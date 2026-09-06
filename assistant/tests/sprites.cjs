const assert = require('node:assert/strict');

module.exports = async function(page) {
  const emotions = ('neutral happy excited amused playful affectionate ' +
    'curious thoughtful focused confident proud relieved ' +
    'surprised confused uncertain sceptical embarrassed apologetic ' +
    'concerned sad crying frustrated angry sleepy').split(' ');
  await page.evaluate(() => closeModal('setupModal'));
  await page.evaluate(() => openSettingsSection('appearance'));
  assert.deepEqual(await page.locator('#setEmotionSpriteSet option').evaluateAll(options => options.map(option => option.value)),
    ['auto', 'claude', 'gpt', 'gemini', 'cat', 'butler', 'maid', 'plushie', 'zom']);
  await page.locator('#setEmotionSprites').check();

  for (const prefix of ['cat', 'butler', 'maid', 'plushie', 'zom']) {
    await page.locator('#setEmotionSpriteSet').selectOption(prefix);
    await page.waitForFunction(prefix => localStorage.getItem('llmEmotionSpriteSet') === prefix && areEmotionSpritesEnabled(), prefix);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.getActiveConv?.());
    assert.equal(await page.evaluate(() => getEmotionSpriteSet()), prefix, 'saved character survives reload');
    await page.evaluate(() => closeModal('setupModal'));
    const prompt = await page.evaluate(async () => JSON.stringify(await buildSystemMessages(getActiveConv())));
    for (const emotion of emotions) assert.ok(prompt.includes('<' + prefix + '_' + emotion + ' />'));
    assert.ok(!prompt.includes('<gpt_helpfulness />'));

    await page.evaluate(({ prefix, emotions }) => {
      createTemporaryConversation();
      const tag = '<' + prefix + '_happy />';
      const content = emotions.map(emotion => '<' + prefix + '_' + emotion + ' />').join('\n') +
        '\n`' + tag + '`\n```text\n' + tag + '\n```\n<gpt_helpfulness />';
      getActiveConv().messages.push({ role: 'assistant', content, swipes: [content], swipeIndex: 0 });
      renderMessages();
    }, { prefix, emotions });
    const images = await page.locator('#messagesArea img.emotion-sprite').evaluateAll(async images => {
      return Promise.all(images.map(async image => {
        image.loading = 'eager';
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        return {
          name: image.closest('[data-emotion]').dataset.emotion,
          width: image.naturalWidth, height: image.naturalHeight,
          displayed: [image.getBoundingClientRect().width, image.getBoundingClientRect().height],
          transparentCorner: ctx.getImageData(0, 0, 1, 1).data[3] === 0,
          embedded: image.src.startsWith('data:image/webp;base64,'), alt: image.alt
        };
      }));
    });
    assert.deepEqual(images.map(image => image.name), emotions.map(emotion => prefix + '_' + emotion));
    for (const image of images) {
      assert.equal(image.width, 256);
      assert.equal(image.height, 256);
      assert.deepEqual(image.displayed, [128, 128]);
      assert.equal(image.transparentCorner, true);
      assert.equal(image.embedded, page.url().includes('/synapse.html'));
      assert.equal(image.alt, image.name.replaceAll('_', ' '));
    }
    assert.equal(await page.locator('#messagesArea code .emotion-sprite').count(), 0);
    assert.ok((await page.locator('#messagesArea').innerText()).includes('<gpt_helpfulness />'));
    for (const [width, theme] of [[375, 'light'], [1440, 'dark']]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => applyTheme(theme), theme);
      assert.equal(await page.locator('#messagesArea img.emotion-sprite').evaluateAll(images => images.every(image => {
        const bounds = image.getBoundingClientRect();
        return bounds.width === 128 && bounds.height === 128 && bounds.left >= 0 && bounds.right <= innerWidth;
      })), true, 'sprites fit desktop and phone layouts');
    }
    await page.evaluate(() => openSettingsSection('appearance'));
    assert.equal(await page.locator('#setEmotionSpriteSet').inputValue(), prefix);
  }

  const originalSets = await page.evaluate(() => {
    return [['claude', 'happy'], ['gpt', 'helpfulness'], ['gemini', 'resonance']].map(([prefix, emotion]) => {
      localStorage.setItem('llmEmotionSpriteSet', prefix);
      const bubble = document.createElement('div');
      bubble.innerHTML = renderMarkdown('<' + prefix + '_' + emotion + ' />');
      postRenderProcessing(bubble);
      return bubble.querySelector('img.emotion-sprite')?.alt;
    });
  });
  assert.deepEqual(originalSets, ['claude happy', 'gpt helpfulness', 'gemini resonance']);
  assert.deepEqual(await page.evaluate(() => {
    localStorage.setItem('llmEmotionSpriteSet', 'auto');
    return ['claude-test', 'gemini-test', 'gpt-test'].map(model => {
      localStorage.setItem('llmModel', model);
      return getEmotionSpritePrefix();
    });
  }), ['claude', 'gemini', 'gpt']);
  const disabled = await page.evaluate(async () => {
    localStorage.setItem('llmEmotionSprites', 'false');
    localStorage.setItem('llmEmotionSpriteSet', 'plushie');
    const bubble = document.createElement('div');
    bubble.innerHTML = renderMarkdown('<plushie_happy />');
    postRenderProcessing(bubble);
    return { images: bubble.querySelectorAll('img').length, prompt: JSON.stringify(await buildSystemMessages(getActiveConv())) };
  });
  assert.equal(disabled.images, 0);
  assert.ok(!disabled.prompt.includes('<plushie_happy />'));
};
