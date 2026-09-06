const assert = require('node:assert/strict');

module.exports = async function(page) {
  const origin = new URL(page.url()).origin;
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
  const checks = [];
  const accept = dialog => dialog.accept();
  page.on('dialog', accept);
  await page.evaluate(origin => {
    window.closeModal('setupModal', false);
    window.closeModal('settingsModal', false);
    const original = window.fetch;
    const fixture = window.__contextFixture = { requests: [], plans: [], releases: [], restore: () => { window.fetch = original; } };
    window.fetch = async (url, options) => {
      if (!String(url).startsWith(origin + '/__context/')) return original(url, options);
      if (options?.method !== 'POST') return new Response('{"data":[]}', { headers: { 'Content-Type': 'application/json' } });
      fixture.requests.push({ url: String(url), body: JSON.parse(options.body), signalNull: options.signal == null });
      const plan = fixture.plans.shift();
      if (!plan) throw new Error('Unexpected context fixture request');
      if (plan.delayed) await new Promise(resolve => fixture.releases.push(resolve));
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: plan.text }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
    };
  }, origin);
  const configure = async (count = 12) => page.evaluate(({ origin, count }) => {
    Object.entries({ llmProvider: 'custom', llmProxyUrl: origin + '/__context/a/v1', llmApiFormat: 'openai', llmModel: 'context-fixture', llmStreaming: 'false', llmMaxTokens: '64', llmContextWindow: '', llmMemoryEnabled: 'false', llmWebSearch: 'false', llmUrlFetch: 'false', llmToolConfirm: 'false', llmPrefill: '', llmExtraParams: '', llmExcludeParams: '', llmForceSearch: 'false' }).forEach(([key, value]) => localStorage.setItem(key, value));
    window.createConversation();
    const conv = window.getActiveConv();
    for (let i = 0; i < count; i++) conv.messages.push(i % 2
      ? { role: 'assistant', content: 'Turn ' + i, swipes: ['Turn ' + i], swipeIndex: 0 }
      : { role: 'user', content: 'Turn ' + i });
    conv.toolPolicy = { webSearch: false, urlFetch: false, confirm: false };
    window.__contextOwner = conv;
    window.renderMessages();
    window.renderContextPanel();
    return window.saveConversations().then(() => conv.id);
  }, { origin, count });
  const plan = (text, delayed = false) => page.evaluate(plan => window.__contextFixture.plans.push(plan), { text, delayed });
  const start = (name, args = []) => page.evaluate(({ name, args }) => {
    window.__contextDone = false;
    window.__contextTask = Promise.resolve(window[name](...args)).finally(() => { window.__contextDone = true; });
  }, { name, args });
  const waiting = () => page.waitForFunction(() => window.__contextFixture.releases.length > 0);
  const release = () => page.evaluate(() => window.__contextFixture.releases.shift()());
  const finish = async () => {
    await page.waitForFunction(() => window.__contextDone);
    return page.evaluate(() => window.__contextTask);
  };
  const request = () => page.evaluate(() => window.__contextFixture.requests.at(-1));
  const owner = () => page.evaluate(() => window.__contextOwner);
  const closePopups = () => page.evaluate(() => document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove()));
  try {
    await configure();
    await page.evaluate(() => {
      window.openContextSection('toolsSection');
      window.openContextSection('summarySection');
    });
    await page.locator('#chatToolWebSearch').check();
    await page.locator('#summaryText').fill('An unsaved summary');
    await page.locator('#chatInput').focus();
    await page.evaluate(() => { window.renderMessages(); window.updateTokenInfo(); window.renderContextPanel(); });
    assert.equal(await page.locator('#chatToolWebSearch').isChecked(), true);
    assert.equal(await page.locator('#summaryText').inputValue(), 'An unsaved summary');
    assert.equal((await owner()).summary, undefined);
    assert.equal((await owner()).toolPolicy.webSearch, false);
    const draftOwner = (await owner()).id;
    await page.evaluate(() => window.createConversation());
    await page.evaluate(id => window.switchConversation(id), draftOwner);
    assert.equal(await page.locator('#summaryText').inputValue(), 'An unsaved summary');
    assert.equal(await page.locator('#chatToolWebSearch').isChecked(), true);
    await page.evaluate(() => window.saveConversationTools());
    await page.evaluate(() => window.saveConversationSummary());
    assert.equal((await owner()).summary, 'An unsaved summary');
    assert.equal((await owner()).toolPolicy.webSearch, true);
    await page.locator('#summaryText').fill('Discard this');
    await page.locator('#discardContextsummary').click();
    await page.locator('#chatToolWebSearch').uncheck();
    await page.locator('#discardContexttools').click();
    assert.equal(await page.locator('#summaryText').inputValue(), 'An unsaved summary');
    assert.equal(await page.locator('#chatToolWebSearch').isChecked(), true);
    checks.push('Context drafts survive focus, redraws and chat switches; Save and Discard are explicit');

    await configure(16);
    await page.evaluate(() => {
      const messages = window.getActiveConv().messages;
      messages[0].includeInContext = false;
      messages[1].swipeRequests = [{ status: 'failed' }];
      messages[3].swipeRequests = [{ status: 'pending' }];
    });
    await plan('Compacted knowledge', true);
    await start('compactOlderTurns');
    await waiting();
    const count = await page.evaluate(() => window.__contextFixture.requests.length);
    await page.evaluate(() => Promise.all([window.compactOlderTurns(), window.generateConversationSummary()]));
    assert.equal(await page.evaluate(() => window.__contextFixture.requests.length), count);
    assert.doesNotMatch((await request()).body.messages[1].content, /Turn (?:0|1|3)(?:\n|$)/);
    assert.equal((await request()).signalNull, true);
    await release(); await finish();
    assert.deepEqual((await owner()).messages.map((message, index) => message.autoCompacted ? index : -1).filter(index => index >= 0), [2, 4, 5, 6, 7]);
    assert.deepEqual((await owner()).summaryCoverage, { version: 1, through: 8 });
    await page.evaluate(() => window.forkBranch(10));
    assert.equal(await page.evaluate(() => window.getActiveConv().summary), 'Compacted knowledge');
    await page.evaluate(id => window.switchConversation(id), (await owner()).id);
    await plan('Combined summary');
    await page.evaluate(() => window.generateConversationSummary());
    assert.match((await request()).body.messages[1].content, /Prior summary:\nCompacted knowledge/);
    assert.doesNotMatch((await request()).body.messages[1].content, /Turn (?:0|1|3)(?:\n|$)/);
    assert.deepEqual((await owner()).summaryCoverage, { version: 1, through: 16 });
    await page.evaluate(() => window.forkBranch(4));
    const fork = await page.evaluate(() => window.getActiveConv());
    assert.equal(fork.summary, '');
    assert.equal(fork.messages[0].includeInContext, false);
    assert.equal(fork.messages[2].includeInContext, true);
    assert.equal(fork.messages[4].includeInContext, true);
    assert.ok(fork.messages.every(message => !message.autoCompacted));
    await configure(10);
    await page.evaluate(() => {
      const conv = window.getActiveConv();
      conv.summary = 'Legacy note';
      conv.messages[0].includeInContext = false;
      window.forkBranch(4);
    });
    assert.equal(await page.evaluate(() => window.getActiveConv().summary), '');
    assert.equal(await page.evaluate(() => window.getActiveConv().messages[0].includeInContext), false);
    checks.push('one summary/compaction job per chat, filtered sources, prior knowledge, coverage and conservative legacy forks');

    for (const action of ['clear-summary', 'clear-chat', 'edit-source', 'delete-chat', 'delete-undo', 'summary-draft']) {
      await configure();
      await plan('Must not land', true);
      await start(action === 'clear-summary' ? 'compactOlderTurns' : 'generateConversationSummary');
      await waiting();
      await page.evaluate(action => {
        if (action === 'clear-summary') window.clearConversationSummary();
        if (action === 'clear-chat') window.clearChat();
        if (action === 'edit-source') window.getActiveConv().messages[0].content = 'Changed while waiting';
        if (action === 'delete-chat') window.deleteConversation(window.getActiveConv().id);
        if (action === 'delete-undo') {
          window.deleteConversation(window.getActiveConv().id);
          [...document.querySelectorAll('button')].filter(button => button.textContent === 'Undo').at(-1).click();
        }
        if (action === 'summary-draft') {
          const input = document.getElementById('summaryText');
          input.value = 'New draft';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, action);
      await release(); await finish();
      assert.notEqual((await owner()).summary, 'Must not land', action);
      assert.ok((await owner()).messages.every(message => !message.autoCompacted), action);
    }
    await configure();
    await plan('Background owner summary', true);
    await start('generateConversationSummary'); await waiting();
    await page.evaluate(origin => {
      window.createConversation();
      localStorage.setItem('llmProxyUrl', origin + '/__context/b/v1');
    }, origin);
    await release(); await finish();
    assert.equal((await owner()).summary, 'Background owner summary');
    assert.notEqual(await page.evaluate(() => window.getActiveConv().summary), 'Background owner summary');
    checks.push('delayed summaries reject clear/edit/delete/draft changes and remain bound to their original chat');

    for (const action of ['source-edit', 'clear-memory']) {
      await configure();
      await page.evaluate(async () => {
        localStorage.setItem('llmMemoryEnabled', 'true');
        await window.saveMemories(Array.from({ length: 5 }, (_, i) => ({ id: 'delayed-cleanup-' + i, text: 'Delayed memory ' + i, createdAt: Date.now() })));
      });
      await plan('{"remove":["delayed-cleanup-0"]}', true);
      await start('cleanupMemories'); await waiting();
      await page.evaluate(async action => {
        if (action === 'source-edit') window.getActiveConv().messages[0].content = 'Edited during cleanup';
        else {
          await window.clearAllMemories();
          await window.saveMemories([{ id: 'after-clear', text: 'Added after clearing', createdAt: Date.now() }]);
        }
      }, action);
      await release(); await finish();
      const memories = await page.evaluate(() => window.loadMemories());
      if (action === 'source-edit') assert.ok(memories.some(memory => memory.id === 'delayed-cleanup-0'));
      else assert.deepEqual(memories.map(memory => memory.id), ['after-clear']);
      await closePopups();
    }
    checks.push('delayed cleanup rejects source edits and never restores cleared memories');

    // Cleanup accepts only IDs in its captured list and merges newer additions.
    await configure();
    await page.evaluate(async () => {
      localStorage.setItem('llmMemoryEnabled', 'true');
      await window.saveMemories(Array.from({ length: 5 }, (_, i) => ({ id: 'context-memory-' + i, text: 'Memory ' + i, createdAt: Date.now() + i })));
    });
    await plan('["Extraction before cleanup"]');
    await plan('{"remove":["context-memory-0","newer-memory","unknown-id"]}', true);
    await page.evaluate(origin => {
      const target = { baseUrl: origin + '/__context/a/v1', model: 'captured-memory-model', provider: 'custom', apiFormat: 'openai', keyRequired: false, apiKey: '', temperature: null };
      localStorage.setItem('llmProxyUrl', origin + '/__context/b/v1');
      window.__contextTask = window.extractMemories([{ role: 'user', content: 'Fixture extraction' }], window.getActiveConv(), target);
    }, origin);
    await waiting();
    await page.evaluate(async origin => {
      localStorage.setItem('llmProxyUrl', origin + '/__context/b/v1');
      await window.saveMemories([...(await window.loadMemories()), { id: 'newer-memory', text: 'A concurrent addition', createdAt: Date.now() }]);
    }, origin);
    await release();
    await page.waitForFunction(async () => !(await window.loadMemories()).some(memory => memory.id === 'context-memory-0'));
    const cleaned = await page.evaluate(() => window.loadMemories());
    assert.ok(cleaned.some(memory => memory.id === 'newer-memory'));
    assert.ok(!cleaned.some(memory => memory.id === 'context-memory-0'));
    const tombstones = await page.evaluate(() => JSON.parse(localStorage.getItem('assistantSyncTombstones')).memories);
    assert.ok(tombstones['context-memory-0']);
    assert.equal(tombstones['newer-memory'], undefined);
    assert.equal(tombstones['unknown-id'], undefined);
    assert.equal((await request()).url, origin + '/__context/a/v1/chat/completions');
    assert.equal((await request()).body.model, 'captured-memory-model');
    assert.ok(cleaned.some(memory => memory.text === 'Extraction before cleanup'));
    checks.push('cleanup removes only selected existing IDs, records deletions and preserves concurrent additions');

    for (const action of ['clear-memory', 'disable-enable', 'clear-chat', 'edit-source', 'delete-chat', 'delete-undo', 'replace']) {
      await configure();
      await page.evaluate(() => localStorage.setItem('llmMemoryEnabled', 'true'));
      await plan('["Stale extracted memory"]', true);
      await start('extractMemories', [[{ role: 'user', content: 'Remember fixture preference' }]]);
      await waiting();
      assert.equal((await request()).signalNull, true);
      await page.evaluate(async action => {
        if (action === 'clear-memory') await window.clearAllMemories();
        if (action === 'disable-enable') {
          window.openSettingsSection('tools');
          document.getElementById('setMemory').checked = false;
          window.saveSettingsTab();
          document.getElementById('setMemory').checked = true;
          window.saveSettingsTab();
          window.closeModal('settingsModal', false);
        }
        if (action === 'clear-chat') window.clearChat();
        if (action === 'edit-source') window.getActiveConv().messages[0].content = 'Changed source';
        if (action === 'delete-chat') window.deleteConversation(window.getActiveConv().id);
        if (action === 'delete-undo') {
          window.deleteConversation(window.getActiveConv().id);
          [...document.querySelectorAll('button')].filter(button => button.textContent === 'Undo').at(-1).click();
        }
        if (action === 'replace') {
          const file = new File([JSON.stringify({ conversations: [{ id: 'replacement-chat', title: 'Replacement', messages: [] }], memories: [] })], 'replacement.json', { type: 'application/json' });
          window.importConversation({ target: { files: [file], value: '' } });
        }
      }, action);
      if (action === 'replace') {
        await page.waitForFunction(() => document.getElementById('importPreviewModal').classList.contains('open'));
        assert.equal(await page.evaluate(() => window.applyImport('replace')), true);
      }
      await release(); await finish();
      assert.ok(!(await page.evaluate(() => window.loadMemories())).some(memory => memory.text === 'Stale extracted memory'), action);
      await closePopups();
    }
    await configure();
    await page.evaluate(() => {
      localStorage.setItem('llmMemoryEnabled', 'true');
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(names, mode, ...args) {
        if (mode === 'readwrite' && Array.isArray(names) && names.includes('memories') && !names.includes('conversations')) {
          IDBDatabase.prototype.transaction = original;
          const lock = original.call(this, names, mode, ...args);
          window.__memoryWriteWaiting = true;
          const pump = () => { if (window.__memoryWriteWaiting) lock.objectStore('memories').getAll().onsuccess = pump; };
          pump();
        }
        return original.call(this, names, mode, ...args);
      };
    });
    await plan('["Memory from invalidated source"]');
    await start('extractMemories', [[{ role: 'user', content: 'Preference' }]]);
    await page.waitForFunction(() => window.__memoryWriteWaiting);
    await page.evaluate(() => { window.clearChat(); window.__memoryWriteWaiting = false; });
    await finish();
    assert.ok(!(await page.evaluate(() => window.loadMemories())).some(memory => memory.text === 'Memory from invalidated source'));
    checks.push('memory validity is checked after a blocked database transaction, immediately before writing');

    await configure();
    await page.evaluate(() => localStorage.setItem('llmMemoryEnabled', 'true'));
    await plan('["Captured target memory"]', true);
    await start('extractMemories', [[{ role: 'user', content: 'Preference' }]]);
    await waiting();
    await page.evaluate(origin => { localStorage.setItem('llmProxyUrl', origin + '/__context/b/v1'); window.createConversation(); }, origin);
    await release(); await finish();
    assert.ok((await page.evaluate(() => window.loadMemories())).some(memory => memory.text === 'Captured target memory'));
    assert.equal((await request()).url, origin + '/__context/a/v1/chat/completions');
    checks.push('memory results reject clear/replace/disable/edit/delete and ignore active-chat/provider changes');

    await configure(1);
    await page.evaluate(() => {
      const conv = window.getActiveConv();
      conv.summary = 'Future knowledge';
      conv.summaryCoverage = { version: 1, through: 1 };
      conv.messages[0].content = [{ type: 'text', text: 'Authored text' }, { type: 'file', file: { name: 'fixture.txt', mime: 'text/plain', textContent: 'ATTACHMENT ONCE' } }];
      conv.messages[0].includeInContext = false;
      conv.messages[0]._editing = true;
      window.renderMessages();
    });
    assert.equal(await page.locator('.msg-edit-textarea').inputValue(), 'Authored text');
    await page.locator('#chatInput').fill('Parent draft stays here');
    await page.locator('.msg-edit-textarea').fill('Edited authored text');
    await plan('Edited response', true);
    await page.locator('.msg-edit-save').click(); await waiting();
    const edited = await page.evaluate(() => window.getActiveConv());
    assert.equal(edited.summary, '');
    assert.equal(edited.messages[0].includeInContext, true);
    assert.equal(edited.messages[0].content.filter(part => part.type === 'file').length, 1);
    assert.equal(await page.locator('#chatInput').inputValue(), '');
    assert.equal((await owner()).draft.text, 'Parent draft stays here');
    const payload = JSON.stringify((await request()).body.messages);
    assert.equal(payload.split('ATTACHMENT ONCE').length - 1, 1);
    assert.match(payload, /Edited authored text/);
    assert.doesNotMatch(payload, /Future knowledge/);
    await plan('Queued response');
    await page.locator('#chatInput').fill('Queued after edit');
    await page.evaluate(() => window.queueFollowUpFromComposer());
    await release();
    await page.waitForFunction(() => window.getActiveConv().messages.at(-1)?.content === 'Queued response' && document.getElementById('sendBtn').textContent !== 'Stop');
    assert.equal(await page.evaluate(() => window.getActiveConv().messages.length), 4);
    checks.push('attachment edit keeps authored text separate, includes excluded target, preserves parent draft and advances queue once');

    await configure(1);
    await plan('Captured resend target');
    assert.equal(await page.evaluate(async origin => {
      const conv = window.getActiveConv();
      conv.messages[0].includeInContext = false;
      const task = window.resendAfterEdit();
      localStorage.setItem('llmProxyUrl', origin + '/__context/b/v1');
      localStorage.setItem('llmModel', 'changed-model');
      conv.toolPolicy = { webSearch: true, urlFetch: true, confirm: true };
      return task;
    }, origin), 'complete');
    assert.equal((await request()).url, origin + '/__context/a/v1/chat/completions');
    assert.equal((await request()).body.model, 'context-fixture');
    assert.equal((await request()).body.tools, undefined);
    assert.match(JSON.stringify((await request()).body.messages), /Turn 0/);
    await configure(1);
    const beforeOwnerChange = await page.evaluate(() => window.__contextFixture.requests.length);
    await page.evaluate(async () => {
      const conv = window.getActiveConv();
      const task = window.resendAfterEdit();
      conv.messages = [];
      await task;
    });
    assert.equal(await page.evaluate(() => window.__contextFixture.requests.length), beforeOwnerChange);
    checks.push('resend captures target and tool policy before await, includes its excluded target and rejects changed message ownership');

    await configure(10);
    await page.evaluate(() => {
      const conv = window.getActiveConv();
      conv.summary = 'Knowledge from future turns';
      conv.summaryCoverage = { version: 1, through: 10 };
      conv.messages[0].includeInContext = false;
      conv.messages[2].includeInContext = false;
      conv.messages[2].autoCompacted = true;
      const msg = conv.messages[3];
      msg.swipeRequests = [{ status: 'failed', connection: { provider: 'custom', baseUrl: location.origin + '/__context/a/v1', apiFormat: 'openai', model: 'context-fixture', maxTokens: 64 } }];
    });
    await plan('Retried earlier response');
    await page.evaluate(() => window.retryRequest(3));
    const retryPayload = JSON.stringify((await request()).body.messages);
    assert.doesNotMatch(retryPayload, /Knowledge from future turns|Turn 0|Turn 4/);
    assert.match(retryPayload, /Turn 2/);
    assert.equal((await owner()).summary, '');
    checks.push('earlier Retry discards crossing summary and restores only automatically compacted turns');
    assert.equal(await page.evaluate(() => window.__contextFixture.plans.length), 0);
    return checks;
  } finally {
    await page.evaluate(() => {
      window.__contextFixture.releases.splice(0).forEach(release => release());
      window.__contextFixture.restore();
    }).catch(() => {});
    page.off('dialog', accept);
  }
};
