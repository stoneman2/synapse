const assert = require('node:assert/strict');

module.exports = async function(page) {
  const origin = new URL(page.url()).origin;
  const configure = (target, suffix) => target.evaluate(({ origin, suffix }) => {
    closeModal('setupModal');
    Object.entries({ llmProvider: 'openai', llmProxyUrl: origin + '/__privacy/' + suffix + '/v1',
      llmModel: 'privacy-fixture', llmApiFormat: 'openai', llmStreaming: 'false', llmMemoryEnabled: 'false',
      llmMaxTokens: '64', llmWebSearch: 'false', llmUrlFetch: 'false', llmExtraParams: '' })
      .forEach(([key, value]) => localStorage.setItem(key, value));
  }, { origin, suffix });
  await configure(page, 'a');
  await page.evaluate(() => setApiKey('disposable-tab-a-secret', 'session'));
  assert.equal(await page.evaluate(() => getApiKey()), 'disposable-tab-a-secret');
  const peer = await page.context().newPage();
  await peer.goto(page.url(), { waitUntil: 'networkidle' });
  await peer.waitForFunction(() => window.getActiveConv?.());
  await configure(peer, 'b');
  await peer.evaluate(() => setApiKey('disposable-tab-b-secret', 'remember'));
  assert.equal(await page.evaluate(() => getApiKey()), '', 'a tab key cannot be used with another tab\'s endpoint');
  assert.equal(await peer.evaluate(() => getApiKey()), 'disposable-tab-b-secret');
  const unauthorisedRequests = [];
  await page.route(origin + '/__privacy/b/**', route => {
    unauthorisedRequests.push(route.request().headers());
    return route.fulfill({ status: 500, body: 'Should never be sent' });
  });
  await page.locator('#chatInput').fill('Do not send with the wrong credential');
  await page.evaluate(() => sendMessage());
  assert.deepEqual(unauthorisedRequests, [], 'required-key requests fail before transmission');
  await configure(page, 'a');
  assert.equal(await page.evaluate(() => getApiKey()), 'disposable-tab-a-secret', 'the original tab credential remains recoverable');
  assert.equal(await peer.evaluate(() => getApiKey()), '', 'remembered keys also require their original destination');
  await peer.close();

  await page.evaluate(() => {
    sessionStorage.removeItem('llmApiKey');
    localStorage.setItem('llmApiKey', 'disposable-legacy-secret');
  });
  assert.equal(await page.evaluate(() => getApiKey()), '', 'legacy credentials are not silently rebound');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.getActiveConv?.());
  assert.equal(await page.locator('#setupKey').inputValue(), 'disposable-legacy-secret');
  assert.equal(await page.locator('#setupProxy').inputValue(), origin + '/__privacy/a/v1');
  assert.match(await page.locator('#setupError').textContent(), /confirm this older saved key/);
  await page.route(origin + '/__privacy/a/v1/models', route => route.fulfill({ json: { data: [] } }));
  await page.evaluate(() => saveSetup());
  assert.equal(await page.evaluate(() => getApiKey()), 'disposable-legacy-secret');

  await page.route(origin + '/__privacy/discovery/v1/models', route => route.fulfill({ json: { error: { message: 'Rejected unsaved-disposable-secret' } } }));
  await page.evaluate(origin => {
    openSettingsSection('api');
    document.getElementById('setProxy').value = origin + '/__privacy/discovery/v1';
    document.getElementById('setKey').value = 'unsaved-disposable-secret';
  }, origin);
  for (const action of ['testConnection', 'refreshModels']) {
    await page.evaluate(action => window[action]('settings'), action);
    assert.doesNotMatch(await page.locator('body').innerText(), /unsaved-disposable-secret/, action + ' redacts the unsaved form key');
  }
  await page.evaluate(() => { window.confirm = () => true; closeModal('settingsModal'); });

  const profiles = await page.evaluate(() => {
    const profile = { id: 'unsafe-profile', name: 'Fixture', settings: {
      llmProvider: 'openai', llmProxyUrl: localStorage.getItem('llmProxyUrl'), llmApiFormat: 'openai', llmModel: 'privacy-fixture',
      llmMaxTokens: '123', llmApiKey: 'legacy-profile-secret', assistantProjects: '[]', arbitrarySetting: 'unsafe',
      llmExtraParams: JSON.stringify({ max_tokens: 123, thinking: { budget_tokens: 100, api_key: 'nested-secret' },
        list: [{ Authorization: 'Bearer nested-secret', temperature: 0.2 }] })
    } };
    localStorage.setItem('assistantProfiles', JSON.stringify([profile]));
    localStorage.setItem('assistantProjects', 'existing-project-data');
    applyProfile(profile);
    setApiKey('disposable-current-secret', 'session');
    return { stored: JSON.parse(localStorage.getItem('assistantProfiles')), projects: localStorage.getItem('assistantProjects'),
      arbitrary: localStorage.getItem('arbitrarySetting'), maxTokens: localStorage.getItem('llmMaxTokens'),
      extra: JSON.parse(localStorage.getItem('llmExtraParams')) };
  });
  assert.equal(profiles.projects, 'existing-project-data');
  assert.equal(profiles.arbitrary, null);
  assert.equal(profiles.maxTokens, '123');
  assert.equal(profiles.extra.max_tokens, 123);
  assert.equal(profiles.extra.thinking.budget_tokens, 100);
  assert.equal(profiles.extra.list[0].temperature, 0.2);
  assert.doesNotMatch(JSON.stringify(profiles), /nested-secret|legacy-profile-secret/);
  assert.ok(!('assistantProjects' in profiles.stored[0].settings));
  await page.evaluate(() => { localStorage.removeItem('assistantProjects'); localStorage.setItem('llmExtraParams', ''); });

  let started;
  let release;
  let sentKey;
  const waiting = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  await page.route(origin + '/__privacy/a/v1/chat/completions', async route => {
    sentKey = route.request().headers().authorization;
    started();
    await response;
    await route.fulfill({ status: 401, json: { error: { message:
      'Echo disposable-current-secret; Authorization: Bearer unknown-bearer-secret; {"api_key":"unknown-json-secret"}' } } });
  });
  await page.evaluate(async () => {
    createConversation();
    localStorage.setItem('assistantDebug', 'true');
    localStorage.setItem('assistantDebugIncludeText', 'false');
    await readAttachmentFile(new File(['private-file-marker'], 'fixture.txt', { type: 'text/plain' }));
    const input = document.getElementById('chatInput');
    input.value = 'private-prompt-marker';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    window.__privacySend = sendMessage();
  });
  await waiting;
  assert.equal(sentKey, 'Bearer disposable-current-secret', 'headers contain the key, not the stored binding record');
  await configure(page, 'b');
  await page.evaluate(() => setApiKey('disposable-replacement-secret', 'session'));
  release();
  await page.evaluate(() => window.__privacySend);
  const failed = await page.evaluate(() => getActiveConv().messages.at(-1));
  assert.equal(failed.swipeRequests.at(-1).status, 'failed');
  assert.doesNotMatch(JSON.stringify(failed), /disposable-current-secret|unknown-bearer-secret|unknown-json-secret/);
  const snapshot = await page.evaluate(async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__privacySnapshot = text; } } });
    await copyDebugSnapshot();
    return window.__privacySnapshot;
  });
  assert.doesNotMatch(snapshot, /private-file-marker|private-prompt-marker|disposable-current-secret|unknown-bearer-secret|unknown-json-secret/);
  assert.match(snapshot, /redacted text/);
  const optedIn = await page.evaluate(async () => {
    localStorage.setItem('assistantDebugIncludeText', 'true');
    debugLogPayload('Explicit text opt-in', { messages: [{ role: 'user', content: 'opt-in-visible-marker' }] });
    await copyDebugSnapshot();
    return window.__privacySnapshot;
  });
  assert.match(optedIn, /opt-in-visible-marker/);

  const cleared = await page.evaluate(async () => {
    window.confirm = () => true;
    document.getElementById('syncPairingText').value = 'pairing-secret';
    document.getElementById('syncPairingCode').value = 'pairing-secret';
    const canvas = document.getElementById('syncPairingQr');
    canvas.getContext('2d').fillRect(0, 0, 10, 10);
    await clearDataCategory('credentials');
    return { key: getApiKey(), remembered: localStorage.getItem('llmApiKey'), tab: sessionStorage.getItem('llmApiKey'),
      text: document.getElementById('syncPairingText').value, code: document.getElementById('syncPairingCode').value,
      alpha: canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] };
  });
  assert.deepEqual(cleared, { key: '', remembered: null, tab: null, text: '', code: '', alpha: 0 });
};
