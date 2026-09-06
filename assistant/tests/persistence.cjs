const assert = require('node:assert/strict');
const { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');

module.exports = async function(page) {
  const stageImport = async data => {
    await page.evaluate(data => {
      closeModal('importPreviewModal');
      importConversation({ target: { files: [new File([JSON.stringify(data)], 'fixture.json', { type: 'application/json' })], value: '' } });
    }, data);
    await page.waitForFunction(() => document.getElementById('importPreviewModal').classList.contains('open'));
  };
  const data = () => page.evaluate(async () => ({
    conversations: await idbGetAll('conversations'), memories: await idbGetAll('memories'),
    projects: (await idbGet('meta', 'projects'))?.value || []
  }));
  await page.evaluate(async () => {
    window.confirm = () => true;
    closeModal('setupModal');
    localStorage.setItem('assistantSyncAutoPush', 'false');
    await saveConversations();
  });
  await stageImport({
    conversation: { id: 'persist-chat', title: 'Persistence fixture', createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content: 'base' }] },
    projects: [{ id: 'project-a', name: 'A', createdAt: 1, updatedAt: 1 }, { id: 'project-b', name: 'B', createdAt: 1, updatedAt: 1 }],
    memories: [{ id: 'memory-a', text: 'Original memory', createdAt: 1 }]
  });
  assert.equal(await page.evaluate(() => applyImport('replace')), true, 'initial import commits');

  const conflict = await page.evaluate(async () => {
    await saveConversations();
    const base = structuredClone(getActiveConv());
    const input = document.getElementById('chatInput');
    input.value = 'later local draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const other = { ...base, messages: [...base.messages, { role: 'user', content: 'other tab message' }], syncVersion: { ...base.syncVersion, other: 1 }, updatedAt: base.updatedAt + 1 };
    await idbPut('conversations', other);
    await saveConversations();
    const first = await idbGetAll('conversations');
    const active = structuredClone(getActiveConv());
    input.value = 'sequential local draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await saveConversations();
    await saveConversations();
    return { first, active, after: await idbGetAll('conversations'), text: document.getElementById('convList').textContent };
  });
  assert.equal(conflict.first.length, 2, 'divergent saves keep two histories');
  assert.equal(conflict.first.find(record => record.id === 'persist-chat').messages.at(-1).content, 'other tab message');
  assert.equal(conflict.active.draft.text, 'later local draft');
  assert.equal(conflict.active.messages.length, 1, 'divergent histories are not automatically combined');
  assert.match(conflict.active.title, /conflict copy/);
  assert.match(conflict.text, /conflict copy/);
  assert.equal(conflict.after.length, 2, 'sequential saves do not create more copies');
  assert.equal(conflict.after.find(record => record.id === conflict.active.id).draft.text, 'sequential local draft');
  const duplicate = await page.evaluate(async id => {
    const before = await idbGetAll('conversations');
    duplicateConversation(id);
    await saveConversations();
    return { before: before.length, records: await idbGetAll('conversations'), active: structuredClone(getActiveConv()) };
  }, conflict.active.id);
  assert.equal(duplicate.records.length, duplicate.before + 1, 'duplicating a conflict copy creates an independent chat');
  assert.ok(!duplicate.active.conflictOf);
  assert.ok(duplicate.records.some(record => record.id === conflict.active.id), 'duplicate does not replace its source');
  await page.evaluate(async () => {
    switchConversation('persist-chat');
    for (let i = 0; i < 4; i++) {
      getActiveConv().messages.push({ role: 'user', content: 'original branch continuation ' + i });
      await saveConversations();
    }
  });

  const broadcastId = await page.evaluate(async () => {
    createConversation();
    await saveConversations();
    const base = structuredClone(getActiveConv());
    const input = document.getElementById('chatInput');
    input.value = 'dirty broadcast draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await idbPut('conversations', { ...base, messages: [{ role: 'user', content: 'broadcast peer' }], syncVersion: { ...base.syncVersion, peer: 1 } });
    const channel = new BroadcastChannel('synapse-conversations');
    channel.postMessage({ changed: [], refresh: true });
    channel.close();
    return base.id;
  });
  await page.waitForFunction(async id => (await idbGetAll('conversations')).some(record => record.conflictOf === id && record.draft?.text === 'dirty broadcast draft'), broadcastId);

  const failedSave = await page.evaluate(async () => {
    await saveConversations();
    const before = await idbGetAll('conversations');
    getActiveConv().messages.push({ role: 'user', content: 'retry this write' });
    const original = IDBObjectStore.prototype.put;
    let rejected = false;
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name === 'conversations') throw new Error('Injected conversation write failure');
      return original.apply(this, args);
    };
    try { await saveConversations(); } catch { rejected = true; }
    finally { IDBObjectStore.prototype.put = original; }
    const after = await idbGetAll('conversations');
    const kept = getActiveConv().messages.at(-1).content;
    await saveConversations();
    return { before, after, rejected, kept, retried: (await idbGet('conversations', getActiveConv().id)).messages.at(-1).content };
  });
  assert.equal(failedSave.rejected, true);
  assert.deepEqual(failedSave.after, failedSave.before, 'failed write leaves committed records intact');
  assert.equal(failedSave.kept, 'retry this write');
  assert.equal(failedSave.retried, 'retry this write', 'failed saves remain retryable');
  const deletedDuringSave = await page.evaluate(async () => {
    const original = IDBObjectStore.prototype.put;
    let target;
    let removed = false;
    IDBObjectStore.prototype.put = function(record, ...args) {
      const request = original.call(this, record, ...args);
      if (!removed && this.name === 'conversations' && record.id === target) {
        removed = true;
        removeConversations([target], false);
      }
      return request;
    };
    try {
      createConversation();
      target = getActiveConv().id;
      getActiveConv().messages.push({ role: 'user', content: 'deleted while the first save commits' });
      await saveConversations();
      await saveConversations();
      return { removed, record: await idbGet('conversations', target) };
    } finally { IDBObjectStore.prototype.put = original; }
  });
  assert.equal(deletedDuringSave.removed, true);
  assert.equal(deletedDuringSave.record, null, 'deletion during an in-flight first save is not lost');

  await page.evaluate(async () => {
    openProjectsModal('project-a');
    document.getElementById('projInstructions').value = 'local project edit';
    scheduleProjectAutosave();
    const stored = (await idbGet('meta', 'projects')).value;
    stored.find(project => project.id === 'project-b').instructions = 'peer project edit';
    stored.find(project => project.id === 'project-b').updatedAt = Date.now();
    stored.push({ id: 'project-peer', name: 'Peer addition', instructions: '', docs: [], createdAt: 2, updatedAt: 2 });
    await idbPut('meta', { key: 'projects', value: stored });
    closeModal('projectsModal');
  });
  await page.waitForFunction(async () => (await idbGet('meta', 'projects')).value.some(project => project.id === 'project-a' && project.instructions === 'local project edit'));
  const projects = (await data()).projects;
  assert.equal(projects.find(project => project.id === 'project-b').instructions, 'peer project edit');
  assert.ok(projects.some(project => project.id === 'project-peer'), 'stale project save preserves peer additions');
  await page.evaluate(async () => {
    openProjectsModal('project-a');
    document.getElementById('projInstructions').value = 'edit after peer deletion';
    scheduleProjectAutosave();
    const stored = (await idbGet('meta', 'projects')).value.filter(project => project.id !== 'project-b');
    await idbPut('meta', { key: 'projects', value: stored });
    const ledger = (await idbGet('meta', 'syncTombstones')).value;
    ledger.projects['project-b'] = Date.now();
    await idbPut('meta', { key: 'syncTombstones', value: ledger });
    closeModal('projectsModal');
  });
  await page.waitForFunction(async () => (await idbGet('meta', 'projects')).value.some(project => project.id === 'project-a' && project.instructions === 'edit after peer deletion'));
  assert.ok(!(await data()).projects.some(project => project.id === 'project-b'), 'stale project saves do not undo peer deletions');
  const memories = await page.evaluate(async () => {
    const stale = await loadMemories();
    await idbPut('memories', { id: 'memory-peer', text: 'Peer addition', createdAt: 2 });
    await saveMemories(stale);
    return idbGetAll('memories');
  });
  assert.ok(memories.some(memory => memory.id === 'memory-peer'), 'stale memory saves preserve peer additions');

  const cleared = await page.evaluate(async () => {
    const conv = getActiveConv();
    conv.queuedFollowUps = [{ id: 'queued-clear', text: 'clear queue', attachments: [], createdAt: 1 }];
    await saveConversations();
    const before = conv.updatedAt;
    await clearDataCategory('drafts');
    return { before, after: await idbGet('conversations', conv.id) };
  });
  assert.ok(cleared.after.updatedAt > cleared.before, 'clearing drafts and queues advances the change time');
  assert.equal(cleared.after.draft?.text || '', '');
  assert.deepEqual(cleared.after.queuedFollowUps, []);

  await page.evaluate(() => {
    localStorage.setItem('llmPersona', 'original persona');
    localStorage.setItem('assistantTheme', 'dark');
  });
  const importFixture = {
    conversation: { id: 'import-new', title: 'Imported', messages: [{ role: 'user', content: 'imported content' }] },
    projects: [{ id: 'import-project', name: 'Imported project' }],
    memories: [{ id: 'import-memory', text: 'Imported memory', createdAt: 3 }],
    settings: { llmPersona: 'imported persona', assistantTheme: 'nord' }
  };
  await stageImport(importFixture);
  const beforeImport = await data();
  const rollback = await page.evaluate(async () => {
    const activeId = getActiveConv().id;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === 'meta' && value?.key === 'projects' && value.value.some(project => project.id === 'import-project')) throw new Error('Injected project write failure');
      return original.call(this, value, ...args);
    };
    let result;
    try { result = await applyImport('replace'); }
    finally { IDBObjectStore.prototype.put = original; }
    return { result, activeId, afterActiveId: getActiveConv().id, persona: localStorage.getItem('llmPersona'), theme: localStorage.getItem('assistantTheme') };
  });
  assert.equal(rollback.result, false, 'project write failure rejects the entire import');
  assert.deepEqual(await data(), beforeImport, 'failed import restores every database category');
  assert.equal(rollback.activeId, rollback.afterActiveId, 'failed import leaves active state unchanged');
  assert.equal(rollback.persona, 'original persona');
  assert.equal(rollback.theme, 'dark');

  const storageRollback = await page.evaluate(async () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'assistantTheme' && value === 'nord') throw new Error('Injected settings write failure');
      return original.call(this, key, value);
    };
    let result;
    try { result = await applyImport('replace'); }
    finally { Storage.prototype.setItem = original; }
    return { result, persona: localStorage.getItem('llmPersona'), theme: localStorage.getItem('assistantTheme') };
  });
  assert.equal(storageRollback.result, false);
  assert.deepEqual(await data(), beforeImport);
  assert.equal(storageRollback.persona, 'original persona', 'partial settings writes are restored');
  assert.equal(storageRollback.theme, 'dark');

  const rollbackOwnership = await page.evaluate(async () => {
    const original = Storage.prototype.setItem;
    let peerWrite;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'assistantTheme' && value === 'nord') {
        original.call(this, 'llmPersona', 'peer persona');
        peerWrite = idbPut('memories', { id: 'rollback-peer', text: 'Written while import aborts', createdAt: 4 });
        throw new Error('Injected failure with an intervening writer');
      }
      return original.call(this, key, value);
    };
    let result;
    try { result = await applyImport('replace'); }
    finally { Storage.prototype.setItem = original; }
    await peerWrite;
    const persona = localStorage.getItem('llmPersona');
    localStorage.setItem('llmPersona', 'original persona');
    return { result, persona, peer: await idbGet('memories', 'rollback-peer') };
  });
  assert.equal(rollbackOwnership.result, false);
  assert.equal(rollbackOwnership.persona, 'peer persona', 'settings rollback does not replace another writer');
  assert.equal(rollbackOwnership.peer.text, 'Written while import aborts', 'rollback does not erase intervening database writes');

  const staleImport = await page.evaluate(async () => {
    const original = IDBDatabase.prototype.transaction;
    let injected = false;
    IDBDatabase.prototype.transaction = function(names, mode, ...args) {
      if (!injected && mode === 'readwrite' && Array.isArray(names) && names.includes('conversations') && names.includes('memories')) {
        injected = true;
        const peer = original.call(this, ['conversations', 'memories', 'meta'], 'readwrite');
        peer.objectStore('memories').put({ id: 'memory-intervening', text: 'Intervening memory', createdAt: 4 });
        peer.objectStore('conversations').put({ id: 'chat-intervening', title: 'Intervening chat', messages: [], createdAt: 4, updatedAt: 4 });
        const request = peer.objectStore('meta').get('projects');
        request.onsuccess = () => peer.objectStore('meta').put({ key: 'projects', value: [...request.result.value, { id: 'project-intervening', name: 'Intervening project', createdAt: 4, updatedAt: 4 }] });
      }
      return original.call(this, names, mode, ...args);
    };
    try { return { result: await applyImport('replace'), injected }; }
    finally { IDBDatabase.prototype.transaction = original; }
  });
  assert.equal(staleImport.injected, true);
  assert.equal(staleImport.result, false, 'transaction rejects a stale import snapshot');
  const intervening = await data();
  assert.ok(intervening.memories.some(record => record.id === 'memory-intervening'));
  assert.ok(intervening.conversations.some(record => record.id === 'chat-intervening'));
  assert.ok(intervening.projects.some(record => record.id === 'project-intervening'));
  assert.ok(!intervening.conversations.some(record => record.id === 'import-new'));

  const passphrase = 'disposable-regression-passphrase';
  const encrypt = payload => {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = pbkdf2Sync(passphrase, salt, 120000, 32, 'sha256');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({ version: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iterations: 120000, salt: salt.toString('base64'), iv: iv.toString('base64'), data: encrypted.toString('base64') });
  };
  const remoteDeletedId = duplicate.active.id;
  const gist = {
    id: 'disposable-gist', files: {
      'manifest.json': { content: JSON.stringify({ app: 'Synapse', schema: 'gist-sync-v1', files: { conversations: [{ file: 'legacy-chat.json.enc' }], tombstones: 'tombstones.json.enc' } }) },
      'legacy-chat.json.enc': { content: encrypt({ conversation: { id: 'remote-only', title: 'Remote only', messages: [{ role: 'user', content: 'remote message' }], createdAt: 5, updatedAt: 5 } }) },
      'conv_orphan.json.enc': { content: encrypt({ conversation: { id: 'remote-orphan', title: 'Unindexed legacy chat', messages: [{ role: 'user', content: 'orphaned legacy message' }], createdAt: 5, updatedAt: 5 } }) },
      'conv_uncertain.json.enc': { content: encrypt({ conversation: { id: 'remote-uncertain', title: 'Unverifiable deletion', messages: [{ role: 'user', content: 'kept despite unknown deletion' }], createdAt: 5, updatedAt: 5 } }) },
      'tombstones.json.enc': { content: encrypt({ tombstones: { conversations: { [remoteDeletedId]: Date.now() + 100000, 'remote-uncertain': Date.now() + 100000 } } }) }
    }
  };
  const remote = await page.evaluateHandle(({ gist, passphrase }) => {
    const state = { gist, requests: [], overwritten: [], originalFetch: window.fetch };
    window.fetch = async (url, options = {}) => {
      if (!String(url).startsWith('https://api.github.com/gists')) return state.originalFetch(url, options);
      const method = options.method || 'GET';
      state.requests.push(method);
      if (method === 'GET' && state.injectDraft) {
        const input = document.getElementById('chatInput');
        input.value = state.injectDraft;
        state.injectDraft = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (method === 'GET' && state.staleRead) {
        const stale = state.staleRead;
        state.staleRead = null;
        return new Response(JSON.stringify(stale), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'PATCH') {
        const files = JSON.parse(options.body).files;
        for (const [name, file] of Object.entries(files)) {
          if (!file || Object.hasOwn(state.gist.files, name)) state.overwritten.push(name);
          if (file) state.gist.files[name] = file;
          else delete state.gist.files[name];
        }
      } else if (method !== 'GET') throw new Error('Unexpected remote mutation: ' + method);
      return new Response(JSON.stringify(state.gist), { status: 200, headers: { 'Content-Type': 'application/json', ETag: 'not-a-write-condition' } });
    };
    localStorage.setItem('assistantSyncGistToken', 'disposable-not-a-real-token');
    localStorage.setItem('assistantSyncGistId', gist.id);
    localStorage.setItem('assistantSyncStateGistId', gist.id);
    localStorage.setItem('assistantSyncPassphrase', passphrase);
    renderSyncSettings();
    closeModal('importPreviewModal');
    return state;
  }, { gist, passphrase });
  const push = await page.evaluate(async id => {
    const tombstones = localStorage.getItem('assistantSyncTombstones');
    const result = await syncPushToGist({ auto: true });
    const afterPush = localStorage.getItem('assistantSyncTombstones');
    await loadConversations();
    return { result, tombstones, afterPush, kept: Boolean(await idbGet('conversations', id)), remoteVisible: Boolean(await idbGet('conversations', 'remote-only')) };
  }, remoteDeletedId);
  assert.equal(push.result, true);
  assert.equal(push.afterPush, push.tombstones, 'push does not apply the remote deletion ledger');
  assert.equal(push.kept, true, 'remote deletion cannot hide local data after push and reload');
  assert.equal(push.remoteVisible, false, 'push is not an implicit pull');
  assert.deepEqual(await remote.evaluate(state => state.overwritten), [], 'push only adds uniquely named files');

  const lifecycle = await page.evaluate(async () => {
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'assistantSyncSettingsState') { failed = true; throw new Error('Injected sync storage failure'); }
      return original.call(this, key, value);
    };
    let result;
    try { result = await syncPushToGist({ auto: true }); }
    finally { Storage.prototype.setItem = original; }
    const retry = await syncPushToGist({ auto: true });
    const old = localStorage.getItem('assistantSyncPassphrase');
    window.confirm = () => false;
    syncGeneratePassphrase();
    const kept = localStorage.getItem('assistantSyncPassphrase') === old;
    window.confirm = () => true;
    return { failed, result, retry, kept };
  });
  assert.equal(lifecycle.failed, true);
  assert.equal(lifecycle.result, false);
  assert.equal(lifecycle.retry, true, 'sync failure releases the operation flag');
  assert.equal(lifecycle.kept, true, 'generating a key for an existing Gist requires explicit new-Gist consent');

  await remote.evaluate(state => { state.injectDraft = 'draft typed while pushing'; });
  const draftPush = await page.evaluate(async () => ({ id: getActiveConv().id, result: await syncPushToGist({ auto: true }) }));
  assert.equal(draftPush.result, true);
  await page.waitForFunction(async id => (await idbGet('conversations', id))?.draft?.text === 'draft typed while pushing', draftPush.id);

  const preConcurrent = await remote.evaluate(state => structuredClone(state.gist));
  const firstPush = await page.evaluate(async () => {
    createConversation();
    getActiveConv().messages.push({ role: 'user', content: 'concurrent device A' });
    await saveConversations();
    return { id: getActiveConv().id, result: await syncPushToGist({ auto: true }) };
  });
  assert.equal(firstPush.result, true);
  await page.evaluate(async id => {
    await idbDelete('conversations', id);
    await loadConversations();
    createConversation();
    getActiveConv().messages.push({ role: 'user', content: 'concurrent device B' });
    await saveConversations();
  }, firstPush.id);
  await remote.evaluate((state, stale) => { state.staleRead = stale; }, preConcurrent);
  assert.equal(await page.evaluate(() => syncPushToGist({ auto: true })), true, 'second writer can verify after reading a stale Gist');
  assert.deepEqual(await remote.evaluate(state => state.overwritten), [], 'two successful pushes do not overwrite either update');
  assert.equal(await page.evaluate(() => syncPullFromGist()), true, 'manual pull reads legacy files and uniquely named updates');
  const pulled = await data();
  assert.ok(pulled.conversations.some(record => record.messages.some(message => message.content === 'concurrent device A')), 'first writer stays discoverable after second writer verifies');
  assert.ok(pulled.conversations.some(record => record.messages.some(message => message.content === 'concurrent device B')));
  assert.ok(pulled.conversations.some(record => record.id === 'remote-only'), 'manual pull imports the legacy remote chat');
  assert.ok(pulled.conversations.some(record => record.id === 'remote-orphan'), 'legacy conversation files remain discoverable without a manifest entry');
  assert.ok(pulled.conversations.some(record => record.conflictOf === 'remote-uncertain' && record.messages[0]?.content === 'kept despite unknown deletion'), 'unverifiable legacy deletions preserve a recovery copy');
  assert.equal(pulled.conversations.find(record => record.id === conflict.active.id)?.messages.length, 1, 'editing the other branch in the same tab must not make it supersede this copy');
  assert.ok(!pulled.conversations.some(record => record.id === remoteDeletedId), 'confirmed manual pull applies the remote deletion');
  const repeatedPullCount = pulled.conversations.length;
  assert.equal(await page.evaluate(() => syncPullFromGist()), true);
  assert.equal((await data()).conversations.length, repeatedPullCount, 'repeated pulls do not create duplicate conflict copies');

  const deletionBase = await page.evaluate(async () => {
    createConversation();
    getActiveConv().messages.push({ role: 'user', content: 'shared deletion base' });
    await saveConversations();
    const base = structuredClone(getActiveConv());
    if (!await syncPushToGist({ auto: true })) throw new Error('Could not publish deletion fixture base');
    return base;
  });
  const deletion = await page.evaluate(async id => {
    removeConversations([id], false);
    await saveConversations();
    const ledger = (await idbGet('meta', 'syncTombstones')).value;
    return { pushed: await syncPushToGist({ auto: true }), seen: ledger.conversationVersions[id] };
  }, deletionBase.id);
  assert.equal(deletion.pushed, true);
  assert.deepEqual(deletion.seen, deletionBase.syncVersion, 'deletion records identify the version actually seen');
  const unseenEdit = {
    ...deletionBase,
    messages: [...deletionBase.messages, { role: 'user', content: 'edit unseen by deleting device' }],
    syncVersion: { ...deletionBase.syncVersion, concurrentPeer: 1 }
  };
  await remote.evaluate((state, content) => {
    state.gist.files['synapse-update-unseen-edit.json.enc'] = { content };
  }, encrypt({ app: 'Synapse', schema: 'gist-sync-update-v2', conversations: [unseenEdit], projects: [], memories: [], settingsState: {}, tombstones: {} }));
  assert.equal(await page.evaluate(() => syncPullFromGist()), true);
  const deletionConflict = await data();
  assert.ok(deletionConflict.conversations.some(record => record.conflictOf === deletionBase.id && record.messages.some(message => message.content === 'edit unseen by deleting device')), 'deletion cannot discard a concurrent edit merely because its clock is earlier');
  assert.ok(!deletionConflict.conversations.some(record => record.id === deletionBase.id));
  assert.equal(await page.evaluate(() => syncPullFromGist()), true);
  assert.equal((await data()).conversations.length, deletionConflict.conversations.length, 'deletion conflict recovery is idempotent');

  for (const reversed of [false, true]) {
    const id = 'deleted-concurrent-' + reversed;
    const a = { id, title: id, createdAt: 1, updatedAt: 2, messages: [{ role: 'user', content: 'explicitly deleted A' }], syncVersion: { base: 1, deviceA: 1 } };
    const b = { ...a, messages: [{ role: 'user', content: 'unseen B' }], syncVersion: { base: 1, deviceB: 1 } };
    const wrap = (conversations, tombstones = {}) => encrypt({ app: 'Synapse', schema: 'gist-sync-update-v2', conversations, projects: [], memories: [], settingsState: {}, tombstones });
    await remote.evaluate((state, { id, files }) => {
      files.forEach((content, i) => { state.gist.files['synapse-update-' + id + '-' + i + '.json.enc'] = { content }; });
    }, { id, files: [wrap([reversed ? a : b]), wrap([reversed ? b : a]), wrap([], { conversations: { [id]: 3 }, conversationVersions: { [id]: a.syncVersion } })] });
    assert.equal(await page.evaluate(() => syncPullFromGist()), true);
    const family = (await data()).conversations.filter(record => record.id === id || record.conflictOf === id);
    assert.equal(family.length, 1, 'archive order cannot resurrect a deleted concurrent version');
    assert.equal(family[0].messages[0].content, 'unseen B');
  }

  const deletedCopy = await page.evaluate(async () => {
    const copy = (await idbGetAll('conversations')).find(record => record.conflictOf === 'deleted-concurrent-false');
    removeConversations([copy.id], false);
    await saveConversations();
    const tombstones = (await idbGet('meta', 'syncTombstones')).value;
    return { id: copy.id, root: tombstones.conversationRoots[copy.id], pushed: await syncPushToGist({ auto: true }) };
  });
  assert.equal(deletedCopy.root, 'deleted-concurrent-false');
  assert.equal(deletedCopy.pushed, true);
  assert.equal(await page.evaluate(() => syncPullFromGist()), true);
  assert.ok(!(await data()).conversations.some(record => record.id === deletedCopy.root || record.conflictOf === deletedCopy.root), 'deleting a conflict copy also removes its older original-name snapshots');

  const stalePull = await page.evaluate(async () => {
    const original = IDBDatabase.prototype.transaction;
    let injected = false;
    IDBDatabase.prototype.transaction = function(names, mode, ...args) {
      if (!injected && mode === 'readwrite' && Array.isArray(names) && names.includes('conversations') && names.includes('memories')) {
        injected = true;
        const peer = original.call(this, ['conversations', 'memories', 'meta'], 'readwrite');
        peer.objectStore('conversations').put({ id: 'pull-peer-chat', title: 'Peer chat during pull', messages: [], createdAt: 10, updatedAt: 10 });
        peer.objectStore('memories').put({ id: 'pull-peer-memory', text: 'Peer memory during pull', createdAt: 10 });
        const request = peer.objectStore('meta').get('projects');
        request.onsuccess = () => peer.objectStore('meta').put({ key: 'projects', value: [...request.result.value, { id: 'pull-peer-project', name: 'Peer project during pull', createdAt: 10, updatedAt: 10 }] });
      }
      return original.call(this, names, mode, ...args);
    };
    try { return { result: await syncPullFromGist(), injected }; }
    finally { IDBDatabase.prototype.transaction = original; }
  });
  assert.equal(stalePull.injected, true);
  assert.equal(stalePull.result, false, 'pull rejects a stale database snapshot');
  const afterStalePull = await data();
  assert.ok(afterStalePull.conversations.some(record => record.id === 'pull-peer-chat'));
  assert.ok(afterStalePull.memories.some(record => record.id === 'pull-peer-memory'));
  assert.ok(afterStalePull.projects.some(record => record.id === 'pull-peer-project'));
  assert.ok(afterStalePull.conversations.some(record => record.id === 'remote-only'));

  const pullLifecycle = await page.evaluate(async () => {
    renderSyncSettings();
    document.getElementById('setSyncToken').value = 'disposable-failing-token';
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'assistantSyncGistToken') throw new Error('Injected sync config failure');
      return original.call(this, key, value);
    };
    let result;
    try { result = await syncPullFromGist(); }
    finally { Storage.prototype.setItem = original; }
    renderSyncSettings();
    return { result, inputLocked: document.querySelector('.input-area').inert, tokenLocked: document.getElementById('setSyncToken').disabled, retry: await syncPullFromGist() };
  });
  assert.equal(pullLifecycle.result, false);
  assert.equal(pullLifecycle.inputLocked, false, 'failed config write releases composer lock');
  assert.equal(pullLifecycle.tokenLocked, false, 'failed config write releases settings controls');
  assert.equal(pullLifecycle.retry, true);

  const backup = await page.evaluate(async () => {
    localStorage.setItem('assistantPresets', JSON.stringify([null, { id: 'preset-fixture', name: 'Fixture', persona: 'Preset persona', promptEntries: [{ id: 'prompt', name: 'Prompt', content: 'Kept prompt' }], extraParams: '{"top_p":0.9,"max_tokens":128,"nested":{"api_key":"disposable-nested-preset-secret"}}', apiKey: 'disposable-preset-secret' }]));
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() { if (!this.download) return original.call(this); };
    try { return await exportAllConversations(); }
    finally { HTMLAnchorElement.prototype.click = original; }
  });
  assert.ok(backup, 'full backup is produced');
  const presets = JSON.parse(backup.settings.assistantPresets);
  assert.equal(presets.length, 1);
  assert.equal(presets[0].promptEntries[0].content, 'Kept prompt');
  assert.equal(JSON.parse(presets[0].extraParams).top_p, 0.9, 'normal generation parameters survive');
  assert.equal(JSON.parse(presets[0].extraParams).max_tokens, 128, 'token limits are not credentials');
  assert.ok(!JSON.stringify(backup).includes('disposable-preset-secret'), 'backup omits preset credential fields');
  await page.evaluate(() => localStorage.removeItem('assistantPresets'));
  await stageImport(backup);
  assert.equal(await page.evaluate(() => applyImport('merge')), true, 'backup can be imported');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('assistantPresets'))), presets, 'presets round-trip');
  assert.equal(await page.evaluate(() => syncPushToGist({ auto: true })), true);
  const syncedEnvelope = JSON.parse(await remote.evaluate(state => Object.entries(state.gist.files).filter(([name]) => name.startsWith('synapse-update-')).at(-1)[1].content));
  const syncedBytes = Buffer.from(syncedEnvelope.data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', pbkdf2Sync(passphrase, Buffer.from(syncedEnvelope.salt, 'base64'), 120000, 32, 'sha256'), Buffer.from(syncedEnvelope.iv, 'base64'));
  decipher.setAuthTag(syncedBytes.subarray(-16));
  const syncedPayload = JSON.parse(Buffer.concat([decipher.update(syncedBytes.subarray(0, -16)), decipher.final()]).toString());
  assert.deepEqual(JSON.parse(syncedPayload.settingsState.settings.assistantPresets), presets, 'sync carries the same normalised presets as backup');

  const migration = await page.evaluate(async () => {
    closeModal('importPreviewModal');
    createConversation();
    getActiveConv().messages.push({ role: 'user', content: 'fallback shared base' });
    await saveConversations();
    const uncommitted = structuredClone(getActiveConv());
    uncommitted.draft = { text: 'uncommitted fallback draft', attachments: [] };
    getActiveConv().messages.push({ role: 'user', content: 'database-only newer message' });
    await saveConversations();
    localStorage.setItem('assistantConversations', JSON.stringify([uncommitted, { id: 'fallback-history', title: 'Fallback', messages: [{ role: 'user', content: 'fallback data' }], createdAt: 12, updatedAt: 12 }]));
    localStorage.setItem('assistantChatHistory', JSON.stringify([{ role: 'user', content: 'legacy data' }]));
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(record, ...args) {
      if (this.name === 'conversations' && record.id === 'fallback-history') throw new Error('Injected migration failure');
      return original.call(this, record, ...args);
    };
    try { await loadConversations(); }
    finally { IDBObjectStore.prototype.put = original; }
    const retained = Boolean(localStorage.getItem('assistantConversations') && localStorage.getItem('assistantChatHistory'));
    await loadConversations();
    return { retained, originalId: uncommitted.id, records: await idbGetAll('conversations'), fallback: localStorage.getItem('assistantConversations'), legacy: localStorage.getItem('assistantChatHistory') };
  });
  assert.equal(migration.retained, true, 'failed migration retains both source copies');
  assert.ok(migration.records.some(record => record.id === 'remote-only'), 'existing database history remains visible');
  assert.ok(migration.records.some(record => record.id === 'fallback-history'));
  assert.ok(migration.records.some(record => record.messages.some(message => message.content === 'legacy data')));
  assert.ok(migration.records.some(record => record.id === migration.originalId && record.messages.some(message => message.content === 'database-only newer message')));
  assert.ok(migration.records.some(record => record.conflictOf === migration.originalId && record.draft?.text === 'uncommitted fallback draft'), 'fallback edits with an old saved version are not discarded');
  assert.equal(migration.fallback, null);
  assert.equal(migration.legacy, null);

  let qrAttempts = 0;
  const qrRoute = async route => {
    qrAttempts++;
    if (qrAttempts === 1) return route.fulfill({ status: 503, body: 'Injected library load failure', headers: { 'Access-Control-Allow-Origin': '*' } });
    return route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'export default { toCanvas(canvas) { canvas.dataset.fixtureRendered = "yes"; } };' });
  };
  await page.route('https://esm.sh/qrcode@1.5.4/es2022/qrcode.bundle.mjs*', qrRoute);
  await page.evaluate(() => syncRenderPairingQr());
  await page.evaluate(() => syncRenderPairingQr());
  assert.equal(qrAttempts, 2, 'failed QR library imports are retryable');
  assert.equal(await page.locator('#syncPairingQr').getAttribute('data-fixture-rendered'), 'yes');
  await page.unroute('https://esm.sh/qrcode@1.5.4/es2022/qrcode.bundle.mjs*', qrRoute);

  const malformed = await page.evaluate(async () => {
    const imported = normalizeImportedData({ conversation: { id: 'malformed-render', sortOrder: { invalid: true }, characterCard: { name: 42, description: { invalid: true } }, messages: [{
      role: 'assistant', content: 'valid answer', swipes: [null], swipeThinking: [{ invalid: true }],
      swipeToolUse: [[null, { type: 'url_fetch', content: 7 }, { results: { bad: true } }]],
      swipeImages: {}, swipeSources: ['invalid'], swipeRequests: [7], swipeLlms: ['invalid']
    }] } });
    await idbPut('conversations', imported.conversations[0]);
    await loadConversations();
    switchConversation('malformed-render');
    setConversationSort('manual');
    renderMessages();
    showCharacterInfo();
    document.querySelector('[data-close-character]')?.click();
    return { content: getActiveConv().messages[0].content, thinking: getActiveConv().messages[0].swipeThinking, html: document.getElementById('messagesArea').textContent };
  });
  assert.equal(malformed.content, 'valid answer');
  assert.deepEqual(malformed.thinking, ['']);
  assert.match(malformed.html, /valid answer/);

  const response = await page.evaluateHandle(() => {
    createConversation();
    localStorage.setItem('llmProvider', 'custom');
    localStorage.setItem('llmProxyUrl', 'https://persistence-provider.invalid/v1');
    localStorage.setItem('llmApiFormat', 'openai');
    localStorage.setItem('llmModel', 'persistence-fixture');
    localStorage.setItem('llmStreaming', 'false');
    const state = { originalFetch: window.fetch, originalTransaction: IDBDatabase.prototype.transaction, conv: getActiveConv(), started: false, refreshed: false };
    window.fetch = (url, options) => {
      if (!String(url).includes('persistence-provider.invalid')) return state.originalFetch(url, options);
      state.started = true;
      return new Promise(resolve => { state.finish = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'completed after peer deletion' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })); });
    };
    const input = document.getElementById('chatInput');
    input.value = 'finish this pending response';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    state.sending = sendMessage();
    return state;
  });
  await page.waitForFunction(state => state.started, response);
  await response.evaluate(async state => {
    IDBDatabase.prototype.transaction = function(names, mode, ...args) {
      const tx = state.originalTransaction.call(this, names, mode, ...args);
      if (mode === 'readwrite' && Array.isArray(names) && names.includes('conversations')) tx.addEventListener('complete', () => { state.refreshed = true; });
      return tx;
    };
    await idbDelete('conversations', state.conv.id);
    const channel = new BroadcastChannel('synapse-conversations');
    channel.postMessage({ refresh: true });
    channel.close();
  });
  await page.waitForFunction(state => state.refreshed, response);
  const finishedResponse = await response.evaluate(async state => {
    IDBDatabase.prototype.transaction = state.originalTransaction;
    state.finish();
    const status = await state.sending;
    window.fetch = state.originalFetch;
    await saveConversations();
    return { status, record: await idbGet('conversations', state.conv.id) };
  });
  assert.equal(finishedResponse.status, 'complete', 'peer deletion does not detach the active request');
  assert.equal(finishedResponse.record.messages.at(-1).content, 'completed after peer deletion');
  assert.ok(finishedResponse.record.conflictOf, 'response after deletion remains a recoverable chat');
  await response.dispose();

  const attachment = await page.evaluateHandle(async () => {
    createConversation();
    await saveConversations();
    const origin = getActiveConv();
    const base = structuredClone(origin);
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    const file = new File(['attachment body'], 'pending.txt', { type: 'text/plain' });
    file.text = () => gate;
    const reading = readAttachmentFile(file);
    const input = document.getElementById('chatInput');
    input.value = 'my file draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await idbPut('conversations', { ...base, messages: [{ role: 'user', content: 'peer during file read' }], syncVersion: { ...base.syncVersion, attachmentPeer: 1 } });
    await saveConversations();
    return { origin, oldId: base.id, reading, finish };
  });
  const attached = await attachment.evaluate(async state => {
    state.finish('attachment body');
    await state.reading;
    await saveConversations();
    return { own: await idbGet('conversations', state.origin.id), peer: await idbGet('conversations', state.oldId) };
  });
  await attachment.dispose();
  await remote.evaluate(state => { window.fetch = state.originalFetch; });
  await remote.dispose();
  const integrationFailures = [];
  if (JSON.stringify(backup).includes('disposable-nested-preset-secret') || JSON.stringify(syncedPayload).includes('disposable-nested-preset-secret')) integrationFailures.push('normalizePresetRecords: strip nested credentials from extraParams without removing max_tokens');
  if (attached.own.draft?.attachments?.[0]?.textContent !== 'attachment body' || attached.peer.draft?.attachments?.length) integrationFailures.push('readAttachmentFile: capture the original conversation object and read its current ID when delivering the file');
  assert.deepEqual(integrationFailures, [], 'Outstanding lead/UI integration dependencies');
};
