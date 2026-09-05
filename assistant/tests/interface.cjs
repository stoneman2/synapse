const assert = require('node:assert/strict');

module.exports = async function(page) {
  await page.waitForFunction(() => window.renderMarkdown && document.getElementById('settingsModal').dataset.a11yInit === '1');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });

  if (await page.locator('#setupModal').evaluate(el => el.classList.contains('open'))) {
    assert.equal(await page.locator('#setupProvider').isVisible(), true);
    assert.equal(await page.locator('#setupKey').isVisible(), true);
    assert.equal(await page.locator('#setupModelManual').isVisible(), true);
    assert.equal(await page.locator('#setupAdvanced').evaluate(el => el.open), false);
    await page.locator('#setupProvider').selectOption('custom');
    assert.equal(await page.locator('#setupProxy').isVisible(), true, 'Custom setup exposes its endpoint');
    await page.getByRole('button', { name: 'Continue disconnected', exact: true }).click();
  }

  const markdown = await page.evaluate(() => {
    const previousKatex = window.katex;
    const results = [];
    const imageAlt = '$x" onerror="window.badMath=1" data-x="$';
    const codeAlt = '`x" onerror="window.badCode=1"`';
    const source = `![${imageAlt}](https://example.test/image.png)\n![${codeAlt}](https://example.test/code.png)\n` +
      '![unsafe](javascript:bad)\n![svg](data:image/svg+xml;base64,PHN2Zy8+)\n' +
      '| Resource | Code | Math |\n| --- | --- | --- |\n' +
      '| [**Docs**](https://example.test/docs?q=1&x=2) | `a|b` | $x_y$ |\n' +
      '| <img src=x onerror=bad()> | <strong>safe</strong> | text |\n' +
      '[Math $x_y$](https://example.test/path?value=$q" z=$)\n' +
      '$$x" <img src=x onerror=bad()>$$\n' +
      '```html\n<cat_happy /> $x_y$\n```';
    try {
      for (const mode of ['missing', 'throwing', 'present']) {
        if (mode === 'missing') delete window.katex;
        else window.katex = {
          renderToString(math, options) {
            if (mode === 'throwing') throw new Error('Deliberate KaTeX failure');
            const span = document.createElement('span');
            span.className = 'katex';
            span.dataset.display = String(options.displayMode);
            span.textContent = math;
            return span.outerHTML;
          }
        };
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble assistant';
        bubble.innerHTML = renderMarkdown(source);
        document.getElementById('messagesArea').append(bubble);
        const link = bubble.querySelector('table a');
        link?.focus();
        results.push({
          mode,
          imageAlts: Array.from(bubble.querySelectorAll('img'), img => img.alt),
          unsafe: bubble.querySelectorAll('script, iframe, object, embed, style, svg, form').length,
          eventAttributes: Array.from(bubble.querySelectorAll('*')).flatMap(el => Array.from(el.attributes).filter(attr => /^on/i.test(attr.name)).map(attr => attr.name)),
          unsafeUrls: Array.from(bubble.querySelectorAll('[src], [href]')).filter(el => !/^https:\/\/example\.test\//.test(el.src || el.href)).length,
          tableHref: link?.href,
          tableLabel: link?.textContent,
          tableLinkFocused: document.activeElement === link,
          tableCode: bubble.querySelector('table code')?.textContent,
          tableMath: bubble.querySelector('tbody td:nth-child(3)')?.textContent,
          visibleHtml: bubble.querySelector('table')?.textContent.includes('<a href'),
          katexCount: bubble.querySelectorAll('.katex').length,
          literalCode: bubble.querySelector('pre code')?.textContent,
          nulCount: (bubble.innerHTML.match(/\x00/g) || []).length
        });
        bubble.remove();
      }
    } finally {
      if (previousKatex === undefined) delete window.katex;
      else window.katex = previousKatex;
    }
    return { results, imageAlt, codeAlt };
  });
  for (const result of markdown.results) {
    assert.deepEqual(result.imageAlts, [markdown.imageAlt, markdown.codeAlt], `${result.mode}: literal image alt`);
    assert.equal(result.unsafe, 0, `${result.mode}: unsafe elements`);
    assert.deepEqual(result.eventAttributes, [], `${result.mode}: event attributes`);
    assert.equal(result.unsafeUrls, 0, `${result.mode}: unsafe URLs`);
    assert.equal(result.tableHref, 'https://example.test/docs?q=1&x=2');
    assert.equal(result.tableLabel, 'Docs');
    assert.equal(result.tableLinkFocused, true, 'Rendered table links remain focusable');
    assert.equal(result.tableCode, 'a|b');
    assert.equal(result.tableMath, result.mode === 'present' ? 'x_y' : '$x_y$');
    assert.equal(result.visibleHtml, false);
    assert.equal(result.katexCount, result.mode === 'present' ? 3 : 0);
    assert.equal(result.literalCode, '<cat_happy /> $x_y$');
    assert.equal(result.nulCount, 0);
  }
  const cat = await page.evaluate(() => {
    const previous = ['llmEmotionSprites', 'llmEmotionSpriteSet'].map(key => [key, localStorage.getItem(key)]);
    localStorage.setItem('llmEmotionSprites', 'true');
    localStorage.setItem('llmEmotionSpriteSet', 'cat');
    const bubble = document.createElement('div');
    bubble.innerHTML = renderMarkdown('<cat_happy />\n`<cat_happy />`');
    postRenderProcessing(bubble);
    const result = { sprites: bubble.querySelectorAll('.emotion-sprite-wrap[data-emotion="cat_happy"]').length, code: bubble.querySelector('code')?.textContent };
    previous.forEach(([key, value]) => value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value));
    return result;
  });
  assert.deepEqual(cat, { sprites: 1, code: '<cat_happy />' });

  const composer = page.locator('#chatInput');
  const beforeIme = await page.evaluate(() => getActiveConv().messages.length);
  await page.evaluate(() => localStorage.setItem('llmModelList', JSON.stringify(['model-interface-test'])));
  for (const text of ['Confirm a word', '/context', '@model']) {
    await composer.fill(text);
    for (const flags of [{ isComposing: true }, { isComposing: true, ctrlKey: true }, { keyCode: 229 }, { keyCode: 229, metaKey: true }]) {
      const result = await composer.evaluate((input, flags) => {
        const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...flags });
        input.dispatchEvent(event);
        return { prevented: event.defaultPrevented, value: input.value, messages: getActiveConv().messages.length };
      }, flags);
      assert.deepEqual(result, { prevented: false, value: text, messages: beforeIme }, 'IME confirmation must not select a command, select a model or send');
    }
  }
  await composer.fill('');

  const focus = await page.evaluate(async () => {
    const { getFocusableElements, trapFocus } = await import(new URL('./js/lib/dom-utils.js', location.href));
    const fixture = document.createElement('div');
    fixture.id = 'interfaceFocus';
    fixture.tabIndex = -1;
    fixture.style.cssText = 'position:fixed;inset:20px;z-index:10000;background:var(--bg)';
    fixture.innerHTML = '<button id="ordinary">Ordinary</button><button tabindex="3" id="third">Third</button><button tabindex="1" id="first">First</button>' +
      '<button tabindex="-1" id="negative">Negative</button><button tabindex="-2" id="moreNegative">Negative</button><button hidden id="hidden">Hidden</button>' +
      '<div hidden><button id="hiddenParent">Hidden parent</button></div><div inert><button id="inert">Inert</button></div>' +
      '<div aria-hidden="true"><button id="ariaHidden">Hidden</button></div><button style="visibility:hidden" id="invisible">Invisible</button>' +
      '<details><summary id="closedSummary">Closed details</summary><button id="closedChild">Closed child</button></details>' +
      '<details open><summary id="openSummary">Open details</summary><button id="openChild">Open child</button></details>' +
      '<fieldset disabled><legend><button id="legend">Legend</button></legend><button id="disabledField">Disabled field</button></fieldset>' +
      '<input type="radio" name="focusRadio" id="unchecked"><input type="radio" name="focusRadio" id="checked" checked>' +
      '<div contenteditable="true" id="editor">Edit <span contenteditable="true" id="nestedEditor">Nested</span></div>' +
      '<button style="position:fixed" id="fixed">Fixed</button>';
    document.body.append(fixture);
    fixture.addEventListener('keydown', event => trapFocus(fixture, event));
    return getFocusableElements(fixture).map(el => el.id);
  });
  assert.deepEqual(focus, ['first', 'third', 'ordinary', 'closedSummary', 'openSummary', 'openChild', 'legend', 'checked', 'editor', 'fixed']);
  await page.locator('#interfaceFocus').focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'fixed');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'first');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'third', 'Positive tabindex follows native order');
  await page.locator('#interfaceFocus').evaluate(el => el.remove());

  await page.locator('#toolbarMoreBtn').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.locator('#settingsTabButton-api').focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'settingsSaveBtn', 'Reverse Tab stays inside Settings');
  await page.locator('#setModelManual').fill('unsaved-interface-model');
  assert.match(await page.locator('#settingsSaveStatus').innerText(), /Unsaved API/);
  await page.locator('#settingsTabButton-tools').click();
  await page.locator('#setSearchApiUrl').fill('https://example.invalid/interface-search');
  await page.locator('#settingsTabButton-prompts').click();
  await page.locator('#setPersona').fill('Interface autosave check');
  await page.evaluate(() => openSettingsSection('api'));
  assert.equal(await page.locator('#setModelManual').inputValue(), 'unsaved-interface-model', 'Opening another settings section does not reload drafts');
  for (const dismiss of ['escape', 'close', 'backdrop']) {
    const dialogPromise = page.waitForEvent('dialog');
    const dismissal = dismiss === 'escape' ? page.keyboard.press('Escape') : dismiss === 'close'
      ? page.locator('#settingsModal .settings-actions').getByRole('button', { name: 'Close', exact: true }).click()
      : page.locator('#settingsModal').click({ position: { x: 2, y: 2 } });
    const dialog = await dialogPromise;
    assert.match(dialog.message(), /Discard unsaved API and Tools/);
    await dialog.dismiss();
    await dismissal;
    assert.equal(await page.locator('#settingsModal').evaluate(el => el.classList.contains('open')), true);
    assert.equal(await page.locator('#setModelManual').inputValue(), 'unsaved-interface-model');
    assert.equal(await page.locator('#setSearchApiUrl').inputValue(), 'https://example.invalid/interface-search');
  }
  assert.equal(await page.evaluate(() => localStorage.getItem('llmPersona')), 'Interface autosave check');
  await page.locator('#settingsTabButton-tools').click();
  await page.locator('#settingsSaveBtn').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('llmSearchApiUrl')), 'https://example.invalid/interface-search');
  assert.match(await page.locator('#settingsSaveStatus').innerText(), /Unsaved API/);
  assert.doesNotMatch(await page.locator('#settingsSaveStatus').innerText(), /Unsaved API and Tools/);
  await page.locator('#settingsTabButton-api').click();
  await page.locator('#setProvider').selectOption('anthropic');
  await page.locator('#settingsConnectionOptions').evaluate(el => { el.open = true; });
  assert.equal(await page.locator('#anthropicOptions').isVisible(), true);
  await page.locator('#setProvider').selectOption('openai');
  assert.equal(await page.locator('#anthropicOptions').isVisible(), false);
  const discardPromise = page.waitForEvent('dialog');
  const discard = page.keyboard.press('Escape');
  await (await discardPromise).accept();
  await discard;
  assert.equal(await page.locator('#settingsModal').evaluate(el => el.classList.contains('open')), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'toolbarMoreBtn', 'Settings restores the durable menu trigger');
  await page.evaluate(() => openSettingsSection('api'));
  assert.notEqual(await page.locator('#setModelManual').inputValue(), 'unsaved-interface-model');
  assert.equal(await page.locator('#setSearchApiUrl').inputValue(), 'https://example.invalid/interface-search');
  assert.equal(await page.locator('#settingsTabButton-api').evaluate(el => el.classList.contains('unsaved')), false);
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    window.__interfaceSpeech = { speaks: 0, cancels: 0, aborts: 0, recognition: null, utterance: null };
    window.SpeechRecognition = class {
      constructor() { window.__interfaceSpeech.recognition = this; }
      start() {}
      abort() { window.__interfaceSpeech.aborts++; }
    };
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak(utterance) { window.__interfaceSpeech.speaks++; window.__interfaceSpeech.utterance = utterance; },
      cancel() { window.__interfaceSpeech.cancels++; }
    } });
    document.getElementById('voiceBtn').style.removeProperty('display');
  });
  await composer.fill('');
  assert.equal(await page.locator('#sendBtn').isDisabled(), true);
  await page.locator('#voiceBtn').click();
  assert.equal(await page.locator('#voiceBtn').getAttribute('aria-label'), 'Stop voice input');
  await page.evaluate(() => window.__interfaceSpeech.recognition.onresult({ results: [[{ transcript: 'Dictated draft' }]] }));
  assert.equal(await composer.inputValue(), 'Dictated draft');
  assert.equal(await page.locator('#sendBtn').isDisabled(), false, 'Dictation uses the shared composer input update');
  assert.equal(await page.evaluate(() => getActiveConv().draft?.text), 'Dictated draft');
  await page.locator('#voiceBtn').click();
  assert.equal(await page.locator('#voiceBtn').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.evaluate(() => window.__interfaceSpeech.recognition.onresult), null, 'Stopped dictation cannot write late results');
  await page.locator('#voiceBtn').click();
  await page.evaluate(() => window.__interfaceSpeech.recognition.onerror({ error: 'not-allowed' }));
  assert.equal(await page.locator('#voiceBtn').getAttribute('aria-label'), 'Voice input');

  await page.evaluate(() => {
    const content = '| ' + Array.from({ length: 15 }, (_, i) => 'Column' + i).join(' | ') + ' |\n| ' + Array(15).fill('---').join(' | ') + ' |\n| ' + Array(15).fill('WideTableContent').join(' | ') + ' |\n```text\nScroll and select this code.\n```';
    getActiveConv().messages.push({ role: 'assistant', content, swipes: [content], swipeIndex: 0 });
    renderMessages();
  });
  const lastMessage = page.locator('.msg-wrapper.assistant').last();
  await lastMessage.focus();
  await lastMessage.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Read aloud', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__interfaceSpeech.speaks), 1);
  await page.evaluate(() => renderMessages({ preserveScroll: true }));
  await lastMessage.focus();
  await lastMessage.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Stop reading aloud', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__interfaceSpeech.speaks), 1, 'Stop does not start another utterance after a redraw');
  assert.equal(await page.evaluate(() => window.__interfaceSpeech.cancels), 1);
  await lastMessage.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Read aloud', exact: true }).click();
  await lastMessage.getByRole('button', { name: 'More', exact: true }).click();
  await page.evaluate(() => window.__interfaceSpeech.utterance.onend());
  assert.equal(await page.getByRole('menuitem', { name: 'Read aloud', exact: true }).count(), 1, 'Speech completion updates an already-open menu');
  await page.keyboard.press('Escape');

  const touch = await lastMessage.evaluate(wrapper => {
    const table = wrapper.querySelector('table');
    const before = getActiveConv().messages.length;
    const fire = (type, x) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: 100 }] });
      table.dispatchEvent(event);
      return event.defaultPrevented;
    };
    fire('touchstart', 200);
    const prevented = fire('touchmove', 110);
    fire('touchend', 110);
    table.scrollLeft = 50;
    const selection = window.getSelection();
    selection.selectAllChildren(table.querySelector('td'));
    const selected = selection.toString();
    selection.removeAllRanges();
    return { prevented, before, after: getActiveConv().messages.length, scrollLeft: table.scrollLeft, selected, touchAction: getComputedStyle(document.getElementById('messagesArea')).touchAction };
  });
  assert.equal(touch.prevented, false);
  assert.equal(touch.after, touch.before, 'A left swipe must not regenerate');
  assert.ok(touch.scrollLeft > 0, 'Tables keep a native horizontal scroll area');
  assert.equal(touch.selected, 'WideTableContent');
  assert.equal(touch.touchAction, 'auto');

  const attachments = await page.evaluate(async () => {
    const delivered = [];
    const options = { onAttachment: attachment => delivered.push(attachment) };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>';
    const svgAccepted = await readAttachmentFile(new File([svg], 'small.svg', { type: 'image/svg+xml' }), options);
    const emptyAccepted = await readAttachmentFile(new File([], 'empty.svg', { type: 'image/svg+xml' }), options);
    const invalidAccepted = await readAttachmentFile(new File(['not an image'], 'broken.png', { type: 'image/png' }), options);
    const image = new Uint8Array(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII=').split('').map(c => c.charCodeAt(0)));
    const pngAccepted = await readAttachmentFile(new File([image], 'valid.png', { type: 'image/png' }), options);
    return { svg, svgAccepted, emptyAccepted, invalidAccepted, pngAccepted, delivered, errors: document.getElementById('toastContainer').textContent };
  });
  assert.equal(attachments.svgAccepted, true);
  assert.equal(attachments.emptyAccepted, false);
  assert.equal(attachments.invalidAccepted, false);
  assert.equal(attachments.pngAccepted, true);
  assert.equal(attachments.delivered.length, 2);
  assert.equal(attachments.delivered[0].type, 'file');
  assert.equal(attachments.delivered[0].textContent, attachments.svg);
  assert.match(attachments.delivered[1].dataUrl, /^data:image\/png;base64,.+/);
  assert.match(attachments.errors, /empty\.svg.*empty/);
  assert.match(attachments.errors, /broken\.png.*decoded/);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.toolbar-toggle').click();
  assert.equal(await page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement)), true, 'Opening the mobile sidebar moves focus inside');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.getElementById('sidebar').contains(document.activeElement)), true);
  await page.locator('#sidebarSearch').fill('no matching interface conversation');
  assert.equal(await page.locator('#conversationFilterEmpty').isVisible(), true);
  await page.locator('#conversationFilterEmpty').getByRole('button', { name: 'Clear filters' }).click();
  assert.equal(await page.locator('#sidebarSearch').inputValue(), '');
  assert.equal(await page.locator('#conversationFilterEmpty').count(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.matches('.toolbar-toggle')), true);
  await page.locator('#contextToggle').click();
  assert.equal(await page.evaluate(() => document.getElementById('contextPanel').contains(document.activeElement)), true);
  await page.evaluate(() => toggleContextPanel(true));
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.matches('#goalSection > summary')), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'contextToggle', 'Repeated open calls do not replace the return trigger with a drawer child');
  await page.locator('#composerMoreBtn').click();
  await page.getByRole('menuitem', { name: 'Conversation tools', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'composerMoreBtn', 'A drawer restores its durable menu trigger');

  await page.evaluate(() => {
    getActiveConv().messages.push({ role: 'user', content: 'Awaiting a reply' });
    renderMessages();
  });
  await composer.fill('');
  const sizes = [320, 375, 430, 768, 769, 900, 1101, 1280];
  const bounds = [];
  for (const width of sizes) {
    await page.setViewportSize({ width, height: 900 });
    if (width > 1100) await page.evaluate(() => { toggleSidebar(true, false); toggleContextPanel(true, false); });
    await page.evaluate(() => openGlobalSearch());
    const result = await page.locator('.char-info-popup').evaluate(popup => {
      const rect = popup.getBoundingClientRect();
      const input = document.getElementById('chatInput').getBoundingClientRect();
      const rowElement = document.querySelector('.input-row');
      const row = rowElement.getBoundingClientRect();
      return { viewport: innerWidth, left: rect.left, right: rect.right, inputLeft: input.left, inputRight: input.right, rowLeft: row.left, rowRight: row.right, rowOverflow: rowElement.scrollWidth - rowElement.clientWidth };
    });
    assert.ok(result.left >= 0 && result.right <= width, `${width}px: global search fits the viewport`);
    assert.ok(result.inputLeft >= result.rowLeft - 1 && result.inputRight <= result.rowRight + 1, `${width}px: composer fits its row`);
    assert.ok(result.rowOverflow <= 1, `${width}px: the longer Regenerate control stays inside the composer`);
    bounds.push(result);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; openGlobalSearch(); });
  const zoom = await page.locator('.char-info-popup').evaluate(popup => {
    const rect = popup.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: innerWidth };
  });
  assert.ok(zoom.left >= 0 && zoom.right <= zoom.width, '200% CSS zoom: global search fits');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.setViewportSize({ width: 640, height: 450 });
  await page.evaluate(() => openGlobalSearch());
  assert.equal(await page.locator('.char-info-popup').evaluate(el => el.getBoundingClientRect().right <= innerWidth), true, '200% desktop zoom equivalent: 1280px viewport reflows at 640 CSS pixels');
  await page.keyboard.press('Escape');

  const themes = await page.evaluate(() => {
    const sample = document.createElement('span');
    sample.style.setProperty('transition', 'none', 'important');
    document.body.append(sample);
    const rgb = colour => {
      sample.style.color = colour;
      return getComputedStyle(sample).color.match(/[\d.]+/g).map(Number);
    };
    const composite = (fg, bg) => fg.slice(0, 3).map((v, i) => v * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
    const luminance = colour => colour.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((total, v, i) => total + v * [.2126, .7152, .0722][i], 0);
    const contrast = (fg, bg) => {
      const a = luminance(composite(fg, bg)), b = luminance(bg);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    const results = [];
    for (const option of document.getElementById('setTheme').options) {
      if (['custom', 'system'].includes(option.value)) continue;
      applyTheme(option.value);
      const root = getComputedStyle(document.documentElement);
      const c = key => rgb(root.getPropertyValue('--' + key));
      const bg = c('bg');
      const surfaces = [bg, c('sidebar-bg'), composite(c('msg-assistant'), bg)];
      const ratios = {};
      for (const key of ['text-primary', 'text-secondary', 'accent', 'accent-hover', 'error-color', 'danger-color', 'success-color', 'warning-color']) {
        ratios[key] = Math.min(...surfaces.map(surface => contrast(c(key), surface)));
      }
      for (const [fg, background] of [['accent-text', 'accent'], ['accent-text', 'accent-hover'], ['msg-user-text', 'msg-user'], ['danger-text', 'danger-color'], ['danger-text', 'danger-hover'], ['success-text', 'success-color'], ['warning-text', 'warning-color']]) {
        ratios[fg + '/' + background] = contrast(c(fg), c(background));
      }
      results.push({ name: option.value, ratios });
    }
    applyTheme('dark');
    const forest = ['--bg', '--sidebar-bg', '--accent'].map(key => getComputedStyle(document.documentElement).getPropertyValue(key).trim());
    sample.remove();
    return { results, forest };
  });
  assert.equal(themes.results.length, 38);
  for (const theme of themes.results) {
    for (const [role, ratio] of Object.entries(theme.ratios)) assert.ok(ratio >= 4.5, `${theme.name} ${role}: ${ratio.toFixed(2)}:1 is below 4.5:1`);
  }
  assert.deepEqual(themes.forest, ['#0f1310', '#151a16', '#789a7f']);
  await page.setViewportSize({ width: 1280, height: 900 });
  console.log(`Interface: rendering (3 KaTeX states), cat tags, IME, focus, settings, fake voice APIs, touch handlers, attachments, ${bounds.length} widths, zoom and ${themes.results.length} theme palettes passed.`);
};
