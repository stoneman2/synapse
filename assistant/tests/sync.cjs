const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');

module.exports = async function(page) {
  const root = path.resolve(__dirname, '..');
  const source = readFileSync(path.join(root, 'js/main.js'), 'utf8');
  const standalone = new URL(page.url()).pathname.endsWith('/synapse.html');
  const html = standalone ? readFileSync(path.join(root, 'synapse.html'), 'utf8') : '';
  const origin = new URL(page.url()).origin;
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname));
  const common = 'syncReadManifest, syncReadRemoteData';
  const exposure = `\nwindow.__syncTest = { ${common}, syncPackUpdates, syncReadArchiveUpdates,
    syncBuildUpdateFiles, syncBuildGistFiles, syncBuildCryptoContext, syncEncryptPayloadWithKey,
    syncDecryptPayload, syncCapturePullSnapshot, syncCollectSettingsState, saveConversationImmediately, saveProjects };\n`;
  let moduleBody = source + exposure;
  const moduleRoute = route => route.fulfill({ contentType: 'application/javascript', body: moduleBody });
  const standaloneRoute = route => route.fulfill({ contentType: 'text/html', body: html.replace('</body>', '<script>' + exposure + '</script></body>') });
  await page.route('**/js/main.js*', moduleRoute);
  if (standalone) await page.route('**/synapse.html', standaloneRoute);
  const failures = [];
  let passed = 0;
  console.log('sync: testing ' + (standalone ? 'standalone' : 'module') + ' SHA-256 ' + createHash('sha256').update(standalone ? html : source).digest('hex'));

  const reset = async () => {
    await page.evaluate(async () => {
      localStorage.setItem('assistantSyncAutoPush', 'false');
      await saveConversations();
      await Promise.all(['conversations', 'memories', 'meta'].map(idbClear));
      localStorage.clear();
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__syncTest && window.getActiveConv?.());
    await page.evaluate(async () => {
      const t = window.__syncTest;
      const h = window.__syncFixture = { t, MiB: 1024 * 1024, passphrase: 'disposable-sync-tests-only', log: [], rawReads: [], unexpected: [] };
      h.ok = (value, message) => { if (!value) throw new Error(message); };
      h.eq = (actual, expected, message) => h.ok(JSON.stringify(actual) === JSON.stringify(expected), message);
      h.rejects = async (fn, pattern) => {
        let error;
        try { await fn(); } catch (caught) { error = caught; }
        h.ok(error, 'Expected rejection: ' + pattern);
        h.ok(new RegExp(pattern, 'i').test(error.message), 'Unexpected rejection: ' + error.message);
      };
      h.hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))))).map(byte => byte.toString(16).padStart(2, '0')).join('');
      h.bytes = files => Object.values(files).reduce((sum, file) => sum + new TextEncoder().encode(file.content || '').length, 0);
      h.name = id => 'synapse-update-' + id + '.json.enc';
      h.update = (extra = {}) => ({ app: 'Synapse', schema: 'gist-sync-update-v2', version: 2, updatedAt: 1, conversations: [], memories: [], projects: [], settingsState: {}, tombstones: {}, ...extra });
      h.chat = (id, text, syncVersion = { peer: 1 }) => ({ id, title: id, createdAt: 1, updatedAt: 2, syncVersion, messages: [{ role: 'user', content: text }] });
      h.context = await t.syncBuildCryptoContext(h.passphrase);
      h.manifest = { app: 'Synapse', schema: 'gist-sync-v2', version: 2, salt: h.context.saltBase64 };
      h.gist = { id: 'disposable-sync-fixture', files: { 'manifest.json': { content: JSON.stringify(h.manifest) } } };
      h.encrypt = payload => t.syncEncryptPayloadWithKey(payload, h.context);
      h.pack = (updates, id) => t.syncBuildUpdateFiles(t.syncPackUpdates(updates), h.context, h.name(id), h.manifest);
      h.read = (gist = h.gist, passphrase = h.passphrase) => t.syncReadArchiveUpdates(gist, passphrase, {});
      h.remote = async (gist = h.gist) => t.syncReadRemoteData(gist, await t.syncReadManifest(gist), h.passphrase);
      h.sourcesEqual = (actual, expected) => {
        h.eq([...actual.updates.keys()].sort(), [...expected.keys()].sort(), 'Every original update identity survives');
        for (const [name, payload] of expected) h.eq(actual.updates.get(name), payload, 'Raw payload and update boundary survive: ' + name);
      };
      h.seed = async (count, payload = h.update({ conversations: [h.chat('remote-only', 'Never implicitly pulled')] })) => {
        const content = await h.encrypt(payload);
        const updates = new Map();
        h.gist.files = { 'manifest.json': { content: JSON.stringify(h.manifest) } };
        for (let i = 0; i < count; i++) {
          const name = h.name('source-' + String(i).padStart(3, '0'));
          h.gist.files[name] = { content };
          updates.set(name, payload);
        }
        return updates;
      };
      h.apply = files => {
        for (const [name, file] of Object.entries(files)) {
          if (file === null) delete h.gist.files[name];
          else h.gist.files[name] = { ...file };
        }
      };
      h.view = () => ({ ...h.gist, files: Object.fromEntries(Object.entries(h.gist.files).map(([name, file]) => [name, {
        ...file, size: file.size ?? new TextEncoder().encode(file.content || '').length,
        ...(h.raw ? { content: '', truncated: true, raw_url: 'https://sync-fixture.invalid/raw/' + encodeURIComponent(name) } : {})
      }])) });
      h.response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
      const originalFetch = window.fetch;
      window.fetch = async (input, options = {}) => {
        const url = new URL(String(input), location.href);
        if (url.origin === 'https://sync-fixture.invalid' && url.pathname.startsWith('/raw/')) {
          const name = decodeURIComponent(url.pathname.slice(5));
          h.rawReads.push(name);
          return new Response(h.gist.files[name]?.content || '', { status: h.gist.files[name] ? 200 : 404 });
        }
        if (url.origin !== 'https://api.github.com' || !['/gists', '/gists/' + h.gist.id].includes(url.pathname)) {
          if (url.origin === location.origin) return originalFetch(input, options);
          h.unexpected.push(url.href);
          throw new Error('No external requests permitted by sync fixture: ' + url.href);
        }
        const method = options.method || 'GET';
        const entry = { method, added: [], deleted: [] };
        h.log.push(entry);
        if (method === 'GET') {
          const view = h.nextGet ? await h.nextGet() : h.view();
          h.nextGet = null;
          return h.response(view);
        }
        h.ok(method === 'PATCH' || method === 'POST', 'Unexpected Gist method: ' + method);
        const body = JSON.parse(options.body);
        const files = body.files;
        entry.added = Object.keys(files).filter(name => files[name] !== null);
        entry.deleted = Object.keys(files).filter(name => files[name] === null);
        entry.public = body.public;
        entry.maxFileBytes = Math.max(0, ...Object.values(files).filter(Boolean).map(file => new TextEncoder().encode(file.content).length));
        if (h.beforePatch) {
          const hook = h.beforePatch;
          h.beforePatch = null;
          const response = await hook(files, entry);
          if (response) return response;
        }
        h.apply(files);
        entry.accepted = true;
        entry.bytes = h.bytes(h.gist.files);
        entry.count = Object.keys(h.gist.files).length;
        if (h.afterPatch) {
          const hook = h.afterPatch;
          h.afterPatch = null;
          const response = await hook(files, entry);
          if (response) return response;
        }
        return h.response(h.view(), method === 'POST' ? 201 : 200);
      };
      h.configure = (id = h.gist.id, passphrase = h.passphrase) => {
        localStorage.setItem('assistantSyncGistToken', 'disposable-not-a-real-token');
        localStorage.setItem('assistantSyncPassphrase', passphrase);
        localStorage.setItem('assistantSyncGistId', id);
        localStorage.setItem('assistantSyncStateGistId', id);
        localStorage.setItem('assistantSyncAutoPush', 'false');
        renderSyncSettings();
      };
      h.push = async () => {
        const result = await syncPushToGist({ auto: Boolean(localStorage.getItem('assistantSyncGistId')) });
        h.status = document.getElementById('syncStatus').textContent + ': ' + document.getElementById('syncDetails').textContent;
        return result;
      };
      h.stored = async () => ({
        conversations: await idbGetAll('conversations'), memories: await idbGetAll('memories'),
        projects: await idbGet('meta', 'projects'), tombstones: await idbGet('meta', 'syncTombstones'),
        active: structuredClone(getActiveConv()), persona: localStorage.getItem('llmPersona'),
        deletions: localStorage.getItem('assistantSyncTombstones'), lastPull: localStorage.getItem('assistantSyncLastPullAt')
      });
      h.limits = () => {
        h.ok(h.bytes(h.gist.files) <= 32 * h.MiB, 'Live archive stays at or below 32 MiB');
        h.ok(Object.keys(h.gist.files).length < 250, 'Live archive stays below 250 files');
        for (const entry of h.log.filter(entry => entry.accepted)) {
          h.ok(entry.maxFileBytes <= 8 * h.MiB, 'Every uploaded physical file is at most 8 MiB');
          h.ok(entry.bytes <= 64 * h.MiB && entry.count < 300, 'Staging stays at most 64 MiB and below 300 files');
        }
      };
      h.large = async () => {
        const payload = h.update({ conversations: [h.chat('large-remote', 'Remote image')], future: 'A'.repeat(9 * h.MiB) });
        const filename = h.name('large');
        const built = await t.syncBuildUpdateFiles(payload, h.context, filename, h.manifest);
        return { gist: { id: h.gist.id, files: { ...h.gist.files, ...built.files } }, payload, filename };
      };
      window.confirm = () => true;
      closeModal('setupModal');
      h.configure();
      getActiveConv().messages = [{ role: 'user', content: 'Local data must survive' }];
      localStorage.setItem('llmPersona', 'Local persona must survive');
      await t.saveConversationImmediately();
      await t.saveProjects(true);
    });
  };
  const check = async (name, fn) => {
    const start = Date.now();
    try {
      await reset();
      await fn();
      assert.deepEqual(await page.evaluate(() => window.__syncFixture?.unexpected || []), [], 'No external fixture requests');
      passed++;
      console.log('sync: PASS ' + name + ' (' + (Date.now() - start) + ' ms)');
    } catch (error) {
      failures.push(name + ': ' + error.message);
      console.error('sync: FAIL ' + name + ': ' + error.message);
    }
  };
  const browserCheck = (name, fn, argument) => check(name, () => page.evaluate(fn, argument));

  try {
    await browserCheck('raw packs, escaping, original hashes, and timestamp-only snapshot deduplication', async () => {
      const h = window.__syncFixture, t = h.t;
      const repeated = 'repeated raw string '.repeat(100);
      const a = h.update({ future: { literal: ['~synapse:0', '~synapse:', '~synapse:999', '~synapse:01', '\u2603'], nested: [null, false, { repeated }] }, conversations: [h.chat('raw', repeated)], memories: [{ id: 'raw-memory', text: repeated, createdAt: 1 }], projects: [{ id: 'raw-project', name: repeated }] });
      const b = { ...a, updatedAt: 2 };
      const originals = new Map([[h.name('a'), a], [h.name('b'), b]]);
      const packed = t.syncPackUpdates(originals);
      h.eq(packed.strings.filter(value => value === repeated).length, 1, 'Repeated long strings are stored once');
      h.ok(JSON.stringify(packed).length < JSON.stringify([...originals]).length, 'Packing reduces repeated strings');
      h.apply((await h.pack(originals, 'physical')).files);
      const archive = await h.read();
      h.sourcesEqual(archive, originals);
      h.eq([...archive.sourceFiles], [h.name('physical')], 'Physical sources are not logical source IDs');
      h.eq(archive.snapshotHashes.size, 1, 'The top-level snapshot timestamp is ignored');
      h.ok(archive.hashes.get(h.name('a')) !== archive.hashes.get(h.name('b')), 'Original hashes retain updatedAt');
      for (const [name, payload] of originals) h.eq(archive.hashes.get(name), await h.hash(payload), 'Original hash covers raw JSON');
    });

    await browserCheck('actual archive above 32 MiB compacts without losing any source or implicitly pulling', async () => {
      const h = window.__syncFixture;
      const local = await h.stored();
      const raw = h.update({ conversations: [h.chat('remote-only', 'R'.repeat(h.MiB))], tombstones: { conversations: { [local.active.id]: Date.now() + 100000 }, conversationVersions: { [local.active.id]: local.active.syncVersion }, conversationRoots: { [local.active.id]: local.active.id } }, settingsState: { settings: { llmPersona: 'Remote persona' }, revisions: { llmPersona: Date.now() + 100000 } }, unknown: { preserve: true } });
      const originals = await h.seed(25, raw);
      const beforeBytes = h.bytes(h.gist.files);
      h.ok(beforeBytes > 32 * h.MiB && beforeBytes < 64 * h.MiB, 'Fixture really exceeds 32 MiB, without falsifying file sizes');
      const physical = Object.keys(h.gist.files).filter(name => name !== 'manifest.json');
      h.ok(await h.push(), h.status);
      const archive = await h.read();
      for (const [name, payload] of originals) h.eq(archive.updates.get(name), payload, 'Large archive source is preserved: ' + name);
      h.eq(archive.updates.size, originals.size + 1, 'Compaction includes the new local snapshot');
      h.eq(await h.stored(), local, 'Push does not import chats, settings, or deletion records');
      h.eq(h.log.map(entry => entry.method), ['GET', 'PATCH', 'GET', 'PATCH'], 'Upload, verification read, then separate cleanup');
      h.eq(h.log[1].deleted, [], 'Replacement upload never deletes');
      h.eq(h.log[3].deleted.sort(), physical.sort(), 'Cleanup deletes only captured source files');
      h.eq(JSON.parse(h.gist.files['manifest.json'].content).schema, 'gist-sync-v3', 'Compaction upgrades the manifest');
      h.ok(h.bytes(h.gist.files) < beforeBytes / 10, 'Repeated snapshots actually compact');
      h.limits();
      return { beforeBytes, afterBytes: h.bytes(h.gist.files) };
    });

    await browserCheck('250-file boundary, including an already-saved snapshot', async () => {
      const h = window.__syncFixture;
      for (const unchanged of [false, true]) {
        const local = await h.t.syncCapturePullSnapshot();
        local.settingsState = h.t.syncCollectSettingsState();
        const payload = unchanged ? (await h.t.syncBuildGistFiles(h.passphrase, h.manifest, local)).payload : h.update();
        const originals = await h.seed(unchanged ? 249 : 248, payload);
        h.log = [];
        h.ok(await h.push(), h.status);
        const archive = await h.read();
        h.eq(archive.updates.size, originals.size + (unchanged ? 0 : 1), 'Snapshot deduplication does not discard original identities');
        for (const [name, payload] of originals) h.eq(archive.updates.get(name), payload, 'File-count compaction preserves each source');
        h.ok(h.log.some(entry => entry.deleted.length === originals.size), 'Exactly the captured sources are cleaned up');
        h.limits();
      }
    });

    await check('new-Gist POST above 8 MiB and a fresh-browser reader recover identical image data', async () => {
      const fixture = await page.evaluate(async () => {
        const h = window.__syncFixture;
        h.gist.files = {};
        h.configure('');
        const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=' + 'A'.repeat(9 * h.MiB);
        getActiveConv().messages = [{ role: 'user', content: [{ type: 'text', text: 'Large image fixture' }, { type: 'image_url', image_url: { url: image } }] }];
        await h.t.saveConversationImmediately();
        const record = await idbGet('conversations', getActiveConv().id);
        h.ok(await h.push(), h.status);
        h.eq(h.log.map(entry => entry.method), ['POST', 'GET'], 'New Gist is verified after POST');
        h.eq(h.log[0].public, false, 'New fixture Gist is private');
        h.ok(h.bytes(h.gist.files) > 8 * h.MiB, 'Actual encrypted image exceeds one physical file');
        const name = Object.keys(h.gist.files).find(name => /^synapse-update-.*\.json\.enc$/.test(name));
        const header = await h.t.syncDecryptPayload(h.gist.files[name].content, h.passphrase);
        h.eq(header.schema, 'gist-sync-parts-v3', 'Chunk header is encrypted and authenticated');
        h.ok(header.parts >= 2, 'Image is physically split');
        const archive = await h.read();
        h.eq([...archive.sourceFiles].sort(), Object.keys(h.gist.files).filter(name => name !== 'manifest.json').sort(), 'Source files include header and every part');
        h.limits();
        record.messages[0].content[1].image_url.url = await h.hash(image);
        return { gist: h.gist, record };
      });
      // Reload after clearing both browser stores: no writer key cache or local image remains.
      await reset();
      const recovered = await page.evaluate(async fixture => {
        const h = window.__syncFixture;
        h.gist = fixture.gist;
        h.configure();
        h.raw = true;
        h.ok(!(await idbGet('conversations', fixture.record.id)), 'Fresh reader does not already have the image');
        h.ok(await syncPullFromGist(), document.getElementById('syncDetails').textContent);
        const record = await idbGet('conversations', fixture.record.id);
        record.messages[0].content[1].image_url.url = await h.hash(record.messages[0].content[1].image_url.url);
        h.ok(h.rawReads.some(name => name.endsWith('.part-0')), 'Truncated inline content uses fixture raw URLs');
        return record;
      }, fixture);
      assert.deepEqual(recovered, fixture.record, 'Full conversation and image bytes are equal, independent of object property order');
    });

    await browserCheck('compacting split sources cleans only their physical headers and parts', async () => {
      const h = window.__syncFixture;
      await h.seed(247);
      const large = await h.large();
      h.gist = large.gist;
      const before = await h.read();
      h.ok(before.sourceFiles.has(large.filename + '.part-0'), 'Compaction fixture contains real split sources');
      h.ok(await h.push(), h.status);
      const after = await h.read();
      for (const [name, payload] of before.updates) h.eq(after.updates.get(name), payload, 'Split-source original payload is intact');
      h.eq(after.updates.size, before.updates.size + 1, 'Compaction adds exactly one local source');
      const cleanup = h.log.filter(entry => entry.deleted.length);
      h.eq(cleanup.length, 1, 'One separate cleanup request');
      h.eq(cleanup[0].deleted.sort(), [...before.sourceFiles].sort(), 'Cleanup includes each captured header and part, not logical IDs');
      h.ok(!h.gist.files[large.filename] && !h.gist.files[large.filename + '.part-0'], 'Old split source is physically removed');
      h.ok([...after.sourceFiles].some(name => name.endsWith('.part-0')), 'Replacement pack itself can be split');
      h.limits();
    });

    await browserCheck('100 small changed/unchanged pushes keep storage bounded and remain v2 when simple', async () => {
      const h = window.__syncFixture;
      h.gist.files = {};
      h.configure('');
      h.ok(await h.push(), h.status);
      h.eq(JSON.parse(h.gist.files['manifest.json'].content).schema, 'gist-sync-v2', 'Simple small push stays v2');
      const firstName = h.log.find(entry => entry.method === 'POST').added[0];
      h.eq((await h.t.syncDecryptPayload(h.gist.files[firstName].content, h.passphrase)).schema, 'gist-sync-update-v2', 'Simple payload stays v2');
      const originals = await h.seed(240);
      h.log = [];
      for (let i = 0; i < 100; i++) {
        getActiveConv().messages = [{ role: 'user', content: 'Small change ' + Math.floor(i / 2) }];
        await h.t.saveConversationImmediately();
        localStorage.removeItem('assistantSyncLastHash');
        const writes = h.log.filter(entry => entry.added.length).length;
        h.ok(await h.push(), 'Push ' + i + ': ' + h.status);
        h.eq(h.log.filter(entry => entry.added.length).length, writes + (i % 2 ? 0 : 1), 'Unchanged push consults the remote archive, not just a local last-hash cache');
        h.limits();
      }
      const archive = await h.read();
      h.eq(archive.updates.size, originals.size + 50, 'Only 50 changed snapshots added, all historical sources retained');
      h.ok(h.log.some(entry => entry.deleted.length), 'The repeated-push test crosses the compaction threshold');
      h.ok(h.bytes(h.gist.files) < h.MiB, 'Small snapshots remain below 1 MiB after 100 pushes');
    });

    await browserCheck('time-based union of C/B and X/Y, per-update memories, deletion roots, overlapping packs', async () => {
      const h = window.__syncFixture;
      const originals = new Map([
        [h.name('a'), h.update({ conversations: [h.chat('CB', 'A', { a: 1 }), h.chat('XY', 'X', { a: 1 }), h.chat('deleted-root', 'Deleted through conflict-copy root', { d: 1 })], memories: [{ id: 'equal', text: 'first', createdAt: 1 }, { id: 'equal', text: 'same-update duplicate', createdAt: 1 }], future: { raw: '~synapse:0' } })],
        [h.name('b'), h.update({ conversations: [h.chat('CB', 'B', { b: 1 }), h.chat('XY', 'Y', { b: 1 })], memories: [{ id: 'equal', text: 'second', createdAt: 1 }] })],
        [h.name('c'), h.update({ conversations: [h.chat('CB', 'C', { a: 2 }), h.chat('XY', 'X', { b: 2 })], memories: [{ id: 'equal', text: 'last', createdAt: 1 }], tombstones: { conversations: { conflict_deleted: 10 }, conversationVersions: { conflict_deleted: { d: 1 } }, conversationRoots: { conflict_deleted: 'deleted-root' }, memories: { removed: 4 }, projects: { removed: 5 } } })]
      ]);
      for (const [name, payload] of originals) h.gist.files[name] = { content: await h.encrypt(payload) };
      const before = await h.remote();
      const family = (remote, root) => remote.conversations.filter(record => record.id === root);
      const contents = (remote, root) => [...new Set(family(remote, root).flatMap(record => record.messages.map(message => message.content)))].sort();
      h.eq(family(before, 'CB').length, 1, 'Concurrent branches combine into one chat instead of conflict copies');
      h.eq(contents(before, 'CB'), ['A', 'B', 'C'], 'No branch content is lost when C meets the concurrent B branch');
      h.eq(family(before, 'XY').length, 1, 'Snapshots of one chat stay one chat');
      h.eq(contents(before, 'XY'), ['X', 'Y'], 'Identical X snapshots deduplicate by message id while Y is kept');
      h.eq(before.conversations.some(record => record.conflictOf === 'CB' || record.conflictOf === 'XY'), false, 'Union never forks conflict copies');
      h.eq(before.memories.map(memory => memory.text).sort(), ['last', 'same-update duplicate'], 'Equal-time memory selection respects update boundaries');
      h.eq(family(before, 'deleted-root').length, 0, 'Version-covered deletions stay deleted through the union');
      const first = await h.pack(new Map([...[...originals].slice(0, 1), ...[...originals].slice(2)]), '000-physical');
      const second = await h.pack(new Map([...originals].slice(0, 2)), 'zzz-physical');
      h.gist.files = { ...second.files, ...first.files };
      const archive = await h.read();
      h.sourcesEqual(archive, originals);
      h.eq(archive.hashes.size, 3, 'Equal overlapping original IDs deduplicate');
      const after = await h.remote();
      for (const key of ['conversations', 'memories', 'projects', 'settingsState', 'tombstones']) h.eq(after[key], before[key], 'Packing preserves reconciliation result: ' + key);
      const collision = new Map([[h.name('a'), { ...originals.get(h.name('a')), future: { changed: true } }]]);
      h.apply((await h.pack(collision, 'collision')).files);
      await h.rejects(() => h.read(), 'Conflicting copies');
      const local = await h.stored();
      h.ok(!await h.push(), 'Conflicting original IDs reject push');
      h.eq(h.log.filter(entry => entry.method !== 'GET').length, 0, 'Collision cannot upload or clean up');
      h.ok(!await syncPullFromGist(), 'Conflicting original IDs reject pull');
      h.eq(await h.stored(), local, 'Collision cannot change local data');
    });

    for (const scenario of ['append', 'two compactors', 'absorbed replacement']) {
      await browserCheck('stale GET before PATCH: ' + scenario, async scenario => {
        const h = window.__syncFixture;
        const originals = await h.seed(248);
        const captured = new Set((await h.read()).sourceFiles);
        const peerName = h.name('concurrent-peer');
        const peer = h.update({ conversations: [h.chat('peer', 'Concurrent peer')], unknown: { retained: true } });
        let peerPhysical;
        if (scenario === 'append') h.beforePatch = async () => { h.gist.files[peerName] = { content: await h.encrypt(peer) }; };
        if (scenario === 'two compactors') h.beforePatch = async () => {
          const packed = await h.pack(new Map([...originals, [peerName, peer]]), 'peer-compactor');
          h.apply(packed.files);
          peerPhysical = h.name('peer-compactor');
          captured.forEach(name => delete h.gist.files[name]);
        };
        if (scenario === 'absorbed replacement') h.afterPatch = async () => {
          const accepted = await h.read();
          const packed = await h.pack(new Map([...accepted.updates, [peerName, peer]]), 'absorbed-by-peer');
          h.apply(packed.files);
          peerPhysical = h.name('absorbed-by-peer');
          accepted.sourceFiles.forEach(name => delete h.gist.files[name]);
        };
        h.ok(await h.push(), h.status);
        const recovered = await h.read();
        h.eq(recovered.updates.size, originals.size + 2, 'Both concurrent writers remain recoverable');
        for (const [name, payload] of [...originals, [peerName, peer]]) h.eq(recovered.updates.get(name), payload, 'Concurrent source survives: ' + name);
        for (const entry of h.log) h.ok(entry.deleted.every(name => captured.has(name)), 'Cleanup cannot delete files discovered after the stale GET');
        if (peerPhysical) h.ok(h.gist.files[peerPhysical], 'Concurrent pack survives cleanup');
        if (scenario === 'two compactors') h.eq(recovered.sourceFiles.size, 2, 'Both independent packs coexist and shared source IDs deduplicate');
        if (scenario === 'absorbed replacement') h.eq([...recovered.sourceFiles], [peerPhysical], 'Verification accepts the source union even after our physical replacement disappears');
        h.limits();
      }, scenario);
    }

    for (const failure of ['upload rejected', 'accepted but response lost', 'verification failed', 'cleanup failed']) {
      await browserCheck('interruption and retry: ' + failure, async failure => {
        const h = window.__syncFixture;
        const originals = await h.seed(248);
        const captured = new Set((await h.read()).sourceFiles);
        const initialFiles = { ...h.gist.files };
        const before = await h.stored();
        if (failure === 'upload rejected') h.beforePatch = () => h.response({ message: 'Injected pre-acceptance failure' }, 503);
        else h.afterPatch = async files => {
          if (failure === 'accepted but response lost') throw new TypeError('Injected lost response after acceptance');
          if (failure === 'verification failed') h.nextGet = () => {
            const view = h.view();
            Object.keys(files).filter(name => name !== 'manifest.json').forEach(name => delete view.files[name]);
            return view;
          };
          if (failure === 'cleanup failed') h.beforePatch = (files, entry) => {
            h.ok(entry.deleted.length > 0 && !entry.added.length, 'Failure is injected only into separate cleanup');
            return h.response({ message: 'Injected cleanup failure' }, 503);
          };
        };
        h.eq(await h.push(), failure === 'cleanup failed', 'Failure reports whether data was verified');
        h.ok([...captured].every(name => h.gist.files[name]), 'Failure retains every captured source');
        h.eq(await h.stored(), before, 'Interrupted push never applies remote data');
        h.eq(h.log.filter(entry => entry.deleted.length).length, failure === 'cleanup failed' ? 1 : 0, 'No cleanup before accepted, verified replacement');
        if (failure === 'upload rejected') h.eq(h.gist.files, initialFiles, 'Rejected upload changes nothing remotely');
        if (failure === 'cleanup failed') h.ok(h.status.includes('cleanup pending'), 'Saved-but-not-cleaned status is explicit');
        h.ok(await h.push(), 'Retry: ' + h.status);
        const recovered = await h.read();
        h.eq(recovered.updates.size, originals.size + 1, 'Retry does not add another timestamp-only snapshot');
        for (const [name, payload] of originals) h.eq(recovered.updates.get(name), payload, 'Retry preserves source: ' + name);
        h.ok([...captured].every(name => !h.gist.files[name]), 'Retry eventually cleans captured old files');
        h.limits();
      }, failure);
    }

    await browserCheck('verification requires every original raw hash, not merely the new local snapshot', async () => {
      const h = window.__syncFixture;
      for (const damage of ['missing original', 'changed original']) {
        const originals = await h.seed(248);
        const captured = new Set((await h.read()).sourceFiles);
        h.log = [];
        h.afterPatch = async (files, entry) => {
          const accepted = await h.read();
          const incomplete = new Map(accepted.updates);
          const name = originals.keys().next().value;
          if (damage === 'missing original') incomplete.delete(name);
          else incomplete.set(name, { ...incomplete.get(name), unknown: 'Changed after stale read' });
          const uploadedName = entry.added.find(name => /^synapse-update-.*\.json\.enc$/.test(name));
          const replacement = await h.t.syncBuildUpdateFiles(h.t.syncPackUpdates(incomplete), h.context, uploadedName, h.manifest);
          h.nextGet = () => {
            const view = h.view();
            captured.forEach(name => delete view.files[name]);
            Object.assign(view.files, replacement.files);
            return view;
          };
        };
        const local = await h.stored();
        h.ok(!await h.push(), damage + ': verification must fail despite a valid local snapshot');
        h.ok(h.status.includes('could not be verified'), damage + ': failure is source-union verification');
        h.eq(h.log.filter(entry => entry.deleted.length).length, 0, damage + ': no cleanup');
        h.ok([...captured].every(name => h.gist.files[name]), damage + ': original physical files retained');
        h.eq(await h.stored(), local, damage + ': no implicit local apply');
      }
    });

    await browserCheck('missing/corrupt chunks, wrong passphrase and tampered header fail before local apply or cleanup', async () => {
      const h = window.__syncFixture;
      const large = await h.large();
      const part = large.filename + '.part-0';
      for (const damage of ['missing part', 'short part', 'corrupt part', 'wrong passphrase', 'header authentication', 'part count', 'content hash']) {
        h.gist = { ...large.gist, files: { ...large.gist.files } };
        h.configure(undefined, damage === 'wrong passphrase' ? 'not-the-fixture-passphrase' : h.passphrase);
        if (damage === 'missing part') delete h.gist.files[part];
        if (damage === 'short part') h.gist.files[part] = { content: h.gist.files[part].content.slice(1) };
        if (damage === 'corrupt part') h.gist.files[part] = { content: '!' + h.gist.files[part].content.slice(1) };
        if (damage === 'header authentication') {
          const envelope = JSON.parse(h.gist.files[large.filename].content);
          envelope.data = (envelope.data[0] === 'A' ? 'B' : 'A') + envelope.data.slice(1);
          h.gist.files[large.filename] = { content: JSON.stringify(envelope) };
        }
        if (damage === 'part count' || damage === 'content hash') {
          const header = await h.t.syncDecryptPayload(h.gist.files[large.filename].content, h.passphrase);
          if (damage === 'part count') header.parts++;
          else header.hash = '0'.repeat(64);
          h.gist.files[large.filename] = { content: await h.encrypt(header) };
        }
        const before = await h.stored();
        h.log = [];
        h.ok(!await syncPullFromGist(), damage + ': pull must fail');
        h.eq(await h.stored(), before, damage + ': all browser data remains unchanged');
        h.ok(!document.querySelector('.input-area').inert, damage + ': pull releases composer lock');
        h.ok(!await h.push(), damage + ': push must fail');
        h.eq(h.log.filter(entry => entry.method !== 'GET').length, 0, damage + ': no upload or cleanup');
      }
      h.gist = large.gist;
      h.configure();
      h.ok(await syncPullFromGist(), 'Restoring complete parts makes pull retryable');
    });

    await browserCheck('truncated lists, invalid/unsupported manifests and malformed updates fail closed', async () => {
      const h = window.__syncFixture;
      const invalid = [
        ['truncated file list', async () => { h.gist.truncated = true; }],
        ['invalid manifest JSON', async () => { h.gist.files['manifest.json'] = { content: '{' }; }],
        ['unsupported manifest', async () => { h.gist.files['manifest.json'] = { content: JSON.stringify({ app: 'Synapse', schema: 'gist-sync-v99' }) }; }],
        ['truncated file without raw URL', async () => { h.gist.files[h.name('source-000')].truncated = true; }],
        ['unsupported update', async () => { h.gist.files[h.name('source-000')] = { content: await h.encrypt(h.update({ schema: 'gist-sync-update-v99' })) }; }],
        ['invalid update arrays', async () => { h.gist.files[h.name('source-000')] = { content: await h.encrypt(h.update({ memories: {} })) }; }],
        ['missing packed string', async () => { h.gist.files[h.name('source-000')] = { content: await h.encrypt({ app: 'Synapse', schema: 'gist-sync-pack-v3', json: JSON.stringify([[h.name('a'), '~synapse:9']]), strings: [] }) }; }],
        ['invalid packed source ID', async () => { h.gist.files[h.name('source-000')] = { content: await h.encrypt(h.t.syncPackUpdates(new Map([['../invalid.json.enc', h.update()]]))) }; }],
        ['empty pack', async () => { h.gist.files[h.name('source-000')] = { content: await h.encrypt(h.t.syncPackUpdates(new Map())) }; }]
      ];
      for (const [name, damage] of invalid) {
        delete h.gist.truncated;
        await h.seed(1);
        await damage();
        const before = await h.stored();
        h.log = [];
        h.ok(!await h.push(), name + ': push fails');
        h.ok(!await syncPullFromGist(), name + ': pull fails');
        h.eq(await h.stored(), before, name + ': no local apply');
        h.eq(h.log.filter(entry => entry.method !== 'GET').length, 0, name + ': no remote writes');
      }
    });

    await browserCheck('read/staging/live size metadata and 300-file staging limits reject without cleanup', async () => {
      const h = window.__syncFixture;
      for (const limit of ['read 64 MiB', 'staged 64 MiB', 'live 32 MiB', 'staged 300 files']) {
        await h.seed(limit === 'staged 300 files' ? 298 : 1);
        if (limit === 'read 64 MiB') h.gist.files[h.name('source-000')].size = 64 * h.MiB + 1;
        if (limit === 'staged 64 MiB') h.gist.files[h.name('source-000')].size = 64 * h.MiB - h.bytes({ 'manifest.json': h.gist.files['manifest.json'] });
        if (limit === 'live 32 MiB') h.gist.files['unmanaged-backup.txt'] = { content: 'Preserve this backup', size: 32 * h.MiB };
        const before = await h.stored();
        const files = JSON.stringify(h.gist.files);
        h.log = [];
        h.ok(!await h.push(), limit + ': oversized operation fails');
        h.eq(h.log.filter(entry => entry.method !== 'GET').length, 0, limit + ': rejected before mutation');
        h.eq(JSON.stringify(h.gist.files), files, limit + ': physical sources retained');
        h.eq(await h.stored(), before, limit + ': local data unchanged');
      }
      await h.rejects(() => h.t.syncBuildUpdateFiles(h.update({ future: 'L'.repeat(25 * h.MiB) }), h.context, h.name('too-large'), h.manifest), 'exceeds 32 MiB');
    });

    let compatibility;
    await check('v1/v2/mixed reads and v3 upgrade preserve legacy physical files', async () => {
      compatibility = await page.evaluate(async () => {
        const h = window.__syncFixture;
        const originals = await h.seed(248);
        const legacyManifest = { app: 'Synapse', schema: 'gist-sync-v1', files: { conversations: [{ file: 'legacy-chat.json.enc' }], memories: 'memories.json.enc', projects: 'projects.json.enc', settings: 'settings.json.enc', tombstones: 'tombstones.json.enc' } };
        const legacyFiles = {
          'legacy-chat.json.enc': { content: await h.encrypt({ conversation: h.chat('legacy-listed', 'Listed v1 chat') }) },
          'conv_orphan.json.enc': { content: await h.encrypt({ conversation: h.chat('legacy-orphan', 'Unindexed v1 chat') }) },
          'memories.json.enc': { content: await h.encrypt({ memories: [{ id: 'legacy-memory', text: 'Legacy memory', createdAt: 1 }] }) },
          'projects.json.enc': { content: await h.encrypt({ projects: [{ id: 'legacy-project', name: 'Legacy project', createdAt: 1, updatedAt: 1 }] }) },
          'settings.json.enc': { content: await h.encrypt({ settings: { llmPersona: 'Legacy persona' }, exportedAt: '2020-01-01T00:00:00.000Z' }) },
          'tombstones.json.enc': { content: await h.encrypt({ tombstones: { memories: { old: 1 }, conversationRoots: {}, conversationVersions: {} } }) }
        };
        const v1 = { id: h.gist.id, files: { 'manifest.json': { content: JSON.stringify(legacyManifest) }, ...legacyFiles } };
        const legacy = await h.remote(v1);
        h.eq(legacy.conversations.length, 2, 'New reader reads v1 indexed and discovered chats');
        const v2 = { ...h.gist, files: { ...h.gist.files } };
        h.eq((await h.remote(v2)).archive.updates.size, originals.size, 'New reader reads unmodified v2 updates');
        h.gist.files = { ...h.gist.files, ...v1.files };
        const mixed = await h.remote();
        h.ok(mixed.conversations.some(record => record.id === 'remote-only'), 'Mixed v1/v2 archive remains readable');
        h.ok(await h.push(), h.status);
        const manifest = JSON.parse(h.gist.files['manifest.json'].content);
        h.eq(manifest.schema, 'gist-sync-v3', 'Legacy archive upgrades during compaction');
        h.eq(manifest.legacy, true, 'Upgrade retains legacy marker');
        h.eq(manifest.files, legacyManifest.files, 'Upgrade retains legacy file pointers');
        for (const [name, file] of Object.entries(legacyFiles)) h.eq(h.gist.files[name], file, 'Legacy physical file remains byte-identical: ' + name);
        const upgraded = await h.remote();
        for (const id of ['legacy-listed', 'legacy-orphan', 'remote-only']) h.ok(upgraded.conversations.some(record => record.id === id), 'Mixed v1/v2/v3 retains chat: ' + id);
        h.eq(upgraded.memories, mixed.memories, 'Legacy memories survive upgrade');
        h.eq(upgraded.projects, mixed.projects, 'Legacy projects survive upgrade');
        const packed = h.gist;
        const large = await h.large();
        const split = { ...large.gist, files: Object.fromEntries(Object.entries(large.gist.files).filter(([name]) => name === 'manifest.json' || name === large.filename || name.startsWith(large.filename + '.part-'))) };
        return { v1, v2, packed, split, passphrase: h.passphrase };
      });
    });

    await check('unmodified pre-v3 reader rejects packs and parts even through manifest fallback', async () => {
      assert.ok(compatibility, 'Compatibility fixtures were built');
      // Pin the shipped v2 reader so committing this suite does not move the compatibility baseline.
      const oldSource = execFileSync('git', ['show', '63721cafdbc0a099b4bbeafdef8aa135e10c4e24:assistant/js/main.js'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      assert.ok(!oldSource.includes('function syncPackUpdates'), 'Baseline is genuinely the old v2 implementation');
      moduleBody = oldSource + '\nwindow.__syncTest = { ' + common + ' };\n';
      await page.goto(origin + '/?sync-old-reader', { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.__syncTest && window.getActiveConv?.());
      const result = await page.evaluate(async fixture => {
        const t = window.__syncTest;
        const results = [];
        for (const name of ['v1', 'v2', 'packed', 'split']) {
          const gist = fixture[name];
          const manifest = await t.syncReadManifest(gist);
          let error = '';
          try { await t.syncReadRemoteData(gist, manifest, fixture.passphrase); }
          catch (caught) { error = caught.message; }
          results.push({ name, schema: manifest.schema, error });
        }
        return results;
      }, compatibility);
      for (const item of result.slice(0, 2)) assert.equal(item.error, '', 'Old reader accepts ' + item.name);
      for (const item of result.slice(2)) {
        assert.ok(['gist-sync-v1', 'gist-sync-v2'].includes(item.schema), 'Old manifest fallback was actually reached');
        assert.match(item.error, /Invalid sync update/, 'Old reader cannot silently ignore ' + item.name);
      }
    });
  } finally {
    await page.unroute('**/js/main.js*', moduleRoute);
    if (standalone) await page.unroute('**/synapse.html', standaloneRoute);
    if (readFileSync(path.join(root, 'js/main.js'), 'utf8') !== source) console.warn('sync: production main.js changed during this run; results cover the source SHA-256 printed above. Rerun for the new version.');
  }
  console.log('sync: ' + passed + ' passed, ' + failures.length + ' failed');
  assert.deepEqual(failures, [], 'Sync regression failures');
};
