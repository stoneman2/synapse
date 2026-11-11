const assert = require('node:assert/strict');
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { gzipSync } = require('node:zlib');

module.exports = async function(page) {
  const root = path.resolve(__dirname, '..');
  const [shell, main, worker, standalone, version] = await Promise.all(
    ['index.html', 'js/main.js', 'sw.js', 'synapse.html', 'version.json'].map(file => readFile(path.join(root, file), 'utf8')));
  const token = worker.match(/const CACHE_VERSION = 'synapse-(\d+)'/)[1];
  const date = JSON.parse(version).buildDate;
  assert.equal(date.replace(/\D/g, '').slice(0, 14), token);
  for (const html of [shell, worker]) {
    assert.ok(html.includes('styles.css?v=' + token));
    assert.ok(html.includes('js/main.js?v=' + token));
  }
  for (const text of [main, standalone]) assert.ok(text.includes("buildDate: '" + date + "'"));
  for (const name of ['dom-utils', 'text-utils']) {
    assert.ok(main.includes('./lib/' + name + '.js?v=' + token));
    assert.ok(worker.includes('./js/lib/' + name + '.js?v=' + token));
  }
  for (const prefix of ['cat', 'butler', 'maid', 'plushie', 'zom']) {
    assert.equal((standalone.match(new RegExp('"' + prefix + '_[a-z]+":"data:image/webp;base64,', 'g')) || []).length, 24);
  }
  assert.ok(!standalone.includes('<script type="module" src="./js/main.js'));

  let previous = true;
  let revision = 'first';
  let versionUnavailable = false;
  let serverErrors = false;
  let apiCalls = 0;
  let versionCalls = 0;
  let scriptCalls = 0;
  const oldToken = '199901010000';
  // Reproduce the old cache-first worker, rather than testing the new worker
  // against a renamed copy of itself. Routing is deliberately not used: it
  // disables Chromium's HTTP cache and would hide the second stale-cache layer.
  const legacyWorker = `
    const key = 'synapse-${oldToken}';
    const files = ['./', './index.html', './styles.css?v=${oldToken}', './js/main.js?v=${oldToken}', './js/lib/dom-utils.js', './js/lib/text-utils.js'];
    self.addEventListener('install', e => e.waitUntil(caches.open(key).then(c => c.addAll(files)).then(() => self.skipWaiting())));
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', e => {
      if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
      e.respondWith((async () => {
        const cache = await caches.open(key);
        if (e.request.mode !== 'navigate') { const hit = await cache.match(e.request); if (hit) return hit; }
        try { const r = await fetch(e.request); if (r.ok) await cache.put(e.request, r.clone()); return r; }
        catch (error) { const hit = await cache.match(e.request); if (hit) return hit; throw error; }
      })());
    });`;
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp' };
  const server = http.createServer(async (request, response) => {
    try {
      const name = new URL(request.url, 'http://localhost').pathname;
      const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + path.sep)) throw new Error('Not found');
      if (name === '/api/probe') {
        apiCalls++;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"ok":true}');
        return;
      }
      if (name === '/version.json') versionCalls++;
      if (name === '/js/main.js') scriptCalls++;
      if ((versionUnavailable && name === '/version.json') || (serverErrors && (name.endsWith('.js') || name.endsWith('.css')))) {
        response.writeHead(503); response.end('Simulated deployment outage'); return;
      }
      let body;
      if (previous && name === '/sw.js') body = legacyWorker;
      else if (previous && (name === '/' || name === '/index.html')) body = '<!doctype html><link rel="stylesheet" href="./styles.css?v=' + oldToken + '"><script src="./js/main.js?v=' + oldToken + '"></script>';
      else if (previous && name === '/js/main.js') body = 'window.previousRelease = true;';
      else {
        body = await readFile(file);
        if (!previous && name === '/js/main.js') body = body.toString() + `
          import { releaseProbe } from './lib/text-utils.js?v=${token}';
          window.moduleReleaseProbe = releaseProbe;
          window.releaseProbe = '${revision}';
          window.__updateTest = {
            setBusy(value) { sending = value; },
            setSyncBusy(value) { _syncOperationInFlight = value; },
            saveConversationImmediately,
            failSave() { saveConversationImmediately = async () => { throw new Error('Simulated storage failure'); }; }
          };`;
        if (!previous && name === '/js/lib/text-utils.js') body = body.toString() + `\nexport const releaseProbe = '${revision}';`;
        if (!previous && name === '/styles.css') body = body.toString() + `\n:root { --release-probe: ${revision}; }`;
      }
      const compressed = gzipSync(body);
      response.writeHead(200, {
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length,
        'Cache-Control': name === '/sw.js' || name === '/version.json' ? 'no-store' : 'public, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self'"
      });
      response.end(compressed);
    } catch { response.writeHead(404); response.end(); }
  });
  let context;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    context = await page.context().browser().newContext({ serviceWorkers: 'allow' });
    const tab = await context.newPage();
    const errors = [];
    tab.on('pageerror', error => errors.push(error.message));
    await tab.goto(origin);
    assert.equal(await tab.evaluate(() => window.previousRelease), true);
    await tab.evaluate(async () => {
      await navigator.serviceWorker.register('./sw.js');
      await navigator.serviceWorker.ready;
      localStorage.setItem('assistantTheme', 'light');
      localStorage.setItem('assistantConversations', JSON.stringify([{ id: 'release-chat', title: 'Before upgrade', messages: [{ role: 'user', content: 'Keep this through upgrade' }], createdAt: 1, updatedAt: 1 }]));
      localStorage.setItem('assistantActiveConvId', 'release-chat');
      for (const name of ['other-app-cache', 'synapse-encrypted-downloads']) {
        const cache = await caches.open(name);
        await cache.put('./unrelated', new Response('Keep unrelated cached data'));
      }
    });
    await tab.waitForFunction(() => navigator.serviceWorker.controller);
    assert.ok((await tab.evaluate(() => caches.keys())).includes('synapse-' + oldToken));
    previous = false;
    await tab.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await tab.waitForFunction(async token => {
      const keys = await caches.keys();
      return keys.includes('synapse-' + token) && !keys.includes('synapse-199901010000');
    }, token);
    assert.equal(await tab.evaluate(() => window.previousRelease), true, 'installing a new worker never forces an active page to reload');
    await tab.reload({ waitUntil: 'load' });
    await tab.waitForFunction(() => window.getActiveConv?.()?.id === 'release-chat');
    assert.equal(await tab.evaluate(() => getActiveConv().messages[0].content), 'Keep this through upgrade');
    assert.equal(await tab.evaluate(() => localStorage.getItem('assistantTheme')), 'light');
    assert.equal(await tab.evaluate(() => releaseProbe), 'first');
    assert.equal(await tab.evaluate(() => moduleReleaseProbe), 'first');
    const options = await tab.evaluate(async () => (await navigator.serviceWorker.getRegistration()).updateViaCache);
    assert.equal(options, 'none');
    assert.ok((await tab.evaluate(async token => (await (await caches.open('synapse-' + token)).match('./js/main.js?v=' + token)).text(), token)).includes(date));
    const baselineSelfTest = await tab.evaluate(() => synapseSelfTest());
    // Update the server without bumping a URL/cache version. Normal reloads
    // must still obtain fresh main code, its imports, and CSS.
    revision = 'second';
    const beforeScripts = scriptCalls;
    await tab.reload({ waitUntil: 'load' });
    await tab.waitForFunction(() => window.releaseProbe === 'second');
    assert.equal(await tab.evaluate(() => moduleReleaseProbe), 'second');
    assert.equal(await tab.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--release-probe').trim()), 'second');
    assert.ok(scriptCalls > beforeScripts, 'online code requests bypass the long-lived HTTP cache');
    await tab.evaluate(async () => {
      const r = await fetch('./api/probe', { method: 'POST', body: 'Do not retry or cache' });
      if (!r.ok) throw new Error('Mock API request failed');
      await fetch('./version.json');
      for (const prefix of ['cat', 'butler', 'maid', 'plushie', 'zom']) await fetch(getEmotionSpriteAssetUrl(prefix + '_happy'));
    });
    assert.equal(apiCalls, 1, 'non-GET API requests pass through once');
    assert.equal(await tab.evaluate(async token => {
      const urls = (await (await caches.open('synapse-' + token)).keys()).map(request => request.url);
      return urls.some(url => url.includes('/api/probe') || url.includes('/version.json'));
    }, token), false, 'API requests and version metadata are not app cached');
    serverErrors = true;
    await tab.reload({ waitUntil: 'load' });
    await tab.waitForFunction(() => window.releaseProbe === 'second');
    serverErrors = false;
    console.log('Release: legacy cache-first upgrade, fresh code/imports/CSS despite immutable HTTP caches, 503 fallback, and uncached API calls passed');
    await context.setOffline(true);
    await tab.reload({ waitUntil: 'load' });
    await tab.waitForFunction(() => window.getActiveConv?.()?.id === 'release-chat');
    assert.deepEqual(await tab.evaluate(() => synapseSelfTest()), baselineSelfTest, 'offline behavior matches the online self-test baseline');
    assert.equal(await tab.evaluate(() => getActiveConv().messages[0].content), 'Keep this through upgrade');
    assert.equal(await tab.evaluate(async () => {
      const results = await Promise.all(['cat', 'butler', 'maid', 'plushie', 'zom'].map(prefix => fetch(getEmotionSpriteAssetUrl(prefix + '_happy'))));
      return results.every(response => response.ok);
    }), true);
    assert.equal(await tab.evaluate(async () => {
      try { await fetch('./version.json'); return true; } catch { return false; }
    }), false, 'offline version checks must not claim a stale build is current');
    assert.equal(await tab.evaluate(() => refreshAppFiles()), false);
    assert.ok((await tab.evaluate(() => caches.keys())).includes('synapse-' + token), 'offline refresh keeps the offline cache');
    await context.setOffline(false);
    await tab.evaluate(() => {
      closeModal('setupModal', false);
      window.__refreshApprovals = [];
      window.confirm = text => { __refreshApprovals.push(text); return true; };
    });
    const beforeGuards = versionCalls;
    await tab.evaluate(() => __updateTest.setBusy(true));
    assert.equal(await tab.evaluate(() => refreshAppFiles()), false);
    await tab.evaluate(() => { __updateTest.setBusy(false); __updateTest.setSyncBusy(true); });
    assert.equal(await tab.evaluate(() => refreshAppFiles()), false);
    await tab.evaluate(() => { __updateTest.setSyncBusy(false); openSettings(); });
    await tab.locator('#setKey').fill('unsaved-key');
    assert.equal(await tab.evaluate(() => refreshAppFiles()), false);
    await tab.evaluate(() => closeSettings());
    await tab.evaluate(() => { getActiveConv().messages[0]._editing = true; });
    assert.equal(await tab.evaluate(() => refreshAppFiles()), false);
    await tab.evaluate(() => { delete getActiveConv().messages[0]._editing; });
    assert.equal(versionCalls, beforeGuards, 'busy and unfinished-edit guards do not start a refresh');
    versionUnavailable = true;
    assert.equal(await tab.evaluate(() => refreshAppFiles()), false);
    assert.ok((await tab.evaluate(() => caches.keys())).includes('synapse-' + token), 'network failure preserves the offline cache');
    versionUnavailable = false;
    await tab.evaluate(() => __updateTest.failSave());
    assert.equal(await tab.evaluate(() => refreshAppFiles()), false);
    assert.ok((await tab.evaluate(() => caches.keys())).includes('synapse-' + token), 'storage failure prevents cache deletion and reload');
    await tab.reload({ waitUntil: 'load' });
    await tab.waitForFunction(() => window.getActiveConv?.()?.id === 'release-chat');
    await tab.evaluate(async () => {
      closeModal('setupModal', false);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const image = { id: 'img_release', type: 'image', status: 'ready', dataUrl: canvas.toDataURL(), prompt: 'Preserve this image' };
      getActiveConv().messages.push({ role: 'assistant', content: '![Kept](attachment:img_release)', attachments: [image], swipeAttachments: [[image]], swipes: ['![Kept](attachment:img_release)'], swipeIndex: 0 });
      localStorage.setItem('llmApiKey', 'local-key-to-preserve');
      localStorage.setItem('llmImageApiKey', 'image-key-to-preserve');
      localStorage.setItem('assistantSyncGistToken', 'sync-token-to-preserve');
      localStorage.setItem('llmImageAutoApprove', 'true');
      await saveMemories([{ id: 'release-memory', content: 'Keep this memory', createdAt: 1 }]);
      await __updateTest.saveConversationImmediately();
      renderMessages();
    });
    await tab.locator('#chatInput').fill('An unsent draft survives refreshing app files');
    await tab.evaluate(() => {
      window.__refreshApprovals = [];
      window.confirm = text => { __refreshApprovals.push(text); return false; };
    });
    assert.equal(await tab.evaluate(() => refreshAppFiles()), false, 'declining refresh is a no-op');
    assert.equal(await tab.locator('#chatInput').inputValue(), 'An unsent draft survives refreshing app files');
    await tab.evaluate(() => createTemporaryConversation());
    assert.equal(await tab.evaluate(() => refreshAppFiles()), false);
    assert.match(await tab.evaluate(() => __refreshApprovals.at(-1)), /Temporary chats.*will be lost/s);
    await tab.evaluate(() => switchConversation('release-chat'));
    // An already-cached CDN/rendering asset is disposable, unlike saved data.
    await tab.evaluate(async token => {
      await (await caches.open('synapse-' + token)).put('./obsolete-file.js', new Response('obsolete'));
      window.confirm = text => { __refreshApprovals.push(text); return true; };
      history.replaceState(null, '', '?kept=1#kept-anchor');
      openSettings();
    }, token);
    await tab.locator('#settingsTabButton-data').click();
    await Promise.all([
      tab.waitForNavigation({ waitUntil: 'load' }),
      tab.locator('#refreshAppFilesBtn').click()
    ]);
    await tab.waitForFunction(() => window.getActiveConv?.()?.id === 'release-chat');
    assert.equal(await tab.locator('#chatInput').inputValue(), 'An unsent draft survives refreshing app files');
    const retained = await tab.evaluate(async token => ({
      text: getActiveConv().messages[0].content,
      image: getActiveConv().messages.at(-1).attachments[0].dataUrl,
      swipeImage: getActiveConv().messages.at(-1).swipeAttachments[0][0].dataUrl,
      theme: localStorage.getItem('assistantTheme'),
      key: localStorage.getItem('llmApiKey'), imageKey: localStorage.getItem('llmImageApiKey'),
      syncToken: localStorage.getItem('assistantSyncGistToken'), autoApprove: localStorage.getItem('llmImageAutoApprove'),
      memory: await loadMemories(), caches: await caches.keys(),
      obsolete: !!(await (await caches.open('synapse-' + token)).match('./obsolete-file.js')),
      refreshedQuery: new URL(location.href).searchParams.has('_synapse_refresh'),
      keptQuery: new URL(location.href).searchParams.get('kept'), hash: location.hash
    }), token);
    assert.equal(retained.text, 'Keep this through upgrade');
    assert.match(retained.image, /^data:image\/png;base64,/);
    assert.equal(retained.swipeImage, retained.image);
    assert.equal(retained.theme, 'light');
    assert.equal(retained.key, 'local-key-to-preserve');
    assert.equal(retained.imageKey, 'image-key-to-preserve');
    assert.equal(retained.syncToken, 'sync-token-to-preserve');
    assert.equal(retained.autoApprove, 'true');
    assert.ok(retained.memory.some(memory => memory.id === 'release-memory'));
    assert.ok(retained.caches.includes('other-app-cache'));
    assert.ok(retained.caches.includes('synapse-encrypted-downloads'));
    assert.equal(retained.obsolete, false);
    assert.equal(retained.refreshedQuery, false);
    assert.equal(retained.keptQuery, '1');
    assert.equal(retained.hash, '#kept-anchor');
    assert.equal(await tab.locator('.msg-wrapper:last-child img.chat-gen-img').count(), 1);
    await context.setOffline(true);
    await tab.reload({ waitUntil: 'load' });
    await tab.waitForFunction(() => window.getActiveConv?.()?.id === 'release-chat');
    assert.equal(await tab.locator('#chatInput').inputValue(), 'An unsent draft survives refreshing app files');
    assert.equal(await tab.locator('.msg-wrapper:last-child img.chat-gen-img').count(), 1);
    console.log('Release: offline reload, safe-refresh guards and failures, refreshed offline cache, saved chats/drafts/images/keys/memories and unrelated-cache preservation passed');
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
  }
};
