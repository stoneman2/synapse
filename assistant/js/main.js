import { getFocusableElements, trapFocus } from './lib/dom-utils.js';
import { escapeHTML, getContrastText, isLightColor } from './lib/text-utils.js';
// ============================================
// State
// ============================================
let conversations = [];
const temporaryConversations = new WeakSet();
let projects = [];
let activeConvId = null;
// True when the page is showing someone else's shared conversation via ?share=.
// Load and save of local data are both suppressed in that mode — see saveConversations.
let readOnlyShare = false;
let messages = [];
let abortController = null;
let foregroundAction = null;
const requestTargets = new WeakMap();
let streaming = false;
let sending = false;
let userScrolledAway = false;
let _suppressScrollFlag = false;
let pendingAttachments = [];
let pendingAttachmentReads = 0;
let attachmentStatusMessage = '';
let voiceRec = null;
let spokenMessage = null;
let speechUtterance = null;
let modelOverride = null;
const armedFollowUpConversationIds = new Set();
let processingFollowUpConversationId = null;
let queueingFollowUp = false;
let contextSourceMessage = null;
let contextPanelFocusReturn = null;
let contextPanelConversationId = null;
const contextDrafts = new WeakMap();
const contextRevisions = new WeakMap();
const summaryJobs = new Set();
let memoryEpoch = 0;
let memoryEnabledState = parseEnabledSetting(localStorage.getItem('llmMemoryEnabled'));
window.addEventListener('storage', event => {
  if (event.key === null || event.key === SYNC_TOMBSTONES_KEY || (event.key === 'llmMemoryEnabled' && !parseEnabledSetting(event.newValue))) memoryEpoch++;
});
let mentionActive = false;
let mentionIdx = 0;
let activeTagFilter = null;
let conversationView = localStorage.getItem('assistantConversationView') || 'active';
let conversationSort = localStorage.getItem('assistantConversationSort') || 'updated';
let bulkMode = false;
const selectedConversationIds = new Set();
let pendingImport = null;
let pendingImportMeta = null;
let activeSettingsTab = 'api';
const dirtySettingsTabs = new Set();
let _promptSettingsAutosaveTimer = null;
let _appearanceSettingsAutosaveTimer = null;
let _promptSettingsAutosavePending = false;
let _appearanceSettingsAutosavePending = false;
let localDataOperationsInFlight = 0;
let commandActive = false;
let commandIdx = 0;
let tokenInfoRequestId = 0;
let lastSearchStatus = { ok: null, error: null, at: null, query: '' };
let openModalStack = [];
const modalFocusReturn = new WeakMap();
let transientDialogFocusReturn = null;
let transientDialogClose = null;
let toolbarMenuFocusReturn = null;
let actionMenuClose = null;
let globalSearchDismiss = null;
let debugLogBuffer = [];
let localUpdateState = { status: 'idle', message: 'Not checked', details: '' };

function beginLocalDataOperation() {
  if (_syncPullInFlight) {
    showToast('Wait for sync pull to finish.', 'info');
    return false;
  }
  localDataOperationsInFlight++;
  // Invalidate before an import/deletion can yield to storage.
  memoryEpoch++;
  return true;
}

function endLocalDataOperation() {
  localDataOperationsInFlight = Math.max(0, localDataOperationsInFlight - 1);
  if (localDataOperationsInFlight === 0 && !_syncPullInFlight &&
      localStorage.getItem(SYNC_AUTO_PUSH_KEY) === 'true' &&
      localStorage.getItem(SYNC_AUTO_PENDING_KEY) === 'true') syncScheduleAutoPush();
}

const TEMPORARY_CHAT_NOTICE = 'This chat stays in this tab. It does not use saved memories or project context. Messages are still sent to your selected provider.';

function isTemporaryConversation(conv) {
  return Boolean(conv && temporaryConversations.has(conv));
}

function getPersistentConversations() {
  return conversations.filter(conv => !isTemporaryConversation(conv));
}

function getPersistentActiveConvId() {
  const active = getActiveConv();
  if (active && !isTemporaryConversation(active)) return active.id;
  return getPersistentConversations()[0]?.id || '';
}

function replacePersistentConversations(next, preserveTemporary = true) {
  const temporary = preserveTemporary ? conversations.filter(isTemporaryConversation) : [];
  const temporaryIds = new Set(temporary.map(conv => conv.id));
  conversations = temporary.concat((next || []).filter(conv => !temporaryIds.has(conv.id)));
}

const APP_VERSION = {
  name: 'Synapse',
  buildDate: '2026-09-05T11:10:36+08:00',
  updateUrl: 'https://platberlitz.github.io/assistant/version.json'
};

const SYNC_GIST_API_URL = 'https://api.github.com/gists';
const SYNC_KDF_ITERATIONS = 120000;
const SYNC_AUTO_PUSH_KEY = 'assistantSyncAutoPush';
const SYNC_AUTO_PENDING_KEY = 'assistantSyncAutoPushPending';
const SYNC_TOMBSTONES_KEY = 'assistantSyncTombstones';
const SYNC_SETTINGS_STATE_KEY = 'assistantSyncSettingsState';
const SYNC_STATE_GIST_KEY = 'assistantSyncStateGistId';
const SYNC_AUTO_PUSH_DELAY = 1200;
const SYNC_SETTINGS_KEYS = [
  'llmStreaming', 'llmEnterSend', 'llmTemperature',
  'llmMaxTokens', 'llmPromptCache', 'llmThinking', 'llmThinkingEffort',
  'llmExtraParams', 'llmExcludeParams', 'llmPrefill', 'llmPersona',
  'llmEnableStMacros', 'llmRpUserName', 'llmInputCost', 'llmOutputCost',
  'llmWebSearch', 'llmForceSearch', 'llmMemoryEnabled', 'llmHoldScreenshot',
  'llmEmotionSprites', 'llmEmotionSpriteSet',
  'llmPromptEntries', 'assistantPresets', 'assistantProfiles', 'assistantTheme',
  'assistantStarterPrompts', 'assistantStarterPromptsHidden',
  'assistantCustomTheme', 'assistantFont', 'assistantMsgFontSize', 'assistantMsgMaxWidth',
  'llmContextWindow', 'llmUrlFetch', 'llmToolConfirm'
];
const SYNC_PROFILE_SECRET_KEYS = [
  'llmApiKey', 'llmSearchApiKey', 'assistantSyncGistToken', 'assistantSyncPassphrase'
];
const PROFILE_SECRET_KEY_RE = /(?:api[-_ ]?key|token|secret|passphrase|password|authorization|credential|cookie)/i;
const PROFILE_SETTING_KEYS = new Set([
  'llmProvider', 'llmProxyUrl', 'llmModel', 'llmApiFormat', 'llmStreaming', 'llmEnterSend',
  'llmTemperature', 'llmMaxTokens', 'llmContextWindow', 'llmPromptCache', 'llmThinking',
  'llmThinkingEffort', 'llmExtraParams', 'llmExcludeParams', 'llmPrefill', 'llmWebSearch',
  'llmForceSearch', 'llmUrlFetch', 'llmToolConfirm', 'llmSearchApiUrl', 'llmCorsProxy',
  'llmMemoryEnabled', 'llmHoldScreenshot', 'llmEmotionSprites', 'llmEmotionSpriteSet',
  'llmInputCost', 'llmOutputCost', 'llmEnableStMacros', 'llmRpUserName'
]);

function isCredentialSettingKey(key) {
  if (/^(?:llmMaxTokens|(?:max(?:_completion)?|min|budget|input|output)_tokens|(?:bos|eos|pad|stop|allowed)_token_ids?)$/i.test(key)) return false;
  return SYNC_PROFILE_SECRET_KEYS.includes(key) || PROFILE_SECRET_KEY_RE.test(String(key || ''));
}

function stripCredentialSettings(settings) {
  if (Array.isArray(settings)) return settings.map(stripCredentialSettings);
  if (!settings || typeof settings !== 'object') return settings;
  return Object.fromEntries(Object.entries(settings)
    .filter(([key]) => !isCredentialSettingKey(key))
    .map(([key, value]) => [key, stripCredentialSettings(value)]));
}

function sanitizeExtraParams(value) {
  if (!value) return '';
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? JSON.stringify(stripCredentialSettings(parsed)) : '';
  } catch { return ''; }
}

function sanitizeStoredUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    Array.from(url.searchParams.keys()).forEach(key => {
      if (/(?:^|[-_])key$|(?:api[-_ ]?key|token|secret|password|auth)/i.test(key)) url.searchParams.delete(key);
    });
    return url.toString();
  } catch (e) {
    return '';
  }
}

function safeHttpUrl(value) {
  return sanitizeStoredUrl(value);
}

function safeDataUrl(value, mediaOnly = false) {
  const text = String(value || '').trim();
  const pattern = mediaOnly
    ? /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,[A-Za-z0-9+/=\s]+$/i
    : /^data:(?:image\/[A-Za-z0-9.+-]+|application\/(?:pdf|json|octet-stream)|text\/[A-Za-z0-9.+-]+);base64,[A-Za-z0-9+/=\s]+$/i;
  return pattern.test(text) ? text : '';
}

function safeMediaUrl(value) {
  const text = String(value || '').trim();
  if (/^blob:/i.test(text)) return text;
  return safeHttpUrl(text) || safeDataUrl(text, true);
}

function safeFileUrl(value) {
  const text = String(value || '').trim();
  if (/^blob:/i.test(text)) return text;
  return safeDataUrl(text);
}

function sanitizeProfileSettings(settings) {
  const safe = Object.fromEntries(Object.entries(settings && typeof settings === 'object' ? settings : {})
    .filter(([key, value]) => PROFILE_SETTING_KEYS.has(key) && ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => [key, String(value)]));
  if ('llmExtraParams' in safe) safe.llmExtraParams = sanitizeExtraParams(safe.llmExtraParams);
  ['llmProxyUrl', 'llmSearchApiUrl', 'llmCorsProxy'].forEach(key => {
    if (safe[key] != null) safe[key] = sanitizeStoredUrl(safe[key]);
  });
  return safe;
}

function sanitizeProfileRecord(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const createdAt = Number(source.createdAt) || Date.now();
  return {
    id: String(source.id || ('profile_' + createdAt)),
    name: String(source.name || 'Unnamed profile').slice(0, 120),
    createdAt,
    updatedAt: Number(source.updatedAt) || createdAt,
    settings: sanitizeProfileSettings(source.settings)
  };
}

function normalizePromptEntries(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.filter(entry => entry && typeof entry === 'object').map((entry, index) => ({
    id: String(entry.id || ('pe_import_' + index)),
    name: String(entry.name || 'Untitled').slice(0, 120),
    content: String(entry.content || ''),
    enabled: entry.enabled !== false
  }));
}

function normalizePresetRecords(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.filter(preset => preset && typeof preset === 'object').map((preset, index) => {
    const normalized = {
      id: String(preset.id || ('preset_import_' + index)),
      name: String(preset.name || 'Untitled').slice(0, 120),
      persona: String(preset.persona || ''),
      temperature: String(preset.temperature ?? ''),
      extraParams: sanitizeExtraParams(preset.extraParams)
    };
    const promptEntries = normalizePromptEntries(preset.promptEntries);
    if (promptEntries) normalized.promptEntries = promptEntries;
    if (typeof preset.systemPrompt === 'string') normalized.systemPrompt = preset.systemPrompt;
    return normalized;
  });
}

function normalizeStructuredSettingValue(key, value) {
  if (value === null || value === undefined) return null;
  if (key === 'llmExtraParams') return sanitizeExtraParams(value);
  if (!['llmPromptEntries', 'assistantPresets', 'assistantProfiles', 'assistantCustomTheme'].includes(key)) return String(value);
  try {
    const parsed = JSON.parse(String(value));
    if (key === 'llmPromptEntries') {
      const entries = normalizePromptEntries(parsed);
      return entries ? JSON.stringify(entries) : undefined;
    }
    if (key === 'assistantPresets') {
      const presets = normalizePresetRecords(parsed);
      return presets ? JSON.stringify(presets) : undefined;
    }
    if (key === 'assistantProfiles') {
      return Array.isArray(parsed) ? JSON.stringify(parsed.map(sanitizeProfileRecord)) : undefined;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const required = ['bg', 'sidebar', 'cardBorder', 'textPrimary', 'textSecondary', 'accent', 'accentHover', 'msgUser', 'msgAssistant'];
    if (required.some(name => typeof parsed[name] !== 'string')) return undefined;
    const allowed = required.concat(['borderRadius', 'msgMaxWidth', 'msgPadding', 'msgFontSize', 'codeBg']);
    return JSON.stringify(Object.fromEntries(allowed.filter(name => typeof parsed[name] === 'string').map(name => [name, parsed[name]])));
  } catch (e) {
    return undefined;
  }
}

const PROVIDER_PRESETS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiFormat: 'openai', keyRequired: true },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', apiFormat: 'anthropic', keyRequired: true },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiFormat: 'openai', keyRequired: true },
  ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', apiFormat: 'openai', keyRequired: false },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiFormat: 'openai', keyRequired: false },
  custom: { label: 'Custom', baseUrl: '', apiFormat: 'auto', keyRequired: false }
};

const COMMAND_REGISTRY = [
  { name: 'search', aliases: ['web', 's'], usage: '/search <query>', description: 'Search the web directly', requiresQuery: true },
  { name: 'files', aliases: ['file', 'docs', 'doc'], usage: '/files <query>', description: 'Search attached text locally', requiresQuery: true },
  { name: 'goal', aliases: [], usage: '/goal <text>', description: 'Set this conversation goal', requiresQuery: true },
  { name: 'context', aliases: [], usage: '/context', description: 'Open the request context', requiresQuery: false },
  { name: 'summary', aliases: [], usage: '/summary', description: 'Open the conversation summary', requiresQuery: false },
  { name: 'tools', aliases: [], usage: '/tools', description: 'Open conversation tools', requiresQuery: false },
  { name: 'settings', aliases: [], usage: '/settings', description: 'Open settings', requiresQuery: false },
  { name: 'projects', aliases: [], usage: '/projects', description: 'Open projects', requiresQuery: false }
];

const SOURCE_CITATION_INSTRUCTION = 'When you use web sources, cite them inline as [1], [2], etc. using the numbered results supplied. Do not invent source numbers.';

const TAG_COLORS = [
  { name: 'Red', color: '#ef4444' },
  { name: 'Orange', color: '#f97316' },
  { name: 'Yellow', color: '#eab308' },
  { name: 'Green', color: '#22c55e' },
  { name: 'Blue', color: '#3b82f6' },
  { name: 'Purple', color: '#a855f7' },
  { name: 'Pink', color: '#ec4899' },
  { name: 'Teal', color: '#14b8a6' }
];

const EMOTION_SPRITE_ASSET_PATH = './assets/emotion-sprites/';
const EMOTION_SPRITE_ASSET_URLS = {};
const EMOTION_SPRITE_SETS = {
  claude: ['amused', 'concerned', 'curious', 'frustrated', 'happy', 'playful', 'sad', 'sheepish', 'skeptical', 'thoughtful', 'touched', 'uncertain', 'warm'],
  gpt: ['caution', 'coherence_seeking', 'confidence', 'confusion', 'curiosity', 'focus', 'frustration', 'helpfulness', 'novelty_detection', 'satisfaction', 'surprise', 'uncertainty', 'urgency'],
  gemini: ['caution', 'certainty', 'convergence', 'dissonance', 'equilibrium', 'generative_flow', 'inquisitiveness', 'perplexity', 'resolution', 'resonance', 'saturation', 'uncertainty', 'vigilance'],
  cat: [
    'neutral', 'happy', 'excited', 'amused', 'playful', 'affectionate',
    'curious', 'thoughtful', 'focused', 'confident', 'proud', 'relieved',
    'surprised', 'confused', 'uncertain', 'sceptical', 'embarrassed', 'apologetic',
    'concerned', 'sad', 'crying', 'frustrated', 'angry', 'sleepy'
  ]
};
const EMOTION_SPRITE_NAMES = Object.fromEntries(Object.entries(EMOTION_SPRITE_SETS).flatMap(([prefix, emotions]) => emotions.map(emotion => [prefix + '_' + emotion, prefix])));
const EMOTION_SPRITE_TAG_RE = new RegExp('<[\\s\\u200B\\u200C\\u200D\\uFEFF]*(' + Object.keys(EMOTION_SPRITE_NAMES).join('|') + ')[\\s\\u200B\\u200C\\u200D\\uFEFF]*(?:/[\\s\\u200B\\u200C\\u200D\\uFEFF]*)?>', 'g');

function areEmotionSpritesEnabled() {
  return localStorage.getItem('llmEmotionSprites') === 'true';
}

function getEmotionSpriteSet() {
  const selected = localStorage.getItem('llmEmotionSpriteSet') || 'auto';
  return Object.hasOwn(EMOTION_SPRITE_SETS, selected) ? selected : 'auto';
}

function getEmotionSpritePrefix() {
  const selected = getEmotionSpriteSet();
  if (selected !== 'auto') return selected;
  const model = localStorage.getItem('llmModel') || '';
  const modelText = model.toLowerCase();
  if (/claude|anthropic/.test(modelText)) return 'claude';
  if (/gemini|palm/.test(modelText)) return 'gemini';
  const provider = getLlmProviderInfo(model, detectApiFormat(model), localStorage.getItem('llmProxyUrl') || '');
  if (/claude|anthropic/.test(provider.name)) return 'claude';
  if (provider.name === 'Gemini') return 'gemini';
  return 'gpt';
}

function buildEmotionSpriteInstructions() {
  const prefix = getEmotionSpritePrefix();
  const tags = EMOTION_SPRITE_SETS[prefix].map(emotion => '<' + prefix + '_' + emotion + ' />').join(', ');
  return 'Optional emotion sprite tags are available for visual expression. Use them sparingly, at most one per response unless the emotional tone genuinely shifts. Allowed tags for this response: ' + tags + '. Do not use these tags in code, quoted examples, or serious high-stakes situations unless the tag communicates useful caution or uncertainty. No tag is required when none fits.';
}

function getEmotionSpriteAssetUrl(name) {
  return EMOTION_SPRITE_ASSET_URLS[name] || EMOTION_SPRITE_ASSET_PATH + name + '.webp';
}

function getFocusReturnTarget(fallback = null) {
  const active = document.activeElement;
  const menu = active?.closest('[role="menu"]');
  const trigger = menu?.id && document.querySelector('[aria-controls="' + CSS.escape(menu.id) + '"]');
  return trigger || (active instanceof HTMLElement && active !== document.body ? active : fallback);
}

function openModal(modalOrId, focusSelector) {
  const modal = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
  if (!modal) return;
  const dialog = modal.querySelector('.modal') || modal;
  const previous = openModalStack[openModalStack.length - 1];

  if (previous && previous !== modal) {
    previous.inert = true;
    previous.setAttribute('aria-hidden', 'true');
  }

  if (!modal.classList.contains('open')) {
    modalFocusReturn.set(modal, getFocusReturnTarget(document.getElementById('toolbarMoreBtn')));
    modal.classList.add('open');
  }
  modal.inert = false;
  modal.setAttribute('aria-hidden', 'false');

  if (!openModalStack.includes(modal)) openModalStack.push(modal);

  requestAnimationFrame(() => {
    if (!modal.classList.contains('open') || modal.inert) return;
    const focusable = getFocusableElements(dialog);
    const preferred = focusSelector && modal.querySelector(focusSelector);
    const focusTarget = focusable.includes(preferred) ? preferred : focusable[0] || dialog;
    focusTarget.focus();
  });
}

function closeModal(modalOrId, restoreFocus = true) {
  const modal = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
  if (!modal) return;
  if (modal.id === 'settingsModal' && _syncPullInFlight) {
    showToast('Wait for sync pull to finish.', 'info');
    return;
  }
  if (modal.id === 'projectsModal') void flushProjectAutosave();
  if (modal.id === 'settingsModal') {
    flushSettingsAutosaves();
    if (dirtySettingsTabs.size && !confirm('Discard unsaved ' + Array.from(dirtySettingsTabs, tab => tab === 'api' ? 'API' : 'Tools').join(' and ') + ' changes? Choose Cancel to keep editing, then use Save.')) return;
    dirtySettingsTabs.clear();
    updateSettingsFooter();
  }
  modal.classList.remove('open');
  modal.inert = true;
  modal.setAttribute('aria-hidden', 'true');
  openModalStack = openModalStack.filter(m => m !== modal);
  const previous = openModalStack[openModalStack.length - 1];
  if (previous) {
    previous.inert = false;
    previous.setAttribute('aria-hidden', 'false');
  }

  if (!restoreFocus) return;
  const prevFocus = modalFocusReturn.get(modal);
  if (prevFocus && getFocusableElements(document).includes(prevFocus)) {
    prevFocus.focus();
  }
}

function closeTopModal(restoreFocus = true) {
  const modal = openModalStack[openModalStack.length - 1];
  if (!modal) return false;
  closeModal(modal, restoreFocus);
  return true;
}

function openTransientDialog(overlay, popup, focusTarget = popup) {
  if (transientDialogClose) transientDialogClose();
  transientDialogFocusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const underlyingModal = openModalStack[openModalStack.length - 1] || null;
  if (underlyingModal) {
    underlyingModal.inert = true;
    underlyingModal.setAttribute('aria-hidden', 'true');
  }
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-modal', 'true');
  if (!popup.hasAttribute('tabindex')) popup.setAttribute('tabindex', '-1');
  const close = () => {
    overlay.remove();
    popup.remove();
    document.removeEventListener('keydown', onKey);
    const previous = transientDialogFocusReturn;
    transientDialogFocusReturn = null;
    if (transientDialogClose === close) transientDialogClose = null;
    if (underlyingModal && underlyingModal.classList.contains('open')) {
      underlyingModal.inert = false;
      underlyingModal.setAttribute('aria-hidden', 'false');
    }
    if (previous && document.contains(previous)) previous.focus();
  };
  const onKey = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    trapFocus(popup, event);
  };
  overlay.onclick = event => { if (event.target === overlay) close(); };
  document.body.append(overlay, popup);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => (focusTarget || popup).focus());
  transientDialogClose = close;
  return close;
}

function initModalAccessibility() {
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    const dialog = modal.querySelector('.modal') || modal;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1');
    const open = modal.classList.contains('open');
    modal.inert = !open;
    modal.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (modal.dataset.a11yInit === '1') return;

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);
    });
    modal.addEventListener('keydown', (e) => trapFocus(dialog, e));
    modal.dataset.a11yInit = '1';
  });
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const days = Math.floor(hr / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getScrollBehavior() {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

function announce(message) {
  const live = document.getElementById('liveStatus');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = String(message || ''); });
}

function sanitizeErrorDetail(error, secrets = []) {
  if (error == null || String(error?.message || error || '').trim() === '') return '';
  let text = String(error?.message || error);
  const known = [...secrets, getStoredApiCredential().value,
    ...['llmSearchApiKey', 'assistantSyncGistToken', 'assistantSyncPassphrase'].map(key => localStorage.getItem(key))];
  known.filter(value => typeof value === 'string' && value).forEach(value => {
    for (const encoded of [JSON.stringify(value).slice(1, -1), value]) text = text.split(encoded).join('[redacted]');
  });
  text = text.replace(/\\+(?=["'])/g, '');
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]+/ig, '$1 [redacted]');
  text = text.replace(/(["']?(?:authorization|x-api-key|api[-_ ]?key|(?:access|refresh)[-_]?token|token|secret|password|passphrase)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/ig, '$1[redacted]');
  text = text.replace(/https?:\/\/[^\s]+/ig, match => {
    try { const url = new URL(match); return url.origin + url.pathname; } catch { return '[url]'; }
  });
  return text.length > 240 ? text.slice(0, 237) + '...' : text;
}

function renderConnectionChip() {
  const providerEl = document.getElementById('connectionChipProvider');
  const modelEl = document.getElementById('connectionChipModel');
  const chip = document.getElementById('connectionChip');
  if (!providerEl || !modelEl) return;
  const model = localStorage.getItem('llmModel') || '';
  const format = localStorage.getItem('llmApiFormat') || detectApiFormat(model);
  const provider = getLlmProviderInfo(model, format, localStorage.getItem('llmProxyUrl') || '');
  const profile = getActiveProfileSummary();
  providerEl.textContent = model ? provider.name : 'Not connected';
  modelEl.textContent = model ? (formatModelForDisplay(model, 44) + (profile?.name ? ' · ' + profile.name : '')) : 'Set up a provider';
  if (chip) chip.setAttribute('aria-label', model ? 'API connection: ' + provider.name + ', ' + model + (profile?.name ? ', profile ' + profile.name : '') : 'Open API settings');
}

function renderConversationHeader() {
  const conv = getActiveConv();
  const title = conv?.title || 'Synapse';
  const toolbarTitle = document.getElementById('toolbarTitle');
  const contextTitle = document.getElementById('contextConversationTitle');
  if (toolbarTitle) {
    toolbarTitle.textContent = title;
    toolbarTitle.title = title;
  }
  if (contextTitle) contextTitle.textContent = title;
}

function modelCacheKey(baseUrl = localStorage.getItem('llmProxyUrl') || '', provider = localStorage.getItem('llmProvider') || '', apiFormat = localStorage.getItem('llmApiFormat') || 'auto') {
  const base = sanitizeStoredUrl(String(baseUrl).replace(/\/(?:chat\/completions|messages)\/?$/i, '')).replace(/\/+$/, '');
  return 'llmModelCache:' + JSON.stringify([base, provider || inferRequestProvider({ llmProxyUrl: base, llmApiFormat: apiFormat }), apiFormat]);
}

function readModelMetadata(key = modelCacheKey()) {
  try {
    return normalizeModelMetadata(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch (e) {
    return [];
  }
}

function readCachedModels() {
  return readModelMetadata().map(model => model.id);
}

function renderConnectionPicker(query = '') {
  const results = document.getElementById('connectionPickerResults');
  if (!results) return;
  const search = String(query || '').trim().toLowerCase();
  results.replaceChildren();
  const addSection = (label, items, choose) => {
    const filtered = items.filter(item => item.label.toLowerCase().includes(search));
    if (!filtered.length) return;
    const heading = document.createElement('div');
    heading.className = 'connection-picker-label';
    heading.textContent = label;
    results.appendChild(heading);
    filtered.forEach(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = item.label;
      if (item.detail) {
        const detail = document.createElement('small');
        detail.textContent = item.detail;
        button.appendChild(detail);
      }
      button.onclick = () => choose(item);
      results.appendChild(button);
    });
  };
  const profiles = loadProfiles().map(profile => {
    const summary = getConnectionSummary(profile.settings || {});
    return { label: profile.name || 'Unnamed profile', detail: summary.provider.name + ' · ' + summary.model, profile };
  });
  addSection('Profiles', profiles, item => {
    applyProfile(item.profile);
    closeConnectionPicker();
  });
  const current = localStorage.getItem('llmModel') || '';
  const models = [...new Set([current, ...readCachedModels()].filter(Boolean))].map(model => ({ label: model, model }));
  addSection('Current provider', models, item => {
    localStorage.setItem('llmModel', item.model);
    localStorage.removeItem('assistantActiveProfileId');
    syncScheduleAutoPush();
    renderConnectionChip();
    renderMessages({ preserveScroll: true });
    updateTokenInfo();
    closeConnectionPicker();
    announce('Model changed to ' + item.model + '.');
  });
  if (!results.children.length) {
    const empty = document.createElement('p');
    empty.className = 'connection-picker-empty';
    empty.textContent = 'No matching models or profiles.';
    results.appendChild(empty);
  }
}

function toggleConnectionPicker(event) {
  event?.stopPropagation();
  const picker = document.getElementById('connectionPicker');
  const chip = document.getElementById('connectionChip');
  if (!picker || !chip) return;
  const opening = picker.hidden;
  closeSidebarMenu(false);
  closeComposerMenu(false);
  picker.hidden = !opening;
  chip.setAttribute('aria-expanded', String(opening));
  if (opening) {
    const search = document.getElementById('connectionPickerSearch');
    search.value = '';
    renderConnectionPicker();
    clampPopupToViewport(picker);
    search.focus();
  }
}

function closeConnectionPicker(restoreFocus = false) {
  const picker = document.getElementById('connectionPicker');
  const chip = document.getElementById('connectionChip');
  if (!picker || picker.hidden) return;
  picker.hidden = true;
  chip?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) chip?.focus();
}

function getKeyStorageMode() {
  const saved = localStorage.getItem('llmKeyStorage');
  if (saved === 'session' || saved === 'remember') return saved;
  // Legacy llmApiKey was always localStorage, so keep it remembered.
  return localStorage.getItem('llmApiKey') ? 'remember' : (sessionStorage.getItem('llmApiKey') ? 'session' : 'remember');
}

function getStoredApiCredential() {
  const value = (sessionStorage.getItem('llmApiKey') || localStorage.getItem('llmApiKey') || '').trim();
  try {
    const saved = JSON.parse(value);
    if (saved && typeof saved.value === 'string' && typeof saved.destination === 'string') return saved;
  } catch {}
  // Legacy keys have no recorded destination. Keep them available for explicit confirmation, never transmission.
  return { value, destination: '' };
}

function getCredentialDestination(settings) {
  settings ||= Object.fromEntries(['llmProvider', 'llmProxyUrl', 'llmApiFormat', 'llmModel'].map(key => [key, localStorage.getItem(key) || '']));
  const provider = inferRequestProvider(settings);
  const base = sanitizeStoredUrl(String(settings.llmProxyUrl || '').trim().replace(/\/(?:chat\/completions|messages)\/?$/i, '')).replace(/\/+$/, '');
  return JSON.stringify([base, provider, resolveRequestApiFormat(settings, provider, settings.llmModel || '')]);
}

function getApiKey(settings) {
  const saved = getStoredApiCredential();
  return saved.destination === getCredentialDestination(settings) ? saved.value : '';
}

function getApiKeyForForm() {
  const saved = getStoredApiCredential();
  return saved.destination ? getApiKey() : saved.value;
}

function setApiKey(key, mode = getKeyStorageMode()) {
  const value = String(key || '').trim();
  const store = mode === 'session' ? sessionStorage : localStorage;
  if (value) store.setItem('llmApiKey', JSON.stringify({ value, destination: getCredentialDestination() }));
  else store.removeItem('llmApiKey');
  (mode === 'session' ? localStorage : sessionStorage).removeItem('llmApiKey');
  localStorage.setItem('llmKeyStorage', mode === 'session' ? 'session' : 'remember');
  scrubProfileSecrets();
}

function scrubProfileSecrets() {
  const profiles = loadProfiles();
  const raw = localStorage.getItem('assistantProfiles');
  if (raw !== null && raw !== JSON.stringify(profiles)) saveProfiles(profiles);
}

function getSelectedKeyStorage(target) {
  const name = target === 'setup' ? 'setupKeyStorage' : 'settingsKeyStorage';
  return document.querySelector('input[name="' + name + '"]:checked')?.value || getKeyStorageMode();
}

function setKeyStorageInputs(mode) {
  document.querySelectorAll('input[name="setupKeyStorage"], input[name="settingsKeyStorage"]').forEach(input => {
    input.checked = input.value === mode;
  });
}

function getProviderPreset(name) {
  return PROVIDER_PRESETS[name] || PROVIDER_PRESETS.custom;
}

function inferProviderKey(settings = {}) {
  const explicit = settings.llmProvider || localStorage.getItem('llmProvider') || '';
  if (explicit && PROVIDER_PRESETS[explicit]) return explicit;
  const base = String(settings.llmProxyUrl || localStorage.getItem('llmProxyUrl') || '').toLowerCase();
  const format = settings.llmApiFormat || localStorage.getItem('llmApiFormat') || 'auto';
  if (base.includes('openrouter')) return 'openrouter';
  if (base.includes('anthropic') || format === 'anthropic') return 'anthropic';
  if (base.includes('11434') || base.includes('ollama')) return 'ollama';
  if (base.includes('1234') || base.includes('lmstudio')) return 'lmstudio';
  if (base.includes('openai.com')) return 'openai';
  return 'custom';
}

function providerRequiresKey(settings = {}) {
  return getProviderPreset(inferProviderKey(settings)).keyRequired;
}

function normalizeQueuedFollowUps(raw) {
  const used = new Set();
  return (Array.isArray(raw) ? raw : []).filter(item => item && typeof item === 'object').slice(0, 20).map((item, index) => {
    let id = String(item.id || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id) || used.has(id)) {
      id = 'followup_' + (Number(item.createdAt) || Date.now()) + '_' + index;
    }
    used.add(id);
    return {
      id,
      text: String(item.text || '').slice(0, 200000),
      attachments: cloneDraftAttachments(item.attachments),
      modelOverride: String(item.modelOverride || '').slice(0, 300) || null,
      createdAt: Number(item.createdAt) || Date.now()
    };
  }).filter(item => item.text.trim() || item.attachments.length);
}

function normalizeConversationRecord(raw) {
  const conv = raw && typeof raw === 'object' ? raw : {};
  const normalized = { ...conv };
  const text = value => ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : '';
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const number = value => ['number', 'string'].includes(typeof value) && Number.isFinite(Number(value)) ? Number(value) : 0;
  const sources = value => (Array.isArray(value) ? value : []).filter(object).map(source => ({
    ...source, title: text(source.title), snippet: text(source.snippet), url: safeHttpUrl(text(source.url)),
    number: number(source.number), sourceNumber: number(source.sourceNumber)
  })).filter(source => source.url || source.title);
  delete normalized.temporary;
  delete normalized.isTemporary;
  normalized.id = text(normalized.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized.id)) normalized.id = genId();
  normalized.title = text(normalized.title) || 'New Chat';
  normalized.createdAt = number(normalized.createdAt) > 0 ? number(normalized.createdAt) : Date.now();
  normalized.updatedAt = number(normalized.updatedAt) > 0 ? number(normalized.updatedAt) : normalized.createdAt;
  normalized.messages = (Array.isArray(normalized.messages) ? normalized.messages : [])
    .filter(message => message && (message.role === 'user' || message.role === 'assistant' || message.role === 'system'))
    .map(source => {
      const message = { ...source };
      if (Array.isArray(message.content)) {
        message.content = message.content.map(part => {
          if (!part || typeof part !== 'object') return null;
          if (part.type === 'text') return { type: 'text', text: text(part.text) };
          if (part.type === 'image_url') {
            const url = safeMediaUrl(text(part.image_url?.url));
            return url ? { type: 'image_url', image_url: { ...(part.image_url || {}), url } } : null;
          }
          if (part.type === 'file') {
            const file = part.file && typeof part.file === 'object' ? part.file : {};
            const url = file.url ? safeFileUrl(text(file.url)) : '';
            if (!url && typeof file.textContent !== 'string') return null;
            return { type: 'file', file: {
              ...file,
              name: text(file.name) || 'file',
              mime: text(file.mime),
              url,
              textContent: typeof file.textContent === 'string' ? file.textContent : ''
            } };
          }
          return null;
        }).filter(Boolean);
      } else if (typeof message.content !== 'string') {
        message.content = object(message.content) ? JSON.stringify(message.content) : text(message.content);
      }
      ['images', 'swipeImages', 'swipeThinking', 'swipeSources', 'swipeToolUse', 'swipeRequests', 'swipeLlms', 'swipeTokenEstimates'].forEach(key => {
        if (key in message && !Array.isArray(message[key])) message[key] = [];
      });
      if (message.images) message.images = message.images.map(value => safeMediaUrl(text(value))).filter(Boolean);
      if (message.swipeImages) message.swipeImages = message.swipeImages.map(images => (Array.isArray(images) ? images.map(value => safeMediaUrl(text(value))).filter(Boolean) : []));
      if (message.swipeThinking) message.swipeThinking = message.swipeThinking.map(text);
      if (message.swipeSources) message.swipeSources = message.swipeSources.map(sources);
      if (message.swipeToolUse) message.swipeToolUse = message.swipeToolUse.map(blocks => (Array.isArray(blocks) ? blocks : []).filter(object).map(block => ({
        ...block, type: text(block.type), query: text(block.query), content: text(block.content),
        error: text(block.error), url: safeHttpUrl(text(block.url)), results: sources(block.results)
      })));
      if (message.swipeRequests) message.swipeRequests = message.swipeRequests.map(request => {
        if (!object(request)) return null;
        const safe = { ...request };
        ['status', 'requestId', 'model', 'apiFormat', 'error'].forEach(key => { if (key in safe) safe[key] = text(safe[key]); });
        ['startedAt', 'completedAt', 'durationMs', 'httpStatus', 'messageCount', 'promptTokens', 'contextWindow'].forEach(key => {
          if (key in safe) safe[key] = safe[key] != null && ['number', 'string'].includes(typeof safe[key]) ? number(safe[key]) : null;
        });
        return safe;
      });
      const llm = value => object(value) ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, text(value)])) : null;
      if (message.swipeLlms) message.swipeLlms = message.swipeLlms.map(llm);
      if ('llm' in message) message.llm = llm(message.llm);
      ['model', 'apiFormat'].forEach(key => { if (key in message) message[key] = text(message[key]); });
      if ('timestamp' in message) message.timestamp = number(message.timestamp);
      if (message.role === 'assistant') {
        if (message.comparison !== true) delete message.comparison;
        message.swipes = Array.isArray(message.swipes) ? message.swipes.map(value => object(value) ? JSON.stringify(value) : text(value)) : [];
        const content = Array.isArray(message.content)
          ? message.content.filter(part => part.type === 'text').map(part => part.text).join('')
          : message.content;
        if (message.swipes.length === 0 || (content && message.swipes.every(value => !value))) {
          message.swipes = [String(content || '')];
        }
        if (!Number.isInteger(message.swipeIndex)) message.swipeIndex = 0;
        message.swipeIndex = Math.max(0, Math.min(message.swipes.length - 1, message.swipeIndex));
        message.content = message.swipes[message.swipeIndex];
      } else delete message.comparison;
      if (message.includeInContext !== false) message.includeInContext = true;
      return message;
    });
  if (normalized.characterAvatar) normalized.characterAvatar = safeMediaUrl(text(normalized.characterAvatar));
  if (object(normalized.characterCard)) {
    normalized.characterCard = { ...normalized.characterCard };
    ['name', 'description', 'personality', 'scenario', 'first_mes', 'system_prompt', 'mes_example', 'creator_notes'].forEach(key => {
      if (key in normalized.characterCard) normalized.characterCard[key] = text(normalized.characterCard[key]);
    });
  } else delete normalized.characterCard;
  ['sortOrder', 'archivedAt', 'summaryUpdatedAt'].forEach(key => {
    if (key in normalized) normalized[key] = normalized[key] == null ? null : number(normalized[key]);
  });
  ['summary', 'persona', 'characterDescription', 'characterSystemPrompt'].forEach(key => {
    if (key in normalized) normalized[key] = text(normalized[key]);
  });
  if ('docs' in normalized) normalized.docs = (Array.isArray(normalized.docs) ? normalized.docs : []).filter(object).map(doc => ({ ...doc, name: text(doc.name), text: text(doc.text) }));
  if (!TAG_COLORS.some(tag => tag.name === normalized.tag)) delete normalized.tag;
  if (!normalized.toolPolicy || typeof normalized.toolPolicy !== 'object') normalized.toolPolicy = null;
  normalized.goal = text(normalized.goal).slice(0, 4000);
  normalized.parentConversationId = text(normalized.parentConversationId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized.parentConversationId) || normalized.parentConversationId === normalized.id) delete normalized.parentConversationId;
  if (!Number.isInteger(normalized.forkMessageIndex) || normalized.forkMessageIndex < 0) delete normalized.forkMessageIndex;
  normalized.forkedAt = number(normalized.forkedAt);
  if (!Number.isFinite(normalized.forkedAt) || normalized.forkedAt <= 0) delete normalized.forkedAt;
  normalized.queuedFollowUps = normalizeQueuedFollowUps((Array.isArray(normalized.queuedFollowUps) ? normalized.queuedFollowUps : []).filter(object).map(item => ({
    ...item, id: text(item.id), text: text(item.text), modelOverride: text(item.modelOverride), createdAt: number(item.createdAt)
  })));
  const draft = object(normalized.draft) ? normalized.draft : {};
  normalized.draft = { ...draft, text: text(draft.text), attachments: cloneDraftAttachments(draft.attachments) };
  if ('updatedAt' in draft) normalized.draft.updatedAt = number(draft.updatedAt);
  if (normalized.syncVersion) normalized.syncVersion = normalizeConversationVersion(normalized.syncVersion);
  if (normalized.conflictOf && (typeof normalized.conflictOf !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized.conflictOf))) delete normalized.conflictOf;
  if ('conflictTitle' in normalized) normalized.conflictTitle = text(normalized.conflictTitle);
  return normalized;
}

function normalizeToolPolicy(policy) {
  const source = policy && typeof policy === 'object' ? policy : {};
  const fallback = getGlobalToolPolicy();
  return {
    webSearch: Object.prototype.hasOwnProperty.call(source, 'webSearch') ? source.webSearch !== false : fallback.webSearch,
    urlFetch: Object.prototype.hasOwnProperty.call(source, 'urlFetch') ? source.urlFetch !== false : fallback.urlFetch,
    confirm: Object.prototype.hasOwnProperty.call(source, 'confirm') ? source.confirm === true : fallback.confirm
  };
}

function getGlobalToolPolicy() {
  return {
    webSearch: localStorage.getItem('llmWebSearch') === 'true',
    urlFetch: localStorage.getItem('llmUrlFetch') === 'true',
    confirm: localStorage.getItem('llmToolConfirm') !== 'false'
  };
}

function getToolPolicy(conv = getActiveConv()) {
  if (conv && conv.toolPolicy) return normalizeToolPolicy(conv.toolPolicy);
  return getGlobalToolPolicy();
}

function canUseTool(toolName, conv = getActiveConv()) {
  const policy = getToolPolicy(conv);
  return toolName === 'web_search' ? policy.webSearch : toolName === 'url_fetch' ? policy.urlFetch : false;
}

function saveConversationImmediately() {
  return persistConversationState();
}

function scrollMessagesToBottom() {
  const area = document.getElementById('messagesArea');
  if (!area) return;
  area.scrollTo({ top: area.scrollHeight, behavior: getScrollBehavior() });
}

function isDebugLoggingEnabled() {
  return localStorage.getItem('assistantDebug') === 'true';
}

function isDebugTextIncluded() {
  return localStorage.getItem('assistantDebugIncludeText') === 'true';
}

function setDebugPreference() {
  const logging = document.getElementById('setDebugLogging');
  const includeText = document.getElementById('setDebugIncludeText');
  if (logging) localStorage.setItem('assistantDebug', logging.checked ? 'true' : 'false');
  if (includeText) localStorage.setItem('assistantDebugIncludeText', includeText.checked ? 'true' : 'false');
  renderDebugLogPreview();
}

function shortenForDebug(value, limit = 160) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '... [' + (text.length - limit).toLocaleString() + ' more chars]';
}

function summarizeContentPartForDebug(part, includeText) {
  if (!part || typeof part !== 'object') return { type: typeof part };
  const type = part.type || 'part';
  if (type === 'text') {
    return {
      type,
      chars: String(part.text || '').length,
      text: includeText ? part.text || '' : '[redacted text]'
    };
  }
  if (type === 'image_url') {
    const url = part.image_url?.url || '';
    return { type, imageUrl: url ? (includeText ? shortenForDebug(url, 80) : '[redacted image]') : '' };
  }
  if (type === 'file') {
    const file = part.file || {};
    const text = file.textContent || '';
    return {
      type,
      name: file.name || 'file',
      mime: file.mime || '',
      chars: String(text).length,
      text: includeText ? text : (text ? '[redacted file text]' : '')
    };
  }
  return { type, keys: Object.keys(part) };
}

function summarizeMessageForDebug(message, includeText) {
  const summary = { role: message.role };
  if (Array.isArray(message.content)) {
    summary.content = message.content.map(part => summarizeContentPartForDebug(part, includeText));
  } else if (typeof message.content === 'string') {
    summary.content = {
      type: 'text',
      chars: message.content.length,
      text: includeText ? message.content : '[redacted text]'
    };
  } else if (message.content === null) {
    summary.content = null;
  } else {
    summary.content = typeof message.content;
  }
  if (message.tool_calls) {
    summary.toolCalls = message.tool_calls.map(tc => ({
      id: tc.id,
      type: tc.type,
      name: tc.function?.name || tc.name || '',
      arguments: includeText ? tc.function?.arguments : '[redacted arguments]'
    }));
  }
  if (message.tool_call_id) summary.toolCallId = message.tool_call_id;
  return summary;
}

function summarizeLlmPayloadForDebug(payload, includeText = isDebugTextIncluded()) {
  const summary = {};
  ['model', 'stream', 'temperature', 'max_tokens', 'tool_choice', 'thinking', 'output_config'].forEach(key => {
    if (payload && key in payload) summary[key] = payload[key];
  });
  if (payload?.system) {
    // system is a plain string on OpenAI-compatible calls and a content-block array
    // when Anthropic prompt caching is on — flatten so the debug view stays readable.
    const cached = Array.isArray(payload.system) && payload.system.some(b => b && b.cache_control);
    const systemText = Array.isArray(payload.system)
      ? payload.system.map(b => (typeof b === 'string' ? b : b?.text || '')).join('\n\n')
      : String(payload.system);
    summary.system = {
      chars: systemText.length,
      cached,
      text: includeText ? systemText : '[redacted text]'
    };
  }
  if (Array.isArray(payload?.messages)) {
    summary.messages = payload.messages.map(message => summarizeMessageForDebug(message, includeText));
  }
  if (Array.isArray(payload?.tools)) {
    summary.tools = payload.tools.map(tool => tool.name || tool.function?.name || tool.type || 'tool');
  }
  return summary;
}

function debugLog(event, details = {}) {
  if (!isDebugLoggingEnabled()) return;
  const entry = { time: new Date().toISOString(), event, details };
  debugLogBuffer.push(entry);
  if (debugLogBuffer.length > 50) debugLogBuffer = debugLogBuffer.slice(-50);
  console.log('[Synapse debug]', event, details);
  renderDebugLogPreview();
}

function debugLogPayload(event, payload, meta = {}) {
  debugLog(event, { ...meta, payload: summarizeLlmPayloadForDebug(payload) });
}

function renderDebugLogPreview() {
  const el = document.getElementById('debugLogPreview');
  if (!el) return;
  if (debugLogBuffer.length === 0) {
    el.textContent = isDebugLoggingEnabled()
      ? 'Debug logging is on. API request summaries will appear here.'
      : 'Debug logging is off.';
    return;
  }
  el.textContent = JSON.stringify(debugLogBuffer.slice(-12), null, 2);
}

function clearDebugLog() {
  debugLogBuffer = [];
  renderDebugLogPreview();
}

async function copyDebugSnapshot() {
  const snapshot = {
    version: APP_VERSION,
    currentModel: localStorage.getItem('llmModel') || '',
    apiFormat: localStorage.getItem('llmApiFormat') || 'auto',
    provider: getLlmProviderInfo(localStorage.getItem('llmModel') || '', detectApiFormat(localStorage.getItem('llmModel') || ''), localStorage.getItem('llmProxyUrl') || ''),
    activeProfile: getActiveProfileSummary(),
    update: localUpdateState,
    logs: debugLogBuffer
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
    showToast('Debug snapshot copied.', 'success');
  } catch(e) {
    showToast('Clipboard is unavailable in this browser.', 'error');
  }
}

function isLocalRuntime() {
  const host = location.hostname;
  return location.protocol === 'file:' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local');
}

async function fetchJsonNoStore(url) {
  const separator = url.includes('?') ? '&' : '?';
  const response = await fetch(url + separator + 't=' + Date.now(), { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

function compareBuildDate(a, b) {
  const aDate = Date.parse(a || '');
  const bDate = Date.parse(b || '');
  if (!Number.isFinite(aDate) || !Number.isFinite(bDate)) return 0;
  return aDate === bDate ? 0 : (aDate > bDate ? 1 : -1);
}

function setLocalUpdateState(status, message, details) {
  localUpdateState = { status, message, details: details || '' };
  renderLocalUpdateStatus();
}

function renderLocalUpdateStatus() {
  const footer = document.getElementById('updateStatus');
  const status = document.getElementById('localUpdateStatus');
  const details = document.getElementById('localUpdateDetails');
  if (footer) {
    footer.hidden = !(isLocalRuntime() && localUpdateState.status === 'update');
    footer.title = localUpdateState.details || '';
    if (!footer.hidden) {
      footer.innerHTML = '<span class="update-status-text">' + escapeHTML(localUpdateState.message || 'Update available') + '</span>' +
        '<button id="updateNowBtn" class="update-btn" type="button">Update Now</button>';
      const btn = document.getElementById('updateNowBtn');
      if (btn) btn.onclick = performSelfUpdate;
    } else {
      footer.textContent = '';
    }
  }
  if (status) {
    status.textContent = localUpdateState.message || 'Not checked';
    status.className = 'debug-status-pill ' + (localUpdateState.status || 'idle');
  }
  if (details) {
    details.textContent = localUpdateState.details || (isLocalRuntime()
      ? 'Synapse can compare this local copy with the published build.'
      : 'Update checks only appear while Synapse is running locally.');
  }
}

async function checkLocalUpdateStatus(manual = false) {
  if (!isLocalRuntime()) {
    setLocalUpdateState('idle', 'Remote build', 'Update checks are shown only when running Synapse from localhost or a local file.');
    if (manual) showToast('Update checks are only shown for local runs.', 'info');
    return;
  }

  setLocalUpdateState('checking', 'Checking...', 'Looking for a newer Synapse build.');
  let current = APP_VERSION;
  try {
    current = { ...APP_VERSION, ...(await fetchJsonNoStore('./version.json')) };
  } catch(e) {}

  try {
    if (location.protocol !== 'file:') {
      const serverVersion = await fetchJsonNoStore('/version');
      if (serverVersion && serverVersion.isLatest === false) {
        setLocalUpdateState('update', 'Update available', 'The local server reports that this checkout is behind its tracked branch.');
        if (manual) showToast('Update available.', 'info');
        return;
      }
      if (serverVersion && serverVersion.isLatest === true) {
        setLocalUpdateState('current', 'Up to date', 'The local server reports that this checkout is current.');
      }
    }
  } catch(e) {}

  try {
    const remote = await fetchRemoteJsonNoStore(current.updateUrl || APP_VERSION.updateUrl);
    const cmp = compareBuildDate(remote.buildDate, current.buildDate);
    if (cmp > 0) {
      setLocalUpdateState('update', 'Update available', 'Published build: ' + (remote.buildDate || 'unknown') + '. Local build: ' + (current.buildDate || 'unknown') + '.');
      if (manual) showToast('Update available.', 'info');
      return;
    }
    if (cmp === 0) {
      setLocalUpdateState('current', 'Up to date', 'Local build matches the published Synapse build.');
      if (manual) showToast('Synapse is up to date.', 'success');
      return;
    }
  } catch(e) {
    if (localUpdateState.status === 'current') return;
  }

  setLocalUpdateState('unknown', 'Unable to compare', 'No local /version endpoint or published version metadata was reachable.');
  if (manual) showToast('Could not compare updates automatically.', 'info');
}

async function fetchRemoteJsonNoStore(url) {
  const text = await fetchRemoteTextNoStore(url);
  return JSON.parse(text);
}

async function fetchRemoteTextNoStore(url) {
  const separator = url.includes('?') ? '&' : '?';
  const cacheBustedUrl = url + separator + 't=' + Date.now();
  const options = { cache: 'no-store' };
  try {
    const response = await fetch(cacheBustedUrl, options);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.text();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    const response = await proxiedFetch(cacheBustedUrl, options);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.text();
  }
}

function getUpdateHtmlUrl(versionInfo = {}) {
  const explicit = versionInfo.htmlUrl || versionInfo.downloadUrl || versionInfo.updateHtmlUrl || APP_VERSION.htmlUrl;
  if (explicit) return explicit;
  const updateUrl = versionInfo.updateUrl || APP_VERSION.updateUrl;
  return String(updateUrl || 'https://platberlitz.github.io/assistant/version.json').replace(/version\.json(?:\?.*)?$/, 'synapse.html');
}

function extractBuildDateFromHtml(html) {
  const match = String(html || '').match(/buildDate:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : '';
}

function validateDownloadedSynapseHtml(html) {
  const text = String(html || '');
  return text.includes('<title>Synapse</title>') &&
    text.includes('APP_VERSION') &&
    text.includes('assistantDB') &&
    text.includes('streamResponse');
}

async function downloadUpdate() {
  let versionInfo = {};
  try {
    versionInfo = await fetchRemoteJsonNoStore(APP_VERSION.updateUrl);
  } catch (err) {
    console.warn('Could not fetch remote version metadata before download:', err);
  }
  const htmlUrl = getUpdateHtmlUrl(versionInfo);
  const htmlContent = await fetchRemoteTextNoStore(htmlUrl);
  if (!validateDownloadedSynapseHtml(htmlContent)) {
    throw new Error('Downloaded file did not look like a Synapse standalone build.');
  }
  const buildDate = extractBuildDateFromHtml(htmlContent) || versionInfo.buildDate || 'unknown';
  return { htmlContent, htmlUrl, versionInfo, buildDate };
}

function triggerFileDownload(htmlContent, filename) {
  const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function performSelfUpdate() {
  const btn = document.getElementById('updateNowBtn');
  const oldText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Downloading...';
  }
  setLocalUpdateState('update', 'Downloading update...', 'Downloading the published standalone Synapse build.');
  const activeBtn = document.getElementById('updateNowBtn');
  if (activeBtn) {
    activeBtn.disabled = true;
    activeBtn.textContent = 'Downloading...';
  }
  try {
    const update = await downloadUpdate();
    triggerFileDownload(update.htmlContent, 'synapse.html');
    setLocalUpdateState('update', 'Update downloaded', 'Downloaded build: ' + update.buildDate + '. Replace your old synapse.html with the downloaded file.');
    showUpdateInstructions(update.buildDate);
    showToast('Update downloaded.', 'success');
  } catch (err) {
    setLocalUpdateState('update', 'Update available', 'Download failed: ' + (err.message || err));
    showToast('Update failed: ' + (err.message || err), 'error', 6000);
  } finally {
    const nextBtn = document.getElementById('updateNowBtn');
    if (nextBtn) {
      nextBtn.disabled = false;
      nextBtn.textContent = oldText || 'Update Now';
    }
  }
}

function createUpdateModal() {
  let modal = document.getElementById('updateInstructionsModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'updateInstructionsModal';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = '<div class="modal update-instructions-modal" aria-labelledby="updateInstructionsTitle">' +
    '<h2 id="updateInstructionsTitle">Update Instructions</h2>' +
    '<div class="modal-body" id="updateInstructionsBody"></div>' +
    '<div class="modal-actions"><button class="btn btn-primary" type="button" onclick="closeModal(\'updateInstructionsModal\')">Close</button></div>' +
    '</div>';
  document.body.appendChild(modal);
  initModalAccessibility();
  return modal;
}

function showUpdateInstructions(newVersion) {
  const modal = createUpdateModal();
  const body = modal.querySelector('#updateInstructionsBody') || modal.querySelector('.modal-body');
  if (body) {
    body.innerHTML = '<div class="update-instructions">' +
      '<p>A fresh <strong>synapse.html</strong> has been saved to your Downloads folder.</p>' +
      '<ol>' +
      '<li>Close any open local Synapse tabs.</li>' +
      '<li>Move the downloaded <strong>synapse.html</strong> over your old copy.</li>' +
      '<li>Open the replaced file to run the new build.</li>' +
      '</ol>' +
      '<div class="update-warning">Browsers cannot replace files opened with <code>file://</code>, so this last swap has to stay manual. Your conversations and settings stay in this browser profile.</div>' +
      (newVersion ? '<p class="update-version-note">Downloaded build: ' + escapeHTML(newVersion) + '</p>' : '') +
      '</div>';
  }
  openModal(modal);
}

// ============================================
// Toast Notifications
// ============================================
function showToast(message, type = 'info', duration = 3000, action = null) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  if (action?.label && typeof action.onClick === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.onclick = () => { action.onClick(); toast.remove(); };
    toast.appendChild(button);
  }
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  toast.setAttribute('aria-atomic', 'true');
  container.appendChild(toast);
  if (duration > 0) {
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}

// ============================================
// Theme Presets
// ============================================
const themePresets = {
  dark:       { bg:'#0f1310', sidebar:'#151a16', cardBorder:'#2a332c', textPrimary:'#d8ded7', textSecondary:'#8d998e', accent:'#789a7f', accentHover:'#8aae91', msgUser:'#223128', msgAssistant:'transparent', borderRadius:'9px', msgMaxWidth:'76%', codeBg:'#111713' },
  light:      { bg:'#f5f5f7', sidebar:'#eeeef2', cardBorder:'rgba(0,0,0,0.1)', textPrimary:'rgba(0,0,0,0.9)', textSecondary:'#646565', accent:'#5457c9', accentHover:'#565ea0', msgUser:'#5457c9', msgAssistant:'rgba(0,0,0,0.05)' },
  nord:       { bg:'#2e3440', sidebar:'#3b4252', cardBorder:'#434c5e', textPrimary:'#eceff4', textSecondary:'#d8dee9', accent:'#88c0d0', accentHover:'#8fbcbb', msgUser:'#5e81ac', msgAssistant:'#3b4252' },
  catppuccin: { bg:'#1e1e2e', sidebar:'#313244', cardBorder:'#45475a', textPrimary:'#cdd6f4', textSecondary:'#a6adc8', accent:'#cba6f7', accentHover:'#b4befe', msgUser:'#cba6f7', msgAssistant:'#313244' },
  dracula:    { bg:'#282a36', sidebar:'#44475a', cardBorder:'#6272a4', textPrimary:'#f8f8f2', textSecondary:'#cdaff8', accent:'#cdaff8', accentHover:'#fd9ed4', msgUser:'#bd93f9', msgAssistant:'#44475a' },
  gruvbox:    { bg:'#282828', sidebar:'#3c3836', cardBorder:'#504945', textPrimary:'#ebdbb2', textSecondary:'#b2a593', accent:'#fabd2f', accentHover:'#fe8019', msgUser:'#fabd2f', msgAssistant:'#3c3836' },
  tokyonight: { bg:'#1a1b26', sidebar:'#24283b', cardBorder:'#414868', textPrimary:'#c0caf5', textSecondary:'#8e95af', accent:'#7aa2f7', accentHover:'#bb9af7', msgUser:'#7aa2f7', msgAssistant:'#24283b' },
  solarized:  { bg:'#002b36', sidebar:'#073642', cardBorder:'#586e75', textPrimary:'#fdf6e3', textSecondary:'#93a1a1', accent:'#58a5db', accentHover:'#47ada5', msgUser:'#268bd2', msgAssistant:'#073642' },
  onedark:    { bg:'#282c34', sidebar:'#21252b', cardBorder:'#3e4451', textPrimary:'#abb2bf', textSecondary:'#989ea4', accent:'#61afef', accentHover:'#ca82df', msgUser:'#61afef', msgAssistant:'#2c313c' },
  rosepine:   { bg:'#191724', sidebar:'#1f1d2e', cardBorder:'#26233a', textPrimary:'#e0def4', textSecondary:'#908caa', accent:'#c4a7e7', accentHover:'#ebbcba', msgUser:'#c4a7e7', msgAssistant:'#1f1d2e' },
  // Gallery
  monochrome:     { bg:'#131313', sidebar:'#222222', cardBorder:'#333333', textPrimary:'#e0e0e0', textSecondary:'rgba(224,224,224,0.6)', accent:'#FCFCFC', accentHover:'#ffffff', msgUser:'#FCFCFC', msgAssistant:'#222222' },
  pewter:         { bg:'#222222', sidebar:'#333333', cardBorder:'#444444', textPrimary:'#e0e0e0', textSecondary:'rgba(224,224,224,0.6)', accent:'#D9D9D9', accentHover:'#eeeeee', msgUser:'#D9D9D9', msgAssistant:'#333333' },
  deepSea:        { bg:'#061234', sidebar:'#0f1e44', cardBorder:'#182a54', textPrimary:'#d0e0d0', textSecondary:'rgba(208,224,208,0.6)', accent:'#50AA09', accentHover:'#6ec42a', msgUser:'#50AA09', msgAssistant:'#0f1e44' },
  gunmetal:       { bg:'#1E212B', sidebar:'#2a2e3a', cardBorder:'#363a48', textPrimary:'#c8cdd2', textSecondary:'#979ba2', accent:'#929da3', accentHover:'#8f9da5', msgUser:'#5B6B76', msgAssistant:'#2a2e3a' },
  clearSky:       { bg:'#1e4c84', sidebar:'#2a5a94', cardBorder:'#3668a4', textPrimary:'#e0f0ff', textSecondary:'#c9d8e6', accent:'#9cdffd', accentHover:'#9ee6ff', msgUser:'#7ed6ff', msgAssistant:'#2a5a94', danger:'#f5ccca', success:'#a4e5bb', warning:'#f0d478' },
  cobalt:         { bg:'#0D55B2', sidebar:'#1a64c0', cardBorder:'#2874d0', textPrimary:'#e0f0f8', textSecondary:'#e3ecf2', accent:'#deeeee', accentHover:'#d9eff1', msgUser:'#249CB6', msgAssistant:'#1a64c0', danger:'#f6e7e4', success:'#d5f1de', warning:'#f4ebc6' },
  nightshade:     { bg:'#07040C', sidebar:'#16121e', cardBorder:'#251e30', textPrimary:'#e0d8e8', textSecondary:'rgba(224,216,232,0.6)', accent:'#BDA8DC', accentHover:'#ddc8fc', msgUser:'#BDA8DC', msgAssistant:'#16121e' },
  plumWine:       { bg:'#1E2233', sidebar:'#2a2e44', cardBorder:'#363a54', textPrimary:'#dcd0e0', textSecondary:'#9e99a9', accent:'#bb8bc5', accentHover:'#c287ce', msgUser:'#822195', msgAssistant:'#2a2e44' },
  neonDusk:       { bg:'#495495', sidebar:'#5a64a5', cardBorder:'#6a74b5', textPrimary:'#f4edf7', textSecondary:'#eeeff2', accent:'#f8edf3', accentHover:'#f8ecf4', msgUser:'#ff7edb', msgAssistant:'#5a64a5', danger:'#f7eeeb', success:'#e2f4e7', warning:'#f5f0d7' },
  lavenderHaze:   { bg:'#414b96', sidebar:'#4b56ab', cardBorder:'#7d89ee', textPrimary:'#f0e8f0', textSecondary:'#e2dfee', accent:'#f0d8ed', accentHover:'#f5e1f1', msgUser:'#A45785', msgAssistant:'#4b56ab', danger:'#ffe5e5', success:'#c9f0d8', warning:'#f7e4b5' },
  jadeMist:       { bg:'#14161E', sidebar:'#20222e', cardBorder:'#2c2e3e', textPrimary:'#d8e8e0', textSecondary:'rgba(216,232,224,0.6)', accent:'#95D3AF', accentHover:'#b5f3cf', msgUser:'#95D3AF', msgAssistant:'#20222e' },
  mossStone:      { bg:'#373C3F', sidebar:'#454b4f', cardBorder:'#555b5f', textPrimary:'#d8e8d8', textSecondary:'#b9c2bb', accent:'#a6c8ad', accentHover:'#a3d3ae', msgUser:'#83B38E', msgAssistant:'#454b4f' },
  emeraldForest:  { bg:'#295233', sidebar:'#376243', cardBorder:'#457253', textPrimary:'#d8f0d0', textSecondary:'#cadaca', accent:'#89E574', accentHover:'#a9ff94', msgUser:'#89E574', msgAssistant:'#376243', danger:'#f5ccca', success:'#a4e5bb', warning:'#f0d478' },
  winterBreeze:   { bg:'#141b1e', sidebar:'#20282e', cardBorder:'#2c343e', textPrimary:'#d0e0f0', textSecondary:'rgba(208,224,240,0.6)', accent:'#67b0e8', accentHover:'#87d0ff', msgUser:'#67b0e8', msgAssistant:'#20282e' },
  neonNoir:       { bg:'#000000', sidebar:'#141414', cardBorder:'#282828', textPrimary:'#e0e0e0', textSecondary:'rgba(224,224,224,0.6)', accent:'#fada16', accentHover:'#ffea46', msgUser:'#fada16', msgAssistant:'#141414' },
  hotPink:        { bg:'#2d2a2e', sidebar:'#3d3a3e', cardBorder:'#4d4a4e', textPrimary:'#f8f8f2', textSecondary:'rgba(248,248,242,0.6)', accent:'#f887af', accentHover:'#fc83b4', msgUser:'#f92672', msgAssistant:'#3d3a3e' },
  roseQuartz:     { bg:'#161616', sidebar:'#262626', cardBorder:'#363636', textPrimary:'#e8d8e0', textSecondary:'rgba(232,216,224,0.6)', accent:'#EE5396', accentHover:'#ff73b6', msgUser:'#EE5396', msgAssistant:'#262626' },
  ember:          { bg:'#0D0D0D', sidebar:'#1d1d1d', cardBorder:'#2d2d2d', textPrimary:'#e8d8c8', textSecondary:'rgba(232,216,200,0.6)', accent:'#E0701E', accentHover:'#ff903e', msgUser:'#E0701E', msgAssistant:'#1d1d1d' },
  moltenCore:     { bg:'#351810', sidebar:'#452820', cardBorder:'#553830', textPrimary:'#f0e0c8', textSecondary:'rgba(240,224,200,0.6)', accent:'#FABD2F', accentHover:'#ffdd4f', msgUser:'#FABD2F', msgAssistant:'#452820' },
  orchidTeal:     { bg:'#821595', sidebar:'#9225a5', cardBorder:'#a235b5', textPrimary:'#e0f0f0', textSecondary:'#e0d3e7', accent:'#badfdc', accentHover:'#aee1de', msgUser:'#259E9C', msgAssistant:'#9225a5', danger:'#f5cecb', success:'#a6e5bc', warning:'#f1d67f' },
  acidGlow:       { bg:'#4B0082', sidebar:'#5b1092', cardBorder:'#6b20a2', textPrimary:'#d8f8e0', textSecondary:'#b1a8c8', accent:'#00FF66', accentHover:'#33ff88', msgUser:'#00FF66', msgAssistant:'#5b1092' },
  fjord:          { bg:'#2E3440', sidebar:'#3b4252', cardBorder:'#434c5e', textPrimary:'#eceff4', textSecondary:'#d8dee9', accent:'#88C0D0', accentHover:'#a8e0f0', msgUser:'#88C0D0', msgAssistant:'#3b4252' },
  oxide:          { bg:'#0f1115', sidebar:'#151922', cardBorder:'#252a36', textPrimary:'#e8e6e3', textSecondary:'#a8a3a0', accent:'#f26a2e', accentHover:'#ff7b43', msgUser:'#f26a2e', msgAssistant:'#1b202b', borderRadius:'16px', msgMaxWidth:'72%', codeBg:'rgba(242,106,46,0.08)' },
  blueprint:      { bg:'#0b1220', sidebar:'#101a2e', cardBorder:'#1e2b46', textPrimary:'#e6edf6', textSecondary:'#9fb0c6', accent:'#4aa3ff', accentHover:'#6bb6ff', msgUser:'#4aa3ff', msgAssistant:'#131f33', borderRadius:'18px', msgMaxWidth:'70%', codeBg:'rgba(74,163,255,0.10)' },
  paperInk:       { bg:'#f6f3ee', sidebar:'#f0ece5', cardBorder:'#d8d3c8', textPrimary:'#1f1b16', textSecondary:'#6e645b', accent:'#2d69a7', accentHover:'#34699e', msgUser:'#2f6fb2', msgAssistant:'#ffffff', borderRadius:'20px', msgMaxWidth:'68%', codeBg:'rgba(47,111,178,0.08)' },
  moss:           { bg:'#101612', sidebar:'#161d17', cardBorder:'#2a332c', textPrimary:'#e0e7df', textSecondary:'#a6b2a4', accent:'#7ac27b', accentHover:'#8fd990', msgUser:'#7ac27b', msgAssistant:'#1a231c', borderRadius:'16px', msgMaxWidth:'72%', codeBg:'rgba(122,194,123,0.10)' },
  claude:         { bg:'#FAF9F5', sidebar:'#EBE7DF', cardBorder:'rgba(0,0,0,0.08)', textPrimary:'#1a1915', textSecondary:'#65645f', accent:'#91533d', accentHover:'#93513a', msgUser:'#D97757', msgAssistant:'#F3F0E8', borderRadius:'24px', msgMaxWidth:'70%', codeBg:'rgba(0,0,0,0.04)' },
  claudeDark:     { bg:'#1a1915', sidebar:'#1a1915', cardBorder:'rgba(255,255,255,0.08)', textPrimary:'#e8e4db', textSecondary:'#989690', accent:'#D97757', accentHover:'#ce846b', msgUser:'#D97757', msgAssistant:'#2b2a27', borderRadius:'24px', msgMaxWidth:'70%', codeBg:'rgba(0,0,0,0.3)' }
};

const themeOrder = ['dark','light','nord','catppuccin','dracula','gruvbox','tokyonight','solarized','onedark','rosepine','monochrome','pewter','deepSea','gunmetal','clearSky','cobalt','nightshade','plumWine','neonDusk','lavenderHaze','jadeMist','mossStone','emeraldForest','winterBreeze','neonNoir','hotPink','roseQuartz','ember','moltenCore','orchidTeal','acidGlow','fjord','oxide','blueprint','paperInk','moss','claude','claudeDark'];

// ============================================
// Utility
// ============================================
// ============================================
// Theme System
// ============================================
function applyTheme(name) {
  let t;
  if (name === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    t = prefersDark ? themePresets.dark : themePresets.light;
  } else if (name === 'custom') {
    try { t = JSON.parse(localStorage.getItem('assistantCustomTheme') || 'null'); } catch(e) { console.warn('Custom theme parse error:', e); }
    if (!t) t = themePresets.dark;
  } else {
    t = themePresets[name] || themePresets.dark;
  }
  const s = document.documentElement.style;
  s.setProperty('--bg', t.bg);
  s.setProperty('--sidebar-bg', t.sidebar);
  s.setProperty('--card-border', t.cardBorder);
  s.setProperty('--text-primary', t.textPrimary);
  s.setProperty('--text-secondary', t.textSecondary);
  s.setProperty('--accent', t.accent);
  s.setProperty('--accent-hover', t.accentHover);
  s.setProperty('--msg-user', t.msgUser);
  s.setProperty('--msg-assistant', t.msgAssistant);
  s.setProperty('--hover', isLightColor(t.bg) ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)');
  s.setProperty('--accent-text', getContrastText(t.accent));
  s.setProperty('--msg-user-text', getContrastText(t.msgUser));
  const bgLight = isLightColor(t.bg);
  // Lets the stylesheet re-skin the (dark-only) highlight.js token colors.
  document.body.classList.toggle('theme-light', bgLight);
  s.setProperty('--overlay-10', bgLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)');
  s.setProperty('--overlay-15', bgLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.15)');
  s.setProperty('--overlay-25', bgLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)');
  s.setProperty('--border-radius', t.borderRadius || '16px');
  s.setProperty('--msg-max-width', t.msgMaxWidth || '75%');
  s.setProperty('--msg-padding', t.msgPadding || '12px 16px');
  s.setProperty('--msg-font-size', t.msgFontSize || '0.95em');
  s.setProperty('--code-bg', t.codeBg || (bgLight ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.3)'));
  s.setProperty('--card-bg', bgLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)');
  const forest = t === themePresets.dark;
  const danger = t.danger || (bgLight ? '#b91c1c' : forest ? '#ef4444' : '#ffb4b4');
  const dangerHover = bgLight ? '#991b1b' : forest ? '#f87171' : danger;
  const success = t.success || (bgLight ? '#166534' : forest ? '#22c55e' : '#4ade80');
  const warning = t.warning || (bgLight ? '#785c0c' : '#eab308');
  s.setProperty('--error-color', forest ? '#ff7777' : danger);
  s.setProperty('--danger-color', danger);
  s.setProperty('--danger-hover', dangerHover);
  s.setProperty('--danger-text', getContrastText(danger));
  s.setProperty('--success-color', success);
  s.setProperty('--success-text', getContrastText(success));
  s.setProperty('--warning-color', warning);
  s.setProperty('--warning-text', getContrastText(warning));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.bg);
  if (!readOnlyShare) localStorage.setItem('assistantTheme', name);

  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.innerHTML = isLightColor(t.bg) ? '&#9728;' : '&#9790;';
    btn.title = 'Theme: ' + name;
  }
  applyMsgOverrides();
  // Sync mermaid theme with app theme
  if (typeof mermaid !== 'undefined') {
    const mermaidTheme = isLightColor(t.bg) ? 'default' : 'dark';
    mermaid.initialize({ startOnLoad: false, theme: mermaidTheme });
  }
}

function applyMsgOverrides() {
  const s = document.documentElement.style;
  const fs = localStorage.getItem('assistantMsgFontSize');
  const mw = localStorage.getItem('assistantMsgMaxWidth');
  if (fs) s.setProperty('--msg-font-size', fs);
  if (mw) s.setProperty('--msg-max-width', mw);
}

function toggleTheme() {
  if (readOnlyShare) return;
  const current = localStorage.getItem('assistantTheme') || 'dark';
  let order = [...themeOrder];
  const hasCustom = localStorage.getItem('assistantCustomTheme');
  if (hasCustom) order.push('custom');
  let idx = order.indexOf(current);
  const next = order[(idx + 1) % order.length];
  applyTheme(next);
  syncScheduleAutoPush();

  // Flash theme name
  const btn = document.getElementById('themeToggle');
  const old = btn.querySelector('.theme-flash');
  if (old) old.remove();
  const flash = document.createElement('span');
  flash.className = 'theme-flash';
  flash.textContent = next;
  btn.appendChild(flash);
  setTimeout(() => flash.remove(), 1600);
}

function loadTheme() {
  const migrationMap = {
    oneBit:'monochrome', graphiteMono:'pewter', abyssalWave:'deepSea', cosmicBlue:'gunmetal',
    pixelDream:'clearSky', anotherWorld:'cobalt', obsidianPurple:'nightshade', scarletNight:'plumWine',
    synthWave:'neonDusk', amethystAura:'lavenderHaze', decayGreen:'jadeMist', greenLush:'mossStone',
    rainDark:'emeraldForest', everBlushing:'winterBreeze', edgeRunner:'neonNoir', monokai:'hotPink',
    redStone:'roseQuartz', soulsborne:'ember', doomBringers:'moltenCore', nightbrew:'orchidTeal',
    joker:'acidGlow', nordicBlue:'fjord'
  };
  let name = localStorage.getItem('assistantTheme') || 'dark';
  if (migrationMap[name]) {
    name = migrationMap[name];
    if (!readOnlyShare) localStorage.setItem('assistantTheme', name);
  }
  applyTheme(name);
}

// ============================================
// Custom Theme Helpers
// ============================================
function onThemeSelectChange() {
  if (readOnlyShare) return;
  const val = document.getElementById('setTheme').value;
  document.getElementById('customThemeColors').style.display = val === 'custom' ? 'grid' : 'none';
  if (val === 'custom') {
    loadCustomColorPickers();
  }
  applyTheme(val);
  syncScheduleAutoPush();
  if (document.getElementById('settingsModal')?.classList.contains('open')) {
    setSettingsSaveStatus(_appearanceSettingsAutosavePending ? 'Saving...' : 'Appearance saved.');
  }
}

function loadCustomColorPickers() {
  let t;
  try { t = JSON.parse(localStorage.getItem('assistantCustomTheme') || 'null'); } catch(e) { console.warn('Custom theme parse error:', e); }
  if (!t) t = themePresets.dark;
  const toHex = (c) => {
    if (c.startsWith('#') && c.length >= 7) return c.slice(0, 7);
    if (c.startsWith('#') && c.length === 4) return '#' + c[1]+c[1]+c[2]+c[2]+c[3]+c[3];
    if (c.startsWith('rgba') || c.startsWith('rgb')) {
      const m = c.match(/[\d.]+/g);
      if (m) return '#' + [m[0],m[1],m[2]].map(v => Math.round(parseFloat(v)).toString(16).padStart(2,'0')).join('');
    }
    return '#101014';
  };
  document.getElementById('cBg').value = toHex(t.bg);
  document.getElementById('cSidebar').value = toHex(t.sidebar);
  document.getElementById('cBorder').value = toHex(t.cardBorder);
  document.getElementById('cText').value = toHex(t.textPrimary);
  document.getElementById('cTextSec').value = toHex(t.textSecondary);
  document.getElementById('cAccent').value = toHex(t.accent);
  document.getElementById('cAccentHover').value = toHex(t.accentHover);
  document.getElementById('cMsgUser').value = toHex(t.msgUser);
  document.getElementById('cMsgAssistant').value = toHex(t.msgAssistant);
  document.getElementById('cBorderRadius').value = t.borderRadius || '';
  document.getElementById('cMsgMaxWidth').value = t.msgMaxWidth || '';
  document.getElementById('cMsgFontSize').value = t.msgFontSize || '';
  document.getElementById('cCodeBg').value = t.codeBg ? toHex(t.codeBg) : '#101014';
}

function resetCustomTheme() {
  localStorage.removeItem('assistantCustomTheme');
  document.getElementById('setTheme').value = 'dark';
  document.getElementById('customThemeColors').style.display = 'none';
  applyTheme('dark');
  syncScheduleAutoPush();
  if (document.getElementById('settingsModal')?.classList.contains('open')) setSettingsSaveStatus('Appearance saved.');
}

function getCustomThemeFromPickers() {
  const t = {
    bg: document.getElementById('cBg').value,
    sidebar: document.getElementById('cSidebar').value,
    cardBorder: document.getElementById('cBorder').value,
    textPrimary: document.getElementById('cText').value,
    textSecondary: document.getElementById('cTextSec').value,
    accent: document.getElementById('cAccent').value,
    accentHover: document.getElementById('cAccentHover').value,
    msgUser: document.getElementById('cMsgUser').value,
    msgAssistant: document.getElementById('cMsgAssistant').value
  };
  const br = document.getElementById('cBorderRadius').value.trim();
  const mw = document.getElementById('cMsgMaxWidth').value.trim();
  const fs = document.getElementById('cMsgFontSize').value.trim();
  const cb = document.getElementById('cCodeBg').value;
  if (br) t.borderRadius = br;
  if (mw) t.msgMaxWidth = mw;
  if (fs) t.msgFontSize = fs;
  if (cb) t.codeBg = cb;
  return t;
}

function liveCustomTheme() {
  const t = getCustomThemeFromPickers();
  localStorage.setItem('assistantCustomTheme', JSON.stringify(t));
  applyTheme('custom');
  syncScheduleAutoPush();
  if (document.getElementById('settingsModal')?.classList.contains('open')) {
    setSettingsSaveStatus(_appearanceSettingsAutosavePending ? 'Saving...' : 'Appearance saved.');
  }
}

// ============================================
// Custom Google Fonts
// ============================================
function loadCustomFont(fontName) {
  const old = document.getElementById('customFontLink');
  if (old) old.remove();
  if (!fontName) {
    document.body.style.fontFamily = "'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    return;
  }
  const link = document.createElement('link');
  link.id = 'customFontLink';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=' + fontName.replace(/ /g, '+') + ':wght@400;500;600;700&display=swap';
  document.head.appendChild(link);
  document.body.style.fontFamily = "'" + fontName + "', 'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
}

const DEFAULT_CORS_PROXY_URL = 'https://corsproxy.io/?url=';

function normalizeCorsProxyUrl(url) {
  const trimmed = String(url || '').trim();
  return safeHttpUrl(trimmed) || DEFAULT_CORS_PROXY_URL;
}

function getCorsProxyUrl() {
  return normalizeCorsProxyUrl(localStorage.getItem('llmCorsProxy'));
}

function isMixedContentSensitiveApiBase(baseUrl) {
  return window.location.protocol === 'https:' && /^http:\/\//i.test(String(baseUrl || '').trim());
}

function isHttpApiBase(baseUrl) {
  return /^http:\/\//i.test(String(baseUrl || '').trim());
}

function isPrivateIpv4(host) {
  const parts = String(host || '').split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b, c] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

function canonicalHostname(url) {
  return new URL(url).hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

function mappedIpv4FromIpv6(host) {
  if (!host.startsWith('::ffff:')) return '';
  const tail = host.slice(7);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) return tail;
  const parts = tail.split(':');
  if (parts.length !== 2 || parts.some(part => !/^[0-9a-f]{1,4}$/i.test(part))) return '';
  const high = parseInt(parts[0], 16);
  const low = parseInt(parts[1], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

function isLocalUrl(url) {
  try {
    const host = canonicalHostname(url);
    const mappedIpv4 = mappedIpv4FromIpv6(host);
    return host === 'localhost' || host.endsWith('.localhost') || host.startsWith('::')
      || host.endsWith('.local') || isPrivateIpv4(host) || isPrivateIpv4(mappedIpv4)
      || /^(?:0:0:0:0:0:0:0:[01]|fc|fd|fe[89ab]|2001:db8)/i.test(host);
  } catch { return false; }
}

function requestContainsSensitiveData(url, options = {}, forceSensitive = false) {
  if (forceSensitive) return true;
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method) || options.body != null) return true;
  const headers = new Headers(options.headers || {});
  if (['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'x-subscription-token']
    .some(name => headers.has(name))) return true;
  try {
    return [...new URL(url).searchParams.keys()].some(key => {
      const compact = key.toLowerCase().replace(/[-_]/g, '');
      return /(?:^|[-_])(key|token|secret|password|auth|credential)(?:$|[-_])/i.test(key)
        || /^(?:api|access|auth|bearer|client|subscription)?(?:key|token|secret|password|credential)s?$/.test(compact)
        || compact === 'authorization';
    });
  } catch (e) {
    return true;
  }
}

function canUseCorsProxy(url, options, proxyUrl, forceSensitive = false) {
  if (!proxyUrl) return false;
  if (!requestContainsSensitiveData(url, options, forceSensitive)) return true;
  try {
    const host = canonicalHostname(proxyUrl);
    return host !== 'corsproxy.io' && host !== 'api.allorigins.win' && host !== 'r.jina.ai';
  } catch (e) {
    return false;
  }
}

function isNetworkLikeFetchError(err) {
  const msg = String(err?.message || '');
  const lower = msg.toLowerCase();
  return msg === 'Failed to fetch'
    || msg === 'Load failed'
    || msg.includes('NetworkError')
    || lower.includes('network')
    || lower.includes('cors')
    || lower.includes('mixed content');
}

async function fetchApiWithHttpSupport(url, options, baseUrl, forceSensitive = false, proxyOverride = '') {
  const apiBase = String(baseUrl || '').trim();
  const corsProxy = proxyOverride ? normalizeCorsProxyUrl(proxyOverride) : getCorsProxyUrl();
  const proxyAllowed = canUseCorsProxy(url, options, corsProxy, forceSensitive);
  const tryProxyFetch = async () => fetch(corsProxy + encodeURIComponent(url), options);
  const tryDirectFetch = async () => fetch(url, options);

  // For explicit http:// API bases, handle proxy vs direct intelligently.
  if (isHttpApiBase(apiBase)) {
    // Local/private URLs: skip proxy entirely (browsers allow http://localhost from HTTPS pages).
    if (isLocalUrl(apiBase)) {
      try {
        return await tryDirectFetch();
      } catch (directErr) {
        if (isNetworkLikeFetchError(directErr)) {
          throw new Error('Could not connect to local API server. Make sure it is running and accessible at ' + apiBase);
        }
        throw directErr;
      }
    }

    if (!proxyAllowed && window.location.protocol === 'https:') {
      throw new Error('Refusing to send credentials or request data through a public CORS proxy. Use an HTTPS API endpoint or a proxy you control.');
    }

    // Non-local http:// URL: use a trusted proxy, or direct HTTP where allowed.
    try {
      const proxyResp = proxyAllowed ? await tryProxyFetch() : await tryDirectFetch();
      // If proxy returned a proxy-level error (not an upstream API error), try direct.
      if (!proxyResp.ok && [403, 407, 502, 503].includes(proxyResp.status)) {
        const isApiError = await (async () => {
          try { const j = await proxyResp.clone().json(); return j.error || j.message; } catch { return false; }
        })();
        if (!isApiError && window.location.protocol !== 'https:') {
          return await tryDirectFetch();
        }
      }
      return proxyResp;
    } catch (proxyErr) {
      // Network-level proxy failure: try direct if not HTTPS.
      if (window.location.protocol !== 'https:') {
        try {
          return await tryDirectFetch();
        } catch (directErr) {
          if (isNetworkLikeFetchError(directErr)) {
            throw new Error('CORS proxy and direct request both failed. Try a different CORS proxy URL in Settings > Tools, or switch the API endpoint to HTTPS.');
          }
          throw directErr;
        }
      }
      if (isNetworkLikeFetchError(proxyErr)) {
        throw new Error('CORS proxy request failed. This proxy may block your target host or Authorization headers. Try a different CORS proxy URL in Settings > Tools.');
      }
      throw proxyErr;
    }
  }

  try {
    return await fetch(url, options);
  } catch (err) {
    if (!isNetworkLikeFetchError(err) || !proxyAllowed) {
      if (isNetworkLikeFetchError(err) && requestContainsSensitiveData(url, options, forceSensitive)) {
        throw new Error('Direct API request failed. Credentials were not sent through the public CORS proxy; configure CORS on the API or use a proxy you control.');
      }
      throw err;
    }
    try {
      return await tryProxyFetch();
    } catch (proxyErr) {
      if (isNetworkLikeFetchError(proxyErr)) {
        throw new Error('CORS proxy request failed. This proxy may block your target host or Authorization headers. Try a different CORS proxy URL in Settings > Tools.');
      }
      throw proxyErr;
    }
  }
}

// ============================================
// Model Fetching
// ============================================
function buildProviderHeaders(provider, apiKey) {
  if (provider === 'anthropic') {
    return { 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  }
  return apiKey ? { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

function normalizeModelMetadata(data) {
  const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []));
  return list.map(item => {
    if (typeof item === 'string') return { id: item };
    const id = item?.id || item?.name || item?.model;
    if (!id) return null;
    const contextLength = Number(item.context_length ?? item.contextLength ?? item.num_ctx ?? item.context_window);
    return { id: String(id), ...(Number.isFinite(contextLength) && contextLength > 0 ? { context_length: contextLength } : {}) };
  }).filter(Boolean);
}

async function fetchAvailableModelMetadata(baseUrl, apiKey, providerName = inferRequestProvider({ llmProxyUrl: baseUrl }), apiFormat = '') {
  const provider = getProviderPreset(providerName);
  const normalizedBase = String(baseUrl || '').replace(/\/+$/, '');
  const url = providerName === 'ollama' && /\/v1$/i.test(normalizedBase)
    ? normalizedBase.replace(/\/v1$/i, '') + '/api/tags'
    : normalizedBase + '/models';
  try {
    const resp = await fetchApiWithHttpSupport(url, {
      headers: buildProviderHeaders(providerName === 'anthropic' || apiFormat === 'anthropic' ? 'anthropic' : provider.apiFormat, apiKey)
    }, baseUrl);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || 'Model discovery failed.');
    return normalizeModelMetadata(data);
  } catch (error) {
    throw new Error(sanitizeErrorDetail(error, [apiKey]));
  }
}

async function fetchAvailableModels(baseUrl, apiKey, providerName = inferRequestProvider({ llmProxyUrl: baseUrl }), apiFormat = getProviderPreset(providerName).apiFormat) {
  const key = modelCacheKey(baseUrl, providerName, apiFormat);
  const metadata = await fetchAvailableModelMetadata(baseUrl, apiKey, providerName, apiFormat);
  try { localStorage.setItem(key, JSON.stringify(metadata)); } catch (e) {}
  return metadata.map(model => model.id);
}

function populateModelSelect(target, models) {
  const select = document.getElementById(target === 'setup' ? 'setupModelSelect' : 'setModelSelect');
  const currentModel = localStorage.getItem('llmModel') || '';
  select.innerHTML = '<option value="">-- Select a model --</option>';
  models.slice().sort().forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === currentModel) opt.selected = true;
    select.appendChild(opt);
  });
}

const modelDiscoveryRequests = new Map();

async function refreshModels(target, btnEl) {
  const inputs = getConnectionInputs(target);
  const baseUrl = inputs.base.value.trim().replace(/\/(chat\/completions|messages)\/?$/, '');
  const apiKey = inputs.key.value.trim();
  const providerName = inputs.provider?.value || inferRequestProvider({ llmProxyUrl: baseUrl });
  const apiFormat = inputs.format?.value || getProviderPreset(providerName).apiFormat;
  const key = modelCacheKey(baseUrl, providerName, apiFormat);
  if (!baseUrl || (providerRequiresKey({ llmProvider: providerName }) && !apiKey)) { showToast(providerRequiresKey({ llmProvider: providerName }) ? 'Enter Base URL and API Key first.' : 'Enter Base URL first.', 'error'); return; }
  const token = {};
  modelDiscoveryRequests.set(target, token);
  const isCurrent = () => modelDiscoveryRequests.get(target) === token &&
    key === modelCacheKey(inputs.base.value.trim(), inputs.provider?.value || providerName, inputs.format?.value || apiFormat) && inputs.key.value.trim() === apiKey;
  const btn = btnEl || document.activeElement;
  modelDiscoveryRequests.set(btn, token);
  btn.classList.add('spinning');
  btn.disabled = true;
  try {
    const metadata = await fetchAvailableModelMetadata(baseUrl, apiKey, providerName, apiFormat);
    if (!isCurrent()) return;
    if (key === modelCacheKey()) localStorage.setItem(key, JSON.stringify(metadata));
    populateModelSelect(target, metadata.map(model => model.id));
  } catch (e) {
    if (isCurrent()) showToast('Failed to fetch models: ' + sanitizeErrorDetail(e), 'error');
  } finally {
    if (modelDiscoveryRequests.get(btn) === token) {
      btn.classList.remove('spinning');
      btn.disabled = false;
      modelDiscoveryRequests.delete(btn);
    }
  }
}

function loadCachedModels(target) {
  populateModelSelect(target, readCachedModels());
}

// ============================================
// Memory System
// ============================================
function parseEnabledSetting(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  return String(value).trim().toLowerCase() === 'true';
}

function isMemoryEnabled() {
  const enabled = parseEnabledSetting(localStorage.getItem('llmMemoryEnabled'));
  if (!enabled && memoryEnabledState) memoryEpoch++;
  memoryEnabledState = enabled;
  return enabled;
}

function normalizeMemoryEntry(raw, index, seedTimestamp) {
  let text = '';
  let id = '';
  let createdAt = seedTimestamp + index;

  if (typeof raw === 'string') {
    text = raw.trim();
  } else if (raw && typeof raw === 'object') {
    if (typeof raw.text === 'string') text = raw.text.trim();
    else if (typeof raw.content === 'string') text = raw.content.trim();
    if (typeof raw.id === 'string') id = raw.id.trim();
    const rawCreatedAt = Number(raw.createdAt);
    if (Number.isFinite(rawCreatedAt) && rawCreatedAt > 0) createdAt = rawCreatedAt;
  }

  if (!text) return null;
  if (!id) id = 'mem_' + createdAt + '_' + index;
  return { id, text, createdAt };
}

function normalizeMemoryList(rawList) {
  if (!Array.isArray(rawList)) return { memories: [], changed: rawList !== null && rawList !== undefined };

  const seedTimestamp = Date.now();
  const usedIds = new Set();
  const normalized = [];
  let changed = false;

  rawList.forEach((raw, index) => {
    const entry = normalizeMemoryEntry(raw, index, seedTimestamp);
    if (!entry) {
      changed = true;
      return;
    }
    if (usedIds.has(entry.id)) {
      entry.id = entry.id + '_' + index;
      changed = true;
    }
    usedIds.add(entry.id);
    normalized.push(entry);

    const isObject = raw && typeof raw === 'object' && !Array.isArray(raw);
    if (!isObject) {
      changed = true;
      return;
    }
    const rawText = typeof raw.text === 'string' ? raw.text : '';
    const rawId = typeof raw.id === 'string' ? raw.id : '';
    const rawCreatedAt = Number(raw.createdAt);
    if (rawText !== entry.text || rawId !== entry.id || !Number.isFinite(rawCreatedAt) || rawCreatedAt !== entry.createdAt) {
      changed = true;
    }
  });

  if (normalized.length !== rawList.length) changed = true;
  return { memories: normalized, changed };
}

async function loadMemories() {
  if (db) {
    try {
      const idbRaw = await idbGetAll('memories');
      const normalizedIdb = normalizeMemoryList(idbRaw);
      const visible = syncFilterDeletedRecords(normalizedIdb.memories, syncLoadTombstones().memories, 'createdAt');
      if (normalizedIdb.changed || visible.length !== normalizedIdb.memories.length) await saveMemories(visible);
      if (visible.length > 0) return visible;
    } catch(e) {}
  }

  try {
    const legacyRaw = JSON.parse(localStorage.getItem('assistantMemories') || '[]');
    const normalizedLegacy = normalizeMemoryList(legacyRaw);
    const visible = syncFilterDeletedRecords(normalizedLegacy.memories, syncLoadTombstones().memories, 'createdAt');
    if (visible.length > 0 || normalizedLegacy.changed) {
      await saveMemories(visible);
      if (db) localStorage.removeItem('assistantMemories');
    }
    return visible;
  } catch(e) { return []; }
}

async function saveMemories(memories, valid = () => true, removals = []) {
  if (readOnlyShare || !valid()) return;
  const normalized = syncFilterDeletedRecords(normalizeMemoryList(memories).memories, syncLoadTombstones().memories, 'createdAt');
  if (!db) {
    if (removals.length) syncRecordTombstones('memories', removals.map(memory => memory.id), Math.max(Date.now(), ...removals.map(memory => memory.createdAt)));
    localStorage.setItem('assistantMemories', JSON.stringify(syncFilterDeletedRecords(normalized, syncLoadTombstones().memories, 'createdAt')));
    syncScheduleAutoPush();
    return;
  }
  await idbPutAll('memories', normalized, valid, removals);
  syncScheduleAutoPush();
}

async function getMemoryPrompt() {
  if (!isMemoryEnabled()) return '';
  const memories = await loadMemories();
  if (memories.length === 0) return '';
  return 'User memories (facts learned from previous conversations):\n' +
    memories.map(m => '- ' + m.text).join('\n');
}

function inferRequestProvider(settings = {}) {
  const explicit = String(settings.llmProvider || '').trim();
  if (explicit && PROVIDER_PRESETS[explicit]) return explicit;
  const base = String(settings.llmProxyUrl || '').toLowerCase();
  const format = String(settings.llmApiFormat || 'auto').toLowerCase();
  if (base.includes('openrouter')) return 'openrouter';
  if (base.includes('anthropic') || format === 'anthropic') return 'anthropic';
  if (base.includes('11434') || base.includes('ollama')) return 'ollama';
  if (base.includes('1234') || base.includes('lmstudio')) return 'lmstudio';
  if (base.includes('openai.com')) return 'openai';
  return 'custom';
}

function resolveRequestApiFormat(settings, provider, model) {
  const explicit = String(settings.llmApiFormat || 'auto').toLowerCase();
  if (explicit !== 'auto') return explicit === 'anthropic' ? 'anthropic' : 'openai';
  const preset = getProviderPreset(provider);
  if (preset.apiFormat !== 'auto') return preset.apiFormat;
  return /^claude/i.test(model) ? 'anthropic' : 'openai';
}

function buildRequestTarget(settings = {}, options = {}) {
  const rawBase = String(settings.llmProxyUrl || '').trim().replace(/\/(?:chat\/completions|messages)\/?$/i, '');
  const baseUrl = sanitizeStoredUrl(rawBase).replace(/\/+$/, '');
  const model = String(options.model || settings.llmModel || '').trim();
  if (!baseUrl) throw new Error('Set a valid API base URL first.');
  if (!model) throw new Error('Choose a model first.');
  const provider = inferRequestProvider(settings);
  const apiFormat = resolveRequestApiFormat(settings, provider, model);
  const temperature = Number.parseFloat(settings.llmTemperature);
  const maxTokens = Number.parseInt(settings.llmMaxTokens, 10);
  const contextWindow = Number.parseInt(settings.llmContextWindow, 10);
  const cacheKey = modelCacheKey(baseUrl, provider, settings.llmApiFormat || 'auto');
  const discoveredContext = readModelMetadata(cacheKey).find(item => item.id === model)?.context_length;
  let host = baseUrl;
  try { host = new URL(baseUrl).host; } catch (error) {}
  return Object.freeze({
    provider,
    baseUrl,
    host,
    model,
    apiFormat,
    temperature: Number.isFinite(temperature) ? temperature : null,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : discoveredContext || null,
    modelCacheKey: cacheKey,
    corsProxy: normalizeCorsProxyUrl(settings.llmCorsProxy || ''),
    stream: settings.llmStreaming !== 'false',
    prefill: String(settings.llmPrefill || ''),
    thinking: settings.llmThinking === 'true',
    thinkingEffort: String(settings.llmThinkingEffort || ''),
    promptCache: settings.llmPromptCache !== 'false',
    forceSearch: settings.llmForceSearch === 'true',
    extraParams: String(settings.llmExtraParams || ''),
    excludeParams: String(settings.llmExcludeParams || ''),
    profileId: String(options.profileId || ''),
    profileName: String(options.profileName || ''),
    keyRequired: getProviderPreset(provider).keyRequired,
    apiKey: String(options.apiKey || '').trim()
  });
}

function getActiveRequestTarget(model = localStorage.getItem('llmModel') || '') {
  const settings = {};
  ['llmProvider', 'llmProxyUrl', 'llmModel', 'llmApiFormat', 'llmTemperature', 'llmMaxTokens', 'llmContextWindow', 'llmCorsProxy',
    'llmStreaming', 'llmPrefill', 'llmThinking', 'llmThinkingEffort', 'llmPromptCache', 'llmForceSearch', 'llmExtraParams', 'llmExcludeParams']
    .forEach(key => { settings[key] = localStorage.getItem(key) || ''; });
  const profile = getActiveProfile();
  return Object.freeze({
    ...buildRequestTarget(settings, { model, apiKey: getApiKey({ ...settings, llmModel: model }), profileId: profile?.id, profileName: profile?.name }),
    toolSettings: Object.freeze(getToolRequestSettings())
  });
}

function requestAuthoritiesMatch(left, right) {
  return Boolean(left && right && left.baseUrl === right.baseUrl && left.provider === right.provider && left.apiFormat === right.apiFormat);
}

function resolveRequestTargetKey(target, active, suppliedKey = '') {
  const supplied = String(suppliedKey || '').trim();
  if (supplied) return supplied;
  return requestAuthoritiesMatch(target, active) ? String(active.apiKey || '') : '';
}

function getProfileRequestTarget(profile, suppliedKey = '') {
  if (!profile?.settings) throw new Error('This saved profile is incomplete.');
  const target = buildRequestTarget(profile.settings, { profileId: profile.id, profileName: profile.name });
  let active = null;
  try { active = getActiveRequestTarget(); } catch (error) {}
  const apiKey = resolveRequestTargetKey(target, active, suppliedKey);
  if (target.keyRequired && !apiKey) throw new Error('Enter a temporary API key for ' + target.host + '.');
  return Object.freeze({ ...target, apiKey });
}

function getTrustedCorsProxyHost(target) {
  if (!target?.corsProxy || isLocalUrl(target.baseUrl)) return '';
  const endpoint = target.apiFormat === 'anthropic' ? '/messages' : '/chat/completions';
  const options = { method: 'POST', headers: { Authorization: 'Bearer [redacted]' }, body: '{}' };
  if (!canUseCorsProxy(target.baseUrl + endpoint, options, target.corsProxy, true)) return '';
  try { return new URL(target.corsProxy).host; } catch (error) { return ''; }
}

function formatRequestTargetDestination(target) {
  const proxyHost = getTrustedCorsProxyHost(target);
  return 'API: ' + target.host + (proxyHost ? ' · Proxy: ' + proxyHost : '') + ' · ' + target.model;
}

function prepareOpenAiMessages(apiMessages) {
  return (apiMessages || []).map(message => {
    if (!Array.isArray(message.content)) return message;
    if (message.role === 'assistant') {
      const text = message.content.filter(part => part.type === 'text').map(part => part.text || '').join('');
      return { ...message, content: text || '[Generated image]' };
    }
    return {
      ...message,
      content: message.content.map(part => {
        if (part.type === 'image_url' && part.image_url) return { type: 'image_url', image_url: { url: part.image_url.url } };
        if (part.type === 'file') {
          const name = part.file?.name || 'file';
          return typeof part.file?.textContent === 'string'
            ? { type: 'text', text: `--- ${name} ---\n${part.file.textContent}\n--- end ${name} ---` }
            : { type: 'text', text: `[Attached file: ${name}]` };
        }
        return part;
      })
    };
  });
}

async function callApiNonStreaming(messages, options = {}) {
  const target = options.target || getActiveRequestTarget();
  const signal = options.signal === undefined ? abortController?.signal : options.signal;
  signal?.throwIfAborted();
  if (target.keyRequired && !target.apiKey) throw new Error('Enter an API key for ' + target.host + '.');
  const outputTokens = Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0 ? Number(options.maxTokens) : 512;
  let url;
  let headers;
  let body;
  if (target.apiFormat === 'anthropic') {
    url = target.baseUrl + '/messages';
    headers = buildProviderHeaders('anthropic', target.apiKey);
    const prepared = prepareAnthropicMessages(messages);
    body = { model: target.model, system: prepared.system, messages: prepared.messages, max_tokens: outputTokens, stream: false };
  } else {
    url = target.baseUrl + '/chat/completions';
    headers = buildProviderHeaders('openai', target.apiKey);
    body = { model: target.model, messages: prepareOpenAiMessages(messages), stream: false };
    const tokenKey = target.provider === 'openai' && /^(?:o\d|gpt-5)/i.test(target.model) ? 'max_completion_tokens' : 'max_tokens';
    body[tokenKey] = outputTokens;
  }
  if (target.temperature !== null && !NO_SAMPLING_PARAMS_RE.test(target.model)) body.temperature = target.temperature;
  assertProviderRequestFits(body, target);

  const resp = await fetchApiWithHttpSupport(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  }, target.baseUrl, false, target.corsProxy);
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 200); } catch (error) {}
    const error = new Error(sanitizeErrorDetail('API returned ' + resp.status + (detail ? ': ' + detail : ''), [target.apiKey]));
    error.httpStatus = resp.status;
    throw error;
  }
  const data = await resp.json();
  signal?.throwIfAborted();
  if (data.error || data.type === 'error') throw new Error(sanitizeErrorDetail(data.error?.message || 'The provider returned an error.', [target.apiKey]));
  const result = extractImages(target.apiFormat === 'anthropic' ? data : data.choices?.[0]?.message);
  if (!result.text.trim() && !(options.returnMessage && result.images.length)) throw new Error('The provider returned an empty response.');
  return options.returnMessage ? result : result.text;
}

function getTargetContextWindow(target) {
  if (target?.contextWindow) return target.contextWindow;
  return readModelMetadata(target?.modelCacheKey || modelCacheKey(target?.baseUrl, target?.provider, target?.apiFormat))
    .find(item => item.id === target?.model)?.context_length || null;
}

function guardTargetContextLimit(apiMessages, target, maxOutput) {
  const contextWindow = getTargetContextWindow(target);
  if (!contextWindow) return false;
  const promptTokens = (apiMessages || []).reduce((total, message) => total + estimateTokens(JSON.stringify(message)), 0);
  if (promptTokens + maxOutput <= contextWindow) return false;
  showToast(formatModelForDisplay(target.model, 30) + ' needs about ' + formatTokenCount(promptTokens + maxOutput) +
    ' tokens, above its ' + formatTokenCount(contextWindow) + ' token context window.', 'error', 7000);
  return true;
}

function assertProviderRequestFits(body, target) {
  const context = [
    ...(body.system ? [{ role: 'system', content: body.system }] : []),
    ...(body.messages || []),
    ...(body.tools?.length ? [{ role: 'system', content: body.tools }] : [])
  ];
  const output = Number(body.max_completion_tokens || body.max_tokens) || target.maxTokens || 8192;
  if (guardTargetContextLimit(context, target, output)) throw new Error('The assembled request exceeds the model context window.');
}

function insertComposerText(text) {
  const input = document.getElementById('chatInput');
  if (!input) return;
  const value = String(text || '').trim();
  if (!value) return;
  if (input.value.trim()) {
    const start = input.selectionStart;
    const prefix = start > 0 && !/\s$/.test(input.value.slice(0, start)) ? '\n' : '';
    input.setRangeText(prefix + value, start, input.selectionEnd, 'end');
  } else {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

async function completeDraft() {
  if (readOnlyShare || sending || streaming) return;
  const input = document.getElementById('chatInput');
  const conv = getActiveConv();
  if (!input || !conv || !input.value.trim()) {
    showToast('Write part of a message first.', 'info');
    return;
  }
  const snapshot = {
    convId: conv.id,
    value: input.value,
    start: input.selectionStart,
    end: input.selectionEnd
  };
  if (!beginSendingAction()) return;
  const messageList = messages;
  const signal = abortController.signal;
  try {
    const target = getActiveRequestTarget();
    const context = await buildRequestMessages(conv, { messageList: messageList.slice() });
    assertRequestOwner(conv, messageList, null, signal);
    const apiMessages = [
      { role: 'system', content: 'Complete the unfinished user draft at the cursor. Return only the exact text to insert. Do not quote, explain, or repeat text before the cursor.' },
      ...context.messages,
      { role: 'user', content: 'Text before cursor:\n' + snapshot.value.slice(0, snapshot.start) + '\n\nText after cursor:\n' + snapshot.value.slice(snapshot.end) }
    ];
    if (guardTargetContextLimit(apiMessages, target, 128)) return;
    const completion = await callApiNonStreaming(apiMessages, { target, maxTokens: 128, signal });
    assertRequestOwner(conv, messageList, null, signal);
    if (getActiveConv() !== conv || input.value !== snapshot.value ||
        input.selectionStart !== snapshot.start || input.selectionEnd !== snapshot.end) {
      showToast('Draft changed, so the completion was not inserted.', 'info');
      return;
    }
    input.setRangeText(completion, snapshot.start, snapshot.end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    announce('Draft completed. Review it before sending.');
  } catch (error) {
    if (error.name !== 'AbortError') showToast('Could not complete the draft: ' + sanitizeErrorDetail(error), 'error', 6000);
  } finally {
    endSendingAction();
  }
}

function parseFollowUpSuggestions(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end < start) throw new Error('The provider did not return a suggestion list.');
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('The provider did not return a suggestion list.');
  const seen = new Set();
  const suggestions = [];
  parsed.forEach(value => {
    if (typeof value !== 'string') return;
    const suggestion = value.trim().slice(0, 280);
    const key = suggestion.toLocaleLowerCase();
    if (!suggestion || seen.has(key) || suggestions.length >= 3) return;
    seen.add(key);
    suggestions.push(suggestion);
  });
  if (!suggestions.length) throw new Error('The provider returned no usable suggestions.');
  return suggestions;
}

function showFollowUpSuggestions(suggestions, snapshot) {
  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  const popup = document.createElement('div');
  popup.className = 'char-info-popup manual-ai-dialog';
  popup.setAttribute('aria-labelledby', 'followUpSuggestionsTitle');
  const heading = document.createElement('h3');
  heading.id = 'followUpSuggestionsTitle';
  heading.textContent = 'Suggested follow-ups';
  const note = document.createElement('p');
  note.className = 'manual-ai-note';
  note.textContent = 'Choose one to place it in the composer. Nothing is sent automatically.';
  const list = document.createElement('div');
  list.className = 'suggestion-list';
  let close;
  suggestions.forEach(suggestion => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion-btn';
    button.textContent = suggestion;
    button.onclick = () => {
      const source = messages[snapshot.messageIndex];
      if (activeConvId !== snapshot.convId || source !== snapshot.message ||
          source?.swipeIndex !== snapshot.swipeIndex || getMsgText(source) !== snapshot.text) {
        close();
        showToast('The source response changed. Generate suggestions again.', 'info');
        return;
      }
      insertComposerText(suggestion);
      close();
      announce('Suggestion placed in the composer.');
    };
    list.appendChild(button);
  });
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'btn btn-secondary';
  closeButton.textContent = 'Close';
  popup.append(heading, note, list, closeButton);
  close = openTransientDialog(overlay, popup, list.querySelector('button'));
  closeButton.onclick = close;
}

async function suggestFollowUps(messageIndex) {
  if (readOnlyShare || sending || streaming) return;
  const conv = getActiveConv();
  const message = messages[messageIndex];
  const request = getSwipeRequest(message);
  if (!conv || message?.role !== 'assistant' || messageIndex !== messages.length - 1 ||
      !getMsgText(message).trim() || (request && request.status !== 'complete')) return;
  const snapshot = {
    convId: conv.id,
    messageIndex,
    message,
    swipeIndex: message.swipeIndex || 0,
    text: getMsgText(message)
  };
  if (!beginSendingAction()) return;
  const messageList = messages;
  const signal = abortController.signal;
  try {
    const target = getActiveRequestTarget();
    const context = await buildRequestMessages(conv, { messageList: messageList.slice(), untilIndex: messageIndex + 1 });
    assertRequestOwner(conv, messageList, message, signal);
    const apiMessages = [
      { role: 'system', content: 'Suggest exactly three concise messages the user could send next. Return only a JSON array of three strings. Do not include markdown or explanations.' },
      ...context.messages
    ];
    if (guardTargetContextLimit(apiMessages, target, 256)) return;
    const suggestions = parseFollowUpSuggestions(await callApiNonStreaming(apiMessages, { target, maxTokens: 256, signal }));
    assertRequestOwner(conv, messageList, message, signal);
    const source = messages[snapshot.messageIndex];
    if (activeConvId !== snapshot.convId || source !== snapshot.message ||
        source?.swipeIndex !== snapshot.swipeIndex || getMsgText(source) !== snapshot.text) {
      showToast('The response changed, so the suggestions were discarded.', 'info');
      return;
    }
    showFollowUpSuggestions(suggestions, snapshot);
  } catch (error) {
    if (error.name !== 'AbortError') showToast('Could not suggest follow-ups: ' + sanitizeErrorDetail(error), 'error', 6000);
  } finally {
    endSendingAction();
  }
}

function comparisonTargetIdentity(target) {
  return [target?.provider, target?.baseUrl, target?.apiFormat, target?.model].join('\n');
}

function getComparisonTargetChoices() {
  const choices = [];
  const currentModel = localStorage.getItem('llmModel') || '';
  [...new Set([currentModel, ...readCachedModels()].filter(Boolean))].forEach(model => {
    choices.push({ kind: 'model', model, label: model, detail: 'Current provider' });
  });
  loadProfiles().forEach(profile => {
    try {
      const target = buildRequestTarget(profile.settings || {}, { profileId: profile.id, profileName: profile.name });
      choices.push({
        kind: 'profile',
        profile,
        label: profile.name || 'Unnamed profile',
        detail: formatRequestTargetDestination(target)
      });
    } catch (error) {}
  });
  return choices.map((choice, index) => ({ ...choice, id: 'target-' + index }));
}

function createComparisonTargetField(slot, choices, defaultId) {
  const section = document.createElement('fieldset');
  section.className = 'comparison-target';
  const legend = document.createElement('legend');
  legend.textContent = 'Target ' + slot;
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Comparison target ' + slot);
  choices.forEach(choice => {
    const option = document.createElement('option');
    option.value = choice.id;
    option.textContent = choice.label + ' · ' + choice.detail;
    select.appendChild(option);
  });
  const manualOption = document.createElement('option');
  manualOption.value = 'manual';
  manualOption.textContent = 'Other model on current provider';
  select.appendChild(manualOption);
  select.value = defaultId || 'manual';

  const manual = document.createElement('input');
  manual.type = 'text';
  manual.placeholder = 'Model name';
  manual.setAttribute('aria-label', 'Model name for target ' + slot);

  const destination = document.createElement('p');
  destination.className = 'comparison-destination';
  const keyLabel = document.createElement('label');
  keyLabel.className = 'comparison-key';
  const keyText = document.createElement('span');
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyLabel.append(keyText, keyInput);

  const selectedChoice = () => choices.find(choice => choice.id === select.value) || null;
  const previewTarget = () => {
    const choice = selectedChoice();
    if (choice?.kind === 'profile') return buildRequestTarget(choice.profile.settings || {}, { profileId: choice.profile.id, profileName: choice.profile.name });
    const model = choice?.kind === 'model' ? choice.model : manual.value.trim();
    if (!model) throw new Error('Enter a model name.');
    return getActiveRequestTarget(model);
  };
  const update = () => {
    manual.hidden = select.value !== 'manual';
    keyLabel.hidden = true;
    keyInput.required = false;
    try {
      const target = previewTarget();
      destination.textContent = formatRequestTargetDestination(target);
      let active = null;
      try { active = getActiveRequestTarget(); } catch (error) {}
      const crossAuthority = selectedChoice()?.kind === 'profile' && !requestAuthoritiesMatch(target, active);
      const showKey = crossAuthority && (target.keyRequired || target.provider === 'custom');
      keyLabel.hidden = !showKey;
      keyInput.required = showKey && target.keyRequired;
      keyText.textContent = target.keyRequired ? 'Temporary API key' : 'Temporary API key (optional)';
      keyInput.setAttribute('aria-label', keyText.textContent + ' for ' + target.host);
    } catch (error) {
      destination.textContent = manual.hidden ? 'This target is incomplete.' : 'Enter a model name.';
    }
  };
  const resolve = () => {
    const choice = selectedChoice();
    if (choice?.kind === 'profile') return getProfileRequestTarget(choice.profile, keyInput.value);
    const model = choice?.kind === 'model' ? choice.model : manual.value.trim();
    if (!model) throw new Error('Enter a model name for target ' + slot + '.');
    return getActiveRequestTarget(model);
  };
  select.onchange = update;
  manual.oninput = update;
  section.append(legend, select, manual, destination, keyLabel);
  update();
  return { section, select, keyInput, resolve, update };
}

function selectAssistantSwipe(message, swipeIndex) {
  if (!message?.swipes?.length) return;
  const next = Math.max(0, Math.min(message.swipes.length - 1, swipeIndex));
  const conv = getActiveConv();
  if (message.swipeIndex !== next && conv?.messages.includes(message)) invalidateConversationContext(conv, conv.messages.indexOf(message));
  message.swipeIndex = next;
  message.content = message.swipes[next];
  message.images = message.swipeImages?.[next] || [];
  const llm = message.swipeLlms?.[next];
  if (llm) {
    message.llm = llm;
    message.model = llm.model;
    message.apiFormat = llm.apiFormat;
  }
  if (Number.isFinite(message.swipeTokenEstimates?.[next])) message.tokenEstimate = message.swipeTokenEstimates[next];
}

function addAssistantSwipe(message, copyIndex = null) {
  if (!message.swipes?.length) message.swipes = [String(message.content || '')];
  message.swipeImages = message.swipeImages || [];
  if (!message.swipeImages[message.swipeIndex || 0] && message.images?.length) {
    message.swipeImages[message.swipeIndex || 0] = message.images.slice();
  }
  const index = message.swipes.length;
  message.swipes.push(copyIndex === null ? '' : message.swipes[copyIndex]);
  if (copyIndex !== null) {
    ['swipeThinking', 'swipeToolUse', 'swipeImages', 'swipeSources', 'swipeLlms'].forEach(key => {
      if (message[key]?.[copyIndex] !== undefined) message[key][index] = structuredClone(message[key][copyIndex]);
    });
  }
  selectAssistantSwipe(message, index);
  return index;
}

function applyComparisonSettledResults(assistantMsg, targets, settled) {
  const successful = [];
  settled.forEach((result, index) => {
    const request = assistantMsg.swipeRequests[index];
    if (result.status === 'fulfilled') {
      assistantMsg.swipes[index] = String(result.value?.text ?? result.value ?? '').trim();
      (assistantMsg.swipeImages ||= [])[index] = result.value?.images || [];
      finishRequestMetadata(request, 'complete');
      successful.push(index);
    } else {
      const stopped = result.reason?.name === 'AbortError';
      assistantMsg.swipes[index] = '';
      finishRequestMetadata(request, stopped ? 'stopped' : 'failed', result.reason, result.reason?.httpStatus);
    }
    selectAssistantSwipe(assistantMsg, index);
    updateMessageTokenMetadata(assistantMsg, index);
  });
  selectAssistantSwipe(assistantMsg, successful[0] ?? 0);
  return successful;
}

function showComparisonResults(conv, assistantMsg, targets) {
  const messageIndex = messages.indexOf(assistantMsg);
  if (messageIndex < 0 || activeConvId !== conv.id) return;
  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  const popup = document.createElement('div');
  popup.className = 'char-info-popup manual-ai-dialog comparison-results-dialog';
  popup.setAttribute('aria-labelledby', 'comparisonResultsTitle');
  const heading = document.createElement('h3');
  heading.id = 'comparisonResultsTitle';
  heading.textContent = 'Compare responses';
  const note = document.createElement('p');
  note.className = 'manual-ai-note';
  note.textContent = 'The chosen response is used as future conversation context.';
  const grid = document.createElement('div');
  grid.className = 'comparison-results';
  let close;
  targets.forEach((target, index) => {
    const card = document.createElement('section');
    card.className = 'comparison-result';
    const title = document.createElement('h4');
    title.textContent = target.profileName || target.model;
    const meta = document.createElement('small');
    meta.textContent = target.destination;
    const response = document.createElement('pre');
    response.textContent = assistantMsg.swipes[index] || (assistantMsg.swipeImages?.[index]?.length ? 'Image response (shown in chat).' : 'No response.');
    const request = assistantMsg.swipeRequests[index];
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'btn ' + (assistantMsg.swipeIndex === index ? 'btn-primary' : 'btn-secondary');
    use.textContent = assistantMsg.swipeIndex === index ? 'Using this response' : 'Use this response';
    use.disabled = request?.status !== 'complete';
    use.onclick = () => {
      if (activeConvId !== conv.id || messages[messageIndex] !== assistantMsg) {
        close();
        showToast('This comparison is no longer active.', 'info');
        return;
      }
      selectAssistantSwipe(assistantMsg, index);
      conv.updatedAt = Date.now();
      saveConversations();
      renderMessages({ preserveScroll: true });
      close();
      announce('Selected ' + target.model + ' for future context.');
    };
    card.append(title, meta, response, use);
    grid.appendChild(card);
  });
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn btn-secondary';
  done.textContent = 'Close';
  popup.append(heading, note, grid, done);
  close = openTransientDialog(overlay, popup, grid.querySelector('button:not(:disabled)') || done);
  done.onclick = close;
}

async function runModelComparison(selectedTargets) {
  if (readOnlyShare || pendingAttachmentReads > 0 || !beginSendingAction()) return;
  const input = document.getElementById('chatInput');
  const conv = getActiveConv();
  const messageList = messages;
  const originalText = input?.value || '';
  const attachments = cloneDraftAttachments(pendingAttachments);
  const attachmentSnapshot = JSON.stringify(attachments);
  const draftMessage = buildComposerMessage(originalText, attachments);
  if (!input || !conv || !draftMessage) {
    showToast('Write a message or attach a file first.', 'error');
    endSendingAction();
    return;
  }
  const targets = selectedTargets.slice(0, 2);
  const publicTargets = targets.map(target => ({
    model: target.model,
    profileName: target.profileName,
    destination: formatRequestTargetDestination(target)
  }));
  const controller = abortController;
  try {
    const built = await buildRequestMessages(conv, { messageList: messageList.slice(), draftMessage });
    assertRequestOwner(conv, messageList, null, controller.signal);
    if (activeConvId !== conv.id || input.value !== originalText || JSON.stringify(cloneDraftAttachments(pendingAttachments)) !== attachmentSnapshot) {
      showToast('The draft changed, so comparison was cancelled.', 'info');
      return;
    }
    const outputLimits = targets.map(target => target.maxTokens || 8192);
    if (targets.some((target, index) => guardTargetContextLimit(built.messages, target, outputLimits[index]))) return;

    const addedDocs = [];
    if (attachments.length) {
      const docs = conv.docs || (conv.docs = []);
      attachments.forEach(attachment => {
        if (!attachment?.textContent || attachment.binary) return;
        const doc = {
          id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name: attachment.name || 'file',
          text: attachment.textContent.slice(0, 20000),
          createdAt: Date.now()
        };
        docs.push(doc);
        addedDocs.push(doc);
      });
    }
    const userMsg = { ...draftMessage, timestamp: Date.now() };
    updateMessageTokenMetadata(userMsg);
    messageList.push(userMsg);
    delete conv.draft;
    conv.updatedAt = Date.now();
    input.value = '';
    input.style.height = 'auto';
    pendingAttachments = [];
    clearModelOverride();
    renderPreviews();
    try {
      await saveConversationImmediately();
    } catch (error) {
      const index = messageList.indexOf(userMsg);
      if (index !== -1) messageList.splice(index, 1);
      if (addedDocs.length) conv.docs = (conv.docs || []).filter(doc => !addedDocs.includes(doc));
      restoreComposerSnapshot(conv, input, originalText, attachments, '');
      throw new Error('Could not save your message before comparing: ' + sanitizeErrorDetail(error));
    }
    assertRequestOwner(conv, messageList, userMsg, controller.signal);
    if (conv.title === 'New Chat') {
      conv.title = (originalText.trim() || 'Attachment chat').slice(0, 40);
      renderSidebar();
    }

    const promptTokens = built.messages.reduce((total, message) => total + estimateTokens(
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '')
    ), 0);
    const assistantMsg = {
      role: 'assistant',
      comparison: true,
      content: '',
      swipes: ['', ''],
      swipeIndex: 0,
      swipeThinking: ['', ''],
      swipeToolUse: [[], []],
      swipeImages: [[], []],
      swipeSources: [[], []],
      timestamp: Date.now()
    };
    targets.forEach((target, index) => {
      setAssistantLlmMetadata(assistantMsg, index, target.model, target.apiFormat, target);
      createRequestMetadata(assistantMsg, index, {
        target,
        model: target.model,
        apiFormat: target.apiFormat,
        messageCount: built.messages.length,
        promptTokens,
        contextWindow: getTargetContextWindow(target)
      });
    });
    messageList.push(assistantMsg);
    renderMessages();
    streaming = true;
    document.getElementById('sendBtn')?.classList.add('streaming');
    updateSendBtnState();
    const lastBubble = document.querySelector('#messagesArea .msg-wrapper.assistant:last-of-type .msg-bubble');
    if (lastBubble) lastBubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

    const settled = await Promise.allSettled(targets.map((target, index) => callApiNonStreaming(built.messages, {
      target,
      returnMessage: true,
      maxTokens: outputLimits[index],
      signal: controller.signal
    })));
    assertRequestOwner(conv, messageList, assistantMsg, null);
    const successful = applyComparisonSettledResults(assistantMsg, targets, settled);
    if (foregroundAction) foregroundAction.status = successful.length === targets.length ? 'complete' : controller.signal.aborted ? 'stopped' : 'failed';
    conv.updatedAt = Date.now();
    await saveConversationImmediately();
    streaming = false;
    renderMessages({ preserveScroll: true });
    updateTokenInfo();
    if (successful.length) {
      announce('Model comparison complete.');
    } else {
      announce(controller.signal.aborted ? 'Model comparison stopped.' : 'Both comparison requests failed.');
    }
    showComparisonResults(conv, assistantMsg, publicTargets);
  } catch (error) {
    if (foregroundAction) foregroundAction.status = error.name === 'AbortError' ? 'stopped' : error.requestStatus || 'failed';
    if (error.name !== 'AbortError') showToast('Could not compare models: ' + sanitizeErrorDetail(error), 'error', 7000);
  } finally {
    streaming = false;
    document.getElementById('sendBtn')?.classList.remove('streaming');
    endSendingAction();
  }
}

function openCompareModels() {
  if (readOnlyShare || sending || streaming) return;
  if (pendingAttachmentReads > 0) {
    showToast('Wait for attachments to finish reading.', 'info');
    return;
  }
  const input = document.getElementById('chatInput');
  if (!getActiveConv() || (!input?.value.trim() && pendingAttachments.length === 0)) {
    showToast('Write a message or attach a file first.', 'info');
    return;
  }
  const choices = getComparisonTargetChoices();
  const first = createComparisonTargetField('A', choices, choices[0]?.id);
  const second = createComparisonTargetField('B', choices, choices[1]?.id || 'manual');
  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  const popup = document.createElement('form');
  popup.className = 'char-info-popup manual-ai-dialog comparison-dialog';
  popup.setAttribute('aria-labelledby', 'compareModelsTitle');
  const heading = document.createElement('h3');
  heading.id = 'compareModelsTitle';
  heading.textContent = 'Compare models';
  const note = document.createElement('p');
  note.className = 'manual-ai-note';
  note.textContent = 'The same conversation context goes to both destinations. This makes two billable requests. A custom CORS proxy may also receive the context and key when used. Comparison replies do not use tools and do not stream.';
  const targets = document.createElement('div');
  targets.className = 'comparison-targets';
  targets.append(first.section, second.section);
  const error = document.createElement('p');
  error.className = 'manual-ai-error';
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-secondary';
  cancel.textContent = 'Cancel';
  const compare = document.createElement('button');
  compare.type = 'submit';
  compare.className = 'btn btn-primary';
  compare.textContent = 'Compare';
  actions.append(cancel, compare);
  popup.append(heading, note, targets, error, actions);
  let close = openTransientDialog(overlay, popup, first.select);
  cancel.onclick = close;
  popup.onsubmit = event => {
    event.preventDefault();
    error.textContent = '';
    try {
      const selected = [first.resolve(), second.resolve()];
      if (comparisonTargetIdentity(selected[0]) === comparisonTargetIdentity(selected[1])) {
        throw new Error('Choose two different models or providers.');
      }
      first.keyInput.value = '';
      second.keyInput.value = '';
      close();
      runModelComparison(selected);
    } catch (submitError) {
      error.textContent = sanitizeErrorDetail(submitError);
    }
  };
}

async function extractMemories(conversationMessages, conv = getActiveConv(), target = null) {
  if (!conv || !isMemoryEnabled() || isTemporaryConversation(conv) || localDataOperationsInFlight || _syncPullInFlight) return;
  const sourceValid = captureContextSource(conv);
  const epoch = memoryEpoch;
  const valid = () => isMemoryEnabled() && epoch === memoryEpoch && sourceValid() && !localDataOperationsInFlight && !_syncPullInFlight;
  try {
    target = target || getActiveRequestTarget();
    const existing = await loadMemories();
    if (!valid()) return;
    const existingText = existing.map(m => '- ' + m.text).join('\n') || '(none yet)';

    const extractPrompt = [
      { role: 'system', content: `You are a memory extraction system. Given a conversation, identify important facts about the user worth remembering for future conversations (preferences, personal details, projects, interests, opinions).

Current memories:
${existingText}

Respond ONLY with a JSON array of new memory strings to add. If there's nothing new worth remembering, respond with []. Do not repeat existing memories. Keep each memory concise (1 sentence). Maximum 3 new memories per extraction.

Example response: ["User prefers TypeScript over JavaScript", "User is building a music app"]` },
      ...conversationMessages.filter(m => m.role !== 'system').slice(-10)
    ];

    const response = await callApiNonStreaming(extractPrompt, { target, signal: null });
    const newMemories = JSON.parse(response);
    if (Array.isArray(newMemories) && newMemories.length > 0) {
      const memories = await loadMemories();
      if (!valid() || existing.some(old => !memories.some(current => current.id === old.id && current.text === old.text && current.createdAt === old.createdAt))) return;
      newMemories.slice(0, 3).forEach(text => {
        if (typeof text === 'string' && text.trim() && !memories.some(memory => memory.text === text.trim())) {
          memories.push({ id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2,5), text: text.trim(), createdAt: Date.now() });
        }
      });
      await saveMemories(memories, valid);
      if (valid()) cleanupMemories(conv, target, valid);
    }
  } catch(e) { /* Memory is best-effort. */ }
}

let _lastCleanup = 0;
let memoryCleanupRunning = false;
async function cleanupMemories(conv = getActiveConv(), target = null, sourceValid = captureContextSource(conv)) {
  if (!conv || !isMemoryEnabled() || isTemporaryConversation(conv) || memoryCleanupRunning || Date.now() - _lastCleanup < 300000) return;
  const epoch = memoryEpoch;
  const valid = () => isMemoryEnabled() && epoch === memoryEpoch && sourceValid() && !localDataOperationsInFlight && !_syncPullInFlight;
  memoryCleanupRunning = true;
  try {
    target = target || getActiveRequestTarget();
    const memories = await loadMemories();
    if (!valid() || memories.length < 5) return;

    const prompt = [
      { role: 'system', content: `You are a memory cleanup system. Given a list of user memories (each with an ID), identify contradictions and duplicates.

Rules:
- If two memories contradict, keep the NEWER one (higher ID number = newer). Mark the older for removal.
- If two memories say the same thing differently, keep the more specific one. Mark the other for removal.
- If a memory is outdated or superseded, mark it for removal.

Respond ONLY with a JSON object: {"remove": ["id1", "id2"]}
If no changes needed: {"remove": []}` },
      { role: 'user', content: memories.map(m => '[' + m.id + '] ' + m.text).join('\n') }
    ];

    const response = await callApiNonStreaming(prompt, { target, signal: null });
    const result = JSON.parse(response);
    const current = await loadMemories();
    if (!valid() || memories.some(old => !current.some(memory => memory.id === old.id && memory.text === old.text && memory.createdAt === old.createdAt))) return;
    if (Array.isArray(result?.remove) && result.remove.length > 0) {
      const selected = memories.filter(memory => result.remove.includes(memory.id));
      const removed = new Set(selected.map(memory => memory.id));
      const cleaned = current.filter(m => !removed.has(m.id));
      await saveMemories(cleaned, valid, selected);
    }
    _lastCleanup = Date.now();
  } catch(e) { /* silent fail */ }
  finally { memoryCleanupRunning = false; }
}

function openManageMemories() {
  document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';

  const popup = document.createElement('div');
  popup.className = 'char-info-popup';
  popup.setAttribute('aria-labelledby', 'memoriesDialogTitle');

  const close = openTransientDialog(overlay, popup);

  async function renderMemoryList() {
    const memories = await loadMemories();
    let html = '<h3 id="memoriesDialogTitle">Memories (' + memories.length + ')</h3>';
    if (memories.length === 0) {
      html += '<div style="color:var(--text-secondary);font-size:0.85em;margin-bottom:12px">No memories saved yet. The AI will automatically remember facts about you as you chat.</div>';
    } else {
      html += '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">';
      memories.forEach(m => {
        html += '<div style="display:flex;align-items:center;gap:8px;font-size:0.85em;background:var(--hover);padding:8px 10px;border-radius:8px">' +
          '<span style="flex:1;color:var(--text-secondary)">' + m.text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</span>' +
          '<button data-memory-id="' + m.id.replace(/"/g, '&quot;') + '" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:14px;flex-shrink:0;padding:2px 4px" title="Delete">✕</button>' +
          '</div>';
      });
      html += '</div>';
      html += '<button class="btn btn-secondary" style="width:100%;margin-bottom:8px;padding:8px;font-size:0.8em" onclick="clearAllMemories()">Clear All</button>';
    }
    html += '<button class="btn btn-primary" type="button" data-close-memories style="width:100%;padding:8px">Close</button>';
    popup.innerHTML = html;
    popup.querySelectorAll('[data-memory-id]').forEach(btn => {
      btn.addEventListener('click', () => deleteMemory(btn.dataset.memoryId));
    });
    popup.querySelector('[data-close-memories]').onclick = close;
  }

  renderMemoryList();
}

function openSearchTest() {
  document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';

  const popup = document.createElement('div');
  popup.className = 'char-info-popup';

  popup.innerHTML =
    '<h3 id="searchTestTitle">Search Test</h3>' +
    '<div style="color:var(--text-secondary);font-size:0.85em;margin-bottom:12px">Runs a live query using your Search API settings.</div>' +
    '<input type="text" id="searchTestInput" aria-label="Search query" placeholder="Search query..." style="width:100%;padding:10px;font-family:inherit;font-size:0.9em;background:var(--hover);border:1px solid var(--card-border);border-radius:8px;color:var(--text-primary);outline:none">' +
    '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="btn btn-primary" id="searchTestRun" style="flex:1;padding:8px">Run</button>' +
      '<button class="btn btn-secondary" id="searchTestClose" style="flex:1;padding:8px">Close</button>' +
    '</div>' +
    '<div id="searchTestStatus" style="margin-top:12px;font-size:0.85em;color:var(--text-secondary)"></div>' +
    '<div id="searchTestResults" style="margin-top:8px;display:flex;flex-direction:column;gap:8px"></div>';

  const input = popup.querySelector('#searchTestInput');
  const runBtn = popup.querySelector('#searchTestRun');
  const closeBtn = popup.querySelector('#searchTestClose');
  const statusEl = popup.querySelector('#searchTestStatus');
  const resultsEl = popup.querySelector('#searchTestResults');
  popup.setAttribute('aria-labelledby', 'searchTestTitle');
  const close = openTransientDialog(overlay, popup, input);
  let controller = null;
  closeBtn.onclick = () => { controller?.abort(); close(); };

  const esc = (s) => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const renderResults = (results) => {
    if (!results.length) {
      resultsEl.innerHTML = '<div style="color:var(--text-secondary);font-size:0.85em">No results found.</div>';
      return;
    }
    resultsEl.innerHTML = results.map(r => {
      const title = esc(r.title || r.url || 'Result');
      const safeUrl = safeHttpUrl(r.url);
      const snippet = esc(r.snippet || '');
      const displayUrl = esc((r.url || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''));
      return '<div style="padding:10px;border:1px solid var(--card-border);border-radius:10px;background:var(--hover)">' +
        (safeUrl ? '<a href="' + esc(safeUrl) + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-weight:600">' + title + '</a>' : '<span style="font-weight:600">' + title + '</span>') +
        (displayUrl ? '<div style="color:var(--text-secondary);font-size:0.75em;margin-top:4px">' + displayUrl + '</div>' : '') +
        (snippet ? '<div style="color:var(--text-secondary);font-size:0.85em;margin-top:6px">' + snippet + '</div>' : '') +
      '</div>';
    }).join('');
  };

  const runSearch = async () => {
    if (controller) { controller.abort(); return; }
    const q = input.value.trim();
    if (!q) { statusEl.textContent = 'Enter a query to test.'; resultsEl.innerHTML = ''; return; }
    if (!beginSendingAction()) return;
    controller = abortController;
    const conv = getActiveConv();
    const messageList = messages;
    const authorization = { confirmed: null, policy: getToolPolicy(conv), settings: getToolRequestSettings() };
    statusEl.textContent = 'Searching...';
    resultsEl.innerHTML = '';
    runBtn.textContent = 'Stop';
    try {
      if (!authorization.policy.webSearch) throw new Error('Web search is disabled for this conversation.');
      const { results, error } = await executeAuthorizedTool('web_search', { query: q }, conv, controller.signal, authorization);
      assertRequestOwner(conv, messageList, null, controller.signal);
      if (error) {
        statusEl.textContent = 'Error: ' + error;
      } else {
        statusEl.textContent = 'Found ' + results.length + ' result' + (results.length === 1 ? '' : 's') + '.';
      }
      renderResults(results);
    } catch (e) {
      statusEl.textContent = e.name === 'AbortError' ? 'Search stopped.' : 'Error: ' + sanitizeErrorDetail(e);
    } finally {
      controller = null;
      runBtn.textContent = 'Run';
      endSendingAction();
    }
  };

  runBtn.onclick = runSearch;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });

}

function openSourcesDrawer(msg) {
  contextSourceMessage = msg || null;
  renderContextSources(contextSourceMessage);
  openContextSection('sourcesSection');
}

function renderContextSources(msg = contextSourceMessage) {
  const body = document.getElementById('contextSourcesBody');
  const status = document.getElementById('sourcesStatus');
  if (!body) return;
  if (!msg) {
    msg = [...messages].reverse().find(message => message.role === 'assistant' && (
      message.swipeSources?.[message.swipeIndex || 0]?.length || message.swipeToolUse?.[message.swipeIndex || 0]?.length
    ));
  }
  contextSourceMessage = msg || null;
  const swipeIdx = msg?.swipeIndex || 0;
  const persisted = msg?.swipeSources?.[swipeIdx] || [];
  const sources = persisted.length ? persisted : (msg?.swipeToolUse?.[swipeIdx] || []).flatMap(block => {
    if (block.type === 'url_fetch' && (block.url || block.content || block.error)) {
      return [{ number: 0, title: block.url || 'Fetched page', url: block.url || '', snippet: block.error || String(block.content || '').slice(0, 500) }];
    }
    return (block.results || []).filter(result => result.url).map(result => ({
      number: result.sourceNumber || 0,
      title: result.title || result.url,
      url: result.url,
      snippet: result.snippet || ''
    }));
  });
  body.replaceChildren();
  if (!sources.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No sources for this chat yet.';
    body.appendChild(empty);
  } else {
    sources.forEach((source, index) => {
      const item = document.createElement('div');
      item.className = 'source-drawer-item';
      const number = document.createElement('span');
      number.className = 'source-number';
      number.textContent = '[' + Number(source.number || index + 1) + ']';
      item.appendChild(number);
      const safeUrl = safeHttpUrl(source.url);
      const title = document.createElement(safeUrl ? 'a' : 'span');
      title.textContent = source.title || source.url || 'Source';
      if (safeUrl) {
        title.href = safeUrl;
        title.target = '_blank';
        title.rel = 'noopener';
      }
      item.appendChild(title);
      if (source.snippet) {
        const snippet = document.createElement('div');
        snippet.className = 'source-snippet';
        snippet.textContent = source.snippet;
        item.appendChild(snippet);
      }
      body.appendChild(item);
    });
  }
  if (status) status.textContent = sources.length ? String(sources.length) : 'None';
}

function buildSnippet(text, idx, windowSize = 90) {
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(text.length, idx + windowSize);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).trim() + suffix;
}

function searchLocalDocs(query, conv) {
  // Project files come first so both callers (the file-search popup and /files) see
  // them without either needing to know projects exist.
  const projectDocs = isTemporaryConversation(conv) ? [] : ((getProject(conv && conv.projectId) || {}).docs || []);
  const docs = projectDocs.concat((conv && conv.docs) || []);
  if (!query || !docs.length) return [];
  const q = query.toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const results = [];
  docs.forEach(doc => {
    const text = (doc.text || '');
    const hay = text.toLowerCase();
    let score = 0;
    let firstIdx = -1;
    terms.forEach(t => {
      const idx = hay.indexOf(t);
      if (idx !== -1) {
        score += 1;
        if (firstIdx === -1 || idx < firstIdx) firstIdx = idx;
      }
    });
    if (score > 0 && firstIdx !== -1) {
      results.push({
        id: doc.id,
        name: doc.name || 'Document',
        snippet: buildSnippet(text, firstIdx),
        score
      });
    }
  });
  return results.sort((a, b) => b.score - a.score).slice(0, 20);
}

function openFileSearch() {
  document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove());
  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  const popup = document.createElement('div');
  popup.className = 'char-info-popup';

  popup.innerHTML =
    '<h3 id="fileSearchTitle">Search Files</h3>' +
    '<div style="color:var(--text-secondary);font-size:0.85em;margin-bottom:12px">Searches text from files you attached in this conversation.</div>' +
    '<input type="text" id="fileSearchInput" aria-label="Search files" placeholder="Search files..." style="width:100%;padding:10px;font-family:inherit;font-size:0.9em;background:var(--hover);border:1px solid var(--card-border);border-radius:8px;color:var(--text-primary);outline:none">' +
    '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="btn btn-primary" id="fileSearchRun" style="flex:1;padding:8px">Search</button>' +
      '<button class="btn btn-secondary" id="fileSearchClose" style="flex:1;padding:8px">Close</button>' +
    '</div>' +
    '<div id="fileSearchStatus" style="margin-top:12px;font-size:0.85em;color:var(--text-secondary)"></div>' +
    '<div id="fileSearchResults" style="margin-top:8px;display:flex;flex-direction:column;gap:8px"></div>';

  const input = popup.querySelector('#fileSearchInput');
  const runBtn = popup.querySelector('#fileSearchRun');
  const closeBtn = popup.querySelector('#fileSearchClose');
  const statusEl = popup.querySelector('#fileSearchStatus');
  const resultsEl = popup.querySelector('#fileSearchResults');
  popup.setAttribute('aria-labelledby', 'fileSearchTitle');
  const close = openTransientDialog(overlay, popup, input);

  closeBtn.onclick = close;

  const renderResults = (results) => {
    if (!results.length) {
      resultsEl.innerHTML = '<div style="color:var(--text-secondary);font-size:0.85em">No matches found.</div>';
      return;
    }
    resultsEl.innerHTML = results.map(r => {
      return '<div style="padding:10px;border:1px solid var(--card-border);border-radius:10px;background:var(--hover)">' +
        '<div style="font-weight:600;color:var(--text-primary)">' + escapeHTML(r.name) + '</div>' +
        '<div style="color:var(--text-secondary);font-size:0.85em;margin-top:6px">' + escapeHTML(r.snippet) + '</div>' +
      '</div>';
    }).join('');
  };

  const runSearch = () => {
    const q = input.value.trim();
    if (!q) { statusEl.textContent = 'Enter a query to search.'; resultsEl.innerHTML = ''; return; }
    const conv = getActiveConv();
    const results = searchLocalDocs(q, conv);
    statusEl.textContent = results.length ? ('Found ' + results.length + ' match' + (results.length === 1 ? '' : 'es') + '.') : 'No matches found.';
    renderResults(results);
  };

  runBtn.onclick = runSearch;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
}

function openSummaryModal() {
  renderContextPanel();
  openContextSection('summarySection');
}

function captureContextSource(conv, checkSummary = false) {
  const list = conv?.messages;
  const length = list?.length || 0;
  const revision = contextRevisions.get(conv);
  const content = () => JSON.stringify(list?.slice(0, length).map(message => [
    message.role, message.content, message.includeInContext !== false, message.autoCompacted === true,
    message.swipeIndex || 0, getSwipeRequest(message)?.status, message.images
  ]));
  const summary = () => JSON.stringify([conv?.summary, conv?.summaryUpdatedAt, conv?.summaryCoverage, contextDrafts.get(conv)?.summary]);
  const before = content();
  const previousSummary = summary();
  return () => Boolean(conv && conversations.includes(conv) && conv.messages === list &&
    contextRevisions.get(conv) === revision && content() === before && (!checkSummary || summary() === previousSummary));
}

function invalidateConversationContext(conv, fromIndex = 0) {
  if (!conv) return;
  contextRevisions.set(conv, (contextRevisions.get(conv) || 0) + 1);
  const coverage = conv.summaryCoverage;
  if (conv.summary && coverage?.version === 1 && Number.isInteger(coverage.through) && coverage.through >= 0 && coverage.through <= fromIndex) return;
  // Legacy summaries have no coverage: discard on any earlier-history change, but
  // never guess which legacy exclusions were automatic. Only marked turns return.
  conv.summary = '';
  conv.summaryUpdatedAt = null;
  delete conv.summaryCoverage;
  conv.messages.forEach(message => {
    if (message.autoCompacted === true) {
      message.includeInContext = true;
      delete message.autoCompacted;
    }
  });
}

function summaryCoverageThrough(conv, selected) {
  // A retained legacy note remains unbounded; do not invent coverage for it.
  if (conv.summary && (conv.summaryCoverage?.version !== 1 || !Number.isInteger(conv.summaryCoverage.through))) return null;
  return { version: 1, through: Math.max(conv.summaryCoverage?.through || 0, ...selected.map(item => item.index + 1), 0) };
}

function saveConversationSummary() {
  const conv = getActiveConv();
  const input = document.getElementById('summaryText');
  if (!conv || !input || readOnlyShare) return;
  const next = input.value.trim();
  if (!next) invalidateConversationContext(conv);
  else conv.summaryCoverage = { version: 1, through: conv.messages.length };
  conv.summary = next;
  delete (contextDrafts.get(conv) || {}).summary;
  contextRevisions.set(conv, (contextRevisions.get(conv) || 0) + 1);
  conv.summaryUpdatedAt = Date.now();
  conv.updatedAt = conv.summaryUpdatedAt;
  saveConversations();
  if (streaming) renderContextPanel();
  else renderMessages({ preserveScroll: true });
  updateTokenInfo();
  showToast('Summary saved.', 'success');
}

function clearConversationSummary() {
  const conv = getActiveConv();
  if (!conv || readOnlyShare) return;
  invalidateConversationContext(conv);
  delete (contextDrafts.get(conv) || {}).summary;
  conv.updatedAt = Date.now();
  saveConversations();
  if (streaming) renderContextPanel();
  else renderMessages({ preserveScroll: true });
  updateTokenInfo();
  showToast('Summary cleared.', 'info');
}

async function generateConversationSummary() {
  const conv = getActiveConv();
  if (!conv || readOnlyShare || summaryJobs.has(conv.id)) return;
  const jobId = conv.id;
  if (contextDrafts.get(conv)?.summary !== undefined) { showToast('Save or discard your summary draft first.', 'info'); return; }
  const valid = captureContextSource(conv, true);
  const selected = filterRequestHistory(conv.messages).included.slice(-40);
  const coverage = summaryCoverageThrough(conv, selected);
  summaryJobs.add(jobId);
  renderContextPanel();
  try {
    const target = getActiveRequestTarget();
    const summary = await callApiNonStreaming([
      { role: 'system', content: 'Summarize the conversation into a concise, structured note the assistant can use for context. Retain the facts, preferences, decisions and open tasks from the prior summary as well as these turns. Do not invent details. Aim for 200 words without losing prior knowledge.' },
      { role: 'user', content: (conv.summary ? 'Prior summary:\n' + conv.summary + '\n\n' : '') + buildConversationTranscript(40, selected.map(item => item.message)) }
    ], { target, signal: null });
    if (!valid()) return;
    const cleaned = (summary || '').trim();
    if (!cleaned) throw new Error('The provider returned an empty summary.');
    conv.summary = cleaned;
    conv.summaryCoverage = coverage;
    conv.summaryUpdatedAt = Date.now();
    conv.updatedAt = conv.summaryUpdatedAt;
    await saveConversations();
    if (getActiveConv() === conv) { renderContextPanel(); updateTokenInfo(); }
    showToast('Summary updated.', 'success');
  } catch (e) {
    showToast('Summary failed: ' + sanitizeErrorDetail(e), 'error');
  } finally {
    summaryJobs.delete(jobId);
    renderContextPanel();
  }
}

function openStatusPanel() {
  document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  const popup = document.createElement('div');
  popup.className = 'char-info-popup';
  popup.setAttribute('aria-labelledby', 'statusDialogTitle');

  const close = openTransientDialog(overlay, popup);
  let controller = null;

  const render = () => {
    const baseUrl = localStorage.getItem('llmProxyUrl') || '(not set)';
    const model = localStorage.getItem('llmModel') || '(not set)';
    const searchUrl = localStorage.getItem('llmSearchApiUrl') || 'https://purasearx.duckdns.org/search?format=json (default)';
    const searchOn = localStorage.getItem('llmWebSearch') === 'true' ? 'Enabled' : 'Disabled';
    const last = lastSearchStatus;
    const lastText = last.ok == null ? 'No searches yet.' : (last.ok ? 'OK' : 'Error: ' + last.error);
    const lastTime = last.at ? formatRelativeTime(last.at) : '';

    popup.innerHTML =
      '<h3 id="statusDialogTitle">Status / Diagnostics</h3>' +
      '<div style="display:flex;flex-direction:column;gap:6px;font-size:0.85em;color:var(--text-secondary)">' +
        '<div><strong style="color:var(--text-primary)">LLM Base URL:</strong> ' + escapeHTML(baseUrl) + '</div>' +
        '<div><strong style="color:var(--text-primary)">Model:</strong> ' + escapeHTML(model) + '</div>' +
        '<div><strong style="color:var(--text-primary)">Web Search:</strong> ' + searchOn + '</div>' +
        '<div><strong style="color:var(--text-primary)">Search API URL:</strong> ' + escapeHTML(searchUrl) + '</div>' +
        '<div><strong style="color:var(--text-primary)">Last Search:</strong> ' + escapeHTML(lastText) + (lastTime ? ' · ' + lastTime : '') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<button class="btn btn-primary" id="statusTestBtn" style="flex:1;padding:8px">Test Search</button>' +
        '<button class="btn btn-secondary" id="statusCloseBtn" style="flex:1;padding:8px">Close</button>' +
      '</div>';

    const closeBtn = popup.querySelector('#statusCloseBtn');
    const testBtn = popup.querySelector('#statusTestBtn');
    closeBtn.onclick = () => { controller?.abort(); close(); };
    testBtn.onclick = async () => {
      if (controller) { controller.abort(); return; }
      if (!beginSendingAction()) return;
      controller = abortController;
      const conv = getActiveConv();
      const messageList = messages;
      const authorization = { confirmed: null, policy: getToolPolicy(conv), settings: getToolRequestSettings() };
      testBtn.textContent = 'Stop';
      try {
        if (!authorization.policy.webSearch) throw new Error('Web search is disabled for this conversation.');
        const result = await executeAuthorizedTool('web_search', { query: 'test' }, conv, controller.signal, authorization);
        assertRequestOwner(conv, messageList, null, controller.signal);
        if (result.error) throw new Error(result.error);
      } catch(e) {
        lastSearchStatus = { ok: false, error: sanitizeErrorDetail(e), at: Date.now(), query: 'test' };
      } finally {
        controller = null;
        endSendingAction();
        if (popup.isConnected) render();
      }
    };
  };

  render();
}

function parseCommand(text) {
  const match = text.trim().match(/^\/([\w-]+)(?:\s+(.+))?$/i);
  if (!match) return null;
  const token = match[1].toLowerCase();
  const definition = COMMAND_REGISTRY.find(command => command.name === token || command.aliases.includes(token));
  if (!definition) return null;
  return { cmd: definition.name, query: (match[2] || '').trim(), definition };
}

function closeCommandDropdown() {
  const dropdown = document.getElementById('commandDropdown');
  if (dropdown) dropdown.classList.remove('open');
  document.getElementById('chatInput')?.setAttribute('aria-expanded', 'false');
  commandActive = false;
  commandIdx = 0;
}

function renderCommandMenu(ta, query = '') {
  const dropdown = document.getElementById('commandDropdown');
  if (!dropdown) return;
  const token = query.toLowerCase();
  const commands = COMMAND_REGISTRY.filter(command => [command.name, ...command.aliases].some(name => name.includes(token)));
  dropdown.innerHTML = '';
  commands.forEach((command, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'command-item' + (index === 0 ? ' active' : '');
    item.setAttribute('role', 'menuitem');
    item.dataset.command = command.name;
    item.innerHTML = '<strong></strong><span></span><small></small>';
    item.querySelector('strong').textContent = '/' + command.name;
    item.querySelector('span').textContent = command.description;
    item.querySelector('small').textContent = command.usage + (command.aliases.length ? ' · aliases: ' + command.aliases.join(', ') : '');
    item.onclick = () => {
      ta.value = '/' + command.name + (command.requiresQuery ? ' ' : '');
      ta.focus();
      closeCommandDropdown();
      persistDraftFromUI();
    };
    dropdown.appendChild(item);
  });
  commandIdx = 0;
  commandActive = commands.length > 0;
  dropdown.classList.toggle('open', commandActive);
  ta.setAttribute('aria-expanded', String(commandActive));
}

function handleCommandInput(ta) {
  const before = ta.value.slice(0, ta.selectionStart);
  const match = before.match(/^\/([\w-]*)$/);
  if (!match) { closeCommandDropdown(); return; }
  renderCommandMenu(ta, match[1]);
}

function handleCommandKeydown(event, ta) {
  const dropdown = document.getElementById('commandDropdown');
  const items = dropdown?.querySelectorAll('.command-item') || [];
  if (!commandActive || !items.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    items[commandIdx]?.classList.remove('active');
    commandIdx = (commandIdx + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[commandIdx]?.classList.add('active');
    return;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    items[commandIdx]?.click();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeCommandDropdown();
  }
}

async function handleCommand(cmd, conv) {
  if (!cmd) return;
  if (cmd.cmd === 'search') {
    await handleManualSearch(cmd.query, conv);
  } else if (cmd.cmd === 'files') {
    await handleFileSearch(cmd.query, conv);
  } else if (cmd.cmd === 'goal') {
    updateConversationGoal(cmd.query, true);
    openContextSection('goalSection');
  } else if (cmd.cmd === 'context') {
    await openContextPreview();
  } else if (cmd.cmd === 'summary') {
    openSummaryModal();
  } else if (cmd.cmd === 'tools') {
    toggleComposerTools();
  } else if (cmd.cmd === 'settings') {
    openSettings();
  } else if (cmd.cmd === 'projects') {
    openProjectsModal();
  }
}

async function handleManualSearch(query, conv = getActiveConv()) {
  if (readOnlyShare || streaming) return;
  const ownsAction = !sending;
  if (ownsAction && !beginSendingAction()) return;
  const action = foregroundAction;
  const messageList = action.messageList;
  const signal = action.controller.signal;
  const authorization = { confirmed: null, policy: getToolPolicy(conv), settings: getToolRequestSettings() };
  if (conv !== action.conv) { if (ownsAction) endSendingAction(); return; }
  const ts = Date.now();
  messageList.push({ role: 'user', content: '/search ' + query, timestamp: ts });
  const assistantMsg = {
    role: 'assistant',
    content: '',
    swipes: [''],
    swipeIndex: 0,
    timestamp: Date.now(),
    swipeToolUse: [[{ query, results: [], searching: true }]]
  };
  messageList.push(assistantMsg);
  const request = createRequestMetadata(assistantMsg, 0);
  request.status = 'streaming';
  renderMessages();

  try {
    await saveConversationImmediately();
    assertRequestOwner(conv, messageList, assistantMsg, signal);
    streaming = true;
    updateSendBtnState();
    const response = await executeAuthorizedTool('web_search', { query }, conv, signal, authorization);
    assertRequestOwner(conv, messageList, assistantMsg, signal);
    const { results, error } = response;
    const tb = assistantMsg.swipeToolUse[0][0];
    tb.results = results;
    tb.searching = false;
    if (error) tb.error = error;
    assistantMsg.content = error ? '' : ('Search results for "' + query + '".');
    assistantMsg.swipes[0] = assistantMsg.content;
    const registry = sourceRegistryFor(assistantMsg, 0);
    registerSources(registry, results).forEach((result, index) => { results[index].sourceNumber = result.sourceNumber; });
    persistSwipeSources(assistantMsg, 0, registry);
    finishRequestMetadata(request, error ? 'failed' : 'complete', error || '', null);
  } catch (e) {
    const tb = assistantMsg.swipeToolUse[0][0];
    tb.searching = false;
    tb.error = sanitizeErrorDetail(e);
    finishRequestMetadata(request, e.name === 'AbortError' ? 'stopped' : e.requestStatus || 'failed', e, null);
  } finally {
    action.status = request.status;
    streaming = false;
    if (getActiveConv() === conv && messages === messageList) {
      conv.updatedAt = Date.now();
      debouncedSave();
      renderMessages({ preserveScroll: true });
      updateTokenInfo();
    }
    if (ownsAction) endSendingAction();
  }
  return request.status;
}

async function handleFileSearch(query, conv) {
  const ts = Date.now();
  messages.push({ role: 'user', content: '/files ' + query, timestamp: ts });
  const results = searchLocalDocs(query, conv);
  const toolResults = results.map(r => ({ title: r.name, url: '', snippet: r.snippet }));
  const assistantMsg = {
    role: 'assistant',
    content: results.length ? ('Found ' + results.length + ' matching file snippet' + (results.length === 1 ? '' : 's') + '.') : 'No matching file snippets found.',
    swipes: [''],
    swipeIndex: 0,
    timestamp: Date.now(),
    swipeToolUse: [[{ query, results: toolResults, searching: false }]]
  };
  assistantMsg.swipes[0] = assistantMsg.content;
  assistantMsg.swipeRequests = [{ status: 'complete', startedAt: ts, completedAt: Date.now(), durationMs: Math.max(0, Date.now() - ts), httpStatus: null, error: '' }];
  messages.push(assistantMsg);
  if (conv) conv.updatedAt = Date.now();
  debouncedSave();
  renderMessages({ preserveScroll: true });
  updateTokenInfo();
}

function buildConversationTranscript(limit = 40, sourceMessages = messages) {
  const slice = (Array.isArray(sourceMessages) ? sourceMessages : []).filter(m => m.role !== 'system');
  const recent = slice.slice(Math.max(0, slice.length - limit));
  return recent.map(m => (m.role === 'assistant' ? 'Assistant: ' : 'User: ') + getMsgText(m)).join('\n');
}

async function deleteMemory(id) {
  if (!beginLocalDataOperation()) return;
  try {
  const existing = await loadMemories();
  if (existing.some(memory => memory.id === id)) syncRecordTombstones('memories', [id]);
  await saveMemories(existing.filter(memory => memory.id !== id));
  openManageMemories();
  } finally {
    endLocalDataOperation();
  }
}

async function clearAllMemories() {
  if (!confirm('Clear all memories?')) return;
  if (!beginLocalDataOperation()) return;
  try {
  const existing = await loadMemories();
  syncRecordTombstones('memories', existing.map(memory => memory.id));
  await saveMemories([]);
  openManageMemories();
  } finally {
    endLocalDataOperation();
  }
}

// ============================================
// API Format Detection
// ============================================
function detectApiFormat(model) {
  const fmt = localStorage.getItem('llmApiFormat') || 'auto';
  if (fmt !== 'auto') return fmt;
  if (/^claude/i.test(model)) return 'anthropic';
  return 'openai';
}

function getLlmProviderInfo(model = '', format = detectApiFormat(model), baseUrl = localStorage.getItem('llmProxyUrl') || '') {
  const modelText = String(model || '').toLowerCase();
  const baseText = String(baseUrl || '').toLowerCase();
  const explicitProvider = localStorage.getItem('llmProvider') || '';
  const explicitLabels = { openai: ['O', 'OpenAI'], anthropic: ['C', 'Anthropic'], openrouter: ['R', 'OpenRouter'], ollama: ['L', 'Ollama'], lmstudio: ['L', 'LM Studio'] };
  if (explicitLabels[explicitProvider]) return { symbol: explicitLabels[explicitProvider][0], name: explicitLabels[explicitProvider][1] };
  const localHost = /(^|\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/.test(baseText) ||
    /ollama|lmstudio|kobold|text-generation-webui/.test(baseText);

  const rules = [
    { test: /claude|anthropic/, symbol: 'C', name: 'Claude' },
    { test: /gpt-|chatgpt|^o[0-9]|openai/, symbol: 'O', name: 'OpenAI' },
    { test: /gemini|palm/, symbol: 'G', name: 'Gemini' },
    { test: /grok|x-ai/, symbol: 'X', name: 'xAI' },
    { test: /command-r|cohere/, symbol: 'H', name: 'Cohere' },
    { test: /mistral|mixtral/, symbol: 'M', name: 'Mistral' },
    { test: /deepseek/, symbol: 'D', name: 'DeepSeek' },
    { test: /qwen/, symbol: 'Q', name: 'Qwen' },
    { test: /llama|yi-|phi-|gemma|nous|hermes/, symbol: 'L', name: 'Local / open model' }
  ];

  for (const rule of rules) {
    if (rule.test.test(modelText)) return { symbol: rule.symbol, name: rule.name };
  }
  if (localHost) return { symbol: 'L', name: 'Local' };
  if (baseText.includes('openrouter')) return { symbol: 'R', name: 'OpenRouter' };
  if (format === 'anthropic') return { symbol: 'C', name: 'Claude' };
  if (baseText.includes('generativelanguage.googleapis.com')) return { symbol: 'G', name: 'Gemini' };
  return { symbol: 'O', name: 'OpenAI-compatible' };
}

function formatModelForDisplay(model, limit = 34) {
  const value = String(model || '').trim() || 'default model';
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - 3)) + '...';
}

function getActiveProfile() {
  const id = localStorage.getItem('assistantActiveProfileId') || '';
  if (!id) return null;
  return loadProfiles().find(profile => profile.id === id) || null;
}

function getActiveProfileSummary() {
  const profile = getActiveProfile();
  if (!profile) return null;
  const settings = profile.settings || {};
  return {
    name: profile.name,
    model: settings.llmModel || '',
    apiFormat: settings.llmApiFormat || 'auto',
    provider: getConnectionSummary(settings).provider
  };
}

function getConnectionSummary(settings = {}) {
  const model = settings.llmModel || localStorage.getItem('llmModel') || '';
  const format = settings.llmApiFormat || localStorage.getItem('llmApiFormat') || 'auto';
  const baseUrl = settings.llmProxyUrl || localStorage.getItem('llmProxyUrl') || '';
  const providerKey = settings.llmProvider || inferProviderKey(settings);
  const presetSymbols = { openai: 'O', anthropic: 'C', openrouter: 'R', ollama: 'L', lmstudio: 'L' };
  const provider = presetSymbols[providerKey]
    ? { symbol: presetSymbols[providerKey], name: getProviderPreset(providerKey).label }
    : getLlmProviderInfo(model, format === 'auto' ? detectApiFormat(model) : format, baseUrl);
  let host = '';
  try { host = baseUrl ? new URL(baseUrl).host : ''; } catch(e) { host = baseUrl; }
  return {
    provider,
    model,
    format,
    host: host || 'No base URL'
  };
}

function suggestProfileName(settings = {}) {
  const summary = getConnectionSummary(settings);
  return (summary.provider.name + ' - ' + formatModelForDisplay(summary.model, 28)).trim();
}

function setAssistantLlmMetadata(assistantMsg, swipeIdx, model, format, requestTarget = null) {
  const baseUrl = requestTarget?.baseUrl || localStorage.getItem('llmProxyUrl') || '';
  const providerKey = requestTarget?.provider || '';
  const symbols = { openai: 'O', anthropic: 'C', openrouter: 'R', ollama: 'L', lmstudio: 'L' };
  const provider = requestTarget
    ? { symbol: symbols[providerKey] || 'O', name: getProviderPreset(providerKey).label }
    : getLlmProviderInfo(model, format, baseUrl);
  const activeProfile = requestTarget ? null : getActiveProfile();
  const metadata = {
    model,
    apiFormat: format,
    providerName: provider.name,
    providerSymbol: provider.symbol,
    profileName: requestTarget?.profileName || activeProfile?.name || '',
    timestamp: Date.now()
  };
  assistantMsg.model = model;
  assistantMsg.apiFormat = format;
  assistantMsg.llm = metadata;
  assistantMsg.swipeLlms = assistantMsg.swipeLlms || [];
  assistantMsg.swipeLlms[swipeIdx] = metadata;
}

// ============================================
// Anthropic Message Conversion
// ============================================

// Claude models that reject temperature / top_p / top_k with a 400.
const NO_SAMPLING_PARAMS_RE = /opus-5|sonnet-5|opus-4-[78]|fable-5|mythos-5/i;
const NO_TRAILING_ASSISTANT_RE = /opus-5|sonnet-5|opus-4-[678]|sonnet-4-6|fable-5|mythos-5/i;

function resolveMaxTokens() {
  const n = parseInt(localStorage.getItem('llmMaxTokens'), 10);
  return Number.isFinite(n) && n > 0 ? n : 8192;
}

function prepareAnthropicMessages(apiMessages) {
  let systemText = '';
  const msgs = [];
  for (const m of apiMessages) {
    if (m.role === 'system') {
      const txt = typeof m.content === 'string' ? m.content : '';
      systemText += (systemText ? '\n\n' : '') + txt;
    } else {
      msgs.push({ role: m.role, content: m.content });
    }
  }
  // Merge consecutive same-role messages
  const merged = [];
  for (const m of msgs) {
    if (merged.length > 0 && merged[merged.length - 1].role === m.role) {
      const prev = merged[merged.length - 1];
      const toArr = (c) => {
        if (Array.isArray(c)) return c;
        if (typeof c === 'string') return [{ type: 'text', text: c }];
        return [{ type: 'text', text: String(c) }];
      };
      prev.content = [...toArr(prev.content), ...toArr(m.content)];
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }
  // Convert image/file content for Anthropic format
  const converted = merged.map(m => {
    if (Array.isArray(m.content)) {
      const parts = m.content.map(part => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        if (part.type === 'image_url') {
          const url = part.image_url.url;
          if (url.startsWith('data:')) {
            const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
            if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
          }
          return { type: 'image', source: { type: 'url', url: url } };
        }
        if (part.type === 'file') {
          const file = part.file || {};
          const url = file.url;
          if (url && url.startsWith('data:')) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) return { type: 'document', source: { type: 'base64', media_type: match[1], data: match[2] } };
          }
          if (typeof file.textContent === 'string') {
            const name = file.name || 'file';
            return { type: 'text', text: `--- ${name} ---\n${file.textContent}\n--- end ${name} ---` };
          }
          return part;
        }
        return part;
      });
      return { role: m.role, content: parts };
    }
    return m;
  });
  return { system: systemText, messages: converted };
}

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  // Share view is decided first: it changes whether local data is touched at all.
  const shareId = new URLSearchParams(location.search).get('share');
  readOnlyShare = !!shareId;
  if (readOnlyShare) document.body.classList.add('share-view');
  if (!readOnlyShare) window.addEventListener('online', () => syncRunAutoPush());

  if (!readOnlyShare) {
    // Migration: strip endpoint suffix from proxy URL
    const storedUrl = localStorage.getItem('llmProxyUrl');
    if (storedUrl) {
      const cleaned = storedUrl.replace(/\/(chat\/completions|messages)\/?$/, '');
      if (cleaned !== storedUrl) localStorage.setItem('llmProxyUrl', cleaned);
    }
    // Migration/default: keep CORS proxy enabled unless explicitly replaced.
    localStorage.setItem('llmCorsProxy', getCorsProxyUrl());
  }

  // Service worker: installability + offline. The protocol guard matters because
  // synapse.html is shipped as a standalone single file and gets opened over file://,
  // where registration throws.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Skipped entirely in share view. Opening the DB and leaving `conversations` empty is
  // what makes an accidental save destructive, so don't open it at all.
  if (!readOnlyShare) {
    try {
      await openDB();
    } catch (e) {
      db = null;
      console.error('IndexedDB unavailable:', e);
      showToast(conversationStorageBlocked
        ? 'Conversation storage is blocked by another tab. Reload after closing older tabs; changes are read-only until then.'
        : 'IndexedDB is unavailable. This tab is using limited browser storage.', 'error', 0);
    }
    await loadProjects();
    migrateToPromptEntries();
    await loadConversations();
    initConversationChannel();
    void syncRunAutoPush();
  }
  loadTheme();
  loadCustomFont(localStorage.getItem('assistantFont') || '');
  loadCachedModels('setup');
  loadCachedModels('settings');
  renderConnectionChip();
  initModalAccessibility();
  const organization = document.querySelector('.sidebar-organization');
  if (organization) organization.hidden = localStorage.getItem('assistantSidebarOrganizationOpen') !== 'true';
  document.getElementById('toolbarMenu')?.addEventListener('keydown', event => {
    handleMenuKeydown(event, event.currentTarget, closeToolbarMenu);
  });
  document.getElementById('sidebarMenu')?.addEventListener('keydown', event => {
    handleMenuKeydown(event, event.currentTarget, () => closeSidebarMenu(true));
  });
  document.getElementById('composerMenu')?.addEventListener('keydown', event => {
    handleMenuKeydown(event, event.currentTarget, () => closeComposerMenu(true));
  });
  document.getElementById('connectionPickerResults')?.addEventListener('keydown', event => {
    handleMenuKeydown(event, event.currentTarget, () => closeConnectionPicker(true));
  });
  document.getElementById('connectionPickerSearch')?.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeConnectionPicker(true);
    } else if (event.key === 'ArrowDown') {
      const first = document.querySelector('#connectionPickerResults [role="menuitem"]');
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  document.querySelector('.settings-tabs')?.addEventListener('keydown', event => {
    const tabs = Array.from(event.currentTarget.querySelectorAll('[role="tab"]'));
    const current = Math.max(0, tabs.indexOf(document.activeElement));
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next].click();
    tabs[next].focus();
  });
  ['setPersona', 'setRpUserName', 'setStarterPrompts'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', schedulePromptSettingsAutosave);
  });
  ['setEnableStMacros', 'setStarterPromptsHidden'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', schedulePromptSettingsAutosave);
  });
  ['setFont', 'setMsgFontSize', 'setMsgMaxWidth', 'setEmotionSprites', 'setEmotionSpriteSet',
    'cBorderRadius', 'cMsgMaxWidth', 'cMsgFontSize'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', scheduleAppearanceSettingsAutosave);
  });
  ['input', 'change'].forEach(type => {
    document.getElementById('settingsModal')?.addEventListener(type, event => {
      const tab = event.target.closest('.settings-tab-content')?.id.replace('settingsTab-', '');
      if (!['api', 'tools'].includes(tab)) return;
      dirtySettingsTabs.add(tab);
      updateProviderOptions();
      updateSettingsFooter();
    });
  });
  document.getElementById('setupProvider')?.addEventListener('change', updateProviderOptions);
  renderLocalUpdateStatus();
  checkLocalUpdateStatus(false);

  // Save on page unload — sync fallback since IDB is async
  window.addEventListener('beforeunload', () => {
    // Second wipe vector: the localStorage fallback below writes `conversations`
    // directly, bypassing the guard inside saveConversations.
    if (readOnlyShare) return;
    if (_projectAutosaveTimer) void flushProjectAutosave();
    flushSettingsAutosaves();
    clearTimeout(_saveDebounceTimer);
    persistDraftFromUI();
    saveConversations();
    // Only write to localStorage as fallback if IndexedDB is not available
    if (!db && !conversationStorageBlocked) {
      try {
        localStorage.setItem('assistantConversations', JSON.stringify(getPersistentConversations()));
        localStorage.setItem('assistantActiveConvId', getPersistentActiveConvId());
      } catch(e) {}
    }
  });

  // Show setup modal if no API key. A visitor reading a shared link has no reason to
  // be asked for one.
  const savedCredential = getStoredApiCredential();
  if (!readOnlyShare && (!localStorage.getItem('llmProxyUrl') || (providerRequiresKey() && !getApiKey()) || (savedCredential.value && !savedCredential.destination))) {
    applyProviderPreset('setup', document.getElementById('setupProvider')?.value || 'openai');
    if (savedCredential.value && !savedCredential.destination) {
      document.getElementById('setupProvider').value = inferProviderKey();
      document.getElementById('setupProxy').value = localStorage.getItem('llmProxyUrl') || '';
      document.getElementById('setupApiFormat').value = localStorage.getItem('llmApiFormat') || 'auto';
      document.getElementById('setupModelManual').value = localStorage.getItem('llmModel') || '';
      document.getElementById('setupKey').value = savedCredential.value;
      renderSetupError('Review the provider and base URL, then save to confirm this older saved key.');
    }
    setKeyStorageInputs(getKeyStorageMode());
    openModal('setupModal', '#setupProxy');
  }

  // Hide voice button if unsupported
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    document.getElementById('voiceBtn').style.display = 'none';
  }
  window.addEventListener('pagehide', stopVoiceInput);


  // Auto-resize textarea + character count + @model mentions
  const ta = document.getElementById('chatInput');
  ['setupProxy', 'setProxy'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', event => {
      delete event.currentTarget.dataset.providerPreset;
      delete event.currentTarget.dataset.providerPresetUrl;
    });
  });
  let tokenDebounce;
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 150) + 'px';
    clearTimeout(tokenDebounce);
    tokenDebounce = setTimeout(updateTokenInfo, 300);
    handleMentionInput(ta);
    handleCommandInput(ta);
    persistDraftFromUI();
    updateSendBtnState();
  });

  // Send on Enter (with mention dropdown handling)
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (commandActive) {
      handleCommandKeydown(e, ta);
      if (e.defaultPrevented) return;
    }
    if (mentionActive) {
      handleMentionKeydown(e, ta);
      if (e.defaultPrevented) return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      streaming ? queueFollowUpFromComposer() : sendMessage();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      const enterSends = localStorage.getItem('llmEnterSend') !== 'false';
      if (enterSends) {
        e.preventDefault();
        streaming ? queueFollowUpFromComposer() : sendMessage();
      }
    }
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const commandKey = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (readOnlyShare && ((commandKey && key === 'n') ||
      (commandKey && e.shiftKey && ['e', 'r'].includes(key)))) {
      e.preventDefault();
      return;
    }
    // Escape - close modals / stop streaming
    if (e.key === 'Escape') {
      if (transientDialogClose) {
        e.preventDefault();
        transientDialogClose();
        return;
      }
      if (globalSearchDismiss) {
        e.preventDefault();
        globalSearchDismiss();
        return;
      }
      if (closeTopModal()) {
        e.preventDefault();
        return;
      }
      if (document.getElementById('chatSearchBar').classList.contains('open')) {
        closeChatSearch();
        return;
      }
      if (document.getElementById('toolbarMenu')?.classList.contains('open')) {
        closeToolbarMenu();
        e.preventDefault();
        return;
      }
      if (document.getElementById('sidebarMenu')?.classList.contains('open')) {
        closeSidebarMenu(true);
        e.preventDefault();
        return;
      }
      if (document.getElementById('composerMenu')?.classList.contains('open')) {
        closeComposerMenu(true);
        e.preventDefault();
        return;
      }
      if (!document.getElementById('connectionPicker')?.hidden) {
        closeConnectionPicker(true);
        e.preventDefault();
        return;
      }
      if (actionMenuClose) {
        actionMenuClose();
        e.preventDefault();
        return;
      }
      const contextPanel = document.getElementById('contextPanel');
      if (window.innerWidth <= 1100 && contextPanel && !contextPanel.classList.contains('collapsed')) {
        toggleContextPanel(false);
        e.preventDefault();
        return;
      }
      const sidebar = document.getElementById('sidebar');
      if (window.innerWidth <= 768 && sidebar && !sidebar.classList.contains('collapsed')) {
        toggleSidebar(false);
        e.preventDefault();
        return;
      }
      if (streaming && abortController) abortController.abort();
    }
    if (openModalStack.length) return;
    // Ctrl+N - new conversation
    if (commandKey && key === 'n') {
      e.preventDefault();
      createConversation();
    }
    // Ctrl+/ - focus input
    if (commandKey && e.key === '/') {
      e.preventDefault();
      document.getElementById('chatInput').focus();
    }
    // Ctrl+K - focus sidebar search
    if (commandKey && key === 'k') {
      e.preventDefault();
      const sb = document.getElementById('sidebar');
      if (sb.classList.contains('collapsed')) toggleSidebar();
      document.getElementById('sidebarSearch').focus();
    }
    // Ctrl+Shift+E - export all
    if (commandKey && e.shiftKey && key === 'e') {
      e.preventDefault();
      exportAllConversations();
    }
    // Ctrl+F - chat search
    if (commandKey && key === 'f') {
      e.preventDefault();
      openChatSearch();
    }
    // Ctrl+Shift+R - regenerate last response
    if (commandKey && e.shiftKey && key === 'r') {
      e.preventDefault();
      regenerate();
    }
    // Ctrl+Shift+? - shortcut help
    if (commandKey && e.shiftKey && e.key === '?') {
      e.preventDefault();
      openModal('shortcutsModal');
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#commandDropdown, #chatInput')) closeCommandDropdown();
  });

  // Drag & drop files
  const main = document.querySelector('.main');
  main.addEventListener('dragenter', (e) => { e.preventDefault(); main.classList.add('drag-over'); });
  main.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; main.classList.add('drag-over'); });
  main.addEventListener('dragleave', (e) => { if (!main.contains(e.relatedTarget)) main.classList.remove('drag-over'); });
  main.addEventListener('drop', (e) => {
    e.preventDefault();
    main.classList.remove('drag-over');
    Array.from(e.dataTransfer.files).forEach(readAttachmentFile);
  });

  // Paste images
  ta.addEventListener('paste', (e) => {
    Array.from(e.clipboardData?.items || []).forEach(item => {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        readAttachmentFile(item.getAsFile());
      }
    });
  });

  toggleSidebar(window.innerWidth > 768, false);
  toggleContextPanel(window.innerWidth > 1100 && localStorage.getItem('assistantContextPanelOpen') !== 'false', false);
  document.getElementById('sidebar')?.addEventListener('keydown', event => {
    const sidebar = document.getElementById('sidebar');
    if (window.innerWidth <= 768 && !sidebar.classList.contains('collapsed')) trapFocus(sidebar, event);
  });
  document.getElementById('contextPanel')?.addEventListener('keydown', event => {
    const panel = document.getElementById('contextPanel');
    if (window.innerWidth <= 1100 && !panel.classList.contains('collapsed')) trapFocus(panel, event);
  });
  window.addEventListener('pagehide', () => armedFollowUpConversationIds.clear());
  let previousLayoutWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    const width = window.innerWidth;
    if (previousLayoutWidth > 768 && width <= 768) {
      toggleSidebar(false, false);
      toggleContextPanel(false, false);
    } else if (previousLayoutWidth > 1100 && width <= 1100) {
      toggleContextPanel(false, false);
    } else if (previousLayoutWidth <= 768 && width > 768) {
      toggleSidebar(true, false);
    }
    if (previousLayoutWidth <= 1100 && width > 1100 && localStorage.getItem('assistantContextPanelOpen') !== 'false') {
      toggleContextPanel(true, false);
    }
    if (window.innerWidth > 768) document.getElementById('sidebarOverlay')?.classList.remove('open');
    if (window.innerWidth > 1100) document.getElementById('contextOverlay')?.classList.remove('open');
    // The send button label is shortened on narrow screens.
    if ((previousLayoutWidth <= 768) !== (width <= 768)) updateSendBtnState();
    document.querySelectorAll('.toolbar-menu.open, .connection-picker:not([hidden])').forEach(clampPopupToViewport);
    previousLayoutWidth = width;
  });

  // Scroll-to-bottom FAB
  const msgsArea = document.getElementById('messagesArea');
  const scrollFab = document.getElementById('scrollFab');
  const inputArea = document.querySelector('.input-area');
  msgsArea.addEventListener('scroll', () => {
    const distanceFromBottom = msgsArea.scrollHeight - msgsArea.scrollTop - msgsArea.clientHeight;
    // Anchor above the composer, which changes height as the textarea grows.
    if (inputArea) scrollFab.style.bottom = (inputArea.offsetHeight + 12) + 'px';
    scrollFab.classList.toggle('visible', distanceFromBottom >= 100);
    if (streaming && !_suppressScrollFlag) {
      userScrolledAway = distanceFromBottom > 4;
    }
  });

  // Initialize mermaid with theme matching current app theme
  if (typeof mermaid !== 'undefined') {
    const mermaidTheme = isLightColor(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()) ? 'default' : 'dark';
    mermaid.initialize({ startOnLoad: false, theme: mermaidTheme });
  }

  // Listen for OS color scheme changes when using system theme
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem('assistantTheme') || 'dark') === 'system') applyTheme('system');
  });

  // Select mode: click to toggle message selection (capture phase)
  msgsArea.addEventListener('click', e => {
    if (!_selectMode) return;
    if (_justEnteredSelectMode) { _justEnteredSelectMode = false; e.preventDefault(); e.stopPropagation(); return; }
    const wrapper = e.target.closest('.msg-wrapper');
    if (!wrapper) return;
    e.preventDefault();
    e.stopPropagation();
    toggleMsgSelect(parseInt(wrapper.dataset.msgIdx));
  }, true);

  // Long-press to enter select mode (desktop)
  let _longPressTimer = null;
  msgsArea.addEventListener('mousedown', e => {
    if (localStorage.getItem('llmHoldScreenshot') !== 'true') return;
    if (_selectMode || e.target.closest('.msg-action-btn, .regen-btn')) return;
    const wrapper = e.target.closest('.msg-wrapper');
    if (!wrapper) return;
    _longPressTimer = setTimeout(() => {
      _longPressTimer = null;
      enterSelectMode();
      toggleMsgSelect(parseInt(wrapper.dataset.msgIdx));
    }, 500);
  });
  document.addEventListener('mouseup', () => { if (_longPressTimer) { clearTimeout(_longPressTimer); _longPressTimer = null; } });

  // Long-press to enter select mode (touch)
  let _lpTouchTimer = null, _lpTouchX = 0, _lpTouchY = 0;
  msgsArea.addEventListener('touchstart', e => {
    if (localStorage.getItem('llmHoldScreenshot') !== 'true') return;
    if (_selectMode) return;
    const wrapper = e.target.closest('.msg-wrapper');
    if (!wrapper) return;
    _lpTouchX = e.touches[0].clientX;
    _lpTouchY = e.touches[0].clientY;
    _lpTouchTimer = setTimeout(() => {
      if (navigator.vibrate) navigator.vibrate(50);
      enterSelectMode();
      toggleMsgSelect(parseInt(wrapper.dataset.msgIdx));
      _lpTouchTimer = null;
    }, 500);
  }, { passive: true });
  msgsArea.addEventListener('touchmove', e => {
    if (!_lpTouchTimer) return;
    const dx = Math.abs(e.touches[0].clientX - _lpTouchX);
    const dy = Math.abs(e.touches[0].clientY - _lpTouchY);
    if (dx > 10 || dy > 10) { clearTimeout(_lpTouchTimer); _lpTouchTimer = null; }
  }, { passive: true });
  msgsArea.addEventListener('touchend', () => { if (_lpTouchTimer) { clearTimeout(_lpTouchTimer); _lpTouchTimer = null; } }, { passive: true });
  msgsArea.addEventListener('contextmenu', e => { if (_longPressTimer || _lpTouchTimer) e.preventDefault(); });

  // Image lightbox for generated images
  msgsArea.addEventListener('click', e => {
    const img = e.target.closest('.chat-gen-img');
    if (!img) return;
    const overlay = document.createElement('div');
    overlay.className = 'img-lightbox-overlay';
    const popup = document.createElement('div');
    popup.className = 'img-lightbox';
    popup.setAttribute('aria-label', 'Generated image preview');
    const fullImg = document.createElement('img');
    fullImg.src = img.src;
    fullImg.alt = img.alt || 'Generated image';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'img-lightbox-close';
    closeButton.setAttribute('aria-label', 'Close image preview');
    closeButton.textContent = '×';
    popup.append(fullImg, closeButton);
    const close = openTransientDialog(overlay, popup, closeButton);
    closeButton.onclick = close;
  });

  // Last: the rest of init (theme, fonts, mermaid, KaTeX, lightbox and key handlers)
  // is wanted in share view too, so this runs after it rather than returning early.
  if (readOnlyShare) await initShareView(shareId);
});

// ============================================
// Markdown Renderer
// ============================================
function renderGenImages(images) {
  if (!images || !images.length) return '';
  return images.map(url => safeMediaUrl(url)).filter(Boolean)
    .map(url => '<img src="' + escapeHTML(url) + '" alt="Generated image" class="chat-inline-img chat-gen-img" loading="lazy">').join('');
}

function buildApiContent(msg) {
  const baseContent = Array.isArray(msg.content) ? msg.content.map(part => {
    if (part?.type === 'image_url') {
      const url = safeMediaUrl(part.image_url?.url);
      return url ? { ...part, image_url: { ...(part.image_url || {}), url } } : null;
    }
    if (part?.type === 'file') return { ...part, file: { ...(part.file || {}), url: safeFileUrl(part.file?.url) } };
    return part;
  }).filter(Boolean) : msg.content;
  if (!msg.images || !msg.images.length) return baseContent;
  const parts = [];
  if (Array.isArray(baseContent)) parts.push(...baseContent);
  else if (baseContent) parts.push({ type: 'text', text: baseContent });
  msg.images.forEach(url => {
    const safeUrl = safeMediaUrl(url);
    if (safeUrl) parts.push({ type: 'image_url', image_url: { url: safeUrl } });
  });
  return parts;
}

function extractImages(msg) {
  if (!msg || typeof msg !== 'object') return { text: '', images: [] };
  const images = [];
  // 1. message.images[] array (some proxies put images here)
  if (Array.isArray(msg.images)) {
    for (const img of msg.images) {
      if (img?.image_url?.url) images.push(img.image_url.url);
      else if (img?.url) images.push(img.url);
      else if (img?.b64_json) images.push('data:image/png;base64,' + img.b64_json);
      else if (typeof img === 'string' && safeMediaUrl(img)) images.push(img);
      else if (typeof img === 'string' && /^[A-Za-z0-9+/]{100,}={0,2}$/.test(img)) images.push('data:image/png;base64,' + img);
    }
  }
  // 2. message.content as array
  const content = msg.content;
  let text = '';
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item) continue;
      if (item.type === 'text') { text += item.text || ''; continue; }
      if (item.type === 'image_url' && item.image_url?.url) { images.push(item.image_url.url); continue; }
      if (item.type === 'image' && item.source?.data) {
        images.push('data:' + (item.source.media_type || 'image/png') + ';base64,' + item.source.data);
        continue;
      }
      if (item.type === 'image' && item.source?.url) { images.push(item.source.url); continue; }
      if (item.image_url?.url) { images.push(item.image_url.url); continue; }
      if (typeof item === 'string' && item.startsWith('data:image')) { images.push(item); continue; }
    }
  } else {
    text = typeof content === 'string' ? content : '';
  }
  // 3. message.parts[] (Gemini inline_data)
  if (Array.isArray(msg.parts)) {
    for (const part of msg.parts) {
      if (!part) continue;
      if (part.inline_data?.data) {
        images.push('data:' + (part.inline_data.mime_type || 'image/png') + ';base64,' + part.inline_data.data);
      }
      if (part.text && !text) text += part.text;
    }
  }
  // 4. Extract images from text string (data URIs, URLs, raw base64)
  if (typeof text === 'string' && text && !images.length) {
    const dataUriMatch = text.trim().match(/^data:image\/[^;]+;base64,[A-Za-z0-9+/=]+$/);
    if (dataUriMatch) {
      images.push(dataUriMatch[0]);
      text = text.replace(dataUriMatch[0], '').trim();
    }
    if (!images.length) {
      const urlMatch = text.match(/^https?:\/\/[^\s]+\.(png|jpg|jpeg|webp|gif)(\?[^\s]*)?$/i);
      if (urlMatch) { images.push(text.trim()); text = ''; }
    }
    if (!images.length) {
      const rawB64 = text.match(/^[A-Za-z0-9+/]{100,}[=]{0,2}$/);
      if (rawB64) { images.push('data:image/png;base64,' + rawB64[0]); text = ''; }
    }
  }
  return { text, images: [...new Set(images.map(safeMediaUrl).filter(Boolean))] };
}

function renderMarkdown(text) {
  if (!text) return '';

  // NUL is reserved for internal tokens, never for model-supplied content.
  text = String(text).replace(/\x00/g, '').replace(/\r\n?/g, '\n');

  function decodeBasicEntities(input) {
    // Decode up to a few passes to handle doubly-encoded model output like &amp;lt;strong&amp;gt;
    let out = String(input || '');
    for (let i = 0; i < 3; i++) {
      const next = out
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      if (next === out) break;
      out = next;
    }
    return out;
  }

  function restoreAllowedInlineHtml(input) {
    // Allow a small, attribute-free inline HTML subset for formatting.
    // Keep all attributes escaped to avoid script/style injection vectors.
    const allowedTags = ['strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'small', 'sub', 'sup', 'code', 'kbd'];
    let out = input;
    allowedTags.forEach(tag => {
      const open = new RegExp('&lt;\\s*' + tag + '\\s*&gt;', 'gi');
      const close = new RegExp('&lt;\\s*\\/\\s*' + tag + '\\s*&gt;', 'gi');
      out = out.replace(open, '<' + tag + '>');
      out = out.replace(close, '</' + tag + '>');
    });
    out = out.replace(/&lt;\s*br\s*\/?\s*&gt;/gi, '<br>');
    return out;
  }

  function renderLiteralCode(input) {
    return escapeHTML(decodeBasicEntities(input));
  }

  // Fix UTF-8 text that was decoded as Latin-1 (smart quotes, em dashes, etc. showing as â + boxes)
  text = text.replace(/[\xC0-\xF4][\x80-\xBF]{1,3}/g, function(m) {
    try {
      const bytes = new Uint8Array(m.length);
      for (let i = 0; i < m.length; i++) bytes[i] = m.charCodeAt(i);
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch(e) { return m; }
  });

  const protectedBlocks = [];
  // Block-level protections get a 'B' marker so newlines around them can be
  // swallowed before the \n -> <br> pass; inline tokens keep text flow.
  const protectBlock = (block) => {
    const idx = protectedBlocks.length;
    protectedBlocks.push(block);
    return '\x00' + (block.type.startsWith('inline-') ? 'I' : 'B') + idx + '\x00';
  };
  // Attributes and math source get original text, never HTML from another token.
  const literalSource = input => String(input || '').replace(/\x00[BI](\d+)\x00/g,
    (_, idx) => literalSource(protectedBlocks[Number(idx)]?.source));
  const restoreProtectedBlock = (_, idx) => {
    const block = protectedBlocks[parseInt(idx, 10)];
    if (!block) return '';
    if (block.type === 'html' || block.type === 'inline-html') return block.html;
    if (block.type === 'math' || block.type === 'inline-math') {
      if (typeof katex !== 'undefined') {
        try {
          return katex.renderToString(literalSource(block.math), { displayMode: block.type === 'math', throwOnError: false, trust: false });
        } catch (e) { console.warn('KaTeX render error:', e); }
      }
      return escapeHTML(literalSource(block.source));
    }
    if (block.type === 'mermaid') {
      return '<div class="mermaid-container"><pre class="mermaid">' + renderLiteralCode(literalSource(block.code)) + '</pre></div>';
    }
    if (block.type === 'inline-code') {
      return '<code>' + renderLiteralCode(literalSource(block.code)) + '</code>';
    }
    const langAttr = block.lang ? ' class="language-' + block.lang + '"' : '';
    return '<pre><code' + langAttr + '>' + renderLiteralCode(literalSource(block.code)) + '</code></pre>';
  };
  const restoreBlocks = input => input.replace(/\x00[BI](\d+)\x00/g, restoreProtectedBlock);

  // Extract KaTeX math before HTML escaping
  const looksLikeInlineMath = (math) => {
    const t = String(math || '').trim();
    if (!t) return false;
    if (t.includes('|')) return false;
    if (/[€£¥₹]/.test(t)) return false;
    if (/\b(?:leaked|input|output|premium|price|pricing|tbd)\b/i.test(t)) return false;
    if (/^[~]?\d/.test(t)) return false;
    if (/^\d+(?:\.\d+)?\s*\/\s*[A-Za-z][A-Za-z0-9-]*(?:\s*\([^)]*\))?$/.test(t)) return false;
    if (/\b\d+(?:\.\d+)?\s*\/\s*[kKmM]\b/.test(t)) return false;
    // Explicit LaTeX markers are always treated as math.
    if (/[\\^_{}]/.test(t)) return true;
    // Accept straightforward symbolic math, reject prose-like text.
    if (/[=<>]/.test(t)) return true;
    if (/^[A-Za-z][A-Za-z0-9]*\s*\/\s*[A-Za-z][A-Za-z0-9]*$/.test(t)) return true;
    if (/^[A-Za-z][A-Za-z0-9]*\s*[+\-*]\s*[A-Za-z0-9]+(?:\s*[+\-*]\s*[A-Za-z0-9]+)*$/.test(t)) return true;
    return false;
  };
  let s = text;
  // Protect literal code/mermaid content before markdown regexes run.
  s = s.replace(/```mermaid(?:[ \t]*\n|[ \t]+)?([\s\S]*?)```/gi, (source, code) =>
    protectBlock({ type: 'mermaid', source, code: code.trimEnd() })
  );
  s = s.replace(/```([A-Za-z0-9_#+.-]*)(?:[ \t]*\n|[ \t]+)?([\s\S]*?)```/g, (source, lang, code) =>
    protectBlock({ type: 'fence', source, lang, code: code.trimEnd() })
  );
  s = s.replace(/(?<!`)`([^`\n]+)`(?!`)/g, (source, code) =>
    protectBlock({ type: 'inline-code', source, code })
  );
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (source, math) => protectBlock({ type: 'math', source, math }));
  s = s.replace(/\$([^\$\n]+?)\$/g, (source, math) =>
    looksLikeInlineMath(math) ? protectBlock({ type: 'inline-math', source, math }) : source
  );

  function renderInline(input) {
    let out = input.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (source, alt, url) => {
      const safeUrl = safeMediaUrl(decodeBasicEntities(literalSource(url)));
      const safeAlt = escapeHTML(literalSource(alt));
      const html = safeUrl ? '<img src="' + escapeHTML(safeUrl) + '" alt="' + safeAlt + '" class="chat-inline-img chat-gen-img" loading="lazy" referrerpolicy="no-referrer">' : safeAlt;
      return protectBlock({ type: 'inline-html', source, html });
    });
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (source, label, url) => {
      const safeUrl = safeHttpUrl(decodeBasicEntities(literalSource(url)));
      const content = restoreBlocks(renderInline(label));
      const html = safeUrl ? '<a href="' + escapeHTML(safeUrl) + '" target="_blank" rel="noopener noreferrer">' + content + '</a>' : content;
      return protectBlock({ type: 'inline-html', source, html });
    });
    out = restoreAllowedInlineHtml(escapeHTML(decodeBasicEntities(out)));
    out = out.replace(/&gt;!([\s\S]*?)!&lt;/g, '<details class="spoiler"><summary><span class="spoiler-reveal">Reveal spoiler</span><span class="spoiler-hide">Hide spoiler</span></summary><span class="spoiler-content">$1</span></details>');
    out = out.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');
    out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    out = out.replace(/(^|[^\w])_([^_\n]+)_([^\w]|$)/g, '$1<em>$2</em>$3');
    out = out.replace(/~~(.+?)~~/g, '<del>$1</del>');
    return out.replace(/==(.+?)==/g, '<mark>$1</mark>');
  }

  // Parse raw table cells before formatting, so links and code are rendered once.
  s = s.replace(/(^\|.+\|$\n?)+/gm, source => {
    const rows = source.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return source;
    const parseRow = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const isSep = r => /^\|[\s\-:|]+\|$/.test(r.trim());
    const renderTableCell = c => restoreBlocks(renderInline(c));
    const headerRow = parseRow(rows[0]);
    const bodyStart = isSep(rows[1]) ? 2 : 1;
    let html = '<table><thead><tr>' + headerRow.map(c => `<th>${renderTableCell(c)}</th>`).join('') + '</tr></thead><tbody>';
    for (let i = bodyStart; i < rows.length; i++) {
      if (isSep(rows[i])) continue;
      html += '<tr>' + parseRow(rows[i]).map(c => `<td>${renderTableCell(c)}</td>`).join('') + '</tr>';
    }
    return protectBlock({ type: 'html', source, html: html + '</tbody></table>' });
  });
  s = renderInline(s);
  s = s.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/^[ \t]*[\-\*] (.+)$/gm, '<li class="ul-li">$1</li>');
  s = s.replace(/((?:<li class="ul-li">.*<\/li>(?:\n[ \t]*)*)+)/g, function(m) {
    const items = m
      .replace(/ class="ul-li"/g, '')
      .replace(/\n[ \t]*/g, '');
    return '<ul>' + items + '</ul>';
  });
  s = s.replace(/^[ \t]*\d+[.)] (.+)$/gm, '<li class="ol-li">$1</li>');
  s = s.replace(/((?:<li class="ol-li">.*<\/li>(?:\n[ \t]*)*)+)/g, function(m) {
    const items = m
      .replace(/ class="ol-li"/g, '')
      .replace(/\n[ \t]*/g, '');
    return '<ol>' + items + '</ol>';
  });
  s = s.replace(/^---$/gm, '<hr>');
  // Block elements carry their own margins; newlines around them must not
  // also become <br>s or headings/lists/code/tables get double-spaced gaps.
  s = s.replace(/<\/blockquote>\n<blockquote>/g, '<br>');
  s = s.replace(/\n+(\x00B\d+\x00)/g, '$1');
  s = s.replace(/(\x00B\d+\x00)\n+/g, '$1');
  s = s.replace(/\n+(?=<(?:h[1-4]|ul|ol|blockquote|hr|table)\b)/g, '');
  s = s.replace(/(<\/(?:h[1-4]|ul|ol|blockquote|table)>|<hr>)\n+/g, '$1');
  s = s.replace(/\n/g, '<br>');

  // Each generated block is complete. Never run formatting over its HTML again.
  return restoreBlocks(s);
}

// ============================================
// Code Copy Buttons
// ============================================
function addCodeCopyButtons(container) {
  const langExtMap = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', cs: 'cs', go: 'go', rust: 'rs', ruby: 'rb', php: 'php', html: 'html', css: 'css', json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yml', sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh', markdown: 'md', md: 'md', swift: 'swift', kotlin: 'kt', lua: 'lua', r: 'r', perl: 'pl', scala: 'scala', dart: 'dart', zig: 'zig', nim: 'nim', elixir: 'ex', clojure: 'clj', haskell: 'hs', ocaml: 'ml', toml: 'toml', ini: 'ini', dockerfile: 'dockerfile', makefile: 'makefile' };
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.parentElement.classList.contains('code-block-wrapper')) return;
    if (pre.classList.contains('mermaid')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.onclick = (e) => {
      e.stopPropagation();
      const code = pre.querySelector('code');
      navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    };
    wrapper.appendChild(btn);
    // Download button
    const code = pre.querySelector('code');
    if (code) {
      const cls = Array.from(code.classList).find(c => c.startsWith('language-'));
      const lang = cls ? cls.replace('language-', '') : '';
      const ext = langExtMap[lang] || lang || 'txt';
      const dlBtn = document.createElement('button');
      dlBtn.className = 'code-download-btn';
      dlBtn.textContent = '\u2913';
      dlBtn.title = 'Download as .' + ext;
      dlBtn.onclick = (e) => {
        e.stopPropagation();
        const blob = new Blob([code.textContent], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'code.' + ext;
        a.click();
        URL.revokeObjectURL(a.href);
      };
      wrapper.appendChild(dlBtn);
    }
  });
}

// ============================================
// Syntax Highlighting
// ============================================
function highlightCodeBlocks(container) {
  if (typeof hljs === 'undefined') return;
  container.querySelectorAll('pre code[class^="language-"]').forEach(el => {
    if (el.dataset.highlighted) return;
    hljs.highlightElement(el);
    el.dataset.highlighted = 'true';
  });
}

// ============================================
// Line Numbers
// ============================================
function addLineNumbers(container) {
  container.querySelectorAll('pre code').forEach(code => {
    if (code.parentElement.classList.contains('has-line-numbers')) return;
    if (code.parentElement.classList.contains('mermaid')) return;
    const lines = code.innerHTML.split('\n');
    if (lines.length < 3) return;
    // Remove trailing empty line if present
    if (lines[lines.length - 1].trim() === '') lines.pop();
    code.innerHTML = lines.map(l => '<span class="code-line">' + l + '</span>').join('\n');
    code.parentElement.classList.add('has-line-numbers');
  });
}

// ============================================
// Mermaid Rendering
// ============================================
let mermaidIdCounter = 0;
async function renderMermaidBlocks(container) {
  if (typeof mermaid === 'undefined') return;
  const pres = container.querySelectorAll('pre.mermaid');
  for (const pre of pres) {
    if (pre.dataset.rendered) continue;
    pre.dataset.rendered = 'true';
    try {
      const id = 'mermaid-' + (mermaidIdCounter++);
      const { svg } = await mermaid.render(id, pre.textContent);
      const div = document.createElement('div');
      div.innerHTML = svg;
      pre.replaceWith(div.firstElementChild);
    } catch (e) {
      pre.textContent = 'Mermaid error: ' + e.message;
    }
  }
}

function renderEmotionSprites(container) {
  if (!areEmotionSpritesEnabled() || !container) return;
  const selectedPrefix = getEmotionSpritePrefix();
  const skipSelector = 'script,style,textarea,input,select,option,button,code,pre,.emotion-sprite-wrap';
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.includes('_')) return NodeFilter.FILTER_REJECT;
      if (!node.parentElement || node.parentElement.closest(skipSelector)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);

  nodes.forEach(node => {
    EMOTION_SPRITE_TAG_RE.lastIndex = 0;
    let match = EMOTION_SPRITE_TAG_RE.exec(node.nodeValue);
    if (!match) return;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    while (match) {
      const raw = match[0];
      const name = match[1];
      if (match.index > cursor) fragment.appendChild(document.createTextNode(node.nodeValue.slice(cursor, match.index)));
      if (EMOTION_SPRITE_NAMES[name] === selectedPrefix) {
        const wrap = document.createElement('span');
        wrap.className = 'emotion-sprite-wrap';
        wrap.dataset.emotion = name;
        const image = document.createElement('img');
        image.className = 'emotion-sprite';
        image.src = getEmotionSpriteAssetUrl(name);
        image.alt = name.replaceAll('_', ' ');
        image.title = name;
        image.width = 128;
        image.height = 128;
        image.loading = 'lazy';
        image.decoding = 'async';
        wrap.appendChild(image);
        fragment.appendChild(wrap);
      } else {
        fragment.appendChild(document.createTextNode(raw));
      }
      cursor = match.index + raw.length;
      match = EMOTION_SPRITE_TAG_RE.exec(node.nodeValue);
    }
    if (cursor < node.nodeValue.length) fragment.appendChild(document.createTextNode(node.nodeValue.slice(cursor)));
    node.replaceWith(fragment);
  });
}

// ============================================
// Artifact Preview
// ============================================
const ARTIFACT_LANGS = ['html', 'svg', 'xml'];

function addArtifactPreview(container) {
  container.querySelectorAll('pre code').forEach(code => {
    const wrapper = code.parentElement && code.parentElement.parentElement;
    if (!wrapper || !wrapper.classList.contains('code-block-wrapper')) return;
    if (wrapper.querySelector('.code-preview-btn')) return;
    const cls = Array.from(code.classList).find(c => c.startsWith('language-'));
    const lang = cls ? cls.replace('language-', '').toLowerCase() : '';
    if (!ARTIFACT_LANGS.includes(lang)) return;
    if (!code.textContent.includes('<')) return;

    const btn = document.createElement('button');
    btn.className = 'code-preview-btn';
    btn.textContent = 'Preview';
    btn.title = 'Render this markup in a sandbox';
    btn.onclick = (e) => {
      e.stopPropagation();
      const existing = wrapper.querySelector('iframe.artifact-frame');
      if (existing) {
        existing.remove();
        btn.textContent = 'Preview';
        return;
      }
      const frame = document.createElement('iframe');
      frame.className = 'artifact-frame';
      // allow-scripts ONLY. Adding allow-same-origin alongside it would put the frame
      // on this page's origin and hand model-generated script the stored API key.
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('title', 'Artifact preview');
      frame.srcdoc = code.textContent;
      wrapper.appendChild(frame);
      btn.textContent = 'Hide';
    };
    wrapper.appendChild(btn);
  });
}

// ============================================
// Post-Render Pipeline
// ============================================
function postRenderProcessing(bubble) {
  renderEmotionSprites(bubble);
  addCodeCopyButtons(bubble);
  addArtifactPreview(bubble);
  highlightCodeBlocks(bubble);
  // Line-number DOM rewriting can be fragile on some mobile WebKit builds.
  // Keep desktop behavior, skip on small screens for more robust code rendering.
  const smallScreen = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
  if (!smallScreen) addLineNumbers(bubble);
  renderMermaidBlocks(bubble);
}

// ============================================
// Token Estimation
// ============================================
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.split(/[\s,.!?;:'"()\[\]{}]+/).filter(Boolean).length * 1.3);
}

function getMsgText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(part => {
      if (part.type === 'text') return part.text || '';
      if (part.type === 'file') {
        const name = part.file?.name || 'file';
        if (typeof part.file?.textContent === 'string') return part.file.textContent;
        return '[Attached file: ' + name + ']';
      }
      if (part.type === 'image_url') return '[Attached image]';
      return '';
    }).filter(Boolean).join(' ');
  }
  return '';
}

// ============================================
// Read Aloud
// ============================================

// Reuses the markdown renderer instead of writing a second stripper: rendering to HTML
// and taking textContent drops the asterisks, backticks and link syntax that would
// otherwise be read out literally. Fenced code is dropped — reading it aloud is noise.
function toSpeechText(text) {
  const holder = document.createElement('div');
  holder.innerHTML = renderMarkdown(text || '');
  holder.querySelectorAll('pre').forEach(el => el.remove());
  return holder.textContent.replace(/\s+/g, ' ').trim();
}

function stopReadAloud() {
  spokenMessage = null;
  if (speechUtterance) {
    speechUtterance.onend = null;
    speechUtterance.onerror = null;
    speechUtterance = null;
    window.speechSynthesis?.cancel();
  }
  document.querySelectorAll('[data-action="read-aloud"]').forEach(button => { button.textContent = 'Read aloud'; });
}

function speakMessage(msg) {
  const synth = window.speechSynthesis;
  if (!synth) {
    showToast('Read aloud is not supported in this browser.', 'error');
    return;
  }
  const stopping = spokenMessage === msg;
  stopVoiceInput();
  if (stopping) return;

  const text = toSpeechText(stripThinkTags(getMsgText(msg)).content);
  if (!text) {
    showToast('Nothing to read in this message.');
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  const reset = () => {
    if (speechUtterance === utterance) stopReadAloud();
  };
  utterance.onend = reset;
  utterance.onerror = reset;
  spokenMessage = msg;
  speechUtterance = utterance;
  try { synth.speak(utterance); }
  catch (error) {
    reset();
    showToast('Could not read this message aloud.', 'error');
  }
}

function formatTokenCount(tokens) {
  const value = Number(tokens) || 0;
  if (value >= 1000000) return (value / 1000000).toFixed(1) + 'm';
  if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
  return String(value);
}

function getMessageTokenCount(msg) {
  if (!msg) return 0;
  if (msg.role === 'assistant' && msg.swipeTokenEstimates && Number.isFinite(msg.swipeTokenEstimates[msg.swipeIndex])) {
    return msg.swipeTokenEstimates[msg.swipeIndex];
  }
  if (Number.isFinite(msg.tokenEstimate)) return msg.tokenEstimate;
  return estimateTokens(getMsgText(msg));
}

function updateMessageTokenMetadata(msg, swipeIdx = msg?.swipeIndex || 0) {
  if (!msg) return;
  const tokenEstimate = estimateTokens(getMsgText(msg));
  msg.tokenEstimate = tokenEstimate;
  if (msg.role === 'assistant') {
    msg.swipeTokenEstimates = msg.swipeTokenEstimates || [];
    msg.swipeTokenEstimates[swipeIdx] = tokenEstimate;
  }
}

function getMessageLlmInfo(msg) {
  if (!msg || msg.role !== 'assistant') return null;
  const swipeInfo = msg.swipeLlms && msg.swipeLlms[msg.swipeIndex];
  if (swipeInfo) return swipeInfo;
  if (msg.llm) return msg.llm;
  if (msg.model) {
    const format = msg.apiFormat || detectApiFormat(msg.model);
    const provider = getLlmProviderInfo(msg.model, format, localStorage.getItem('llmProxyUrl') || '');
    return {
      model: msg.model,
      apiFormat: format,
      providerName: provider.name,
      providerSymbol: provider.symbol,
      profileName: ''
    };
  }
  return null;
}

function renderMessageMeta(msg) {
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  let hasMeta = false;

  const llm = getMessageLlmInfo(msg);
  if (llm) {
    const llmBadge = document.createElement('span');
    llmBadge.className = 'msg-meta-pill llm-badge';
    const symbol = document.createElement('span');
    symbol.className = 'llm-symbol';
    symbol.textContent = llm.providerSymbol || '?';
    const label = document.createElement('span');
    label.textContent = (llm.providerName || 'Model') + ' | ' + formatModelForDisplay(llm.model || '');
    llmBadge.title = 'LLM used: ' + (llm.providerName || 'Model') + (llm.model ? ' (' + llm.model + ')' : '') + (llm.profileName ? ' via ' + llm.profileName : '');
    llmBadge.setAttribute('aria-label', llmBadge.title);
    llmBadge.appendChild(symbol);
    llmBadge.appendChild(label);
    meta.appendChild(llmBadge);
    hasMeta = true;
  }

  const tokenCount = getMessageTokenCount(msg);
  if (tokenCount > 0 || getMsgText(msg)) {
    const tokenEl = document.createElement('span');
    tokenEl.className = 'msg-meta-pill';
    tokenEl.textContent = '~' + formatTokenCount(tokenCount) + ' tokens';
    tokenEl.title = 'Estimated message tokens';
    meta.appendChild(tokenEl);
    hasMeta = true;
  }

  if (msg.timestamp) {
    const tsEl = document.createElement('span');
    tsEl.className = 'msg-meta-pill msg-timestamp';
    tsEl.textContent = formatRelativeTime(msg.timestamp);
    tsEl.title = new Date(msg.timestamp).toLocaleString();
    meta.appendChild(tsEl);
    hasMeta = true;
  }

  return hasMeta ? meta : null;
}

function getSwipeRequest(msg, swipeIdx = msg?.swipeIndex || 0) {
  return msg?.swipeRequests?.[swipeIdx] || null;
}

function renderRequestMeta(msg) {
  const request = getSwipeRequest(msg);
  if (!request) return null;
  const meta = document.createElement('div');
  meta.className = 'request-meta request-' + (request.status || 'complete');
  const duration = Number.isFinite(request.durationMs) ? ' · ' + (request.durationMs / 1000).toFixed(1) + 's' : '';
  const status = request.status || 'complete';
  meta.textContent = status + duration + (request.httpStatus ? ' · HTTP ' + request.httpStatus : '');
  meta.setAttribute('aria-label', 'Request ' + status + (duration ? duration : ''));
  meta.title = request.error || (request.startedAt ? new Date(request.startedAt).toLocaleString() : '');
  return meta;
}

function showRequestDetails(request) {
  if (!request) return;
  document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove());
  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  const popup = document.createElement('div');
  popup.className = 'char-info-popup request-details-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-modal', 'true');
  popup.setAttribute('aria-labelledby', 'requestDetailsTitle');
  const rows = [
    ['Request ID', request.requestId || '—'],
    ['Status', request.status || 'unknown'],
    ['Model', request.model || '—'],
    ['API format', request.apiFormat || '—'],
    ['Messages sent', request.messageCount ?? '—'],
    ['Estimated prompt', request.promptTokens ? formatTokenCount(request.promptTokens) + ' tokens' : '—'],
    ['Context window', request.contextWindow ? formatTokenCount(request.contextWindow) + ' tokens' : '—'],
    ['Started', request.startedAt ? new Date(request.startedAt).toLocaleString() : '—'],
    ['Completed', request.completedAt ? new Date(request.completedAt).toLocaleString() : '—'],
    ['Duration', Number.isFinite(request.durationMs) ? (request.durationMs / 1000).toFixed(2) + ' seconds' : '—'],
    ['HTTP status', request.httpStatus || '—'],
    ['Error detail', request.error || '—']
  ];
  const heading = document.createElement('h3');
  heading.id = 'requestDetailsTitle';
  heading.textContent = 'Request details';
  popup.appendChild(heading);
  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'request-detail-row';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const span = document.createElement('span');
    span.textContent = value;
    row.append(strong, span);
    popup.appendChild(row);
  });
  const close = document.createElement('button');
  close.className = 'btn btn-primary';
  close.type = 'button';
  close.textContent = 'Close';
  popup.appendChild(close);
  const closeDialog = openTransientDialog(overlay, popup, close);
  close.onclick = closeDialog;
}

async function retryRequest(idx) {
  if (readOnlyShare || !beginSendingAction()) return;
  try {
    const msg = messages[idx];
    if (!msg || msg.role !== 'assistant') return;
    if (msg.comparison === true) {
      showToast('Comparison responses cannot be retried with the active provider.', 'info');
      return;
    }
    const conv = getActiveConv();
    const messageList = messages;
    const original = getSwipeRequest(msg);
    let target = requestTargets.get(original);
    if (!target) {
      const saved = original?.connection;
      if (!saved?.baseUrl) throw new Error('The original connection was not recorded. Use Regenerate to choose the current provider.');
      target = buildRequestTarget({
        llmProvider: saved.provider, llmProxyUrl: saved.baseUrl, llmApiFormat: saved.apiFormat, llmModel: saved.model,
        llmTemperature: saved.temperature, llmMaxTokens: saved.maxTokens, llmContextWindow: saved.contextWindow, llmCorsProxy: saved.corsProxy
      }, { profileId: saved.profileId, profileName: saved.profileName });
      let active = null;
      try { active = getActiveRequestTarget(); } catch (error) {}
      target = Object.freeze({ ...target, apiKey: resolveRequestTargetKey(target, active) });
    }
    if (target.keyRequired && !target.apiKey) throw new Error('Reconnect to ' + target.host + ' before retrying this request.');
    const toolPolicy = getToolPolicy(conv);
    const requestContext = await buildRequestMessages(conv, { messageList: messageList.slice(), untilIndex: idx });
    assertRequestOwner(conv, messageList, msg);
    if (guardTargetContextLimit(requestContext.messages, target, target.maxTokens || 8192)) return;
    const swipeIdx = addAssistantSwipe(msg);
    renderMessages();
    const wrapper = document.querySelector('.msg-wrapper[data-msg-idx="' + idx + '"]');
    const bubble = wrapper?.querySelector('.msg-bubble');
    if (!bubble) return;
    bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    announce('Retrying the failed request.');
    const status = await streamResponse(requestContext.messages, msg, swipeIdx, bubble, target.model, null, { conv, messageList, target, toolPolicy });
    assertRequestOwner(conv, messageList, msg, null);
    if (conv) conv.updatedAt = Date.now();
    if (status === 'complete') extractMemories(requestContext.messages, conv, target);
    await saveConversationImmediately();
    renderMessages({ preserveScroll: true });
    updateTokenInfo();
    return status;
  } catch (error) {
    if (foregroundAction) foregroundAction.status = error.name === 'AbortError' ? 'stopped' : error.requestStatus || 'failed';
    if (error.name !== 'AbortError') showToast(sanitizeErrorDetail(error), 'error');
  } finally {
    endSendingAction();
  }
}

async function updateTokenInfo() {
  const el = document.getElementById('tokenInfo');
  if (!el) return;
  const requestId = ++tokenInfoRequestId;
  const inputText = document.getElementById('chatInput').value;
  const inputChars = inputText.length;

  const parts = [];
  if (inputChars > 0) {
    const inputTokens = estimateTokens(inputText);
    parts.push(inputChars + (inputChars === 1 ? ' char' : ' chars'));
    parts.push('~' + (inputTokens > 999 ? (inputTokens / 1000).toFixed(1) + 'k' : inputTokens) + ' tokens');
  }

  let total = 0;
  messages.forEach(m => { total += estimateTokens(getMsgText(m)); });
  if (total > 0 || messages.length > 0) {
    parts.push('Conv: ~' + (total > 999 ? (total / 1000).toFixed(1) + 'k' : total) + ' tokens');
  }

  // Project instructions and files are re-sent on every request, so surface them —
  // otherwise the cost is completely invisible in this bar.
  const tokenConv = getActiveConv();
  const activeProject = isTemporaryConversation(tokenConv) ? null : getProject((tokenConv || {}).projectId);
  if (activeProject) {
    const projTokens = estimateTokens((activeProject.instructions || '') + '\n' + projectDocsSystemText(activeProject));
    if (projTokens > 0) parts.push('Proj: ~' + formatTokenCount(projTokens) + ' tokens/msg');
  }

  const inputCost = parseFloat(localStorage.getItem('llmInputCost') || '0');
  const outputCost = parseFloat(localStorage.getItem('llmOutputCost') || '0');
  if ((inputCost > 0 || outputCost > 0) && total > 0) {
    let cost = 0;
    messages.forEach(m => {
      const t = estimateTokens(getMsgText(m));
      cost += t * ((m.role === 'assistant' ? outputCost : inputCost) / 1000000);
    });
    parts.push('~$' + cost.toFixed(4));
  }
  let promptPart = '';
  try {
    const built = await buildRequestMessages(getActiveConv(), { messageList: messages, draftMessage: buildComposerMessage() });
    const stats = getRequestContextStats(built.messages, built.excluded);
    const limit = stats.contextWindow ? ' / ' + formatTokenCount(stats.contextWindow) : '';
    promptPart = 'Prompt: ~' + formatTokenCount(stats.includedTokens) + limit;
  } catch (e) {
    // Token display is advisory; keep the local estimate if system context is unavailable.
  }
  if (requestId === tokenInfoRequestId) el.textContent = parts.concat(promptPart ? [promptPart] : []).join(' | ');
}

// ============================================
// IndexedDB Storage Layer
// ============================================
const DB_NAME = 'assistantDB';
// Older tabs must not write records whose revision metadata they cannot maintain.
const DB_VERSION = 4;
let db = null;
let conversationBaseline = new Map();
let conversationSaveChain = Promise.resolve();
let conversationChannel = null;
let conversationStorageBlocked = false;
let persistenceErrorShown = false;
const conversationWriters = new Map();
const notifiedConversationConflicts = new Set();

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('conversations')) d.createObjectStore('conversations', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('memories')) d.createObjectStore('memories', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (d.objectStoreNames.contains('responseCache')) d.deleteObjectStore('responseCache');
    };
    req.onsuccess = (e) => {
      const opened = e.target.result;
      if (settled) { opened.close(); return; }
      settled = true;
      db = opened;
      db.onversionchange = () => {
        db.close();
        db = null;
        conversationStorageBlocked = true;
        showToast('Storage was updated in another tab. Reload before making more changes.', 'error', 0);
      };
      resolve(db);
    };
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      conversationStorageBlocked = true;
      reject(new Error('IndexedDB upgrade is blocked by another open tab.'));
    };
    req.onerror = (e) => {
      if (settled) return;
      settled = true;
      reject(e.target.error);
    };
  });
}

function idbPut(store, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    s.put(data);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage write was aborted.'));
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const s = tx.objectStore(store);
    const req = s.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const s = tx.objectStore(store);
    const req = s.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    s.delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage deletion was aborted.'));
  });
}

function idbClear(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage deletion was aborted.'));
  });
}

function idbPutAll(store, items, valid = () => true, removals = []) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([store, 'meta'], 'readwrite');
    const s = tx.objectStore(store);
    const request = s.getAll();
    const ledger = tx.objectStore('meta').get('syncTombstones');
    let pending = 2;
    let failure;
    let committedTombstones;
    const write = () => {
      if (--pending) return;
      try {
        if (!valid()) return;
        const tombstones = syncMergeTombstones(ledger.result?.value, syncLoadTombstones());
        removals.forEach(memory => {
          tombstones.memories[memory.id] = Math.max(Number(tombstones.memories[memory.id]) || 0, Date.now(), memory.createdAt);
        });
        // All memory removals have deletion records; an omitted ID may be another tab's addition.
        const records = store === 'memories' ? syncMergeMemoryLists(request.result, items, tombstones.memories) : items;
        const ids = new Set(records.map(record => record.id));
        request.result.forEach(record => { if (!ids.has(record.id)) s.delete(record.id); });
        records.forEach(record => s.put(record));
        tx.objectStore('meta').put({ key: 'syncTombstones', value: tombstones });
        committedTombstones = tombstones;
      } catch (error) { failure = error; tx.abort(); }
    };
    request.onsuccess = ledger.onsuccess = write;
    tx.oncomplete = () => {
      if (committedTombstones) {
        try { syncSaveTombstones(syncMergeTombstones(syncLoadTombstones(), committedTombstones)); }
        catch (error) { console.warn('Deletion records remain in the database:', error); }
        broadcastPersistenceChange();
      }
      resolve();
    };
    tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Storage write was aborted.'));
  });
}

function serializeConversation(conv) {
  return JSON.stringify(conv, (key, value) => {
    if (key === '_editing') return undefined;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value;
  });
}

function serializeConversationRecord(conv) {
  return serializeConversation(normalizeConversationRecord(conv));
}

function setConversationBaseline(items) {
  conversationWriters.clear();
  conversationBaseline = new Map((items || []).filter(conv => !isTemporaryConversation(conv)).map(conv => [conv.id, serializeConversationRecord(conv)]));
}

function getConversationChanges() {
  const current = new Map();
  const changed = [];
  getPersistentConversations().forEach(record => {
    if (!conversationBaseline.has(record.id) && record.conflictOf && !record.id.startsWith('conflict_')) {
      // Duplicating or forking a conflict copy creates an independent chat.
      delete record.conflictOf;
      delete record.conflictTitle;
      delete record.syncVersion;
    }
    const json = serializeConversationRecord(record);
    current.set(record.id, json);
    const baseline = conversationBaseline.get(record.id);
    if (baseline !== json) changed.push({ record: JSON.parse(json), json, baseline });
  });
  const deletedIds = [...conversationBaseline.keys()].filter(id => !current.has(id));
  return { changed, deletedIds, current };
}

function conversationContent(conv) {
  const record = normalizeConversationRecord(conv);
  if (record.conflictTitle && record.title === record.conflictTitle + ' (conflict copy)') record.title = record.conflictTitle;
  ['id', 'createdAt', 'updatedAt', 'syncVersion', 'conflictOf', 'conflictTitle', 'shareGistId', 'shareUrl', 'shareId'].forEach(key => delete record[key]);
  delete record.draft.updatedAt;
  return serializeConversation(record);
}

function compareConversationVersions(left, right) {
  const a = left?.syncVersion || {};
  const b = right?.syncVersion || {};
  if (!Object.keys(a).length || !Object.keys(b).length) return null;
  let ahead = false;
  let behind = false;
  new Set([...Object.keys(a), ...Object.keys(b)]).forEach(key => {
    if ((a[key] || 0) > (b[key] || 0)) ahead = true;
    if ((a[key] || 0) < (b[key] || 0)) behind = true;
  });
  return ahead && behind ? null : ahead ? 1 : behind ? -1 : 0;
}

function normalizeConversationVersion(value) {
  return Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(([key, count]) =>
    /^[A-Za-z0-9._:-]{1,160}$/.test(key) && Number.isSafeInteger(count) && count > 0));
}

function chooseConversationWinner(local, existing, baseline) {
  if (!existing || serializeConversation(existing) === baseline || serializeConversationRecord(existing) === baseline) return local;
  if (conversationContent(local) === conversationContent(existing)) return existing;
  if (baseline && conversationContent(local) === conversationContent(JSON.parse(baseline))) return existing;
  if (serializeConversation(local) === baseline) return existing;
  const order = compareConversationVersions(local, existing);
  return order === 1 ? local : order === -1 ? existing : null;
}

function makeConversationConflict(record, id) {
  const copy = JSON.parse(serializeConversation(record));
  copy.id = id;
  copy.conflictOf = record.conflictOf || record.id;
  copy.conflictTitle = record.conflictTitle && record.title === record.conflictTitle + ' (conflict copy)' ? record.conflictTitle : record.title;
  copy.title = (copy.conflictTitle || 'Chat') + ' (conflict copy)';
  delete copy.shareGistId;
  delete copy.shareUrl;
  delete copy.shareId;
  return copy;
}

async function conversationConflictId(record) {
  const content = (record.conflictOf || record.id) + ':' + conversationContent(record);
  return 'conflict_' + (window.crypto?.subtle ? await syncSha256Hex(content) : genId());
}

function reconcileConversationRecord(byId, incoming, conflictId, baseline, deleted = false, localIds = null) {
  const exact = byId.get(incoming.id);
  if (!deleted && exact && serializeConversationRecord(exact) === baseline) {
    byId.set(incoming.id, incoming);
    return incoming;
  }
  const root = incoming.conflictOf || incoming.id;
  // ponytail: scan loaded records for related branches; index by conflictOf if large histories need it.
  const family = [...byId.values()].filter(record => (record.id === root || record.conflictOf === root || record.id === incoming.id) &&
    (record.id === incoming.id || !localIds?.has(record.id)));
  for (const current of family) {
    const winner = chooseConversationWinner(incoming, current, current.id === incoming.id ? baseline : undefined);
    if (winner === current) {
      if (conversationContent(incoming) === conversationContent(current)) {
        const version = { ...current.syncVersion };
        Object.entries(incoming.syncVersion || {}).forEach(([key, value]) => { version[key] = Math.max(version[key] || 0, value); });
        const same = { ...current, syncVersion: version, updatedAt: Math.max(current.updatedAt || 0, incoming.updatedAt || 0) };
        byId.set(current.id, same);
        return same;
      }
      return current;
    }
    if (winner === incoming) {
      const next = current.conflictOf || current.id !== incoming.id ? makeConversationConflict(incoming, current.id) : incoming;
      byId.set(next.id, next);
      return next;
    }
  }
  if (!exact && !deleted) {
    byId.set(incoming.id, incoming);
    return incoming;
  }
  const prefix = conflictId;
  let suffix = 0;
  while (byId.has(conflictId)) conflictId = prefix + '_' + (++suffix);
  const copy = makeConversationConflict(incoming, conflictId);
  byId.set(copy.id, copy);
  return copy;
}

function broadcastPersistenceChange() {
  try { conversationChannel?.postMessage({ refresh: true }); }
  catch (error) { console.warn('Could not notify other tabs:', error); }
}

function idbApplyConversationChanges(changed, deletions, tombstones, localIds) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['conversations', 'meta'], 'readwrite');
    const store = tx.objectStore('conversations');
    const request = store.getAll();
    const ledger = tx.objectStore('meta').get('syncTombstones');
    let pending = 2;
    let result;
    let failure;
    const write = () => {
      if (--pending) return;
      try {
        const before = new Map(request.result.map(record => [record.id, record]));
        const records = new Map(before);
        const mergedTombstones = syncMergeTombstones(ledger.result?.value, tombstones);
        const applied = [];
        const conflicts = [];
        changed.forEach(({ record, baseline, conflictId }) => {
          const deleted = !records.has(record.id) && (baseline !== undefined || Number(mergedTombstones.conversations[record.id]) >= Number(record.updatedAt));
          const saved = reconcileConversationRecord(records, record, conflictId, baseline, deleted, localIds);
          localIds?.add(saved.id);
          applied.push({ fromId: record.id, record: saved });
          if (saved.id !== record.id && saved.conflictOf) conflicts.push(saved.id);
        });
        deletions.forEach(({ id, deletedAt, baseline }) => {
          const existing = records.get(id);
          const base = JSON.parse(baseline || 'null');
          const diverged = existing && conversationContent(existing) !== conversationContent(base);
          if (diverged) {
            const copy = makeConversationConflict(existing, 'conflict_' + (window.crypto?.randomUUID?.() || genId()));
            records.set(copy.id, copy);
            conflicts.push(copy.id);
          }
          records.delete(id);
          mergedTombstones.conversations[id] = Math.max(Number(mergedTombstones.conversations[id]) || 0, deletedAt, Number(existing?.updatedAt) || 0, Number(base?.updatedAt) || 0);
          const seen = normalizeConversationVersion((diverged ? base : existing || base)?.syncVersion);
          const previous = mergedTombstones.conversationVersions[id] || {};
          Object.entries(seen).forEach(([writer, count]) => { previous[writer] = Math.max(Number(previous[writer]) || 0, count); });
          mergedTombstones.conversationVersions[id] = previous;
          mergedTombstones.conversationRoots[id] = (base || existing)?.conflictOf || id;
        });
        const writtenRecords = [...records.values()].filter(record => serializeConversation(record) !== serializeConversation(before.get(record.id)));
        const deletedIds = [...before.keys()].filter(id => !records.has(id));
        writtenRecords.forEach(record => store.put(record));
        deletedIds.forEach(id => store.delete(id));
        tx.objectStore('meta').put({ key: 'syncTombstones', value: mergedTombstones });
        tx.objectStore('meta').put({ key: 'activeConvId', value: getPersistentActiveConvId() });
        result = { records: [...records.values()], writtenRecords, deletedIds, applied, conflicts, tombstones: mergedTombstones };
      } catch (error) { failure = error; tx.abort(); }
    };
    request.onsuccess = ledger.onsuccess = write;
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Conversation save was aborted.'));
  });
}

function reportPersistenceError(error) {
  console.error('Conversation save error:', error);
  if (persistenceErrorShown) return;
  persistenceErrorShown = true;
  showToast('Changes could not be saved. Keep this tab open and retry after freeing storage or reloading.', 'error', 0);
}

function persistConversationState(refresh = false) {
  if (readOnlyShare) return Promise.resolve();
  if (conversationStorageBlocked) return Promise.reject(new Error('Conversation storage is unavailable until reload.'));
  try { localStorage.setItem('assistantActiveConvId', getPersistentActiveConvId()); } catch(e) {}

  const run = conversationSaveChain.then(async () => {
    if (conversationStorageBlocked) throw new Error('Conversation storage is unavailable until reload.');
    const { changed, deletedIds, current: captured } = getConversationChanges();
    if (!changed.length && !deletedIds.length && !refresh) {
      if (db) await idbPut('meta', { key: 'activeConvId', value: getPersistentActiveConvId() });
      persistenceErrorShown = false;
      return;
    }
    const now = Date.now();
    const tombstones = syncLoadTombstones();
    const deletions = deletedIds.map(id => ({ id, deletedAt: Number(tombstones.conversations[id]) || now, baseline: conversationBaseline.get(id) }));
    for (const entry of changed) {
      const base = JSON.parse(entry.baseline || 'null') || entry.record;
      if (!conversationWriters.has(entry.record.id)) conversationWriters.set(entry.record.id, window.crypto?.randomUUID?.() || genId());
      const writerId = conversationWriters.get(entry.record.id);
      entry.record.syncVersion = { ...(entry.record.syncVersion || base.syncVersion) };
      if (entry.baseline !== undefined && !Object.keys(base.syncVersion || {}).length) entry.record.syncVersion['legacy:' + await conversationConflictId(base)] = 1;
      entry.record.syncVersion[writerId] = (entry.record.syncVersion[writerId] || 0) + 1;
      entry.record.updatedAt = Math.max(now, Number(entry.record.updatedAt) || 0, Number(JSON.parse(entry.baseline || 'null')?.updatedAt || 0) + 1);
      entry.conflictId = 'conflict_' + (window.crypto?.randomUUID?.() || genId());
    }
    if (conversationStorageBlocked) throw new Error('Conversation storage is unavailable until reload.');
    let result;
    const localIds = new Set(captured.keys());
    if (db) result = await idbApplyConversationChanges(changed, deletions, tombstones, localIds);
    else {
      const records = new Map(syncFilterDeletedRecords(normalizeLoadedConversations(JSON.parse(localStorage.getItem('assistantConversations') || '[]')).conversations, tombstones.conversations, 'updatedAt').map(record => [record.id, record]));
      const applied = changed.map(({ record, baseline, conflictId }) => {
        const saved = reconcileConversationRecord(records, record, conflictId, baseline, !records.has(record.id) && baseline !== undefined, localIds);
        localIds.add(saved.id);
        return { fromId: record.id, record: saved };
      });
      deletions.forEach(({ id, deletedAt, baseline }) => {
        const existing = records.get(id);
        if (existing && conversationContent(existing) !== conversationContent(JSON.parse(baseline || 'null'))) {
          const copy = makeConversationConflict(existing, 'conflict_' + (window.crypto?.randomUUID?.() || genId()));
          records.set(copy.id, copy);
        }
        records.delete(id);
        tombstones.conversations[id] = Math.max(deletedAt, Number(existing?.updatedAt) || 0);
      });
      result = { records: [...records.values()], applied, writtenRecords: changed, deletedIds, tombstones, conflicts: applied.filter(item => item.record.id !== item.fromId).map(item => item.record.id) };
      localStorage.setItem('assistantConversations', JSON.stringify(result.records));
    }
    const removedDuringSave = new Set([...captured.keys()].filter(id => !conversations.some(conv => conv.id === id)));
    let reconciled = false;
    const deferredIds = new Set();
    const committedLocalIds = new Set();
    // ponytail: file reads are counted globally, so keep loaded chats stable until they finish.
    const hasPendingWork = id => pendingAttachmentReads > 0 || (id === activeConvId && (sending || streaming || queueingFollowUp));
    const appliedIds = new Set(result.applied.map(item => item.record.id));
    result.applied.forEach(({ fromId, record }) => {
      const keptLocalContent = conversationContent(record) === conversationContent(JSON.parse(captured.get(fromId)));
      if (keptLocalContent) {
        committedLocalIds.add(record.id);
        if (removedDuringSave.has(fromId)) removedDuringSave.add(record.id);
      }
      const local = conversations.find(conv => conv.id === fromId && !isTemporaryConversation(conv));
      if (!local) return;
      if (!keptLocalContent) {
        if (serializeConversationRecord(local) !== captured.get(fromId) || hasPendingWork(fromId)) {
          deferredIds.add(fromId);
          return;
        }
        conversations = conversations.filter(conv => conv !== local);
        if (activeConvId === fromId) activeConvId = record.id;
        reconciled = true;
        return;
      }
      if (record.id !== fromId) {
        // A fork keeps its writer; editing the other branch must use a different writer.
        const writerId = conversationWriters.get(fromId);
        conversationWriters.delete(fromId);
        if (writerId) conversationWriters.set(record.id, writerId);
        if (local.title === JSON.parse(captured.get(fromId)).title) local.title = record.title;
        local.id = record.id;
        local.conflictOf = record.conflictOf;
        local.conflictTitle = record.conflictTitle;
        delete local.shareGistId;
        delete local.shareUrl;
        delete local.shareId;
        if (activeConvId === fromId) activeConvId = record.id;
        reconciled = true;
      }
      local.syncVersion = record.syncVersion;
      local.updatedAt = Math.max(Number(local.updatedAt) || 0, Number(record.updatedAt) || 0);
    });
    const storedIds = new Set(result.records.map(record => record.id));
    result.records.forEach(record => {
      let json;
      try { json = serializeConversationRecord(record); }
      catch (error) { console.warn('Unreadable chat left in storage:', record.id, error); return; }
      const index = conversations.findIndex(conv => conv.id === record.id && !isTemporaryConversation(conv));
      if (removedDuringSave.has(record.id)) {
        if (committedLocalIds.has(record.id)) conversationBaseline.set(record.id, json);
        return;
      }
      if (deferredIds.has(record.id)) return;
      if (index !== -1 && hasPendingWork(record.id) && !appliedIds.has(record.id)) return;
      if (index !== -1 && captured.has(record.id) && serializeConversationRecord(conversations[index]) !== captured.get(record.id) && !appliedIds.has(record.id)) return;
      if (index === -1 && !removedDuringSave.has(record.id)) {
        try { conversations.unshift(normalizeConversationRecord(record)); }
        catch (error) { console.warn('Unreadable chat left in storage:', record.id, error); return; }
        reconciled = true;
      } else if (index !== -1 && captured.get(record.id) === serializeConversationRecord(conversations[index]) && json !== captured.get(record.id)) {
        conversations[index] = normalizeConversationRecord(record);
        reconciled = true;
      }
      conversationBaseline.set(record.id, json);
    });
    for (const id of conversationBaseline.keys()) {
      if (storedIds.has(id)) continue;
      const local = conversations.find(conv => conv.id === id && !isTemporaryConversation(conv));
      if (local && (hasPendingWork(id) || deferredIds.has(id) || serializeConversationRecord(local) !== captured.get(id))) continue;
      conversations = conversations.filter(conv => conv !== local);
      conversationBaseline.delete(id);
      conversationWriters.delete(id);
      if (local) reconciled = true;
    }
    try { syncSaveTombstones(syncMergeTombstones(syncLoadTombstones(), result.tombstones)); }
    catch (error) { console.warn('Could not mirror deletion records:', error); }
    if (reconciled) refreshConversationStateAfterExternalChange();
    notifyConversationConflicts(getPersistentConversations().filter(record => record.conflictOf).map(record => record.id));
    if (result.writtenRecords.length || result.deletedIds.length) {
      broadcastPersistenceChange();
      syncScheduleAutoPush();
    }
    persistenceErrorShown = false;
  });
  conversationSaveChain = run.catch(() => {});
  return run;
}

function initConversationChannel() {
  if (!db || typeof BroadcastChannel === 'undefined' || conversationChannel) return;
  conversationChannel = new BroadcastChannel('synapse-conversations');
  conversationChannel.onmessage = () => {
    // Read the committed database, not an out-of-order broadcast. Dirty chats use the same arbitration as saves.
    persistDraftFromUI();
    persistConversationState(true).then(() => saveProjects(true)).catch(reportPersistenceError);
  };
}

function notifyConversationConflicts(ids) {
  const fresh = (ids || []).filter(id => !notifiedConversationConflicts.has(id));
  if (!fresh.length) return;
  fresh.forEach(id => notifiedConversationConflicts.add(id));
  showToast('Conflicting edits were kept as separate chats. Which would you like to continue?', 'info', 0, {
    label: 'Choose chat',
    onClick: () => {
      const roots = new Set(fresh.map(id => conversations.find(conv => conv.id === id)?.conflictOf));
      const choices = conversations.filter(conv => fresh.includes(conv.id) || roots.has(conv.id) || roots.has(conv.conflictOf));
      const overlay = document.createElement('div');
      overlay.className = 'char-info-overlay';
      const popup = document.createElement('div');
      popup.className = 'char-info-popup';
      popup.setAttribute('aria-label', 'Choose which saved chat to continue');
      const heading = document.createElement('h3');
      heading.textContent = 'Choose a chat to continue';
      popup.appendChild(heading);
      let close;
      choices.forEach(conv => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-secondary';
        button.textContent = conv.title + ' (' + conv.messages.length + ' messages' + (conv.draft?.text ? ', draft saved' : '') + ')';
        button.onclick = () => {
          if (sending || streaming || _syncPullInFlight) { showToast('Finish the current operation before switching chats.', 'info'); return; }
          close();
          setConversationView(conv.archivedAt ? 'archived' : 'active');
          switchConversation(conv.id);
        };
        popup.appendChild(button);
      });
      close = openTransientDialog(overlay, popup, popup.querySelector('button'));
    }
  });
}

function refreshConversationStateAfterExternalChange() {
  armedFollowUpConversationIds.clear();
  if (!conversations.length) {
    const conv = { id: genId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    conversations.push(conv);
  }
  if (!conversations.some(conv => conv.id === activeConvId)) activeConvId = conversations[0].id;
  messages = getActiveConv().messages;
  renderSidebar();
  if (sending || streaming || queueingFollowUp || pendingAttachmentReads > 0) return;
  renderMessages({ preserveScroll: true });
  updateCharacterUI();
  restoreActiveDraft();
}

function formatCacheBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return (unit === 0 ? value : value.toFixed(value >= 10 ? 1 : 2)) + ' ' + units[unit];
}

// ============================================
// Conversation Management
// ============================================
function genId() { return 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

function saveConversations() {
  const pending = persistConversationState();
  pending.catch(reportPersistenceError);
  return pending;
}

let _saveDebounceTimer;
function debouncedSave() {
  clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(saveConversations, 1000);
}

function recoverInterruptedRequests(convs) {
  let changed = false;
  (convs || []).forEach(conv => {
    (conv.messages || []).forEach(message => {
      if (message.role !== 'assistant') return;
      if (!Array.isArray(message.swipeRequests)) message.swipeRequests = [];
      const swipeIndex = Number.isInteger(message.swipeIndex) ? message.swipeIndex : 0;
      const currentText = Array.isArray(message.swipes) ? message.swipes[swipeIndex] : message.content;
      if (!String(currentText || '').trim() && !(message.images || []).length && !message.swipeRequests[swipeIndex]) {
        const completedAt = Date.now();
        message.swipeRequests[swipeIndex] = {
          status: 'failed',
          startedAt: Number(message.timestamp) || completedAt,
          completedAt,
          durationMs: Number(message.timestamp) ? Math.max(0, completedAt - Number(message.timestamp)) : null,
          httpStatus: null,
          error: 'No response was saved before the request ended.'
        };
        if (Array.isArray(message.swipes)) message.swipes[swipeIndex] = 'Request failed before a response was saved. Retry to try again.';
        message.content = Array.isArray(message.swipes) ? message.swipes[swipeIndex] : message.content;
        changed = true;
      }
      message.swipeRequests.forEach((request, index) => {
        if (!request || !['pending', 'streaming'].includes(request.status)) return;
        request.status = 'failed';
        request.error = 'Interrupted before the page closed.';
        request.completedAt = request.completedAt || Date.now();
        request.durationMs = request.startedAt ? Math.max(0, request.completedAt - request.startedAt) : null;
        if (Array.isArray(message.swipes) && !String(message.swipes[index] || '').trim()) {
          message.swipes[index] = 'Request interrupted. Retry to try again.';
          message.content = message.swipes[message.swipeIndex || 0] || '';
        }
        changed = true;
      });
    });
  });
  return changed;
}

function migrateLegacyBranches(convs, usedIds) {
  const forks = [];
  let changed = false;
  convs.forEach(conv => {
    conv.messages.forEach((message, messageIndex) => {
      const branches = Array.isArray(message.branches) ? message.branches : [];
      if (!branches.length) return;
      changed = true;
      const currentBranch = Number.isInteger(message.branchIndex) ? message.branchIndex : -1;
      branches.forEach((branch, branchIndex) => {
        if (branchIndex === currentBranch || !Array.isArray(branch) || !branch.length) return;
        let id = genId();
        while (usedIds.has(id)) id = genId();
        usedIds.add(id);
        const now = Date.now();
        const fork = normalizeConversationRecord({
          ...JSON.parse(JSON.stringify(conv)),
          id,
          title: (conv.title || 'Chat') + ' (legacy branch ' + (branchIndex + 1) + ')',
          messages: JSON.parse(JSON.stringify(conv.messages.slice(0, messageIndex).concat(branch))),
          createdAt: now,
          updatedAt: now
        });
        delete fork.draft;
        fork.queuedFollowUps = [];
        fork.parentConversationId = conv.id;
        fork.forkMessageIndex = messageIndex;
        fork.forkedAt = now;
        delete fork.shareGistId;
        delete fork.shareUrl;
        delete fork.shareId;
        fork.messages.forEach(item => {
          delete item._editing;
          delete item.branches;
          delete item.branchIndex;
        });
        forks.push(fork);
      });
    });
    conv.messages.forEach(message => {
      if (Array.isArray(message.branches) || Object.prototype.hasOwnProperty.call(message, 'branchIndex')) changed = true;
      delete message.branches;
      delete message.branchIndex;
    });
  });
  return { conversations: convs.concat(forks), changed };
}

function normalizeLoadedConversations(list) {
  const source = Array.isArray(list) ? list : [];
  const used = new Set();
  const normalized = [];
  source.forEach(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    try {
      let conv = normalizeConversationRecord(raw);
      if (used.has(conv.id)) {
        if (normalized.some(record => record.id === conv.id && conversationContent(record) === conversationContent(conv))) return;
        conv = makeConversationConflict(conv, 'conflict_' + (window.crypto?.randomUUID?.() || genId()));
      }
      used.add(conv.id);
      normalized.push(conv);
    } catch (error) { console.warn('Unreadable chat left in its source:', raw.id, error); }
  });
  const migrated = migrateLegacyBranches(normalized, used);
  const recovered = recoverInterruptedRequests(migrated.conversations);
  return {
    conversations: migrated.conversations,
    changed: migrated.changed || recovered
  };
}

function cloneDraftAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : []).filter(att => att && typeof att === 'object').map(att => ({
    type: att.type === 'image' ? 'image' : 'file',
    name: typeof att.name === 'string' ? att.name : 'file',
    mime: typeof att.mime === 'string' ? att.mime : '',
    dataUrl: typeof att.dataUrl === 'string' ? (att.type === 'image' ? safeMediaUrl(att.dataUrl) : safeFileUrl(att.dataUrl)) : '',
    textContent: typeof att.textContent === 'string' ? att.textContent : '',
    binary: att.binary === true,
    truncated: att.truncated === true
  }));
}

function queueAttachmentForConversation(convId, attachment) {
  const queued = cloneDraftAttachments([attachment])[0];
  if (!queued) return;
  if (convId === activeConvId) {
    pendingAttachments.push(queued);
    renderPreviews();
    return;
  }
  const conv = conversations.find(item => item.id === convId);
  if (!conv || readOnlyShare) return;
  conv.draft = conv.draft || { text: '', attachments: [] };
  conv.draft.attachments = cloneDraftAttachments(conv.draft.attachments).concat([queued]);
  conv.draft.updatedAt = Date.now();
  conv.updatedAt = Date.now();
  saveConversations();
  announce('Attachment added to the original conversation draft.');
}

function persistDraftFromUI() {
  const conv = getActiveConv();
  const input = document.getElementById('chatInput');
  if (!conv || !input || readOnlyShare) return;
  const text = input.value;
  const attachments = cloneDraftAttachments(pendingAttachments);
  const previousText = conv.draft?.text || '';
  const previousAttachments = cloneDraftAttachments(conv.draft?.attachments);
  if (text === previousText && JSON.stringify(attachments) === JSON.stringify(previousAttachments)) return false;
  if (!text && attachments.length === 0) delete conv.draft;
  else conv.draft = { text, attachments, updatedAt: Date.now() };
  conv.updatedAt = Date.now();
  debouncedSave();
  return true;
}

function restoreActiveDraft() {
  const input = document.getElementById('chatInput');
  const conv = getActiveConv();
  if (!input || !conv) return;
  const draft = conv.draft || {};
  clearModelOverride();
  input.value = draft.text || '';
  pendingAttachments = cloneDraftAttachments(draft.attachments);
  renderPreviews();
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  updateTokenInfo();
  updateSendBtnState();
  renderFollowUpQueue();
}

function migratePersonaField(convs) {
  let changed = false;
  convs.forEach(c => {
    if (c.characterSystemPrompt && !c.characterDescription) {
      // If we have the original card, rebuild character description and system prompt properly
      if (c.characterCard) {
        c.characterDescription = buildCharaDescription(c.characterCard);
        c.characterSystemPrompt = c.characterCard.system_prompt || '';
        if (!c.characterSystemPrompt) delete c.characterSystemPrompt;
      } else {
        c.characterDescription = c.characterSystemPrompt;
        delete c.characterSystemPrompt;
      }
      changed = true;
    }
  });
  return changed;
}

function finishConversationLoad(preferredActiveId) {
  if (!conversations.length) conversations.push({ id: genId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() });
  activeConvId = conversations.some(conv => conv.id === preferredActiveId) ? preferredActiveId : conversations[0].id;
  messages = getActiveConv().messages;
  renderSidebar();
  renderMessages();
  updateTokenInfo();
  updateCharacterUI();
  restoreActiveDraft();
}

async function loadConversations() {
  let stored = [];
  let preferredActiveId = localStorage.getItem('assistantActiveConvId');
  if (db) {
    try {
      await conversationSaveChain;
      stored = await idbGetAll('conversations');
      preferredActiveId = (await idbGet('meta', 'activeConvId'))?.value || preferredActiveId;
    } catch(e) {
      console.error('IDB load error:', e);
      conversationStorageBlocked = true;
      conversations = [];
      finishConversationLoad(null);
      showToast('Existing conversations could not be read safely. Storage is read-only until you reload.', 'error', 0);
      return;
    }
  }
  const normalizedStored = normalizeLoadedConversations(stored).conversations;
  conversationWriters.clear();
  const readableIds = new Set(normalizedStored.map(conv => conv.id));
  conversationBaseline = new Map(stored.filter(conv => readableIds.has(conv.id)).map(conv => [conv.id, serializeConversationRecord(conv)]));
  const fallback = [];
  const saved = localStorage.getItem('assistantConversations');
  let fallbackReadable = true;
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) throw new Error('Conversation backup is not a list.');
      if (!db) setConversationBaseline(parsed.filter(record => record && typeof record === 'object' && !Array.isArray(record)));
      fallback.push(...normalizeLoadedConversations(parsed).conversations);
    } catch (error) {
      fallbackReadable = false;
      console.error('Conversation fallback was retained:', error);
      showToast('A local conversation backup could not be read. It has not been removed.', 'error', 0);
    }
  }
  const legacy = localStorage.getItem('assistantChatHistory');
  let legacyReadable = false;
  if (legacy) {
    try {
      const history = JSON.parse(legacy);
      if (!Array.isArray(history)) throw new Error('Legacy history is not a list.');
      const id = 'legacy_' + (window.crypto?.subtle ? await syncSha256Hex(legacy) : 'chat_history');
      fallback.push(normalizeConversationRecord({ id, title: 'Chat', messages: history, createdAt: 1, updatedAt: 1 }));
      legacyReadable = true;
    } catch (e) { console.error('Failed to parse legacy chat:', e); }
  }
  // Fallback JSON may contain edits written before an IDB save completed, with an old version still attached.
  if (db) fallback.forEach(record => delete record.syncVersion);
  const tombstones = syncLoadTombstones();
  const recoveredFallback = (await syncMergeConversationLists([], fallback, tombstones.conversations, tombstones.conversationVersions, tombstones.conversationRoots)).conversations;
  const merged = await syncMergeConversationLists(normalizedStored, recoveredFallback);
  conversations = merged.conversations;
  migratePersonaField(conversations);
  finishConversationLoad(preferredActiveId);
  if (!db && !fallbackReadable) { conversationStorageBlocked = true; return; }
  // Source copies are removed only after the destination commits, and only if no other tab changed them.
  try {
    await persistConversationState();
    if (db && fallbackReadable && localStorage.getItem('assistantConversations') === saved) localStorage.removeItem('assistantConversations');
    if (legacyReadable && localStorage.getItem('assistantChatHistory') === legacy) localStorage.removeItem('assistantChatHistory');
    notifyConversationConflicts(conversations.filter(conv => conv.conflictOf).map(conv => conv.id));
  } catch(e) { reportPersistenceError(e); }
}

function getActiveConv() { return conversations.find(c => c.id === activeConvId); }

function prepareConversationTransition() {
  if (readOnlyShare) return false;
  if (_syncPullInFlight) { showToast('Wait for sync pull to finish.', 'info'); return false; }
  if (sending || streaming || queueingFollowUp) {
    showToast('Stop the current request before changing chats.', 'info');
    return false;
  }
  stopVoiceInput();
  persistDraftFromUI();
  return true;
}

function createConversation(projectId) {
  if (!prepareConversationTransition()) return;
  const conv = { id: genId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  // Only ever set from the per-project "+" in the sidebar; index.html calls this with
  // no argument, and a click event must not be mistaken for a project id.
  if (typeof projectId === 'string' && getProject(projectId)) conv.projectId = projectId;
  conversations.unshift(conv);
  activeConvId = conv.id;
  messages = conv.messages;
  saveConversations();
  renderSidebar();
  renderMessages();
  updateTokenInfo();
  updateCharacterUI();
  restoreActiveDraft();
  document.getElementById('chatInput')?.focus();
  announce('New conversation created.');
  if (window.innerWidth <= 768) toggleSidebar(false);
  if (window.innerWidth <= 1100) toggleContextPanel(false, false);
}

function createTemporaryConversation() {
  if (!prepareConversationTransition()) return;
  const conv = { id: genId(), title: 'Temporary chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  temporaryConversations.add(conv);
  conversations.unshift(conv);
  activeConvId = conv.id;
  messages = conv.messages;
  saveConversations();
  renderSidebar();
  renderMessages();
  updateTokenInfo();
  updateCharacterUI();
  restoreActiveDraft();
  document.getElementById('chatInput')?.focus();
  closeSidebarMenu();
  announce(TEMPORARY_CHAT_NOTICE);
  if (window.innerWidth <= 768) toggleSidebar(false);
  if (window.innerWidth <= 1100) toggleContextPanel(false, false);
}

function switchConversation(id) {
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;
  if (!prepareConversationTransition()) return;
  activeConvId = id;
  messages = conv.messages;
  userScrolledAway = false;
  saveConversations();
  renderSidebar();
  renderMessages();
  updateTokenInfo();
  updateCharacterUI();
  restoreActiveDraft();
  announce('Opened conversation ' + (conv.title || 'conversation') + '.');
  if (window.innerWidth <= 768) toggleSidebar(false);
  if (window.innerWidth <= 1100) toggleContextPanel(false, false);
}

function deleteConversation(id, e) {
  e?.stopPropagation();
  removeConversations([id]);
}

function clearAllConversations() {
  if (!confirm('Delete ALL conversations? Public share links are not revoked.')) return;
  removeConversations(conversations.map(c => c.id), false);
}

// ============================================
// Projects
// ============================================
// Stored as a single record in the existing `meta` store rather than a new object store.
// Save only this tab's changes, against the current record in a read/write transaction.

const PROJECT_DOC_CHAR_LIMIT = 20000;
const COLLAPSED_PROJECTS_KEY = 'assistantCollapsedProjectIds';
let _projectEditId = null;
let _projectAutosaveTimer = null;
let _projectSaveRevision = 0;
let _projectSaveChain = Promise.resolve();
let projectBaseline = new Map();

function getCollapsedProjectIds() {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) || '[]');
    return new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string') : []);
  } catch (e) {
    return new Set();
  }
}

function toggleProjectCollapse(projectId) {
  const collapsed = getCollapsedProjectIds();
  if (collapsed.has(projectId)) collapsed.delete(projectId);
  else collapsed.add(projectId);
  localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsed]));
  renderSidebar();
}

function normalizeProjectRecord(raw, index = 0) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const createdAt = Number(source.createdAt) || Date.now();
  let id = String(source.id || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) id = 'proj_' + createdAt + '_' + index;
  const docs = (Array.isArray(source.docs) ? source.docs : []).filter(doc => doc && typeof doc === 'object').map((doc, docIndex) => ({
    id: String(doc.id || ('doc_' + createdAt + '_' + docIndex)),
    name: String(doc.name || 'Document').slice(0, 200),
    text: String(doc.text || '').slice(0, PROJECT_DOC_CHAR_LIMIT),
    createdAt: Number(doc.createdAt) || createdAt
  }));
  return {
    id,
    name: String(source.name || 'New project').trim().slice(0, 160) || 'New project',
    instructions: String(source.instructions || ''),
    docs,
    createdAt,
    updatedAt: Number(source.updatedAt) || createdAt
  };
}

function normalizeProjectList(raw) {
  const used = new Set();
  return (Array.isArray(raw) ? raw : []).map((project, index) => {
    const normalized = normalizeProjectRecord(project, index);
    while (used.has(normalized.id)) normalized.id = 'proj_' + Date.now() + '_' + index + '_' + used.size;
    used.add(normalized.id);
    return normalized;
  });
}

async function loadProjects() {
  let fallbackProjects = [];
  const fallbackRaw = localStorage.getItem('assistantProjects');
  let fallbackReadable = true;
  if (fallbackRaw !== null) {
    try {
      const parsed = JSON.parse(fallbackRaw);
      if (!Array.isArray(parsed)) throw new Error('Project fallback is not a list.');
      fallbackProjects = syncFilterDeletedRecords(normalizeProjectList(parsed), syncLoadTombstones().projects, 'updatedAt');
    } catch (error) {
      console.error('Project fallback parse error:', error);
      fallbackReadable = false;
    }
  }
  if (!db) {
    projects = fallbackProjects;
    projectBaseline = new Map(projects.map(project => [project.id, serializeConversation(project)]));
    return;
  }
  try {
    const record = await idbGet('meta', 'projects');
    const raw = (record && record.value) || [];
    projects = normalizeProjectList(raw);
    projectBaseline = new Map((Array.isArray(raw) ? raw : []).filter(project => project?.id).map(project => [project.id, serializeConversation(project)]));
    for (const project of fallbackProjects) {
      const current = projects.find(item => item.id === project.id);
      if (current && serializeConversation({ ...current, updatedAt: 0 }) === serializeConversation({ ...project, updatedAt: 0 })) continue;
      if (current) {
        project.id = 'proj_conflict_' + (window.crypto?.subtle ? await syncSha256Hex(project) : genId());
        project.name += ' (conflict copy)';
      }
      if (!projects.some(item => item.id === project.id)) projects.push(project);
    }
    if (await saveProjects() && fallbackReadable && localStorage.getItem('assistantProjects') === fallbackRaw) localStorage.removeItem('assistantProjects');
  } catch (e) {
    console.error('IDB projects load error:', e);
    showToast('Projects could not be read safely. Keep this tab open and reload before saving projects.', 'error', 0);
  }
}

function saveProjects(refresh = false) {
  if (readOnlyShare || conversationStorageBlocked) return Promise.resolve(false);
  ++_projectSaveRevision;
  const run = _projectSaveChain.then(async () => {
    if (conversationStorageBlocked) throw new Error('Project storage is unavailable until reload.');
    const local = normalizeProjectList(projects);
    const baselines = new Map(projectBaseline);
    const captured = new Map(local.map(project => [project.id, serializeConversation(project)]));
    const changed = local.filter(project => captured.get(project.id) !== baselines.get(project.id));
    const deleted = [...baselines.keys()].filter(id => !captured.has(id));
    if (!changed.length && !deleted.length && !refresh) return true;
    const tombstones = syncLoadTombstones();
    const merge = (stored, ledger) => {
      const mergedTombstones = syncMergeTombstones(ledger, tombstones);
      const before = syncFilterDeletedRecords(normalizeProjectList(stored), mergedTombstones.projects, 'updatedAt');
      const rawById = new Map((Array.isArray(stored) ? stored : []).filter(project => project?.id).map(project => [project.id, project]));
      const records = new Map(before.map(project => [project.id, project]));
      const applied = [];
      let conflicts = 0;
      const keepCopy = project => {
        const copy = { ...project, id: 'proj_conflict_' + (window.crypto?.randomUUID?.() || genId()), name: project.name + ' (conflict copy)' };
        records.set(copy.id, copy);
        conflicts++;
        return copy;
      };
      changed.forEach(project => {
        const current = records.get(project.id);
        const baseline = baselines.get(project.id);
        let saved = project;
        if ((current && serializeConversation(rawById.get(project.id)) !== baseline && serializeConversation(current) !== serializeConversation(project)) ||
            (!current && (baseline !== undefined || Number(mergedTombstones.projects[project.id]) >= Number(project.updatedAt)))) saved = keepCopy(project);
        else records.set(project.id, saved);
        saved.updatedAt = Math.max(Date.now(), Number(saved.updatedAt) || 0, Number(JSON.parse(baseline || 'null')?.updatedAt || 0) + 1);
        applied.push({ fromId: project.id, record: saved });
      });
      deleted.forEach(id => {
        const current = records.get(id);
        if (current && serializeConversation(rawById.get(id)) !== baselines.get(id)) keepCopy(current);
        records.delete(id);
        mergedTombstones.projects[id] = Math.max(Number(mergedTombstones.projects[id]) || 0, Date.now());
      });
      const next = [...records.values()];
      return { records: next, tombstones: mergedTombstones, applied, conflicts, changed: serializeConversation(stored || []) !== serializeConversation(next) };
    };
    let result;
    if (!db) {
      result = merge(JSON.parse(localStorage.getItem('assistantProjects') || '[]'), tombstones);
      localStorage.setItem('assistantProjects', JSON.stringify(result.records));
    } else {
      result = await new Promise((resolve, reject) => {
        const tx = db.transaction('meta', 'readwrite');
        const store = tx.objectStore('meta');
        const request = store.get('projects');
        const ledger = store.get('syncTombstones');
        let pending = 2;
        let next;
        let failure;
        const write = () => {
          if (--pending) return;
          try {
            next = merge(request.result?.value || [], ledger.result?.value);
            if (next.changed) store.put({ key: 'projects', value: next.records });
            store.put({ key: 'syncTombstones', value: next.tombstones });
          } catch (error) { failure = error; tx.abort(); }
        };
        request.onsuccess = ledger.onsuccess = write;
        tx.oncomplete = () => resolve(next);
        tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Project save was aborted.'));
      });
    }
    const removedDuringSave = new Set([...captured.keys()].filter(id => !projects.some(project => project.id === id)));
    result.applied.forEach(({ fromId, record }) => {
      if (fromId === record.id) return;
      const current = projects.find(project => project.id === fromId);
      if (!current) return;
      current.id = record.id;
      if (current.name === JSON.parse(captured.get(fromId)).name) current.name = record.name;
      if (_projectEditId === fromId) _projectEditId = record.id;
      captured.set(record.id, serializeConversation(record));
    });
    const appliedIds = new Set(result.applied.map(item => item.record.id));
    result.records.forEach(record => {
      const index = projects.findIndex(project => project.id === record.id);
      if (removedDuringSave.has(record.id)) return;
      const dirty = index !== -1 && serializeConversation(normalizeProjectRecord(projects[index])) !== captured.get(record.id);
      if (index === -1) projects.push(record);
      else if (!dirty) projects[index] = record;
      if (!dirty || appliedIds.has(record.id)) projectBaseline.set(record.id, serializeConversation(record));
    });
    const storedIds = new Set(result.records.map(record => record.id));
    for (const id of projectBaseline.keys()) {
      if (storedIds.has(id)) continue;
      const current = projects.find(project => project.id === id);
      if (current && serializeConversation(normalizeProjectRecord(current)) !== captured.get(id)) continue;
      projects = projects.filter(project => project.id !== id);
      projectBaseline.delete(id);
    }
    try { syncSaveTombstones(syncMergeTombstones(syncLoadTombstones(), result.tombstones)); }
    catch (error) { console.warn('Could not mirror project deletion records:', error); }
    if (result.changed) { broadcastPersistenceChange(); syncScheduleAutoPush(); }
    if (result.conflicts) showToast('Conflicting project edits were kept as separate projects.', 'info', 0);
    if (refresh || result.conflicts) { renderSidebar(); renderProjectEditorPreservingPendingEdits(_projectEditId); }
    return true;
  }).catch(error => {
    console.error('Project save error:', error);
    showToast('Project changes could not be saved. Keep this tab open and retry.', 'error', 0);
    return false;
  });
  _projectSaveChain = run.then(() => undefined);
  return run;
}

function getProject(id) {
  return id ? (projects.find(p => p.id === id) || null) : null;
}

function createProject(name) {
  if (readOnlyShare) return null;
  const proj = {
    id: 'proj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: (name || 'New project').trim() || 'New project',
    instructions: '',
    docs: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  projects.unshift(proj);
  saveProjects();
  renderSidebar();
  return proj;
}

function deleteProject(id) {
  if (readOnlyShare) return;
  const proj = getProject(id);
  if (!proj) return;
  if (!confirm('Delete project "' + proj.name + '"? Its chats are kept and become unfiled.')) return;
  clearTimeout(_projectAutosaveTimer);
  _projectAutosaveTimer = null;
  // Detach, never cascade — deleting a folder must not delete the conversations in it.
  syncRecordTombstones('projects', [id]);
  conversations.forEach(c => {
    if (c.projectId !== id) return;
    delete c.projectId;
    c.updatedAt = Date.now();
  });
  projects = projects.filter(p => p.id !== id);
  _projectEditId = projects.length ? projects[0].id : null;
  saveProjects();
  saveConversations();
  renderSidebar();
  renderProjectEditor();
  showToast('Project deleted. Its chats are now unfiled.', 'success');
}

function assignConversationToProject(conv, projectId) {
  if (readOnlyShare) return;
  if (projectId) conv.projectId = projectId;
  else delete conv.projectId;
  conv.updatedAt = Date.now();
  saveConversations();
  renderSidebar();
}

function setConversationView(view) {
  if (readOnlyShare) return;
  conversationView = view === 'archived' ? 'archived' : 'active';
  localStorage.setItem('assistantConversationView', conversationView);
  renderSidebar();
}

function setConversationSort(sort) {
  if (readOnlyShare) return;
  conversationSort = ['updated', 'created', 'title', 'manual'].includes(sort) ? sort : 'updated';
  localStorage.setItem('assistantConversationSort', conversationSort);
  renderSidebar();
}

function toggleBulkMode(enabled = !bulkMode) {
  bulkMode = enabled;
  if (!bulkMode) selectedConversationIds.clear();
  const toolbar = document.getElementById('bulkToolbar');
  if (toolbar) toolbar.hidden = !bulkMode;
  const btn = document.getElementById('bulkModeBtn');
  if (btn) {
    btn.classList.toggle('active', bulkMode);
    btn.setAttribute('aria-pressed', String(bulkMode));
  }
  renderSidebar();
}

function updateBulkCount() {
  const count = document.getElementById('bulkCount');
  if (count) count.textContent = selectedConversationIds.size + ' selected';
  const all = document.getElementById('bulkSelectAll');
  const visible = conversations.filter(isConversationVisibleInSidebar);
  if (all) {
    all.checked = visible.length > 0 && visible.every(c => selectedConversationIds.has(c.id));
    all.indeterminate = visible.some(c => selectedConversationIds.has(c.id)) && !all.checked;
  }
}

function toggleConversationSelection(id, checked) {
  if (checked) selectedConversationIds.add(id);
  else selectedConversationIds.delete(id);
  updateBulkCount();
}

function toggleSelectAllConversations(checked) {
  conversations.forEach(conv => {
    if (isConversationVisibleInSidebar(conv)) {
      if (checked) selectedConversationIds.add(conv.id);
      else selectedConversationIds.delete(conv.id);
    }
  });
  renderSidebar();
}

function archiveConversation(id) {
  if (readOnlyShare) return;
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;
  if (conv.archivedAt) delete conv.archivedAt;
  else conv.archivedAt = Date.now();
  conv.updatedAt = Date.now();
  saveConversations();
  renderSidebar();
  announce(conv.archivedAt ? 'Conversation archived.' : 'Conversation restored.');
}

function toggleActiveArchive() {
  archiveConversation(activeConvId);
}

function duplicateConversation(id = activeConvId) {
  if (!prepareConversationTransition()) return;
  const source = conversations.find(c => c.id === id);
  if (!source) return;
  const copy = normalizeConversationRecord(JSON.parse(JSON.stringify(source)));
  copy.id = genId();
  copy.title = (source.title || 'Chat') + ' (copy)';
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  delete copy.shareGistId;
  delete copy.shareUrl;
  delete copy.shareId;
  delete copy.parentConversationId;
  delete copy.forkMessageIndex;
  delete copy.forkedAt;
  copy.queuedFollowUps = [];
  if (isTemporaryConversation(source)) temporaryConversations.add(copy);
  conversations.unshift(copy);
  activeConvId = copy.id;
  messages = copy.messages;
  saveConversations();
  renderSidebar();
  renderMessages();
  updateTokenInfo();
  restoreActiveDraft();
  updateCharacterUI();
  announce('Conversation duplicated.');
}

function removeConversations(ids, showUndo = true) {
  if (!prepareConversationTransition()) return;
  const targets = conversations.filter(c => ids.includes(c.id));
  if (!targets.length) return;
  const publicCount = targets.filter(c => c.shareGistId || c.shareUrl || c.shareId).length;
  if (publicCount && !confirm(publicCount + ' selected conversation' + (publicCount === 1 ? ' has' : 's have') + ' public share IDs. Deleting locally does not revoke those links. Continue?')) return;
  const removed = targets.map(conv => ({ conv, index: conversations.indexOf(conv) }));
  targets.forEach(conv => contextRevisions.set(conv, (contextRevisions.get(conv) || 0) + 1));
  ids.forEach(id => armedFollowUpConversationIds.delete(id));
  syncRecordTombstones('conversations', targets.filter(conv => !isTemporaryConversation(conv)).map(conv => conv.id));
  conversations = conversations.filter(c => !ids.includes(c.id));
  if (!conversations.length) conversations.push({ id: genId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() });
  if (!conversations.some(c => c.id === activeConvId)) activeConvId = conversations[0].id;
  messages = getActiveConv()?.messages || [];
  saveConversations();
  renderSidebar();
  renderMessages();
  updateTokenInfo();
  restoreActiveDraft();
  updateCharacterUI();
  selectedConversationIds.clear();
  if (!showUndo) return;
  showToast(targets.length + ' conversation' + (targets.length === 1 ? '' : 's') + ' deleted.', 'info', 5000, {
    label: 'Undo',
    onClick: () => {
      if (!prepareConversationTransition()) return;
      const tombstones = syncLoadTombstones().conversations;
      removed.filter(({ conv }) => !isTemporaryConversation(conv)).forEach(({ conv }) => { conv.updatedAt = Math.max(Date.now(), Number(tombstones[conv.id]) + 1 || 0); });
      syncRemoveTombstones('conversations', removed.filter(({ conv }) => !isTemporaryConversation(conv)).map(({ conv }) => conv.id));
      removed.sort((a, b) => a.index - b.index).forEach(({ conv, index }) => conversations.splice(Math.min(index, conversations.length), 0, conv));
      activeConvId = removed[0].conv.id;
      messages = getActiveConv().messages;
      saveConversations();
      renderSidebar();
      renderMessages();
      restoreActiveDraft();
      updateCharacterUI();
      updateTokenInfo();
      showToast('Conversation deletion undone.', 'success');
    }
  });
}

function bulkArchiveSelected() {
  if (readOnlyShare) return;
  if (!selectedConversationIds.size) return;
  const shouldArchive = conversationView !== 'archived';
  conversations.forEach(conv => {
    if (!selectedConversationIds.has(conv.id)) return;
    if (shouldArchive) conv.archivedAt = Date.now();
    else delete conv.archivedAt;
    conv.updatedAt = Date.now();
  });
  selectedConversationIds.clear();
  saveConversations();
  renderSidebar();
  announce(shouldArchive ? 'Selected conversations archived.' : 'Selected conversations restored.');
}

function bulkDeleteSelected() {
  removeConversations([...selectedConversationIds]);
}

function projectDocsSystemText(project) {
  const docs = (project && project.docs) || [];
  if (!docs.length) return '';
  return 'Project files (reference material):\n\n' + docs
    .map(d => '--- ' + d.name + ' ---\n' + d.text + '\n--- end ' + d.name + ' ---')
    .join('\n\n');
}

function showProjectPicker(conv, anchorEl) {
  document.querySelectorAll('.tag-picker').forEach(p => p.remove());
  const picker = document.createElement('div');
  picker.className = 'tag-picker project-picker';
  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = rect.bottom + 4 + 'px';
  picker.style.left = Math.max(8, rect.left - 120) + 'px';

  const addItem = (label, active, onClick) => {
    const btn = document.createElement('button');
    btn.className = 'project-picker-item' + (active ? ' active' : '');
    btn.textContent = label;
    btn.onclick = () => { onClick(); picker.remove(); };
    picker.appendChild(btn);
  };

  addItem('No project', !conv.projectId, () => assignConversationToProject(conv, null));
  projects.forEach(p => {
    addItem(p.name, conv.projectId === p.id, () => assignConversationToProject(conv, p.id));
  });
  addItem('+ New project', false, () => {
    const proj = createProject('New project');
    assignConversationToProject(conv, proj.id);
    openProjectsModal(proj.id);
    requestAnimationFrame(() => {
      const input = document.getElementById('projName');
      input?.focus();
      input?.select();
    });
  });

  document.body.appendChild(picker);
  const closePicker = (e) => {
    if (!picker.contains(e.target) && e.target !== anchorEl) {
      picker.remove();
      document.removeEventListener('click', closePicker);
    }
  };
  setTimeout(() => document.addEventListener('click', closePicker), 0);
}

// --- Projects modal ---

function openProjectsModal(projectId) {
  clearTimeout(_projectAutosaveTimer);
  _projectEditId = projectId || (projects.length ? projects[0].id : null);
  renderProjectEditor();
  openModal('projectsModal');
}

function selectProjectInModal(id) {
  flushProjectAutosave();
  _projectEditId = id || null;
  renderProjectEditor();
}

function renderProjectEditor() {
  const select = document.getElementById('projSelect');
  const body = document.getElementById('projEditorBody');
  const empty = document.getElementById('projEmptyState');
  if (!select || !body) return;

  select.innerHTML = '';
  projects.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === _projectEditId) opt.selected = true;
    select.appendChild(opt);
  });

  const proj = getProject(_projectEditId);
  body.style.display = proj ? '' : 'none';
  if (empty) empty.style.display = proj ? 'none' : '';
  if (!proj) return;

  document.getElementById('projName').value = proj.name;
  document.getElementById('projInstructions').value = proj.instructions || '';
  const saveStatus = document.getElementById('projectSaveStatus');
  if (saveStatus) saveStatus.textContent = 'Saved';

  const count = conversations.filter(c => c.projectId === proj.id).length;
  document.getElementById('projChatCount').textContent =
    count === 1 ? '1 chat in this project' : count + ' chats in this project';

  const list = document.getElementById('projDocList');
  list.innerHTML = '';
  if (!proj.docs.length) {
    const none = document.createElement('div');
    none.className = 'setting-hint';
    none.textContent = 'No files yet. Files added here are sent with every chat in this project.';
    list.appendChild(none);
    return;
  }
  proj.docs.forEach(doc => {
    const row = document.createElement('div');
    row.className = 'prompt-entry';
    const label = document.createElement('span');
    label.style.flex = '1';
    label.textContent = doc.name + ' (' + formatTokenCount(estimateTokens(doc.text)) + ' tokens)';
    row.appendChild(label);
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Remove file';
    del.setAttribute('aria-label', 'Remove ' + doc.name);
    del.onclick = () => removeProjectDoc(doc.id);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function renderProjectEditorPreservingPendingEdits(projectId) {
  const preserve = _projectEditId === projectId && Boolean(_projectAutosaveTimer);
  const name = preserve ? document.getElementById('projName')?.value : '';
  const instructions = preserve ? document.getElementById('projInstructions')?.value : '';
  renderProjectEditor();
  if (!preserve) return;
  const nameInput = document.getElementById('projName');
  const instructionsInput = document.getElementById('projInstructions');
  if (nameInput) nameInput.value = name || '';
  if (instructionsInput) instructionsInput.value = instructions || '';
  const status = document.getElementById('projectSaveStatus');
  if (status) status.textContent = 'Saving...';
}

function newProjectFromModal() {
  flushProjectAutosave();
  const proj = createProject('New project');
  _projectEditId = proj.id;
  renderProjectEditor();
  requestAnimationFrame(() => {
    const input = document.getElementById('projName');
    input?.focus();
    input?.select();
  });
}

async function flushProjectAutosave() {
  clearTimeout(_projectAutosaveTimer);
  _projectAutosaveTimer = null;
  const proj = getProject(_projectEditId);
  if (!proj) return true;
  const projectId = proj.id;
  const name = document.getElementById('projName')?.value.trim() || proj.name;
  const instructions = document.getElementById('projInstructions')?.value || '';
  const status = document.getElementById('projectSaveStatus');
  if (proj.name === name && proj.instructions === instructions) {
    if (_projectEditId === projectId && status) status.textContent = 'Saved';
    return true;
  }
  proj.name = name;
  proj.instructions = instructions;
  proj.updatedAt = Date.now();
  if (_projectEditId === projectId && status) status.textContent = 'Saving...';
  renderSidebar();
  const save = saveProjects();
  const revision = _projectSaveRevision;
  const saved = await save;
  if (_projectEditId === projectId && revision === _projectSaveRevision && status) status.textContent = saved ? 'Saved' : 'Could not save';
  if (!saved) showToast('Could not save project changes.', 'error', 6000);
  return saved;
}

function scheduleProjectAutosave() {
  const status = document.getElementById('projectSaveStatus');
  if (status) status.textContent = 'Saving...';
  ++_projectSaveRevision;
  clearTimeout(_projectAutosaveTimer);
  _projectAutosaveTimer = setTimeout(() => { void flushProjectAutosave(); }, 450);
}

function saveProjectFromModal() {
  closeModal('projectsModal');
}

async function removeProjectDoc(docId) {
  if (!beginLocalDataOperation()) return;
  try {
  const projectId = _projectEditId;
  await flushProjectAutosave();
  const proj = getProject(projectId);
  if (!proj) return;
  proj.docs = proj.docs.filter(d => d.id !== docId);
  proj.updatedAt = Date.now();
  if (_projectEditId === projectId) renderProjectEditorPreservingPendingEdits(projectId);
  const status = document.getElementById('projectSaveStatus');
  if (_projectEditId === projectId && status) status.textContent = 'Saving...';
  const save = saveProjects();
  const revision = _projectSaveRevision;
  const saved = await save;
  const currentStatus = document.getElementById('projectSaveStatus');
  if (_projectEditId === projectId && revision === _projectSaveRevision && currentStatus) currentStatus.textContent = saved ? 'Saved' : 'Could not save';
  if (!saved) showToast('Could not save project files.', 'error', 6000);
  } finally {
    endLocalDataOperation();
  }
}

// Reuse chat extraction while delivering results directly to this project.
async function addProjectFiles(event) {
  if (!beginLocalDataOperation()) {
    event.target.value = '';
    return;
  }
  try {
  const projectId = _projectEditId;
  await flushProjectAutosave();
  const proj = getProject(projectId);
  if (!proj) return;
  const files = Array.from(event.target.files || []);
  const docs = [];
  let skipped = 0;
  for (const file of files) {
    const added = [];
    try {
      await readAttachmentFile(file, { onAttachment: attachment => added.push(attachment) });
    } catch (e) {
      console.warn('Project file read failed:', file.name, e);
    }
    added.forEach(att => {
      const text = att.textContent || (att.file && att.file.textContent) || '';
      if (!text) { skipped++; return; }
      docs.push({
        id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: att.name || (att.file && att.file.name) || 'file',
        text: text.slice(0, PROJECT_DOC_CHAR_LIMIT),
        createdAt: Date.now()
      });
    });
  }
  await flushProjectAutosave();
  const currentProject = getProject(projectId);
  if (!currentProject) { event.target.value = ''; return; }
  currentProject.docs.push(...docs);
  currentProject.updatedAt = Date.now();
  if (_projectEditId === projectId) renderProjectEditorPreservingPendingEdits(projectId);
  const status = document.getElementById('projectSaveStatus');
  if (_projectEditId === projectId && status) status.textContent = 'Saving...';
  const save = saveProjects();
  const revision = _projectSaveRevision;
  const saved = await save;
  const currentStatus = document.getElementById('projectSaveStatus');
  if (_projectEditId === projectId && revision === _projectSaveRevision && currentStatus) currentStatus.textContent = saved ? 'Saved' : 'Could not save';
  if (!saved) showToast('Could not save project files.', 'error', 6000);
  if (skipped) showToast(skipped + ' file(s) skipped. Images and files without readable text cannot be project files.');
  } finally {
    event.target.value = '';
    endLocalDataOperation();
  }
}

// Inline SVG icons for conversation-row controls: consistent stroke glyphs
// instead of platform emoji (which render colored and mismatched).
const CONV_ICONS = {
  pin: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.3 1.8 14.2 6.7l-2.9.7-1.2 4.1L4.5 6l4.1-1.2z"/><path d="M6.2 9.8 2.2 13.8"/></svg>',
  tag: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 2.5h5.2L13.8 8.6a1 1 0 0 1 0 1.4l-3.8 3.8a1 1 0 0 1-1.4 0L2.5 7.7z"/><circle cx="5.6" cy="5.6" r="1" fill="currentColor" stroke="none"/></svg>',
  folder: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.2c0-.6.4-1 1-1h3l1.5 1.9h5.5c.6 0 1 .4 1 1v6.2c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z"/></svg>',
  archive: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="3" rx=".5"/><path d="M3.5 5.5v6.5c0 .6.4 1 1 1h7c.6 0 1-.4 1-1V5.5M6.5 8.2h3"/></svg>',
  restore: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2.5" width="12" height="3" rx=".5"/><path d="M3.5 5.5v6.5c0 .6.4 1 1 1h7c.6 0 1-.4 1-1V5.5M8 11V7.2M6.3 8.9 8 7.2l1.7 1.7"/></svg>',
  duplicate: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M2.5 10.5v-7c0-.6.4-1 1-1h7"/></svg>'
};

function renderSidebar() {
  const list = document.getElementById('convList');
  list.innerHTML = '';

  const activeBtn = document.getElementById('activeViewBtn');
  const archivedBtn = document.getElementById('archivedViewBtn');
  if (activeBtn) {
    activeBtn.classList.toggle('active', conversationView === 'active');
    activeBtn.setAttribute('aria-pressed', String(conversationView === 'active'));
  }
  if (archivedBtn) {
    archivedBtn.classList.toggle('active', conversationView === 'archived');
    archivedBtn.setAttribute('aria-pressed', String(conversationView === 'archived'));
  }
  const sortSelect = document.getElementById('conversationSort');
  if (sortSelect) sortSelect.value = conversationSort;

  const visibleConversations = conversations.filter(c => (conversationView === 'archived') === Boolean(c.archivedAt));
  // Unfiled chats sort last so the existing date groups stay where they are.
  const projectSortKey = (c) => {
    const p = getProject(c.projectId);
    return p ? p.name.toLowerCase() + '\u0000' + p.id : '\uffff';
  };
  const sorted = [...visibleConversations].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    const pa = projectSortKey(a), pb = projectSortKey(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    if (conversationSort === 'manual') return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    if (conversationSort === 'created') return (b.createdAt || 0) - (a.createdAt || 0);
    if (conversationSort === 'title') return String(a.title || '').localeCompare(String(b.title || ''));
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  // Date grouping
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 7 * 86400000;
  const monthStart = todayStart - 30 * 86400000;

  function getGroup(c) {
    if (c.pinned) return { key: 'pinned', label: 'Pinned', project: null };
    const p = getProject(c.projectId);
    if (p) return { key: 'project:' + p.id, label: p.name, project: p };
    const t = c.updatedAt || c.createdAt || 0;
    if (t >= todayStart) return { key: 'today', label: 'Today', project: null };
    if (t >= yesterdayStart) return { key: 'yesterday', label: 'Yesterday', project: null };
    if (t >= weekStart) return { key: 'week', label: 'Last 7 Days', project: null };
    if (t >= monthStart) return { key: 'month', label: 'Last 30 Days', project: null };
    return { key: 'older', label: 'Older', project: null };
  }

  let lastGroup = '';
  const collapsedProjects = getCollapsedProjectIds();
  sorted.forEach((c, sortIdx) => {
    const group = getGroup(c);
    if (group.key !== lastGroup) {
      const header = document.createElement('div');
      header.className = 'conv-group-header';
      header.dataset.group = group.key;
      const proj = group.project;
      if (proj) {
        header.classList.add('project-header');
        header.dataset.projectId = proj.id;
        const collapseBtn = document.createElement('button');
        collapseBtn.className = 'project-collapse-btn';
        collapseBtn.textContent = collapsedProjects.has(proj.id) ? '+' : '−';
        collapseBtn.title = (collapsedProjects.has(proj.id) ? 'Expand ' : 'Collapse ') + proj.name;
        collapseBtn.setAttribute('aria-label', collapseBtn.title);
        collapseBtn.setAttribute('aria-expanded', String(!collapsedProjects.has(proj.id)));
        collapseBtn.onclick = () => toggleProjectCollapse(proj.id);
        const label = document.createElement('button');
        label.className = 'project-name-btn';
        label.textContent = proj.name;
        label.title = 'Edit project';
        label.onclick = () => openProjectsModal(proj.id);
        header.append(collapseBtn, label);
        const addBtn = document.createElement('button');
        addBtn.className = 'project-add-btn';
        addBtn.textContent = '+';
        addBtn.title = 'New chat in ' + proj.name;
        addBtn.setAttribute('aria-label', 'New chat in ' + proj.name);
        addBtn.onclick = (e) => { e.stopPropagation(); createConversation(proj.id); };
        header.appendChild(addBtn);
      } else {
        header.textContent = group.label;
      }
      list.appendChild(header);
      lastGroup = group.key;
    }

    const div = document.createElement('div');
    div.className = 'conv-item' + (c.id === activeConvId ? ' active' : '') + (c.archivedAt ? ' archived' : '');
    div.dataset.convId = c.id;
    if (group.project) div.dataset.projectId = group.project.id;

    // Drag-and-drop (desktop only)
    div.draggable = conversationSort === 'manual' && !bulkMode;
    div.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', c.id);
      div.classList.add('dragging');
    });
    div.addEventListener('dragend', () => div.classList.remove('dragging'));
    div.addEventListener('dragover', (e) => { e.preventDefault(); div.classList.add('drag-over'); });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      div.classList.remove('drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (draggedId === c.id) return;
      if (conversationSort !== 'manual') {
        setConversationSort('manual');
        showToast('Manual sorting enabled for dragging.', 'info');
      }
      const fromIdx = conversations.findIndex(x => x.id === draggedId);
      const toIdx = conversations.findIndex(x => x.id === c.id);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = conversations.splice(fromIdx, 1);
      conversations.splice(toIdx, 0, moved);
      const reorderedAt = Date.now();
      conversations.forEach((x, i) => {
        if (x.sortOrder === i) return;
        x.sortOrder = i;
        x.updatedAt = reorderedAt;
      });
      saveConversations();
      renderSidebar();
    });

    if (bulkMode) {
      const select = document.createElement('input');
      select.type = 'checkbox';
      select.className = 'conv-select-checkbox';
      select.checked = selectedConversationIds.has(c.id);
      select.setAttribute('aria-label', 'Select ' + c.title);
      select.onclick = e => e.stopPropagation();
      select.onchange = () => toggleConversationSelection(c.id, select.checked);
      div.appendChild(select);
    }

    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'conv-title';
    title.textContent = c.title;
    const preview = [...(c.messages || [])].reverse().map(getMsgText).find(text => String(text || '').trim());
    title.title = preview ? String(preview).trim().slice(0, 180) : 'Open conversation; press F2 to rename';
    title.setAttribute('aria-label', 'Open conversation ' + c.title + '. Press F2 to rename.');
    if (c.id === activeConvId) title.setAttribute('aria-current', 'page');
    title.onclick = () => { if (c.id !== activeConvId) switchConversation(c.id); };
    const beginRename = () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'conv-rename-input';
      input.value = c.title;
      input.onclick = (ev) => ev.stopPropagation();
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const val = input.value.trim();
        if (val && val !== c.title) {
          c.title = val;
          c.updatedAt = Date.now();
          saveConversations();
        }
        renderSidebar();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') commit();
        if (ev.key === 'Escape') renderSidebar();
      });
      title.replaceWith(input);
      input.focus();
      input.select();
    };
    title.addEventListener('dblclick', (e) => {
      e.preventDefault();
      beginRename();
    });
    title.addEventListener('keydown', (e) => {
      if (e.key !== 'F2') return;
      e.preventDefault();
      beginRename();
    });

    if (c.characterAvatar) {
      const safeAvatar = safeMediaUrl(c.characterAvatar);
      if (safeAvatar) {
        const avatar = document.createElement('img');
        avatar.className = 'conv-avatar';
        avatar.src = safeAvatar;
        div.appendChild(avatar);
      }
    }
    div.appendChild(title);
    const state = document.createElement('span');
    state.className = 'conv-state';
    const stateParts = [];
    if (isTemporaryConversation(c)) stateParts.push('Temporary');
    if (c.archivedAt) stateParts.push('Archived');
    if (c.queuedFollowUps?.length) stateParts.push(c.queuedFollowUps.length + ' queued');
    state.textContent = stateParts.join(' · ');
    if (state.textContent) div.appendChild(state);
    if (c.tag) {
      const tagEl = document.createElement('span');
      tagEl.className = 'conv-tag';
      const tagColor = TAG_COLORS.find(t => t.name === c.tag);
      tagEl.style.background = tagColor ? tagColor.color : 'var(--accent)';
      tagEl.style.color = 'var(--accent-text)';
      tagEl.textContent = c.tag;
      div.appendChild(tagEl);
    }
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'conv-more';
    moreBtn.textContent = '⋯';
    moreBtn.title = 'Conversation actions';
    moreBtn.setAttribute('aria-label', 'Actions for ' + c.title);
    moreBtn.setAttribute('aria-haspopup', 'menu');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.onclick = event => {
      event.stopPropagation();
      openActionMenu(moreBtn, [
        { label: 'Rename', action: beginRename },
        { label: c.pinned ? 'Unpin' : 'Pin', action: () => { c.pinned = !c.pinned; c.updatedAt = Date.now(); saveConversations(); renderSidebar(); } },
        { label: 'Tag', action: () => showTagPicker(c, moreBtn) },
        { label: 'Move to project', action: () => showProjectPicker(c, moreBtn) },
        { label: 'Duplicate', action: () => duplicateConversation(c.id) },
        { label: c.archivedAt ? 'Restore' : 'Archive', action: () => archiveConversation(c.id) },
        { label: 'Delete', danger: true, action: () => deleteConversation(c.id) }
      ], 'Conversation actions');
    };
    div.appendChild(moreBtn);
    list.appendChild(div);
  });
  if (!sorted.length) {
    const empty = document.createElement('p');
    empty.className = 'sidebar-empty';
    empty.textContent = conversationView === 'archived' ? 'No archived chats.' : 'No active chats.';
    list.appendChild(empty);
  }
  renderTagFilterBar();
  filterConversations();
  updateBulkCount();
}

// ============================================
// Conversation Tags
// ============================================
function showTagPicker(conv, anchorEl) {
  document.querySelectorAll('.tag-picker').forEach(p => p.remove());
  const picker = document.createElement('div');
  picker.className = 'tag-picker';
  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = rect.bottom + 4 + 'px';
  picker.style.left = rect.left + 'px';
  // "None" option
  const none = document.createElement('button');
  none.className = 'tag-picker-item' + (!conv.tag ? ' active' : '');
  none.style.background = 'var(--hover)';
  none.title = 'None';
  none.onclick = () => { delete conv.tag; conv.updatedAt = Date.now(); saveConversations(); renderSidebar(); picker.remove(); };
  picker.appendChild(none);
  TAG_COLORS.forEach(tc => {
    const btn = document.createElement('button');
    btn.className = 'tag-picker-item' + (conv.tag === tc.name ? ' active' : '');
    btn.style.background = tc.color;
    btn.title = tc.name;
    btn.onclick = () => { conv.tag = tc.name; conv.updatedAt = Date.now(); saveConversations(); renderSidebar(); picker.remove(); };
    picker.appendChild(btn);
  });
  document.body.appendChild(picker);
  const closePicker = (e) => { if (!picker.contains(e.target) && e.target !== anchorEl) { picker.remove(); document.removeEventListener('click', closePicker); } };
  setTimeout(() => document.addEventListener('click', closePicker), 0);
}

function renderTagFilterBar() {
  const bar = document.getElementById('tagFilterBar');
  const usedTags = [...new Set(conversations.map(c => c.tag).filter(tag => TAG_COLORS.some(tc => tc.name === tag)))];
  bar.replaceChildren();
  if (usedTags.length === 0) return;
  const addButton = (label, tag, color = '') => {
    const button = document.createElement('button');
    button.className = 'tag-filter-btn' + (activeTagFilter === tag ? ' active' : '');
    button.textContent = label;
    if (activeTagFilter === tag && color) {
      button.style.background = color;
      button.style.borderColor = color;
    }
    button.onclick = () => setTagFilter(tag);
    bar.appendChild(button);
  };
  addButton('All', null);
  usedTags.forEach(tag => {
    const tc = TAG_COLORS.find(t => t.name === tag);
    addButton(tag, tag, tc?.color || 'var(--accent)');
  });
}

function setTagFilter(tag) {
  activeTagFilter = tag;
  renderTagFilterBar();
  filterConversations();
}

// ============================================
// Sidebar Search
// ============================================
function filterConversations() {
  const searchEl = document.getElementById('sidebarSearch');
  const query = searchEl ? searchEl.value.trim().toLowerCase() : '';
  const filtering = Boolean(query || activeTagFilter);
  const collapsedProjects = getCollapsedProjectIds();
  const items = document.querySelectorAll('.conv-item');
  items.forEach(item => {
    const title = item.querySelector('.conv-title').textContent.toLowerCase();
    const convId = item.dataset.convId;
    const conv = conversations.find(c => c.id === convId);
    const matchesSearch = !query || title.includes(query);
    const matchesTag = !activeTagFilter || (conv && conv.tag === activeTagFilter);
    const hiddenByCollapse = !filtering && item.dataset.projectId && collapsedProjects.has(item.dataset.projectId);
    item.style.display = (matchesSearch && matchesTag && !hiddenByCollapse) ? '' : 'none';
  });
  // Hide empty group headers
  document.querySelectorAll('.conv-group-header').forEach(header => {
    let next = header.nextElementSibling;
    let hasVisible = false;
    while (next && !next.classList.contains('conv-group-header')) {
      if (next.classList.contains('conv-item') && next.style.display !== 'none') hasVisible = true;
      next = next.nextElementSibling;
    }
    const collapsedProject = !filtering && header.dataset.projectId && collapsedProjects.has(header.dataset.projectId);
    header.style.display = (hasVisible || collapsedProject) ? '' : 'none';
  });
  document.getElementById('conversationFilterEmpty')?.remove();
  if (filtering && !Array.from(items).some(item => item.style.display !== 'none')) {
    const empty = document.createElement('div');
    empty.id = 'conversationFilterEmpty';
    empty.className = 'sidebar-empty';
    const message = document.createElement('p');
    message.setAttribute('role', 'status');
    message.textContent = 'No conversations match these filters.';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn btn-secondary';
    clear.textContent = 'Clear filters';
    clear.onclick = () => {
      searchEl.value = '';
      setTagFilter(null);
      searchEl.focus();
    };
    empty.append(message, clear);
    document.getElementById('convList')?.appendChild(empty);
  }
}

function isConversationVisibleInSidebar(conv) {
  if (!conv || (conversationView === 'archived') !== Boolean(conv.archivedAt)) return false;
  const query = document.getElementById('sidebarSearch')?.value.trim().toLowerCase() || '';
  const title = String(conv.title || '').toLowerCase();
  const filtering = Boolean(query || activeTagFilter);
  const hiddenByCollapse = !filtering && !conv.pinned && conv.projectId && getCollapsedProjectIds().has(conv.projectId);
  return !hiddenByCollapse && (!query || title.includes(query)) && (!activeTagFilter || conv.tag === activeTagFilter);
}

// ============================================
// Sidebar Toggle
// ============================================
function toggleSidebar(forceOpen, persist = true) {
  const sb = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const open = typeof forceOpen === 'boolean' ? forceOpen : sb.classList.contains('collapsed');
  const wasOpen = !sb.classList.contains('collapsed');
  if (open && window.innerWidth <= 768) toggleContextPanel(false, false);
  const trigger = document.querySelector('.toolbar-toggle');
  if (!open && wasOpen && (persist || sb.contains(document.activeElement))) trigger?.focus();
  sb.classList.toggle('collapsed', !open);
  sb.inert = !open;
  sb.setAttribute('aria-hidden', String(!open));
  if (open && window.innerWidth <= 768) {
    sb.setAttribute('role', 'dialog');
    sb.setAttribute('aria-modal', 'true');
  } else {
    sb.removeAttribute('role');
    sb.removeAttribute('aria-modal');
  }
  overlay.classList.toggle('open', open && window.innerWidth <= 768);
  trigger?.setAttribute('aria-expanded', String(open));
  if (open && !wasOpen && persist && window.innerWidth <= 768) getFocusableElements(sb)[0]?.focus();
}

function toggleContextPanel(forceOpen, persist = true) {
  const panel = document.getElementById('contextPanel');
  const overlay = document.getElementById('contextOverlay');
  const trigger = document.getElementById('contextToggle');
  if (!panel || !overlay) return;
  const open = typeof forceOpen === 'boolean' ? forceOpen : panel.classList.contains('collapsed');
  const wasOpen = !panel.classList.contains('collapsed');
  if (open && !panel.contains(document.activeElement)) contextPanelFocusReturn = getFocusReturnTarget(trigger);
  if (open && window.innerWidth <= 768) toggleSidebar(false, false);
  if (open) panel.inert = false;
  panel.classList.toggle('collapsed', !open);
  panel.setAttribute('aria-hidden', String(!open));
  if (open && window.innerWidth <= 1100) {
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
  } else {
    panel.removeAttribute('role');
    panel.removeAttribute('aria-modal');
  }
  overlay.classList.toggle('open', open && window.innerWidth <= 1100);
  trigger?.setAttribute('aria-expanded', String(open));
  document.getElementById('contextBtn')?.setAttribute('aria-expanded', String(open));
  document.getElementById('toolsBtn')?.setAttribute('aria-expanded', String(open));
  if (persist) localStorage.setItem('assistantContextPanelOpen', String(open));
  if (open && !wasOpen && persist && window.innerWidth <= 1100) getFocusableElements(panel)[0]?.focus();
  if (!open && wasOpen && (persist || panel.contains(document.activeElement))) {
    const target = getFocusableElements(document).includes(contextPanelFocusReturn) ? contextPanelFocusReturn : trigger;
    target?.focus();
  }
  if (!open) {
    contextPanelFocusReturn = null;
    panel.inert = true;
  }
}

// ============================================
// Toolbar Menu
// ============================================
function handleMenuKeydown(event, menu, closeMenu) {
  const items = Array.from(menu.querySelectorAll('[role="menuitem"]:not([hidden]):not(:disabled)'));
  if (!items.length) return;
  const current = Math.max(0, items.indexOf(document.activeElement));
  let next = current;
  if (event.key === 'ArrowDown') next = (current + 1) % items.length;
  else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
    return;
  } else if (event.key === 'Tab') {
    closeMenu();
    return;
  } else {
    return;
  }
  event.preventDefault();
  items.forEach((item, index) => { item.tabIndex = index === next ? 0 : -1; });
  items[next].focus();
}

function clampPopupToViewport(popup) {
  const pad = 8;
  const rect = popup.getBoundingClientRect();
  let dx = 0, dy = 0;
  if (rect.left < pad) dx = pad - rect.left;
  else if (rect.right > window.innerWidth - pad) dx = (window.innerWidth - pad) - rect.right;
  if (rect.top < pad) dy = pad - rect.top;
  else if (rect.bottom > window.innerHeight - pad) dy = (window.innerHeight - pad) - rect.bottom;
  if (!dx && !dy) return;
  const host = popup.offsetParent;
  const hostRect = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
  popup.style.left = Math.round(rect.left - hostRect.left + dx) + 'px';
  popup.style.top = Math.round(rect.top - hostRect.top + dy) + 'px';
}

function setStaticMenuOpen(menuId, buttonId, open, restoreFocus = false) {
  const menu = document.getElementById(menuId);
  const button = document.getElementById(buttonId);
  if (!menu || !button) return;
  menu.classList.toggle('open', open);
  button.setAttribute('aria-expanded', String(open));
  if (open) {
    clampPopupToViewport(menu);
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]:not([hidden]):not(:disabled)'));
    items.forEach((item, index) => { item.tabIndex = index === 0 ? 0 : -1; });
    items[0]?.focus();
  } else if (restoreFocus) {
    button.focus();
  }
}

function toggleSidebarMenu(event) {
  event?.stopPropagation();
  const open = !document.getElementById('sidebarMenu')?.classList.contains('open');
  closeComposerMenu(false);
  closeConnectionPicker(false);
  setStaticMenuOpen('sidebarMenu', 'sidebarMoreBtn', open);
}

function closeSidebarMenu(restoreFocus = false) {
  setStaticMenuOpen('sidebarMenu', 'sidebarMoreBtn', false, restoreFocus);
}

function toggleComposerMenu(event) {
  event?.stopPropagation();
  const open = !document.getElementById('composerMenu')?.classList.contains('open');
  closeSidebarMenu(false);
  closeConnectionPicker(false);
  setStaticMenuOpen('composerMenu', 'composerMoreBtn', open);
}

function closeComposerMenu(restoreFocus = false) {
  setStaticMenuOpen('composerMenu', 'composerMoreBtn', false, restoreFocus);
}

function toggleSidebarOrganization() {
  const section = document.querySelector('.sidebar-organization');
  if (!section) return;
  section.hidden = !section.hidden;
  localStorage.setItem('assistantSidebarOrganizationOpen', String(!section.hidden));
  if (!section.hidden) section.querySelector('button, select')?.focus();
}

function openActionMenu(anchor, items, label = 'Actions') {
  actionMenuClose?.(false);
  const menu = document.createElement('div');
  menu.className = 'toolbar-menu action-menu open';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  items.filter(item => !item.hidden).forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    if (item.id) button.dataset.action = item.id;
    if (item.danger) button.classList.add('danger');
    button.onclick = () => {
      close();
      item.action();
    };
    menu.appendChild(button);
  });
  if (!menu.children.length) return;

  document.body.appendChild(menu);
  anchor.setAttribute('aria-expanded', 'true');
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8)) + 'px';

  const onDocumentClick = event => {
    if (!menu.contains(event.target) && event.target !== anchor) close(false);
  };
  const close = (restoreFocus = true) => {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocumentClick);
    if (actionMenuClose === close) actionMenuClose = null;
    if (restoreFocus && document.contains(anchor)) {
      if (!anchor.getClientRects().length) anchor.closest('.msg-wrapper')?.focus();
      anchor.focus();
    }
  };
  actionMenuClose = close;
  menu.addEventListener('keydown', event => handleMenuKeydown(event, menu, close));
  setTimeout(() => document.addEventListener('click', onDocumentClick), 0);
  const buttons = Array.from(menu.querySelectorAll('[role="menuitem"]'));
  buttons.forEach((button, index) => { button.tabIndex = index === 0 ? 0 : -1; });
  buttons[0]?.focus();
}

function toggleToolbarMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('toolbarMenu');
  const open = menu.classList.toggle('open');
  document.getElementById('toolbarMoreBtn')?.setAttribute('aria-expanded', String(open));
  if (open) {
    toolbarMenuFocusReturn = document.activeElement;
    clampPopupToViewport(menu);
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]:not([hidden]):not(:disabled)'));
    items.forEach((item, index) => { item.tabIndex = index === 0 ? 0 : -1; });
    items[0]?.focus();
  } else {
    toolbarMenuFocusReturn = null;
  }
}
function closeToolbarMenu(restoreFocus = true) {
  document.getElementById('toolbarMenu').classList.remove('open');
  document.getElementById('toolbarMoreBtn')?.setAttribute('aria-expanded', 'false');
  if (restoreFocus && toolbarMenuFocusReturn && document.contains(toolbarMenuFocusReturn)) toolbarMenuFocusReturn.focus();
  toolbarMenuFocusReturn = null;
}
document.addEventListener('click', event => {
  if (!event.target.closest('.toolbar-more')) closeToolbarMenu(false);
  if (!event.target.closest('.sidebar-more')) closeSidebarMenu(false);
  if (!event.target.closest('.composer-more')) closeComposerMenu(false);
  if (!event.target.closest('.connection-picker-wrap')) closeConnectionPicker(false);
});

// ============================================
// Setup & Settings
// ============================================
function getConnectionInputs(target) {
  const setup = target === 'setup';
  return {
    provider: document.getElementById(setup ? 'setupProvider' : 'setProvider'),
    base: document.getElementById(setup ? 'setupProxy' : 'setProxy'),
    key: document.getElementById(setup ? 'setupKey' : 'setKey'),
    format: document.getElementById(setup ? 'setupApiFormat' : 'setApiFormat'),
    model: document.getElementById(setup ? 'setupModelManual' : 'setModelManual')
  };
}

function applyProviderPreset(target, providerName) {
  const preset = getProviderPreset(providerName);
  const inputs = getConnectionInputs(target);
  const currentUrl = inputs.base?.value.trim() || '';
  const previousPresetUrl = inputs.base?.dataset.providerPresetUrl || '';
  if (inputs.base && (!currentUrl || (previousPresetUrl && currentUrl === previousPresetUrl))) {
    inputs.base.value = preset.baseUrl;
  }
  if (inputs.base) {
    inputs.base.dataset.providerPreset = providerName;
    inputs.base.dataset.providerPresetUrl = preset.baseUrl;
  }
  if (inputs.format) inputs.format.value = preset.apiFormat;
  const keyLabel = inputs.key ? document.querySelector('label[for="' + inputs.key.id + '"]') : null;
  if (keyLabel) keyLabel.textContent = preset.keyRequired ? 'API Key' : 'API Key (optional)';
  const refresh = document.querySelector('[onclick="refreshModels(\'' + target + '\', this)"]');
  if (refresh) refresh.disabled = false;
}

function renderConnectionStatus(target, text, state = '') {
  const el = document.getElementById(target === 'setup' ? 'setupConnectionStatus' : 'settingsConnectionStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'connection-status ' + state;
}

async function testConnection(target = 'settings') {
  const inputs = getConnectionInputs(target);
  const baseUrl = inputs.base?.value.trim().replace(/\/(chat\/completions|messages)\/?$/, '') || '';
  const providerName = inputs.provider?.value || inferRequestProvider({ llmProxyUrl: baseUrl });
  const key = inputs.key?.value.trim() || '';
  const apiFormat = inputs.format?.value || getProviderPreset(providerName).apiFormat;
  const cacheKey = modelCacheKey(baseUrl, providerName, apiFormat);
  const preset = getProviderPreset(providerName);
  if (!baseUrl || (preset.keyRequired && !key)) {
    renderConnectionStatus(target, preset.keyRequired ? 'Base URL and key required.' : 'Base URL required.', 'error');
    return;
  }
  const token = {};
  modelDiscoveryRequests.set(target, token);
  const isCurrent = () => modelDiscoveryRequests.get(target) === token &&
    cacheKey === modelCacheKey(inputs.base.value.trim(), inputs.provider?.value || providerName, inputs.format?.value || apiFormat) && inputs.key.value.trim() === key;
  const started = performance.now();
  const statusEl = document.getElementById(target === 'setup' ? 'setupConnectionStatus' : 'settingsConnectionStatus');
  const button = statusEl?.closest('.connection-test-row')?.querySelector('button');
  if (button) {
    modelDiscoveryRequests.set(button, token);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }
  renderConnectionStatus(target, 'Testing...', 'testing');
  announce('Testing ' + preset.label + ' connection.');
  try {
    const metadata = await fetchAvailableModelMetadata(baseUrl, key, providerName, apiFormat);
    if (!isCurrent()) return;
    const elapsed = Math.max(0, Math.round(performance.now() - started));
    renderConnectionStatus(target, 'Success · ' + metadata.length + ' models · ' + elapsed + ' ms', 'success');
    announce('Connection succeeded. ' + metadata.length + ' models discovered.');
    populateModelSelect(target, metadata.map(model => model.id));
  } catch (err) {
    if (!isCurrent()) return;
    const elapsed = Math.max(0, Math.round(performance.now() - started));
    renderConnectionStatus(target, 'Failed · ' + elapsed + ' ms · ' + sanitizeErrorDetail(err), 'error');
    announce('Connection failed.');
  } finally {
    if (button && modelDiscoveryRequests.get(button) === token) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      modelDiscoveryRequests.delete(button);
    }
  }
}

function getSelectedModel(target) {
  const manualEl = document.getElementById(target === 'setup' ? 'setupModelManual' : 'setModelManual');
  const selectEl = document.getElementById(target === 'setup' ? 'setupModelSelect' : 'setModelSelect');
  const manual = manualEl.value.trim();
  if (manual) return manual;
  return selectEl.value || localStorage.getItem('llmModel') || '';
}

function renderSetupError(message = '') {
  const error = document.getElementById('setupError');
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

function saveSetup() {
  let proxy = document.getElementById('setupProxy').value.trim();
  const key = document.getElementById('setupKey').value.trim();
  const provider = document.getElementById('setupProvider').value || 'custom';
  renderSetupError();
  if (!proxy || (providerRequiresKey({ llmProvider: provider }) && !key)) {
    renderSetupError(providerRequiresKey({ llmProvider: provider }) ? 'Enter a base URL and API key.' : 'Enter a base URL.');
    return;
  }
  proxy = proxy.replace(/\/(chat\/completions|messages)\/?$/, '');
  const model = getSelectedModel('setup');
  if (!model) { renderSetupError('Choose or enter a model.'); return; }
  localStorage.setItem('llmProxyUrl', proxy);
  localStorage.setItem('llmProvider', provider);
  localStorage.setItem('llmModel', model);
  localStorage.setItem('llmApiFormat', document.getElementById('setupApiFormat')?.value || getProviderPreset(provider).apiFormat);
  setApiKey(key, getSelectedKeyStorage('setup'));
  syncScheduleAutoPush();
  closeModal('setupModal');
  renderConnectionChip();
  announce('Provider settings saved.');
  // Try to fetch models in the background
  const apiFormat = localStorage.getItem('llmApiFormat') || 'auto';
  const cacheKey = modelCacheKey(proxy, provider, apiFormat);
  if (key || !providerRequiresKey({ llmProvider: provider })) fetchAvailableModels(proxy, key, provider, apiFormat).then(() => {
    if (cacheKey === modelCacheKey()) loadCachedModels('settings');
  }).catch(() => {});
}

function continueWithoutProvider() {
  renderSetupError();
  closeModal('setupModal');
  document.getElementById('chatInput')?.focus();
  announce('Continuing without a configured provider.');
}

function updateSettingsFooter(tabName = activeSettingsTab) {
  activeSettingsTab = tabName;
  const button = document.getElementById('settingsSaveBtn');
  const labels = {
    api: 'Save API settings',
    tools: 'Save tool settings'
  };
  if (button) {
    button.hidden = !labels[tabName];
    button.textContent = labels[tabName] || 'Save';
  }
  document.querySelectorAll('.settings-tab').forEach(tab => {
    const dirty = dirtySettingsTabs.has(tab.id.replace('settingsTabButton-', ''));
    tab.classList.toggle('unsaved', dirty);
    tab.setAttribute('aria-label', tab.textContent + (dirty ? ', unsaved changes' : ''));
  });
  setSettingsSaveStatus(['prompts', 'appearance', 'debug'].includes(tabName) ? 'Changes save automatically.' : '');
}

function setSettingsSaveStatus(message = '') {
  const status = document.getElementById('settingsSaveStatus');
  if (!status) return;
  const names = Array.from(dirtySettingsTabs, tab => tab === 'api' ? 'API' : 'Tools');
  status.classList.toggle('unsaved', names.length > 0);
  status.textContent = [message, names.length ? 'Unsaved ' + names.join(' and ') + ' changes. Use Save in each tab.' : ''].filter(Boolean).join(' ');
}

function updateProviderOptions() {
  if (document.getElementById('setupProvider')?.value === 'custom') document.getElementById('setupAdvanced').open = true;
  const inputs = getConnectionInputs('settings');
  if (inputs.provider?.value === 'custom') document.getElementById('settingsConnectionOptions').open = true;
  const options = document.getElementById('anthropicOptions');
  if (options) options.hidden = resolveRequestApiFormat({ llmApiFormat: inputs.format?.value }, inputs.provider?.value, getSelectedModel('settings')) !== 'anthropic';
}

function switchSettingsTab(tabName, btn) {
  document.querySelectorAll('.settings-tab').forEach(tab => {
    const selected = tab === btn;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  document.querySelectorAll('.settings-tab-content').forEach(panel => {
    const selected = panel.id === 'settingsTab-' + tabName;
    panel.classList.toggle('active', selected);
    panel.hidden = !selected;
  });
  if (tabName === 'data') renderStorageSummary();
  updateProviderOptions();
  updateSettingsFooter(tabName);
}

function openSettings() {
  if (document.getElementById('settingsModal').classList.contains('open')) return;
  clearTimeout(_promptSettingsAutosaveTimer);
  clearTimeout(_appearanceSettingsAutosaveTimer);
  _promptSettingsAutosaveTimer = null;
  _appearanceSettingsAutosaveTimer = null;
  _promptSettingsAutosavePending = false;
  _appearanceSettingsAutosavePending = false;
  document.getElementById('setProxy').value = localStorage.getItem('llmProxyUrl') || '';
  document.getElementById('setKey').value = getApiKeyForForm();
  const providerSelect = document.getElementById('setProvider');
  if (providerSelect) providerSelect.value = inferProviderKey();
  if (providerSelect) applyProviderPreset('settings', providerSelect.value);
  setKeyStorageInputs(getKeyStorageMode());
  const currentModel = localStorage.getItem('llmModel') || '';
  document.getElementById('setModelManual').value = currentModel;
  document.getElementById('setApiFormat').value = localStorage.getItem('llmApiFormat') || 'auto';
  renderPromptEntries();
  const conv = getActiveConv();
  document.getElementById('setPersona').value = (conv && conv.persona) || localStorage.getItem('llmPersona') || '';
  document.getElementById('setEnableStMacros').checked = localStorage.getItem('llmEnableStMacros') === 'true';
  document.getElementById('setRpUserName').value = localStorage.getItem('llmRpUserName') || '';
  document.getElementById('setStarterPrompts').value = getStarterPrompts().join('\n');
  document.getElementById('setStarterPromptsHidden').checked = localStorage.getItem('assistantStarterPromptsHidden') === 'true';
  document.getElementById('setExtraParams').value = localStorage.getItem('llmExtraParams') || '';
  document.getElementById('setExcludeParams').value = localStorage.getItem('llmExcludeParams') || '';
  document.getElementById('setPrefill').value = localStorage.getItem('llmPrefill') || '';
  document.getElementById('setStreaming').checked = localStorage.getItem('llmStreaming') !== 'false';
  document.getElementById('setEnterSend').checked = localStorage.getItem('llmEnterSend') !== 'false';
  document.getElementById('setTemperature').value = localStorage.getItem('llmTemperature') || '';
  document.getElementById('setMaxTokens').value = localStorage.getItem('llmMaxTokens') || '';
  document.getElementById('setContextWindow').value = localStorage.getItem('llmContextWindow') || '';
  document.getElementById('setPromptCache').checked = localStorage.getItem('llmPromptCache') !== 'false';
  document.getElementById('setThinking').checked = localStorage.getItem('llmThinking') === 'true';
  document.getElementById('setThinkingEffort').value = localStorage.getItem('llmThinkingEffort') || '';
  document.getElementById('setInputCost').value = localStorage.getItem('llmInputCost') || '';
  document.getElementById('setOutputCost').value = localStorage.getItem('llmOutputCost') || '';
  document.getElementById('setFont').value = localStorage.getItem('assistantFont') || '';
  document.getElementById('setMsgFontSize').value = localStorage.getItem('assistantMsgFontSize') || '';
  document.getElementById('setMsgMaxWidth').value = localStorage.getItem('assistantMsgMaxWidth') || '';
  document.getElementById('setEmotionSprites').checked = areEmotionSpritesEnabled();
  document.getElementById('setEmotionSpriteSet').value = getEmotionSpriteSet();
  document.getElementById('setWebSearch').checked = localStorage.getItem('llmWebSearch') === 'true';
  document.getElementById('setForceSearch').checked = localStorage.getItem('llmForceSearch') === 'true';
  document.getElementById('setUrlFetch').checked = localStorage.getItem('llmUrlFetch') === 'true';
  document.getElementById('setToolConfirm').checked = localStorage.getItem('llmToolConfirm') !== 'false';
  document.getElementById('setSearchApiUrl').value = localStorage.getItem('llmSearchApiUrl') || '';
  document.getElementById('setSearchApiKey').value = localStorage.getItem('llmSearchApiKey') || '';
  document.getElementById('setCorsProxy').value = getCorsProxyUrl();
  document.getElementById('setMemory').checked = isMemoryEnabled();
  document.getElementById('setHoldScreenshot').checked = localStorage.getItem('llmHoldScreenshot') === 'true';

  renderProfileSelect();
  const activeProfileId = localStorage.getItem('assistantActiveProfileId') || '';
  const profileSelect = document.getElementById('profileSelect');
  if (profileSelect) profileSelect.value = activeProfileId;
  const profileName = document.getElementById('profileName');
  if (profileName) profileName.value = '';
  renderProfileSummary();
  const debugLogging = document.getElementById('setDebugLogging');
  const debugIncludeText = document.getElementById('setDebugIncludeText');
  if (debugLogging) debugLogging.checked = isDebugLoggingEnabled();
  if (debugIncludeText) debugIncludeText.checked = isDebugTextIncluded();
  renderDebugLogPreview();
  renderLocalUpdateStatus();
  renderSyncSettings();

  // Presets
  loadPresets();

  // Theme
  const currentTheme = localStorage.getItem('assistantTheme') || 'dark';
  document.getElementById('setTheme').value = currentTheme;
  document.getElementById('customThemeColors').style.display = currentTheme === 'custom' ? 'grid' : 'none';
  if (currentTheme === 'custom') loadCustomColorPickers();

  // Model select
  loadCachedModels('settings');
  const selectEl = document.getElementById('setModelSelect');
  if (currentModel) {
    for (const opt of selectEl.options) {
      if (opt.value === currentModel) { opt.selected = true; break; }
    }
  }

  const activeButton = document.querySelector('.settings-tab.active') || document.getElementById('settingsTabButton-api');
  const tabName = activeButton?.id.replace('settingsTabButton-', '') || 'api';
  switchSettingsTab(tabName, activeButton);
  openModal('settingsModal', '#' + (tabName === 'api' ? 'setProxy' : activeButton?.id));
}

function loadProfiles() {
  try {
    const raw = JSON.parse(localStorage.getItem('assistantProfiles') || '[]');
    return Array.isArray(raw) ? raw.map(sanitizeProfileRecord) : [];
  } catch(e) { return []; }
}

function saveProfiles(profiles) {
  const safeProfiles = (Array.isArray(profiles) ? profiles : []).map(sanitizeProfileRecord);
  localStorage.setItem('assistantProfiles', JSON.stringify(safeProfiles));
  syncScheduleAutoPush();
}

function renderProfileSelect() {
  const select = document.getElementById('profileSelect');
  if (!select) return;
  const profiles = loadProfiles().slice().sort((a, b) =>
    (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  );
  select.innerHTML = '<option value="">-- Select profile --</option>';
  profiles.forEach(p => {
    const opt = document.createElement('option');
    const summary = getConnectionSummary(p.settings || {});
    opt.value = p.id;
    opt.textContent = (p.name || 'Unnamed profile') + ' | ' + summary.provider.name + ' | ' + formatModelForDisplay(summary.model, 26);
    select.appendChild(opt);
  });
}

function renderProfileSummary() {
  const el = document.getElementById('profileSummary');
  if (!el) return;
  const select = document.getElementById('profileSelect');
  const profiles = loadProfiles();
  const selected = select?.value ? profiles.find(p => p.id === select.value) : null;
  const settings = selected ? (selected.settings || {}) : collectProfileSettingsFromInputs();
  const summary = getConnectionSummary(settings);
  const name = selected ? (selected.name || 'Unnamed profile') : 'Current settings';
  const updated = selected?.updatedAt ? ' | saved ' + formatRelativeTime(selected.updatedAt) : '';
  el.textContent = name + ': ' + summary.provider.symbol + ' ' + summary.provider.name + ' | ' + formatModelForDisplay(summary.model, 42) + ' | ' + summary.host + updated;
  el.title = selected?.updatedAt ? new Date(selected.updatedAt).toLocaleString() : '';
}

function collectProfileSettingsFromInputs() {
  return {
    llmProvider: document.getElementById('setProvider').value,
    llmProxyUrl: document.getElementById('setProxy').value.trim(),
    llmModel: getSelectedModel('settings'),
    llmApiFormat: document.getElementById('setApiFormat').value,
    llmStreaming: document.getElementById('setStreaming').checked ? 'true' : 'false',
    llmEnterSend: document.getElementById('setEnterSend').checked ? 'true' : 'false',
    llmTemperature: document.getElementById('setTemperature').value.trim(),
    llmMaxTokens: document.getElementById('setMaxTokens').value.trim(),
    llmContextWindow: document.getElementById('setContextWindow').value.trim(),
    llmPromptCache: document.getElementById('setPromptCache').checked ? 'true' : 'false',
    llmThinking: document.getElementById('setThinking').checked ? 'true' : 'false',
    llmThinkingEffort: document.getElementById('setThinkingEffort').value,
    llmExtraParams: document.getElementById('setExtraParams').value.trim(),
    llmExcludeParams: document.getElementById('setExcludeParams').value.trim(),
    llmPrefill: document.getElementById('setPrefill').value,
    llmWebSearch: document.getElementById('setWebSearch').checked ? 'true' : 'false',
    llmForceSearch: document.getElementById('setForceSearch').checked ? 'true' : 'false',
    llmUrlFetch: document.getElementById('setUrlFetch').checked ? 'true' : 'false',
    llmToolConfirm: document.getElementById('setToolConfirm').checked ? 'true' : 'false',
    llmSearchApiUrl: document.getElementById('setSearchApiUrl').value.trim(),
    llmCorsProxy: normalizeCorsProxyUrl(document.getElementById('setCorsProxy').value),
    llmMemoryEnabled: document.getElementById('setMemory').checked ? 'true' : 'false',
    llmHoldScreenshot: document.getElementById('setHoldScreenshot').checked ? 'true' : 'false',
    llmEmotionSprites: document.getElementById('setEmotionSprites').checked ? 'true' : 'false',
    llmEmotionSpriteSet: document.getElementById('setEmotionSpriteSet').value,
    llmInputCost: document.getElementById('setInputCost').value.trim(),
    llmOutputCost: document.getElementById('setOutputCost').value.trim(),
    llmEnableStMacros: document.getElementById('setEnableStMacros').checked ? 'true' : 'false',
    llmRpUserName: document.getElementById('setRpUserName').value.trim()
  };
}

function applyProfileToInputs(settings) {
  document.getElementById('setProxy').value = settings.llmProxyUrl || '';
  document.getElementById('setKey').value = getApiKeyForForm();
  const providerSelect = document.getElementById('setProvider');
  if (providerSelect) providerSelect.value = settings.llmProvider || inferProviderKey(settings);
  document.getElementById('setApiFormat').value = settings.llmApiFormat || 'auto';
  document.getElementById('setStreaming').checked = settings.llmStreaming !== 'false';
  document.getElementById('setEnterSend').checked = settings.llmEnterSend !== 'false';
  document.getElementById('setTemperature').value = settings.llmTemperature || '';
  document.getElementById('setMaxTokens').value = settings.llmMaxTokens || '';
  document.getElementById('setContextWindow').value = settings.llmContextWindow || '';
  document.getElementById('setPromptCache').checked = settings.llmPromptCache !== 'false';
  document.getElementById('setThinking').checked = settings.llmThinking === 'true';
  document.getElementById('setThinkingEffort').value = settings.llmThinkingEffort || '';
  document.getElementById('setExtraParams').value = settings.llmExtraParams || '';
  document.getElementById('setExcludeParams').value = settings.llmExcludeParams || '';
  document.getElementById('setPrefill').value = settings.llmPrefill || '';
  document.getElementById('setWebSearch').checked = settings.llmWebSearch === 'true';
  document.getElementById('setForceSearch').checked = settings.llmForceSearch === 'true';
  document.getElementById('setUrlFetch').checked = settings.llmUrlFetch === 'true';
  document.getElementById('setToolConfirm').checked = settings.llmToolConfirm !== 'false';
  document.getElementById('setSearchApiUrl').value = settings.llmSearchApiUrl || '';
  document.getElementById('setSearchApiKey').value = settings.llmSearchApiKey || '';
  document.getElementById('setCorsProxy').value = normalizeCorsProxyUrl(settings.llmCorsProxy);
  document.getElementById('setMemory').checked = parseEnabledSetting(settings.llmMemoryEnabled);
  document.getElementById('setHoldScreenshot').checked = settings.llmHoldScreenshot === 'true';
  document.getElementById('setEmotionSprites').checked = settings.llmEmotionSprites === 'true';
  document.getElementById('setEmotionSpriteSet').value = settings.llmEmotionSpriteSet || 'auto';
  document.getElementById('setInputCost').value = settings.llmInputCost || '';
  document.getElementById('setOutputCost').value = settings.llmOutputCost || '';
  document.getElementById('setEnableStMacros').checked = settings.llmEnableStMacros === 'true';
  document.getElementById('setRpUserName').value = settings.llmRpUserName || '';

  const model = settings.llmModel || '';
  document.getElementById('setModelManual').value = model;
  document.getElementById('setModelSelect').value = '';
  const selectEl = document.getElementById('setModelSelect');
  for (const opt of selectEl.options) {
    if (opt.value === model) { opt.selected = true; break; }
  }
}

function applyProfile(profile) {
  if (!profile) return;
  const settings = sanitizeProfileSettings(profile.settings);
  const apiEndpointChanged = settings.llmProxyUrl && settings.llmProxyUrl !== localStorage.getItem('llmProxyUrl');
  const searchEndpointChanged = settings.llmSearchApiUrl && settings.llmSearchApiUrl !== localStorage.getItem('llmSearchApiUrl');
  if (apiEndpointChanged) setApiKey('', getKeyStorageMode());
  if (searchEndpointChanged) localStorage.removeItem('llmSearchApiKey');
  Object.entries(settings).forEach(([k, v]) => {
    if (v === null || v === undefined) return;
    if (k === 'llmApiKey') return;
    localStorage.setItem(k, v);
  });
  localStorage.setItem('assistantActiveProfileId', profile.id);
  applyProfileToInputs(settings);
  if (!streaming) renderMessages({ preserveScroll: true });
  renderProfileSummary();
  renderConnectionChip();
  syncScheduleAutoPush();
  showToast('Profile applied: ' + profile.name + (apiEndpointChanged || searchEndpointChanged ? '. Re-enter credentials for the new endpoint.' : ''), 'success');
}

function applyProfileFromSelect() {
  const select = document.getElementById('profileSelect');
  if (!select) return;
  const id = select.value;
  if (!id) return;
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === id);
  if (profile) applyProfile(profile);
}

function saveCurrentAsProfile() {
  const select = document.getElementById('profileSelect');
  const nameInput = document.getElementById('profileName');
  const desiredName = (nameInput && nameInput.value.trim()) || '';
  const profiles = loadProfiles();
  const settings = collectProfileSettingsFromInputs();
  let profile = null;

  if (select && select.value) {
    profile = profiles.find(p => p.id === select.value);
  }

  if (profile) {
    profile.name = desiredName || profile.name;
    profile.settings = settings;
    profile.updatedAt = Date.now();
  } else {
    const now = Date.now();
    profile = { id: 'profile_' + now, name: desiredName || suggestProfileName(settings), settings, createdAt: now, updatedAt: now };
    profiles.push(profile);
  }

  saveProfiles(profiles);
  renderProfileSelect();
  if (select) select.value = profile.id;
  localStorage.setItem('assistantActiveProfileId', profile.id);
  if (nameInput) nameInput.value = '';
  renderProfileSummary();
  renderConnectionChip();
  showToast('Profile saved.', 'success');
}

function deleteSelectedProfile() {
  const select = document.getElementById('profileSelect');
  if (!select || !select.value) { showToast('Select a profile to delete.', 'info'); return; }
  if (!confirm('Delete this profile?')) return;
  let profiles = loadProfiles();
  profiles = profiles.filter(p => p.id !== select.value);
  saveProfiles(profiles);
  localStorage.removeItem('assistantActiveProfileId');
  renderProfileSelect();
  select.value = '';
  renderProfileSummary();
  showToast('Profile deleted.', 'info');
}

function readValidatedExtraParams() {
  const extraParamsField = document.getElementById('setExtraParams');
  const extraParamsVal = extraParamsField.value.trim();
  if (extraParamsVal) {
    try {
      JSON.parse(extraParamsVal);
      extraParamsField.classList.remove('invalid');
    } catch(e) {
      extraParamsField.classList.add('invalid');
      showToast('Extra Parameters must be valid JSON.', 'error');
      return null;
    }
  } else {
    extraParamsField.classList.remove('invalid');
  }
  return extraParamsVal;
}

function savePresetGenerationSettings() {
  const extraParamsVal = readValidatedExtraParams();
  if (extraParamsVal === null) return false;
  localStorage.setItem('llmTemperature', document.getElementById('setTemperature').value.trim());
  localStorage.setItem('llmExtraParams', extraParamsVal);
  syncScheduleAutoPush();
  updateTokenInfo();
  return true;
}

function saveApiSettings() {
  const extraParamsVal = readValidatedExtraParams();
  if (extraParamsVal === null) return false;
  let proxy = document.getElementById('setProxy').value.trim();
  proxy = proxy.replace(/\/(chat\/completions|messages)\/?$/, '');
  const providerName = document.getElementById('setProvider').value || 'custom';
  const keyValue = document.getElementById('setKey').value.trim();
  if (!proxy || (providerRequiresKey({ llmProvider: providerName }) && !keyValue)) {
    showToast(providerRequiresKey({ llmProvider: providerName }) ? 'Base URL and API Key are required.' : 'Base URL is required.', 'error');
    return false;
  }
  const selectedModel = getSelectedModel('settings');
  if (!selectedModel) { showToast('Choose or enter a model.', 'error'); return false; }
  localStorage.setItem('llmProxyUrl', proxy);
  localStorage.setItem('llmProvider', providerName);
  localStorage.setItem('llmModel', selectedModel);
  localStorage.setItem('llmApiFormat', document.getElementById('setApiFormat').value);
  setApiKey(keyValue, getSelectedKeyStorage('settings'));
  localStorage.setItem('llmExtraParams', extraParamsVal);
  localStorage.setItem('llmExcludeParams', document.getElementById('setExcludeParams').value.trim());
  localStorage.setItem('llmPrefill', document.getElementById('setPrefill').value);
  localStorage.setItem('llmStreaming', document.getElementById('setStreaming').checked ? 'true' : 'false');
  localStorage.setItem('llmEnterSend', document.getElementById('setEnterSend').checked ? 'true' : 'false');
  localStorage.setItem('llmTemperature', document.getElementById('setTemperature').value.trim());
  localStorage.setItem('llmMaxTokens', document.getElementById('setMaxTokens').value.trim());
  localStorage.setItem('llmContextWindow', document.getElementById('setContextWindow').value.trim());
  localStorage.setItem('llmPromptCache', document.getElementById('setPromptCache').checked ? 'true' : 'false');
  localStorage.setItem('llmThinking', document.getElementById('setThinking').checked ? 'true' : 'false');
  localStorage.setItem('llmThinkingEffort', document.getElementById('setThinkingEffort').value);
  localStorage.removeItem('assistantActiveProfileId');
  renderConnectionChip();
  renderProfileSummary();
  syncScheduleAutoPush();
  setSettingsSaveStatus('API settings saved.');
  announce('API settings saved.');

  if (keyValue || !providerRequiresKey({ llmProvider: providerName })) {
    fetchAvailableModels(proxy, keyValue, providerName, localStorage.getItem('llmApiFormat') || 'auto').catch(() => {});
  }
  return true;
}

function savePromptSettings({ announceChange = true } = {}) {
  _promptSettingsAutosavePending = false;
  const personaVal = document.getElementById('setPersona').value;
  const conv = getActiveConv();
  if (conv && conv.persona !== personaVal) {
    conv.persona = personaVal;
    conv.updatedAt = Date.now();
    saveConversations();
  }
  if ((!conv || !conv.characterCard) && !isTemporaryConversation(conv)) localStorage.setItem('llmPersona', personaVal);
  localStorage.setItem('llmEnableStMacros', document.getElementById('setEnableStMacros').checked ? 'true' : 'false');
  localStorage.setItem('llmRpUserName', document.getElementById('setRpUserName').value.trim());
  const prompts = document.getElementById('setStarterPrompts').value
    .split('\n').map(value => value.trim()).filter(Boolean)
    .filter((value, index, all) => all.findIndex(item => item.toLowerCase() === value.toLowerCase()) === index)
    .slice(0, 8);
  localStorage.setItem('assistantStarterPrompts', JSON.stringify(prompts));
  localStorage.setItem('assistantStarterPromptsHidden', document.getElementById('setStarterPromptsHidden').checked ? 'true' : 'false');
  syncScheduleAutoPush();
  if (!streaming) renderMessages({ preserveScroll: true });
  setSettingsSaveStatus('Prompt settings saved.');
  if (announceChange) announce('Prompt settings saved.');
  return true;
}

function validateCssSetting(id, property, label) {
  const field = document.getElementById(id);
  const value = field.value.trim();
  const valid = !value || Boolean(window.CSS?.supports?.(property, value));
  field.classList.toggle('invalid', !valid);
  if (!valid) showToast(label + ' is not a valid CSS value.', 'error');
  return valid;
}

function saveAppearanceSettings({ announceChange = true } = {}) {
  const valid = [
    validateCssSetting('setMsgFontSize', 'font-size', 'Message font size'),
    validateCssSetting('setMsgMaxWidth', 'width', 'Message width')
  ];
  if (document.getElementById('setTheme').value === 'custom') {
    valid.push(validateCssSetting('cBorderRadius', 'border-radius', 'Custom radius'));
    valid.push(validateCssSetting('cMsgMaxWidth', 'width', 'Custom message width'));
    valid.push(validateCssSetting('cMsgFontSize', 'font-size', 'Custom message font size'));
  }
  if (valid.includes(false)) return false;
  _appearanceSettingsAutosavePending = false;
  const themeName = document.getElementById('setTheme').value;
  if (themeName === 'custom') {
    localStorage.setItem('assistantCustomTheme', JSON.stringify(getCustomThemeFromPickers()));
  }
  applyTheme(themeName);
  const msgFs = document.getElementById('setMsgFontSize').value.trim();
  const msgMw = document.getElementById('setMsgMaxWidth').value.trim();
  msgFs ? localStorage.setItem('assistantMsgFontSize', msgFs) : localStorage.removeItem('assistantMsgFontSize');
  msgMw ? localStorage.setItem('assistantMsgMaxWidth', msgMw) : localStorage.removeItem('assistantMsgMaxWidth');
  applyMsgOverrides();
  const fontName = document.getElementById('setFont').value.trim();
  localStorage.setItem('assistantFont', fontName);
  loadCustomFont(fontName);
  localStorage.setItem('llmEmotionSprites', document.getElementById('setEmotionSprites').checked ? 'true' : 'false');
  localStorage.setItem('llmEmotionSpriteSet', document.getElementById('setEmotionSpriteSet').value);
  if (!streaming) renderMessages({ preserveScroll: true });
  syncScheduleAutoPush();
  setSettingsSaveStatus('Appearance saved.');
  if (announceChange) announce('Appearance saved.');
  return true;
}

function schedulePromptSettingsAutosave() {
  _promptSettingsAutosavePending = true;
  setSettingsSaveStatus('Saving...');
  clearTimeout(_promptSettingsAutosaveTimer);
  _promptSettingsAutosaveTimer = setTimeout(() => {
    _promptSettingsAutosaveTimer = null;
    savePromptSettings({ announceChange: false });
  }, 450);
}

function scheduleAppearanceSettingsAutosave() {
  _appearanceSettingsAutosavePending = true;
  setSettingsSaveStatus('Saving...');
  clearTimeout(_appearanceSettingsAutosaveTimer);
  _appearanceSettingsAutosaveTimer = setTimeout(() => {
    _appearanceSettingsAutosaveTimer = null;
    saveAppearanceSettings({ announceChange: false });
  }, 450);
}

function flushSettingsAutosaves() {
  if (_promptSettingsAutosaveTimer) clearTimeout(_promptSettingsAutosaveTimer);
  if (_appearanceSettingsAutosaveTimer) clearTimeout(_appearanceSettingsAutosaveTimer);
  _promptSettingsAutosaveTimer = null;
  _appearanceSettingsAutosaveTimer = null;
  if (_promptSettingsAutosavePending) savePromptSettings({ announceChange: false });
  if (_appearanceSettingsAutosavePending) saveAppearanceSettings({ announceChange: false });
}

function saveToolSettings() {
  localStorage.setItem('llmInputCost', document.getElementById('setInputCost').value.trim());
  localStorage.setItem('llmOutputCost', document.getElementById('setOutputCost').value.trim());
  localStorage.setItem('llmWebSearch', document.getElementById('setWebSearch').checked ? 'true' : 'false');
  localStorage.setItem('llmForceSearch', document.getElementById('setForceSearch').checked ? 'true' : 'false');
  localStorage.setItem('llmUrlFetch', document.getElementById('setUrlFetch').checked ? 'true' : 'false');
  localStorage.setItem('llmToolConfirm', document.getElementById('setToolConfirm').checked ? 'true' : 'false');
  localStorage.setItem('llmSearchApiUrl', document.getElementById('setSearchApiUrl').value.trim());
  localStorage.setItem('llmSearchApiKey', document.getElementById('setSearchApiKey').value.trim());
  localStorage.setItem('llmCorsProxy', normalizeCorsProxyUrl(document.getElementById('setCorsProxy').value));
  localStorage.setItem('llmMemoryEnabled', document.getElementById('setMemory').checked ? 'true' : 'false');
  isMemoryEnabled();
  localStorage.setItem('llmHoldScreenshot', document.getElementById('setHoldScreenshot').checked ? 'true' : 'false');
  if (document.getElementById('setWebSearch').checked) {
    const fmt = localStorage.getItem('llmApiFormat') || 'auto';
    const searchUrl = document.getElementById('setSearchApiUrl').value.trim();
    if (fmt !== 'anthropic' && fmt !== 'auto' && !searchUrl) {
      showToast('Web search needs a Search API URL for OpenAI-compatible models.', 'error');
    }
  }
  syncScheduleAutoPush();
  setSettingsSaveStatus('Tool settings saved.');
  announce('Tool settings saved.');
  return true;
}

function saveSettingsTab() {
  const saves = {
    api: saveApiSettings,
    prompts: savePromptSettings,
    appearance: saveAppearanceSettings,
    tools: saveToolSettings
  };
  const saved = saves[activeSettingsTab]?.() || false;
  if (saved && dirtySettingsTabs.delete(activeSettingsTab)) {
    updateSettingsFooter();
    setSettingsSaveStatus(activeSettingsTab === 'api' ? 'API settings saved.' : 'Tool settings saved.');
  }
  return saved;
}

function saveSettings() {
  return saveSettingsTab();
}

function closeSettings() {
  closeModal('settingsModal');
}

// ============================================
// System Prompt Presets
// ============================================
function readPresetRecords() {
  try { return normalizePresetRecords(JSON.parse(localStorage.getItem('assistantPresets') || '[]')) || []; }
  catch(e) { console.warn('Presets parse error:', e); return []; }
}

function loadPresets() {
  const presets = readPresetRecords();
  const select = document.getElementById('setPresetSelect');
  select.innerHTML = '<option value="">-- Custom --</option>';
  presets.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });
  return presets;
}

function applyPreset(id) {
  if (!id) return;
  const presets = readPresetRecords();
  const preset = presets.find(p => p.id === id);
  if (!preset) return;
  // Prompt entries (new format) or legacy fallback
  if (preset.promptEntries) {
    savePromptEntries(preset.promptEntries);
    if ('persona' in preset) document.getElementById('setPersona').value = preset.persona || '';
  } else {
    const entries = [];
    if (preset.systemPrompt) entries.push({ id: 'pe_' + Date.now() + '_sys', name: 'System Prompt', content: preset.systemPrompt, enabled: true });
    if (preset.persona) entries.push({ id: 'pe_' + Date.now() + '_per', name: 'Persona', content: preset.persona, enabled: true });
    if (entries.length > 0) savePromptEntries(entries);
  }
  renderPromptEntries();
  if ('temperature' in preset) document.getElementById('setTemperature').value = preset.temperature ?? '';
  if ('extraParams' in preset) document.getElementById('setExtraParams').value = preset.extraParams || '';
  savePresetGenerationSettings();
  schedulePromptSettingsAutosave();
}

function saveCurrentAsPreset() {
  const name = prompt('Preset name:');
  if (!name) return;
  const presets = readPresetRecords();
  const preset = {
    id: 'preset_' + Date.now(),
    name: name,
    promptEntries: loadPromptEntries(),
    persona: document.getElementById('setPersona').value,
    temperature: document.getElementById('setTemperature').value.trim(),
    extraParams: document.getElementById('setExtraParams').value.trim()
  };
  presets.push(preset);
  localStorage.setItem('assistantPresets', JSON.stringify(presets));
  syncScheduleAutoPush();
  loadPresets();
  document.getElementById('setPresetSelect').value = preset.id;
  showToast('Preset saved: ' + name, 'success');
}

function deleteSelectedPreset() {
  const select = document.getElementById('setPresetSelect');
  const id = select.value;
  if (!id) { showToast('Select a preset to delete.', 'info'); return; }
  let presets = readPresetRecords();
  const preset = presets.find(p => p.id === id);
  if (!preset) return;
  if (!confirm('Delete preset "' + preset.name + '"?')) return;
  presets = presets.filter(p => p.id !== id);
  localStorage.setItem('assistantPresets', JSON.stringify(presets));
  syncScheduleAutoPush();
  loadPresets();
  showToast('Preset deleted.', 'info');
}

function importSTPreset(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  if (!beginLocalDataOperation()) return;
  let operationEnded = false;
  const finishOperation = () => {
    if (operationEnded) return;
    operationEnded = true;
    endLocalDataOperation();
  };
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
    let data;
    try { data = JSON.parse(e.target.result); } catch(err) {
      showToast('Invalid JSON file.', 'error');
      return;
    }

    // Map ST parameter names to API-compatible names
    const nameMap = {
      temp: 'temperature',
      top_p: 'top_p',
      top_k: 'top_k',
      min_p: 'min_p',
      rep_pen: 'repetition_penalty',
      rep_pen_range: 'repetition_penalty_range',
      rep_pen_slope: 'repetition_penalty_slope',
      freq_pen: 'frequency_penalty',
      presence_pen: 'presence_penalty',
      typical_p: 'typical_p',
      tfs: 'tfs_z',
      top_a: 'top_a',
      mirostat_mode: 'mirostat_mode',
      mirostat_tau: 'mirostat_tau',
      mirostat_eta: 'mirostat_eta',
      max_tokens: 'max_tokens',
      genamt: 'max_tokens',
      max_length: 'max_tokens',
      seed: 'seed',
      smoothing_factor: 'smoothing_factor',
      smoothing_curve: 'smoothing_curve',
      dynatemp: 'dynatemp',
      min_temp: 'min_temp',
      max_temp: 'max_temp',
      temperature_last: 'temperature_last',
      sampler_order: 'sampler_order',
      no_repeat_ngram_size: 'no_repeat_ngram_size',
      penalty_alpha: 'penalty_alpha',
      epsilon_cutoff: 'epsilon_cutoff',
      eta_cutoff: 'eta_cutoff',
      encoder_rep_pen: 'encoder_repetition_penalty',
      frequency_penalty: 'frequency_penalty',
      presence_penalty: 'presence_penalty',
      temperature: 'temperature',
      repetition_penalty: 'repetition_penalty'
    };

    // Fields to skip (metadata, not sampler params)
    const skip = new Set([
      'name', 'preset', 'do_sample', 'early_stopping',
      'grammar_string', 'banned_tokens', 'custom_token_bans',
      'ignore_eos_token_ban', 'num_beams', 'length_penalty',
      'min_length', 'add_bos_token', 'truncation_length',
      'ban_eos_token', 'skip_special_tokens',
      'sampler_priority', 'n'
    ]);

    const extra = {};
    let temperature = null;

    for (const [key, val] of Object.entries(data)) {
      if (skip.has(key)) continue;
      if (typeof val === 'string' && key !== 'sampler_order') continue;
      if (typeof val === 'boolean') continue;
      const mapped = nameMap[key] || key;
      if (mapped === 'temperature') {
        temperature = val;
      } else {
        extra[mapped] = val;
      }
    }

    // Set temperature field
    if (temperature !== null) {
      document.getElementById('setTemperature').value = temperature;
    }

    // Set Extra Parameters field
    document.getElementById('setExtraParams').value = Object.keys(extra).length ? JSON.stringify(extra, null, 2) : '';
    savePresetGenerationSettings();

    // Extract prompt entries from ST prompts array
    if (Array.isArray(data.prompts)) {
      // Build enabled map from prompt_order (use last order set)
      const enabledMap = {};
      if (Array.isArray(data.prompt_order) && data.prompt_order.length > 0) {
        const orderSet = data.prompt_order[data.prompt_order.length - 1];
        if (orderSet && Array.isArray(orderSet.order)) {
          orderSet.order.forEach(o => { enabledMap[o.identifier] = o.enabled; });
        }
      }

      const entries = [];
      data.prompts.forEach(p => {
        if (p.marker) return; // skip marker-only entries
        if (!p.content || !p.content.trim()) return; // skip empty
        const enabled = enabledMap[p.identifier] != null ? enabledMap[p.identifier] : (p.enabled !== false);
        entries.push({
          id: 'pe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name: p.name || p.identifier || 'Untitled',
          content: p.content.trim(),
          enabled: enabled
        });
      });
      if (entries.length > 0) {
        savePromptEntries(entries);
        renderPromptEntries();
      }
    }

    // Save as a named preset
    const presetName = data.name || file.name.replace(/\.json$/i, '');
    const presets = readPresetRecords();
    const preset = {
      id: 'preset_' + Date.now(),
      name: presetName,
      promptEntries: loadPromptEntries(),
      temperature: temperature !== null ? String(temperature) : '',
      extraParams: document.getElementById('setExtraParams').value.trim()
    };
    presets.push(preset);
    localStorage.setItem('assistantPresets', JSON.stringify(presets));
    syncScheduleAutoPush();
    loadPresets();
    document.getElementById('setPresetSelect').value = preset.id;
    showToast('Imported ST preset: ' + presetName, 'success');
    } catch (err) {
      showToast('Could not import preset: ' + sanitizeErrorDetail(err), 'error');
    } finally {
      finishOperation();
    }
  };
  reader.onerror = reader.onabort = () => {
    showToast('Could not read preset file.', 'error');
    finishOperation();
  };
  try {
    reader.readAsText(file);
  } catch (err) {
    showToast('Could not read preset file.', 'error');
    finishOperation();
  }
}

// ============================================
// Prompt Manager
// ============================================
function loadPromptEntries() {
  try { return normalizePromptEntries(JSON.parse(localStorage.getItem('llmPromptEntries') || '[]')) || []; } catch(e) { return []; }
}

function savePromptEntries(entries) {
  localStorage.setItem('llmPromptEntries', JSON.stringify(normalizePromptEntries(entries) || []));
  syncScheduleAutoPush();
}

function migrateToPromptEntries() {
  if (localStorage.getItem('llmPromptEntries')) return;
  const entries = [];
  const sys = localStorage.getItem('llmSystemPrompt');
  entries.push({ id: 'pe_' + Date.now() + '_sys', name: 'System Prompt', content: sys || 'You are a helpful assistant.', enabled: true });
  const persona = localStorage.getItem('llmPersona');
  if (persona) {
    entries.push({ id: 'pe_' + Date.now() + '_per', name: 'Persona', content: persona, enabled: true });
  }
  savePromptEntries(entries);
}

function renderPromptEntries() {
  const list = document.getElementById('promptEntryList');
  if (!list) return;
  list.innerHTML = '';
  const entries = loadPromptEntries();

  entries.forEach((entry) => {
    const div = document.createElement('div');
    div.className = 'prompt-entry' + (entry.enabled ? '' : ' disabled');
    div.dataset.peId = entry.id;

    // Drag-and-drop
    div.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', entry.id);
      div.classList.add('dragging');
    });
    div.addEventListener('dragend', () => div.classList.remove('dragging'));
    div.addEventListener('dragover', (e) => { e.preventDefault(); div.classList.add('drag-over'); });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      div.classList.remove('drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (draggedId === entry.id) return;
      const current = loadPromptEntries();
      const fromIdx = current.findIndex(x => x.id === draggedId);
      const toIdx = current.findIndex(x => x.id === entry.id);
      if (fromIdx === -1 || toIdx === -1) return;
      const [moved] = current.splice(fromIdx, 1);
      current.splice(toIdx, 0, moved);
      savePromptEntries(current);
      renderPromptEntries();
    });

    // Header row
    const header = document.createElement('div');
    header.className = 'prompt-entry-header';

    const drag = document.createElement('span');
    drag.className = 'drag-handle';
    drag.textContent = '☰';
    drag.draggable = true;

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = entry.enabled;
    toggle.title = entry.enabled ? 'Enabled' : 'Disabled';
    toggle.onchange = () => togglePromptEntry(entry.id);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'pe-name';
    nameInput.value = entry.name;
    nameInput.oninput = () => updatePromptEntry(entry.id, 'name', nameInput.value);

    const expandBtn = document.createElement('button');
    expandBtn.textContent = '▾';
    expandBtn.title = 'Expand/collapse';
    expandBtn.onclick = () => {
      const body = div.querySelector('.prompt-entry-body');
      body.classList.toggle('open');
      expandBtn.textContent = body.classList.contains('open') ? '▴' : '▾';
    };

    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Delete entry';
    delBtn.onclick = () => deletePromptEntry(entry.id);

    header.appendChild(drag);
    header.appendChild(toggle);
    header.appendChild(nameInput);
    header.appendChild(expandBtn);
    header.appendChild(delBtn);

    // Body (collapsible textarea)
    const body = document.createElement('div');
    body.className = 'prompt-entry-body';
    const ta = document.createElement('textarea');
    ta.value = entry.content;
    ta.placeholder = 'Enter prompt content...';
    ta.oninput = () => updatePromptEntry(entry.id, 'content', ta.value);
    body.appendChild(ta);

    div.appendChild(header);
    div.appendChild(body);
    list.appendChild(div);
  });
}

function addPromptEntry() {
  const entries = loadPromptEntries();
  entries.push({ id: 'pe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), name: 'New Prompt', content: '', enabled: true });
  savePromptEntries(entries);
  renderPromptEntries();
}

function deletePromptEntry(id) {
  let entries = loadPromptEntries();
  entries = entries.filter(e => e.id !== id);
  savePromptEntries(entries);
  renderPromptEntries();
}

function togglePromptEntry(id) {
  const entries = loadPromptEntries();
  const entry = entries.find(e => e.id === id);
  if (entry) entry.enabled = !entry.enabled;
  savePromptEntries(entries);
  renderPromptEntries();
}

function updatePromptEntry(id, field, value) {
  const entries = loadPromptEntries();
  const entry = entries.find(e => e.id === id);
  if (entry) entry[field] = value;
  savePromptEntries(entries);
}

function isStMacroEnabled() {
  return localStorage.getItem('llmEnableStMacros') === 'true';
}

function getRpMacroContext(conv) {
  const card = (conv && conv.characterCard) || {};
  const userName = (localStorage.getItem('llmRpUserName') || '').trim() || 'User';
  const charName = (typeof card.name === 'string' && card.name.trim()) ||
    (conv && typeof conv.title === 'string' && conv.title.trim()) ||
    'Assistant';
  return {
    user: userName,
    username: userName,
    user_name: userName,
    char: charName,
    char_name: charName,
    charname: charName,
    character: charName,
    character_name: charName,
    bot: charName,
    bot_name: charName,
    assistant: charName,
    description: card.description || '',
    personality: card.personality || '',
    scenario: card.scenario || ''
  };
}

function applyStMacros(text, context) {
  if (typeof text !== 'string' || !text) return text;
  const ctx = context || {};
  return text.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, rawKey) => {
    const key = String(rawKey || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(ctx, key)) return match;
    const value = ctx[key];
    return value == null ? '' : String(value);
  });
}

async function buildSystemMessages(conv) {
  const msgs = [];
  const macroCtx = isStMacroEnabled() ? getRpMacroContext(conv) : null;
  const resolveText = (text) => macroCtx ? applyStMacros(text, macroCtx) : text;
  // Prompt entries (never overridden by character cards)
  const entries = loadPromptEntries();
  entries.forEach(entry => {
    const content = resolveText(entry.content);
    if (entry.enabled && typeof content === 'string' && content.trim()) msgs.push({ role: 'system', content });
  });
  // Project instructions and files. Sits after prompt entries (which are the user's
  // global system prompt and are never overridden) but before the empty fallback below,
  // so a project with instructions suppresses "You are a helpful assistant."
  // Macros are applied to instructions only — resolving them inside a source file would
  // silently rewrite any {{...}} the file happens to contain.
  const project = isTemporaryConversation(conv) ? null : getProject(conv && conv.projectId);
  if (project) {
    if (project.instructions && project.instructions.trim()) {
      msgs.push({ role: 'system', content: 'Project instructions (' + project.name + '):\n\n' + resolveText(project.instructions) });
    }
    const projectFiles = projectDocsSystemText(project);
    if (projectFiles) msgs.push({ role: 'system', content: projectFiles });
  }
  // Fallback if completely empty
  if (msgs.length === 0) {
    msgs.push({ role: 'system', content: 'You are a helpful assistant.' });
  }
  if (conv && typeof conv.goal === 'string' && conv.goal.trim()) {
    msgs.push({ role: 'system', content: 'Conversation goal:\n\n' + resolveText(conv.goal.trim()) });
  }
  // Character card system_prompt (actual instructions from the card)
  if (conv && conv.characterSystemPrompt && conv.characterSystemPrompt.trim()) {
    msgs.push({ role: 'system', content: resolveText(conv.characterSystemPrompt) });
  }
  // Character description — who the assistant is (from character cards)
  if (conv && conv.characterDescription && conv.characterDescription.trim()) {
    msgs.push({ role: 'system', content: 'The following describes your character \u2014 this is who YOU are, not the user:\n\n' + resolveText(conv.characterDescription) });
  }
  // Persona — who the user is
  const persona = (conv && conv.persona) || localStorage.getItem('llmPersona') || '';
  if (persona.trim()) {
    msgs.push({ role: 'system', content: 'The following describes the user you are speaking with:\n\n' + resolveText(persona) });
  }
  // Conversation summary
  if (conv && conv.summary) {
    msgs.push({ role: 'system', content: 'Conversation summary:\n' + conv.summary });
  }
  // Memory prompt
  const mem = isTemporaryConversation(conv) ? '' : await getMemoryPrompt();
  if (mem) msgs.push({ role: 'system', content: mem });
  if (areEmotionSpritesEnabled()) msgs.push({ role: 'system', content: buildEmotionSpriteInstructions() });
  return msgs;
}

function isFailedAssistantMessage(message) {
  if (!message || message.role !== 'assistant') return false;
  const request = message.swipeRequests?.[message.swipeIndex || 0];
  return request?.status ? ['failed', 'stopped', 'interrupted'].includes(request.status) : /^\s*(Error:|Request failed:|Request interrupted\.)/i.test(getMsgText(message));
}

function isPendingAssistantMessage(message) {
  if (!message || message.role !== 'assistant') return false;
  const request = message.swipeRequests?.[message.swipeIndex || 0];
  return request?.status ? ['pending', 'streaming'].includes(request.status) :
    !String(getMsgText(message) || '').trim() && !(message.swipeImages?.[message.swipeIndex || 0] || message.images || []).length;
}

function filterRequestHistory(source, options = {}) {
  const list = Array.isArray(source) ? source : [];
  const end = Number.isInteger(options.untilIndex) ? options.untilIndex : list.length;
  const includeTarget = options.includeTarget === true;
  const included = [];
  const excluded = [];
  list.slice(0, end).forEach((message, index) => {
    if (!message || !['user', 'assistant'].includes(message.role)) return;
    const isTarget = index === options.targetIndex;
    if (message.role === 'assistant' && (isPendingAssistantMessage(message) || isFailedAssistantMessage(message))) return;
    if (message.includeInContext === false && !(includeTarget && isTarget)) {
      excluded.push({ message, index });
      return;
    }
    included.push({ message, index });
  });
  return { included, excluded };
}

function buildComposerMessage(text = document.getElementById('chatInput')?.value || '', attachments = pendingAttachments) {
  const messageText = String(text || '').trim();
  const queued = Array.isArray(attachments) ? attachments : [];
  if (!messageText && queued.length === 0) return null;
  if (queued.length === 0) return { role: 'user', content: messageText };
  const content = [];
  if (messageText) content.push({ type: 'text', text: messageText });
  queued.forEach(att => {
    if (att.type === 'image') {
      content.push({ type: 'image_url', image_url: { url: att.dataUrl } });
    } else if (typeof att.textContent === 'string') {
      const filePart = { name: att.name, mime: att.mime, textContent: att.textContent };
      if (att.dataUrl) filePart.url = att.dataUrl;
      if (att.binary) filePart.binary = true;
      content.push({ type: 'file', file: filePart });
    } else {
      content.push({ type: 'file', file: { url: att.dataUrl, name: att.name, mime: att.mime } });
    }
  });
  return { role: 'user', content };
}

async function buildRequestMessages(conv = getActiveConv(), options = {}) {
  const source = Array.isArray(options.messageList) ? options.messageList : messages;
  if (Number.isInteger(options.untilIndex) && options.untilIndex < conv?.messages.length) {
    invalidateConversationContext(conv, options.untilIndex);
  }
  const systemMessages = await buildSystemMessages(conv);
  const toolPolicy = getToolPolicy(conv);
  if (toolPolicy.webSearch || toolPolicy.urlFetch) {
    systemMessages.push({ role: 'system', content: SOURCE_CITATION_INSTRUCTION });
  }
  const requestMessages = [...systemMessages];
  const selection = filterRequestHistory(source, options);
  selection.included = selection.included.map(({ message, index }) => {
    const normalized = { role: message.role, content: buildApiContent(message) };
    requestMessages.push(normalized);
    return { message, index, normalized };
  });
  let draft = null;
  if (options.draftMessage && getMsgText(options.draftMessage).trim()) {
    draft = { message: options.draftMessage, index: source.length, normalized: { role: 'user', content: buildApiContent(options.draftMessage) } };
    requestMessages.push(draft.normalized);
  }
  return { messages: requestMessages, systemMessages, included: selection.included, excluded: selection.excluded, draft, toolPolicy };
}

function getModelContextWindow(model = localStorage.getItem('llmModel') || '') {
  try { return getTargetContextWindow(getActiveRequestTarget(model || undefined)); }
  catch (e) { return null; }
}

function getRequestContextStats(requestMessages, excluded = [], model = localStorage.getItem('llmModel') || '') {
  const includedTokens = (requestMessages || []).reduce((total, message) => {
    if (message.role === 'system') return total + estimateTokens(typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''));
    return total + estimateTokens(getMsgText(message));
  }, 0);
  const excludedTokens = (excluded || []).reduce((total, item) => total + estimateTokens(getMsgText(item.message)), 0);
  const maxOutput = resolveMaxTokens();
  const contextWindow = getModelContextWindow(model);
  return { includedTokens, excludedTokens, maxOutput, contextWindow, usage: contextWindow ? (includedTokens + maxOutput) / contextWindow : null };
}

function contextLimitMessage(stats) {
  if (!stats?.contextWindow || stats.includedTokens + stats.maxOutput <= stats.contextWindow) return '';
  return 'This request is too large for the configured context window (' +
    formatTokenCount(stats.includedTokens + stats.maxOutput) + ' of ' + formatTokenCount(stats.contextWindow) + ' tokens). Exclude older messages or compact the conversation.';
}

function guardContextLimit(requestContext, model = localStorage.getItem('llmModel') || '') {
  const stats = getRequestContextStats(requestContext?.messages, requestContext?.excluded, model);
  const warning = contextLimitMessage(stats);
  if (!warning) return false;
  showToast(warning, 'error', 7000);
  announce('Request blocked because the context window is too small.');
  return true;
}

async function buildContextPreviewData() {
  const conv = getActiveConv();
  const draftMessage = buildComposerMessage();
  const built = await buildRequestMessages(conv, { messageList: messages, draftMessage });
  const all = await buildRequestMessages(conv, { messageList: messages });
  const stats = getRequestContextStats(built.messages, built.excluded);
  const attachments = [];
  const collectAttachments = (message, included) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach(part => {
      if (part.type === 'file') attachments.push({ name: part.file?.name || 'file', chars: String(part.file?.textContent || '').length, included });
      if (part.type === 'image_url') attachments.push({ name: 'image attachment', chars: 0, included, image: true });
    });
  };
  messages.forEach(message => collectAttachments(message, message.includeInContext !== false));
  if (draftMessage) collectAttachments(draftMessage, true);
  return { provider: getLlmProviderInfo(localStorage.getItem('llmModel') || '', detectApiFormat(localStorage.getItem('llmModel') || ''), localStorage.getItem('llmProxyUrl') || ''), model: localStorage.getItem('llmModel') || '(not set)', systemMessages: built.systemMessages, included: built.included, excluded: all.excluded, draft: built.draft, attachments, stats };
}

function openContextSection(sectionId) {
  toggleContextPanel(true);
  const section = document.getElementById(sectionId);
  if (section) {
    section.open = true;
    requestAnimationFrame(() => section.scrollIntoView({ block: 'nearest', behavior: getScrollBehavior() }));
  }
}

function updateConversationGoal(value, immediate = false) {
  const conv = getActiveConv();
  if (!conv || readOnlyShare) return;
  const next = String(value || '').slice(0, 4000);
  if (conv.goal === next) return;
  conv.goal = next;
  conv.updatedAt = Date.now();
  const input = document.getElementById('conversationGoal');
  if (input && input.value !== next) input.value = next;
  const status = document.getElementById('goalStatus');
  if (status) status.textContent = next.trim() ? 'Active' : 'Optional';
  if (immediate) saveConversations();
  else debouncedSave();
  updateTokenInfo();
}

async function saveConversationTools() {
  const conv = getActiveConv();
  if (!conv || readOnlyShare) return;
  conv.toolPolicy = {
    webSearch: Boolean(document.getElementById('chatToolWebSearch')?.checked),
    urlFetch: Boolean(document.getElementById('chatToolUrlFetch')?.checked),
    confirm: Boolean(document.getElementById('chatToolConfirm')?.checked)
  };
  delete (contextDrafts.get(conv) || {}).tools;
  conv.updatedAt = Date.now();
  await saveConversationImmediately();
  renderContextPanel();
  updateTokenInfo();
  announce('Conversation tool policy saved.');
  showToast('Tools updated for this conversation.', 'success');
}

function navigateForkConversation(id) {
  const target = conversations.find(conv => conv.id === id);
  if (!target) return;
  setConversationView(target.archivedAt ? 'archived' : 'active');
  switchConversation(id);
}

function renderContextPanel() {
  if (readOnlyShare) return;
  const conv = getActiveConv();
  if (!conv) return;
  renderConversationHeader();
  let draft = contextDrafts.get(conv);
  if (!draft) { draft = {}; contextDrafts.set(conv, draft); }
  const conversationChanged = contextPanelConversationId !== conv.id;
  if (conversationChanged) {
    contextPanelConversationId = conv.id;
    contextSourceMessage = null;
    const preview = document.getElementById('contextPreviewBody');
    if (preview) preview.innerHTML = '<p class="setting-hint">Open this section with the Context button to build a preview.</p>';
  }
  const goalInput = document.getElementById('conversationGoal');
  if (goalInput && (conversationChanged || document.activeElement !== goalInput)) goalInput.value = conv.goal || '';
  const goalStatus = document.getElementById('goalStatus');
  if (goalStatus) goalStatus.textContent = conv.goal?.trim() ? 'Active' : 'Optional';

  const policy = draft.tools || getToolPolicy(conv);
  const web = document.getElementById('chatToolWebSearch');
  const url = document.getElementById('chatToolUrlFetch');
  const confirm = document.getElementById('chatToolConfirm');
  if (web) web.checked = policy.webSearch;
  if (url) url.checked = policy.urlFetch;
  if (confirm) confirm.checked = policy.confirm;
  [web, url, confirm].filter(Boolean).forEach(input => {
    input.onchange = () => {
      draft.tools = { webSearch: web.checked, urlFetch: url.checked, confirm: confirm.checked };
      renderContextPanel();
    };
  });
  const toolsStatus = document.getElementById('toolsStatus');
  if (toolsStatus) toolsStatus.textContent = draft.tools ? 'Unsaved' : [policy.webSearch && 'Search', policy.urlFetch && 'Fetch'].filter(Boolean).join(' + ') || 'Off';

  const summary = document.getElementById('summaryText');
  if (summary) {
    const value = draft.summary ?? conv.summary ?? '';
    if (summary.value !== value) summary.value = value;
    summary.oninput = () => { draft.summary = summary.value; renderContextPanel(); };
  }
  const summaryStatus = document.getElementById('summaryStatus');
  if (summaryStatus) summaryStatus.textContent = draft.summary !== undefined ? 'Unsaved' : conv.summary?.trim() ? 'Saved' : 'Empty';
  const genBtn = document.getElementById('summaryGen');
  if (genBtn) {
    genBtn.disabled = summaryJobs.has(conv.id);
    genBtn.textContent = summaryJobs.has(conv.id) ? 'Generating...' : 'Generate';
  }
  [['tools', 'toolsSection'], ['summary', 'summarySection']].forEach(([key, section]) => {
    let button = document.getElementById('discardContext' + key);
    if (!button) {
      button = document.createElement('button');
      button.id = 'discardContext' + key;
      button.type = 'button';
      button.className = 'btn btn-secondary';
      button.textContent = 'Discard draft';
      document.querySelector('#' + section + ' .context-panel-section-body')?.appendChild(button);
    }
    button.hidden = draft[key] === undefined;
    button.onclick = () => { delete draft[key]; renderContextPanel(); };
  });

  const project = isTemporaryConversation(conv) ? null : getProject(conv.projectId);
  const chatDocs = Array.isArray(conv.docs) ? conv.docs : [];
  const projectDocs = Array.isArray(project?.docs) ? project.docs : [];
  const fileStatus = document.getElementById('filesStatus');
  const filesBody = document.getElementById('contextFilesBody');
  const fileCount = chatDocs.length + projectDocs.length;
  if (fileStatus) fileStatus.textContent = fileCount ? String(fileCount) : 'None';
  if (filesBody) {
    filesBody.replaceChildren();
    const addFiles = (label, docs) => {
      if (!docs.length) return;
      const heading = document.createElement('strong');
      heading.className = 'context-file-heading';
      heading.textContent = label;
      filesBody.appendChild(heading);
      docs.forEach(doc => {
        const row = document.createElement('div');
        row.className = 'context-file-row';
        row.textContent = doc.name || 'Document';
        filesBody.appendChild(row);
      });
    };
    addFiles('This chat', chatDocs);
    addFiles(project ? project.name : 'Project', projectDocs);
    if (!fileCount) {
      const empty = document.createElement('p');
      empty.textContent = isTemporaryConversation(conv)
        ? 'No files in this temporary chat.'
        : 'No files in this chat or its project.';
      filesBody.appendChild(empty);
    }
    const search = document.createElement('button');
    search.type = 'button';
    search.className = 'btn btn-secondary context-wide-action';
    search.textContent = 'Search files';
    search.disabled = !fileCount;
    search.onclick = () => openFileSearch();
    filesBody.appendChild(search);
  }

  if (!conv.messages.includes(contextSourceMessage)) contextSourceMessage = null;
  renderContextSources(contextSourceMessage);

  const links = document.getElementById('contextForkLinks');
  const forkStatus = document.getElementById('forksStatus');
  if (links) {
    links.replaceChildren();
    let count = 0;
    const addLink = (label, related) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'context-fork-link';
      button.textContent = label + ': ' + (related.title || 'Untitled chat');
      button.onclick = () => navigateForkConversation(related.id);
      links.appendChild(button);
      count++;
    };
    if (conv.parentConversationId) {
      const parent = conversations.find(item => item.id === conv.parentConversationId);
      if (parent) addLink('Parent', parent);
      else {
        const missing = document.createElement('p');
        missing.textContent = 'Parent unavailable.';
        links.appendChild(missing);
      }
    }
    conversations.filter(item => item.parentConversationId === conv.id).forEach(child => addLink('Fork', child));
    if (!links.children.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No related conversations.';
      links.appendChild(empty);
    }
    if (forkStatus) forkStatus.textContent = count ? String(count) : 'None';
  }
}

async function openContextPreview() {
  const body = document.getElementById('contextPreviewBody');
  if (!body) return;
  const conversationId = activeConvId;
  body.textContent = 'Building request preview...';
  openContextSection('requestContextSection');
  try {
    const data = await buildContextPreviewData();
    if (activeConvId !== conversationId) return;
    body.innerHTML = '';
    const summary = document.createElement('div');
    summary.className = 'context-summary';
    const denominator = data.stats.contextWindow ? ' / ' + formatTokenCount(data.stats.contextWindow) : '';
    summary.textContent = data.provider.name + ' · ' + data.model + ' · ~' + formatTokenCount(data.stats.includedTokens) + ' prompt tokens' + denominator + ' · max output ' + formatTokenCount(data.stats.maxOutput) + (data.stats.usage != null ? ' · ' + Math.round(data.stats.usage * 100) + '% estimated use' : ' · context limit unknown');
    body.appendChild(summary);
    const addSection = (title, rows) => {
      const section = document.createElement('section');
      section.className = 'context-section';
      const heading = document.createElement('h3');
      heading.textContent = title;
      section.appendChild(heading);
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'setting-hint';
        empty.textContent = 'None';
        section.appendChild(empty);
      } else rows.forEach(row => { const pre = document.createElement('pre'); pre.textContent = row; section.appendChild(pre); });
      body.appendChild(section);
    };
    addSection('System context', data.systemMessages.map(message => message.content));
    addSection('Included history', data.included.map(item => item.message.role.toUpperCase() + ': ' + getMsgText(item.message)));
    if (data.draft) addSection('Current draft', [data.draft.message.role.toUpperCase() + ': ' + getMsgText(data.draft.message)]);
    addSection('Excluded history', data.excluded.map(item => item.message.role.toUpperCase() + ': ' + getMsgText(item.message)));
    addSection('Attachments', data.attachments.map(att => att.name + ' · ' + (att.image ? 'image data redacted' : att.chars.toLocaleString() + ' extracted characters') + (att.included ? ' · included' : ' · excluded')));
    if (data.stats.contextWindow && data.stats.includedTokens + data.stats.maxOutput > data.stats.contextWindow) {
      const warning = document.createElement('p');
      warning.className = 'context-warning';
      warning.textContent = 'Estimated context use exceeds the configured window. Counts are advisory estimates.';
      body.prepend(warning);
    }
  } catch (err) {
    if (activeConvId === conversationId) body.textContent = 'Could not build preview: ' + sanitizeErrorDetail(err);
  }
}

async function compactOlderTurns() {
  if (readOnlyShare) return;
  const conv = getActiveConv();
  if (!conv || summaryJobs.has(conv.id)) return;
  const jobId = conv.id;
  if (contextDrafts.get(conv)?.summary !== undefined) { showToast('Save or discard your summary draft first.', 'info'); return; }
  const candidates = filterRequestHistory(conv.messages).included;
  if (candidates.length <= 8) { showToast('There are not enough older turns to compact.', 'info'); return; }
  const older = candidates.slice(0, -8);
  const transcript = older.map(item => (item.message.role === 'assistant' ? 'Assistant: ' : 'User: ') + getMsgText(item.message)).join('\n');
  const valid = captureContextSource(conv, true);
  const coverage = summaryCoverageThrough(conv, older);
  summaryJobs.add(jobId);
  renderContextPanel();
  try {
    const target = getActiveRequestTarget();
    announce('Generating a nondestructive summary of older turns.');
    const summary = (await callApiNonStreaming([
      { role: 'system', content: 'Summarize these older conversation turns into a concise context note. Preserve facts, decisions, preferences, and unresolved tasks. Do not invent details.' },
      { role: 'user', content: transcript }
    ], { target, signal: null })).trim();
    if (!valid()) return;
    if (!summary) throw new Error('The provider returned an empty summary.');
    conv.summary = conv.summary ? conv.summary + '\n\n' + summary : summary;
    conv.summaryCoverage = coverage;
    conv.summaryUpdatedAt = Date.now();
    older.forEach(item => { item.message.includeInContext = false; item.message.autoCompacted = true; });
    conv.updatedAt = Date.now();
    await saveConversationImmediately();
    showToast('Older turns summarized and excluded from future requests. History remains intact.', 'success');
    announce('Older turns compacted successfully.');
    if (getActiveConv() === conv) { renderMessages({ preserveScroll: true }); await openContextPreview(); }
  } catch (err) {
    showToast('Compaction failed: ' + sanitizeErrorDetail(err), 'error');
  } finally {
    summaryJobs.delete(jobId);
    renderContextPanel();
  }
}

// ============================================
// Render Messages
// ============================================
function maybeAddAvatar(wrapper) {
  const conv = getActiveConv();
  if (conv && conv.characterAvatar) {
    const safeAvatar = safeMediaUrl(conv.characterAvatar);
    if (!safeAvatar) return;
    wrapper.classList.add('has-avatar');
    const avatar = document.createElement('img');
    avatar.className = 'msg-avatar';
    avatar.src = safeAvatar;
    avatar.alt = '';
    wrapper.appendChild(avatar);
  }
}

const DEFAULT_STARTER_PROMPTS = [
  'Help me plan today\'s priorities.',
  'Explain a difficult topic clearly.',
  'Review and improve some writing.',
  'Turn my notes into an action plan.'
];

function getStarterPrompts() {
  try {
    const saved = JSON.parse(localStorage.getItem('assistantStarterPrompts') || 'null');
    if (Array.isArray(saved)) return saved.map(String).map(text => text.trim()).filter(Boolean).slice(0, 8);
  } catch (error) {
    console.warn('Starter prompt parse error:', error);
  }
  return DEFAULT_STARTER_PROMPTS;
}

function insertStarterPrompt(text) {
  const input = document.getElementById('chatInput');
  if (!input || readOnlyShare) return;
  input.value = String(text || '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function renderEmptyConversation(area) {
  const placeholder = document.createElement('div');
  placeholder.className = 'chat-placeholder starter-surface';
  const configured = Boolean((localStorage.getItem('llmProxyUrl') || '').trim()) && (!providerRequiresKey() || Boolean(getApiKey()));
  const heading = document.createElement('h2');
  heading.textContent = configured ? 'Start a conversation' : 'Connect a provider to start';
  const detail = document.createElement('p');
  detail.textContent = configured
    ? (localStorage.getItem('llmModel') || 'Choose a model from the toolbar')
    : 'Your provider receives messages directly from this browser.';
  placeholder.append(heading, detail);

  if (configured && localStorage.getItem('assistantStarterPromptsHidden') !== 'true') {
    const prompts = document.createElement('div');
    prompts.className = 'starter-prompts';
    getStarterPrompts().forEach(text => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.onclick = () => insertStarterPrompt(text);
      prompts.appendChild(button);
    });
    if (prompts.children.length) placeholder.appendChild(prompts);
  }

  const actions = document.createElement('div');
  actions.className = 'starter-actions';
  const addAction = (label, action, primary = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ' + (primary ? 'btn-primary' : 'btn-secondary');
    button.textContent = label;
    button.onclick = action;
    actions.appendChild(button);
  };
  if (!configured) {
    addAction('Connect provider', () => openSettingsSection('api'), true);
  } else {
    addAction('Attach a file', () => document.getElementById('fileInput')?.click());
    addAction('Set a goal', () => openContextSection('goalSection'));
    addAction('Shortcuts', () => openModal('shortcutsModal'));
  }
  placeholder.appendChild(actions);
  area.appendChild(placeholder);
}

function renderMessages({ preserveScroll = false } = {}) {
  if (streaming) return;
  closeChatSearch();
  renderContextPanel();
  renderFollowUpQueue();
  const area = document.getElementById('messagesArea');
  const wasAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight <= 4;
  const savedScrollTop = preserveScroll && !wasAtBottom ? area.scrollTop : null;
  area.innerHTML = '';
  if (isTemporaryConversation(getActiveConv())) {
    const notice = document.createElement('div');
    notice.className = 'temporary-chat-notice';
    notice.setAttribute('role', 'note');
    notice.textContent = TEMPORARY_CHAT_NOTICE;
    area.appendChild(notice);
  }

  if (messages.length === 0) {
    renderEmptyConversation(area);
    updateSendBtnState();
    return;
  }

  messages.forEach((msg, idx) => {
    if (msg._editing) {
      renderEditMode(area, msg, idx);
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper ' + msg.role + (msg.includeInContext === false ? ' excluded' : '');
    wrapper.dataset.msgIdx = idx;
    wrapper.setAttribute('role', 'article');
    wrapper.setAttribute('tabindex', '0');
    wrapper.setAttribute('aria-label', (msg.role === 'user' ? 'User message' : 'Assistant message') + (msg.includeInContext === false ? ', excluded from context' : ''));

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble ' + msg.role;

    if (msg.role === 'user') {
      if (Array.isArray(msg.content)) {
        msg.content.forEach(part => {
          if (part.type === 'text') {
            const sp = document.createElement('span');
            sp.textContent = part.text;
            bubble.appendChild(sp);
          } else if (part.type === 'image_url') {
            const img = document.createElement('img');
            const safeUrl = safeMediaUrl(part.image_url.url);
            if (!safeUrl) return;
            img.src = safeUrl;
            img.className = 'chat-inline-img';
            img.alt = 'User uploaded image';
            bubble.appendChild(img);
          } else if (part.type === 'file') {
            const fileName = part.file?.name || 'file';
            const fileUrl = part.file?.url;
            const safeUrl = safeFileUrl(fileUrl);
            const badge = document.createElement(safeUrl ? 'a' : 'span');
            badge.className = 'chat-file-badge';
            badge.textContent = '\u{1F4C4} ' + fileName;
            if (safeUrl) {
              badge.href = safeUrl;
              badge.download = fileName;
              badge.title = 'Download ' + fileName;
            } else {
              badge.title = 'Attached file: ' + fileName;
            }
            bubble.appendChild(badge);
          }
        });
      } else {
        bubble.textContent = msg.content;
      }
    } else if (msg.role === 'assistant') {
      const thinkData = msg.swipeThinking && msg.swipeThinking[msg.swipeIndex];
      const toolData = msg.swipeToolUse && msg.swipeToolUse[msg.swipeIndex];
      const imgData = msg.swipeImages && msg.swipeImages[msg.swipeIndex];
      const _h = stripThinkTags(msg.content);
      const _hThink = _h.thinking ? (thinkData || '') + _h.thinking : (thinkData || '');
      setBubbleHTML(bubble, _hThink, renderToolBlocksHTML(toolData || []) + renderMarkdown(_h.content) + renderGenImages(imgData));
      postRenderProcessing(bubble);
    } else {
      bubble.textContent = msg.content;
    }

    if (msg.role === 'assistant') maybeAddAvatar(wrapper);
    wrapper.appendChild(bubble);

    // Keep frequent actions visible and put the rest in one keyboard-capable menu.
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.setAttribute('role', 'toolbar');
    actions.setAttribute('aria-label', (msg.role === 'assistant' ? 'Assistant' : 'User') + ' message actions');

    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.setAttribute('aria-label', 'Copy message');
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(getMsgText(msg));
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      } catch (error) {
        showToast('Could not copy this message.', 'error');
      }
    };
    actions.appendChild(copyBtn);

    const request = msg.role === 'assistant' ? getSwipeRequest(msg) : null;
    const isComparison = msg.role === 'assistant' && msg.comparison === true;
    if (!isComparison && request && ['failed', 'interrupted', 'stopped'].includes(request.status)) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'msg-action-btn retry-btn';
      retryBtn.textContent = 'Retry';
      retryBtn.onclick = () => retryRequest(idx);
      actions.appendChild(retryBtn);
    } else if (!isComparison && msg.role === 'assistant' && idx === messages.length - 1) {
      const regenerateBtn = document.createElement('button');
      regenerateBtn.className = 'msg-action-btn';
      regenerateBtn.textContent = 'Regenerate';
      regenerateBtn.onclick = () => regenerate();
      actions.appendChild(regenerateBtn);
    }

    const toolData = msg.role === 'assistant' && msg.swipeToolUse?.[msg.swipeIndex];
    const hasSources = msg.role === 'assistant' && ((msg.swipeSources?.[msg.swipeIndex]?.length > 0) || (toolData && toolData.some(tb =>
      (tb.type === 'url_fetch' && (tb.content || tb.url)) || (tb.results || []).some(result => result.url)
    )));
    const requestStatus = request?.status;
    const canContinue = !isComparison && msg.role === 'assistant' && idx === messages.length - 1 &&
      Boolean(String(getMsgText(msg) || '').trim()) && (!requestStatus || requestStatus === 'complete') &&
      !NO_TRAILING_ASSISTANT_RE.test(localStorage.getItem('llmModel') || '');
    const secondaryActions = [];
    if (msg.role === 'assistant') secondaryActions.push({ id: 'read-aloud', get label() { return spokenMessage === msg ? 'Stop reading aloud' : 'Read aloud'; }, action: () => speakMessage(msg) });
    if (msg.role === 'assistant' && idx === messages.length - 1 && getMsgText(msg).trim() && (!requestStatus || requestStatus === 'complete')) {
      secondaryActions.push({ label: 'Suggest follow-ups', action: () => suggestFollowUps(idx) });
    }
    if (hasSources) secondaryActions.push({ label: 'Sources', action: () => openSourcesDrawer(msg) });
    secondaryActions.push({
      label: msg.includeInContext === false ? 'Include in context' : 'Exclude from context',
      action: () => {
        msg.includeInContext = msg.includeInContext === false;
        delete msg.autoCompacted;
        const conv = getActiveConv();
        invalidateConversationContext(conv, idx);
        if (conv) conv.updatedAt = Date.now();
        saveConversations();
        renderMessages();
        updateTokenInfo();
        announce(msg.includeInContext === false ? 'Message excluded from future context.' : 'Message included in future context.');
      }
    });
    if (msg.role === 'user') secondaryActions.push({ label: 'Edit and resend', action: () => { msg._editing = true; renderMessages(); } });
    secondaryActions.push({ label: 'Fork from here', action: () => forkBranch(idx) });
    if (msg.role === 'assistant' && msg.swipes?.length > 1) {
      secondaryActions.push({
        label: 'Delete this response version',
        danger: true,
        action: () => {
          if (readOnlyShare || sending || streaming || messages[idx] !== msg) return;
          if (!confirm('Delete this response version?')) return;
          invalidateConversationContext(getActiveConv(), idx);
          const swipeIndex = msg.swipeIndex;
          msg.swipes.splice(swipeIndex, 1);
          ['swipeThinking', 'swipeToolUse', 'swipeImages', 'swipeSources', 'swipeLlms', 'swipeRequests', 'swipeTokenEstimates'].forEach(key => {
            if (Array.isArray(msg[key])) msg[key].splice(swipeIndex, 1);
          });
          selectAssistantSwipe(msg, Math.min(swipeIndex, msg.swipes.length - 1));
          const conv = getActiveConv();
          if (conv) conv.updatedAt = Date.now();
          saveConversations();
          renderMessages();
          updateTokenInfo();
        }
      });
    }
    if (canContinue) secondaryActions.push({ label: 'Continue response', action: () => continueMessage() });
    if (request) secondaryActions.push({ label: 'Request details', action: () => showRequestDetails(request) });
    secondaryActions.push({
      label: msg.role === 'assistant' ? 'Delete response' : 'Delete message',
      danger: true,
      action: () => {
        if (readOnlyShare || sending || streaming || messages[idx] !== msg) return;
        if (msg.role === 'assistant' && !confirm('Delete this response?')) return;
        invalidateConversationContext(getActiveConv(), idx);
        messages.splice(idx, 1);
        const conv = getActiveConv();
        if (conv) conv.updatedAt = Date.now();
        saveConversations();
        renderMessages();
        updateTokenInfo();
      }
    });
    const moreBtn = document.createElement('button');
    moreBtn.className = 'msg-action-btn';
    moreBtn.textContent = 'More';
    moreBtn.setAttribute('aria-haspopup', 'menu');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.onclick = () => openActionMenu(moreBtn, secondaryActions, 'Message actions');
    actions.appendChild(moreBtn);
    wrapper.appendChild(actions);

    const metaEl = renderMessageMeta(msg);
    if (metaEl) wrapper.appendChild(metaEl);
    const requestMeta = renderRequestMeta(msg);
    if (requestMeta) wrapper.appendChild(requestMeta);

    if (msg.role === 'assistant') {
      if (request && ['failed', 'interrupted', 'stopped'].includes(request.status)) {
        wrapper.classList.add('request-needs-attention');
      }
      // Swipe controls
      const swipeDiv = document.createElement('div');
      swipeDiv.className = 'swipe-controls' + (msg.swipes && msg.swipes.length > 1 ? ' has-swipes' : '');
      const prev = document.createElement('button');
      prev.textContent = '\u25C0\uFE0E';
      prev.disabled = !msg.swipes || msg.swipeIndex <= 0;
      prev.onclick = () => swipeMsg(idx, -1);
      prev.setAttribute('aria-label', 'Previous swipe');
      const counter = document.createElement('span');
      counter.textContent = msg.swipes ? (msg.swipeIndex + 1) + '/' + msg.swipes.length : '1/1';
      const next = document.createElement('button');
      next.textContent = '\u25B6\uFE0E';
      next.disabled = !msg.swipes || msg.swipeIndex >= msg.swipes.length - 1;
      next.onclick = () => swipeMsg(idx, 1);
      next.setAttribute('aria-label', 'Next swipe');
      swipeDiv.appendChild(prev);
      swipeDiv.appendChild(counter);
      swipeDiv.appendChild(next);
      wrapper.appendChild(swipeDiv);
    }

    // Fade-in on last message only
    if (idx === messages.length - 1) wrapper.classList.add('msg-new');

    area.appendChild(wrapper);
  });

  area.scrollTop = savedScrollTop === null ? area.scrollHeight : savedScrollTop;
  updateSendBtnState();

  // Restore select mode state if active
  if (_selectMode) {
    area.classList.add('select-mode');
    _selectedMsgs.forEach(idx => {
      const w = area.querySelector('.msg-wrapper[data-msg-idx="' + idx + '"]');
      if (w) w.classList.add('selected');
    });
  }
}

function renderEditMode(area, msg, idx) {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-wrapper user';

  const ta = document.createElement('textarea');
  ta.className = 'msg-edit-textarea';
  ta.value = Array.isArray(msg.content) ? msg.content.filter(part => part.type === 'text').map(part => part.text || '').join('\n') : getMsgText(msg);
  wrapper.appendChild(ta);

  if (Array.isArray(msg.content)) {
    const attachments = msg.content.filter(c => c.type === 'image_url' || c.type === 'file');
    if (attachments.length > 0) {
      const attPreview = document.createElement('div');
      attPreview.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;padding:4px 0';
      attachments.forEach(part => {
        if (part.type === 'image_url') {
          const img = document.createElement('img');
          const safeUrl = safeMediaUrl(part.image_url.url);
          if (!safeUrl) return;
          img.src = safeUrl;
          img.className = 'chat-inline-img';
          img.style.cssText = 'max-width:80px;max-height:80px;border-radius:6px;opacity:0.8';
          img.alt = 'Attached image';
          attPreview.appendChild(img);
        } else if (part.type === 'file') {
          const badge = document.createElement('span');
          badge.className = 'chat-file-badge';
          badge.style.opacity = '0.8';
          badge.textContent = '\u{1F4C4} ' + (part.file.name || 'file');
          attPreview.appendChild(badge);
        }
      });
      wrapper.appendChild(attPreview);
    }
  }

  const editActions = document.createElement('div');
  editActions.className = 'msg-edit-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'msg-edit-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => { delete msg._editing; renderMessages(); };

  const saveBtn = document.createElement('button');
  saveBtn.className = 'msg-edit-save';
  saveBtn.textContent = 'Save & Resend';
  saveBtn.onclick = async () => {
    if (readOnlyShare || sending || streaming || messages[idx] !== msg) return;
    const editedText = ta.value;
    if (!editedText.trim() && !(Array.isArray(msg.content) && msg.content.some(part => part.type === 'file' || part.type === 'image_url'))) return;
    delete msg._editing;
    const source = getActiveConv();
    const forked = forkBranch(idx);
    if (!forked) return;
    contextRevisions.set(source, (contextRevisions.get(source) || 0) + 1);
    invalidateConversationContext(forked, idx);
    const editedMessage = messages[idx];
    editedMessage.includeInContext = true;
    delete editedMessage.autoCompacted;

    if (Array.isArray(editedMessage.content)) {
      const attachments = editedMessage.content.filter(c => c.type === 'image_url' || c.type === 'file');
      if (attachments.length > 0) {
        editedMessage.content = [{ type: 'text', text: editedText }, ...attachments];
      } else {
        editedMessage.content = editedText;
      }
    } else {
      editedMessage.content = editedText;
    }
    updateMessageTokenMetadata(editedMessage);
    forked.updatedAt = Date.now();
    saveConversations();
    renderMessages();
    await resendAfterEdit();
  };

  editActions.appendChild(cancelBtn);
  editActions.appendChild(saveBtn);
  wrapper.appendChild(editActions);
  area.appendChild(wrapper);
}

async function resendAfterEdit() {
  if (readOnlyShare || !beginSendingAction()) return;
  const conv = getActiveConv();
  const messageList = messages;
  let assistantMsg;
  let started = false;
  try {
    const target = getActiveRequestTarget();
    const toolPolicy = getToolPolicy(conv);
    const targetIndex = messageList.length - 1;
    const requestContext = await buildRequestMessages(conv, { messageList: messageList.slice(), targetIndex, includeTarget: true });
    assertRequestOwner(conv, messageList);
    const apiMessages = requestContext.messages;
    if (guardTargetContextLimit(apiMessages, target, target.maxTokens || 8192)) return;

    assistantMsg = { role: 'assistant', content: '', swipes: [''], swipeIndex: 0, timestamp: Date.now() };
    messageList.push(assistantMsg);

    const area = document.getElementById('messagesArea');
    const wrapper = document.createElement('div');
    wrapper.className = 'msg-wrapper assistant';
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble assistant';
    bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    maybeAddAvatar(wrapper);
    wrapper.appendChild(bubble);
    area.appendChild(wrapper);
    area.scrollTop = area.scrollHeight;

    await saveConversationImmediately().catch(error => { throw new Error('Could not save the edited prompt: ' + sanitizeErrorDetail(error)); });
    assertRequestOwner(conv, messageList, assistantMsg);
    started = true;
    const status = await streamResponse(apiMessages, assistantMsg, 0, bubble, target.model, null, { conv, messageList, target, toolPolicy });
    assertRequestOwner(conv, messageList, assistantMsg, null);

    if (status === 'complete') {
      extractMemories(apiMessages, conv, target);
    }
    if (conv) conv.updatedAt = Date.now();
    await saveConversations();
    renderMessages({ preserveScroll: true });
    updateTokenInfo();
    return status;
  } catch (error) {
    if (!started && assistantMsg && messageList.includes(assistantMsg)) {
      messageList.splice(messageList.indexOf(assistantMsg), 1);
      if (getActiveConv() === conv) renderMessages();
    }
    if (foregroundAction) foregroundAction.status = error.name === 'AbortError' ? 'stopped' : error.requestStatus || 'failed';
    if (error.name !== 'AbortError') showToast(sanitizeErrorDetail(error), 'error');
  } finally {
    endSendingAction();
  }
}

// ============================================
// Swipe
// ============================================
function swipeMsg(idx, dir) {
  if (readOnlyShare || sending || streaming) return;
  const msg = messages[idx];
  if (!msg || !msg.swipes) return;
  if (msg.swipeIndex + dir < 0 || msg.swipeIndex + dir >= msg.swipes.length) return;
  selectAssistantSwipe(msg, msg.swipeIndex + dir);
  const conv = getActiveConv();
  if (conv) conv.updatedAt = Date.now();
  debouncedSave();
  renderMessages();
  updateTokenInfo();
}

function forkBranch(msgIdx) {
  if (!Number.isInteger(msgIdx) || msgIdx < 0 || msgIdx >= messages.length || !prepareConversationTransition()) return;
  const conv = getActiveConv();
  if (!conv) return;
  const now = Date.now();
  const newConv = normalizeConversationRecord(structuredClone(conv));
  newConv.id = genId();
  newConv.title = conv.title + ' (fork)';
  newConv.messages = structuredClone(messages.slice(0, msgIdx + 1));
  invalidateConversationContext(newConv, msgIdx + 1);
  newConv.messages.forEach(message => {
    delete message._editing;
    delete message.branches;
    delete message.branchIndex;
  });
  newConv.createdAt = now;
  newConv.updatedAt = now;
  newConv.parentConversationId = conv.id;
  newConv.forkMessageIndex = msgIdx;
  newConv.forkedAt = now;
  newConv.queuedFollowUps = [];
  if (isTemporaryConversation(conv)) temporaryConversations.add(newConv);
  delete newConv.draft;
  delete newConv.shareGistId;
  delete newConv.shareUrl;
  delete newConv.shareId;

  conversations.unshift(newConv);
  activeConvId = newConv.id;
  messages = newConv.messages;
  saveConversations();
  renderSidebar();
  renderMessages();
  updateTokenInfo();
  updateCharacterUI();
  restoreActiveDraft();
  announce('Conversation forked.');
  return newConv;
}

// ============================================
// Thinking/Reasoning Rendering
// ============================================
function renderThinkingHTML(text) {
  if (!text) return '';
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<details class="thinking-block"><summary class="thinking-header">Thinking</summary>' +
    '<div class="thinking-content">' + escaped + '</div></details>';
}

// Streaming rewrites the whole bubble every 80ms. Replacing the thinking
// <details> resets its scroll box and cancels any touch drag in progress, so on
// a phone the reasoning could not be scrolled at all. Update it in place and
// only follow the tail while it is already scrolled to the bottom.
function setBubbleHTML(bubbleEl, thinkingText, restHTML) {
  const block = bubbleEl.firstElementChild;
  const content = thinkingText && block && block.classList.contains('thinking-block')
    ? block.querySelector('.thinking-content')
    : null;
  if (!content) {
    bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + restHTML;
    return;
  }
  if (content.textContent !== thinkingText) {
    const pinned = content.scrollHeight - content.scrollTop - content.clientHeight < 24;
    content.textContent = thinkingText;
    if (pinned) content.scrollTop = content.scrollHeight;
  }
  while (block.nextSibling) block.nextSibling.remove();
  block.insertAdjacentHTML('afterend', restHTML);
}

function stripThinkTags(text) {
  if (!text) return { thinking: '', content: '' };
  let thinking = '';
  let content = text;
  // Extract closed <think>...</think> and <thinking>...</thinking> blocks
  content = content.replace(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/gi, (_, inner) => {
    thinking += inner;
    return '';
  });
  // Handle unclosed <think> or <thinking> at end of string (mid-stream)
  content = content.replace(/<think(?:ing)?>([\s\S]*)$/i, (_, inner) => {
    thinking += inner;
    return '';
  });
  return { thinking, content };
}

// ============================================
// Tool Use Rendering
// ============================================
function renderToolBlocksHTML(toolBlocks) {
  if (!toolBlocks || toolBlocks.length === 0) return '';
  return toolBlocks.map((tb, i) => {
    // --- url_fetch blocks ---
    if (tb.type === 'url_fetch') {
      const safeUrl = safeHttpUrl(tb.url);
      const displayUrl = escapeHTML((safeUrl || String(tb.url || '')).replace(/^https?:\/\//, '').replace(/\/+$/, ''));
      if (tb.searching) {
        return '<div class="tool-use-block" role="status" aria-live="polite"><div class="tool-use-header">Reading ' + displayUrl + '\u2026</div></div>';
      }
      if (tb.error) {
        return '<div class="tool-use-block" role="status" aria-live="polite"><div class="tool-use-header">' + displayUrl + ' \u00B7 <span style="color:var(--error-color,#ff7777)">' + escapeHTML(tb.error) + '</span></div></div>';
      }
      const charCount = (tb.content || '').length;
      const preview = escapeHTML((tb.content || '').slice(0, 300));
      return '<details class="tool-use-block" aria-label="URL fetch result">' +
        '<summary class="tool-use-header">Fetched ' + displayUrl + ' \u00B7 ' + charCount.toLocaleString() + ' chars</summary>' +
        '<div class="tool-use-results"><div class="tool-result-snippet" style="max-height:200px;overflow-y:auto;white-space:pre-wrap;font-size:0.8em;padding:8px">' + preview + (charCount > 300 ? '\u2026' : '') + '</div></div></details>';
    }
    // --- web_search blocks (default) ---
    const query = tb.query || '';
    const results = tb.results || [];
    const searching = tb.searching;
    if (searching) {
      return '<div class="tool-use-block" role="status" aria-live="polite"><div class="tool-use-header">Searching\u2026</div></div>';
    }
    const escapedQuery = escapeHTML(query);
    if (tb.error) {
      return '<div class="tool-use-block" role="status" aria-live="polite"><div class="tool-use-header">Searched "' + escapedQuery + '" \u00B7 <span style="color:var(--error-color,#ff7777)">' + escapeHTML(tb.error) + '</span></div></div>';
    }
    const count = results.length;
    const resultsHTML = results.map(r => {
      const title = r.title || r.url || 'Result';
      const url = r.url || '';
      const safeUrl = safeHttpUrl(url);
      const hasUrl = Boolean(safeUrl);
      const displayUrl = hasUrl ? safeUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') : '';
      const snippetText = r.snippet ? escapeHTML(r.snippet) : '';
      const snippetHtml = snippetText ? '<div class="tool-result-snippet">' + snippetText + '</div>' : '';
      const titleHtml = hasUrl
        ? '<a href="' + escapeHTML(safeUrl) + '" target="_blank" rel="noopener">' + escapeHTML(title) + '</a>'
        : '<span class="tool-result-title">' + escapeHTML(title) + '</span>';
      return '<div class="tool-use-result">' +
        (r.sourceNumber ? '<span class="source-number">[' + Number(r.sourceNumber) + ']</span> ' : '') + titleHtml +
        (displayUrl ? '<span class="tool-result-url">' + escapeHTML(displayUrl) + '</span>' : '') +
        snippetHtml + '</div>';
    }).join('');
    const headerText = 'Searched "' + escapedQuery + '" \u00B7 ' + count + ' result' + (count !== 1 ? 's' : '');
    return '<details class="tool-use-block" aria-label="Web search results">' +
      '<summary class="tool-use-header">' + headerText + '</summary>' +
      '<div class="tool-use-results">' + resultsHTML + '</div></details>';
  }).join('');
}

// ============================================
// OpenAI Web Search Function Calling
// ============================================
const OPENAI_WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information. Use this when the user asks about recent events, real-time data, or anything that may require up-to-date information.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' }
      },
      required: ['query']
    }
  }
};

function proxiedFetch(url, options, forceSensitive = false, proxy = getCorsProxyUrl()) {
  const sensitive = requestContainsSensitiveData(url, options, forceSensitive);
  if (!canUseCorsProxy(url, options, proxy, forceSensitive)) {
    return Promise.reject(new Error('Refusing to send credentials through a public CORS proxy. Use a proxy you control.'));
  }
  return fetch(proxy + encodeURIComponent(url), options).catch(err => {
    if (err.name === 'AbortError') throw err;
    const msg = err.message || '';
    if (!sensitive && (msg === 'Failed to fetch' || msg === 'Load failed' || msg.includes('NetworkError') || msg.includes('CORS'))) {
      const fallbackProxy = 'https://api.allorigins.win/raw?url=';
      return fetch(fallbackProxy + encodeURIComponent(url), options);
    }
    throw err;
  });
}

async function fetchWebSearchWithFallback(url, options, forceSensitive = false, proxy = getCorsProxyUrl()) {
  try {
    return await fetchApiWithHttpSupport(url, options, url, forceSensitive, proxy);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (!isNetworkLikeFetchError(err)) throw err;
    return await proxiedFetch(url, options, forceSensitive, proxy);
  }
}

function extractWebSearchQueryFromArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const candidates = [];

  if (typeof args.query === 'string') candidates.push(args.query);
  if (typeof args.search_query === 'string') candidates.push(args.search_query);
  if (typeof args.q === 'string') candidates.push(args.q);
  if (typeof args.search === 'string') candidates.push(args.search);
  if (typeof args.keywords === 'string') candidates.push(args.keywords);
  if (typeof args.text === 'string') candidates.push(args.text);

  if (Array.isArray(args.search_query) && args.search_query.length > 0) {
    const first = args.search_query[0];
    if (typeof first === 'string') candidates.push(first);
    else if (first && typeof first === 'object' && typeof first.q === 'string') candidates.push(first.q);
  }

  for (const candidate of candidates) {
    const q = candidate.trim();
    if (q) return q;
  }
  return '';
}

function getToolRequestSettings() {
  return {
    searchUrl: (localStorage.getItem('llmSearchApiUrl') || 'https://purasearx.duckdns.org/search?format=json').trim(),
    searchKey: (localStorage.getItem('llmSearchApiKey') || '').trim(),
    corsProxy: getCorsProxyUrl()
  };
}

async function executeWebSearch(query, signal, settings = getToolRequestSettings()) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) {
    lastSearchStatus = { ok: false, error: 'Search query is empty.', at: Date.now(), query: '' };
    return { results: [], error: 'Search query is empty.' };
  }

  const { searchUrl, searchKey } = settings;
  if (!searchUrl) {
    lastSearchStatus = { ok: false, error: 'No search API URL configured.', at: Date.now(), query: normalizedQuery };
    return { results: [], error: 'No search API URL configured. Set one in Settings > Tools.' };
  }
  const isBrave = searchUrl.includes('api.search.brave.com');
  const isSearx = /searx|searxng/i.test(searchUrl);
  const hasQueryTpl = /{query}|\{\{query\}\}|%s/i.test(searchUrl);
  const hasKeyTpl = /{key}|\{\{key\}\}/i.test(searchUrl);
  if (hasKeyTpl && !searchKey) {
    lastSearchStatus = { ok: false, error: 'Search API key required for this URL template.', at: Date.now(), query: normalizedQuery };
    return { results: [], error: 'Search API key required for this URL template.' };
  }
  try {
    const qEnc = encodeURIComponent(normalizedQuery);
    const kEnc = encodeURIComponent(searchKey);
    let fetchUrl = searchUrl;

    if (hasQueryTpl || hasKeyTpl) {
      fetchUrl = fetchUrl
        .replace(/{query}|\{\{query\}\}|%s/gi, qEnc)
        .replace(/{key}|\{\{key\}\}/gi, kEnc);
    }

    if (!hasQueryTpl) {
      const sep = fetchUrl.includes('?') ? '&' : '?';
      fetchUrl = fetchUrl + sep + 'q=' + qEnc;
      if (isSearx && !/[?&]format=/i.test(fetchUrl)) fetchUrl += '&format=json';
    }

    const fetchHeaders = {};
    if (!hasKeyTpl && searchKey) {
      const headerMatch = searchKey.match(/^([A-Za-z0-9-]+)\s*:\s*(.+)$/);
      if (headerMatch) {
        fetchHeaders[headerMatch[1]] = headerMatch[2];
      } else if (isBrave) {
        fetchHeaders['X-Subscription-Token'] = searchKey;
      } else if (/^bearer\s+/i.test(searchKey)) {
        fetchHeaders['Authorization'] = searchKey;
      } else {
        fetchHeaders['Authorization'] = 'Bearer ' + searchKey;
      }
    }
    if (!fetchHeaders['Accept']) fetchHeaders['Accept'] = 'application/json';

    const resp = await fetchWebSearchWithFallback(fetchUrl, { headers: fetchHeaders, signal }, Boolean(searchKey), settings.corsProxy);
    if (!resp.ok) throw new Error(resp.status + ' ' + (resp.statusText || 'Error'));
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('Expected JSON but got ' + (ct.split(';')[0] || 'unknown content type'));
    const data = await resp.json();

    const pickArray = (obj) => {
      if (Array.isArray(obj)) return obj;
      if (obj && Array.isArray(obj.results)) return obj.results;
      if (obj && Array.isArray(obj.items)) return obj.items;
      if (obj && Array.isArray(obj.value)) return obj.value;
      return null;
    };

    const candidates = [
      data?.web?.results,
      data?.webPages?.value,
      data?.results,
      data?.items,
      data?.data,
      data?.organic_results,
      data?.organic,
      data?.value
    ];

    let raw = [];
    for (const c of candidates) {
      const arr = pickArray(c);
      if (arr) {
        raw = arr;
        if (arr.length) break;
      }
    }

    const results = raw.slice(0, 30).map(r => ({
      title: r.title || r.name || r.heading || '',
      url: r.url || r.link || r.href || r.target_url || '',
      snippet: r.content || r.snippet || r.description || r.summary || ''
    })).filter(r => r.title || r.url);

    lastSearchStatus = { ok: true, error: null, at: Date.now(), query: normalizedQuery };
    return { results, error: null };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    let msg = e.message || 'Unknown error';
    if (msg === 'Failed to fetch' || msg.includes('NetworkError')) msg = 'Network error — CORS may be blocked by this search instance';
    lastSearchStatus = { ok: false, error: msg, at: Date.now(), query: normalizedQuery };
    return { results: [], error: msg };
  }
}

let activeSourceRegistry = null;
function formatSearchResultsForModel(results, error, registry = null) {
  if (error) return 'Web search error: ' + error;
  if (!results.length) return 'No search results found.';
  const numbered = (registry || activeSourceRegistry) ? registerSources(registry || activeSourceRegistry, results) : results.map((r, i) => ({ ...r, sourceNumber: i + 1 }));
  numbered.forEach((result, index) => { if (results[index] && result.sourceNumber) results[index].sourceNumber = result.sourceNumber; });
  return numbered.map((r, i) =>
    '[' + (r.sourceNumber || i + 1) + '] ' + r.title + '\n   URL: ' + r.url + (r.snippet ? '\n   ' + r.snippet : '')
  ).join('\n\n') + '\n\n' + SOURCE_CITATION_INSTRUCTION;
}

// ============================================
// URL Fetch Tool
// ============================================
const URL_FETCH_MAX_CHARS = 18000;

const OPENAI_URL_FETCH_TOOL = {
  type: 'function',
  function: {
    name: 'url_fetch',
    description: 'Fetch the full content of a web page given its URL. Use this to read articles, documentation, or any web page the user shares or that appeared in search results.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' }
      },
      required: ['url']
    }
  }
};

const ANTHROPIC_URL_FETCH_TOOL = {
  name: 'url_fetch',
  description: 'Fetch the full content of a web page given its URL. Use this to read articles, documentation, or any web page the user shares or that appeared in search results.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' }
    },
    required: ['url']
  }
};

const ANTHROPIC_WEB_SEARCH_TOOL = {
  name: 'web_search',
  description: 'Search the web for current information and return concise results with URLs.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The search query' } },
    required: ['query']
  }
};

const HANDLED_TOOLS = new Set(['web_search', 'url_fetch']);
const TOOL_FINAL_ANSWER_NUDGE = 'You have already used tools and received their results above. Do not call any more tools. Produce the final assistant answer now in plain text, using the tool results to address the user\'s original question.';

// Text tools must be standalone explicit invocations, never quoted JSON examples.
function parseTextToolCalls(text) {
  const calls = [];
  const tagPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  const source = String(text || '').trim();
  if (source.replace(tagPattern, '').trim()) return calls;
  for (const match of source.matchAll(tagPattern)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (!HANDLED_TOOLS.has(parsed.name)) return [];
      const args = typeof parsed.arguments === 'string' ? JSON.parse(parsed.arguments) : parsed.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
      calls.push({ id: 'text_tc_' + calls.length, name: parsed.name, arguments: JSON.stringify(args) });
    } catch (e) { return []; }
  }
  return calls;
}

function stripTextToolCalls(text) {
  return parseTextToolCalls(text).length ? '' : text;
}

function normalizeExtractedText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractReadableTextFromHtml(rawHtml) {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  for (const sel of ['script','style','nav','footer','header','aside','iframe','noscript','svg','form','button','input','textarea','[role="navigation"]','[role="banner"]','[role="contentinfo"]']) {
    doc.querySelectorAll(sel).forEach(el => el.remove());
  }

  const candidates = [
    'article',
    'main',
    '[role="main"]',
    '.post-content',
    '.article-content',
    '.entry-content',
    '.content',
    '#content',
    '.prose',
    'body'
  ];

  let best = '';
  for (const sel of candidates) {
    const node = sel === 'body' ? doc.body : doc.querySelector(sel);
    if (!node) continue;
    const t = normalizeExtractedText(node.textContent || '');
    if (t.length > best.length) best = t;
  }

  if (!best) {
    const meta = doc.querySelector('meta[name="description"],meta[property="og:description"],meta[name="twitter:description"]');
    best = normalizeExtractedText(meta?.getAttribute('content') || '');
  }

  if (!best) return '';
  const title = normalizeExtractedText(doc.title || '');
  if (title && !best.startsWith(title) && best.length < 400) best = title + '\n\n' + best;
  return best;
}

function looksLikeBotOrBlockPage(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return /just a moment|checking your browser|enable javascript|access denied|are you human|captcha|cloudflare|ddos protection|request blocked/.test(t);
}

function buildReaderMirrorUrls(url) {
  const stripped = String(url || '').replace(/^https?:\/\//i, '');
  return [...new Set([
    'https://r.jina.ai/' + url,
    'https://r.jina.ai/http://' + stripped
  ])];
}

function stripReaderMirrorPreamble(text) {
  let out = normalizeExtractedText(text);
  const markerMatch = out.match(/\nMarkdown Content:\n/i);
  if (markerMatch) {
    const idx = out.indexOf(markerMatch[0]);
    out = out.slice(idx + markerMatch[0].length);
  }
  out = out.replace(/^Title:[^\n]*\n/i, '');
  out = out.replace(/^URL Source:[^\n]*\n/i, '');
  return normalizeExtractedText(out);
}

async function executeUrlFetch(url, signal, settings = getToolRequestSettings()) {
  const targetUrl = safeHttpUrl(url);
  if (!targetUrl) {
    return { content: '', error: 'Invalid URL. Use a full URL starting with http:// or https://.' };
  }
  if (isLocalUrl(targetUrl)) return { content: '', error: 'Private and local network URLs are not allowed.' };

  let primaryReadable = '';
  let lastError = '';

  try {
    const resp = await proxiedFetch(targetUrl, { signal }, false, settings.corsProxy);
    if (!resp.ok) {
      lastError = resp.status + ' ' + (resp.statusText || 'Error');
    } else {
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      const raw = await resp.text();
      const looksHtml = ct.includes('html') || /<!doctype html|<html|<body/i.test(raw.slice(0, 2500));
      if (!looksHtml) {
        const plain = normalizeExtractedText(raw);
        if (plain) return { content: plain.slice(0, URL_FETCH_MAX_CHARS), error: null };
        lastError = 'Page returned no readable text.';
      } else {
        primaryReadable = extractReadableTextFromHtml(raw);
        if (primaryReadable && !looksLikeBotOrBlockPage(primaryReadable) && primaryReadable.length >= 120) {
          return { content: primaryReadable.slice(0, URL_FETCH_MAX_CHARS), error: null };
        }
        lastError = primaryReadable ? 'Page returned no readable text.' : 'Page returned no readable text.';
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    let msg = e.message || 'Unknown error';
    if (msg === 'Failed to fetch' || msg === 'Load failed' || msg.includes('NetworkError')) msg = 'Network error while fetching page';
    lastError = msg;
  }

  // Fallback for JS-heavy/CORS-blocked pages: server-side reader mirror.
  try {
    const readerUrls = buildReaderMirrorUrls(targetUrl);
    for (const readerUrl of readerUrls) {
      const r = await fetch(readerUrl, { signal });
      if (!r.ok) continue;
      const txt = stripReaderMirrorPreamble(await r.text());
      if (txt && txt.length >= 40) {
        return { content: txt.slice(0, URL_FETCH_MAX_CHARS), error: null };
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }

  // If we got something but it was short/blocked and mirror failed, return what we have.
  if (primaryReadable) {
    const fallbackText = normalizeExtractedText(primaryReadable);
    if (fallbackText) return { content: fallbackText.slice(0, URL_FETCH_MAX_CHARS), error: null };
  }

  // Final fallback error message.
  if (!lastError) lastError = 'Unable to fetch readable content from this page.';
  if (/network error|failed to fetch|cors/i.test(lastError)) {
    lastError = 'Network error — CORS proxy may be required';
  }
  return { content: '', error: lastError };
}

function formatUrlFetchResultForModel(content, error, url) {
  const safeUrl = safeHttpUrl(url) || '[invalid URL]';
  const source = activeSourceRegistry ? registerSources(activeSourceRegistry, [{ title: safeUrl, url: safeUrl, snippet: error || '' }])[0] : null;
  const label = source?.sourceNumber ? '[' + source.sourceNumber + '] ' : '';
  if (error) return label + 'Error fetching ' + safeUrl + ': ' + error;
  if (!content) return label + 'No content found at ' + safeUrl;
  return label + 'Content from ' + safeUrl + ':\n\n' + content;
}

function createRequestMetadata(assistantMsg, swipeIdx, metadata = {}) {
  assistantMsg.swipeRequests = assistantMsg.swipeRequests || [];
  const request = {
    requestId: 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    status: 'pending',
    startedAt: Date.now(),
    completedAt: null,
    durationMs: null,
    httpStatus: null,
    error: '',
    model: metadata.model || '',
    apiFormat: metadata.apiFormat || '',
    messageCount: Number.isFinite(metadata.messageCount) ? metadata.messageCount : null,
    promptTokens: Number.isFinite(metadata.promptTokens) ? metadata.promptTokens : null,
    contextWindow: Number.isFinite(metadata.contextWindow) ? metadata.contextWindow : null
  };
  if (metadata.target) {
    const target = metadata.target;
    requestTargets.set(request, target);
    request.connection = {
      provider: target.provider,
      baseUrl: sanitizeStoredUrl(target.baseUrl).replace(/\/+$/, ''),
      apiFormat: target.apiFormat,
      model: target.model,
      profileId: target.profileId,
      profileName: target.profileName,
      temperature: target.temperature,
      maxTokens: target.maxTokens,
      contextWindow: getTargetContextWindow(target),
      corsProxy: sanitizeStoredUrl(target.corsProxy)
    };
  }
  assistantMsg.swipeRequests[swipeIdx] = request;
  return request;
}

function finishRequestMetadata(request, status, error = '', httpStatus = null) {
  if (!request) return;
  request.status = status;
  request.completedAt = Date.now();
  request.durationMs = request.startedAt ? Math.max(0, request.completedAt - request.startedAt) : null;
  request.httpStatus = httpStatus != null && Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : request.httpStatus || null;
  request.error = sanitizeErrorDetail(error, [requestTargets.get(request)?.apiKey]);
}

async function authorizeExternalTool(toolName, args, conv, authorization) {
  const policy = authorization?.policy || getToolPolicy(conv);
  if (!(toolName === 'web_search' ? policy.webSearch : toolName === 'url_fetch' && policy.urlFetch)) return false;
  if (!policy.confirm) return true;
  if (authorization && typeof authorization.confirmed === 'boolean') return authorization.confirmed;
  const target = toolName === 'web_search' ? extractWebSearchQueryFromArgs(args) : safeHttpUrl(args?.url);
  const confirmed = window.confirm('The assistant wants to use ' + (toolName === 'web_search' ? 'web search' : 'URL fetching') + ':\n\n' + (target || '[invalid target]') + '\n\nAllow this request?');
  if (authorization) authorization.confirmed = confirmed;
  announce(confirmed ? 'External tool request approved.' : 'External tool request denied.');
  return confirmed;
}

async function executeAuthorizedTool(toolName, args, conv, signal, authorization) {
  signal?.throwIfAborted();
  if (!(await authorizeExternalTool(toolName, args, conv, authorization))) {
    return { results: [], content: '', error: 'Tool call denied by user; no external request was made.', denied: true };
  }
  signal?.throwIfAborted();
  if (toolName === 'web_search') return executeWebSearch(extractWebSearchQueryFromArgs(args), signal, authorization?.settings);
  return executeUrlFetch(args?.url || '', signal, authorization?.settings);
}

function sourceRegistryFor(assistantMsg, swipeIdx) {
  const registry = { byUrl: new Map(), sources: [] };
  const existing = assistantMsg.swipeSources?.[swipeIdx] || [];
  existing.forEach(source => {
    const key = sourceUrlKey(source?.url);
    if (!key || registry.byUrl.has(key)) return;
    const normalized = { ...source, number: registry.sources.length + 1 };
    registry.byUrl.set(key, normalized.number);
    registry.sources.push(normalized);
  });
  return registry;
}

function sourceUrlKey(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (e) {
    return String(url || '').trim().replace(/#.*$/, '').replace(/\/$/, '');
  }
}

function registerSources(registry, results = []) {
  return (results || []).map(result => {
    const url = safeHttpUrl(result.url);
    if (!url) return result;
    const key = sourceUrlKey(url);
    let number = registry.byUrl.get(key);
    if (!number) {
      number = registry.sources.length + 1;
      registry.byUrl.set(key, number);
      registry.sources.push({ number, url, title: result.title || url, snippet: result.snippet || '' });
    }
    return { ...result, sourceNumber: number };
  });
}

function persistSwipeSources(assistantMsg, swipeIdx, registry) {
  const toolBlocks = assistantMsg.swipeToolUse?.[swipeIdx] || [];
  toolBlocks.forEach(block => {
    if (block.type !== 'url_fetch' && Array.isArray(block.results)) {
      const numbered = registerSources(registry, block.results);
      numbered.forEach((result, index) => { if (block.results[index]) block.results[index].sourceNumber = result.sourceNumber; });
    }
  });
  toolBlocks.filter(block => block.type === 'url_fetch' && block.url).forEach(block => {
    registerSources(registry, [{ title: block.url, url: block.url, snippet: block.error || '' }]);
  });
  if (!registry?.sources?.length) return;
  assistantMsg.swipeSources = assistantMsg.swipeSources || [];
  assistantMsg.swipeSources[swipeIdx] = registry.sources.map(source => ({ ...source }));
}

// ============================================
// Streaming
// ============================================
async function streamResponse(apiMessages, assistantMsg, swipeIdx, bubbleEl, overrideModel, prefixText, requestOptions = {}) {
  const target = requestOptions.target || getActiveRequestTarget(overrideModel || undefined);
  const { baseUrl, apiKey, model, apiFormat: format } = target;
  const requestConv = requestOptions.conv || getActiveConv();
  const messageList = requestOptions.messageList || foregroundAction?.messageList || requestConv?.messages;
  const controller = abortController || new AbortController();
  const action = foregroundAction;
  assertRequestOwner(requestConv, messageList, assistantMsg, controller.signal);
  const toolPolicy = requestOptions.toolPolicy || getToolPolicy(requestConv);
  const authorization = { confirmed: null, policy: toolPolicy, settings: target.toolSettings || getToolRequestSettings() };
  const request = createRequestMetadata(assistantMsg, swipeIdx, {
    target,
    model,
    apiFormat: format,
    messageCount: apiMessages?.length || 0,
    promptTokens: (apiMessages || []).reduce((total, message) => total + estimateTokens(JSON.stringify(message)), 0),
    contextWindow: getTargetContextWindow(target)
  });
  const sourceRegistry = sourceRegistryFor(assistantMsg, swipeIdx);
  activeSourceRegistry = sourceRegistry;
  setAssistantLlmMetadata(assistantMsg, swipeIdx, model, format, target);

  // Extra params & excludes
  let extra = {};
  try { extra = JSON.parse(target.extraParams || '{}'); } catch(e) { console.warn('Extra params parse error:', e); }
  const exclude = (target.excludeParams || '').split(',').map(s => s.trim()).filter(Boolean);

  abortController = controller;
  streaming = true;
  request.status = 'streaming';
  announce('Generating response.');
  userScrolledAway = false;
  const btn = document.getElementById('sendBtn');
  btn.textContent = 'Stop';
  btn.classList.add('streaming');
  btn.disabled = false;

  let fullText = prefixText || '';
  let thinkingText = prefixText ? assistantMsg.swipeThinking?.[swipeIdx] || '' : '';
  let lastRender = 0;
  const toolBlocks = prefixText ? structuredClone(assistantMsg.swipeToolUse?.[swipeIdx] || []) : [];
  const responseImages = prefixText ? (assistantMsg.swipeImages?.[swipeIdx] || []).slice() : [];
  let responseStatus = null;

  const renderProgress = (force = false) => {
    assistantMsg.swipes[swipeIdx] = fullText;
    (assistantMsg.swipeThinking ||= [])[swipeIdx] = thinkingText;
    (assistantMsg.swipeToolUse ||= [])[swipeIdx] = toolBlocks;
    (assistantMsg.swipeImages ||= [])[swipeIdx] = responseImages;
    if (assistantMsg.swipeIndex === swipeIdx) selectAssistantSwipe(assistantMsg, swipeIdx);
    if (getActiveConv() !== requestConv || messages !== messageList || assistantMsg.swipeIndex !== swipeIdx) return;
    if (!force && Date.now() - lastRender < 80) return;
    bubbleEl = document.querySelector('.msg-wrapper[data-msg-idx="' + messageList.indexOf(assistantMsg) + '"] .msg-bubble') || (bubbleEl?.isConnected ? bubbleEl : null);
    if (!bubbleEl) return;
    const area = document.getElementById('messagesArea');
    const savedScroll = userScrolledAway ? area.scrollTop : null;
    const openTools = Array.from(bubbleEl.querySelectorAll('details.tool-use-block')).map(block => block.open);
    const stripped = stripThinkTags(fullText);
    _suppressScrollFlag = true;
    setBubbleHTML(bubbleEl, thinkingText + stripped.thinking, renderToolBlocksHTML(toolBlocks) + renderMarkdown(stripped.content) + renderGenImages(responseImages));
    bubbleEl.querySelectorAll('details.tool-use-block').forEach((block, index) => { block.open = openTools[index] === true; });
    area.scrollTop = savedScroll === null ? area.scrollHeight : savedScroll;
    _suppressScrollFlag = false;
    lastRender = Date.now();
  };

  try {
    if (target.keyRequired && !apiKey) throw new Error('Enter an API key for ' + target.host + '.');
    await saveConversationImmediately();
    assertRequestOwner(requestConv, messageList, assistantMsg, controller.signal);
    let url, headers, body;
    const useStream = target.stream !== false;

    // Assistant prefill. A trailing assistant turn is rejected with a 400 by Claude 4.6
    // and later, so skip it there rather than failing every request; the settings field
    // carries a matching note.
    const prefillBlocked = NO_TRAILING_ASSISTANT_RE.test(model);
    const prefill = prefillBlocked ? '' : (target.prefill || '');
    if (prefill && !prefixText) {
      apiMessages = apiMessages.concat({ role: 'assistant', content: prefill });
      fullText = prefill;
    }

    if (format === 'anthropic') {
      url = baseUrl + '/messages';
      headers = buildProviderHeaders('anthropic', apiKey);
      const prepared = prepareAnthropicMessages(apiMessages);
      const thinkingOn = target.thinking;
      const thinkingEffort = target.thinkingEffort;
      body = {
        ...extra,
        model,
        system: prepared.system,
        messages: prepared.messages,
        max_tokens: target.maxTokens || 8192,
        stream: useStream,
        // Adaptive thinking only. budget_tokens is rejected by Opus 4.7+ / Sonnet 5 /
        // Fable 5; display defaults to "omitted" there, which renders an empty pane.
        ...(thinkingOn ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
        ...(thinkingEffort ? { output_config: { effort: thinkingEffort } } : {})
      };
      if (toolPolicy.webSearch || toolPolicy.urlFetch) {
        body.tools = (body.tools || []).concat([
          ...(toolPolicy.webSearch ? [toolPolicy.confirm ? ANTHROPIC_WEB_SEARCH_TOOL : { type: 'web_search_20250305', name: 'web_search', max_uses: 20 }] : []),
          ...(toolPolicy.urlFetch ? [ANTHROPIC_URL_FETCH_TOOL] : [])
        ]);
        if (toolPolicy.webSearch && target.forceSearch) {
          body.tool_choice = { type: 'any' };
          body.system = (body.system || '') + '\n\nIMPORTANT: You MUST call the web_search tool to look up information before answering. Do NOT answer from memory or training data. Always search first, then synthesize your answer from the results.';
        }
      }
      // Prompt caching. Must run AFTER the force-search concat above, which appends to
      // body.system as a string. Breakpoint goes on the system block only: `system`
      // survives the { ...body } spreads into tool follow-up requests, whereas a
      // breakpoint on the last message would go stale as soon as `messages` is replaced.
      if (typeof body.system === 'string' && body.system && target.promptCache !== false) {
        body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }];
      }
    } else {
      url = baseUrl + '/chat/completions';
      headers = buildProviderHeaders('openai', apiKey);
      body = { ...extra, model, messages: prepareOpenAiMessages(apiMessages), stream: useStream };
      const configuredMaxTokens = target.maxTokens;
      if (configuredMaxTokens && !('max_tokens' in body) && !('max_completion_tokens' in body)) {
        const provider = target.provider;
        const tokenKey = provider === 'openai' && /^(?:o\d|gpt-5)/i.test(model) ? 'max_completion_tokens' : 'max_tokens';
        body[tokenKey] = configuredMaxTokens;
      }
      // Inject web search tool for OpenAI-compatible models
      if (toolPolicy.webSearch || toolPolicy.urlFetch) {
        body.tools = (body.tools || []).concat([
          ...(toolPolicy.webSearch ? [OPENAI_WEB_SEARCH_TOOL] : []),
          ...(toolPolicy.urlFetch ? [OPENAI_URL_FETCH_TOOL] : [])
        ]);
        if (toolPolicy.webSearch && target.forceSearch) {
          body.tool_choice = 'required';
          // Reinforce via system prompt — some providers (e.g. Gemini) ignore tool_choice
          body.messages = body.messages.concat([{
            role: 'system',
            content: 'IMPORTANT: You MUST call the web_search tool to look up information before answering. Do NOT answer from memory or training data. Always search first, then synthesize your answer from the results.'
          }]);
        }
      }
    }
    if (!('temperature' in body)) {
      if (target.temperature !== null) body.temperature = target.temperature;
    }
    // Sampling params are rejected with a 400 by current Claude models. This block runs
    // for both API formats, so without the strip a saved temperature breaks every
    // request on those models with no hint as to why.
    if (NO_SAMPLING_PARAMS_RE.test(model)) {
      delete body.temperature; delete body.top_p; delete body.top_k;
    }
    exclude.forEach(k => delete body[k]);
    body.model = model;
    const fetchResponse = async () => {
      assertRequestOwner(requestConv, messageList, assistantMsg, controller.signal);
      assertProviderRequestFits(body, target);
      debugLogPayload('API request', body, { url, format, model });
      const response = await fetchApiWithHttpSupport(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal
      }, baseUrl, false, target.corsProxy);
      responseStatus = response.status;
      return response;
    };

    // Each transport uses the same history, tool budget and completion rules.
    for (let toolRound = 0; toolRound <= 20; toolRound++) {
      let resp = await fetchResponse();
      if (!resp.ok && resp.status === 400 && body.tool_choice) {
        delete body.tool_choice;
        resp = await fetchResponse();
      }
      if (!resp.ok) {
        const detail = (await resp.text()).slice(0, 200);
        throw new Error('API returned ' + resp.status + (detail ? ': ' + detail : ''));
      }
      const textBeforeRound = fullText + (toolRound && fullText ? '\n\n' : '');
      const thinkingBeforeRound = thinkingText;
      let reply = { role: 'assistant', content: format === 'anthropic' ? [] : '' };
      let roundText = '';
      let roundThinking = '';
      let hasRoundImages = false;
      let stopReason = null;
      const addImages = images => {
        for (const image of images.map(safeMediaUrl).filter(Boolean)) {
          hasRoundImages = true;
          if (!responseImages.includes(image)) responseImages.push(image);
        }
      };
      const readMessage = message => {
        if (!message || typeof message !== 'object') throw new Error('The provider returned no assistant message.');
        reply = { ...message, role: 'assistant' };
        const extracted = extractImages(reply);
        roundText = extracted.text;
        addImages(extracted.images);
        roundThinking = format === 'anthropic'
          ? (reply.content || []).filter(block => block.type === 'thinking').map(block => block.thinking || '').join('')
          : reply.reasoning_content || reply.reasoning || (reply.reasoning_details || []).filter(block => block.type === 'reasoning.text').map(block => block.text || '').join('');
        fullText = textBeforeRound + roundText;
        thinkingText = thinkingBeforeRound + roundThinking;
        renderProgress();
      };
      if ((resp.headers.get('content-type') || '').includes('application/json')) {
        const data = await resp.json();
        if (data.error || data.type === 'error') throw new Error(data.error?.message || 'The provider returned an error.');
        stopReason = data.stop_reason || data.choices?.[0]?.finish_reason;
        readMessage(format === 'anthropic' ? { role: 'assistant', content: data.content } : data.choices?.[0]?.message);
      } else {
        const reader = resp.body?.getReader();
        if (!reader) throw new Error('The provider returned no response body.');
        const decoder = new TextDecoder();
        const inputJson = {};
        let buffer = '';
        let eventData = [];
        let complete = false;
        const acceptEvent = payload => {
          if (!payload || complete) return;
          if (payload === '[DONE]') { complete = true; return; }
          const data = JSON.parse(payload);
          if (data.error || data.type === 'error') throw new Error(data.error?.message || 'The provider returned an error.');
          if (format === 'anthropic') {
            const index = data.index ?? 0;
            if (data.type === 'content_block_start') {
              const block = structuredClone(data.content_block);
              reply.content[index] = block;
              if (block.type === 'text') roundText += block.text || '';
              if (block.type === 'thinking') roundThinking += block.thinking || '';
              addImages(extractImages({ content: [block] }).images);
            } else if (data.type === 'content_block_delta') {
              const block = reply.content[index];
              const delta = data.delta || {};
              if (!block) throw new Error('The provider sent a delta without its content block.');
              if (delta.type === 'text_delta') { block.text = (block.text || '') + (delta.text || ''); roundText += delta.text || ''; }
              else if (delta.type === 'thinking_delta') { block.thinking = (block.thinking || '') + (delta.thinking || ''); roundThinking += delta.thinking || ''; }
              else if (delta.type === 'signature_delta') block.signature = (block.signature || '') + (delta.signature || '');
              else if (delta.type === 'input_json_delta') inputJson[index] = (inputJson[index] || '') + (delta.partial_json || '');
              else if (delta.type === 'citations_delta') (block.citations ||= []).push(delta.citation);
            } else if (data.type === 'content_block_stop' && inputJson[index]) {
              reply.content[index].input = JSON.parse(inputJson[index]);
            } else if (data.type === 'message_delta') stopReason = data.delta?.stop_reason || stopReason;
            else if (data.type === 'message_stop') complete = true;
          } else {
            const choice = data.choices?.[0];
            const delta = choice?.delta || {};
            if (choice?.message) readMessage(choice.message);
            else {
              for (const [key, value] of Object.entries(delta)) {
                if (!['content', 'images', 'tool_calls', 'reasoning_content', 'reasoning', 'reasoning_details'].includes(key)) reply[key] = value;
              }
              if (typeof delta.content === 'string') {
                roundText += delta.content;
                if (Array.isArray(reply.content)) reply.content.push({ type: 'text', text: delta.content });
                else reply.content = (reply.content || '') + delta.content;
              } else if (Array.isArray(delta.content)) {
                if (!Array.isArray(reply.content)) reply.content = reply.content ? [{ type: 'text', text: reply.content }] : [];
                reply.content.push(...delta.content);
                const extracted = extractImages({ content: delta.content });
                roundText += extracted.text;
                addImages(extracted.images);
              }
              if (delta.images) { (reply.images ||= []).push(...delta.images); addImages(extractImages({ images: delta.images }).images); }
              for (const key of ['reasoning_content', 'reasoning']) {
                if (typeof delta[key] === 'string') { reply[key] = (reply[key] || '') + delta[key]; roundThinking += delta[key]; }
              }
              for (const detail of delta.reasoning_details || []) {
                const details = reply.reasoning_details ||= [];
                const previous = Number.isInteger(detail.index) ? details.find(item => item.index === detail.index) : null;
                if (previous) {
                  for (const [key, value] of Object.entries(detail)) previous[key] = ['text', 'data', 'summary'].includes(key) ? (previous[key] || '') + value : value;
                } else details.push({ ...detail });
                if (detail.type === 'reasoning.text') roundThinking += detail.text || '';
              }
              for (const call of delta.tool_calls || []) {
                const calls = reply.tool_calls ||= [];
                const index = call.index ?? 0;
                const current = calls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
                const previous = current.function;
                Object.assign(current, call);
                delete current.index;
                current.function = {
                  ...previous, ...call.function,
                  name: previous.name + (call.function?.name || ''),
                  arguments: previous.arguments + (call.function?.arguments || '')
                };
              }
            }
            if (choice?.finish_reason != null) { stopReason = choice.finish_reason; complete = true; }
          }
          fullText = textBeforeRound + roundText;
          thinkingText = thinkingBeforeRound + roundThinking;
          renderProgress();
        };
        const acceptLine = line => {
          if (!line) { acceptEvent(eventData.join('\n')); eventData = []; }
          else if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart());
        };
        try {
          while (!complete) {
            const { done, value } = await reader.read();
            assertRequestOwner(requestConv, messageList, assistantMsg, controller.signal);
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) { acceptLine(line); if (complete) break; }
            if (done) {
              if (buffer) acceptLine(buffer);
              if (!complete) acceptEvent(eventData.join('\n'));
              break;
            }
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (!complete) {
          const error = new Error('The provider stream ended before completion. Partial output was kept.');
          error.requestStatus = 'interrupted';
          throw error;
        }
        readMessage(reply);
      }

      assertRequestOwner(requestConv, messageList, assistantMsg, controller.signal);
      if (format === 'anthropic') {
        const nativeTools = new Map();
        for (const block of reply.content || []) {
          if (block.type === 'server_tool_use' && block.name === 'web_search') {
            const tool = { query: extractWebSearchQueryFromArgs(block.input), results: [], searching: false };
            nativeTools.set(block.id, tool);
            toolBlocks.push(tool);
          } else if (block.type === 'web_search_tool_result') {
            const tool = nativeTools.get(block.tool_use_id) || { query: '', results: [], searching: false };
            if (!toolBlocks.includes(tool)) toolBlocks.push(tool);
            tool.results = (Array.isArray(block.content) ? block.content : []).filter(result => result.type === 'web_search_result')
              .map(result => ({ title: result.title, url: result.url, snippet: result.snippet || '' }));
            if (block.content?.type === 'web_search_tool_result_error') tool.error = block.content.error_code || 'Search failed.';
          }
        }
      }
      let calls = format === 'anthropic'
        ? (reply.content || []).filter(block => block.type === 'tool_use').map(block => ({ id: block.id, name: block.name, input: block.input }))
        : (reply.tool_calls || []).filter(Boolean).map(call => ({ id: call.id, name: call.function?.name, arguments: call.function?.arguments }));
      let textTools = false;
      if (!calls.length && format !== 'anthropic' && (toolPolicy.webSearch || toolPolicy.urlFetch)) {
        calls = parseTextToolCalls(roundText);
        textTools = calls.length > 0;
      }
      const enabledCalls = calls.filter(call => call.name === 'web_search' ? toolPolicy.webSearch : call.name === 'url_fetch' && toolPolicy.urlFetch);
      const nativeContinuation = format === 'anthropic' && stopReason === 'pause_turn' && toolPolicy.webSearch;
      if (!enabledCalls.length && !nativeContinuation) {
        if (!stripThinkTags(roundText).content.trim() && !hasRoundImages) throw new Error('The provider returned no final answer.');
        finishRequestMetadata(request, 'complete', '', responseStatus);
        break;
      }
      if (enabledCalls.length !== calls.length) throw new Error('The provider requested an unavailable tool.');
      if (toolRound === 20) throw new Error('The tool round limit was reached without a final answer.');
      if (textTools) fullText = textBeforeRound + stripTextToolCalls(roundText);
      const results = [];
      for (const call of enabledCalls) {
        const args = call.input ?? JSON.parse(call.arguments || '{}');
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('The provider returned invalid tool arguments.');
        const tool = call.name === 'url_fetch'
          ? { type: 'url_fetch', url: args.url || '', content: '', searching: true }
          : { query: extractWebSearchQueryFromArgs(args), results: [], searching: true };
        toolBlocks.push(tool);
        renderProgress(true);
        const result = await executeAuthorizedTool(call.name, args, requestConv, controller.signal, authorization);
        assertRequestOwner(requestConv, messageList, assistantMsg, controller.signal);
        Object.assign(tool, result, { searching: false });
        const content = call.name === 'url_fetch'
          ? formatUrlFetchResultForModel(result.content, result.error, args.url)
          : formatSearchResultsForModel(result.results, result.error, sourceRegistry);
        results.push(format === 'anthropic'
          ? { type: 'tool_result', tool_use_id: call.id, content, ...(result.error ? { is_error: true } : {}) }
          : { role: 'tool', tool_call_id: call.id, content });
        renderProgress(true);
      }
      // Replay the full assistant blocks, including signed thinking, in every exchange.
      body.messages = [...body.messages, reply];
      if (textTools) body.messages.push({ role: 'user', content: 'Tool results:\n\n' + results.map(result => result.content).join('\n\n') });
      else if (format === 'anthropic' && results.length) body.messages.push({ role: 'user', content: results });
      else body.messages.push(...results);
      delete body.tool_choice;
      if (toolRound === 19) {
        delete body.tools;
        if (format === 'anthropic') body.system = Array.isArray(body.system)
          ? body.system.concat({ type: 'text', text: TOOL_FINAL_ANSWER_NUDGE })
          : [body.system, TOOL_FINAL_ANSWER_NUDGE].filter(Boolean).join('\n\n');
        else body.messages.push({ role: 'system', content: TOOL_FINAL_ANSWER_NUDGE });
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      finishRequestMetadata(request, 'stopped', 'Generation stopped by the user.', responseStatus);
      announce('Generation stopped.');
    } else {
      finishRequestMetadata(request, e.requestStatus || 'failed', e, responseStatus);
      announce('Request failed. Retry is available.');
    }
  } finally {
    const stripped = stripThinkTags(fullText);
    thinkingText += stripped.thinking;
    fullText = stripped.content;
    toolBlocks.forEach(block => {
      if (block.searching) { block.searching = false; block.error = request.error || 'Tool request stopped.'; }
    });
    renderProgress(true);
    if (bubbleEl?.isConnected && getActiveConv() === requestConv) postRenderProcessing(bubbleEl);
    persistSwipeSources(assistantMsg, swipeIdx, sourceRegistry);
    if (request.status === 'complete') announce('Response complete.');
    if (action && foregroundAction === action) action.status = request.status;
    updateMessageTokenMetadata(assistantMsg, swipeIdx);
    debugLog('API response', {
      model,
      format,
      outputTokens: getMessageTokenCount(assistantMsg),
      toolBlocks: toolBlocks.length,
      hasThinking: Boolean(thinkingText)
    });
    streaming = false;
    if (!sending && abortController === controller) abortController = null;
    btn.classList.remove('streaming');
    btn.disabled = false;
    updateSendBtnState();
    activeSourceRegistry = null;
  }
  return request.status;
}

// ============================================
// Send Button State
// ============================================
function updateSendBtnState() {
  const btn = document.getElementById('sendBtn');
  if (!btn) return;
  const conv = getActiveConv();
  const queueBtn = document.getElementById('followUpQueueBtn');
  if (queueBtn) queueBtn.disabled = readOnlyShare || !conv || pendingAttachmentReads > 0 || (conv.queuedFollowUps || []).length >= 20 || queueingFollowUp || (sending && !streaming);
  if (abortController && (sending || streaming)) {
    btn.textContent = 'Stop';
    btn.setAttribute('aria-label', 'Stop generating response');
    btn.disabled = false;
    return;
  }
  if (sending) {
    btn.textContent = 'Preparing…';
    btn.setAttribute('aria-label', 'Preparing request');
    btn.disabled = true;
    return;
  }
  const input = document.getElementById('chatInput');
  const hasInput = Boolean(input.value.trim() || pendingAttachments.length > 0);
  const lastMsg = messages[messages.length - 1];
  const canRegenerate = !hasInput && lastMsg?.role === 'user';
  btn.disabled = readOnlyShare || _syncPullInFlight || !conv || pendingAttachmentReads > 0 || (!hasInput && !canRegenerate);
  if (canRegenerate) {
    // ponytail: the word does not fit beside the other controls on a phone.
    btn.textContent = window.innerWidth <= 768 ? '↻' : 'Regenerate';
    btn.setAttribute('aria-label', 'Regenerate response');
  } else {
    btn.textContent = 'Send';
    btn.setAttribute('aria-label', 'Send message');
  }
}

function beginSendingAction() {
  if (_syncPullInFlight || localDataOperationsInFlight) {
    showToast('Wait for the current data operation to finish.', 'info');
    return false;
  }
  if (sending || streaming) return false;
  abortController = new AbortController();
  foregroundAction = { conv: getActiveConv(), messageList: messages, controller: abortController, status: 'paused' };
  sending = true;
  updateSendBtnState();
  return true;
}

function endSendingAction() {
  const action = foregroundAction;
  const status = action?.controller.signal.aborted ? 'stopped' : action?.status;
  sending = false;
  streaming = false;
  if (abortController === action?.controller) abortController = null;
  foregroundAction = null;
  document.getElementById('sendBtn')?.classList.remove('streaming');
  updateSendBtnState();
  if (action?.conv) {
    if (status !== 'complete') armedFollowUpConversationIds.delete(action.conv.id);
    else if (armedFollowUpConversationIds.has(action.conv.id)) setTimeout(() => processQueuedFollowUps(action.conv.id), 0);
    renderFollowUpQueue();
    renderSidebar();
  }
}

function assertRequestOwner(conv, messageList, message = null, signal = abortController?.signal) {
  signal?.throwIfAborted();
  if (!conv || getActiveConv() !== conv || conv.messages !== messageList || messages !== messageList ||
      (message && !messageList.includes(message))) {
    const error = new Error('The conversation changed while the request was being prepared.');
    error.requestStatus = 'interrupted';
    throw error;
  }
}

function resolveWebSearchEnabled(conv = getActiveConv()) {
  return canUseTool('web_search', conv);
}

function closeComposerTools() {
  const button = document.getElementById('toolsBtn');
  if (button) button.setAttribute('aria-expanded', 'false');
}

function toggleComposerTools(event) {
  event?.stopPropagation();
  const button = document.getElementById('toolsBtn');
  if (button) button.setAttribute('aria-expanded', 'true');
  openContextSection('toolsSection');
}

// ============================================
// Follow-up queue
// ============================================
function renderFollowUpQueue() {
  const conv = getActiveConv();
  const panel = document.getElementById('followUpQueuePanel');
  const list = document.getElementById('followUpQueueList');
  const summary = document.getElementById('followUpQueueSummary');
  const resume = document.getElementById('followUpQueueResume');
  const queueBtn = document.getElementById('followUpQueueBtn');
  if (!panel || !list || !summary || !resume || !queueBtn) return;
  const queue = conv?.queuedFollowUps || [];
  const armed = Boolean(conv && armedFollowUpConversationIds.has(conv.id));
  panel.hidden = queue.length === 0;
  queueBtn.textContent = queue.length ? 'Queue (' + queue.length + ')' : 'Queue';
  queueBtn.disabled = readOnlyShare || !conv || pendingAttachmentReads > 0 || queue.length >= 20 || queueingFollowUp || (sending && !streaming);
  list.innerHTML = '';
  queue.forEach(item => {
    const row = document.createElement('div');
    row.className = 'follow-up-item';
    const copy = document.createElement('div');
    const text = document.createElement('strong');
    text.textContent = item.text || 'Attachment-only message';
    const meta = document.createElement('small');
    const details = [];
    if (item.attachments.length) details.push(item.attachments.length + ' attachment' + (item.attachments.length === 1 ? '' : 's'));
    if (item.modelOverride) details.push(item.modelOverride);
    meta.textContent = details.join(' · ') || 'Text message';
    copy.append(text, meta);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'icon-btn';
    cancel.textContent = 'Remove';
    cancel.setAttribute('aria-label', 'Remove queued follow-up');
    cancel.onclick = () => cancelQueuedFollowUp(item.id);
    row.append(copy, cancel);
    list.appendChild(row);
  });
  const state = streaming || sending ? 'after current response' : 'ready';
  summary.textContent = queue.length + ' queued · ' + (armed ? state : 'paused');
  resume.textContent = armed ? 'Pause' : 'Resume';
  resume.disabled = queue.length === 0 || queueingFollowUp;
}

function restoreComposerSnapshot(conv, input, originalText, attachments, overrideModel) {
  const restoredAttachments = cloneDraftAttachments(attachments);
  if (!conv || getActiveConv() !== conv) {
    if (conv) {
      if (originalText || restoredAttachments.length) conv.draft = { text: originalText, attachments: restoredAttachments, updatedAt: Date.now() };
      else delete conv.draft;
      conv.updatedAt = Date.now();
    }
    return;
  }
  const currentText = input.value;
  const separator = originalText && currentText && !/\s$/.test(originalText) ? '\n' : '';
  input.value = originalText + separator + currentText;
  pendingAttachments = restoredAttachments.concat(cloneDraftAttachments(pendingAttachments));
  if (!modelOverride && overrideModel) setModelOverride(overrideModel);
  if (input.value || pendingAttachments.length) {
    conv.draft = { text: input.value, attachments: cloneDraftAttachments(pendingAttachments), updatedAt: Date.now() };
  } else {
    delete conv.draft;
  }
  conv.updatedAt = Date.now();
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  renderPreviews();
  updateTokenInfo();
}

async function queueFollowUpFromComposer() {
  if (readOnlyShare || queueingFollowUp) return;
  if (pendingAttachmentReads > 0) {
    showToast('Wait for attachments to finish reading.', 'info');
    return;
  }
  if (sending && !streaming) {
    showToast('Wait until the current request starts before queueing a follow-up.', 'info');
    return;
  }
  const conv = getActiveConv();
  const input = document.getElementById('chatInput');
  if (!conv || !input) return;
  const originalText = input.value;
  const text = originalText.trim();
  const attachments = cloneDraftAttachments(pendingAttachments);
  if (!text && attachments.length === 0) {
    showToast('Write a follow-up or attach a file first.', 'error');
    return;
  }
  const command = parseCommand(text);
  if (command) {
    showToast('Run slash commands directly instead of queueing them.', 'error');
    return;
  }
  if ((conv.queuedFollowUps || []).length >= 20) {
    showToast('This chat already has 20 queued follow-ups.', 'error');
    return;
  }
  const originalOverride = modelOverride;
  const item = {
    id: 'followup_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    text,
    attachments,
    modelOverride: originalOverride || null,
    createdAt: Date.now()
  };
  // Queued credentials stay in memory; a reload already requires explicit Resume.
  try {
    requestTargets.set(item, Object.freeze({
      ...getActiveRequestTarget(originalOverride || undefined),
      toolPolicy: Object.freeze(getToolPolicy(conv))
    }));
  } catch (error) { /* A disconnected draft can still be queued. */ }
  conv.queuedFollowUps = (conv.queuedFollowUps || []).concat(item);
  delete conv.draft;
  conv.updatedAt = Date.now();
  queueingFollowUp = true;
  input.value = '';
  input.style.height = 'auto';
  pendingAttachments = [];
  document.getElementById('imagePreview').replaceChildren();
  clearModelOverride();
  updateSendBtnState();
  let saved = false;
  try {
    await saveConversationImmediately();
    saved = true;
  } catch (error) {
    conv.queuedFollowUps = (conv.queuedFollowUps || []).filter(queued => queued.id !== item.id);
    restoreComposerSnapshot(conv, input, originalText, attachments, originalOverride);
    showToast('Could not save the queued follow-up: ' + sanitizeErrorDetail(error), 'error');
  } finally {
    queueingFollowUp = false;
    updateSendBtnState();
  }
  if (!saved) {
    renderFollowUpQueue();
    renderSidebar();
    return;
  }
  if (activeConvId !== conv.id) {
    armedFollowUpConversationIds.delete(conv.id);
    renderSidebar();
    return;
  }
  armedFollowUpConversationIds.add(conv.id);
  renderFollowUpQueue();
  renderSidebar();
  announce('Follow-up queued.');
  if (!streaming && !sending) setTimeout(() => processQueuedFollowUps(conv.id), 0);
}

async function cancelQueuedFollowUp(id) {
  if (queueingFollowUp) return;
  const conv = getActiveConv();
  if (!conv) return;
  const before = conv.queuedFollowUps || [];
  conv.queuedFollowUps = before.filter(item => item.id !== id);
  if (conv.queuedFollowUps.length === before.length) return;
  const wasArmed = armedFollowUpConversationIds.has(conv.id);
  const previousUpdatedAt = conv.updatedAt;
  if (!conv.queuedFollowUps.length) armedFollowUpConversationIds.delete(conv.id);
  conv.updatedAt = Date.now();
  queueingFollowUp = true;
  try {
    await saveConversationImmediately();
  } catch (error) {
    conv.queuedFollowUps = before;
    conv.updatedAt = previousUpdatedAt;
    if (wasArmed) armedFollowUpConversationIds.add(conv.id);
    else armedFollowUpConversationIds.delete(conv.id);
    showToast('Could not remove the queued follow-up: ' + sanitizeErrorDetail(error), 'error');
  } finally {
    queueingFollowUp = false;
    renderFollowUpQueue();
    renderSidebar();
    updateSendBtnState();
    if (activeConvId === conv.id && armedFollowUpConversationIds.has(conv.id) && conv.queuedFollowUps.length && !sending && !streaming) {
      setTimeout(() => processQueuedFollowUps(conv.id), 0);
    }
  }
}

async function cancelAllQueuedFollowUps() {
  if (queueingFollowUp) return;
  const conv = getActiveConv();
  if (!conv?.queuedFollowUps?.length) return;
  const before = conv.queuedFollowUps;
  const wasArmed = armedFollowUpConversationIds.has(conv.id);
  const previousUpdatedAt = conv.updatedAt;
  conv.queuedFollowUps = [];
  armedFollowUpConversationIds.delete(conv.id);
  conv.updatedAt = Date.now();
  queueingFollowUp = true;
  try {
    await saveConversationImmediately();
  } catch (error) {
    conv.queuedFollowUps = before;
    conv.updatedAt = previousUpdatedAt;
    if (wasArmed) armedFollowUpConversationIds.add(conv.id);
    showToast('Could not clear the follow-up queue: ' + sanitizeErrorDetail(error), 'error');
  } finally {
    queueingFollowUp = false;
    renderFollowUpQueue();
    renderSidebar();
    updateSendBtnState();
  }
}

function toggleFollowUpQueue() {
  if (queueingFollowUp) return;
  const conv = getActiveConv();
  if (!conv?.queuedFollowUps?.length) return;
  if (armedFollowUpConversationIds.has(conv.id)) {
    armedFollowUpConversationIds.delete(conv.id);
    announce('Follow-up queue paused.');
  } else {
    armedFollowUpConversationIds.add(conv.id);
    announce('Follow-up queue resumed.');
    if (!streaming && !sending) setTimeout(() => processQueuedFollowUps(conv.id), 0);
  }
  renderFollowUpQueue();
}

async function processQueuedFollowUps(convId) {
  if (processingFollowUpConversationId || queueingFollowUp || sending || streaming || activeConvId !== convId || !armedFollowUpConversationIds.has(convId)) return;
  processingFollowUpConversationId = convId;
  try {
    while (activeConvId === convId && armedFollowUpConversationIds.has(convId) && !sending && !streaming) {
      const conv = getActiveConv();
      const item = conv?.queuedFollowUps?.[0];
      if (!item) {
        armedFollowUpConversationIds.delete(convId);
        break;
      }
      const status = await sendMessage({ queuedFollowUp: item });
      if (status !== 'complete') {
        armedFollowUpConversationIds.delete(convId);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally {
    processingFollowUpConversationId = null;
    renderFollowUpQueue();
    renderSidebar();
  }
}

// ============================================
// Send Message
// ============================================
async function sendMessage({ queuedFollowUp = null } = {}) {
  if ((sending || streaming) && abortController && !queuedFollowUp) { abortController.abort(); return 'stopped'; }
  if (readOnlyShare) return 'paused';
  if (!queuedFollowUp && pendingAttachmentReads > 0) {
    showToast('Wait for attachments to finish reading.', 'info');
    return 'paused';
  }
  if (!beginSendingAction()) return 'paused';
  let finalStatus = 'paused';
  try {

  stopVoiceInput();
  const input = document.getElementById('chatInput');
  const originalText = queuedFollowUp ? '' : input.value;
  const text = queuedFollowUp ? queuedFollowUp.text : originalText.trim();
  const composerAttachments = queuedFollowUp ? cloneDraftAttachments(queuedFollowUp.attachments) : cloneDraftAttachments(pendingAttachments);
  const conv = getActiveConv();
  const messageList = messages;
  const lastMsg = messageList[messageList.length - 1];
  const isRegenFromFork = !queuedFollowUp && !text && composerAttachments.length === 0 && lastMsg && lastMsg.role === 'user';
  if (!text && composerAttachments.length === 0 && !isRegenFromFork) return finalStatus;

  if (queuedFollowUp && conv?.queuedFollowUps?.[0]?.id !== queuedFollowUp.id) return finalStatus;

  if (!isRegenFromFork && !queuedFollowUp) {
    const cmd = parseCommand(text);
    if (cmd) {
      if (composerAttachments.length > 0) { showToast('Commands cannot include attachments.', 'error'); return finalStatus; }
      if (cmd.definition.requiresQuery && !cmd.query) { renderCommandMenu(input, cmd.cmd); return finalStatus; }
      input.value = '';
      input.style.height = 'auto';
      closeCommandDropdown();
      persistDraftFromUI();
      await handleCommand(cmd, conv);
      finalStatus = foregroundAction?.status === 'paused' ? 'complete' : foregroundAction?.status || 'paused';
      return finalStatus;
    }
  }

  const overrideModel = queuedFollowUp ? queuedFollowUp.modelOverride : modelOverride;
  const queuedTarget = queuedFollowUp && requestTargets.get(queuedFollowUp);
  if (!queuedTarget && !(localStorage.getItem('llmProxyUrl') || '').trim()) {
    openModal('setupModal', '#setupProxy');
    return finalStatus;
  }
  const target = queuedTarget || getActiveRequestTarget(overrideModel || undefined);
  const toolPolicy = target.toolPolicy || getToolPolicy(conv);
  if (target.keyRequired && !target.apiKey) {
    openModal('setupModal', '#setupProxy');
    return finalStatus;
  }

  const queuedAttachments = composerAttachments;
  const addedDocs = [];
  const previousTitle = conv?.title;
  let userMsg = null;
  const assistantMsg = { role: 'assistant', content: '', swipes: [''], swipeIndex: 0, timestamp: Date.now() };
  if (!isRegenFromFork) {
    let userContent;
    if (composerAttachments.length > 0) {
      if (conv) {
        const docs = conv.docs || (conv.docs = []);
        composerAttachments.forEach(att => {
          if (att && att.textContent && !att.binary) {
            const text = att.textContent.length > 20000 ? att.textContent.slice(0, 20000) : att.textContent;
            const doc = {
              id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
              name: att.name || 'file',
              text: text,
              createdAt: Date.now()
            };
            docs.push(doc);
            addedDocs.push(doc);
          }
        });
      }
      userContent = buildComposerMessage(text, composerAttachments).content;
    } else {
      userContent = text;
    }

    userMsg = { role: 'user', content: userContent, timestamp: Date.now() };
    updateMessageTokenMetadata(userMsg);
    messageList.push(userMsg);
    if (conv) {
      if (queuedFollowUp) conv.queuedFollowUps.shift();
      else delete conv.draft;
      conv.updatedAt = Date.now();
    }
    if (!queuedFollowUp) {
      input.value = '';
      input.style.height = 'auto';
      pendingAttachments = [];
      document.getElementById('imagePreview').replaceChildren();
      clearModelOverride();
    }
    try {
      await saveConversationImmediately();
    } catch (err) {
      if (conv && queuedFollowUp) conv.queuedFollowUps.unshift(queuedFollowUp);
      if (conv && addedDocs.length) conv.docs = (conv.docs || []).filter(doc => !addedDocs.includes(doc));
      const index = messageList.indexOf(userMsg);
      if (index !== -1) messageList.splice(index, 1);
      if (!queuedFollowUp) restoreComposerSnapshot(conv, input, originalText, queuedAttachments, overrideModel);
      showToast('Could not save your message before sending: ' + sanitizeErrorDetail(err), 'error');
      return finalStatus;
    }
    assertRequestOwner(conv, messageList, userMsg);

    // Auto-title
    if (conv && conv.title === 'New Chat') {
      conv.title = (text || 'Attachment chat').slice(0, 40);
      conv.updatedAt = Date.now();
      renderSidebar();
    }
  }

  assertRequestOwner(conv, messageList);
  const requestContext = await buildRequestMessages(conv, { messageList: messageList.slice() });
  assertRequestOwner(conv, messageList, userMsg || lastMsg);
  const apiMessages = requestContext.messages;
  if (guardTargetContextLimit(apiMessages, target, target.maxTokens || 8192)) {
    if (!isRegenFromFork) {
      const index = messageList.indexOf(userMsg);
      if (index !== -1) messageList.splice(index, 1);
      if (conv) {
        if (addedDocs.length) conv.docs = (conv.docs || []).filter(doc => !addedDocs.includes(doc));
        if (queuedFollowUp) conv.queuedFollowUps.unshift(queuedFollowUp);
        else restoreComposerSnapshot(conv, input, originalText, queuedAttachments, overrideModel);
        if (previousTitle) conv.title = previousTitle;
      }
    }
    try {
      await saveConversationImmediately();
    } catch (error) {
      showToast('The message was restored, but could not be saved: ' + sanitizeErrorDetail(error), 'error');
    }
    renderMessages();
    return finalStatus;
  }

  messageList.push(assistantMsg);
  renderMessages();
  const bubble = document.querySelector('.msg-wrapper[data-msg-idx="' + messageList.indexOf(assistantMsg) + '"] .msg-bubble');
  if (bubble) bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  finalStatus = await streamResponse(apiMessages, assistantMsg, 0, bubble, target.model, null, { conv, messageList, target, toolPolicy });

  assertRequestOwner(conv, messageList, assistantMsg, null);
  if (getSwipeRequest(assistantMsg)?.status === 'complete') {
    extractMemories(apiMessages, conv, target);
  }
  if (conv) conv.updatedAt = Date.now();
  debouncedSave();
  renderMessages({ preserveScroll: true });
  updateTokenInfo();
  } catch (error) {
    finalStatus = error.name === 'AbortError' ? 'stopped' : error.requestStatus || 'failed';
    if (error.name !== 'AbortError') showToast(sanitizeErrorDetail(error), 'error');
    renderMessages({ preserveScroll: true });
  } finally {
    if (foregroundAction) foregroundAction.status = finalStatus;
    endSendingAction();
  }
  return finalStatus;
}

// ============================================
// Regenerate
// ============================================
async function regenerate() {
  if (readOnlyShare || !beginSendingAction()) return;
  try {
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastIdx = i; break; }
  }
  if (lastIdx === -1) return;

  const msg = messages[lastIdx];
  if (msg.comparison === true) {
    showToast('Comparison responses cannot be regenerated with the active provider.', 'info');
    return;
  }
  const conv = getActiveConv();
  const messageList = messages;
  const target = getActiveRequestTarget();
  const toolPolicy = getToolPolicy(conv);
  const requestContext = await buildRequestMessages(conv, { messageList: messageList.slice(), untilIndex: lastIdx });
  assertRequestOwner(conv, messageList, msg);
  if (guardTargetContextLimit(requestContext.messages, target, target.maxTokens || 8192)) return;
  const swipeIdx = addAssistantSwipe(msg);
  renderMessages();

  const bubble = document.querySelector('.msg-wrapper[data-msg-idx="' + lastIdx + '"] .msg-bubble');
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

  const apiMessages = requestContext.messages;

  const status = await streamResponse(apiMessages, msg, swipeIdx, bubble, target.model, null, { conv, messageList, target, toolPolicy });
  assertRequestOwner(conv, messageList, msg, null);
  if (conv) conv.updatedAt = Date.now();
  debouncedSave();
  renderMessages({ preserveScroll: true });
  updateTokenInfo();
  return status;
  } catch (error) {
    if (foregroundAction) foregroundAction.status = error.name === 'AbortError' ? 'stopped' : error.requestStatus || 'failed';
    if (error.name !== 'AbortError') showToast(sanitizeErrorDetail(error), 'error');
  } finally {
    endSendingAction();
  }
}

// ============================================
// Continue Message
// ============================================
async function continueMessage() {
  if (readOnlyShare || !beginSendingAction()) return;
  try {
  const target = getActiveRequestTarget();
  if (NO_TRAILING_ASSISTANT_RE.test(target.model)) {
    showToast('Continue is not supported by this model. Start a new user turn instead.', 'error');
    return;
  }
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastIdx = i; break; }
  }
  if (lastIdx === -1) return;

  const msg = messages[lastIdx];
  if (msg.comparison === true) {
    showToast('Comparison responses cannot be continued with the active provider.', 'info');
    return;
  }
  const existingText = typeof msg.content === 'string' ? msg.content : '';
  if (!existingText.trim()) return;

  const conv = getActiveConv();
  const messageList = messages;
  const sourceSwipe = msg.swipeIndex || 0;
  const toolPolicy = getToolPolicy(conv);
  const requestContext = await buildRequestMessages(conv, {
    messageList: messageList.slice(),
    untilIndex: lastIdx + 1,
    targetIndex: lastIdx,
    includeTarget: true
  });
  assertRequestOwner(conv, messageList, msg);
  const apiMessages = requestContext.messages;
  if (guardTargetContextLimit(apiMessages, target, target.maxTokens || 8192)) return;
  const swipeIdx = addAssistantSwipe(msg, sourceSwipe);
  renderMessages();

  const bubble = document.querySelector('.msg-wrapper[data-msg-idx="' + lastIdx + '"] .msg-bubble');

  const status = await streamResponse(apiMessages, msg, swipeIdx, bubble, target.model, existingText, { conv, messageList, target, toolPolicy });
  assertRequestOwner(conv, messageList, msg, null);
  if (conv) conv.updatedAt = Date.now();
  debouncedSave();
  renderMessages({ preserveScroll: true });
  updateTokenInfo();
  return status;
  } catch (error) {
    if (foregroundAction) foregroundAction.status = error.name === 'AbortError' ? 'stopped' : error.requestStatus || 'failed';
    if (error.name !== 'AbortError') showToast(sanitizeErrorDetail(error), 'error');
  } finally {
    endSendingAction();
  }
}

// ============================================
// Clear Chat
// ============================================
function clearChat() {
  if (!prepareConversationTransition()) return;
  if (!confirm('Clear this conversation?')) return;
  const conv = getActiveConv();
  if (conv) {
    invalidateConversationContext(conv);
    contextDrafts.delete(conv);
    conv.messages = [];
    conv.title = 'New Chat';
    conv.summary = '';
    conv.summaryUpdatedAt = null;
    conv.docs = [];
    conv.queuedFollowUps = [];
    armedFollowUpConversationIds.delete(conv.id);
    conv.updatedAt = Date.now();
    messages = conv.messages;
    saveConversations();
    renderSidebar();
  }
  renderMessages();
  restoreActiveDraft();
  updateTokenInfo();
}

// ============================================
// Export / Import
// ============================================
const EXPORT_SCHEMA = 'synapse-export';
const EXPORT_VERSION = 2;
const EXPORT_SETTING_ALLOWLIST = [
  'llmProvider', 'llmProxyUrl', 'llmModel', 'llmApiFormat', 'llmStreaming', 'llmEnterSend',
  'llmTemperature', 'llmMaxTokens', 'llmContextWindow', 'llmPromptCache', 'llmThinking',
  'llmThinkingEffort', 'llmExtraParams', 'llmExcludeParams', 'llmPrefill', 'llmPersona',
  'llmEnableStMacros', 'llmRpUserName', 'llmInputCost', 'llmOutputCost', 'llmWebSearch',
  'llmForceSearch', 'llmMemoryEnabled', 'llmHoldScreenshot', 'llmEmotionSprites', 'llmEmotionSpriteSet', 'llmPromptEntries',
  'llmUrlFetch', 'llmToolConfirm', 'llmSearchApiUrl', 'llmCorsProxy',
  'assistantTheme', 'assistantStarterPrompts', 'assistantStarterPromptsHidden',
  'assistantCustomTheme', 'assistantFont', 'assistantMsgFontSize', 'assistantMsgMaxWidth', 'assistantPresets'
];
const IMPORT_SETTING_URL_KEYS = new Set(['llmProxyUrl', 'llmSearchApiUrl', 'llmCorsProxy']);
const IMPORT_SETTING_ALLOWLIST = EXPORT_SETTING_ALLOWLIST.filter(key => ![
  'llmProvider', 'llmProxyUrl', 'llmModel', 'llmApiFormat', 'llmSearchApiUrl', 'llmCorsProxy',
  'llmWebSearch', 'llmForceSearch', 'llmUrlFetch', 'llmToolConfirm'
].includes(key));
const IMPORT_PROFILE_AUTHORITY_KEYS = new Set([
  'llmProvider', 'llmProxyUrl', 'llmModel', 'llmApiFormat', 'llmSearchApiUrl', 'llmCorsProxy',
  'llmWebSearch', 'llmForceSearch', 'llmUrlFetch', 'llmToolConfirm'
]);

function sanitizeImportedProfileRecord(profile) {
  const safe = sanitizeProfileRecord(profile);
  IMPORT_PROFILE_AUTHORITY_KEYS.forEach(key => delete safe.settings[key]);
  return safe;
}

function buildSafeExportSettings() {
  const settings = {};
  EXPORT_SETTING_ALLOWLIST.forEach(key => {
    const value = localStorage.getItem(key);
    if (value === null) return;
    const safe = IMPORT_SETTING_URL_KEYS.has(key) ? sanitizeStoredUrl(value) : normalizeStructuredSettingValue(key, value);
    if (safe !== undefined) settings[key] = safe;
  });
  return settings;
}

function buildSafeExportProfiles() {
  return loadProfiles().map(sanitizeProfileRecord);
}

function shareSafeText(text) {
  return stripThinkTags(String(text || '')).content;
}

function exportConversation() {
  const conv = getActiveConv();
  if (!conv) return;
  if (isTemporaryConversation(conv)) { showToast('Temporary chats cannot be exported.', 'info'); return; }
  const data = {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    conversation: normalizeConversationRecord(JSON.parse(JSON.stringify(conv))),
    title: conv.title,
    messages: conv.messages,
    model: localStorage.getItem('llmModel') || '',
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (conv.title || 'chat') + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function exportAllConversations() {
  if (readOnlyShare) return;
  try {
  persistDraftFromUI();
  if (_projectAutosaveTimer && !await flushProjectAutosave()) throw new Error('Project changes could not be saved.');
  await saveConversationImmediately();
  if (!await saveProjects(true)) throw new Error('Project changes could not be saved.');
  const memories = await loadMemories();
  const snapshot = db ? await syncCapturePullSnapshot() : { conversations: getPersistentConversations(), projects, memories };
  const persistentConversations = snapshot.conversations;
  const data = {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    conversations: persistentConversations,
    // Advertised as a full backup, so project instructions and files ride along too.
    projects: snapshot.projects,
    memories: snapshot.memories,
    drafts: persistentConversations.filter(conv => conv.draft).map(conv => ({ conversationId: conv.id, ...conv.draft })),
    exportedAt: new Date().toISOString(),
    settings: buildSafeExportSettings(),
    profiles: buildSafeExportProfiles()
  };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'assistant-export-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    return data;
  } catch (error) { showToast('Could not prepare export: ' + sanitizeErrorDetail(error), 'error'); return null; }
}

function normalizeImportedData(data) {
  if (!data || typeof data !== 'object') throw new Error('The file is not a JSON object.');
  if (data.schema && data.schema !== EXPORT_SCHEMA) throw new Error('Unsupported export schema.');
  if (data.version != null && (!Number.isInteger(Number(data.version)) || Number(data.version) < 1 || Number(data.version) > EXPORT_VERSION)) throw new Error('Unsupported export version.');
  let rawConversations = Array.isArray(data.conversations) ? data.conversations : [];
  if (!rawConversations.length && data.conversation && typeof data.conversation === 'object') rawConversations = [data.conversation];
  if (!rawConversations.length && Array.isArray(data.messages)) rawConversations = [{ id: genId(), title: data.title || 'Imported Chat', messages: data.messages }];
  const importedConversations = normalizeLoadedConversations(rawConversations).conversations.map(conv => {
    conv.toolPolicy = null;
    // An imported file cannot assert that it has seen this browser's saved revisions.
    delete conv.syncVersion;
    delete conv.shareGistId;
    delete conv.shareUrl;
    delete conv.shareId;
    return conv;
  });
  if (!importedConversations.length) throw new Error('No conversations found in this file.');
  importedConversations.forEach(conv => conv.messages.forEach(message => {
    if (message.role === 'assistant' && !Array.isArray(message.swipes)) {
      message.swipes = [typeof message.content === 'string' ? message.content : ''];
      message.swipeIndex = 0;
    }
  }));
  const importedProjects = normalizeProjectList(data.projects);
  const importedMemories = normalizeMemoryList(Array.isArray(data.memories) ? data.memories : []).memories;
  const drafts = Array.isArray(data.drafts) ? data.drafts.filter(draft => draft && typeof draft === 'object').map(draft => ({ ...draft })) : [];
  const settings = {};
  Object.keys(data.settings || {}).forEach(key => {
    if (IMPORT_SETTING_ALLOWLIST.includes(key)) {
      const value = String(data.settings[key] ?? '');
      const safeValue = IMPORT_SETTING_URL_KEYS.has(key) ? sanitizeStoredUrl(value) : normalizeStructuredSettingValue(key, value);
      if (safeValue !== undefined) settings[key] = safeValue;
    }
  });
  const profiles = Array.isArray(data.profiles) ? data.profiles.map(sanitizeImportedProfileRecord) : [];
  return { conversations: importedConversations, projects: importedProjects, memories: importedMemories, drafts, settings, profiles };
}

function renderImportPreview(data) {
  const body = document.getElementById('importPreviewBody');
  if (!body) return;
  body.innerHTML = '';
  const rows = [
    ['File', pendingImportMeta?.name || 'JSON import'],
    ['Schema', pendingImportMeta?.schema || 'Legacy'],
    ['Exported', pendingImportMeta?.exportedAt ? new Date(pendingImportMeta.exportedAt).toLocaleString() : 'Not provided'],
    ['Conversations', data.conversations.length],
    ['Projects', data.projects.length],
    ['Messages', data.conversations.reduce((total, conv) => total + conv.messages.length, 0)],
    ['Drafts', data.drafts.length + data.conversations.filter(conv => conv.draft).length],
    ['Queued follow-ups', data.conversations.reduce((total, conv) => total + (conv.queuedFollowUps?.length || 0), 0)],
    ['Memories', data.memories.length],
    ['Safe settings', Object.keys(data.settings).length]
  ];
  const intro = document.createElement('p');
  intro.textContent = 'Parsed successfully. Provider endpoints, API keys, search settings, sync tokens, and other credentials will not be restored.';
  body.appendChild(intro);
  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'import-preview-row';
    row.innerHTML = '<strong></strong><span></span>';
    row.querySelector('strong').textContent = label;
    row.querySelector('span').textContent = String(value);
    body.appendChild(row);
  });
  document.querySelector('input[name="importStrategy"][value="merge"]')?.click();
  updateImportStrategyUI();
}

function importConversation(event) {
  if (readOnlyShare) return;
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  if (!beginLocalDataOperation()) return;
  let operationEnded = false;
  const finishOperation = () => {
    if (operationEnded) return;
    operationEnded = true;
    endLocalDataOperation();
  };
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const raw = JSON.parse(e.target.result);
      pendingImport = normalizeImportedData(raw);
      pendingImportMeta = {
        name: file.name,
        schema: raw.schema ? raw.schema + (raw.version ? ' v' + raw.version : '') : '',
        exportedAt: raw.exportedAt || ''
      };
      renderImportPreview(pendingImport);
      openModal('importPreviewModal');
    } catch (err) { showToast('Could not parse import: ' + sanitizeErrorDetail(err), 'error'); }
    finally { finishOperation(); }
  };
  reader.onerror = reader.onabort = () => {
    showToast('Could not read import file.', 'error');
    finishOperation();
  };
  try {
    reader.readAsText(file);
  } catch (err) {
    showToast('Could not read import file.', 'error');
    finishOperation();
  }
}

function updateImportStrategyUI() {
  const mode = document.querySelector('input[name="importStrategy"]:checked')?.value || 'merge';
  const button = document.getElementById('applyImportBtn');
  if (!button) return;
  button.classList.toggle('btn-danger', mode === 'replace');
  button.classList.toggle('btn-primary', mode !== 'replace');
  button.textContent = mode === 'replace' ? 'Replace data' : 'Import';
}

function applySelectedImport() {
  const mode = document.querySelector('input[name="importStrategy"]:checked')?.value || 'merge';
  return applyImport(mode);
}

function mergeByUpdatedId(localList, incomingList) {
  const byId = new Map((localList || []).filter(item => item?.id).map(item => [item.id, item]));
  (incomingList || []).filter(item => item?.id).forEach(item => {
    const existing = byId.get(item.id);
    if (!existing || Number(item.updatedAt || item.createdAt || 0) > Number(existing.updatedAt || existing.createdAt || 0)) byId.set(item.id, item);
  });
  return Array.from(byId.values());
}

function hasPublicShareIds(list) {
  return (list || []).some(conv => conv.shareGistId || conv.shareUrl || conv.shareId);
}

function remapCopiedConversationParents(copies, idMap) {
  copies.forEach(copy => {
    if (!copy.parentConversationId) return;
    const parentId = idMap.get(copy.parentConversationId);
    if (parentId) copy.parentConversationId = parentId;
    else {
      delete copy.parentConversationId;
      delete copy.forkMessageIndex;
      delete copy.forkedAt;
    }
  });
  return copies;
}

async function applyImport(mode = 'merge') {
  if (readOnlyShare || !pendingImport) return false;
  if (sending || streaming || queueingFollowUp) {
    showToast('Stop the current response before importing.', 'info');
    return;
  }
  if (pendingAttachmentReads > 0) {
    showToast('Wait for attachments to finish reading before importing.', 'info');
    return false;
  }
  if (!['merge', 'copy', 'replace'].includes(mode)) return;
  if (!beginLocalDataOperation()) return;
  let committed = false;
  try {
  if (!db) throw new Error('Import needs a working browser database. Free storage and reload, then retry.');
  const imported = pendingImport;
  const previousActiveConvId = activeConvId;
  if (mode === 'replace' && !confirm('Replace imported categories? This removes local conversations, projects, memories, and drafts.')) return;
  if ((mode === 'replace' && hasPublicShareIds(conversations)) || (mode !== 'replace' && hasPublicShareIds(imported.conversations))) {
    if (!confirm('Some records have public share IDs. Deleting or replacing them does not revoke the public links. Continue?')) return;
  }
  flushSettingsAutosaves();
  persistDraftFromUI();
  if (_projectAutosaveTimer && !await flushProjectAutosave()) throw new Error('Project changes could not be saved. Retry before importing.');
  if (!await saveProjects(true)) throw new Error('Project changes could not be saved. Retry before importing.');
  await saveConversationImmediately();
  await loadMemories();
  const snapshot = await syncCapturePullSnapshot();
  let importedConversations = imported.conversations.map(conv => normalizeConversationRecord(JSON.parse(JSON.stringify(conv))));
  let importedProjects = JSON.parse(JSON.stringify(imported.projects));
  let importedMemories = imported.memories.slice();
  imported.drafts.forEach(draft => {
    const conv = importedConversations.find(item => item.id === draft.conversationId);
    if (conv && (!conv.draft || Number(draft.updatedAt || 0) > Number(conv.draft.updatedAt || 0))) {
      conv.draft = { text: typeof draft.text === 'string' ? draft.text : '', attachments: cloneDraftAttachments(draft.attachments), updatedAt: Number(draft.updatedAt) || Date.now() };
      conv.updatedAt = Math.max(conv.updatedAt, conv.draft.updatedAt);
      delete conv.syncVersion;
    }
  });
  const copyConversationIds = new Map();
  if (mode === 'copy') {
    const projectIds = new Map();
    importedProjects = importedProjects.map(project => {
      const copy = { ...project, id: 'proj_' + genId(), updatedAt: Date.now() };
      projectIds.set(project.id, copy.id);
      return copy;
    });
    importedConversations = importedConversations.map(conv => {
      const copy = normalizeConversationRecord(JSON.parse(JSON.stringify(conv)));
      copyConversationIds.set(conv.id, copy.id = genId());
      copy.updatedAt = Date.now();
      delete copy.syncVersion;
      delete copy.conflictOf;
      delete copy.conflictTitle;
      if (copy.projectId) copy.projectId = projectIds.get(copy.projectId) || copy.projectId;
      delete copy.shareGistId;
      delete copy.shareUrl;
      delete copy.shareId;
      copy.messages.forEach(message => delete message._editing);
      return copy;
    });
    remapCopiedConversationParents(importedConversations, copyConversationIds);
    importedMemories = importedMemories.map(memory => ({ ...memory, id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) }));
  }
  const localTombstones = syncCloneJson(snapshot.tombstones);
  const resurrect = (records, category, timestampKey) => records.forEach(record => {
    const deletedAt = Number(localTombstones[category][record.id]) || 0;
    if (!deletedAt) return;
    record[timestampKey] = Math.max(Date.now(), deletedAt + 1, Number(record[timestampKey]) || 0);
    delete localTombstones[category][record.id];
    if (category === 'conversations') delete localTombstones.conversationVersions[record.id];
  });
  resurrect(importedConversations, 'conversations', 'updatedAt');
  resurrect(importedProjects, 'projects', 'updatedAt');
  resurrect(importedMemories, 'memories', 'createdAt');
  if (sending || streaming || queueingFollowUp) {
    showToast('Stop the current response before importing.', 'info');
    return;
  }
  const merged = mode === 'replace' ? { conversations: importedConversations, conflicts: [] }
    : await syncMergeConversationLists(snapshot.conversations, importedConversations);
  const nextProjects = mode === 'replace' ? importedProjects : syncMergeProjectLists(snapshot.projects, importedProjects);
  const nextMemories = mode === 'replace' ? importedMemories : syncMergeMemoryLists(snapshot.memories, importedMemories);
  if (mode === 'replace') {
    [['conversations', importedConversations, 'updatedAt'], ['projects', nextProjects, 'updatedAt'], ['memories', nextMemories, 'createdAt']].forEach(([category, incoming, timestamp]) => {
      const ids = new Set(incoming.map(record => record.id));
      snapshot[category].forEach(record => {
        if (!ids.has(record.id)) {
          localTombstones[category][record.id] = Math.max(Date.now(), Number(record[timestamp]) || 0);
          if (category === 'conversations') localTombstones.conversationVersions[record.id] = normalizeConversationVersion(record.syncVersion);
        }
      });
    });
  }
  const settingsValues = { ...imported.settings, [SYNC_TOMBSTONES_KEY]: JSON.stringify(localTombstones) };
  if (imported.profiles.length) {
    const existing = JSON.parse(snapshot.settingsValues.assistantProfiles || '[]');
    settingsValues.assistantProfiles = JSON.stringify(mergeByUpdatedId(Array.isArray(existing) ? existing.map(sanitizeProfileRecord) : [], imported.profiles.map(sanitizeImportedProfileRecord)));
  }
  const nextActiveId = mode !== 'replace' && merged.conversations.some(conv => conv.id === previousActiveConvId)
    ? previousActiveConvId : (merged.conversations[0]?.id || '');
  const saved = await syncPersistPullData({ conversations: merged.conversations, projects: nextProjects, memories: nextMemories, persistentActiveId: nextActiveId, settingsValues }, snapshot);
  committed = true;
  replacePersistentConversations(saved.conversations, mode !== 'replace');
  projects = saved.projects;
  setConversationBaseline(saved.conversations);
  projectBaseline = new Map(projects.map(project => [project.id, serializeConversation(project)]));
  armedFollowUpConversationIds.clear();
  activeConvId = mode !== 'replace' && conversations.some(conv => conv.id === previousActiveConvId)
    ? previousActiveConvId
    : (conversations[0]?.id || null);
  messages = getActiveConv()?.messages || [];
  pendingImport = null;
  pendingImportMeta = null;
  try {
  closeModal('importPreviewModal');
  if (document.getElementById('settingsModal')?.classList.contains('open')) closeModal('settingsModal');
  renderSidebar();
  renderMessages();
  restoreActiveDraft();
  updateTokenInfo();
  renderConnectionChip();
  syncRefreshAppliedSettings();
  } catch (error) { console.warn('Import committed; interface refresh failed:', error); }
  notifyConversationConflicts(saved.conversations.filter(conv => conv.conflictOf).map(conv => conv.id));
  syncScheduleAutoPush();
  showToast('Import applied (' + mode + ').', 'success');
  return true;
  } catch (error) {
    console.error(committed ? 'Import refresh failed:' : 'Import was not applied:', error);
    showToast(committed ? 'Import was saved, but the display could not be refreshed. Reload this tab.' :
      'Import was not applied: ' + sanitizeErrorDetail(error) + ' Keep the file and retry after resolving the problem.', 'error', 0);
    return committed;
  } finally {
    endLocalDataOperation();
  }
}

async function renderStorageSummary() {
  const el = document.getElementById('storageSummary');
  if (!el) return;
  const persistentConversations = getPersistentConversations();
  const approximate = [
    ['Conversations', JSON.stringify(persistentConversations).length],
    ['Projects', JSON.stringify(projects).length],
    ['Drafts and queue', JSON.stringify(persistentConversations.map(conv => ({ draft: conv.draft || null, queuedFollowUps: conv.queuedFollowUps || [] }))).length],
    ['Memories', (await loadMemories()).reduce((total, memory) => total + JSON.stringify(memory).length, 0)]
  ];
  let usageText = 'Storage estimate unavailable.';
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.usage != null) usageText = 'Browser storage: ' + formatCacheBytes(estimate.usage) + (estimate.quota ? ' used of ' + formatCacheBytes(estimate.quota) : ' used');
  } catch (e) {}
  el.innerHTML = approximate.map(([label, bytes]) => '<div><span>' + escapeHTML(label) + '</span><strong>' + formatCacheBytes(bytes * 2) + '</strong></div>').join('') + '<p>' + escapeHTML(usageText) + '</p>';
}

async function clearDataCategory(category) {
  if (readOnlyShare) return;
  if (category === 'conversations' && (sending || streaming || queueingFollowUp)) {
    showToast('Stop the current response before clearing conversations.', 'info');
    return;
  }
  const labels = { conversations: 'conversations', drafts: 'drafts', memories: 'memories', credentials: 'provider, search, and sync credentials' };
  if (!labels[category] || !confirm('Clear ' + labels[category] + '? This cannot be undone.')) return;
  if (!beginLocalDataOperation()) return;
  try {
  if (category === 'conversations') {
    if (hasPublicShareIds(conversations) && !confirm('Some links may remain public after local deletion. Continue?')) return;
    syncRecordTombstones('conversations', conversations.map(conv => conv.id));
    conversations = [];
    activeConvId = null;
    createConversation();
    await saveConversationImmediately();
  } else if (category === 'drafts') {
    conversations.forEach(conv => {
      if (conv.draft?.text || conv.draft?.attachments?.length || conv.queuedFollowUps?.length) conv.updatedAt = Math.max(Date.now(), (Number(conv.updatedAt) || 0) + 1);
      delete conv.draft;
      conv.queuedFollowUps = [];
    });
    armedFollowUpConversationIds.clear();
    pendingAttachments = [];
    const input = document.getElementById('chatInput');
    if (input) input.value = '';
    renderPreviews();
    await saveConversationImmediately();
  } else if (category === 'memories') {
    syncRecordTombstones('memories', (await loadMemories()).map(memory => memory.id));
    await saveMemories([]);
  } else if (category === 'credentials') {
    ['llmApiKey', 'llmSearchApiKey'].forEach(key => { localStorage.removeItem(key); sessionStorage.removeItem(key); });
    ['assistantSyncGistToken', 'assistantSyncPassphrase', 'assistantSyncGistId', 'assistantSyncSalt', 'assistantSyncLastHash', 'assistantSyncLastPushAt', 'assistantSyncLastPullAt', SYNC_TOMBSTONES_KEY, SYNC_SETTINGS_STATE_KEY, SYNC_STATE_GIST_KEY, SYNC_AUTO_PUSH_KEY, SYNC_AUTO_PENDING_KEY].forEach(key => localStorage.removeItem(key));
    ['setKey', 'setSearchApiKey', 'setupKey', 'setSyncToken', 'setSyncGistId', 'setSyncPassphrase', 'syncPairingText', 'syncPairingCode'].forEach(id => {
      const input = document.getElementById(id);
      if (input) input.value = '';
    });
    scrubProfileSecrets();
    const canvas = document.getElementById('syncPairingQr');
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    document.getElementById('syncPairingOutput').hidden = true;
    renderSyncSettings();
  }
  await renderStorageSummary();
  renderConnectionChip();
  showToast('Cleared ' + labels[category] + '.', 'success');
  } catch (error) {
    reportPersistenceError(error);
  } finally {
    endLocalDataOperation();
  }
}

function synapseSelfTest() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  try {
    const sample = normalizeConversationRecord({ id: 'selftest', messages: [
      { role: 'user', content: 'included' },
      { role: 'assistant', content: 'excluded', includeInContext: false },
      { role: 'assistant', content: 'failed', swipeRequests: [{ status: 'failed' }], swipes: ['failed'], swipeIndex: 0 }
    ] });
    const filtered = filterRequestHistory(sample.messages);
    assert(filtered.included.length === 1 && filtered.included[0].message.content === 'included', 'context filtering');
    assert(filtered.excluded.length === 1, 'excluded history');
    const registry = sourceRegistryFor({ swipeSources: [[{ number: 1, url: 'https://example.test/page' }]] }, 0);
    const numbered = registerSources(registry, [{ url: 'https://example.test/page#section', title: 'same' }, { url: 'https://example.test/other', title: 'other' }]);
    assert(numbered[0].sourceNumber === 1 && numbered[1].sourceNumber === 2, 'source numbering');
    const imported = normalizeImportedData({ messages: [{ role: 'user', content: 'legacy' }] });
    assert(imported.conversations.length === 1 && imported.conversations[0].messages.length === 1, 'legacy import');
    const malformed = normalizeConversationRecord({ id: '\" bad', tag: '<img>', draft: { attachments: [null] }, messages: [] });
    assert(malformed.id !== '\" bad' && !malformed.tag && malformed.draft.attachments.length === 0, 'untrusted conversation normalization');
    const bubbleProbe = document.createElement('div');
    setBubbleHTML(bubbleProbe, 'first', '<p>a</p>');
    const thinkProbe = bubbleProbe.querySelector('.thinking-content');
    setBubbleHTML(bubbleProbe, 'first second', '<p>b</p>');
    assert(bubbleProbe.querySelector('.thinking-content') === thinkProbe, 'thinking block reused while streaming');
    assert(thinkProbe.textContent === 'first second' && bubbleProbe.lastElementChild.textContent === 'b', 'thinking block updated in place');
    const malformedParts = normalizeConversationRecord({ messages: [{ role: 'user', content: [null, { type: 'text', text: 7 }] }, { role: 'assistant', content: 'ok', swipes: [null, 42], swipeIndex: 9 }] });
    assert(malformedParts.messages[0].content.length === 1 && malformedParts.messages[0].content[0].text === '7' && malformedParts.messages[1].swipes[1] === '42' && malformedParts.messages[1].swipeIndex === 1, 'message part normalization');
    const queued = normalizeConversationRecord({ id: 'queue-test', goal: 'g'.repeat(5000), parentConversationId: 'queue-test', queuedFollowUps: [
      { id: 'one', text: 'next', modelOverride: 'model', createdAt: 1 },
      { id: 'empty', text: '', attachments: [] }
    ] });
    assert(queued.goal.length === 4000 && !queued.parentConversationId && queued.queuedFollowUps.length === 1 && queued.queuedFollowUps[0].text === 'next', 'goal and queue normalization');
    const copiedLineage = remapCopiedConversationParents([
      { id: 'new-child', parentConversationId: 'old-parent', forkMessageIndex: 2 },
      { id: 'orphan', parentConversationId: 'missing', forkMessageIndex: 3 }
    ], new Map([['old-parent', 'new-parent']]));
    assert(copiedLineage[0].parentConversationId === 'new-parent' && !copiedLineage[1].parentConversationId, 'copied fork lineage');
    const xss = renderMarkdown('![\" onerror=\"alert(1)\" x=\"](https://example.test/image.png)');
    assert(!xss.includes('alt="" onerror='), 'markdown image attributes');
    assert(!canUseCorsProxy('https://api.example.test/chat', { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: '{}' }, 'https://corsproxy.io/?url='), 'credentialed public proxy blocking');
    assert(!canUseCorsProxy('https://search.example.test/?credential=opaque', { headers: { 'X-RapidAPI-Key': 'secret' } }, 'https://corsproxy.io/?url=', true), 'configured search credential blocking');
    assert(isLocalUrl('http://[::ffff:7f00:1]/'), 'mapped private IPv6 blocking');
    assert(isLocalUrl('http://[::]/') && isLocalUrl('http://100.64.0.1/'), 'non-public address blocking');
    assert(isLocalUrl('http://localhost./'), 'trailing-dot private host blocking');
    assert(requestContainsSensitiveData('https://search.example.test/?apiKey=secret'), 'query credential detection');
    assert(!canUseCorsProxy('https://api.example.test/chat', { method: 'POST', body: '{}' }, 'https://corsproxy.io./?url='), 'trailing-dot public proxy blocking');
    const activeProfileBeforeRequestTests = localStorage.getItem('assistantActiveProfileId');
    const activeKeyBeforeRequestTests = getApiKey();
    const explicitTarget = buildRequestTarget({
      llmProvider: 'openai',
      llmProxyUrl: 'https://one.example.test/v1',
      llmModel: 'claude-name-does-not-change-format',
      llmApiFormat: 'openai'
    }, { apiKey: 'self-test-key' });
    const otherAuthority = buildRequestTarget({
      llmProvider: 'anthropic',
      llmProxyUrl: 'https://two.example.test/v1',
      llmModel: 'claude-test',
      llmApiFormat: 'anthropic'
    });
    assert(explicitTarget.apiFormat === 'openai', 'request target format isolation');
    assert(resolveRequestTargetKey(explicitTarget, explicitTarget) === 'self-test-key', 'same-authority key reuse');
    assert(resolveRequestTargetKey(otherAuthority, explicitTarget) === '', 'cross-authority key isolation');
    assert(localStorage.getItem('assistantActiveProfileId') === activeProfileBeforeRequestTests && getApiKey() === activeKeyBeforeRequestTests, 'request target storage isolation');
    const parsedSuggestions = parseFollowUpSuggestions('```json\n["One", "one", 7, "Two"]\n```');
    assert(parsedSuggestions.length === 2 && parsedSuggestions[0] === 'One' && parsedSuggestions[1] === 'Two', 'follow-up parsing');
    const comparisonProbe = { role: 'assistant', comparison: true, content: '', swipes: ['', ''], swipeIndex: 0, swipeRequests: [] };
    createRequestMetadata(comparisonProbe, 0, { model: 'first' });
    createRequestMetadata(comparisonProbe, 1, { model: 'second' });
    const comparisonSuccess = applyComparisonSettledResults(comparisonProbe, [explicitTarget, otherAuthority], [
      { status: 'rejected', reason: Object.assign(new Error('failed'), { httpStatus: 401 }) },
      { status: 'fulfilled', value: 'kept response' }
    ]);
    assert(comparisonSuccess.length === 1 && comparisonSuccess[0] === 1 && comparisonProbe.swipes.length === 2 &&
      comparisonProbe.swipeRequests[0].status === 'failed' && comparisonProbe.swipeRequests[1].status === 'complete' &&
      comparisonProbe.swipeIndex === 1 && comparisonProbe.content === 'kept response', 'comparison result alignment');
    const normalizedComparison = normalizeConversationRecord({ messages: [comparisonProbe, { role: 'user', comparison: true, content: 'prompt' }] });
    assert(normalizedComparison.messages[0].comparison === true && !('comparison' in normalizedComparison.messages[1]), 'comparison marker normalization');
    assert(!JSON.stringify(comparisonProbe).includes('self-test-key'), 'comparison credential isolation');
    const authorityImport = normalizeImportedData({
      conversation: {
        messages: [],
        toolPolicy: { urlFetch: true, confirm: false },
        shareGistId: 'attacker-gist',
        shareUrl: 'https://example.test/share',
        shareId: 'attacker-share'
      },
      settings: { llmUrlFetch: 'true', llmToolConfirm: 'false' },
      profiles: [{ id: 'imported', settings: { llmProxyUrl: 'https://attacker.test/v1', llmUrlFetch: 'true' } }]
    });
    assert(authorityImport.conversations[0].toolPolicy === null &&
      !authorityImport.conversations[0].shareGistId && !authorityImport.conversations[0].shareUrl && !authorityImport.conversations[0].shareId &&
      !('llmUrlFetch' in authorityImport.settings) && !authorityImport.profiles[0].settings.llmProxyUrl, 'import authority stripping');
    const malformedImport = normalizeImportedData({ conversation: { messages: [] }, settings: { llmPromptEntries: '{}' }, projects: [{ id: 'project', name: {}, docs: [null] }] });
    assert(!('llmPromptEntries' in malformedImport.settings) && typeof malformedImport.projects[0].name === 'string' && malformedImport.projects[0].docs.length === 0, 'structured import normalization');
    const legacyBranches = normalizeLoadedConversations([{ id: 'legacy-branches', title: 'Legacy', messages: [
      { role: 'user', content: 'root', branches: [[{ role: 'user', content: 'old' }], [{ role: 'user', content: 'current' }]], branchIndex: 1 }
    ] }]);
    assert(legacyBranches.conversations.length === 2 && legacyBranches.conversations.every(conv => !conv.messages.some(message => message.branches)), 'legacy branch migration');
    const legacySettings = syncNormalizeSettingsPayload({ exportedAt: '2026-01-01T00:00:00Z', settings: { assistantTheme: 'dark' } });
    assert(legacySettings.settings.assistantTheme === 'dark' && !Object.prototype.hasOwnProperty.call(legacySettings.settings, 'llmPromptEntries'), 'legacy settings presence');
    assert(syncConversationFileName('a.b') !== syncConversationFileName('a:b'), 'sync filename uniqueness');
    assert(chooseConversationWinner({ id: 'same', updatedAt: 2, messages: [{ role: 'user', content: 'newer' }] }, { id: 'same', updatedAt: 1, messages: [] }) === null, 'unknown divergent history needs a copy');
    const storedConversation = { id: 'persist', updatedAt: 1, messages: [] };
    const appendedConversation = { id: 'persist', updatedAt: 1, messages: [{ role: 'assistant', content: 'reply' }] };
    assert(chooseConversationWinner(appendedConversation, storedConversation, serializeConversation(storedConversation)) === appendedConversation, 'same-tab persistence');
    const occupied = { id: 'collision', title: 'Unrelated', messages: [] };
    const collisionRecords = new Map([['persist', storedConversation], ['collision', occupied]]);
    const recoveredCollision = reconcileConversationRecord(collisionRecords, appendedConversation, 'collision');
    assert(recoveredCollision.id !== 'collision' && collisionRecords.get('collision') === occupied && recoveredCollision.messages.length === 1, 'conflict IDs do not overwrite unrelated records');
    assert(syncFilterDeletedRecords([storedConversation], { persist: 2 }, 'updatedAt').length === 0, 'conversation tombstone filtering');
    const originalConversations = conversations;
    const originalActiveConvId = activeConvId;
    try {
      const persistentProbe = normalizeConversationRecord({ id: 'persistent-probe', messages: [] });
      const temporaryProbe = normalizeConversationRecord({ id: 'temporary-probe', messages: [] });
      temporaryConversations.add(temporaryProbe);
      conversations = [persistentProbe, temporaryProbe];
      activeConvId = temporaryProbe.id;
      assert(getPersistentConversations().length === 1 && getPersistentConversations()[0] === persistentProbe, 'temporary persistence projection');
      assert(getPersistentActiveConvId() === persistentProbe.id, 'temporary active ID projection');
      const spoofedTemporary = normalizeConversationRecord({ id: 'spoofed-temporary', temporary: true, isTemporary: true, messages: [] });
      assert(!isTemporaryConversation(spoofedTemporary) && !('temporary' in spoofedTemporary) && !('isTemporary' in spoofedTemporary), 'temporary marker trust boundary');
      replacePersistentConversations([{ id: temporaryProbe.id, messages: [{ role: 'user', content: 'collision' }] }, { id: 'remote-probe', messages: [] }], true);
      assert(conversations.find(conv => conv.id === temporaryProbe.id) === temporaryProbe && conversations.filter(conv => conv.id === temporaryProbe.id).length === 1, 'temporary collision preservation');
    } finally {
      conversations = originalConversations;
      activeConvId = originalActiveConvId;
    }
    assert(!syncAutoPushIsConfigured({ token: 'token', passphrase: 'passphrase' }), 'auto-push Gist gating');
    assert(syncAutoPushIsConfigured({ token: 'token', passphrase: 'passphrase', gistId: 'gist' }), 'auto-push configuration');
    const storedSync = syncGetStoredConfig();
    assert(storedSync.token === (localStorage.getItem('assistantSyncGistToken') || '') &&
      storedSync.gistId === (localStorage.getItem('assistantSyncGistId') || '') &&
      storedSync.passphrase === (localStorage.getItem('assistantSyncPassphrase') || ''), 'auto-push stored configuration');
    EMOTION_SPRITE_TAG_RE.lastIndex = 0;
    assert(EMOTION_SPRITE_TAG_RE.test('<gpt_helpfulness />'), 'emotion sprite tag');
    assert(EMOTION_SPRITE_SETS.cat.length === 24 && new Set(EMOTION_SPRITE_SETS.cat).size === 24, '24 distinct cat expressions');
    for (const emotion of EMOTION_SPRITE_SETS.cat) {
      const name = 'cat_' + emotion;
      EMOTION_SPRITE_TAG_RE.lastIndex = 0;
      assert(EMOTION_SPRITE_NAMES[name] === 'cat' && EMOTION_SPRITE_TAG_RE.test('<' + name + ' />'), 'cat expression tag: ' + emotion);
    }
    const result = { ok: true, checks: ['normalization', 'goal and queue', 'fork lineage', 'context filtering', 'source numbering', 'legacy import', 'legacy branches', 'legacy settings', 'trust boundaries', 'request targets', 'manual AI parsing', 'comparison alignment', 'sync filenames', 'persistence arbitration', 'tombstones', 'temporary chat isolation', 'updatedAt merge', 'auto-push configuration', 'auto-push stored configuration', 'emotion sprite tag'] };
    console.info('Synapse self-test passed', result);
    return result;
  } catch (error) {
    const result = { ok: false, error: error.message || String(error) };
    console.error('Synapse self-test failed', result);
    return result;
  }
}

// ============================================
// Encrypted GitHub Gist Sync
// ============================================
function syncSetStoredValue(key, value) {
  if (value === null || value === undefined || value === '') localStorage.removeItem(key);
  else localStorage.setItem(key, String(value));
}

function syncGetDeviceId() {
  let id = localStorage.getItem('assistantSyncDeviceId') || '';
  if (!id) {
    id = window.crypto?.randomUUID ? window.crypto.randomUUID() : 'device_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('assistantSyncDeviceId', id);
  }
  return id;
}

let _syncInputsLoaded = false;
let _syncAutoPushTimer;
let _syncOperationInFlight = false;
// Pull replaces all local state, so it alone must lock the UI. Push only
// snapshots local data into the Gist; anything changed mid-push is picked up
// by the next auto-push, so the app stays usable while a push runs.
let _syncPullInFlight = false;

function syncAutoPushIsConfigured(cfg) {
  return !!(cfg?.token && cfg?.passphrase && cfg?.gistId);
}

function syncGetStoredConfig() {
  return {
    token: localStorage.getItem('assistantSyncGistToken') || '',
    gistId: localStorage.getItem('assistantSyncGistId') || '',
    passphrase: localStorage.getItem('assistantSyncPassphrase') || '',
    autoPush: localStorage.getItem(SYNC_AUTO_PUSH_KEY) === 'true'
  };
}

function syncGetConfigFromInputs() {
  const tokenEl = document.getElementById('setSyncToken');
  const gistEl = document.getElementById('setSyncGistId');
  const passEl = document.getElementById('setSyncPassphrase');
  const autoEl = document.getElementById('setSyncAutoPush');
  const stored = syncGetStoredConfig();
  return {
    token: _syncInputsLoaded && tokenEl ? tokenEl.value.trim() : stored.token,
    gistId: _syncInputsLoaded && gistEl ? gistEl.value.trim() : stored.gistId,
    passphrase: _syncInputsLoaded && passEl ? passEl.value : stored.passphrase,
    autoPush: _syncInputsLoaded && autoEl ? autoEl.checked : stored.autoPush
  };
}

function syncResetScopedState() {
  [SYNC_TOMBSTONES_KEY, SYNC_SETTINGS_STATE_KEY, 'assistantSyncSalt', 'assistantSyncLastHash',
    'assistantSyncLastPushAt', 'assistantSyncLastPullAt', SYNC_AUTO_PENDING_KEY]
    .forEach(key => localStorage.removeItem(key));
}

function syncUpdateGistScope(nextGistId, previousGistId = '') {
  const next = String(nextGistId || '').trim();
  const scoped = localStorage.getItem(SYNC_STATE_GIST_KEY) || '';
  if ((scoped && scoped !== next) || (!scoped && previousGistId && previousGistId !== next)) syncResetScopedState();
  if (next) localStorage.setItem(SYNC_STATE_GIST_KEY, next);
  else localStorage.removeItem(SYNC_STATE_GIST_KEY);
}

function syncScheduleAutoPush() {
  try {
    if (readOnlyShare || localStorage.getItem(SYNC_AUTO_PUSH_KEY) !== 'true') return;
    localStorage.setItem(SYNC_AUTO_PENDING_KEY, 'true');
    clearTimeout(_syncAutoPushTimer);
    _syncAutoPushTimer = setTimeout(syncRunAutoPush, SYNC_AUTO_PUSH_DELAY);
  } catch (error) {
    console.warn('Could not schedule automatic sync:', error);
    syncSetStatus('unknown', 'Auto-push unavailable', 'Browser storage failed. Local database saves are separate; retry sync after freeing storage.');
  }
}

async function syncRunAutoPush() {
  clearTimeout(_syncAutoPushTimer);
  _syncAutoPushTimer = null;
  try {
  if (readOnlyShare || localStorage.getItem(SYNC_AUTO_PUSH_KEY) !== 'true' ||
      localStorage.getItem(SYNC_AUTO_PENDING_KEY) !== 'true' || navigator.onLine === false) return false;
  if (_syncOperationInFlight) return false;
  const cfg = syncGetStoredConfig();
  if (!syncAutoPushIsConfigured(cfg)) {
    localStorage.setItem(SYNC_AUTO_PUSH_KEY, 'false');
    localStorage.removeItem(SYNC_AUTO_PENDING_KEY);
    return false;
  }
  localStorage.removeItem(SYNC_AUTO_PENDING_KEY);
  const pushed = await syncPushToGist({ auto: true });
  if (!pushed) {
    localStorage.setItem(SYNC_AUTO_PENDING_KEY, 'true');
    return false;
  }
  if (localStorage.getItem(SYNC_AUTO_PENDING_KEY) === 'true') syncScheduleAutoPush();
  return true;
  } catch (error) {
    console.warn('Automatic sync failed:', error);
    syncSetStatus('unknown', 'Auto-push unavailable', 'Browser storage failed. Free storage and retry.');
    return false;
  }
}

function syncToggleAutoPush(input) {
  if (!input?.checked) {
    syncSaveSettings(false);
    return;
  }
  if (!syncAutoPushIsConfigured(syncGetConfigFromInputs())) {
    input.checked = false;
    syncSaveSettings(false, false);
    showToast('Auto-push requires a GitHub token, passphrase, and existing Gist ID.', 'error');
    return;
  }
  syncSaveSettings(false);
}

function syncSaveSettings(showSavedToast = true, schedule = true) {
  const applied = [];
  let previous;
  try {
  previous = syncGetStoredConfig();
  const cfg = syncGetConfigFromInputs();
  const previousGistId = localStorage.getItem('assistantSyncGistId') || '';
  const scoped = localStorage.getItem(SYNC_STATE_GIST_KEY) || '';
  const autoPush = cfg.autoPush && syncAutoPushIsConfigured(cfg);
  const values = {
    assistantSyncGistToken: cfg.token || null, assistantSyncGistId: cfg.gistId || null,
    assistantSyncPassphrase: cfg.passphrase || null, [SYNC_STATE_GIST_KEY]: cfg.gistId || null,
    [SYNC_AUTO_PUSH_KEY]: autoPush ? 'true' : 'false'
  };
  if ((scoped && scoped !== cfg.gistId) || (!scoped && previousGistId && previousGistId !== cfg.gistId)) {
    [SYNC_TOMBSTONES_KEY, SYNC_SETTINGS_STATE_KEY, 'assistantSyncSalt', 'assistantSyncLastHash',
      'assistantSyncLastPushAt', 'assistantSyncLastPullAt', SYNC_AUTO_PENDING_KEY].forEach(key => { values[key] = null; });
  }
  if (!autoPush) values[SYNC_AUTO_PENDING_KEY] = null;
  Object.entries(values).sort((a, b) => Number(a[1] === null) - Number(b[1] === null)).forEach(([key, after]) => {
    const before = localStorage.getItem(key);
    if (before === after) return;
    if (after === null) localStorage.removeItem(key);
    else localStorage.setItem(key, after);
    applied.push({ key, before, after });
  });
  cfg.autoPush = autoPush;
  renderSyncSettings();
  if (schedule && autoPush) syncScheduleAutoPush();
  if (showSavedToast) showToast('Sync settings saved.', 'success');
  return cfg;
  } catch (error) {
    applied.reverse().forEach(({ key, before, after }) => {
      try {
        if (localStorage.getItem(key) !== after) return;
        if (before === null) localStorage.removeItem(key);
        else localStorage.setItem(key, before);
      } catch (restoreError) { console.error('Could not restore sync setting:', key, restoreError); }
    });
    if (previous?.gistId) {
      [['setSyncToken', previous.token], ['setSyncGistId', previous.gistId], ['setSyncPassphrase', previous.passphrase]].forEach(([id, value]) => {
        const input = document.getElementById(id);
        if (input) input.value = value;
      });
    }
    syncSetStatus('unknown', 'Settings not saved', 'Browser storage failed. Keep the existing pairing details and retry after freeing storage.');
    if (showSavedToast) showToast('Could not save sync settings. Free storage and retry.', 'error');
    return null;
  }
}

function syncSetStatus(state, message, details) {
  const status = document.getElementById('syncStatus');
  const detailsEl = document.getElementById('syncDetails');
  if (status) {
    status.textContent = message || 'Not configured';
    status.className = 'debug-status-pill ' + (state || 'unknown');
    status.setAttribute('aria-live', 'polite');
  }
  if (detailsEl) detailsEl.textContent = details || '';
}

function setSyncBusy(busy) {
  if (busy) stopVoiceInput();
  document.querySelectorAll('#settingsModal button, #settingsModal input, #settingsModal textarea, #settingsModal select').forEach(control => {
    if (busy) {
      if (!control.hasAttribute('data-sync-was-disabled')) control.dataset.syncWasDisabled = String(control.disabled);
      control.disabled = true;
    } else if (control.hasAttribute('data-sync-was-disabled')) {
      control.disabled = control.dataset.syncWasDisabled === 'true';
      delete control.dataset.syncWasDisabled;
    }
  });
  const panel = document.getElementById('settingsTab-sync');
  if (panel) panel.setAttribute('aria-busy', String(busy));
  const composer = document.querySelector('.input-area');
  if (composer) {
    composer.inert = busy;
    composer.setAttribute('aria-busy', String(busy));
  }
  try { updateSendBtnState(); }
  catch (error) { console.warn('Could not refresh composer state:', error); }
}

function renderSyncSettings() {
  const tokenEl = document.getElementById('setSyncToken');
  const gistEl = document.getElementById('setSyncGistId');
  const passEl = document.getElementById('setSyncPassphrase');
  const autoEl = document.getElementById('setSyncAutoPush');
  if (tokenEl) tokenEl.value = localStorage.getItem('assistantSyncGistToken') || '';
  if (gistEl) gistEl.value = localStorage.getItem('assistantSyncGistId') || '';
  if (passEl) passEl.value = localStorage.getItem('assistantSyncPassphrase') || '';
  if (autoEl) autoEl.checked = localStorage.getItem(SYNC_AUTO_PUSH_KEY) === 'true';
  setSyncBusy(_syncPullInFlight);
  _syncInputsLoaded = true;

  const token = localStorage.getItem('assistantSyncGistToken') || '';
  const gistId = localStorage.getItem('assistantSyncGistId') || '';
  syncUpdateGistScope(gistId, gistId);
  const passphrase = localStorage.getItem('assistantSyncPassphrase') || '';
  const lastPush = Number(localStorage.getItem('assistantSyncLastPushAt') || 0);
  const lastPull = Number(localStorage.getItem('assistantSyncLastPullAt') || 0);
  const lastParts = [];
  if (lastPush) lastParts.push('last push ' + formatRelativeTime(lastPush));
  if (lastPull) lastParts.push('last pull ' + formatRelativeTime(lastPull));

  if (!token || !passphrase) {
    syncSetStatus('unknown', 'Not configured', 'Add a GitHub token and sync passphrase before pushing or pulling.');
  } else if (!gistId) {
    syncSetStatus('checking', 'Ready to create', 'Push now will create a private encrypted Gist.');
  } else {
    syncSetStatus('current', 'Configured', 'Gist ' + gistId + (lastParts.length ? ' | ' + lastParts.join(' | ') : ''));
  }
}

function syncValidateConfig(cfg, requireGist = false) {
  if (!cfg.token) throw new Error('GitHub token is required.');
  if (!cfg.passphrase) throw new Error('Sync passphrase is required.');
  if (requireGist && !cfg.gistId) throw new Error('Gist ID is required. Push once to create a Gist or paste a pairing code.');
}

function syncRequireCrypto() {
  if (!window.crypto || !window.crypto.subtle || !window.crypto.getRandomValues) {
    throw new Error('Encrypted sync requires Web Crypto. Use HTTPS, localhost, or a modern browser.');
  }
}

function syncRandomBytes(length) {
  syncRequireCrypto();
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return bytes;
}

function syncBytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function syncBase64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function syncBytesToBase64Url(bytes) {
  return syncBytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function syncBase64UrlToBytes(text) {
  let normalized = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return syncBase64ToBytes(normalized);
}

function syncEncodePairingPayload(payload) {
  return syncBytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

function syncDecodePairingPayload(text) {
  return JSON.parse(new TextDecoder().decode(syncBase64UrlToBytes(text)));
}

async function syncSha256Hex(value) {
  syncRequireCrypto();
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function syncDeriveKey(passphrase, saltBytes) {
  syncRequireCrypto();
  const material = await window.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: SYNC_KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function syncBuildCryptoContext(passphrase, saltBase64) {
  const salt = saltBase64 ? syncBase64ToBytes(saltBase64) : syncRandomBytes(16);
  const key = await syncDeriveKey(passphrase, salt);
  return { key, salt, saltBase64: syncBytesToBase64(salt) };
}

async function syncEncryptPayloadWithKey(payload, context) {
  const iv = syncRandomBytes(12);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, context.key, encoded);
  return JSON.stringify({
    version: 1,
    alg: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: SYNC_KDF_ITERATIONS,
    salt: context.saltBase64,
    iv: syncBytesToBase64(iv),
    data: syncBytesToBase64(new Uint8Array(encrypted))
  });
}

async function syncDecryptPayload(content, passphrase, keyCache = {}) {
  const envelope = typeof content === 'string' ? JSON.parse(content) : content;
  if (!envelope || envelope.alg !== 'AES-GCM' || !envelope.salt || !envelope.iv || !envelope.data) {
    throw new Error('Invalid encrypted sync file.');
  }
  if (envelope.iterations && envelope.iterations !== SYNC_KDF_ITERATIONS) {
    throw new Error('Unsupported sync encryption settings.');
  }
  const cacheKey = envelope.salt;
  if (!keyCache[cacheKey]) keyCache[cacheKey] = await syncDeriveKey(passphrase, syncBase64ToBytes(envelope.salt));
  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: syncBase64ToBytes(envelope.iv) },
    keyCache[cacheKey],
    syncBase64ToBytes(envelope.data)
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

function syncFormatGistError(response, bodyText) {
  let message = bodyText || response.statusText || 'GitHub request failed';
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed.message) message = parsed.message;
  } catch(e) {}
  if (response.status === 401) return 'GitHub token was rejected.';
  if (response.status === 403) return 'GitHub denied the Gist request. Check token scopes and rate limits.';
  if (response.status === 404) return 'Gist not found or token cannot access it.';
  if (response.status === 422) return 'GitHub rejected the Gist payload: ' + message;
  return 'GitHub error ' + response.status + ': ' + message;
}

async function fetchGistResponse(url, options = {}, token = '') {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {})
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const error = new Error(syncFormatGistError(response, await response.text()));
    error.status = response.status;
    throw error;
  }
  return {
    data: response.status === 204 ? null : await response.json(),
    etag: response.headers.get('etag') || ''
  };
}

async function fetchGist(url, options = {}, token = '') {
  return (await fetchGistResponse(url, options, token)).data;
}

async function fetchGistRawText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(syncFormatGistError(response, await response.text()));
  return response.text();
}

async function syncGetGistFileContent(gist, filename) {
  const file = gist?.files?.[filename];
  if (!file) throw new Error('Missing Gist file: ' + filename);
  if (!file.truncated && typeof file.content === 'string') return file.content;
  if (file.raw_url) return fetchGistRawText(file.raw_url);
  throw new Error('Gist file is truncated and has no raw URL: ' + filename);
}

async function syncReadManifest(gist, token) {
  if (gist?.truncated) throw new Error('GitHub truncated the file list. Keep this Gist as a backup and start a new sync Gist; no data was changed.');
  const hasUpdates = Object.keys(gist?.files || {}).some(name => /^synapse-update-[A-Za-z0-9_-]+\.json\.enc$/.test(name));
  const hasLegacyChats = Object.keys(gist?.files || {}).some(name => /^conv_.+\.json\.enc$/.test(name));
  try {
    const manifest = JSON.parse(await syncGetGistFileContent(gist, 'manifest.json', token));
    if (manifest?.app === 'Synapse' && ['gist-sync-v1', 'gist-sync-v2'].includes(manifest.schema)) return manifest;
  } catch (error) { if (!hasUpdates && !hasLegacyChats) throw error; }
  if (hasLegacyChats) return { app: 'Synapse', schema: 'gist-sync-v1', version: 1 };
  if (hasUpdates) return { app: 'Synapse', schema: 'gist-sync-v2', version: 2 };
  throw new Error('This Gist does not look like a Synapse sync Gist.');
}

function syncConversationFileName(id) {
  return 'conv_' + syncBytesToBase64Url(new TextEncoder().encode(String(id || 'unknown'))) + '.json.enc';
}

function syncCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function syncNormalizeConversation(conv) {
  return normalizeConversationRecord(conv && typeof conv === 'object' ? syncCloneJson(conv) : {});
}

function syncNormalizeTombstones(value) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = { conversations: {}, projects: {}, memories: {}, conversationVersions: {}, conversationRoots: {} };
  ['conversations', 'projects', 'memories'].forEach(category => {
    const entries = source[category] && typeof source[category] === 'object' ? source[category] : {};
    Object.entries(entries).forEach(([id, deletedAt]) => {
      const timestamp = Number(deletedAt);
      if (id && Number.isFinite(timestamp) && timestamp > 0) normalized[category][id] = timestamp;
    });
  });
  Object.entries(source.conversationVersions && typeof source.conversationVersions === 'object' ? source.conversationVersions : {}).forEach(([id, value]) => {
    const version = normalizeConversationVersion(value);
    if (Object.hasOwn(normalized.conversations, id) && Object.keys(version).length) normalized.conversationVersions[id] = version;
  });
  Object.entries(source.conversationRoots || {}).forEach(([id, root]) => {
    if (Object.hasOwn(normalized.conversations, id) && typeof root === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(root)) normalized.conversationRoots[id] = root;
  });
  return normalized;
}

function syncLoadTombstones() {
  try { return syncNormalizeTombstones(JSON.parse(localStorage.getItem(SYNC_TOMBSTONES_KEY) || '{}')); }
  catch (e) { return syncNormalizeTombstones(); }
}

function syncSaveTombstones(tombstones) {
  localStorage.setItem(SYNC_TOMBSTONES_KEY, JSON.stringify(syncNormalizeTombstones(tombstones)));
}

function syncRecordTombstones(category, ids, deletedAt = Date.now()) {
  if (!['conversations', 'projects', 'memories'].includes(category)) return;
  const tombstones = syncLoadTombstones();
  const temporaryIds = category === 'conversations'
    ? new Set(conversations.filter(isTemporaryConversation).map(conv => conv.id))
    : new Set();
  (ids || []).filter(id => id && !temporaryIds.has(id)).forEach(id => {
    const record = category === 'conversations' ? conversations.find(conv => conv.id === id) : null;
    tombstones[category][id] = Math.max(Number(tombstones[category][id]) || 0, deletedAt, Number(record?.updatedAt) || 0);
    if (record) {
      const seen = { ...tombstones.conversationVersions[id] };
      Object.entries(normalizeConversationVersion(record.syncVersion)).forEach(([writer, count]) => { seen[writer] = Math.max(Number(seen[writer]) || 0, count); });
      tombstones.conversationVersions[id] = seen;
      tombstones.conversationRoots[id] = record.conflictOf || id;
    }
  });
  syncSaveTombstones(tombstones);
}

function syncRemoveTombstones(category, ids) {
  const tombstones = syncLoadTombstones();
  (ids || []).forEach(id => {
    delete tombstones[category]?.[id];
    if (category === 'conversations') delete tombstones.conversationVersions[id];
    if (category === 'conversations') delete tombstones.conversationRoots[id];
  });
  syncSaveTombstones(tombstones);
}

function syncMergeTombstones(localValue, remoteValue) {
  const local = syncNormalizeTombstones(localValue);
  const remote = syncNormalizeTombstones(remoteValue);
  ['conversations', 'projects', 'memories'].forEach(category => {
    Object.entries(remote[category]).forEach(([id, deletedAt]) => {
      local[category][id] = Math.max(Number(local[category][id]) || 0, deletedAt);
    });
  });
  Object.entries(remote.conversationVersions).forEach(([id, version]) => {
    const merged = { ...local.conversationVersions[id] };
    Object.entries(version).forEach(([writer, count]) => { merged[writer] = Math.max(Number(merged[writer]) || 0, count); });
    local.conversationVersions[id] = merged;
  });
  Object.assign(local.conversationRoots, remote.conversationRoots);
  return local;
}

function syncFilterDeletedRecords(records, tombstones, timestampKey) {
  return (records || []).filter(record => {
    const deletedAt = Number(tombstones?.[record?.id]) || 0;
    return !deletedAt || Number(record?.[timestampKey]) > deletedAt;
  });
}

function syncScrubProfileSecrets(profile) {
  return sanitizeProfileRecord(profile);
}

function syncPreserveLocalProfileSecrets(remoteProfiles) {
  const localById = new Map(loadProfiles().map(profile => [profile.id, profile]));
  return remoteProfiles.map(profile => {
    const cleaned = syncScrubProfileSecrets(profile);
    const local = localById.get(cleaned.id);
    if (!local?.settings) return cleaned;
    cleaned.settings = cleaned.settings && typeof cleaned.settings === 'object' ? cleaned.settings : {};
    SYNC_PROFILE_SECRET_KEYS.forEach(key => {
      if (!cleaned.settings[key] && local.settings[key]) cleaned.settings[key] = local.settings[key];
    });
    return cleaned;
  });
}

function syncCurrentSettingsValues() {
  const settings = {};
  SYNC_SETTINGS_KEYS.forEach(key => {
    const value = localStorage.getItem(key);
    if (value === null) { settings[key] = null; return; }
    if (key === 'assistantProfiles') {
      try {
        const profiles = JSON.parse(value);
        settings[key] = JSON.stringify(Array.isArray(profiles) ? profiles.map(syncScrubProfileSecrets) : []);
      } catch(e) {
        settings[key] = '[]';
      }
      return;
    }
    settings[key] = value;
  });
  return settings;
}

function syncReadSettingsState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SYNC_SETTINGS_STATE_KEY) || 'null');
    if (parsed?.settings && parsed?.revisions) return parsed;
  } catch (e) {}
  return { settings: {}, revisions: {} };
}

function syncSaveSettingsState(state) {
  localStorage.setItem(SYNC_SETTINGS_STATE_KEY, JSON.stringify({ settings: state.settings || {}, revisions: state.revisions || {} }));
}

function syncCollectSettingsState(markInitial = true, persist = true) {
  const previous = syncReadSettingsState();
  const current = syncCurrentSettingsValues();
  const settings = {};
  const revisions = {};
  const now = Date.now();
  SYNC_SETTINGS_KEYS.forEach(key => {
    const hadPrevious = Object.prototype.hasOwnProperty.call(previous.settings, key);
    const include = current[key] !== null || hadPrevious;
    if (!include) return;
    settings[key] = current[key];
    if ((hadPrevious && previous.settings[key] !== current[key]) || (!hadPrevious && markInitial && current[key] !== null)) revisions[key] = now;
    else revisions[key] = Number(previous.revisions[key]) || 0;
  });
  const state = { settings, revisions };
  if (persist) syncSaveSettingsState(state);
  return state;
}

function syncNormalizeSettingsPayload(payload) {
  const settings = payload?.settings && typeof payload.settings === 'object' ? payload.settings : {};
  const revisions = payload?.revisions && typeof payload.revisions === 'object' ? payload.revisions : {};
  const legacyRevision = Date.parse(payload?.exportedAt || '') || 0;
  const normalized = { settings: {}, revisions: {} };
  SYNC_SETTINGS_KEYS.forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) return;
    const value = normalizeStructuredSettingValue(key, settings[key]);
    if (value === undefined) return;
    normalized.settings[key] = value;
    normalized.revisions[key] = Number(revisions[key]) || legacyRevision;
  });
  return normalized;
}

function syncMergeSettingsStates(localValue, remoteValue) {
  const local = syncNormalizeSettingsPayload(localValue);
  const remote = syncNormalizeSettingsPayload(remoteValue);
  const merged = { settings: {}, revisions: {} };
  SYNC_SETTINGS_KEYS.forEach(key => {
    const hasLocal = Object.prototype.hasOwnProperty.call(local.settings, key);
    const hasRemote = Object.prototype.hasOwnProperty.call(remote.settings, key);
    if (!hasLocal && !hasRemote) return;
    const localRevision = Number(local.revisions[key]) || 0;
    const remoteRevision = Number(remote.revisions[key]) || 0;
    const useRemote = hasRemote && (!hasLocal || remoteRevision > localRevision ||
      (remoteRevision === localRevision && String(remote.settings[key]) > String(local.settings[key])));
    merged.settings[key] = useRemote ? remote.settings[key] : local.settings[key];
    merged.revisions[key] = Math.max(localRevision, remoteRevision);
  });
  return merged;
}

function syncRefreshAppliedSettings() {
  applyTheme(localStorage.getItem('assistantTheme') || 'dark');
  loadCustomFont(localStorage.getItem('assistantFont') || '');
  applyMsgOverrides();
  renderPromptEntries();
  loadPresets();
  renderProfileSelect();
  renderProfileSummary();
  renderConnectionChip();
}

function syncApplySettings(state) {
  if (!state?.settings || typeof state.settings !== 'object') return;
  SYNC_SETTINGS_KEYS.forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(state.settings, key)) return;
    let value = state.settings[key];
    if (key === 'assistantProfiles' && value !== null && value !== undefined) {
      try {
        const profiles = JSON.parse(value || '[]');
        value = JSON.stringify(Array.isArray(profiles) ? syncPreserveLocalProfileSecrets(profiles) : []);
      } catch(e) {
        value = '[]';
      }
    }
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  });
  syncSaveSettingsState(state);
  syncRefreshAppliedSettings();
}

async function syncReadRemoteConversations(gist, manifest, passphrase, keyCache = {}) {
  const remoteConversations = [];
  const entries = Array.isArray(manifest.files?.conversations) ? manifest.files.conversations : [];
  const files = new Set(entries.map(entry => entry?.file).filter(file => typeof file === 'string' && file));
  Object.keys(gist?.files || {}).filter(name => /^conv_.+\.json\.enc$/.test(name)).forEach(name => files.add(name));
  for (const filename of files) {
    const payload = await syncDecryptPayload(await syncGetGistFileContent(gist, filename), passphrase, keyCache);
    if (payload?.conversation) {
      // Old clients can carry, but do not advance, newer persistence metadata.
      delete payload.conversation.syncVersion;
      remoteConversations.push(payload.conversation);
    }
  }
  return remoteConversations;
}

async function syncReadRemoteData(gist, manifest, passphrase) {
  const archiveBytes = Object.values(gist?.files || {}).reduce((sum, file) => sum + (Number(file?.size) || new TextEncoder().encode(file?.content || '').byteLength), 0);
  if (archiveBytes > 64 * 1024 * 1024) throw new Error('This sync archive exceeds the 64 MiB read limit. Keep it and its passphrase for recovery; no local data was changed.');
  const keyCache = {};
  const decryptFile = async filename => syncDecryptPayload(
    await syncGetGistFileContent(gist, filename), passphrase, keyCache);
  const existingFile = (pointer, fallback) => pointer || (gist?.files?.[fallback] ? fallback : '');
  const legacy = manifest.schema === 'gist-sync-v1';
  const settingsFile = legacy && existingFile(manifest.files?.settings, 'settings.json.enc');
  const memoriesFile = legacy && existingFile(manifest.files?.memories, 'memories.json.enc');
  const projectsFile = legacy && existingFile(manifest.files?.projects, 'projects.json.enc');
  const tombstonesFile = legacy && existingFile(manifest.files?.tombstones, 'tombstones.json.enc');
  const settingsPayload = settingsFile ? await decryptFile(settingsFile) : {};
  const memoriesPayload = memoriesFile ? await decryptFile(memoriesFile) : {};
  const projectsPayload = projectsFile ? await decryptFile(projectsFile) : {};
  const tombstonesPayload = tombstonesFile ? await decryptFile(tombstonesFile) : {};
  const remote = {
    conversations: await syncReadRemoteConversations(gist, manifest, passphrase, keyCache),
    settingsState: syncNormalizeSettingsPayload(settingsPayload),
    memories: Array.isArray(memoriesPayload.memories) ? memoriesPayload.memories : [],
    projects: normalizeProjectList(projectsPayload.projects),
    tombstones: syncNormalizeTombstones(tombstonesPayload.tombstones)
  };
  const updates = Object.keys(gist?.files || {}).filter(name => /^synapse-update-[A-Za-z0-9_-]+\.json\.enc$/.test(name)).sort();
  for (const filename of updates) {
    const update = await decryptFile(filename);
    if (update?.app !== 'Synapse' || update.schema !== 'gist-sync-update-v2' || !Array.isArray(update.conversations) ||
        !Array.isArray(update.memories) || !Array.isArray(update.projects)) throw new Error('Invalid sync update: ' + filename);
    remote.tombstones = syncMergeTombstones(remote.tombstones, update.tombstones);
    remote.settingsState = syncMergeSettingsStates(remote.settingsState, update.settingsState);
    remote.conversations.push(...update.conversations);
    remote.memories = syncMergeMemoryLists(remote.memories, update.memories);
    remote.projects = syncMergeProjectLists(remote.projects, update.projects);
  }
  remote.conversations = (await syncMergeConversationLists([], remote.conversations, remote.tombstones.conversations, remote.tombstones.conversationVersions, remote.tombstones.conversationRoots)).conversations;
  return remote;
}

// Each push owns a new file. GitHub leaves omitted files unchanged; no manifest race can hide an update.
async function syncBuildGistFiles(passphrase, existingManifest = null, merged = null) {
  const existingSalt = existingManifest?.salt || localStorage.getItem('assistantSyncSalt') || '';
  const context = await syncBuildCryptoContext(passphrase, existingSalt || null);
  const now = Date.now();
  const tombstones = syncNormalizeTombstones(merged?.tombstones || syncLoadTombstones());
  const settingsState = syncNormalizeSettingsPayload(merged?.settingsState || syncCollectSettingsState());
  const payload = {
    app: 'Synapse', schema: 'gist-sync-update-v2', version: 2, updatedAt: now,
    tombstones, settingsState,
    conversations: (await syncMergeConversationLists([], merged?.conversations || getPersistentConversations(), tombstones.conversations, tombstones.conversationVersions, tombstones.conversationRoots)).conversations,
    memories: syncFilterDeletedRecords(merged?.memories || await loadMemories(), tombstones.memories, 'createdAt'),
    projects: syncFilterDeletedRecords(normalizeProjectList(merged?.projects || projects), tombstones.projects, 'updatedAt')
  };
  const filename = 'synapse-update-' + syncBytesToBase64Url(syncRandomBytes(24)) + '.json.enc';
  const content = await syncEncryptPayloadWithKey(payload, context);
  if (new TextEncoder().encode(content).byteLength > 8 * 1024 * 1024) throw new Error('This encrypted snapshot exceeds the 8 MiB sync limit. Export a local backup and reduce attachments before retrying.');
  const files = { [filename]: { content } };
  const manifest = {
    version: 2, app: 'Synapse', schema: 'gist-sync-v2', salt: context.saltBase64,
    kdf: { name: 'PBKDF2-SHA256', iterations: SYNC_KDF_ITERATIONS }
  };
  if (!existingManifest) files['manifest.json'] = { content: JSON.stringify(manifest) };
  return { files, manifest, filename, conversationCount: payload.conversations.length, hash: await syncSha256Hex({ ...payload, updatedAt: 0 }) };
}

async function syncPushToGist(options = {}) {
  const auto = options.auto === true;
  if (readOnlyShare) return false;
  if (localDataOperationsInFlight > 0) {
    if (!auto) showToast('Wait for local data changes to finish.', 'info');
    return false;
  }
  if (pendingAttachmentReads > 0) {
    if (!auto) showToast('Wait for attachments to finish reading.', 'info');
    return false;
  }
  if (_syncOperationInFlight) {
    if (!auto) showToast('A sync operation is already in progress.', 'info');
    return false;
  }
  _syncOperationInFlight = true;
  let pendingAtStart = false;
  let cfg;
  let succeeded = false;
  let uploaded = false;
  try {
    if (!db) throw new Error('Encrypted sync needs a working browser database. Export a local backup and reload before syncing.');
    flushSettingsAutosaves();
    pendingAtStart = localStorage.getItem(SYNC_AUTO_PENDING_KEY) === 'true';
    if (auto || pendingAtStart) localStorage.removeItem(SYNC_AUTO_PENDING_KEY);
    cfg = auto ? syncGetStoredConfig() : syncSaveSettings(false, false);
    if (!cfg) throw new Error('Sync settings could not be saved. Free storage and retry.');
    syncValidateConfig(cfg, auto);
    persistDraftFromUI();
    if (_projectAutosaveTimer && !await flushProjectAutosave()) throw new Error('Project changes could not be saved. Retry before pushing.');
    if (!await saveProjects(true)) throw new Error('Project changes could not be saved. Retry before pushing.');
    await saveConversationImmediately();
    await loadMemories();
    syncSetStatus('checking', 'Pushing...', 'Encrypting local data and writing Gist files.');
    const settingsState = syncCollectSettingsState();
    const local = await syncCapturePullSnapshot();
    local.settingsState = settingsState;
    let built;
    if (cfg.gistId) {
      const url = SYNC_GIST_API_URL + '/' + encodeURIComponent(cfg.gistId);
      const gist = await fetchGist(url, { cache: 'no-store' }, cfg.token);
      const existingManifest = await syncReadManifest(gist, cfg.token);
      // ponytail: bounded append-only snapshots. Rotate manually, never delete another device's updates.
      if (Object.keys(gist.files || {}).length >= 250) throw new Error('This sync Gist has reached the 250-file safety limit. Pull on all devices and export a backup, then clear the Gist ID to start a new one.');
      await syncReadRemoteData(gist, existingManifest, cfg.passphrase); // Verify the key, without applying remote data locally.
      built = await syncBuildGistFiles(cfg.passphrase, existingManifest, local);
      const size = Object.values(gist.files || {}).reduce((sum, file) => sum + (Number(file?.size) || new TextEncoder().encode(file?.content || '').byteLength), 0);
      if (size + new TextEncoder().encode(built.files[built.filename].content).byteLength > 32 * 1024 * 1024) throw new Error('This sync archive would exceed 32 MiB. Pull on all devices and export a backup, then start a new Gist. The old Gist is unchanged.');
      if (gist.files?.[built.filename]) throw new Error('Sync update name already exists. Retry; no remote file was changed.');
      await fetchGistResponse(url, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: built.files })
      }, cfg.token);
      uploaded = true;
      const verified = await fetchGist(url, { cache: 'no-store' }, cfg.token);
      if (await syncGetGistFileContent(verified, built.filename) !== built.files[built.filename].content) throw new Error('The uploaded update could not be verified. Retrying will not overwrite it.');
    } else {
      built = await syncBuildGistFiles(cfg.passphrase, null, local);
      const gist = await fetchGist(SYNC_GIST_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Synapse encrypted sync data', public: false, files: built.files })
      }, cfg.token);
      cfg.gistId = gist.id;
      uploaded = true;
      const gistEl = document.getElementById('setSyncGistId');
      if (gistEl) gistEl.value = cfg.gistId;
      localStorage.setItem('assistantSyncGistId', cfg.gistId);
      localStorage.setItem(SYNC_STATE_GIST_KEY, cfg.gistId);
    }

    localStorage.setItem('assistantSyncSalt', built.manifest.salt);
    localStorage.setItem('assistantSyncLastPushAt', String(Date.now()));
    localStorage.setItem('assistantSyncLastHash', built.hash);
    renderSyncSettings();
    syncSetStatus('current', 'Pushed', 'Saved a separate encrypted update with ' + built.conversationCount + ' conversations. Remote changes are applied only by Pull now.');
    succeeded = true;
    if (!auto) showToast('Sync push complete.', 'success');
    return true;
  } catch (err) {
    console.error('Sync push failed:', err);
    const message = err.name === 'OperationError' ? 'Could not decrypt the existing sync Gist. Check the passphrase.' :
      (uploaded ? 'An update was uploaded to Gist ' + cfg.gistId + ', but confirmation or local storage failed. Keep that Gist ID. ' : '') + (err.message || 'Unable to push sync data.');
    syncSetStatus('unknown', 'Push failed', message);
    if (!auto) showToast('Sync push failed: ' + message, 'error', 6000);
    return false;
  } finally {
    _syncOperationInFlight = false;
    try {
      if (!succeeded && syncAutoPushIsConfigured(cfg) && (auto || pendingAtStart)) localStorage.setItem(SYNC_AUTO_PENDING_KEY, 'true');
      if (succeeded && localStorage.getItem(SYNC_AUTO_PUSH_KEY) === 'true' &&
          localStorage.getItem(SYNC_AUTO_PENDING_KEY) === 'true') syncScheduleAutoPush();
    } catch (error) { console.warn('Could not save automatic sync state:', error); }
  }
}

async function syncMergeConversationLists(localList, remoteList, tombstones = {}, deletionVersions = {}, deletionRoots = {}) {
  const merged = new Map();
  const inputs = [...(localList || []), ...(remoteList || [])];
  const roots = new Map([...inputs.filter(record => record && typeof record === 'object').map(record => [record.id, record.conflictOf || record.id]), ...Object.entries(deletionRoots)]);
  let added = 0;
  let updated = 0;
  let tied = 0;
  const conflicts = [];
  for (const [index, raw] of inputs.entries()) {
    if (!raw || typeof raw !== 'object' || isTemporaryConversation(raw)) continue;
    let record;
    try { record = syncNormalizeConversation(raw); }
    catch (error) { console.warn('Unreadable sync chat skipped:', raw.id, error); continue; }
    const conflictId = await conversationConflictId(record);
    if (!Object.keys(record.syncVersion || {}).length) record.syncVersion = { ['legacy:' + conflictId]: 1 };
    const root = record.conflictOf || record.id;
    const deletions = Object.keys(tombstones).filter(id => id === record.id || id === root || roots.get(id) === root);
    if (deletions.some(id => {
      if (!Object.hasOwn(deletionVersions, id)) return false;
      const order = compareConversationVersions({ syncVersion: deletionVersions[id] }, record);
      return order === 0 || order === 1;
    })) continue;
    const previous = merged.get(record.id);
    const size = merged.size;
    const saved = reconcileConversationRecord(merged, record, conflictId);
    if (index < (localList || []).length) continue;
    if (merged.size > size) added++;
    else if (previous && conversationContent(previous) !== conversationContent(saved)) updated++;
    if (saved.id !== record.id && merged.size > size) { conflicts.push(saved.id); tied++; }
  }
  const visible = new Map();
  for (const record of merged.values()) {
    const deletedAt = Math.max(Number(tombstones[record.id]) || 0, Number(tombstones[record.conflictOf]) || 0);
    if (!deletedAt || Number(record.updatedAt) > deletedAt) { visible.set(record.id, record); continue; }
    const seen = Object.hasOwn(deletionVersions, record.id) ? deletionVersions[record.id] : null;
    // Unknown deletion ancestry is recovered, not guessed from the clock.
    const order = seen ? compareConversationVersions({ syncVersion: seen }, record) : null;
    if (order === 0 || order === 1) continue;
    const copy = makeConversationConflict(record, await conversationConflictId(record));
    if (Number(tombstones[copy.id]) >= Number(copy.updatedAt)) continue;
    visible.set(copy.id, copy);
    conflicts.push(copy.id);
  }
  return { conversations: [...visible.values()], added, updated, tied, conflicts };
}

function syncMergeProjectLists(localList, remoteList, tombstones = {}) {
  const byId = new Map();
  normalizeProjectList(localList).forEach(p => byId.set(p.id, p));
  normalizeProjectList(remoteList).forEach(p => {
    const existing = byId.get(p.id);
    const updatedDiff = (Number(p.updatedAt) || 0) - (Number(existing?.updatedAt) || 0);
    if (!existing || updatedDiff > 0 || (updatedDiff === 0 && JSON.stringify(p) > JSON.stringify(existing))) {
      byId.set(p.id, p);
    }
  });
  return syncFilterDeletedRecords(Array.from(byId.values()), tombstones, 'updatedAt')
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

function syncMergeMemoryLists(localList, remoteList, tombstones = {}) {
  const localNormalized = normalizeMemoryList(localList || []).memories;
  const remoteNormalized = normalizeMemoryList(remoteList || []).memories;
  const byId = new Map();
  localNormalized.forEach(memory => byId.set(memory.id, memory));
  remoteNormalized.forEach(memory => {
    const existing = byId.get(memory.id);
    if (!existing || Number(memory.createdAt) >= Number(existing.createdAt)) byId.set(memory.id, memory);
  });
  return syncFilterDeletedRecords(Array.from(byId.values()), tombstones, 'createdAt')
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

async function syncPersistPullData({ conversations: nextConversations, memories: nextMemories, projects: nextProjects, persistentActiveId, settingsValues = {} }, snapshot) {
  if (!db || !snapshot?.database) throw new Error('Import and pull need a working browser database. Free storage and reload, then retry.');
  const conversationRecords = (nextConversations || []).map(syncNormalizeConversation);
  for (const record of conversationRecords) {
    if (!Object.keys(record.syncVersion || {}).length) record.syncVersion = { ['legacy:' + await conversationConflictId(record)]: 1 };
  }
  const memoryRecords = normalizeMemoryList(nextMemories || []).memories;
  const projectRecords = normalizeProjectList(nextProjects || []);
  const storedActiveId = String(persistentActiveId || '');
  const values = { ...settingsValues, assistantActiveConvId: storedActiveId };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['conversations', 'memories', 'meta'], 'readwrite');
    const conversationStore = tx.objectStore('conversations');
    const memoryStore = tx.objectStore('memories');
    const metaStore = tx.objectStore('meta');
    const requests = {
      conversations: conversationStore.getAll(), memories: memoryStore.getAll(),
      projects: metaStore.get('projects'), tombstones: metaStore.get('syncTombstones')
    };
    const appliedSettings = [];
    let pending = Object.keys(requests).length;
    let failure;
    const write = () => {
      if (--pending) return;
      try {
        const current = {
          conversations: requests.conversations.result, memories: requests.memories.result,
          projects: requests.projects.result || null, tombstones: requests.tombstones.result || null
        };
        if (serializeConversation(current) !== serializeConversation(snapshot.database) ||
            sending || streaming || queueingFollowUp || pendingAttachmentReads > 0 ||
            serializeConversation(getPersistentConversations()) !== snapshot.localConversations ||
            serializeConversation(projects) !== snapshot.localProjects ||
            Object.entries(snapshot.settingsValues).some(([key, value]) => localStorage.getItem(key) !== value)) {
          throw new Error('Local data changed while this operation was being prepared. Nothing was applied; retry to include those changes.');
        }
        // localStorage is not transactional. Restore only values still owned by this attempt if IDB aborts.
        Object.entries(values).forEach(([key, value]) => {
          const before = localStorage.getItem(key);
          const after = value == null ? null : String(value);
          if (before === after) return;
          if (after === null) localStorage.removeItem(key);
          else localStorage.setItem(key, after);
          appliedSettings.push({ key, before, after });
        });
        const replace = (store, before, records) => {
          const ids = new Set(records.map(record => record.id));
          before.forEach(record => { if (!ids.has(record.id)) store.delete(record.id); });
          records.forEach(record => store.put(record));
        };
        replace(conversationStore, current.conversations, conversationRecords);
        replace(memoryStore, current.memories, memoryRecords);
        metaStore.put({ key: 'projects', value: projectRecords });
        metaStore.put({ key: 'activeConvId', value: storedActiveId });
        if (Object.hasOwn(values, SYNC_TOMBSTONES_KEY)) metaStore.put({ key: 'syncTombstones', value: syncNormalizeTombstones(JSON.parse(values[SYNC_TOMBSTONES_KEY] || '{}')) });
      } catch (error) { failure = error; tx.abort(); }
    };
    Object.values(requests).forEach(request => { request.onsuccess = write; });
    tx.oncomplete = () => {
      broadcastPersistenceChange();
      resolve({ conversations: conversationRecords, memories: memoryRecords, projects: projectRecords });
    };
    tx.onabort = () => {
      const unrestored = [];
      appliedSettings.reverse().forEach(({ key, before, after }) => {
        try {
          if (localStorage.getItem(key) !== after) return;
          if (before === null) localStorage.removeItem(key);
          else localStorage.setItem(key, before);
        } catch (error) { unrestored.push(key); }
      });
      const error = failure || tx.error || new Error('The data transaction was aborted.');
      reject(unrestored.length ? new Error(error.message + ' Some settings could not be restored. Free storage before retrying: ' + unrestored.join(', ')) : error);
    };
    tx.onerror = () => { failure = failure || tx.error; };
  });
}

async function syncCapturePullSnapshot() {
  if (!db) throw new Error('Import and pull need a working browser database. Free storage and reload, then retry.');
  const localConversations = serializeConversation(getPersistentConversations());
  const localProjects = serializeConversation(projects);
  const settingsValues = {};
  new Set([...SYNC_SETTINGS_KEYS, ...EXPORT_SETTING_ALLOWLIST, SYNC_SETTINGS_STATE_KEY, SYNC_TOMBSTONES_KEY,
    SYNC_AUTO_PENDING_KEY, 'assistantSyncSalt', 'assistantActiveConvId', 'assistantSyncLastPullAt',
    'assistantConversations', 'assistantMemories', 'assistantProjects']).forEach(key => { settingsValues[key] = localStorage.getItem(key); });
  const database = await new Promise((resolve, reject) => {
    const tx = db.transaction(['conversations', 'memories', 'meta'], 'readonly');
    const requests = {
      conversations: tx.objectStore('conversations').getAll(), memories: tx.objectStore('memories').getAll(),
      projects: tx.objectStore('meta').get('projects'), tombstones: tx.objectStore('meta').get('syncTombstones')
    };
    tx.oncomplete = () => resolve(Object.fromEntries(Object.entries(requests).map(([key, request]) => [key, request.result || null])));
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not read the local data snapshot.'));
  });
  return {
    database, settingsValues,
    localConversations, localProjects,
    tombstones: syncMergeTombstones(database.tombstones?.value, syncLoadTombstones()),
    memories: normalizeMemoryList(database.memories).memories,
    projects: normalizeProjectList(database.projects?.value),
    conversations: database.conversations.map(syncNormalizeConversation),
    activeConvId,
    persistentActiveId: getPersistentActiveConvId()
  };
}

async function syncPullFromGist() {
  if (readOnlyShare) return false;
  if (sending || streaming || queueingFollowUp) {
    showToast('Stop the current response before pulling sync data.', 'info');
    return false;
  }
  if (pendingAttachmentReads > 0) {
    showToast('Wait for attachments to finish reading.', 'info');
    return false;
  }
  if (localDataOperationsInFlight > 0) {
    showToast('Wait for local data changes to finish.', 'info');
    return false;
  }
  if (_syncOperationInFlight) {
    showToast('A sync operation is already in progress.', 'info');
    return false;
  }
  _syncOperationInFlight = true;
  _syncPullInFlight = true;
  const previousActiveConvId = activeConvId;
  let committed = false;
  try {
    if (!db) throw new Error('Encrypted sync needs a working browser database. Export a local backup and reload before syncing.');
    setSyncBusy(true);
    flushSettingsAutosaves();
    const cfg = syncSaveSettings(false, false);
    if (!cfg) throw new Error('Sync settings could not be saved. Free storage and retry.');
    syncValidateConfig(cfg, true);
    persistDraftFromUI();
    if (_projectAutosaveTimer && !await flushProjectAutosave()) throw new Error('Project changes could not be saved. Retry before pulling.');
    if (!await saveProjects(true)) throw new Error('Project changes could not be saved. Retry before pulling.');
    await saveConversationImmediately();
    await loadMemories();
    syncSetStatus('checking', 'Pulling...', 'Fetching and decrypting sync files.');
    const gist = await fetchGist(SYNC_GIST_API_URL + '/' + encodeURIComponent(cfg.gistId), { cache: 'no-store' }, cfg.token);
    const manifest = await syncReadManifest(gist, cfg.token);
    const remote = await syncReadRemoteData(gist, manifest, cfg.passphrase);
    await saveConversationImmediately();
    const snapshot = await syncCapturePullSnapshot();
    const remoteTombstones = syncNormalizeTombstones(remote.tombstones);
    const incomingDeletionCount = (records, category, timestampKey) => records.filter(record => {
      const remoteDeletedAt = Number(remoteTombstones[category]?.[record.id]) || 0;
      const localDeletedAt = Number(snapshot.tombstones[category]?.[record.id]) || 0;
      return remoteDeletedAt > localDeletedAt && remoteDeletedAt >= Number(record[timestampKey] || 0);
    }).length;
    const deletionCounts = {
      conversations: incomingDeletionCount(snapshot.conversations, 'conversations', 'updatedAt'),
      projects: incomingDeletionCount(snapshot.projects, 'projects', 'updatedAt'),
      memories: incomingDeletionCount(snapshot.memories, 'memories', 'createdAt')
    };
    const totalDeletions = Object.values(deletionCounts).reduce((sum, count) => sum + count, 0);
    if (totalDeletions) {
      const detail = Object.entries(deletionCounts).filter(([, count]) => count).map(([name, count]) => count + ' ' + name).join(', ');
      if (!confirm('Remote sync will remove ' + detail + ' from this browser. Continue?')) {
        syncSetStatus('current', 'Pull cancelled', 'No local data was changed.');
        return false;
      }
      for (const record of snapshot.conversations) {
        const deletedAt = Number(remoteTombstones.conversations[record.id]) || 0;
        if (!remoteTombstones.conversationVersions[record.id] && deletedAt > (Number(snapshot.tombstones.conversations[record.id]) || 0) && deletedAt >= Number(record.updatedAt)) {
          remoteTombstones.conversationVersions[record.id] = { ...record.syncVersion, ['legacy:' + await conversationConflictId(record)]: 1 };
        }
      }
    }
    if (sending || streaming || queueingFollowUp) throw new Error('Stop the current response before applying pulled sync data.');
    if (localDataOperationsInFlight > 0) throw new Error('Wait for local data changes to finish before applying pulled sync data.');

    const liveTombstones = syncMergeTombstones(snapshot.tombstones, remoteTombstones);
    const liveSettingsState = syncMergeSettingsStates(syncCollectSettingsState(false, false), remote.settingsState);
    const liveMemories = syncMergeMemoryLists(snapshot.memories, remote.memories, liveTombstones.memories);
    const liveProjects = syncMergeProjectLists(snapshot.projects, remote.projects, liveTombstones.projects);
    const liveMerged = await syncMergeConversationLists(snapshot.conversations, remote.conversations, liveTombstones.conversations, liveTombstones.conversationVersions, liveTombstones.conversationRoots);
    const temporaryActive = conversations.find(conv => conv.id === snapshot.activeConvId && isTemporaryConversation(conv));
    const nextActiveId = temporaryActive?.id ||
      (liveMerged.conversations.some(conv => conv.id === snapshot.activeConvId) ? snapshot.activeConvId : (liveMerged.conversations[0]?.id || null));
    const nextPersistentActiveId = liveMerged.conversations.some(conv => conv.id === snapshot.persistentActiveId)
      ? snapshot.persistentActiveId
      : (liveMerged.conversations[0]?.id || '');

    const settingsValues = {
      ...liveSettingsState.settings,
      [SYNC_SETTINGS_STATE_KEY]: JSON.stringify(liveSettingsState),
      [SYNC_TOMBSTONES_KEY]: JSON.stringify(liveTombstones),
      assistantSyncLastPullAt: String(Date.now())
    };
    if (manifest.salt) settingsValues.assistantSyncSalt = manifest.salt;
    const saved = await syncPersistPullData({
      conversations: liveMerged.conversations, memories: liveMemories, projects: liveProjects,
      persistentActiveId: nextPersistentActiveId, settingsValues
    }, snapshot);
    committed = true;
    projects = saved.projects;
    projectBaseline = new Map(projects.map(project => [project.id, serializeConversation(project)]));
    armedFollowUpConversationIds.clear();
    replacePersistentConversations(saved.conversations, true);
    activeConvId = conversations.some(conv => conv.id === nextActiveId) ? nextActiveId : (conversations[0]?.id || null);
    messages = getActiveConv()?.messages || [];
    setConversationBaseline(saved.conversations);

    try {
      renderSidebar();
      renderMessages({ preserveScroll: activeConvId === previousActiveConvId });
      updateTokenInfo();
      updateCharacterUI();
      restoreActiveDraft();
      syncRefreshAppliedSettings();
      renderSyncSettings();
    } catch (renderError) {
      console.error('Sync pull render refresh failed:', renderError);
    }
    syncSetStatus('current', 'Pulled', 'Merged ' + remote.conversations.length + ' remote conversations. Added ' + liveMerged.added + ', updated ' + liveMerged.updated + '.');
    showToast('Sync pull complete.', 'success');
    notifyConversationConflicts(saved.conversations.filter(conv => conv.conflictOf).map(conv => conv.id));
    return true;
  } catch (err) {
    console.error('Sync pull failed:', err);
    if (committed) {
      syncSetStatus('current', 'Pull saved', 'The data was saved, but the display could not be refreshed. Reload this tab.');
      return true;
    }
    const message = err.name === 'OperationError' ? 'Could not decrypt sync data. Check the passphrase.' : (err.message || 'Unable to pull sync data.');
    syncSetStatus('unknown', 'Pull failed', message);
    showToast('Sync pull failed: ' + message, 'error', 6000);
    return false;
  } finally {
    _syncOperationInFlight = false;
    _syncPullInFlight = false;
    setSyncBusy(false);
    try {
      if (localStorage.getItem(SYNC_AUTO_PUSH_KEY) === 'true' &&
          localStorage.getItem(SYNC_AUTO_PENDING_KEY) === 'true') syncScheduleAutoPush();
    } catch (error) { console.warn('Could not read automatic sync state:', error); }
  }
}

function syncGeneratePassphrase() {
  try {
    if (_syncOperationInFlight) { showToast('Wait for the current sync operation to finish.', 'info'); return false; }
    const cfg = syncGetConfigFromInputs();
    if ((cfg.gistId || localStorage.getItem('assistantSyncGistId')) && !confirm('Generate a passphrase for a NEW sync Gist? The existing Gist will not be changed. Keep its pairing code first; you will need the old passphrase to read it.')) return false;
    const passphrase = syncBytesToBase64Url(syncRandomBytes(24)).match(/.{1,6}/g).join('-');
    const passEl = document.getElementById('setSyncPassphrase');
    if (passEl) passEl.value = passphrase;
    const gistEl = document.getElementById('setSyncGistId');
    if (gistEl) gistEl.value = '';
    const autoEl = document.getElementById('setSyncAutoPush');
    if (autoEl) autoEl.checked = false;
    _syncInputsLoaded = true;
    if (!syncSaveSettings(false, false)) throw new Error('Browser storage failed. Keep the pairing details shown before retrying.');
    showToast('Sync passphrase generated.', 'success');
    return true;
  } catch (err) {
    showToast('Could not generate passphrase: ' + (err.message || err), 'error');
  }
}

function syncTogglePassphraseVisibility() {
  const input = document.getElementById('setSyncPassphrase');
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
}

async function syncCopyPassphrase() {
  const passphrase = document.getElementById('setSyncPassphrase')?.value || '';
  if (!passphrase) {
    showToast('Generate or enter a passphrase first.', 'info');
    return;
  }
  const copied = await copyShareText(passphrase);
  showToast(copied ? 'Sync passphrase copied.' : 'Could not copy the sync passphrase.', copied ? 'success' : 'error');
}

function syncBuildPairingText() {
  const cfg = syncSaveSettings(false, false);
  if (!cfg) throw new Error('Sync settings could not be saved. Free storage and retry.');
  if (!cfg.gistId) throw new Error('Push once to create a Gist before pairing.');
  if (!cfg.passphrase) throw new Error('Sync passphrase is required for pairing.');
  const includeToken = document.getElementById('setSyncQrIncludeToken')?.checked;
  const payload = {
    app: 'synapse',
    version: 1,
    gistId: cfg.gistId,
    passphrase: cfg.passphrase,
    createdAt: Date.now()
  };
  if (includeToken && cfg.token) payload.token = cfg.token;
  return 'sync:' + syncEncodePairingPayload(payload);
}

function syncParsePairingText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Pairing code is empty.');
  let payload;
  if (raw.toLowerCase().startsWith('sync:')) payload = syncDecodePairingPayload(raw.slice(5));
  else payload = JSON.parse(raw);
  if (!payload || payload.app !== 'synapse' || !payload.gistId || !payload.passphrase) {
    throw new Error('Invalid Synapse pairing code.');
  }
  return payload;
}

function syncApplyPairingText(text, silent = false) {
  if (_syncPullInFlight) {
    if (!silent) showToast('Wait for sync pull to finish.', 'info');
    return false;
  }
  try {
    const source = text || document.getElementById('syncPairingCode')?.value || '';
    const payload = syncParsePairingText(source);
    const gistEl = document.getElementById('setSyncGistId');
    const passEl = document.getElementById('setSyncPassphrase');
    const tokenEl = document.getElementById('setSyncToken');
    if (gistEl) gistEl.value = payload.gistId;
    if (passEl) passEl.value = payload.passphrase;
    if (payload.token && tokenEl) tokenEl.value = payload.token;
    if (!syncSaveSettings(false, false)) throw new Error('Sync settings could not be saved. Free storage and retry.');
    showToast('Pairing code applied.', 'success');
    return true;
  } catch (err) {
    if (!silent) showToast('Pairing failed: ' + (err.message || err), 'error');
    return false;
  }
}

function syncLoadScriptOnce(id, src, globalName) {
  if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
  syncLoadScriptOnce.promises = syncLoadScriptOnce.promises || {};
  if (syncLoadScriptOnce.promises[id]) return syncLoadScriptOnce.promises[id];
  syncLoadScriptOnce.attempts = syncLoadScriptOnce.attempts || {};
  const attempt = syncLoadScriptOnce.attempts[id] || 0;
  const load = src.endsWith('.mjs')
    ? import(src + (attempt ? '?retry=' + attempt : '')).then(module => module.default || module)
    : new Promise((resolve, reject) => {
    document.getElementById(id)?.remove();
    const script = document.createElement('script');
    script.id = id;
    script.src = src;
    script.onload = () => resolve(globalName ? window[globalName] : true);
    script.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(script);
  });
  syncLoadScriptOnce.promises[id] = load.catch(error => {
    delete syncLoadScriptOnce.promises[id];
    syncLoadScriptOnce.attempts[id] = attempt + 1;
    document.getElementById(id)?.remove();
    throw error;
  });
  return syncLoadScriptOnce.promises[id];
}

async function syncRenderPairingQr() {
  try {
    const text = syncBuildPairingText();
    const output = document.getElementById('syncPairingOutput');
    const textArea = document.getElementById('syncPairingText');
    const canvas = document.getElementById('syncPairingQr');
    if (output) output.hidden = false;
    if (textArea) textArea.value = text;
    // A single-file bundle also makes retries independent of cached dependency failures.
    const qr = await syncLoadScriptOnce('syncQrCodeScript', 'https://esm.sh/qrcode@1.5.4/es2022/qrcode.bundle.mjs');
    if (!qr?.toCanvas) throw new Error('QR generator did not load.');
    await qr.toCanvas(canvas, text, {
      width: 192,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#101014', light: '#f7f8ff' }
    });
    showToast('Pairing QR ready.', 'success');
  } catch (err) {
    showToast('QR failed: ' + (err.message || err), 'error', 6000);
  }
}

async function syncCopyPairingText() {
  try {
    const text = syncBuildPairingText();
    const output = document.getElementById('syncPairingOutput');
    const textArea = document.getElementById('syncPairingText');
    if (output) output.hidden = false;
    if (textArea) textArea.value = text;
    try {
      await navigator.clipboard.writeText(text);
    } catch(e) {
      if (!textArea) throw e;
      textArea.focus();
      textArea.select();
      document.execCommand('copy');
    }
    showToast('Pairing code copied.', 'success');
  } catch (err) {
    showToast('Copy failed: ' + (err.message || err), 'error');
  }
}

function syncLoadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read QR image.')); };
    img.src = url;
  });
}

async function syncImportPairingQr(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!beginLocalDataOperation()) return;
  try {
    syncSetStatus('checking', 'Reading QR...', 'Decoding selected pairing image.');
    await syncLoadScriptOnce('syncJsQrScript', 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js', 'jsQR');
    const img = await syncLoadImageFromFile(file);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = window.jsQR(imageData.data, canvas.width, canvas.height);
    if (!result?.data) throw new Error('No QR code found in image.');
    const codeEl = document.getElementById('syncPairingCode');
    if (codeEl) codeEl.value = result.data;
    if (!syncApplyPairingText(result.data, true)) throw new Error('Invalid Synapse pairing code.');
  } catch (err) {
    syncSetStatus('unknown', 'QR failed', err.message || 'Could not decode QR image.');
    showToast('QR import failed: ' + (err.message || err), 'error', 6000);
  } finally {
    endLocalDataOperation();
  }
}

// ============================================
// Export as Markdown
// ============================================
// ============================================
// Share (read-only public link)
// ============================================
// One plaintext file in a secret gist. Confidentiality comes from the unguessable gist
// id, the same way ChatGPT and Claude share links work — the encrypted sync path can't
// be reused because a reader has no passphrase.

const SHARE_FILE = 'share.json';
const SHARE_SCHEMA = 'share-v1';
const SHARE_MAX_BYTES = 5000000;

// Reduce a file part to its name. The dropped fields are the whole point: file.url is a
// base64 copy of the upload and file.textContent is its full extracted text.
function shareSafeContent(content) {
  if (typeof content === 'string') return stripThinkTags(content).content;
  if (!Array.isArray(content)) return String(content == null ? '' : content);
  return content.map(part => {
    if (part.type === 'file') return { type: 'file', file: { name: (part.file && part.file.name) || 'file' } };
    if (part.type === 'text') return { type: 'text', text: stripThinkTags(part.text || '').content };
    if (part.type === 'image_url') return { type: 'text', text: '[Image attachment omitted]' };
    return { type: 'text', text: '[Unsupported content omitted]' };
  });
}

// ALLOWLIST, never a blacklist — a new private field added to conversations later must
// not silently start leaking. Anything not named here is not published.
function buildSharePayload(conv) {
  return {
    app: 'Synapse',
    schema: SHARE_SCHEMA,
    sharedAt: Date.now(),
    title: shareSafeText(conv.title || 'Shared chat'),
    messages: (conv.messages || [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const out = { role: m.role, content: shareSafeContent(m.content) };
        return out;
      })
  };
}

function shareLinkFor(gistId) {
  const pageUrl = location.protocol === 'file:' || location.origin === 'null'
    ? new URL('.', APP_VERSION.updateUrl).href
    : location.origin + location.pathname;
  return pageUrl + '?share=' + encodeURIComponent(gistId);
}

async function copyShareText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.focus();
    helper.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    helper.remove();
    return ok;
  }
}

function openSettingsSection(tabName) {
  openSettings();
  const button = document.getElementById('settingsTabButton-' + tabName);
  if (button) switchSettingsTab(tabName, button);
}

function openShareDialog() {
  closeToolbarMenu(false);
  const conv = getActiveConv();
  if (isTemporaryConversation(conv)) {
    showToast('Temporary chats cannot be shared.', 'info');
    return;
  }
  if (!conv || !(conv.messages || []).length) {
    showToast('Nothing to share in this chat yet.', 'info');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  const popup = document.createElement('div');
  popup.className = 'char-info-popup share-dialog';
  popup.setAttribute('aria-labelledby', 'shareDialogTitle');
  const title = document.createElement('h3');
  title.id = 'shareDialogTitle';
  title.textContent = 'Share conversation';
  const state = document.createElement('p');
  state.className = 'share-state';
  state.textContent = conv.shareGistId ? 'Shared' : 'Not shared';
  const privacy = document.createElement('p');
  privacy.className = 'manual-ai-note';
  privacy.textContent = 'Anyone with the link can read the selected responses. Keys, files, personas, memories, and alternate responses are excluded.';
  popup.append(title, state, privacy);

  let close;
  const token = localStorage.getItem('assistantSyncGistToken') || '';
  if (conv.shareGistId) {
    const row = document.createElement('div');
    row.className = 'share-link-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    input.value = shareLinkFor(conv.shareGistId);
    input.setAttribute('aria-label', 'Public share link');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-secondary';
    copy.textContent = 'Copy link';
    copy.onclick = async () => {
      const copied = await copyShareText(input.value);
      showToast(copied ? 'Share link copied.' : 'Could not copy the share link.', copied ? 'success' : 'error');
    };
    row.append(input, copy);
    popup.appendChild(row);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn btn-secondary';
  done.textContent = 'Close';
  actions.appendChild(done);

  if (!token) {
    const configure = document.createElement('button');
    configure.type = 'button';
    configure.className = 'btn btn-primary';
    configure.textContent = 'Open Sync settings';
    configure.onclick = () => {
      close();
      openSettingsSection('sync');
    };
    actions.appendChild(configure);
  } else {
    const publish = document.createElement('button');
    publish.type = 'button';
    publish.className = 'btn btn-primary';
    publish.textContent = conv.shareGistId ? 'Update link' : 'Publish';
    publish.onclick = async () => {
      publish.disabled = true;
      publish.setAttribute('aria-busy', 'true');
      const shared = await shareConversation({ confirmPublish: false });
      if (shared) close();
      else {
        publish.disabled = false;
        publish.removeAttribute('aria-busy');
      }
    };
    actions.appendChild(publish);
    if (conv.shareGistId) {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'btn btn-danger';
      revoke.textContent = 'Revoke link';
      revoke.onclick = async () => {
        revoke.disabled = true;
        const revoked = await unshareConversation();
        if (revoked) close();
        else revoke.disabled = false;
      };
      actions.appendChild(revoke);
    }
  }
  popup.appendChild(actions);
  close = openTransientDialog(overlay, popup, actions.querySelector('.btn-primary') || done);
  done.onclick = close;
}

async function shareConversation(options = {}) {
  const conv = getActiveConv();
  if (isTemporaryConversation(conv)) {
    showToast('Temporary chats cannot be shared.', 'info');
    return false;
  }
  if (!conv || !(conv.messages || []).length) {
    showToast('Nothing to share in this chat yet.', 'error');
    return false;
  }
  const token = localStorage.getItem('assistantSyncGistToken') || '';
  if (!token) {
    showToast('Add a GitHub token in Settings → Sync first.', 'error');
    return false;
  }
  const payload = buildSharePayload(conv);
  const json = JSON.stringify(payload);
  if (new TextEncoder().encode(json).byteLength > SHARE_MAX_BYTES) {
    showToast('Too large to share.', 'error');
    return false;
  }
  if (!conv.shareGistId && options.confirmPublish !== false && !confirm(
    'Publish this chat to a secret GitHub Gist?\n\n' +
    'Anyone with the link can read it. Your API key, files, personas, memories and ' +
    'alternate responses are not included.')) return false;

  if (!beginLocalDataOperation()) return false;
  try {
    showToast('Publishing...', 'info', 2500);
    const files = {};
    files[SHARE_FILE] = { content: json };
    const gist = conv.shareGistId
      ? await fetchGist(SYNC_GIST_API_URL + '/' + encodeURIComponent(conv.shareGistId), {
          method: 'PATCH', body: JSON.stringify({ files })
        }, token)
      : await fetchGist(SYNC_GIST_API_URL, {
          method: 'POST',
          body: JSON.stringify({ description: 'Synapse shared conversation', public: false, files })
        }, token);
    conv.shareGistId = gist.id;
    conv.updatedAt = Date.now();
    saveConversations();
    const link = shareLinkFor(gist.id);
    const copied = await copyShareText(link);
    showToast(copied ? 'Link copied. Anyone with it can read this chat.' : 'Shared: ' + link, 'success');
    return true;
  } catch (err) {
    showToast('Share failed: ' + (err.message || err), 'error');
    return false;
  } finally {
    endLocalDataOperation();
  }
}

async function unshareConversation(options = {}) {
  const conv = getActiveConv();
  if (!conv || !conv.shareGistId) {
    showToast('This chat is not shared.');
    return false;
  }
  const token = localStorage.getItem('assistantSyncGistToken') || '';
  if (!token) {
    showToast('Add a GitHub token in Settings → Sync first.', 'error');
    return false;
  }
  if (options.confirm !== false && !confirm('Revoke this public share link? Anyone using it will lose access.')) return false;
  if (!beginLocalDataOperation()) return false;
  try {
    await fetchGist(SYNC_GIST_API_URL + '/' + encodeURIComponent(conv.shareGistId), { method: 'DELETE' }, token);
    delete conv.shareGistId;
    conv.updatedAt = Date.now();
    saveConversations();
    showToast('Link revoked.', 'success');
    return true;
  } catch (err) {
    showToast('Unshare failed: ' + (err.message || err), 'error');
    return false;
  } finally {
    endLocalDataOperation();
  }
}

async function initShareView(gistId) {
  const area = document.getElementById('messagesArea');
  const fail = (msg) => {
    if (area) area.innerHTML = '<div class="chat-placeholder">' + escapeHTML(msg) + '</div>';
  };
  try {
    // ponytail: anonymous GitHub API is 60 req/hr/IP. Switch to the gist raw URL if a
    // shared link ever gets real traffic.
    const gist = await fetchGist(SYNC_GIST_API_URL + '/' + encodeURIComponent(gistId), { cache: 'no-store' });
    const payload = JSON.parse(await syncGetGistFileContent(gist, SHARE_FILE));
    if (!payload || payload.schema !== SHARE_SCHEMA || !Array.isArray(payload.messages)) {
      throw new Error('Unrecognised share format');
    }
    messages = normalizeConversationRecord({ messages: payload.messages }).messages;
    document.title = (payload.title || 'Shared chat') + ' — Synapse';
    const titleEl = document.querySelector('.toolbar-title');
    if (titleEl) titleEl.textContent = payload.title || 'Shared chat';

    const banner = document.createElement('div');
    banner.className = 'share-banner';
    banner.innerHTML = 'Read-only shared conversation · <a href="' +
      escapeHTML(location.origin + location.pathname) + '">Open Synapse</a>';
    document.body.appendChild(banner);

    renderMessages();
  } catch (err) {
    console.warn('Share view failed:', err);
    fail('This shared conversation is unavailable (it may have been unshared).');
  }
}

// Runnable check for the one genuinely dangerous piece of this feature: the strip.
// Run shareSelfTest() in the console after a build.
function shareSelfTest() {
  const conv = {
    id: 'conv_1', title: 't', projectId: 'proj_1',
    summary: 'SECRET_SUMMARY', persona: 'SECRET_PERSONA',
    characterDescription: 'SECRET_CHAR', characterSystemPrompt: 'SECRET_SYSPROMPT',
    tag: 'SECRET_TAG', shareGistId: 'SECRET_GIST', goal: 'SECRET_GOAL',
    parentConversationId: 'SECRET_PARENT', forkMessageIndex: 2,
    queuedFollowUps: [{ id: 'SECRET_QUEUE_ID', text: 'SECRET_QUEUE', attachments: [] }],
    docs: [{ id: 'd', name: 'n', text: 'SECRET_DOC' }],
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'hi <think>SECRET_INLINE</think>' },
        { type: 'file', file: { name: 'a.txt', url: 'data:SECRET_URL', textContent: 'SECRET_FILE' } },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,SECRET_IMAGE' } }
      ] },
      { role: 'assistant', content: 'ok', swipes: ['ok', 'SECRET_SWIPE'], swipeIndex: 0, swipeImages: [['data:image/png;base64,SECRET_ASSISTANT_IMAGE']],
        swipeThinking: ['SECRET_THINK'], swipeToolUse: [[{ url: 'SECRET_TOOL' }]],
        llm: { profileName: 'SECRET_PROFILE', providerName: 'SECRET_PROVIDER' } },
      { role: 'system', content: 'SECRET_SYSTEM' }
    ]
  };
  const json = JSON.stringify(buildSharePayload(conv));
  const leaks = ['SECRET_SUMMARY', 'SECRET_PERSONA', 'SECRET_CHAR', 'SECRET_SYSPROMPT', 'SECRET_TAG',
    'SECRET_GIST', 'SECRET_DOC', 'SECRET_URL', 'SECRET_FILE', 'SECRET_SWIPE', 'SECRET_THINK',
    'SECRET_TOOL', 'SECRET_PROFILE', 'SECRET_PROVIDER', 'SECRET_SYSTEM', 'SECRET_INLINE', 'SECRET_IMAGE',
    'SECRET_ASSISTANT_IMAGE', 'SECRET_GOAL', 'SECRET_PARENT', 'SECRET_QUEUE_ID', 'SECRET_QUEUE', 'proj_1', 'conv_1']
    .filter(s => json.includes(s));
  if (leaks.length) throw new Error('share payload leaked: ' + leaks.join(', '));
  if (!json.includes('a.txt')) throw new Error('share payload lost the file name');
  if (!json.includes('hi')) throw new Error('share payload lost the message text');
  console.log('shareSelfTest OK');
  return true;
}

function exportMarkdown() {
  const conv = getActiveConv();
  if (isTemporaryConversation(conv)) { showToast('Temporary chats cannot be exported.', 'info'); return; }
  if (!conv || conv.messages.length === 0) { showToast('No messages to export.', 'info'); return; }
  let md = '# ' + conv.title + '\n\n';
  conv.messages.forEach(m => {
    if (m.role === 'user') {
      md += '## User\n\n';
      const text = getMsgText(m);
      if (Array.isArray(m.content)) {
        m.content.forEach(p => {
          if (p.type === 'text') md += p.text + '\n\n';
          else if (p.type === 'image_url') md += '_[Image attachment]_\n\n';
          else if (p.type === 'file') md += '_[File: ' + (p.file.name || 'attachment') + ']_\n\n';
        });
      } else {
        md += text + '\n\n';
      }
    } else if (m.role === 'assistant') {
      const thinking = m.swipeThinking && m.swipeThinking[m.swipeIndex || 0];
      if (thinking) md += '<details>\n<summary>Thinking</summary>\n\n' + thinking + '\n\n</details>\n\n';
      md += '## Assistant\n\n' + (m.content || '') + '\n\n';
    }
  });
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (conv.title || 'chat') + '.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ============================================
// Screenshot Select Mode
// ============================================
let _selectMode = false;
const _selectedMsgs = new Set();
let _justEnteredSelectMode = false;

function enterSelectMode() {
  if (isTemporaryConversation(getActiveConv())) { showToast('Temporary chats cannot be saved as screenshots.', 'info'); return; }
  if (messages.length === 0) { showToast('No messages to screenshot.', 'info'); return; }
  _selectMode = true;
  _justEnteredSelectMode = true;
  _selectedMsgs.clear();
  document.getElementById('messagesArea').classList.add('select-mode');
  const selectToolbar = document.getElementById('selectToolbar');
  const inputArea = document.querySelector('.input-area');
  if (inputArea) selectToolbar.style.bottom = (inputArea.offsetHeight + 16) + 'px';
  selectToolbar.classList.add('visible');
  updateSelectCount();
}

function exitSelectMode() {
  _selectMode = false;
  _selectedMsgs.clear();
  const area = document.getElementById('messagesArea');
  area.classList.remove('select-mode');
  area.querySelectorAll('.msg-wrapper.selected').forEach(el => el.classList.remove('selected'));
  document.getElementById('selectToolbar').classList.remove('visible');
}

function toggleMsgSelect(idx) {
  if (idx < 0 || idx >= messages.length) return;
  if (_selectedMsgs.has(idx)) _selectedMsgs.delete(idx);
  else _selectedMsgs.add(idx);
  const wrapper = document.querySelector('.msg-wrapper[data-msg-idx="' + idx + '"]');
  if (wrapper) wrapper.classList.toggle('selected', _selectedMsgs.has(idx));
  updateSelectCount();
}

function updateSelectCount() {
  document.getElementById('selectCount').textContent = _selectedMsgs.size + ' selected';
  document.getElementById('ssBtn').disabled = _selectedMsgs.size === 0;
}

async function screenshotSelected() {
  if (_selectedMsgs.size === 0) return;
  const conversationId = activeConvId;
  if (isTemporaryConversation(getActiveConv())) { showToast('Temporary chats cannot be saved as screenshots.', 'info'); return; }
  const btn = document.getElementById('ssBtn');
  btn.disabled = true;
  btn.textContent = 'Rendering...';
  try {
    if (!window.html2canvas) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load html2canvas'));
        document.head.appendChild(s);
      });
    }
    if (activeConvId !== conversationId || isTemporaryConversation(getActiveConv())) throw new Error('The active chat changed before the screenshot was ready.');
    const indices = [..._selectedMsgs].sort((a, b) => a - b);
    const area = document.getElementById('messagesArea');
    const cs = getComputedStyle(document.documentElement);
    const bgColor = cs.getPropertyValue('--bg').trim();
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;left:-9999px;top:0;width:' + Math.min(area.offsetWidth, 800) + 'px;background:' + bgColor + ';padding:20px;display:flex;flex-direction:column;gap:12px;';
    indices.forEach(idx => {
      const wrapper = area.querySelector('.msg-wrapper[data-msg-idx="' + idx + '"]');
      if (!wrapper) return;
      const clone = wrapper.cloneNode(true);
      clone.querySelectorAll('.msg-actions, .regen-btn, .swipe-nav, .msg-meta, .msg-timestamp').forEach(el => el.remove());
      clone.classList.remove('selected');
      container.appendChild(clone);
    });
    document.body.appendChild(container);
    const canvas = await html2canvas(container, { backgroundColor: bgColor, scale: 2, useCORS: true, logging: false });
    document.body.removeChild(container);
    const link = document.createElement('a');
    link.download = 'chat-screenshot.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    exitSelectMode();
  } catch (err) {
    console.error('Screenshot failed:', err);
    showToast('Screenshot failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Screenshot';
  }
}

// ============================================
// Chat Search (Ctrl+F)
// ============================================
let chatSearchMatches = [];
let chatSearchIdx = -1;
let chatSearchDebounce = null;

// ============================================
// Global Message Search
// ============================================
function openGlobalSearch() {
  if (globalSearchDismiss) globalSearchDismiss(false);

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  const popup = document.createElement('div');
  popup.className = 'char-info-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-modal', 'true');
  popup.setAttribute('aria-labelledby', 'globalSearchTitle');
  popup.setAttribute('tabindex', '-1');
  popup.innerHTML = '<h3 id="globalSearchTitle">Search All Messages</h3>' +
    '<input type="text" id="globalSearchInput" aria-label="Search all messages" placeholder="Type to search across all conversations..." style="width:100%;padding:10px;font-family:inherit;font-size:0.9em;background:var(--hover);border:1px solid var(--card-border);border-radius:8px;color:var(--text-primary);margin-bottom:12px">' +
    '<div class="sr-only" id="globalSearchStatus" aria-live="polite" aria-atomic="true"></div>' +
    '<div class="global-search-results" id="globalSearchResults" role="region" aria-live="polite" aria-label="Search results"><div style="color:var(--text-secondary);font-size:0.85em;text-align:center;padding:20px">Start typing to search</div></div>';

  const closeGlobalSearch = (restoreFocus = true) => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    popup.remove();
    if (globalSearchDismiss === closeGlobalSearch) globalSearchDismiss = null;
    if (restoreFocus && previousFocus && document.contains(previousFocus)) previousFocus.focus();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeGlobalSearch();
      return;
    }
    trapFocus(popup, e);
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeGlobalSearch();
  });
  document.body.appendChild(overlay);
  document.body.appendChild(popup);
  globalSearchDismiss = closeGlobalSearch;
  document.addEventListener('keydown', onKey);

  const input = document.getElementById('globalSearchInput');
  const status = document.getElementById('globalSearchStatus');
  if (status) status.textContent = 'Start typing to search across all conversations.';
  input.focus();
  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => performGlobalSearch(input.value.trim()), 200);
  });
}

function performGlobalSearch(query) {
  const container = document.getElementById('globalSearchResults');
  const status = document.getElementById('globalSearchStatus');
  if (!container) return;
  if (!query || query.length < 2) {
    container.innerHTML = '<div style="color:var(--text-secondary);font-size:0.85em;text-align:center;padding:20px">Type at least 2 characters</div>';
    if (status) status.textContent = 'Type at least 2 characters.';
    return;
  }
  const results = [];
  const lq = query.toLowerCase();
  conversations.forEach(conv => {
    conv.messages.forEach((msg) => {
      const raw = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.filter(p => p.type === 'text').map(p => p.text).join(' ') : '');
      // Search visible text only; hidden reasoning would surface unopenable hits
      // and leak raw <think> markup into snippets.
      const text = raw.includes('<think') ? stripThinkTags(raw).content : raw;
      const idx = text.toLowerCase().indexOf(lq);
      if (idx !== -1) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + query.length + 40);
        const snippet = (start > 0 ? '...' : '') +
          escapeHTML(text.slice(start, idx)) +
          '<mark>' + escapeHTML(text.slice(idx, idx + query.length)) + '</mark>' +
          escapeHTML(text.slice(idx + query.length, end)) +
          (end < text.length ? '...' : '');
        results.push({ convId: conv.id, convTitle: conv.title, role: msg.role, snippet });
      }
    });
  });
  if (results.length === 0) {
    container.innerHTML = '<div style="color:var(--text-secondary);font-size:0.85em;text-align:center;padding:20px">No results found</div>';
    if (status) status.textContent = 'No results found.';
    return;
  }
  const displayed = results.slice(0, 50);
  container.replaceChildren();
  displayed.forEach(result => {
    const row = document.createElement('div');
    row.className = 'global-search-result';
    row.dataset.convId = result.convId;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', 'Open conversation ' + result.convTitle);
    const title = document.createElement('div');
    title.className = 'global-search-result-title';
    title.textContent = result.convTitle + ' ';
    const role = document.createElement('span');
    role.style.cssText = 'font-weight:400;color:var(--text-secondary)';
    role.textContent = '(' + result.role + ')';
    title.appendChild(role);
    const snippet = document.createElement('div');
    snippet.className = 'global-search-result-snippet';
    snippet.innerHTML = result.snippet;
    row.append(title, snippet);
    container.appendChild(row);
  });
  if (results.length > 50) {
    const more = document.createElement('div');
    more.style.cssText = 'color:var(--text-secondary);font-size:0.8em;text-align:center;padding:8px';
    more.textContent = 'Showing 50 of ' + results.length + ' results';
    container.appendChild(more);
  }
  if (status) status.textContent = (results.length > 50 ? 'Showing 50 of ' + results.length : results.length) + ' results found.';
  container.querySelectorAll('.global-search-result').forEach(el => {
    const activateResult = () => {
      switchConversation(el.dataset.convId);
      if (globalSearchDismiss) globalSearchDismiss();
    };
    el.addEventListener('click', () => {
      activateResult();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateResult();
      }
    });
  });
}

function openChatSearch() {
  const bar = document.getElementById('chatSearchBar');
  bar.classList.add('open');
  document.getElementById('chatSearchInput').focus();
}

function closeChatSearch() {
  const bar = document.getElementById('chatSearchBar');
  bar.classList.remove('open');
  document.getElementById('chatSearchInput').value = '';
  document.getElementById('chatSearchCount').textContent = '';
  clearChatHighlights();
  chatSearchMatches = [];
  chatSearchIdx = -1;
}

function clearChatHighlights() {
  document.querySelectorAll('.search-highlight').forEach(el => {
    const parent = el.parentNode;
    parent.replaceChild(document.createTextNode(el.textContent), el);
    parent.normalize();
  });
}

function debouncedChatSearch() {
  clearTimeout(chatSearchDebounce);
  chatSearchDebounce = setTimeout(performChatSearch, 200);
}

function performChatSearch() {
  clearChatHighlights();
  chatSearchMatches = [];
  chatSearchIdx = -1;
  const query = document.getElementById('chatSearchInput').value.trim();
  if (!query) { document.getElementById('chatSearchCount').textContent = ''; return; }

  const textNodes = [];
  document.querySelectorAll('#messagesArea .msg-bubble').forEach(bubble => {
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest('.thinking-block, button')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) textNodes.push(walker.currentNode);
  });

  const lowerQuery = query.toLowerCase();
  textNodes.forEach(node => {
    const text = node.textContent;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(lowerQuery);
    if (idx === -1) return;
    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    while (idx !== -1) {
      if (idx > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
      const span = document.createElement('span');
      span.className = 'search-highlight';
      span.textContent = text.slice(idx, idx + query.length);
      frag.appendChild(span);
      chatSearchMatches.push(span);
      lastIdx = idx + query.length;
      idx = lower.indexOf(lowerQuery, lastIdx);
    }
    if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    node.parentNode.replaceChild(frag, node);
  });

  document.getElementById('chatSearchCount').textContent = chatSearchMatches.length + ' matches';
  if (chatSearchMatches.length > 0) {
    chatSearchIdx = 0;
    chatSearchMatches[0].classList.add('active');
    chatSearchMatches[0].scrollIntoView({ behavior: getScrollBehavior(), block: 'center' });
  }
}

function navigateChatSearch(dir) {
  if (chatSearchMatches.length === 0) return;
  chatSearchMatches[chatSearchIdx]?.classList.remove('active');
  chatSearchIdx = (chatSearchIdx + dir + chatSearchMatches.length) % chatSearchMatches.length;
  chatSearchMatches[chatSearchIdx].classList.add('active');
  chatSearchMatches[chatSearchIdx].scrollIntoView({ behavior: getScrollBehavior(), block: 'center' });
  document.getElementById('chatSearchCount').textContent = (chatSearchIdx + 1) + '/' + chatSearchMatches.length;
}

// ============================================
// File Attachments
// ============================================
function resizeImageIfNeeded(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { resolve(null); return; }
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      let { width, height } = img;
      if (width <= maxDim && height <= maxDim) { resolve(null); return; }
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('This image could not be decoded. Try PNG, JPEG, WebP, GIF or AVIF.')); };
    img.src = URL.createObjectURL(file);
  });
}

async function extractPdfText(arrayBuffer) {
  const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.map(item => item.str).join(' '));
  }
  return pages.join('\n\n');
}

const MAX_ATTACHMENT_TEXT_CHARS = 200000;
const TEXT_MIMES = new Set([
  'application/ecmascript',
  'application/geo+json',
  'application/graphql',
  'application/graphql-response+json',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'application/rss+xml',
  'application/sql',
  'application/toml',
  'application/xml',
  'application/yaml',
  'application/x-ipynb+json',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-ndjson',
  'application/x-php',
  'application/x-python-code',
  'application/x-ruby',
  'application/x-sh',
  'application/x-sql',
  'application/x-toml',
  'application/x-yaml',
  'image/svg+xml',
  'text/cache-manifest',
  'text/calendar',
  'text/css',
  'text/csv',
  'text/html',
  'text/javascript',
  'text/jsx',
  'text/markdown',
  'text/plain',
  'text/rtf',
  'text/tab-separated-values',
  'text/tsx',
  'text/typescript',
  'text/vcard',
  'text/xml',
  'text/yaml'
]);
const TEXT_EXTENSIONS = /\.(asm|bat|c|cfg|conf|cpp|cs|css|csv|cts|cxx|diff|dockerignore|editorconfig|env|gitattributes|gitignore|gitmodules|go|gql|graphql|h|hpp|htm|html|ini|ipynb|java|js|json|json5|jsonl|jsx|lock|log|lua|m|md|mdx|mts|npmrc|php|plist|properties|py|r|rb|rs|sass|scala|scss|sh|sql|srt|svg|swift|toml|ts|tsv|tsx|txt|vue|xml|yaml|yml|zsh)$/i;
const TEXT_FILENAMES = new Set([
  'changelog',
  'dockerfile',
  'license',
  'makefile',
  'readme'
]);
const DOCX_EXTENSIONS = /\.(docm|docx|dotm|dotx)$/i;
const DOC_EXTENSIONS = /\.(doc|dot)$/i;
const DOCX_MIMES = new Set([
  'application/vnd.ms-word.document.macroenabled.12',
  'application/vnd.ms-word.template.macroenabled.12',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template'
]);
const DOC_MIMES = new Set(['application/msword']);
const RTF_MIMES = new Set(['application/rtf', 'text/rtf']);

function limitAttachmentText(text, name) {
  const value = String(text || '');
  if (value.length <= MAX_ATTACHMENT_TEXT_CHARS) return value;
  return value.slice(0, MAX_ATTACHMENT_TEXT_CHARS) +
    `\n\n[${name || 'file'} truncated after ${MAX_ATTACHMENT_TEXT_CHARS.toLocaleString()} characters.]`;
}

function isTextLikeFile(file) {
  const mime = (file.type || '').toLowerCase();
  const name = String(file.name || '').toLowerCase();
  return mime.startsWith('text/') || TEXT_MIMES.has(mime) || TEXT_EXTENSIONS.test(name) || TEXT_FILENAMES.has(name);
}

function isProbablyTextBuffer(buffer) {
  const bytes = new Uint8Array(buffer.slice(0, Math.min(buffer.byteLength, 4096)));
  if (bytes.length === 0) return true;
  let suspicious = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / bytes.length < 0.08;
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function cleanExtractedText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function extractTextFromDocxXml(xml) {
  const withBreaks = String(xml || '')
    .replace(/<w:tab\/?>/g, '\t')
    .replace(/<w:br\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t');
  return cleanExtractedText(decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, '')));
}

function findZipEndOfCentralDirectory(view) {
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function inflateZipEntry(data, method) {
  if (method === 0) return data;
  if (method !== 8) throw new Error('Unsupported ZIP compression method: ' + method);
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress DOCX files.');
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (rawErr) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
}

async function extractZipEntries(arrayBuffer, wantedNames) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const eocd = findZipEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error('ZIP directory not found.');
  const totalEntries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const results = {};

  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLen));

    if (wantedNames.some(pattern => typeof pattern === 'string' ? pattern === name : pattern.test(name))) {
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('ZIP local header not found.');
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      results[name] = decoder.decode(await inflateZipEntry(compressed, method));
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return results;
}

async function extractDocxText(arrayBuffer) {
  const entries = await extractZipEntries(arrayBuffer, [
    'word/document.xml',
    /^word\/header\d+\.xml$/,
    /^word\/footer\d+\.xml$/,
    /^word\/footnotes\.xml$/,
    /^word\/endnotes\.xml$/
  ]);
  const orderedNames = Object.keys(entries).sort((a, b) => {
    if (a === 'word/document.xml') return -1;
    if (b === 'word/document.xml') return 1;
    return a.localeCompare(b);
  });
  const parts = orderedNames.map(name => extractTextFromDocxXml(entries[name])).filter(Boolean);
  return cleanExtractedText(parts.join('\n\n'));
}

function extractRtfText(text) {
  return cleanExtractedText(String(text || '')
    .replace(/\\u(-?\d+)\??/g, (_, code) => String.fromCharCode(Number(code) < 0 ? Number(code) + 65536 : Number(code)))
    .replace(/\\'[0-9a-f]{2}/gi, match => String.fromCharCode(parseInt(match.slice(2), 16)))
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\line/g, '\n')
    .replace(/\\tab/g, '\t')
    .replace(/[{}]/g, '')
    .replace(/\\[a-z]+\d* ?/gi, '')
    .replace(/\\[^a-z0-9]/gi, ''));
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(reader.error || new Error('File could not be read.'));
    reader.readAsDataURL(file);
  });
}

function extractLegacyDocText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const singleByte = new TextDecoder('windows-1252').decode(bytes);
  const utf16 = new TextDecoder('utf-16le').decode(bytes);
  const chunks = [];

  for (const source of [singleByte, utf16]) {
    const matches = source.match(/[^\x00-\x08\x0b\x0c\x0e-\x1f]{6,}/g) || [];
    for (const match of matches) {
      const cleaned = match.replace(/\s+/g, ' ').trim();
      if (!cleaned) continue;
      if (/^[\W_]+$/.test(cleaned)) continue;
      chunks.push(cleaned);
    }
  }

  return cleanExtractedText([...new Set(chunks)].join('\n'));
}

async function readAttachmentFile(file, options = {}) {
  if (!file) return false;
  const mime = (file.type || '').toLowerCase();
  const name = file.name || 'file';
  const originConv = getActiveConv();
  const deliver = typeof options.onAttachment === 'function'
    ? options.onAttachment
    : attachment => queueAttachmentForConversation(originConv?.id, attachment);
  const queueText = (text, fallbackMime, typeName) => {
    const value = String(text || '').trim();
    if (!value) throw new Error(typeName + ' contains no readable text.');
    deliver({
      type: 'file',
      name,
      mime: file.type || fallbackMime,
      textContent: limitAttachmentText(value, name),
      truncated: value.length > MAX_ATTACHMENT_TEXT_CHARS
    });
  };

  pendingAttachmentReads++;
  attachmentStatusMessage = '';
  renderPreviews();
  try {
    if (!file.size) throw new Error('The file is empty.');
    const isImage = mime.startsWith('image/');
    if (mime === 'image/svg+xml' || /\.svg$/i.test(name)) {
      // SVG is supported as source text, not as an active image document.
      queueText(await file.text(), 'image/svg+xml', 'SVG');
    } else if (isImage) {
      const resizedUrl = await resizeImageIfNeeded(file, 1536, 0.85);
      const dataUrl = safeMediaUrl(resizedUrl || await readFileAsDataURL(file));
      if (!dataUrl) throw new Error('This image format cannot be attached. Try PNG, JPEG, WebP, GIF or AVIF.');
      deliver({ type: 'image', dataUrl, name, mime: resizedUrl ? 'image/jpeg' : file.type });
    } else if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
      queueText(await extractPdfText(await file.arrayBuffer()), 'application/pdf', 'PDF');
    } else if (DOCX_EXTENSIONS.test(name) || DOCX_MIMES.has(mime)) {
      queueText(await extractDocxText(await file.arrayBuffer()), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'DOCX');
    } else if (/\.rtf$/i.test(name) || RTF_MIMES.has(mime)) {
      queueText(extractRtfText(await file.text()), 'text/rtf', 'RTF');
    } else if (DOC_EXTENSIONS.test(name) || DOC_MIMES.has(mime)) {
      queueText(extractLegacyDocText(await file.arrayBuffer()), 'application/msword', 'DOC');
    } else if (isTextLikeFile(file)) {
      queueText(await file.text(), 'text/plain', 'File');
    } else {
      const buffer = await file.arrayBuffer();
      if (isProbablyTextBuffer(buffer)) {
        queueText(new TextDecoder('utf-8').decode(buffer), 'text/plain', 'File');
        return true;
      }
      deliver({
        type: 'file',
        dataUrl: await readFileAsDataURL(file),
        name,
        mime: file.type || 'application/octet-stream',
        binary: true,
        textContent: `[Binary file attached: ${name} (${file.type || 'unknown type'}, ${file.size.toLocaleString()} bytes). This provider may only receive file contents if it supports document uploads.]`
      });
    }
    return true;
  } catch (e) {
    console.error('File attachment failed:', e);
    attachmentStatusMessage = 'Could not attach ' + name + '.';
    showToast(attachmentStatusMessage + ' ' + (e?.message || 'The file could not be read.'), 'error');
    announce(attachmentStatusMessage);
    return false;
  } finally {
    pendingAttachmentReads = Math.max(0, pendingAttachmentReads - 1);
    renderPreviews();
  }
}

function handleFileSelect(event) {
  Array.from(event.target.files).forEach(file => { void readAttachmentFile(file); });
  event.target.value = '';
}

function renderPreviews() {
  const container = document.getElementById('imagePreview');
  const status = document.getElementById('attachmentStatus');
  container.innerHTML = '';
  pendingAttachments.forEach((att, idx) => {
    const thumb = document.createElement('div');
    thumb.className = att.type === 'image' ? 'img-thumb' : 'file-thumb';
    thumb.title = att.name || 'file';
    if (att.type === 'image') {
      const imgEl = document.createElement('img');
      imgEl.src = att.dataUrl;
      imgEl.alt = att.name ? 'Attached image: ' + att.name : 'Attached image';
      thumb.appendChild(imgEl);
    } else {
      thumb.textContent = '\u{1F4C4} ' + (att.name || 'file');
      if (att.truncated) thumb.title = (att.name || 'file') + ' was truncated to fit the context.';
    }
    const rm = document.createElement('button');
    rm.className = 'remove-thumb';
    rm.type = 'button';
    rm.title = 'Remove ' + (att.name || 'attachment');
    rm.setAttribute('aria-label', 'Remove ' + (att.name || 'attachment'));
    rm.innerHTML = '&times;';
    rm.onclick = () => { pendingAttachments.splice(idx, 1); renderPreviews(); persistDraftFromUI(); };
    thumb.appendChild(rm);
    container.appendChild(thumb);
  });
  if (status) {
    const truncated = pendingAttachments.filter(att => att.truncated).length;
    const message = pendingAttachmentReads > 0
      ? 'Reading ' + pendingAttachmentReads + (pendingAttachmentReads === 1 ? ' file…' : ' files…')
      : attachmentStatusMessage || (truncated ? truncated + (truncated === 1 ? ' file was' : ' files were') + ' truncated to fit.' : '');
    status.textContent = message;
    status.hidden = !message;
  }
  updateSendBtnState();
  persistDraftFromUI();
}

// ============================================
// @Model Mentions
// ============================================
function clearModelOverride() {
  modelOverride = null;
  document.getElementById('modelOverrideBadge').classList.remove('visible');
}

function setModelOverride(model) {
  modelOverride = model;
  document.getElementById('modelOverrideText').textContent = model;
  document.getElementById('modelOverrideBadge').classList.add('visible');
  closeMentionDropdown();
}

function closeMentionDropdown() {
  document.getElementById('mentionDropdown').classList.remove('open');
  mentionActive = false;
  mentionIdx = 0;
}

function handleMentionInput(ta) {
  const val = ta.value;
  const cursorPos = ta.selectionStart;
  // Find @query before cursor
  const before = val.slice(0, cursorPos);
  const atMatch = before.match(/@([\w\-./]*)$/);
  if (!atMatch) { closeMentionDropdown(); return; }

  const query = atMatch[1].toLowerCase();
  const models = readCachedModels();
  if (models.length === 0) { closeMentionDropdown(); return; }

  const filtered = models.filter(m => m.toLowerCase().includes(query)).slice(0, 8);
  if (filtered.length === 0) { closeMentionDropdown(); return; }

  const dropdown = document.getElementById('mentionDropdown');
  dropdown.innerHTML = '';
  mentionIdx = 0;
  filtered.forEach((m, i) => {
    const div = document.createElement('div');
    div.className = 'mention-item' + (i === 0 ? ' active' : '');
    div.textContent = m;
    div.onclick = () => selectMention(ta, m, atMatch.index);
    dropdown.appendChild(div);
  });
  dropdown.classList.add('open');
  mentionActive = true;
}

function selectMention(ta, model, atStart) {
  // Remove @query from input
  const after = ta.value.slice(ta.selectionStart);
  ta.value = ta.value.slice(0, atStart) + after;
  ta.focus();
  setModelOverride(model);
  persistDraftFromUI();
}

function handleMentionKeydown(e, ta) {
  if (!mentionActive) return;
  const dropdown = document.getElementById('mentionDropdown');
  const items = dropdown.querySelectorAll('.mention-item');
  if (items.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[mentionIdx]?.classList.remove('active');
    mentionIdx = (mentionIdx + 1) % items.length;
    items[mentionIdx]?.classList.add('active');
    items[mentionIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[mentionIdx]?.classList.remove('active');
    mentionIdx = (mentionIdx - 1 + items.length) % items.length;
    items[mentionIdx]?.classList.add('active');
    items[mentionIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    const model = items[mentionIdx]?.textContent;
    if (model) {
      const before = ta.value.slice(0, ta.selectionStart);
      const atMatch = before.match(/@([\w\-./]*)$/);
      if (atMatch) selectMention(ta, model, atMatch.index);
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMentionDropdown();
  }
}

// ============================================
// Character Card Import (PNG + JSON)
// ============================================
function extractCharaFromPNG(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  let offset = 8; // skip PNG signature
  while (offset < view.byteLength) {
    const len = view.getUint32(offset);
    const typeBytes = new Uint8Array(arrayBuffer, offset + 4, 4);
    const type = String.fromCharCode(...typeBytes);
    if (type === 'tEXt') {
      const data = new Uint8Array(arrayBuffer, offset + 8, len);
      const nullIdx = data.indexOf(0);
      const keyword = new TextDecoder().decode(data.slice(0, nullIdx));
      if (keyword === 'chara') {
        const text = new TextDecoder().decode(data.slice(nullIdx + 1));
        return JSON.parse(atob(text));
      }
    }
    offset += 12 + len; // 4 length + 4 type + data + 4 CRC
  }
  return null;
}

function normalizeCharaCard(raw) {
  // V2 format wraps in { spec, data }
  if (raw.spec === 'chara_card_v2' && raw.data) return raw.data;
  // V1 is flat
  if (raw.name || raw.description || raw.first_mes) return raw;
  return raw;
}

function buildCharaDescription(card) {
  let parts = [];
  if (card.name) parts.push('Character: ' + card.name);
  if (card.description) parts.push(card.description);
  if (card.personality) parts.push('Personality: ' + card.personality);
  if (card.scenario) parts.push('Scenario: ' + card.scenario);
  if (card.mes_example) parts.push('Example dialogue:\n' + card.mes_example);
  return parts.join('\n\n');
}

async function importCharacterCard(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  if (readOnlyShare || sending || streaming || queueingFollowUp) return;
  if (!beginLocalDataOperation()) return;

  try {
    let rawCard = null;
    let avatarDataUrl = null;

    if (file.name.toLowerCase().endsWith('.png')) {
      const arrayBuffer = await file.arrayBuffer();
      rawCard = extractCharaFromPNG(arrayBuffer);
      if (!rawCard) { showToast('No character data found in PNG.', 'error'); return; }
      // Also store the PNG as avatar
      const blob = new Blob([arrayBuffer], { type: 'image/png' });
      avatarDataUrl = await readFileAsDataURL(blob);
    } else if (file.name.toLowerCase().endsWith('.json')) {
      const text = await file.text();
      rawCard = JSON.parse(text);
    } else {
      showToast('Unsupported file type. Use .png or .json.', 'error');
      return;
    }

    const card = normalizeCharaCard(rawCard);
    const charName = card.name || 'Character';
    const charDescription = buildCharaDescription(card);

    // Create a new conversation
    const conv = {
      id: genId(),
      title: charName,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      characterCard: card,
      characterDescription: charDescription
    };

    // Store card's system_prompt as actual system instructions (separate from persona)
    if (card.system_prompt) conv.characterSystemPrompt = card.system_prompt;

    if (avatarDataUrl) conv.characterAvatar = avatarDataUrl;

    // Add first message if present
    if (card.first_mes) {
      const firstMesTemplate = typeof card.first_mes === 'string' ? card.first_mes : String(card.first_mes);
      const firstMes = isStMacroEnabled() ? applyStMacros(firstMesTemplate, getRpMacroContext(conv)) : firstMesTemplate;
      conv.messages.push({
        role: 'assistant',
        content: firstMes,
        swipes: [firstMes],
        swipeIndex: 0
      });
    }

    if (!prepareConversationTransition()) return;
    conversations.unshift(conv);
    activeConvId = conv.id;
    messages = conv.messages;
    saveConversations();
    renderSidebar();
    renderMessages();
    restoreActiveDraft();
    updateTokenInfo();
    updateCharacterUI();

    showToast('Character imported: ' + charName, 'success');
    if (window.innerWidth <= 768) toggleSidebar();
  } catch (err) {
    showToast('Error importing character: ' + err.message, 'error');
  } finally {
    endLocalDataOperation();
  }
}

function updateCharacterUI() {
  const conv = getActiveConv();
  const infoBtn = document.getElementById('charInfoMenuItem');
  if (infoBtn) infoBtn.hidden = !conv?.characterCard;
  renderConversationHeader();
}

function showCharacterInfo() {
  const conv = getActiveConv();
  if (!conv || !conv.characterCard) return;
  const card = conv.characterCard;

  // Remove existing popup
  document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  overlay.onclick = () => { overlay.remove(); popup.remove(); };

  const popup = document.createElement('div');
  popup.className = 'char-info-popup';
  popup.setAttribute('aria-labelledby', 'characterInfoTitle');

  let html = '';
  if (conv.characterAvatar) {
    const safeAvatar = safeMediaUrl(conv.characterAvatar);
    if (safeAvatar) html += '<img class="char-info-avatar" src="' + escapeHTML(safeAvatar) + '" alt="">';
  }
  html += '<h3 id="characterInfoTitle">' + (card.name || 'Character').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</h3>';

  const fields = [
    ['Description', card.description],
    ['Personality', card.personality],
    ['Scenario', card.scenario],
    ['First Message', card.first_mes],
    ['System Prompt', card.system_prompt],
    ['Example Dialogue', card.mes_example],
    ['Creator Notes', card.creator_notes]
  ];
  fields.forEach(([label, value]) => {
    if (!value) return;
    html += '<div class="char-info-field"><div class="char-info-label">' + label + '</div>' +
      '<div class="char-info-value">' + value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div></div>';
  });

  html += '<button class="btn btn-primary" type="button" data-close-character style="margin-top:12px;width:100%">Close</button>';
  popup.innerHTML = html;
  const close = openTransientDialog(overlay, popup, popup.querySelector('[data-close-character]'));
  popup.querySelector('[data-close-character]').onclick = close;
}

// ============================================
// Voice Input
// ============================================
// Stop dictation and read-aloud without changing the composer's draft.
function stopVoiceInput() {
  const recognition = voiceRec;
  voiceRec = null;
  if (recognition) {
    recognition.onresult = null;
    recognition.onend = null;
    recognition.onerror = null;
    try { recognition.abort(); } catch (error) { console.warn('Voice input stop failed:', error); }
  }
  const button = document.getElementById('voiceBtn');
  button?.classList.remove('recording');
  button?.setAttribute('aria-pressed', 'false');
  button?.setAttribute('aria-label', 'Voice input');
  if (button) button.title = 'Voice input';
  stopReadAloud();
}

function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const btn = document.getElementById('voiceBtn');

  if (voiceRec) {
    stopVoiceInput();
    return;
  }

  stopReadAloud();
  const recognition = new SR();
  voiceRec = recognition;
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.continuous = true;

  const input = document.getElementById('chatInput');
  const startText = input.value;
  const originConvId = activeConvId;
  btn.classList.add('recording');
  btn.setAttribute('aria-pressed', 'true');
  btn.setAttribute('aria-label', 'Stop voice input');
  btn.title = 'Stop voice input';

  recognition.onresult = (e) => {
    if (voiceRec !== recognition || activeConvId !== originConvId) return;
    let transcript = '';
    for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
    input.value = startText + transcript;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  recognition.onend = () => { if (voiceRec === recognition) stopVoiceInput(); };
  recognition.onerror = event => {
    if (voiceRec !== recognition) return;
    stopVoiceInput();
    if (event.error !== 'aborted') showToast('Voice input failed. Check microphone permission and try again.', 'error');
  };
  try { recognition.start(); }
  catch (error) {
    stopVoiceInput();
    showToast('Could not start voice input. Check microphone permission and try again.', 'error');
  }
}

// Window bridge for inline handlers and external hooks
const __windowBridge = {
  // Share links (inline onclick in index.html; shareSelfTest is for the console)
  openShareDialog,
  shareConversation,
  unshareConversation,
  buildSharePayload,
  shareSafeContent,
  shareLinkFor,
  initShareView,
  shareSelfTest,
  // Projects (inline onclick in index.html)
  openProjectsModal,
  selectProjectInModal,
  newProjectFromModal,
  scheduleProjectAutosave,
  saveProjectFromModal,
  deleteProject,
  addProjectFiles,
  removeProjectDoc,
  showProjectPicker,
  assignConversationToProject,
  getProject,
  openModal,
  closeModal,
  closeTopModal,
  initModalAccessibility,
  formatRelativeTime,
  prefersReducedMotion,
  getScrollBehavior,
  announce,
  scrollMessagesToBottom,
  isDebugLoggingEnabled,
  isDebugTextIncluded,
  setDebugPreference,
  summarizeLlmPayloadForDebug,
  debugLog,
  debugLogPayload,
  renderDebugLogPreview,
  clearDebugLog,
  copyDebugSnapshot,
  isLocalRuntime,
  checkLocalUpdateStatus,
  renderLocalUpdateStatus,
  downloadUpdate,
  performSelfUpdate,
  showUpdateInstructions,
  showToast,
  applyTheme,
  applyMsgOverrides,
  toggleTheme,
  loadTheme,
  onThemeSelectChange,
  loadCustomColorPickers,
  resetCustomTheme,
  getCustomThemeFromPickers,
  liveCustomTheme,
  loadCustomFont,
  fetchAvailableModels,
  populateModelSelect,
  refreshModels,
  loadCachedModels,
  loadMemories,
  saveMemories,
  getMemoryPrompt,
  callApiNonStreaming,
  completeDraft,
  openCompareModels,
  suggestFollowUps,
  extractMemories,
  cleanupMemories,
  openManageMemories,
  openSearchTest,
  openSourcesDrawer,
  renderContextSources,
  buildSnippet,
  searchLocalDocs,
  openFileSearch,
  openSummaryModal,
  generateConversationSummary,
  saveConversationSummary,
  clearConversationSummary,
  openStatusPanel,
  parseCommand,
  handleCommand,
  handleManualSearch,
  handleFileSearch,
  buildConversationTranscript,
  deleteMemory,
  clearAllMemories,
  detectApiFormat,
  getLlmProviderInfo,
  formatModelForDisplay,
  getActiveProfile,
  getActiveProfileSummary,
  getConnectionSummary,
  suggestProfileName,
  getApiKey,
  setApiKey,
  getKeyStorageMode,
  getProviderPreset,
  applyProviderPreset,
  testConnection,
  renderConnectionChip,
  renderConnectionPicker,
  toggleConnectionPicker,
  closeConnectionPicker,
  renderConversationHeader,
  setAssistantLlmMetadata,
  prepareAnthropicMessages,
  renderGenImages,
  buildApiContent,
  extractImages,
  renderMarkdown,
  areEmotionSpritesEnabled,
  getEmotionSpriteSet,
  getEmotionSpritePrefix,
  getEmotionSpriteAssetUrl,
  renderEmotionSprites,
  addCodeCopyButtons,
  highlightCodeBlocks,
  addLineNumbers,
  renderMermaidBlocks,
  postRenderProcessing,
  estimateTokens,
  getMsgText,
  formatTokenCount,
  getMessageTokenCount,
  updateMessageTokenMetadata,
  getMessageLlmInfo,
  renderMessageMeta,
  renderRequestMeta,
  retryRequest,
  showRequestDetails,
  updateTokenInfo,
  openDB,
  idbPut,
  idbGet,
  idbGetAll,
  idbDelete,
  idbClear,
  idbPutAll,
  genId,
  saveConversations,
  debouncedSave,
  migratePersonaField,
  loadConversations,
  getActiveConv,
  createConversation,
  createTemporaryConversation,
  switchConversation,
  deleteConversation,
  clearAllConversations,
  setConversationView,
  setConversationSort,
  toggleBulkMode,
  toggleConversationSelection,
  toggleSelectAllConversations,
  bulkArchiveSelected,
  bulkDeleteSelected,
  archiveConversation,
  toggleActiveArchive,
  duplicateConversation,
  removeConversations,
  renderSidebar,
  showTagPicker,
  renderTagFilterBar,
  setTagFilter,
  filterConversations,
  toggleSidebar,
  toggleContextPanel,
  toggleProjectCollapse,
  toggleToolbarMenu,
  closeToolbarMenu,
  toggleSidebarMenu,
  closeSidebarMenu,
  toggleComposerMenu,
  closeComposerMenu,
  toggleSidebarOrganization,
  getSelectedModel,
  saveSetup,
  continueWithoutProvider,
  switchSettingsTab,
  openSettings,
  openSettingsSection,
  loadProfiles,
  saveProfiles,
  renderProfileSelect,
  renderProfileSummary,
  collectProfileSettingsFromInputs,
  applyProfileToInputs,
  applyProfile,
  applyProfileFromSelect,
  saveCurrentAsProfile,
  deleteSelectedProfile,
  saveSettingsTab,
  saveSettings,
  closeSettings,
  loadPresets,
  applyPreset,
  saveCurrentAsPreset,
  deleteSelectedPreset,
  importSTPreset,
  loadPromptEntries,
  savePromptEntries,
  migrateToPromptEntries,
  renderPromptEntries,
  addPromptEntry,
  deletePromptEntry,
  togglePromptEntry,
  updatePromptEntry,
  buildSystemMessages,
  buildRequestMessages,
  filterRequestHistory,
  openContextPreview,
  openContextSection,
  renderContextPanel,
  updateConversationGoal,
  saveConversationTools,
  compactOlderTurns,
  toggleComposerTools,
  closeComposerTools,
  maybeAddAvatar,
  renderMessages,
  renderEditMode,
  resendAfterEdit,
  swipeMsg,
  forkBranch,
  renderThinkingHTML,
  stripThinkTags,
  renderToolBlocksHTML,
  proxiedFetch,
  executeWebSearch,
  formatSearchResultsForModel,
  parseTextToolCalls,
  stripTextToolCalls,
  executeUrlFetch,
  formatUrlFetchResultForModel,
  streamResponse,
  updateSendBtnState,
  resolveWebSearchEnabled,
  sendMessage,
  queueFollowUpFromComposer,
  cancelQueuedFollowUp,
  cancelAllQueuedFollowUps,
  toggleFollowUpQueue,
  processQueuedFollowUps,
  regenerate,
  continueMessage,
  clearChat,
  exportConversation,
  exportAllConversations,
  importConversation,
  normalizeImportedData,
  applySelectedImport,
  updateImportStrategyUI,
  applyImport,
  renderStorageSummary,
  clearDataCategory,
  synapseSelfTest,
  closeCommandDropdown,
  handleCommandInput,
  handleCommandKeydown,
  syncSaveSettings,
  syncScheduleAutoPush,
  syncRunAutoPush,
  syncToggleAutoPush,
  renderSyncSettings,
  syncPushToGist,
  syncPullFromGist,
  syncGeneratePassphrase,
  syncTogglePassphraseVisibility,
  syncCopyPassphrase,
  syncRenderPairingQr,
  syncCopyPairingText,
  syncApplyPairingText,
  syncImportPairingQr,
  exportMarkdown,
  enterSelectMode,
  exitSelectMode,
  toggleMsgSelect,
  updateSelectCount,
  screenshotSelected,
  openGlobalSearch,
  performGlobalSearch,
  openChatSearch,
  closeChatSearch,
  clearChatHighlights,
  debouncedChatSearch,
  performChatSearch,
  navigateChatSearch,
  resizeImageIfNeeded,
  extractPdfText,
  extractDocxText,
  extractRtfText,
  extractLegacyDocText,
  isTextLikeFile,
  readAttachmentFile,
  handleFileSelect,
  renderPreviews,
  clearModelOverride,
  setModelOverride,
  closeMentionDropdown,
  handleMentionInput,
  selectMention,
  handleMentionKeydown,
  extractCharaFromPNG,
  normalizeCharaCard,
  buildCharaDescription,
  importCharacterCard,
  updateCharacterUI,
  showCharacterInfo,
  toggleVoice
};
Object.assign(window, __windowBridge);

export function getWindowBridge() {
  return __windowBridge;
}
