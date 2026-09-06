const assert = require('node:assert/strict');

module.exports = async function(page) {
  const origin = new URL(page.url()).origin;
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname));
  const base = origin + '/__requests';
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=';
  const requests = [];
  const plans = [];
  const modelPlans = new Map();
  const discoveries = [];
  const gates = [];
  const checks = [];
  let searchSnippet = 'A fixture search result.';
  let searchCount = 0;
  const onDialog = dialog => dialog.accept();
  page.on('dialog', onDialog);
  const json = data => ({ contentType: 'application/json', body: JSON.stringify(data) });
  const event = data => 'data: ' + (typeof data === 'string' ? data : JSON.stringify(data)) + '\n\n';
  const answer = (format, text) => format === 'anthropic'
    ? { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
    : { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
  const stream = (format, text, terminal = true) => format === 'anthropic'
    ? event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
      (terminal ? event({ type: 'content_block_stop', index: 0 }) + event({ type: 'message_stop' }) : '')
    : event({ choices: [{ delta: { content: text } }] }) + (terminal ? event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) : '');
  const deferred = () => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    const gate = { promise, release };
    gates.push(gate);
    return gate;
  };
  const handler = async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/models') || url.pathname.endsWith('/api/tags')) {
      discoveries.push({ path: url.pathname, headers: request.headers() });
      const planned = modelPlans.get(url.pathname)?.shift();
      if (planned?.gate) await planned.gate.promise;
      await route.fulfill(json(planned?.data || { data: [] }));
      return;
    }
    if (url.pathname === '/__requests/search') {
      searchCount++;
      await route.fulfill(json({ results: [{ title: 'Fixture source', url: 'https://example.test/source', content: searchSnippet }] }));
      return;
    }
    if (url.pathname === '/__requests/reader') {
      await route.fulfill({ status: 403, contentType: 'text/plain', body: 'Fixture blocked page' });
      return;
    }
    requests.push({ url: request.url(), body: request.postDataJSON(), headers: request.headers() });
    const planned = plans.shift();
    if (planned?.gate) await planned.gate.promise;
    await route.fulfill(planned?.response || { status: 500, ...json({ error: { message: 'Unexpected fixture request' } }) });
  };
  await page.route(base + '/**', handler);
  const configure = async (format = 'openai', suffix = 'a', options = {}) => page.evaluate(({ base, format, suffix, options }) => {
    window.closeModal('setupModal', false);
    window.closeModal('settingsModal', false);
    const settings = {
      llmProvider: 'custom', llmProxyUrl: base + '/' + suffix + '/v1', llmModel: 'fixture-model', llmApiFormat: format,
      llmStreaming: 'true', llmMaxTokens: '64', llmContextWindow: '', llmTemperature: '0.2', llmPrefill: '',
      llmThinking: 'false', llmThinkingEffort: '', llmExtraParams: '', llmExcludeParams: '', llmForceSearch: 'false',
      llmMemoryEnabled: 'false', llmWebSearch: 'false', llmUrlFetch: 'false', llmToolConfirm: 'false',
      llmSearchApiUrl: base + '/search', ...options
    };
    Object.entries(settings).forEach(([key, value]) => localStorage.setItem(key, value));
    window.createConversation();
    window.getActiveConv().toolPolicy = { webSearch: false, urlFetch: false, confirm: false };
    return window.getActiveConv().id;
  }, { base, format, suffix, options });
  const compose = text => page.locator('#chatInput').fill(text);
  const message = () => page.evaluate(() => window.getActiveConv().messages.at(-1));
  const send = async (format, text, response) => {
    plans.push({ response: response || json(answer(format, 'Fixture answer')) });
    await compose(text);
    return page.evaluate(() => window.sendMessage());
  };
  const start = async name => page.evaluate(name => {
    window.__requestsDone = false;
    window.__requestsTask = Promise.resolve(['suggestFollowUps', 'retryRequest'].includes(name)
      ? window[name](window.getActiveConv().messages.length - 1)
      : window[name]()).then(result => { window.__requestsDone = true; return result; });
  }, name);
  const finish = async () => {
    await page.waitForFunction(() => window.__requestsDone, null, { timeout: 5000 });
    return page.evaluate(() => window.__requestsTask);
  };
  const injectStream = async body => page.evaluate(({ base, body }) => {
    const original = window.fetch;
    let used = false;
    const state = window.__requestsStream = { cancelled: false, started: false };
    window.__restoreRequestsFetch = () => { window.fetch = original; };
    window.fetch = async (url, options) => {
      if (!used && String(url).startsWith(base) && options?.method === 'POST') {
        used = true;
        state.started = true;
        state.request = JSON.parse(options.body);
        const readable = new ReadableStream({
          start(controller) {
            state.close = () => controller.close();
            state.fail = () => controller.error(new TypeError('Fixture connection lost'));
            controller.enqueue(new TextEncoder().encode(body));
            options.signal?.addEventListener('abort', () => { if (!state.cancelled) controller.error(options.signal.reason); }, { once: true });
          },
          cancel() { state.cancelled = true; }
        });
        return new Response(readable, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return original(url, options);
    };
  }, { base, body });
  try {
    // Hold a real IndexedDB write transaction: the app's save must actually wait.
    const owner = await configure();
    const other = await page.evaluate(async owner => {
      window.createConversation();
      const other = window.getActiveConv().id;
      window.switchConversation(owner);
      await window.saveConversations();
      return other;
    }, owner);
    await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('assistantDB');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction(['conversations', 'meta'], 'readwrite');
        let released = false;
        window.__releaseRequestSave = () => { released = true; };
        transaction.oncomplete = () => db.close();
        const hold = () => {
          const read = transaction.objectStore('conversations').get('__fixture_lock__');
          read.onsuccess = () => { resolve(); if (!released) hold(); };
        };
        hold();
      };
    }));
    plans.push({ response: json(answer('openai', 'Bound to the original chat')) });
    await compose('Delayed save');
    await start('sendMessage');
    const before = requests.length;
    const guarded = await page.evaluate(({ owner, other, base }) => {
      window.switchConversation(other);
      window.duplicateConversation(owner);
      window.deleteConversation(owner);
      window.clearChat();
      localStorage.setItem('llmProxyUrl', base + '/b/v1');
      localStorage.setItem('llmModel', 'changed-model');
      localStorage.setItem('llmApiFormat', 'anthropic');
      window.renderConnectionPicker();
      window.renderMessages();
      return window.getActiveConv().id;
    }, { owner, other, base });
    assert.equal(guarded, owner);
    assert.equal(requests.length, before, 'No provider request before the save finishes');
    await page.evaluate(() => window.__releaseRequestSave());
    assert.equal(await finish(), 'complete');
    assert.equal(requests.at(-1).url, base + '/a/v1/chat/completions');
    assert.equal(requests.at(-1).body.model, 'fixture-model');
    assert.equal((await message()).content, 'Bound to the original chat');
    assert.equal((await message()).swipeRequests[0].connection.baseUrl, base + '/a/v1');
    checks.push('delayed save, transition guards and fixed submission target');

    for (const format of ['openai', 'anthropic']) {
      await configure(format);
      assert.equal(await send(format, 'Start', json(answer(format, 'Prefix'))), 'complete');
      plans.push({ response: json(answer(format, ' suffix')) });
      await page.evaluate(() => window.continueMessage());
      assert.deepEqual((await message()).swipes, ['Prefix', 'Prefix suffix'], format + ' JSON continuation');
      plans.push({ response: { contentType: 'text/event-stream', body: stream(format, ' streamed') } });
      await page.evaluate(() => window.continueMessage());
      assert.deepEqual((await message()).swipes, ['Prefix', 'Prefix suffix', 'Prefix suffix streamed']);
      checks.push(format + ' continuation, JSON and streaming');

      await configure(format);
      const partial = stream(format, 'Useful partial', false);
      await send(format, 'Fail after partial', { contentType: 'text/event-stream', body: partial + event({ type: 'error', error: { message: 'Fixture provider failure' } }) });
      assert.equal((await message()).content, 'Useful partial');
      assert.equal((await message()).swipeRequests[0].status, 'failed');
      assert.match((await message()).swipeRequests[0].error, /Fixture provider failure/);
      await configure(format);
      assert.equal(await send(format, 'Interrupted', { contentType: 'text/event-stream', body: partial }), 'interrupted');
      assert.equal((await message()).content, 'Useful partial');

      await configure(format);
      await injectStream(stream(format, 'Explicit completion'));
      await compose('Do not wait for the socket to close');
      await start('sendMessage');
      assert.equal(await finish(), 'complete');
      assert.equal(await page.evaluate(() => window.__requestsStream.cancelled), true);
      await page.evaluate(() => window.__restoreRequestsFetch());
      checks.push(format + ' partial errors, interrupted closure and terminal event cancellation');
    }

    await configure();
    await injectStream(stream('openai', 'Kept after Stop', false));
    await compose('Stop this response');
    await start('sendMessage');
    await page.waitForFunction(() => window.getActiveConv().messages.at(-1)?.content === 'Kept after Stop');
    await page.locator('#sendBtn').click();
    assert.equal(await finish(), 'stopped');
    assert.equal((await message()).content, 'Kept after Stop');
    await page.evaluate(() => window.__restoreRequestsFetch());
    await page.evaluate(base => {
      localStorage.setItem('llmProxyUrl', base + '/b/v1');
      localStorage.setItem('llmModel', 'different-model');
      window.setModelOverride('another-model');
    }, base);
    plans.push({ response: json(answer('openai', 'Retried on A')) });
    await page.evaluate(() => window.retryRequest(window.getActiveConv().messages.length - 1));
    assert.equal(requests.at(-1).url, base + '/a/v1/chat/completions');
    assert.equal(requests.at(-1).body.model, 'fixture-model');
    assert.deepEqual((await message()).swipes, ['Kept after Stop', 'Retried on A']);
    assert.ok(!JSON.stringify((await message()).swipeRequests).includes('apiKey'));
    checks.push('stop keeps partial text; retry keeps the old version and target');

    for (const enabled of [false, true]) {
      for (const text of ['{"name":"web_search","arguments":{"query":"example"}}', '```json\n{"name":"web_search","arguments":{"query":"example"}}\n```', '```xml\n<tool_call>{"name":"web_search","arguments":{"query":"example"}}</tool_call>\n```', ...(!enabled ? ['<tool_call>{"name":"web_search","arguments":{"query":"example"}}</tool_call>'] : [])]) {
        await configure();
        await page.evaluate(enabled => { window.getActiveConv().toolPolicy.webSearch = enabled; }, enabled);
        const count = requests.length;
        const searches = searchCount;
        await send('openai', 'Show an example', json(answer('openai', text)));
        assert.equal((await message()).content, text);
        assert.equal(requests.length, count + 1);
        assert.equal(searchCount, searches);
      }
    }
    checks.push('loose and fenced JSON never invokes tools; disabled text tools stay literal');

    await configure('openai', 'text-tools');
    await page.evaluate(() => { window.getActiveConv().toolPolicy.webSearch = true; });
    const textGate = deferred();
    const taggedCall = '<tool_call>{"name":"web_search","arguments":{"query":"explicit"}}</tool_call>';
    plans.push({ gate: textGate, response: json(answer('openai', taggedCall)) },
      { response: { contentType: 'text/event-stream', body: stream('openai', taggedCall) } },
      { response: json(answer('openai', 'Explicit tool answer')) });
    const beforeTextTools = requests.length;
    await compose('Use explicit tools');
    await start('sendMessage');
    await page.evaluate(base => {
      localStorage.setItem('llmProxyUrl', base + '/changed/v1');
      localStorage.setItem('llmModel', 'changed-model');
      localStorage.setItem('llmApiFormat', 'anthropic');
      localStorage.setItem('llmStreaming', 'false');
      localStorage.setItem('llmSearchApiUrl', base + '/changed-search');
    }, base);
    textGate.release();
    assert.equal(await finish(), 'complete');
    assert.equal(requests.length, beforeTextTools + 3);
    assert.ok(requests.slice(beforeTextTools).every(request => request.url === base + '/text-tools/v1/chat/completions' && request.body.model === 'fixture-model' && request.body.stream));
    assert.equal((await message()).content, 'Explicit tool answer');
    checks.push('explicit text tools support multiple rounds with fixed provider and search settings');

    for (const format of ['openai', 'anthropic']) {
      for (const transport of ['json', 'sse']) {
        await configure(format);
        await page.evaluate(() => { window.getActiveConv().toolPolicy = { webSearch: true, urlFetch: false, confirm: true }; });
        const rounds = [0, 1].map(index => format === 'anthropic' ? [
          { type: 'thinking', thinking: 'Thinking ' + index, signature: 'signed-' + index },
          { type: 'redacted_thinking', data: 'opaque-' + index },
          { type: 'text', text: 'Looking ' + index },
          { type: 'tool_use', id: 'call-' + index, name: 'web_search', input: { query: 'query-' + index } }
        ] : { role: 'assistant', content: 'Looking ' + index, extra_content: { signature: 'message-' + index }, tool_calls: [{ id: 'call-' + index, type: 'function', extra_content: { signature: 'tool-' + index }, function: { name: 'web_search', arguments: JSON.stringify({ query: 'query-' + index }) } }] });
        for (const round of rounds) {
          let response;
          if (transport === 'json') response = json(format === 'anthropic' ? { content: round, stop_reason: 'tool_use' } : { choices: [{ message: round, finish_reason: 'tool_calls' }] });
          else if (format === 'openai') response = { contentType: 'text/event-stream', body: event({ choices: [{ delta: round }] }) + event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) };
          else {
            const body = round.map((block, index) => {
              if (block.type === 'thinking') return event({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }) + event({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }) + event({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }) + event({ type: 'content_block_stop', index });
              if (block.type === 'tool_use') return event({ type: 'content_block_start', index, content_block: { ...block, input: {} } }) + event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }) + event({ type: 'content_block_stop', index });
              return event({ type: 'content_block_start', index, content_block: block }) + event({ type: 'content_block_stop', index });
            }).join('') + event({ type: 'message_stop' });
            response = { contentType: 'text/event-stream', body };
          }
          plans.push({ response });
        }
        plans.push({ response: json(answer(format, 'Final answer after two searches')) });
        const count = requests.length;
        await compose('Use tools twice');
        assert.equal(await page.evaluate(() => window.sendMessage()), 'complete');
        assert.equal(requests.length, count + 3, format + ' ' + transport + ' rounds');
        const exchanges = requests.at(-1).body.messages.filter(message => message.role === 'assistant');
        assert.equal(exchanges.length, 2);
        assert.deepEqual(format === 'anthropic' ? exchanges.map(message => message.content) : exchanges, rounds);
        assert.match((await message()).content, /Final answer after two searches$/);
        checks.push(format + ' ' + transport + ' multi-round tools and full exchange replay');
      }
    }

    for (const format of ['openai', 'anthropic']) {
      for (const failure of [
        { status: 503, ...json({ error: { message: 'Follow-up unavailable' } }) },
        json({ error: { message: 'Follow-up provider error' } }),
        json(answer(format, '')),
        { contentType: 'text/event-stream', body: stream(format, 'Useful suffix', false) + event({ error: { message: 'Follow-up stream error' } }) }
      ]) {
        await configure(format, 'follow-up-errors');
        await page.evaluate(() => { window.getActiveConv().toolPolicy = { webSearch: true, urlFetch: false, confirm: true }; });
        const first = format === 'anthropic'
          ? { content: [{ type: 'text', text: 'Useful preface' }, { type: 'tool_use', id: 'error-call', name: 'web_search', input: { query: 'fixture' } }], stop_reason: 'tool_use' }
          : { choices: [{ message: { content: 'Useful preface', tool_calls: [{ id: 'error-call', type: 'function', function: { name: 'web_search', arguments: '{"query":"fixture"}' } }] }, finish_reason: 'tool_calls' }] };
        const count = requests.length;
        plans.push({ response: json(first) }, { response: failure });
        await compose('Tool response must not hide errors');
        assert.equal(await page.evaluate(() => window.sendMessage()), 'failed');
        assert.equal(requests.length, count + 2, 'No hidden recovery request after a failed follow-up');
        assert.ok((await message()).content.startsWith('Useful preface'));
        assert.equal((await message()).swipeRequests[0].status, 'failed');
        if (failure.status) assert.equal((await message()).swipeRequests[0].httpStatus, failure.status);
        if (failure.contentType === 'text/event-stream') assert.match((await message()).content, /Useful suffix$/);
      }
    }
    checks.push('both providers propagate follow-up HTTP, JSON and stream errors; tool results alone are not answers');

    await configure('openai', 'bounded-tools');
    await page.evaluate(() => { window.getActiveConv().toolPolicy.webSearch = true; });
    const budgetStart = requests.length;
    for (let index = 0; index <= 20; index++) plans.push({ response: json({ choices: [{ message: {
      content: '', tool_calls: [{ id: 'budget-' + index, type: 'function', function: { name: 'web_search', arguments: '{"query":"budget"}' } }]
    }, finish_reason: 'tool_calls' }] }) });
    await compose('Bound the tool loop');
    assert.equal(await page.evaluate(() => window.sendMessage()), 'failed');
    assert.equal(requests.length, budgetStart + 21);
    assert.equal(requests.at(-1).body.tools, undefined);
    assert.match((await message()).swipeRequests[0].error, /round limit/);
    checks.push('tool budget stops at 20 tool rounds and one final-answer attempt');

    await configure();
    await send('openai', 'Initial response');
    const gate = deferred();
    plans.push({ gate, response: json(answer('openai', 'Regenerated')) }, { response: json(answer('openai', 'Queued answer')) });
    const count = requests.length;
    await start('regenerate');
    await page.waitForFunction(() => document.getElementById('sendBtn').classList.contains('streaming'));
    await compose('Queued after regeneration');
    await page.evaluate(() => window.queueFollowUpFromComposer());
    await page.evaluate(() => window.swipeMsg(1, -1));
    assert.equal((await message()).swipeIndex, 1, 'The streaming destination cannot be changed');
    await page.locator('.msg-wrapper.assistant').last().focus();
    await page.locator('.msg-wrapper.assistant').last().getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete this response version', exact: true }).click();
    assert.equal((await message()).swipes.length, 2, 'A running response version cannot be deleted');
    await page.locator('.msg-wrapper.assistant').last().focus();
    await page.locator('.msg-wrapper.assistant').last().getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete response', exact: true }).click();
    assert.equal((await message()).role, 'assistant', 'A running response cannot be deleted');
    assert.equal(await page.evaluate(() => {
      const bubble = document.querySelector('.msg-wrapper.assistant .msg-bubble');
      window.renderConnectionPicker();
      document.querySelector('#connectionPickerResults button').click();
      return bubble.isConnected;
    }), true, 'Changing the picker does not detach the streaming bubble');
    await page.evaluate(base => {
      localStorage.setItem('llmProxyUrl', base + '/after-queue/v1');
      localStorage.setItem('llmModel', 'after-queue-model');
    }, base);
    gate.release();
    await finish();
    await page.waitForFunction(() => window.getActiveConv().messages.at(-1)?.content === 'Queued answer' && document.getElementById('sendBtn').textContent !== 'Stop');
    assert.equal(requests.length, count + 2, 'The queue advances exactly once after regeneration');
    assert.equal(requests.at(-1).url, base + '/a/v1/chat/completions', 'An armed follow-up keeps the connection selected when queued');
    assert.equal(requests.at(-1).body.model, 'fixture-model');
    const failureGate = deferred();
    plans.push({ gate: failureGate, response: { contentType: 'text/event-stream', body: stream('openai', 'Partial regen', false) + event({ error: { message: 'Regeneration failed' } }) } });
    await start('regenerate');
    await page.waitForFunction(() => document.getElementById('sendBtn').classList.contains('streaming'));
    await compose('Keep this queued after failure');
    await page.evaluate(() => window.queueFollowUpFromComposer());
    failureGate.release();
    await finish();
    assert.equal(await page.locator('#followUpQueueResume').textContent(), 'Resume');
    assert.equal(await page.evaluate(() => window.getActiveConv().queuedFollowUps.length), 1);
    assert.equal((await message()).swipeRequests.at(-1).status, 'failed');
    checks.push('queue advances once after regeneration and pauses after failure');

    const retryGate = deferred();
    const beforeRetryQueue = requests.length;
    plans.push({ gate: retryGate, response: json(answer('openai', 'Retry recovered')) }, { response: json(answer('openai', 'Queued after retry')) });
    await start('retryRequest');
    await page.waitForFunction(() => document.getElementById('sendBtn').classList.contains('streaming'));
    await page.evaluate(() => window.toggleFollowUpQueue());
    retryGate.release();
    await finish();
    await page.waitForFunction(() => window.getActiveConv().messages.at(-1)?.content === 'Queued after retry' && document.getElementById('sendBtn').textContent !== 'Stop');
    assert.equal(requests.length, beforeRetryQueue + 2);
    const continueGate = deferred();
    const beforeContinueQueue = requests.length;
    plans.push({ gate: continueGate, response: json(answer('openai', ' continued')) }, { response: json(answer('openai', 'Queued after continuation')) });
    await start('continueMessage');
    await page.waitForFunction(() => document.getElementById('sendBtn').classList.contains('streaming'));
    await compose('Queue after Continue');
    await page.evaluate(() => window.queueFollowUpFromComposer());
    continueGate.release();
    await finish();
    await page.waitForFunction(() => window.getActiveConv().messages.at(-1)?.content === 'Queued after continuation' && document.getElementById('sendBtn').textContent !== 'Stop');
    assert.equal(requests.length, beforeContinueQueue + 2);
    checks.push('Retry and Continue use the same once-only queue completion path');

    await configure();
    await compose('Compare and queue');
    const compareGate = deferred();
    const beforeCompareQueue = requests.length;
    plans.push({ gate: compareGate, response: json({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: image } }] }, finish_reason: 'stop' }] }) },
      { gate: compareGate, response: json(answer('openai', 'Comparison B')) }, { response: json(answer('openai', 'Queued after comparison')) });
    await page.evaluate(() => window.openCompareModels());
    await page.locator('.comparison-target').nth(1).getByRole('combobox').selectOption('manual');
    await page.getByRole('textbox', { name: 'Model name for target B', exact: true }).fill('comparison-model');
    await page.locator('form.comparison-dialog').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.getElementById('sendBtn').classList.contains('streaming'));
    await compose('Queue after Compare');
    await page.evaluate(() => window.queueFollowUpFromComposer());
    compareGate.release();
    await page.waitForFunction(() => window.getActiveConv().messages.at(-1)?.content === 'Queued after comparison' && document.getElementById('sendBtn').textContent !== 'Stop');
    assert.equal(requests.length, beforeCompareQueue + 3);
    assert.deepEqual(await page.evaluate(() => window.getActiveConv().messages[1].swipeRequests.map(request => request.status)), ['complete', 'complete']);
    assert.deepEqual(await page.evaluate(() => window.getActiveConv().messages[1].swipeImages[0]), [image]);
    await page.locator('.comparison-results-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    checks.push('comparison image-only success and queue completion');

    await configure();
    await injectStream(stream('openai', 'Network partial', false));
    await compose('Keep the output if the reader fails');
    await start('sendMessage');
    await page.waitForFunction(() => window.getActiveConv().messages.at(-1)?.content === 'Network partial');
    await page.evaluate(() => window.__requestsStream.fail());
    assert.equal(await finish(), 'failed');
    assert.equal((await message()).content, 'Network partial');
    await page.evaluate(() => window.__restoreRequestsFetch());
    checks.push('network reader failure preserves partial text');

    for (const format of ['openai', 'anthropic']) {
      await configure(format);
      const content = [{ type: 'image_url', image_url: { url: image } }];
      const response = json(format === 'anthropic' ? { content, stop_reason: 'end_turn' } : { choices: [{ message: { content }, finish_reason: 'stop' }] });
      assert.equal(await send(format, 'Image only', response), 'complete');
      assert.deepEqual((await message()).images, [image]);
      assert.equal(await page.evaluate(async () => (await window.buildRequestMessages(window.getActiveConv())).included.length), 2);
      plans.push({ response: json(answer(format, 'Text replacement')) });
      await page.evaluate(() => window.regenerate());
      assert.deepEqual((await message()).images, []);
      await page.evaluate(() => window.swipeMsg(1, -1));
      assert.deepEqual((await message()).images, [image]);
    }
    checks.push('image-only completion and independent swipe image state');

    for (const name of ['completeDraft', 'suggestFollowUps', 'handleManualSearch', 'openSearchTest', 'openStatusPanel']) {
      await configure();
      const diagnostic = name === 'openSearchTest' || name === 'openStatusPanel';
      if (name === 'suggestFollowUps') await send('openai', 'A completed response');
      if (diagnostic) await page.evaluate(() => { window.getActiveConv().toolPolicy.webSearch = true; });
      if (name === 'handleManualSearch') {
        await page.evaluate(() => { window.getActiveConv().toolPolicy.webSearch = true; });
        await compose('/search cancellable');
      } else await compose('Unfinished draft');
      await page.evaluate(base => {
        const original = window.fetch;
        window.__restoreRequestsFetch = () => { window.fetch = original; };
        window.fetch = (url, options) => String(url).startsWith(base)
          ? new Promise((resolve, reject) => {
              window.__requestsWaiting = true;
              if (options.signal?.aborted) reject(options.signal.reason);
              else options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            })
          : original(url, options);
        window.__requestsWaiting = false;
      }, base);
      if (diagnostic) {
        await page.evaluate(name => window[name](), name);
        if (name === 'openSearchTest') await page.locator('#searchTestInput').fill('cancellable diagnostic');
        await page.locator(name === 'openSearchTest' ? '#searchTestRun' : '#statusTestBtn').click();
      } else await start(name === 'handleManualSearch' ? 'sendMessage' : name);
      await page.waitForFunction(() => window.__requestsWaiting);
      assert.equal(await page.locator('#sendBtn').textContent(), 'Stop');
      if (diagnostic) {
        const button = page.locator(name === 'openSearchTest' ? '#searchTestRun' : '#statusTestBtn');
        assert.equal(await button.textContent(), 'Stop');
        await button.click();
        await page.waitForFunction(() => document.getElementById('sendBtn').textContent !== 'Stop');
        await page.locator(name === 'openSearchTest' ? '#searchTestClose' : '#statusCloseBtn').click();
      } else {
        await page.locator('#sendBtn').click();
        await finish();
      }
      assert.notEqual(await page.locator('#sendBtn').textContent(), 'Stop');
      if (name !== 'handleManualSearch') assert.equal(await page.locator('#chatInput').inputValue(), 'Unfinished draft');
      await page.evaluate(() => window.__restoreRequestsFetch());
    }
    checks.push('complete draft, suggestions, manual search and diagnostics share Stop and clean up');

    await configure();
    modelPlans.set('/__requests/a/v1/models', [{ data: { data: [{ id: 'fixture-model', context_length: 400 }, { id: 'only-a' }] } }]);
    await page.evaluate(base => window.fetchAvailableModels(base + '/a/v1', '', 'custom', 'openai'), base);
    await page.evaluate(base => {
      document.getElementById('setProxy').value = base + '/b/v1';
      document.getElementById('setProvider').value = 'custom';
      document.getElementById('setApiFormat').value = 'anthropic';
      document.getElementById('setKey').value = '';
    }, base);
    modelPlans.set('/__requests/b/v1/models', [{ data: { data: [{ id: 'only-unsaved', context_length: 1 }] } }]);
    await page.evaluate(() => window.testConnection('settings'));
    await page.evaluate(() => window.renderConnectionPicker());
    assert.match(await page.locator('#connectionPickerResults').textContent(), /only-a/);
    assert.doesNotMatch(await page.locator('#connectionPickerResults').textContent(), /only-unsaved/);
    modelPlans.set('/__requests/edited/api/tags', [{ data: { models: [{ name: 'edited-provider-model' }] } }]);
    await page.evaluate(base => {
      document.getElementById('setProxy').value = base + '/edited/v1';
      document.getElementById('setProvider').value = 'ollama';
      document.getElementById('setApiFormat').value = 'anthropic';
      const button = Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('onclick')?.includes("refreshModels('settings'"));
      return window.refreshModels('settings', button);
    }, base);
    assert.equal(discoveries.at(-1).path, '/__requests/edited/api/tags');
    assert.equal(discoveries.at(-1).headers['anthropic-version'], '2023-06-01');
    assert.match(await page.locator('#setModelSelect').textContent(), /edited-provider-model/);
    const staleInputGate = deferred();
    modelPlans.set('/__requests/a/v1/models', [{ gate: staleInputGate, data: { data: [{ id: 'stale-input-a' }] } }]);
    await page.evaluate(base => {
      document.getElementById('setProxy').value = base + '/a/v1';
      document.getElementById('setProvider').value = 'custom';
      document.getElementById('setApiFormat').value = 'openai';
      window.__staleConnectionTest = window.testConnection('settings');
    }, base);
    modelPlans.set('/__requests/b/v1/models', [{ data: { data: [{ id: 'current-input-b' }] } }]);
    await page.evaluate(base => {
      document.getElementById('setProxy').value = base + '/b/v1';
      return window.testConnection('settings');
    }, base);
    staleInputGate.release();
    await page.evaluate(() => window.__staleConnectionTest);
    assert.match(await page.locator('#setModelSelect').textContent(), /current-input-b/);
    assert.doesNotMatch(await page.locator('#setModelSelect').textContent(), /stale-input-a/);
    const modelGate = deferred();
    modelPlans.set('/__requests/a/v1/models', [{ gate: modelGate, data: { data: [{ id: 'late-a' }] } }]);
    await page.evaluate(base => { window.__lateModels = window.fetchAvailableModels(base + '/a/v1', '', 'custom', 'openai'); }, base);
    await configure('openai', 'b');
    modelPlans.set('/__requests/b/v1/models', [{ data: { data: [{ id: 'fixture-model', context_length: 20000 }, { id: 'only-b' }] } }]);
    await page.evaluate(base => window.fetchAvailableModels(base + '/b/v1', '', 'custom', 'openai'), base);
    modelGate.release();
    await page.evaluate(() => window.__lateModels);
    await page.evaluate(() => window.renderConnectionPicker());
    assert.match(await page.locator('#connectionPickerResults').textContent(), /only-b/);
    assert.doesNotMatch(await page.locator('#connectionPickerResults').textContent(), /late-a/);
    await configure('openai', 'a');
    modelPlans.set('/__requests/a/v1/models', [{ data: { data: [{ id: 'fixture-model', context_length: 400 }] } }]);
    await page.evaluate(base => window.fetchAvailableModels(base + '/a/v1', '', 'custom', 'openai'), base);
    const beforeLimit = requests.length;
    const longPrompt = 'word '.repeat(500);
    await compose(longPrompt);
    assert.equal(await page.evaluate(() => window.sendMessage()), 'paused');
    assert.equal(requests.length, beforeLimit, 'Default Send respects discovered model context');
    assert.equal(await page.locator('#chatInput').inputValue(), longPrompt);
    await configure('openai', 'b');
    assert.equal(await send('openai', longPrompt), 'complete', 'The same model name uses B context metadata');
    checks.push('provider-scoped models and context; unsaved tests and late discovery stay isolated');

    await configure('openai', 'tools', { llmContextWindow: '1500' });
    await page.evaluate(() => { window.getActiveConv().toolPolicy.webSearch = true; });
    searchSnippet = 'large '.repeat(3000);
    const beforeToolLimit = requests.length;
    await send('openai', 'Search first', json({ choices: [{ message: { content: 'Useful before tools', tool_calls: [{ id: 'large-result', type: 'function', function: { name: 'web_search', arguments: '{"query":"large"}' } }] }, finish_reason: 'tool_calls' }] }));
    assert.equal(requests.length, beforeToolLimit + 1, 'Oversized tool results are checked before the next provider call');
    assert.equal((await message()).swipeRequests[0].status, 'failed');
    assert.equal((await message()).content, 'Useful before tools');
    checks.push('assembled tool context is checked before every provider call');

    const readerRequests = [];
    const readerHandler = async route => {
      readerRequests.push(route.request().url());
      await route.fulfill({ contentType: 'text/plain', body: 'A readable fixture article supplied entirely by the browser test.' });
    };
    await page.route('https://r.jina.ai/**', readerHandler);
    try {
      const fetched = await page.evaluate(async base => {
        localStorage.setItem('llmCorsProxy', base + '/reader?url=');
        return window.executeUrlFetch('https://reader-fixture.test/article');
      }, base);
      assert.equal(fetched.error, null);
      assert.deepEqual(readerRequests, ['https://r.jina.ai/https://reader-fixture.test/article']);
    } finally {
      await page.unroute('https://r.jina.ai/**', readerHandler);
    }
    checks.push('reader fallback keeps one valid URL scheme');

    await configure();
    await page.evaluate(() => window.createTemporaryConversation());
    await compose('temporary-only fixture draft');
    await page.evaluate(async () => window.importCharacterCard({ target: {
      value: '', files: [new File([JSON.stringify({ name: 'Fixture character', first_mes: 'Hello' })], 'fixture.json', { type: 'application/json' })]
    } }));
    assert.equal(await page.locator('#chatInput').inputValue(), '');
    assert.equal(await page.evaluate(() => window.getActiveConv().title), 'Fixture character');
    await page.evaluate(() => window.saveConversations());
    assert.ok(!JSON.stringify(await page.evaluate(() => window.idbGetAll('conversations'))).includes('temporary-only fixture draft'));
    await page.evaluate(() => window.deleteConversation(window.getActiveConv().id));
    await page.evaluate(() => window.createTemporaryConversation());
    await compose('temporary-only undo draft');
    await page.getByRole('button', { name: 'Undo', exact: true }).last().click();
    assert.equal(await page.locator('#chatInput').inputValue(), '');
    await page.evaluate(() => window.saveConversations());
    assert.ok(!JSON.stringify(await page.evaluate(() => window.idbGetAll('conversations'))).includes('temporary-only undo draft'));
    checks.push('character import and deletion Undo do not persist a temporary draft');
    assert.equal(await page.evaluate(() => {
      let stops = 0;
      window.SpeechRecognition = class {
        start() {}
        stop() { stops++; }
        abort() { stops++; }
      };
      window.toggleVoice();
      window.createConversation();
      window.toggleVoice();
      window.duplicateConversation();
      return stops;
    }), 2);
    checks.push('chat transitions stop existing dictation');
    assert.equal(plans.length, 0, 'All planned provider requests were consumed');
    return checks;
  } finally {
    gates.forEach(gate => gate.release());
    await page.evaluate(() => { window.__releaseRequestSave?.(); window.__restoreRequestsFetch?.(); }).catch(() => {});
    await page.unroute(base + '/**', handler);
    page.off('dialog', onDialog);
  }
};
