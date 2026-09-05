const assert = require('node:assert/strict');
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

module.exports = async function(page) {
  const root = path.resolve(__dirname, '..');
  const [shell, main, worker, standalone, version] = await Promise.all(
    ['index.html', 'js/main.js', 'sw.js', 'synapse.html', 'version.json'].map(file => readFile(path.join(root, file), 'utf8')));
  const token = worker.match(/const CACHE_VERSION = 'synapse-(\d+)'/)[1];
  const date = JSON.parse(version).buildDate;
  assert.equal(date.replace(/\D/g, '').slice(0, 12), token);
  for (const html of [shell, worker]) {
    assert.ok(html.includes('styles.css?v=' + token));
    assert.ok(html.includes('js/main.js?v=' + token));
  }
  for (const text of [main, standalone]) assert.ok(text.includes("buildDate: '" + date + "'"));
  assert.equal((standalone.match(/"cat_[a-z]+":"data:image\/webp;base64,/g) || []).length, 24);
  assert.ok(!standalone.includes('<script type="module" src="./js/main.js'));

  let previous = true;
  const oldToken = '199901010000';
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp' };
  const server = http.createServer(async (request, response) => {
    try {
      const name = new URL(request.url, 'http://localhost').pathname;
      const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + path.sep)) throw new Error('Not found');
      let body;
      if (previous && name === '/sw.js') body = worker.replaceAll(token, oldToken);
      else if (previous && (name === '/' || name === '/index.html')) body = '<!doctype html><script src="./js/main.js?v=' + oldToken + '"></script>';
      else if (previous && name === '/js/main.js') body = 'window.previousRelease = true;';
      else body = await readFile(file);
      response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  let context;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    context = await page.context().browser().newContext({ serviceWorkers: 'allow' });
    await context.route(/^https?:/, route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
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
    });
    await tab.waitForFunction(() => navigator.serviceWorker.controller);
    assert.ok((await tab.evaluate(() => caches.keys())).includes('synapse-' + oldToken));
    previous = false;
    await tab.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await tab.waitForFunction(async token => {
      const keys = await caches.keys();
      return keys.includes('synapse-' + token) && !keys.includes('synapse-199901010000');
    }, token);
    await tab.reload({ waitUntil: 'load' });
    await tab.waitForFunction(() => window.getActiveConv?.()?.id === 'release-chat');
    assert.equal(await tab.evaluate(() => getActiveConv().messages[0].content), 'Keep this through upgrade');
    assert.equal(await tab.evaluate(() => localStorage.getItem('assistantTheme')), 'light');
    assert.ok((await tab.evaluate(async token => (await (await caches.open('synapse-' + token)).match('./js/main.js?v=' + token)).text(), token)).includes(date));
    await tab.evaluate(async () => {
      await fetch('./version.json');
      await fetch(getEmotionSpriteAssetUrl('cat_happy'));
    });
    await context.setOffline(true);
    await tab.reload({ waitUntil: 'load' });
    await tab.waitForFunction(() => window.getActiveConv?.()?.id === 'release-chat');
    assert.equal(await tab.evaluate(() => synapseSelfTest().ok), true);
    assert.equal(await tab.evaluate(() => getActiveConv().messages[0].content), 'Keep this through upgrade');
    assert.equal(await tab.evaluate(async () => (await fetch(getEmotionSpriteAssetUrl('cat_happy'))).ok), true);
    assert.equal(await tab.evaluate(async () => (await (await fetch('./version.json')).json()).buildDate), date);
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
  }
};
