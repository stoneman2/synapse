const assert = require('node:assert/strict');
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png' };
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (request.method !== 'GET' || !file.startsWith(root + path.sep)) throw new Error('Not found');
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});

(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true });
    const args = process.argv.slice(2);
    const suites = args.filter(arg => arg !== '--standalone');
    for (const name of suites.length ? suites : ['privacy', 'persistence', 'requests', 'context', 'interface']) {
      assert.match(name, /^[a-z]+$/);
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
      await context.route(/^https?:/, route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + (args.includes('--standalone') ? '/synapse.html' : '/'), { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.getActiveConv?.());
      const selfTest = await page.evaluate(() => synapseSelfTest());
      assert.equal(selfTest.ok, true, JSON.stringify(selfTest));
      await require('./' + name + '.cjs')(page);
      assert.deepEqual(errors, [], name + ' has no uncaught page errors');
      console.log(name + ': passed');
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
