import { getFocusableElements, trapFocus } from './lib/dom-utils.js';
import { escapeHTML, isLightColor } from './lib/text-utils.js';
// ============================================
// State
// ============================================
let conversations = [];
let projects = [];
let activeConvId = null;
// True when the page is showing someone else's shared conversation via ?share=.
// Load and save of local data are both suppressed in that mode — see saveConversations.
let readOnlyShare = false;
let messages = [];
let abortController = null;
let streaming = false;
let userScrolledAway = false;
let _suppressScrollFlag = false;
let pendingAttachments = [];
let voiceRec = null;
let modelOverride = null;
let mentionActive = false;
let mentionIdx = 0;
let activeTagFilter = null;
let conversationView = localStorage.getItem('assistantConversationView') || 'active';
let conversationSort = localStorage.getItem('assistantConversationSort') || 'updated';
let bulkMode = false;
const selectedConversationIds = new Set();
let pendingImport = null;
let commandActive = false;
let commandIdx = 0;
let tokenInfoRequestId = 0;
let lastSearchStatus = { ok: null, error: null, at: null, query: '' };
let openModalStack = [];
const modalFocusReturn = new WeakMap();
let transientDialogFocusReturn = null;
let transientDialogClose = null;
let toolbarMenuFocusReturn = null;
let composerToolsFocusReturn = null;
let globalSearchDismiss = null;
let debugLogBuffer = [];
let localUpdateState = { status: 'idle', message: 'Not checked', details: '' };

const APP_VERSION = {
  name: 'Synapse',
  buildDate: '2026-08-12',
  updateUrl: 'https://platberlitz.github.io/assistant/version.json'
};

const SYNC_GIST_API_URL = 'https://api.github.com/gists';
const SYNC_KDF_ITERATIONS = 120000;
const SYNC_SETTINGS_KEYS = [
  'llmModel', 'llmApiFormat', 'llmStreaming', 'llmEnterSend', 'llmTemperature',
  'llmMaxTokens', 'llmPromptCache', 'llmThinking', 'llmThinkingEffort',
  'llmExtraParams', 'llmExcludeParams', 'llmPrefill', 'llmPersona',
  'llmEnableStMacros', 'llmRpUserName', 'llmInputCost', 'llmOutputCost',
  'llmWebSearch', 'llmForceSearch', 'llmMemoryEnabled', 'llmHoldScreenshot',
  'llmCacheEnabled', 'llmPromptEntries', 'assistantPresets', 'assistantProfiles', 'assistantTheme',
  'assistantCustomTheme', 'assistantFont', 'assistantMsgFontSize', 'assistantMsgMaxWidth',
  'llmContextWindow', 'llmUrlFetch', 'llmToolConfirm'
];
const SYNC_PROFILE_SECRET_KEYS = [
  'llmApiKey', 'llmSearchApiKey', 'assistantSyncGistToken', 'assistantSyncPassphrase'
];
const PROFILE_SECRET_KEY_RE = /(?:api[-_ ]?key|token|secret|passphrase|password|authorization|credential|cookie)/i;

function isCredentialSettingKey(key) {
  return SYNC_PROFILE_SECRET_KEYS.includes(key) || PROFILE_SECRET_KEY_RE.test(String(key || ''));
}

function stripCredentialSettings(settings) {
  const safe = {};
  Object.entries(settings && typeof settings === 'object' ? settings : {}).forEach(([key, value]) => {
    if (!isCredentialSettingKey(key)) safe[key] = value;
  });
  return safe;
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
  const safe = stripCredentialSettings(settings);
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

const PROVIDER_PRESETS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiFormat: 'openai', keyRequired: true },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', apiFormat: 'anthropic', keyRequired: true },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiFormat: 'openai', keyRequired: true },
  ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', apiFormat: 'openai', keyRequired: false },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiFormat: 'openai', keyRequired: false },
  custom: { label: 'Custom', baseUrl: '', apiFormat: 'auto', keyRequired: false }
};

const COMMAND_REGISTRY = [
  { name: 'search', aliases: ['web', 's'], usage: '/search <query>', description: 'Search the web directly' },
  { name: 'files', aliases: ['file', 'docs', 'doc'], usage: '/files <query>', description: 'Search attached text locally' }
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

function openModal(modalOrId, focusSelector) {
  const modal = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
  if (!modal) return;
  const dialog = modal.querySelector('.modal') || modal;

  if (!modal.classList.contains('open')) {
    modalFocusReturn.set(modal, document.activeElement instanceof HTMLElement ? document.activeElement : null);
    modal.classList.add('open');
  }
  modal.setAttribute('aria-hidden', 'false');

  if (!openModalStack.includes(modal)) openModalStack.push(modal);

  const focusTarget = (focusSelector && modal.querySelector(focusSelector)) || getFocusableElements(dialog)[0] || dialog;
  requestAnimationFrame(() => {
    if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
  });
}

function closeModal(modalOrId, restoreFocus = true) {
  const modal = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  openModalStack = openModalStack.filter(m => m !== modal);

  if (!restoreFocus) return;
  const prevFocus = modalFocusReturn.get(modal);
  if (prevFocus && document.contains(prevFocus) && typeof prevFocus.focus === 'function') {
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
    modal.setAttribute('aria-hidden', modal.classList.contains('open') ? 'false' : 'true');
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

function sanitizeErrorDetail(error) {
  if (error == null || String(error?.message || error || '').trim() === '') return '';
  let text = String(error?.message || error);
  text = text.replace(/(authorization|x-api-key|api[-_ ]?key|token|secret)\s*[:=]\s*[^\s,;]+/ig, '$1: [redacted]');
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
  modelEl.textContent = model ? (formatModelForDisplay(model, 25) + (profile?.name ? ' · ' + profile.name : '')) : 'Set up a provider';
  if (chip) chip.setAttribute('aria-label', model ? 'API connection: ' + provider.name + ', ' + model + (profile?.name ? ', profile ' + profile.name : '') : 'Open API settings');
}

function getKeyStorageMode() {
  const saved = localStorage.getItem('llmKeyStorage');
  if (saved === 'session' || saved === 'remember') return saved;
  // Legacy llmApiKey was always localStorage, so keep it remembered.
  return localStorage.getItem('llmApiKey') ? 'remember' : (sessionStorage.getItem('llmApiKey') ? 'session' : 'remember');
}

function getApiKey() {
  return (sessionStorage.getItem('llmApiKey') || localStorage.getItem('llmApiKey') || '').trim();
}

function setApiKey(key, mode = getKeyStorageMode()) {
  const value = String(key || '').trim();
  localStorage.setItem('llmKeyStorage', mode === 'session' ? 'session' : 'remember');
  localStorage.removeItem('llmApiKey');
  sessionStorage.removeItem('llmApiKey');
  if (value) (mode === 'session' ? sessionStorage : localStorage).setItem('llmApiKey', value);
  if (mode === 'session') scrubProfileSecrets('llmApiKey');
}

function scrubProfileSecrets(field = null) {
  const profiles = loadProfiles();
  let changed = false;
  profiles.forEach(profile => {
    if (!profile.settings) return;
    const safe = field
      ? Object.fromEntries(Object.entries(profile.settings).filter(([key]) => key !== field))
      : stripCredentialSettings(profile.settings);
    if (JSON.stringify(safe) !== JSON.stringify(profile.settings)) {
      profile.settings = safe;
      changed = true;
    }
  });
  if (changed) saveProfiles(profiles);
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

function normalizeConversationRecord(raw) {
  const conv = raw && typeof raw === 'object' ? raw : {};
  const normalized = { ...conv };
  normalized.id = String(normalized.id || genId());
  normalized.title = String(normalized.title || 'New Chat');
  normalized.createdAt = Number(normalized.createdAt) || Date.now();
  normalized.updatedAt = Number(normalized.updatedAt) || normalized.createdAt;
  normalized.messages = Array.isArray(normalized.messages) ? normalized.messages : [];
  normalized.messages = normalized.messages.filter(m => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'));
  normalized.messages.forEach(message => {
    if (Array.isArray(message.content)) {
      message.content = message.content.map(part => {
        if (part?.type === 'image_url') return { ...part, image_url: { ...(part.image_url || {}), url: safeMediaUrl(part.image_url?.url) } };
        if (part?.type === 'file') return { ...part, file: { ...(part.file || {}), url: safeFileUrl(part.file?.url) } };
        return part;
      });
    }
    if (Array.isArray(message.images)) message.images = message.images.map(safeMediaUrl).filter(Boolean);
    if (Array.isArray(message.swipeImages)) message.swipeImages = message.swipeImages.map(images => (Array.isArray(images) ? images.map(safeMediaUrl).filter(Boolean) : []));
    if (Array.isArray(message.swipeSources)) message.swipeSources = message.swipeSources.map(sources => (Array.isArray(sources) ? sources.map(source => ({ ...source, url: safeHttpUrl(source?.url) })).filter(source => source.url) : []));
    if (Array.isArray(message.swipeToolUse)) message.swipeToolUse = message.swipeToolUse.map(blocks => (Array.isArray(blocks) ? blocks.map(block => ({
      ...block,
      url: block?.url ? safeHttpUrl(block.url) : block?.url,
      results: Array.isArray(block?.results) ? block.results.map(result => ({ ...result, url: safeHttpUrl(result?.url) })).filter(result => result.url || result.title) : block?.results
    })) : []));
    if (message.role === 'assistant') {
      if (!Array.isArray(message.swipes) || message.swipes.length === 0) message.swipes = [typeof message.content === 'string' ? message.content : ''];
      if (!Number.isInteger(message.swipeIndex)) message.swipeIndex = 0;
      message.swipeIndex = Math.max(0, Math.min(message.swipes.length - 1, message.swipeIndex));
    }
    if (message.includeInContext !== false) message.includeInContext = true;
  });
  if (normalized.characterAvatar) normalized.characterAvatar = safeMediaUrl(normalized.characterAvatar);
  if (!normalized.toolPolicy || typeof normalized.toolPolicy !== 'object') normalized.toolPolicy = null;
  if (!normalized.draft || typeof normalized.draft !== 'object') normalized.draft = { text: '', attachments: [] };
  normalized.draft.attachments = cloneDraftAttachments(normalized.draft.attachments);
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
    urlFetch: localStorage.getItem('llmUrlFetch') !== 'false',
    confirm: localStorage.getItem('llmToolConfirm') === 'true'
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
  if (readOnlyShare) return Promise.resolve();
  if (!db) {
    try {
      localStorage.setItem('assistantConversations', JSON.stringify(conversations));
      localStorage.setItem('assistantActiveConvId', activeConvId || '');
    } catch(e) { return Promise.reject(e); }
    return Promise.resolve();
  }
  try { localStorage.setItem('assistantActiveConvId', activeConvId || ''); } catch(e) {}
  return idbPutAll('conversations', conversations)
    .then(() => idbPut('meta', { key: 'activeConvId', value: activeConvId || '' }));
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
      text: includeText ? part.text || '' : shortenForDebug(part.text || '')
    };
  }
  if (type === 'image_url') {
    const url = part.image_url?.url || '';
    return { type, imageUrl: url ? shortenForDebug(url, 80) : '' };
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
      text: includeText ? message.content : shortenForDebug(message.content)
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
      arguments: includeText ? tc.function?.arguments : shortenForDebug(tc.function?.arguments || '')
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
      text: includeText ? systemText : shortenForDebug(systemText)
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
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ============================================
// Theme Presets
// ============================================
const themePresets = {
  dark:       { bg:'#0a0a0f', sidebar:'#14141a', cardBorder:'rgba(255,255,255,0.08)', textPrimary:'rgba(255,255,255,0.95)', textSecondary:'rgba(255,255,255,0.6)', accent:'#6366f1', accentHover:'#818cf8', msgUser:'#6366f1', msgAssistant:'rgba(255,255,255,0.08)' },
  light:      { bg:'#f5f5f7', sidebar:'#eeeef2', cardBorder:'rgba(0,0,0,0.1)', textPrimary:'rgba(0,0,0,0.9)', textSecondary:'rgba(0,0,0,0.5)', accent:'#6366f1', accentHover:'#818cf8', msgUser:'#6366f1', msgAssistant:'rgba(0,0,0,0.05)' },
  nord:       { bg:'#2e3440', sidebar:'#3b4252', cardBorder:'#434c5e', textPrimary:'#eceff4', textSecondary:'#d8dee9', accent:'#88c0d0', accentHover:'#8fbcbb', msgUser:'#5e81ac', msgAssistant:'#3b4252' },
  catppuccin: { bg:'#1e1e2e', sidebar:'#313244', cardBorder:'#45475a', textPrimary:'#cdd6f4', textSecondary:'#a6adc8', accent:'#cba6f7', accentHover:'#b4befe', msgUser:'#cba6f7', msgAssistant:'#313244' },
  dracula:    { bg:'#282a36', sidebar:'#44475a', cardBorder:'#6272a4', textPrimary:'#f8f8f2', textSecondary:'#bd93f9', accent:'#bd93f9', accentHover:'#ff79c6', msgUser:'#bd93f9', msgAssistant:'#44475a' },
  gruvbox:    { bg:'#282828', sidebar:'#3c3836', cardBorder:'#504945', textPrimary:'#ebdbb2', textSecondary:'#a89984', accent:'#fabd2f', accentHover:'#fe8019', msgUser:'#fabd2f', msgAssistant:'#3c3836' },
  tokyonight: { bg:'#1a1b26', sidebar:'#24283b', cardBorder:'#414868', textPrimary:'#c0caf5', textSecondary:'#565f89', accent:'#7aa2f7', accentHover:'#bb9af7', msgUser:'#7aa2f7', msgAssistant:'#24283b' },
  solarized:  { bg:'#002b36', sidebar:'#073642', cardBorder:'#586e75', textPrimary:'#fdf6e3', textSecondary:'#93a1a1', accent:'#268bd2', accentHover:'#2aa198', msgUser:'#268bd2', msgAssistant:'#073642' },
  onedark:    { bg:'#282c34', sidebar:'#21252b', cardBorder:'#3e4451', textPrimary:'#abb2bf', textSecondary:'#5c6370', accent:'#61afef', accentHover:'#c678dd', msgUser:'#61afef', msgAssistant:'#2c313c' },
  rosepine:   { bg:'#191724', sidebar:'#1f1d2e', cardBorder:'#26233a', textPrimary:'#e0def4', textSecondary:'#908caa', accent:'#c4a7e7', accentHover:'#ebbcba', msgUser:'#c4a7e7', msgAssistant:'#1f1d2e' },
  // Gallery
  monochrome:     { bg:'#131313', sidebar:'#222222', cardBorder:'#333333', textPrimary:'#e0e0e0', textSecondary:'rgba(224,224,224,0.6)', accent:'#FCFCFC', accentHover:'#ffffff', msgUser:'#FCFCFC', msgAssistant:'#222222' },
  pewter:         { bg:'#222222', sidebar:'#333333', cardBorder:'#444444', textPrimary:'#e0e0e0', textSecondary:'rgba(224,224,224,0.6)', accent:'#D9D9D9', accentHover:'#eeeeee', msgUser:'#D9D9D9', msgAssistant:'#333333' },
  deepSea:        { bg:'#061234', sidebar:'#0f1e44', cardBorder:'#182a54', textPrimary:'#d0e0d0', textSecondary:'rgba(208,224,208,0.6)', accent:'#50AA09', accentHover:'#6ec42a', msgUser:'#50AA09', msgAssistant:'#0f1e44' },
  gunmetal:       { bg:'#1E212B', sidebar:'#2a2e3a', cardBorder:'#363a48', textPrimary:'#c8cdd2', textSecondary:'rgba(200,205,210,0.6)', accent:'#5B6B76', accentHover:'#7b8b96', msgUser:'#5B6B76', msgAssistant:'#2a2e3a' },
  clearSky:       { bg:'#1e4c84', sidebar:'#2a5a94', cardBorder:'#3668a4', textPrimary:'#e0f0ff', textSecondary:'rgba(224,240,255,0.6)', accent:'#7ed6ff', accentHover:'#9ee6ff', msgUser:'#7ed6ff', msgAssistant:'#2a5a94' },
  cobalt:         { bg:'#0D55B2', sidebar:'#1a64c0', cardBorder:'#2874d0', textPrimary:'#e0f0f8', textSecondary:'rgba(224,240,248,0.6)', accent:'#249CB6', accentHover:'#44bcd6', msgUser:'#249CB6', msgAssistant:'#1a64c0' },
  nightshade:     { bg:'#07040C', sidebar:'#16121e', cardBorder:'#251e30', textPrimary:'#e0d8e8', textSecondary:'rgba(224,216,232,0.6)', accent:'#BDA8DC', accentHover:'#ddc8fc', msgUser:'#BDA8DC', msgAssistant:'#16121e' },
  plumWine:       { bg:'#1E2233', sidebar:'#2a2e44', cardBorder:'#363a54', textPrimary:'#dcd0e0', textSecondary:'rgba(220,208,224,0.6)', accent:'#822195', accentHover:'#a241b5', msgUser:'#822195', msgAssistant:'#2a2e44' },
  neonDusk:       { bg:'#495495', sidebar:'#5a64a5', cardBorder:'#6a74b5', textPrimary:'#f0e0f8', textSecondary:'rgba(240,224,248,0.6)', accent:'#ff7edb', accentHover:'#ff9eeb', msgUser:'#ff7edb', msgAssistant:'#5a64a5' },
  lavenderHaze:   { bg:'#5D69CE', sidebar:'#6d79de', cardBorder:'#7d89ee', textPrimary:'#f0e8f0', textSecondary:'rgba(240,232,240,0.6)', accent:'#A45785', accentHover:'#c477a5', msgUser:'#A45785', msgAssistant:'#6d79de' },
  jadeMist:       { bg:'#14161E', sidebar:'#20222e', cardBorder:'#2c2e3e', textPrimary:'#d8e8e0', textSecondary:'rgba(216,232,224,0.6)', accent:'#95D3AF', accentHover:'#b5f3cf', msgUser:'#95D3AF', msgAssistant:'#20222e' },
  mossStone:      { bg:'#373C3F', sidebar:'#454b4f', cardBorder:'#555b5f', textPrimary:'#d8e8d8', textSecondary:'rgba(216,232,216,0.6)', accent:'#83B38E', accentHover:'#a3d3ae', msgUser:'#83B38E', msgAssistant:'#454b4f' },
  emeraldForest:  { bg:'#295233', sidebar:'#376243', cardBorder:'#457253', textPrimary:'#d8f0d0', textSecondary:'rgba(216,240,208,0.6)', accent:'#89E574', accentHover:'#a9ff94', msgUser:'#89E574', msgAssistant:'#376243' },
  winterBreeze:   { bg:'#141b1e', sidebar:'#20282e', cardBorder:'#2c343e', textPrimary:'#d0e0f0', textSecondary:'rgba(208,224,240,0.6)', accent:'#67b0e8', accentHover:'#87d0ff', msgUser:'#67b0e8', msgAssistant:'#20282e' },
  neonNoir:       { bg:'#000000', sidebar:'#141414', cardBorder:'#282828', textPrimary:'#e0e0e0', textSecondary:'rgba(224,224,224,0.6)', accent:'#fada16', accentHover:'#ffea46', msgUser:'#fada16', msgAssistant:'#141414' },
  hotPink:        { bg:'#2d2a2e', sidebar:'#3d3a3e', cardBorder:'#4d4a4e', textPrimary:'#f8f8f2', textSecondary:'rgba(248,248,242,0.6)', accent:'#f92672', accentHover:'#ff4692', msgUser:'#f92672', msgAssistant:'#3d3a3e' },
  roseQuartz:     { bg:'#161616', sidebar:'#262626', cardBorder:'#363636', textPrimary:'#e8d8e0', textSecondary:'rgba(232,216,224,0.6)', accent:'#EE5396', accentHover:'#ff73b6', msgUser:'#EE5396', msgAssistant:'#262626' },
  ember:          { bg:'#0D0D0D', sidebar:'#1d1d1d', cardBorder:'#2d2d2d', textPrimary:'#e8d8c8', textSecondary:'rgba(232,216,200,0.6)', accent:'#E0701E', accentHover:'#ff903e', msgUser:'#E0701E', msgAssistant:'#1d1d1d' },
  moltenCore:     { bg:'#351810', sidebar:'#452820', cardBorder:'#553830', textPrimary:'#f0e0c8', textSecondary:'rgba(240,224,200,0.6)', accent:'#FABD2F', accentHover:'#ffdd4f', msgUser:'#FABD2F', msgAssistant:'#452820' },
  orchidTeal:     { bg:'#821595', sidebar:'#9225a5', cardBorder:'#a235b5', textPrimary:'#e0f0f0', textSecondary:'rgba(224,240,240,0.6)', accent:'#259E9C', accentHover:'#45bebc', msgUser:'#259E9C', msgAssistant:'#9225a5' },
  acidGlow:       { bg:'#4B0082', sidebar:'#5b1092', cardBorder:'#6b20a2', textPrimary:'#d8f8e0', textSecondary:'rgba(216,248,224,0.6)', accent:'#00FF66', accentHover:'#33ff88', msgUser:'#00FF66', msgAssistant:'#5b1092' },
  fjord:          { bg:'#2E3440', sidebar:'#3b4252', cardBorder:'#434c5e', textPrimary:'#eceff4', textSecondary:'#d8dee9', accent:'#88C0D0', accentHover:'#a8e0f0', msgUser:'#88C0D0', msgAssistant:'#3b4252' },
  oxide:          { bg:'#0f1115', sidebar:'#151922', cardBorder:'#252a36', textPrimary:'#e8e6e3', textSecondary:'#a8a3a0', accent:'#f26a2e', accentHover:'#ff7b43', msgUser:'#f26a2e', msgAssistant:'#1b202b', borderRadius:'16px', msgMaxWidth:'72%', codeBg:'rgba(242,106,46,0.08)' },
  blueprint:      { bg:'#0b1220', sidebar:'#101a2e', cardBorder:'#1e2b46', textPrimary:'#e6edf6', textSecondary:'#9fb0c6', accent:'#4aa3ff', accentHover:'#6bb6ff', msgUser:'#4aa3ff', msgAssistant:'#131f33', borderRadius:'18px', msgMaxWidth:'70%', codeBg:'rgba(74,163,255,0.10)' },
  paperInk:       { bg:'#f6f3ee', sidebar:'#f0ece5', cardBorder:'#d8d3c8', textPrimary:'#1f1b16', textSecondary:'#6e645b', accent:'#2f6fb2', accentHover:'#3f82c8', msgUser:'#2f6fb2', msgAssistant:'#ffffff', borderRadius:'20px', msgMaxWidth:'68%', codeBg:'rgba(47,111,178,0.08)' },
  moss:           { bg:'#101612', sidebar:'#161d17', cardBorder:'#2a332c', textPrimary:'#e0e7df', textSecondary:'#a6b2a4', accent:'#7ac27b', accentHover:'#8fd990', msgUser:'#7ac27b', msgAssistant:'#1a231c', borderRadius:'16px', msgMaxWidth:'72%', codeBg:'rgba(122,194,123,0.10)' },
  claude:         { bg:'#FAF9F5', sidebar:'#EBE7DF', cardBorder:'rgba(0,0,0,0.08)', textPrimary:'#1a1915', textSecondary:'rgba(26,25,21,0.55)', accent:'#D97757', accentHover:'#C4684A', msgUser:'#D97757', msgAssistant:'#F3F0E8', borderRadius:'24px', msgMaxWidth:'70%', codeBg:'rgba(0,0,0,0.04)' },
  claudeDark:     { bg:'#1a1915', sidebar:'#1a1915', cardBorder:'rgba(255,255,255,0.08)', textPrimary:'#e8e4db', textSecondary:'rgba(232,228,219,0.5)', accent:'#D97757', accentHover:'#C4684A', msgUser:'#D97757', msgAssistant:'#2b2a27', borderRadius:'24px', msgMaxWidth:'70%', codeBg:'rgba(0,0,0,0.3)' }
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
  s.setProperty('--accent-text', isLightColor(t.accent) ? '#101014' : '#f7f8ff');
  s.setProperty('--msg-user-text', isLightColor(t.msgUser) ? '#101014' : '#f7f8ff');
  const bgLight = isLightColor(t.bg);
  s.setProperty('--overlay-10', bgLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)');
  s.setProperty('--overlay-15', bgLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.15)');
  s.setProperty('--overlay-25', bgLight ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.25)');
  s.setProperty('--border-radius', t.borderRadius || '16px');
  s.setProperty('--msg-max-width', t.msgMaxWidth || '75%');
  s.setProperty('--msg-padding', t.msgPadding || '12px 16px');
  s.setProperty('--msg-font-size', t.msgFontSize || '0.95em');
  s.setProperty('--code-bg', t.codeBg || (bgLight ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.3)'));
  s.setProperty('--card-bg', bgLight ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)');
  s.setProperty('--error-color', bgLight ? '#dc2626' : '#ff7777');
  s.setProperty('--danger-color', bgLight ? '#dc2626' : '#ef4444');
  s.setProperty('--danger-hover', bgLight ? '#b91c1c' : '#dc2626');
  s.setProperty('--success-color', '#22c55e');
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

function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
      || host.endsWith('.local') || /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(host);
  } catch { return false; }
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

async function fetchApiWithHttpSupport(url, options, baseUrl) {
  const apiBase = String(baseUrl || '').trim();
  const corsProxy = getCorsProxyUrl();
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

    // Non-local http:// URL: try proxy first, fall back to direct on proxy errors.
    try {
      const proxyResp = await tryProxyFetch();
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
    if (!isMixedContentSensitiveApiBase(apiBase) || !isNetworkLikeFetchError(err)) throw err;
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

async function fetchAvailableModelMetadata(baseUrl, apiKey, providerName = inferProviderKey({ llmProxyUrl: baseUrl }), apiFormat = '') {
  const provider = getProviderPreset(providerName);
  const normalizedBase = String(baseUrl || '').replace(/\/+$/, '');
  const url = providerName === 'ollama' && /\/v1$/i.test(normalizedBase)
    ? normalizedBase.replace(/\/v1$/i, '') + '/api/tags'
    : normalizedBase + '/models';
  const resp = await fetchApiWithHttpSupport(url, {
    headers: buildProviderHeaders(providerName === 'anthropic' || apiFormat === 'anthropic' ? 'anthropic' : provider.apiFormat, apiKey)
  }, baseUrl);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  return normalizeModelMetadata(data);
}

async function fetchAvailableModels(baseUrl, apiKey) {
  const providerName = inferProviderKey({ llmProxyUrl: baseUrl });
  const metadata = await fetchAvailableModelMetadata(baseUrl, apiKey, providerName, localStorage.getItem('llmApiFormat') || '');
  const map = {};
  metadata.forEach(model => { if (model.context_length) map[model.id] = model.context_length; });
  try { localStorage.setItem('llmModelMetadata', JSON.stringify({ ...(JSON.parse(localStorage.getItem('llmModelMetadata') || '{}')), ...map })); } catch(e) {}
  return metadata.map(model => model.id);
}

function populateModelSelect(target, models) {
  const select = document.getElementById(target === 'setup' ? 'setupModelSelect' : 'setModelSelect');
  const currentModel = localStorage.getItem('llmModel') || '';
  select.innerHTML = '<option value="">-- Select a model --</option>';
  models.sort().forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    if (m === currentModel) opt.selected = true;
    select.appendChild(opt);
  });
}

async function refreshModels(target, btnEl) {
  const proxyInput = document.getElementById(target === 'setup' ? 'setupProxy' : 'setProxy');
  const keyInput = document.getElementById(target === 'setup' ? 'setupKey' : 'setKey');
  let baseUrl = proxyInput.value.trim().replace(/\/(chat\/completions|messages)\/?$/, '');
  const apiKey = keyInput.value.trim();
  const providerName = document.getElementById(target === 'setup' ? 'setupProvider' : 'setProvider')?.value || inferProviderKey({ llmProxyUrl: baseUrl });
  if (!baseUrl || (providerRequiresKey({ llmProvider: providerName }) && !apiKey)) { showToast(providerRequiresKey({ llmProvider: providerName }) ? 'Enter Base URL and API Key first.' : 'Enter Base URL first.', 'error'); return; }
  const btn = btnEl || document.activeElement;
  btn.classList.add('spinning');
  btn.disabled = true;
  try {
    const models = await fetchAvailableModels(baseUrl, apiKey);
    localStorage.setItem('llmModelList', JSON.stringify(models));
    populateModelSelect(target, models);
  } catch (e) {
    showToast('Failed to fetch models: ' + e.message, 'error');
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
  }
}

function loadCachedModels(target) {
  try {
    const cached = JSON.parse(localStorage.getItem('llmModelList') || '[]');
    if (cached.length > 0) populateModelSelect(target, cached);
  } catch(e) { console.warn('Cached model list parse error:', e); }
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
  return parseEnabledSetting(localStorage.getItem('llmMemoryEnabled'));
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
      if (normalizedIdb.changed) await saveMemories(normalizedIdb.memories);
      if (normalizedIdb.memories.length > 0) return normalizedIdb.memories;
    } catch(e) {}
  }

  try {
    const legacyRaw = JSON.parse(localStorage.getItem('assistantMemories') || '[]');
    const normalizedLegacy = normalizeMemoryList(legacyRaw);
    if (normalizedLegacy.memories.length > 0 || normalizedLegacy.changed) {
      await saveMemories(normalizedLegacy.memories);
      if (db) localStorage.removeItem('assistantMemories');
    }
    return normalizedLegacy.memories;
  } catch(e) { return []; }
}

async function saveMemories(memories) {
  if (readOnlyShare) return;
  const normalized = normalizeMemoryList(memories).memories;
  if (!db) {
    localStorage.setItem('assistantMemories', JSON.stringify(normalized));
    return;
  }
  await idbPutAll('memories', normalized);
}

async function getMemoryPrompt() {
  if (!isMemoryEnabled()) return '';
  const memories = await loadMemories();
  if (memories.length === 0) return '';
  return 'User memories (facts learned from previous conversations):\n' +
    memories.map(m => '- ' + m.text).join('\n');
}

async function callApiNonStreaming(messages) {
  const baseUrl = (localStorage.getItem('llmProxyUrl') || '').replace(/\/+$/, '');
  const apiKey = getApiKey();
  const model = localStorage.getItem('llmModel') || '';
  const format = localStorage.getItem('llmApiFormat') && localStorage.getItem('llmApiFormat') !== 'auto'
    ? localStorage.getItem('llmApiFormat') : detectApiFormat(model);

  let url, headers, body;
  if (format === 'anthropic') {
    url = baseUrl + '/messages';
    headers = buildProviderHeaders('anthropic', apiKey);
    const prepared = prepareAnthropicMessages(messages);
    body = { model, system: prepared.system, messages: prepared.messages, max_tokens: 512, stream: false };
  } else {
    url = baseUrl + '/chat/completions';
    headers = buildProviderHeaders('openai', apiKey);
    body = { model, messages, stream: false, max_tokens: 512 };
  }

  const resp = await fetchApiWithHttpSupport(url, { method: 'POST', headers, body: JSON.stringify(body) }, baseUrl);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();

  if (format === 'anthropic') {
    return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  }
  return data.choices?.[0]?.message?.content || '';
}

async function extractMemories(conversationMessages) {
  if (!isMemoryEnabled()) return;

  const existing = await loadMemories();
  const existingText = existing.map(m => '- ' + m.text).join('\n') || '(none yet)';

  const extractPrompt = [
    { role: 'system', content: `You are a memory extraction system. Given a conversation, identify important facts about the user worth remembering for future conversations (preferences, personal details, projects, interests, opinions).

Current memories:
${existingText}

Respond ONLY with a JSON array of new memory strings to add. If there's nothing new worth remembering, respond with []. Do not repeat existing memories. Keep each memory concise (1 sentence). Maximum 3 new memories per extraction.

Example response: ["User prefers TypeScript over JavaScript", "User is building a music app"]` },
    ...conversationMessages.filter(m => m.role !== 'system').slice(-10)
  ];

  try {
    const response = await callApiNonStreaming(extractPrompt);
    const newMemories = JSON.parse(response);
    if (Array.isArray(newMemories) && newMemories.length > 0) {
      const memories = await loadMemories();
      newMemories.forEach(text => {
        if (typeof text === 'string' && text.trim()) {
          memories.push({ id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2,5), text: text.trim(), createdAt: Date.now() });
        }
      });
      await saveMemories(memories);
      cleanupMemories(); // fire-and-forget, has its own cooldown
    }
  } catch(e) { /* silent fail — memory is best-effort */ }
}

let _lastCleanup = 0;
async function cleanupMemories() {
  if (Date.now() - _lastCleanup < 300000) return; // 5-min cooldown
  const memories = await loadMemories();
  if (memories.length < 5) return;

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

  try {
    const response = await callApiNonStreaming(prompt);
    const result = JSON.parse(response);
    if (result.remove && result.remove.length > 0) {
      const cleaned = memories.filter(m => !result.remove.includes(m.id));
      await saveMemories(cleaned);
    }
    _lastCleanup = Date.now();
  } catch(e) { /* silent fail */ }
}

function openManageMemories() {
  document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';

  const popup = document.createElement('div');
  popup.className = 'char-info-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-modal', 'true');
  popup.setAttribute('aria-labelledby', 'sourcesDrawerTitle');

  async function renderMemoryList() {
    const memories = await loadMemories();
    let html = '<h3>Memories (' + memories.length + ')</h3>';
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
      html += '<button class="btn btn-secondary" style="width:100%;margin-bottom:8px;padding:8px;font-size:0.8em" onclick="if(confirm(\'Clear all memories?\')){saveMemories([]).then(()=>openManageMemories())}">Clear All</button>';
    }
    html += '<button class="btn btn-primary" style="width:100%;padding:8px" onclick="this.closest(\'.char-info-popup\').previousElementSibling.click()">Close</button>';
    popup.innerHTML = html;
    popup.querySelectorAll('[data-memory-id]').forEach(btn => {
      btn.addEventListener('click', () => deleteMemory(btn.dataset.memoryId));
    });
  }

  overlay.onclick = () => { overlay.remove(); popup.remove(); };
  renderMemoryList();
  document.body.appendChild(overlay);
  document.body.appendChild(popup);
}

function openSearchTest() {
  document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';

  const popup = document.createElement('div');
  popup.className = 'char-info-popup';

  popup.innerHTML =
    '<h3>Search Test</h3>' +
    '<div style="color:var(--text-secondary);font-size:0.85em;margin-bottom:12px">Runs a live query using your Search API settings.</div>' +
    '<input type="text" id="searchTestInput" placeholder="Search query..." style="width:100%;padding:10px;font-family:inherit;font-size:0.9em;background:var(--hover);border:1px solid var(--card-border);border-radius:8px;color:var(--text-primary);outline:none">' +
    '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="btn btn-primary" id="searchTestRun" style="flex:1;padding:8px">Run</button>' +
      '<button class="btn btn-secondary" id="searchTestClose" style="flex:1;padding:8px">Close</button>' +
    '</div>' +
    '<div id="searchTestStatus" style="margin-top:12px;font-size:0.85em;color:var(--text-secondary)"></div>' +
    '<div id="searchTestResults" style="margin-top:8px;display:flex;flex-direction:column;gap:8px"></div>';

  const close = () => { overlay.remove(); popup.remove(); };
  overlay.onclick = close;

  document.body.appendChild(overlay);
  document.body.appendChild(popup);

  const input = popup.querySelector('#searchTestInput');
  const runBtn = popup.querySelector('#searchTestRun');
  const closeBtn = popup.querySelector('#searchTestClose');
  const statusEl = popup.querySelector('#searchTestStatus');
  const resultsEl = popup.querySelector('#searchTestResults');

  closeBtn.onclick = close;

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
    const q = input.value.trim();
    if (!q) { statusEl.textContent = 'Enter a query to test.'; resultsEl.innerHTML = ''; return; }
    statusEl.textContent = 'Searching...';
    resultsEl.innerHTML = '';
    runBtn.disabled = true;
    try {
      if (!canUseTool('web_search', getActiveConv())) throw new Error('Web search is disabled for this conversation.');
      const { results, error } = await executeAuthorizedTool('web_search', { query: q }, getActiveConv(), null, { confirmed: null });
      if (error) {
        statusEl.textContent = 'Error: ' + error;
      } else {
        statusEl.textContent = 'Found ' + results.length + ' result' + (results.length === 1 ? '' : 's') + '.';
      }
      renderResults(results);
    } catch (e) {
      statusEl.textContent = 'Error: ' + (e.message || 'Unknown error');
    } finally {
      runBtn.disabled = false;
    }
  };

  runBtn.onclick = runSearch;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
  });

  input.focus();
}

function openSourcesDrawer(msg) {
  document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove());
  const swipeIdx = msg?.swipeIndex || 0;
  const toolBlocks = msg?.swipeToolUse?.[swipeIdx] || [];
  const persistedSources = msg?.swipeSources?.[swipeIdx] || [];

  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  const popup = document.createElement('div');
  popup.className = 'char-info-popup';

  let html = '<h3 id="sourcesDrawerTitle">Sources</h3>';
  if (persistedSources.length) {
    persistedSources.forEach(source => {
      const title = escapeHTML(source.title || source.url || 'Source');
      const safeUrl = safeHttpUrl(source.url);
      const snippet = source.snippet ? escapeHTML(source.snippet) : '';
      html += '<div class="source-drawer-item"><span class="source-number">[' + Number(source.number || 0) + ']</span>' +
        (safeUrl ? '<a href="' + escapeHTML(safeUrl) + '" target="_blank" rel="noopener">' + title + '</a>' : '<span>' + title + '</span>') +
        (snippet ? '<div class="source-snippet">' + snippet + '</div>' : '') + '</div>';
    });
  } else if (!toolBlocks.length || toolBlocks.every(tb => tb.type === 'url_fetch' ? (!tb.content && !tb.error) : !(tb.results || []).length)) {
    html += '<div style="color:var(--text-secondary);font-size:0.85em;margin-bottom:12px">No sources available.</div>';
  } else {
    toolBlocks.forEach(tb => {
      // --- url_fetch blocks ---
      if (tb.type === 'url_fetch') {
        const safeUrl = safeHttpUrl(tb.url);
        const displayUrl = escapeHTML((safeUrl || String(tb.url || '')).replace(/^https?:\/\//, '').replace(/\/+$/, ''));
        html += '<div style="margin:10px 0 6px;font-weight:600;font-size:0.9em">\u{1F310} ' + displayUrl + '</div>';
        if (tb.error) {
          html += '<div style="padding:10px;border:1px solid var(--card-border);border-radius:10px;background:var(--hover);margin-bottom:8px;color:var(--error-color,#ff7777);font-size:0.85em">' + escapeHTML(tb.error) + '</div>';
        } else if (tb.content) {
          const preview = escapeHTML(tb.content.slice(0, 500));
          html += '<div style="padding:10px;border:1px solid var(--card-border);border-radius:10px;background:var(--hover);margin-bottom:8px">' +
            (safeUrl ? '<a href="' + escapeHTML(safeUrl) + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-weight:600">' + displayUrl + '</a>' : '<span style="font-weight:600">' + displayUrl + '</span>') +
            '<div style="color:var(--text-secondary);font-size:0.8em;margin-top:6px;white-space:pre-wrap;max-height:150px;overflow-y:auto">' + preview + (tb.content.length > 500 ? '\u2026' : '') + '</div>' +
          '</div>';
        }
        return;
      }
      // --- web_search blocks ---
      const results = tb.results || [];
      if (!results.length) return;
      const q = escapeHTML(tb.query || 'Search');
      html += '<div style="margin:10px 0 6px;font-weight:600;font-size:0.9em">🔎 ' + q + '</div>';
      results.forEach(r => {
        const title = escapeHTML(r.title || r.url || 'Result');
        const safeUrl = safeHttpUrl(r.url);
        const displayUrl = escapeHTML((safeUrl || String(r.url || '')).replace(/^https?:\/\//, '').replace(/\/+$/, ''));
        const snippet = r.snippet ? escapeHTML(r.snippet) : '';
        html += '<div style="padding:10px;border:1px solid var(--card-border);border-radius:10px;background:var(--hover);margin-bottom:8px">' +
          (safeUrl ? '<a href="' + escapeHTML(safeUrl) + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;font-weight:600">' + title + '</a>' : '<span style="font-weight:600">' + title + '</span>') +
          (displayUrl ? '<div style="color:var(--text-secondary);font-size:0.75em;margin-top:4px">' + displayUrl + '</div>' : '') +
          (snippet ? '<div style="color:var(--text-secondary);font-size:0.85em;margin-top:6px">' + snippet + '</div>' : '') +
        '</div>';
      });
    });
  }

  html += '<button class="btn btn-primary" type="button" data-close-sources style="width:100%;padding:8px">Close</button>';
  popup.innerHTML = html;

  const close = openTransientDialog(overlay, popup, popup.querySelector('[data-close-sources]'));
  popup.querySelector('[data-close-sources]').onclick = close;
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
  const projectDocs = (getProject(conv && conv.projectId) || {}).docs || [];
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
    '<h3>Search Files</h3>' +
    '<div style="color:var(--text-secondary);font-size:0.85em;margin-bottom:12px">Searches text from files you attached in this conversation.</div>' +
    '<input type="text" id="fileSearchInput" placeholder="Search files..." style="width:100%;padding:10px;font-family:inherit;font-size:0.9em;background:var(--hover);border:1px solid var(--card-border);border-radius:8px;color:var(--text-primary);outline:none">' +
    '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="btn btn-primary" id="fileSearchRun" style="flex:1;padding:8px">Search</button>' +
      '<button class="btn btn-secondary" id="fileSearchClose" style="flex:1;padding:8px">Close</button>' +
    '</div>' +
    '<div id="fileSearchStatus" style="margin-top:12px;font-size:0.85em;color:var(--text-secondary)"></div>' +
    '<div id="fileSearchResults" style="margin-top:8px;display:flex;flex-direction:column;gap:8px"></div>';

  const close = () => { overlay.remove(); popup.remove(); };
  overlay.onclick = close;

  document.body.appendChild(overlay);
  document.body.appendChild(popup);

  const input = popup.querySelector('#fileSearchInput');
  const runBtn = popup.querySelector('#fileSearchRun');
  const closeBtn = popup.querySelector('#fileSearchClose');
  const statusEl = popup.querySelector('#fileSearchStatus');
  const resultsEl = popup.querySelector('#fileSearchResults');

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
  input.focus();
}

function openSummaryModal() {
  document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove());
  const conv = getActiveConv();

  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  const popup = document.createElement('div');
  popup.className = 'char-info-popup';

  popup.innerHTML =
    '<h3>Conversation Summary</h3>' +
    '<div style="color:var(--text-secondary);font-size:0.85em;margin-bottom:12px">Generate a compact summary and keep it in the system prompt for this chat.</div>' +
    '<textarea id="summaryText" style="width:100%;min-height:160px;resize:vertical;font-family:inherit;font-size:0.9em;background:var(--hover);border:1px solid var(--card-border);border-radius:8px;color:var(--text-primary);padding:10px;outline:none"></textarea>' +
    '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
      '<button class="btn btn-primary" id="summaryGen" style="flex:1;padding:8px">Generate</button>' +
      '<button class="btn btn-secondary" id="summarySave" style="flex:1;padding:8px">Save</button>' +
      '<button class="btn btn-secondary" id="summaryClear" style="flex:1;padding:8px">Clear</button>' +
      '<button class="btn btn-secondary" id="summaryClose" style="flex:1;padding:8px">Close</button>' +
    '</div>';

  const close = () => { overlay.remove(); popup.remove(); };
  overlay.onclick = close;
  document.body.appendChild(overlay);
  document.body.appendChild(popup);

  const ta = popup.querySelector('#summaryText');
  const genBtn = popup.querySelector('#summaryGen');
  const saveBtn = popup.querySelector('#summarySave');
  const clearBtn = popup.querySelector('#summaryClear');
  const closeBtn = popup.querySelector('#summaryClose');

  ta.value = conv?.summary || '';

  closeBtn.onclick = close;
  clearBtn.onclick = () => {
    if (!conv) return;
    conv.summary = '';
    conv.summaryUpdatedAt = null;
    saveConversations();
    ta.value = '';
    showToast('Summary cleared.', 'info');
  };
  saveBtn.onclick = () => {
    if (!conv) return;
    conv.summary = ta.value.trim();
    conv.summaryUpdatedAt = Date.now();
    saveConversations();
    showToast('Summary saved.', 'success');
  };
  genBtn.onclick = async () => {
    if (!conv) return;
    const baseUrl = (localStorage.getItem('llmProxyUrl') || '').trim();
    const apiKey = getApiKey();
    if (!baseUrl || !apiKey) { showToast('Set API Base URL and Key first.', 'error'); return; }
    genBtn.disabled = true;
    genBtn.textContent = 'Generating...';
    try {
      const transcript = buildConversationTranscript(40);
      const prompt = [
        { role: 'system', content: 'Summarize the conversation into a concise, structured note the assistant can use for context. Focus on facts, preferences, and open tasks. Keep it under 200 words.' },
        { role: 'user', content: transcript }
      ];
      const summary = await callApiNonStreaming(prompt);
      const cleaned = (summary || '').trim();
      ta.value = cleaned;
      conv.summary = cleaned;
      conv.summaryUpdatedAt = Date.now();
      saveConversations();
      showToast('Summary updated.', 'success');
    } catch (e) {
      showToast('Summary failed: ' + (e.message || 'Unknown error'), 'error');
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = 'Generate';
    }
  };
}

function openStatusPanel() {
  document.querySelectorAll('.char-info-overlay,.char-info-popup').forEach(el => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'char-info-overlay';
  const popup = document.createElement('div');
  popup.className = 'char-info-popup';

  const render = () => {
    const baseUrl = localStorage.getItem('llmProxyUrl') || '(not set)';
    const model = localStorage.getItem('llmModel') || '(not set)';
    const searchUrl = localStorage.getItem('llmSearchApiUrl') || 'https://purasearx.duckdns.org/search?format=json (default)';
    const searchOn = localStorage.getItem('llmWebSearch') === 'true' ? 'Enabled' : 'Disabled';
    const last = lastSearchStatus;
    const lastText = last.ok == null ? 'No searches yet.' : (last.ok ? 'OK' : 'Error: ' + last.error);
    const lastTime = last.at ? formatRelativeTime(last.at) : '';

    popup.innerHTML =
      '<h3>Status / Diagnostics</h3>' +
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
    closeBtn.onclick = () => { overlay.remove(); popup.remove(); };
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = 'Testing...';
      try {
        if (!canUseTool('web_search', getActiveConv())) throw new Error('Web search is disabled for this conversation.');
        await executeAuthorizedTool('web_search', { query: 'test' }, getActiveConv(), null, { confirmed: null });
      } catch(e) {
        lastSearchStatus = { ok: false, error: sanitizeErrorDetail(e), at: Date.now(), query: 'test' };
      }
      testBtn.disabled = false;
      testBtn.textContent = 'Test Search';
      render();
    };
  };

  overlay.onclick = () => { overlay.remove(); popup.remove(); };
  document.body.appendChild(overlay);
  document.body.appendChild(popup);
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
      ta.value = '/' + command.name + ' ';
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
  if (!cmd || !cmd.query) return;
  if (['search', 'web', 's'].includes(cmd.cmd)) {
    await handleManualSearch(cmd.query, conv);
  } else if (['files', 'file', 'docs', 'doc'].includes(cmd.cmd)) {
    await handleFileSearch(cmd.query, conv);
  }
}

async function handleManualSearch(query, conv) {
  const ts = Date.now();
  messages.push({ role: 'user', content: '/search ' + query, timestamp: ts });
  const assistantMsg = {
    role: 'assistant',
    content: '',
    swipes: [''],
    swipeIndex: 0,
    timestamp: Date.now(),
    swipeToolUse: [[{ query, results: [], searching: true }]]
  };
  messages.push(assistantMsg);
  const request = createRequestMetadata(assistantMsg, 0);
  request.status = 'streaming';
  await saveConversationImmediately().catch(() => {});
  renderMessages();

  try {
    const response = await executeAuthorizedTool('web_search', { query }, conv, null, { confirmed: null });
    const { results, error } = response;
    const tb = assistantMsg.swipeToolUse[0][0];
    tb.results = results;
    tb.searching = false;
    if (error) tb.error = error;
    assistantMsg.content = error ? ('Search error: ' + error) : ('Search results for "' + query + '".');
    assistantMsg.swipes[0] = assistantMsg.content;
    const registry = sourceRegistryFor(assistantMsg, 0);
    registerSources(registry, results).forEach((result, index) => { results[index].sourceNumber = result.sourceNumber; });
    persistSwipeSources(assistantMsg, 0, registry);
    finishRequestMetadata(request, error ? 'failed' : 'complete', error || '', null);
  } catch (e) {
    const tb = assistantMsg.swipeToolUse[0][0];
    tb.searching = false;
    tb.error = e.message || 'Search failed';
    assistantMsg.content = 'Search error: ' + (e.message || 'Unknown error');
    assistantMsg.swipes[0] = assistantMsg.content;
    finishRequestMetadata(request, 'failed', e.message || 'Search failed', null);
  }

  if (conv) conv.updatedAt = Date.now();
  debouncedSave();
  renderMessages();
  updateTokenInfo();
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
  renderMessages();
  updateTokenInfo();
}

function buildConversationTranscript(limit = 40) {
  const slice = messages.filter(m => m.role !== 'system');
  const recent = slice.slice(Math.max(0, slice.length - limit));
  return recent.map(m => (m.role === 'assistant' ? 'Assistant: ' : 'User: ') + getMsgText(m)).join('\n');
}

async function deleteMemory(id) {
  const memories = (await loadMemories()).filter(m => m.id !== id);
  await saveMemories(memories);
  openManageMemories();
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

function setAssistantLlmMetadata(assistantMsg, swipeIdx, model, format) {
  const baseUrl = localStorage.getItem('llmProxyUrl') || '';
  const provider = getLlmProviderInfo(model, format, baseUrl);
  const activeProfile = getActiveProfile();
  const metadata = {
    model,
    apiFormat: format,
    providerName: provider.name,
    providerSymbol: provider.symbol,
    profileName: activeProfile?.name || '',
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
    await openDB();
    try {
      const deleted = await cacheCleanupExpired();
      if (deleted > 0) console.log('Cleaned up ' + deleted + ' expired cache entries');
    } catch (e) {
      console.warn('Cache cleanup failed:', e);
    }
    migrateToPromptEntries();
    await loadProjects();
    await loadConversations();
  }
  loadTheme();
  loadCustomFont(localStorage.getItem('assistantFont') || '');
  loadCachedModels('setup');
  loadCachedModels('settings');
  renderConnectionChip();
  initModalAccessibility();
  renderLocalUpdateStatus();
  checkLocalUpdateStatus(false);

  // Save on page unload — sync fallback since IDB is async
  window.addEventListener('beforeunload', () => {
    // Second wipe vector: the localStorage fallback below writes `conversations`
    // directly, bypassing the guard inside saveConversations.
    if (readOnlyShare) return;
    clearTimeout(_saveDebounceTimer);
    persistDraftFromUI();
    saveConversations();
    // Only write to localStorage as fallback if IndexedDB is not available
    if (!db) {
      try {
        localStorage.setItem('assistantConversations', JSON.stringify(conversations));
        localStorage.setItem('assistantActiveConvId', activeConvId || '');
      } catch(e) {}
    }
  });

  // Show setup modal if no API key. A visitor reading a shared link has no reason to
  // be asked for one.
  if (!readOnlyShare && (!localStorage.getItem('llmProxyUrl') || (providerRequiresKey() && !getApiKey()))) {
    applyProviderPreset('setup', document.getElementById('setupProvider')?.value || 'openai');
    setKeyStorageInputs(getKeyStorageMode());
    openModal('setupModal', '#setupProxy');
  }

  // Hide voice button if unsupported
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    document.getElementById('voiceBtn').style.display = 'none';
  }


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
    if (commandActive) {
      handleCommandKeydown(e, ta);
      if (e.defaultPrevented) return;
    }
    if (mentionActive) {
      handleMentionKeydown(e, ta);
      if (e.defaultPrevented) return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const enterSends = localStorage.getItem('llmEnterSend') !== 'false';
      if (enterSends) {
        e.preventDefault();
        sendMessage();
      }
    }
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (readOnlyShare && ((e.ctrlKey && e.key.toLowerCase() === 'n') ||
      (e.ctrlKey && e.shiftKey && ['e', 'r'].includes(e.key.toLowerCase())))) {
      e.preventDefault();
      return;
    }
    // Escape - close modals / stop streaming
    if (e.key === 'Escape') {
      if (globalSearchDismiss) {
        e.preventDefault();
        globalSearchDismiss();
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
      if (document.getElementById('composerToolsPopover')) {
        closeComposerTools();
        e.preventDefault();
        return;
      }
      if (closeTopModal()) {
        e.preventDefault();
        return;
      }
      if (streaming && abortController) { streaming = false; abortController.abort(); }
    }
    // Ctrl+N - new conversation
    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      createConversation();
    }
    // Ctrl+/ - focus input
    if (e.ctrlKey && e.key === '/') {
      e.preventDefault();
      document.getElementById('chatInput').focus();
    }
    // Ctrl+K - focus sidebar search
    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault();
      const sb = document.getElementById('sidebar');
      if (sb.classList.contains('collapsed')) toggleSidebar();
      document.getElementById('sidebarSearch').focus();
    }
    // Ctrl+Shift+E - export all
    if (e.ctrlKey && e.shiftKey && e.key === 'E') {
      e.preventDefault();
      exportAllConversations();
    }
    // Ctrl+F - chat search
    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      openChatSearch();
    }
    // Ctrl+Shift+R - regenerate last response
    if (e.ctrlKey && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      regenerate();
    }
    // Ctrl+Shift+? - shortcut help
    if (e.ctrlKey && e.shiftKey && e.key === '?') {
      e.preventDefault();
      openModal('shortcutsModal');
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#composerToolsPopover, #toolsBtn')) closeComposerTools();
    if (!e.target.closest('#commandDropdown, #chatInput')) closeCommandDropdown();
  });

  // Drag & drop files
  const main = document.querySelector('.main');
  main.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  main.addEventListener('drop', (e) => {
    e.preventDefault();
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

  // Mobile: collapse sidebar by default
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.add('collapsed');
  }

  // Scroll-to-bottom FAB
  const msgsArea = document.getElementById('messagesArea');
  const scrollFab = document.getElementById('scrollFab');
  msgsArea.addEventListener('scroll', () => {
    const atBottom = msgsArea.scrollHeight - msgsArea.scrollTop - msgsArea.clientHeight < 100;
    scrollFab.classList.toggle('visible', !atBottom);
    if (streaming && !_suppressScrollFlag) {
      userScrolledAway = !atBottom;
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

  // Mobile swipe gestures for assistant message alternatives
  let _touchStartX = 0, _touchStartY = 0, _touchLastX = 0, _touchMsgIdx = null, _swiping = false, _touchDecided = false;
  msgsArea.addEventListener('touchstart', e => {
    const wrapper = e.target.closest('.msg-wrapper.assistant');
    if (!wrapper || _selectMode) { _touchMsgIdx = null; return; }
    _touchMsgIdx = parseInt(wrapper.dataset.msgIdx);
    _touchStartX = _touchLastX = e.touches[0].clientX;
    _touchStartY = e.touches[0].clientY;
    _swiping = false;
    _touchDecided = false;
  }, { passive: true });
  msgsArea.addEventListener('touchmove', e => {
    if (_touchMsgIdx === null || isNaN(_touchMsgIdx)) return;
    _touchLastX = e.touches[0].clientX;
    if (_touchDecided) { if (_swiping) e.preventDefault(); return; }
    const dx = Math.abs(_touchLastX - _touchStartX);
    const dy = Math.abs(e.touches[0].clientY - _touchStartY);
    if (dx > 10 || dy > 10) {
      _touchDecided = true;
      _swiping = dx > dy;
    }
    if (_swiping) e.preventDefault();
  }, { passive: false });
  msgsArea.addEventListener('touchend', e => {
    if (!_swiping || _touchMsgIdx === null || isNaN(_touchMsgIdx)) {
      _touchMsgIdx = null;
      _swiping = false;
      _touchDecided = false;
      return;
    }
    const dx = _touchLastX - _touchStartX;
    if (Math.abs(dx) > 30) {
      const msg = messages[_touchMsgIdx];
      if (msg && dx < 0 && _touchMsgIdx === messages.length - 1 && (!msg.swipes || msg.swipeIndex >= msg.swipes.length - 1)) {
        regenerate();
      } else if (msg && msg.swipes && msg.swipes.length > 1) {
        swipeMsg(_touchMsgIdx, dx < 0 ? 1 : -1);
      }
    }
    _touchMsgIdx = null;
    _swiping = false;
    _touchDecided = false;
  }, { passive: true });

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
    overlay.className = 'img-lightbox';
    const fullImg = document.createElement('img');
    fullImg.src = img.src;
    fullImg.alt = img.alt || 'Generated image';
    overlay.appendChild(fullImg);
    overlay.addEventListener('click', e => { if (e.target !== fullImg) overlay.remove(); });
    const onKey = e => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
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
  const images = [];
  // 1. message.images[] array (some proxies put images here)
  if (msg.images?.length) {
    for (const img of msg.images) {
      if (img.image_url?.url) images.push(img.image_url.url);
      else if (img.url) images.push(img.url);
      else if (img.b64_json) images.push('data:image/png;base64,' + img.b64_json);
      else if (typeof img === 'string' && img.length > 100)
        images.push(img.startsWith('data:') ? img : 'data:image/png;base64,' + img);
    }
  }
  // 2. message.content as array
  const content = msg.content;
  let text = '';
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') { text += item.text; continue; }
      if (item.type === 'image_url' && item.image_url?.url) { images.push(item.image_url.url); continue; }
      if (item.type === 'image' && item.source?.data) {
        images.push('data:' + (item.source.media_type || 'image/png') + ';base64,' + item.source.data);
        continue;
      }
      if (item.image_url?.url) { images.push(item.image_url.url); continue; }
      if (typeof item === 'string' && item.startsWith('data:image')) { images.push(item); continue; }
    }
  } else {
    text = content || '';
  }
  // 3. message.parts[] (Gemini inline_data)
  if (msg.parts) {
    for (const part of msg.parts) {
      if (part.inline_data?.data) {
        images.push('data:' + (part.inline_data.mime_type || 'image/png') + ';base64,' + part.inline_data.data);
      }
      if (part.text && !text) text += part.text;
    }
  }
  // 4. Extract images from text string (data URIs, URLs, raw base64)
  if (typeof text === 'string' && text && !images.length) {
    const dataUriMatch = text.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
    if (dataUriMatch) {
      images.push(dataUriMatch[0]);
      text = text.replace(dataUriMatch[0], '').trim();
    }
    if (!images.length) {
      const urlMatch = text.match(/^https?:\/\/[^\s]+\.(png|jpg|jpeg|webp|gif)(\?[^\s]*)?$/i);
      if (urlMatch) { images.push(text.trim()); text = ''; }
    }
    if (!images.length) {
      const embeddedMatch = text.match(/(https?:\/\/[^\s]+\.(png|jpg|jpeg|webp|gif)(\?[^\s]*)?)/i);
      if (embeddedMatch) {
        images.push(embeddedMatch[1]);
        text = text.replace(embeddedMatch[1], '').trim();
      }
    }
    if (!images.length) {
      const rawB64 = text.match(/^[A-Za-z0-9+/]{100,}[=]{0,2}$/);
      if (rawB64) { images.push('data:image/png;base64,' + rawB64[0]); text = ''; }
    }
  }
  return { text, images };
}

function renderMarkdown(text) {
  if (!text) return '';

  // Normalize line endings early so markdown regexes behave consistently.
  text = String(text).replace(/\r\n?/g, '\n');

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
  const protectBlock = (block) => {
    const idx = protectedBlocks.length;
    protectedBlocks.push(block);
    return '\x00BLOCK' + idx + '\x00';
  };
  const restoreProtectedBlock = (_, idx) => {
    const block = protectedBlocks[parseInt(idx, 10)];
    if (!block) return '';
    if (block.type === 'html') return block.html;
    if (block.type === 'mermaid') {
      return '<div class="mermaid-container"><pre class="mermaid">' + renderLiteralCode(block.code) + '</pre></div>';
    }
    if (block.type === 'inline-code') {
      return '<code>' + renderLiteralCode(block.code) + '</code>';
    }
    const langAttr = block.lang ? ' class="language-' + block.lang + '"' : '';
    return '<pre><code' + langAttr + '>' + renderLiteralCode(block.code) + '</code></pre>';
  };

  // Extract KaTeX math before HTML escaping
  const mathPlaceholders = [];
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
  s = s.replace(/```mermaid(?:[ \t]*\n|[ \t]+)?([\s\S]*?)```/gi, (_, code) =>
    protectBlock({ type: 'mermaid', code: code.trimEnd() })
  );
  s = s.replace(/```([A-Za-z0-9_#+.-]*)(?:[ \t]*\n|[ \t]+)?([\s\S]*?)```/g, (_, lang, code) =>
    protectBlock({ type: 'fence', lang, code: code.trimEnd() })
  );
  s = s.replace(/(?<!`)`([^`\n]+)`(?!`)/g, (_, code) =>
    protectBlock({ type: 'inline-code', code })
  );
  // Block math $$...$$
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    const idx = mathPlaceholders.length;
    mathPlaceholders.push({ math, display: true });
    return '\x00MATH' + idx + '\x00';
  });
  // Inline math $...$
  s = s.replace(/\$([^\$\n]+?)\$/g, (_, math) => {
    if (!looksLikeInlineMath(math)) return '$' + math + '$';
    const idx = mathPlaceholders.length;
    mathPlaceholders.push({ math, display: false });
    return '\x00MATH' + idx + '\x00';
  });

  // Decode HTML entities that models sometimes output before escaping
  s = decodeBasicEntities(s);
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = restoreAllowedInlineHtml(s);
  // Spoiler tags >!hidden text!<
  s = s.replace(/&gt;!([\s\S]*?)!&lt;/g, '<span class="spoiler" onclick="this.classList.toggle(\'revealed\')">$1</span>');
  s = s.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/(^|[^\w])_([^_\n]+)_([^\w]|$)/g, '$1<em>$2</em>$3');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  s = s.replace(/==(.+?)==/g, '<mark>$1</mark>');
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
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const safeUrl = safeMediaUrl(url);
    return safeUrl ? '<img src="' + escapeHTML(safeUrl) + '" alt="' + alt + '" class="chat-inline-img chat-gen-img" loading="lazy">' : alt;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const safeUrl = safeHttpUrl(url);
    return safeUrl ? '<a href="' + escapeHTML(safeUrl) + '" target="_blank" rel="noopener">' + label + '</a>' : label;
  });
  s = s.replace(/^---$/gm, '<hr>');
  // Markdown tables
  s = s.replace(/(^\|.+\|$\n?)+/gm, match => {
    const rows = match.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return match;
    const parseRow = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const isSep = r => /^\|[\s\-:|]+\|$/.test(r.trim());
    const renderTableCell = c => restoreAllowedInlineHtml(escapeHTML(decodeBasicEntities(c)));
    let headerRow = parseRow(rows[0]);
    let bodyStart = 1;
    if (isSep(rows[1])) bodyStart = 2;
    let html = '<table><thead><tr>' + headerRow.map(c => `<th>${renderTableCell(c)}</th>`).join('') + '</tr></thead><tbody>';
    for (let i = bodyStart; i < rows.length; i++) {
      if (isSep(rows[i])) continue;
      const cells = parseRow(rows[i]);
      html += '<tr>' + cells.map(c => `<td>${renderTableCell(c)}</td>`).join('') + '</tr>';
    }
    html += '</tbody></table>';
    return protectBlock({ type: 'html', html });
  });
  s = s.replace(/\n/g, '<br>');

  // Restore KaTeX math placeholders
  s = s.replace(/\x00MATH(\d+)\x00/g, (_, idx) => {
    const ph = mathPlaceholders[parseInt(idx)];
    if (typeof katex !== 'undefined') {
      try { return katex.renderToString(ph.math, { displayMode: ph.display, throwOnError: false }); } catch(e) { console.warn('KaTeX render error:', e); }
    }
    return (ph.display ? '$$' : '$') + ph.math.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + (ph.display ? '$$' : '$');
  });
  s = s.replace(/\x00BLOCK(\d+)\x00/g, restoreProtectedBlock);

  return s;
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

function speakMessage(msg, btn) {
  const synth = window.speechSynthesis;
  if (!synth) {
    showToast('Read aloud is not supported in this browser.', 'error');
    return;
  }
  const stopping = btn.dataset.speaking === 'true';
  // Always stop whatever is playing first, then clear every live button's state. This
  // self-heals across re-renders: stale buttons are gone from the DOM, so the query
  // only ever finds current ones.
  // ponytail: speech orphaned by a re-render keeps playing until the next click or the
  // end of the utterance. Hook renderMessages if that ever actually bites.
  synth.cancel();
  document.querySelectorAll('.msg-action-btn[data-speaking="true"]').forEach(b => {
    b.dataset.speaking = 'false';
    b.textContent = 'Speak';
  });
  if (stopping) return;

  const text = toSpeechText(stripThinkTags(getMsgText(msg)).content);
  if (!text) {
    showToast('Nothing to read in this message.');
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  const reset = () => {
    btn.dataset.speaking = 'false';
    btn.textContent = 'Speak';
  };
  utterance.onend = reset;
  utterance.onerror = reset;
  btn.dataset.speaking = 'true';
  btn.textContent = 'Stop';
  synth.speak(utterance);
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
  if (readOnlyShare || streaming) return;
  const msg = messages[idx];
  if (!msg || msg.role !== 'assistant') return;
  const conv = getActiveConv();
  const swipeIdx = Number.isInteger(msg.swipeIndex) ? msg.swipeIndex : 0;
  const requestContext = await buildRequestMessages(conv, { messageList: messages, untilIndex: idx });
  if (guardContextLimit(requestContext)) return;
  msg.swipes = Array.isArray(msg.swipes) ? msg.swipes : [''];
  msg.swipes[swipeIdx] = '';
  msg.content = '';
  if (msg.swipeThinking) msg.swipeThinking[swipeIdx] = '';
  if (msg.swipeToolUse) msg.swipeToolUse[swipeIdx] = [];
  if (msg.swipeImages) msg.swipeImages[swipeIdx] = [];
  if (msg.swipeSources) msg.swipeSources[swipeIdx] = [];
  renderMessages();
  const wrapper = document.querySelector('.msg-wrapper[data-msg-idx="' + idx + '"]');
  const bubble = wrapper?.querySelector('.msg-bubble');
  if (!bubble) return;
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  announce('Retrying the failed request.');
  await streamResponse(requestContext.messages, msg, swipeIdx, bubble, null, null, { conv });
  if (conv) conv.updatedAt = Date.now();
  if (getSwipeRequest(msg, swipeIdx)?.status === 'complete') extractMemories(requestContext.messages);
  await saveConversationImmediately();
  renderMessages();
  updateTokenInfo();
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
    parts.push(inputChars + ' chars');
    parts.push('~' + (inputTokens > 999 ? (inputTokens / 1000).toFixed(1) + 'k' : inputTokens) + ' tokens');
  }

  let total = 0;
  messages.forEach(m => { total += estimateTokens(getMsgText(m)); });
  if (total > 0 || messages.length > 0) {
    parts.push('Conv: ~' + (total > 999 ? (total / 1000).toFixed(1) + 'k' : total) + ' tokens');
  }

  // Project instructions and files are re-sent on every request, so surface them —
  // otherwise the cost is completely invisible in this bar.
  const activeProject = getProject((getActiveConv() || {}).projectId);
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
const DB_VERSION = 2;
const RESPONSE_CACHE_STORE = 'responseCache';
const RESPONSE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      const oldVersion = e.oldVersion;
      if (!d.objectStoreNames.contains('conversations')) d.createObjectStore('conversations', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('memories')) d.createObjectStore('memories', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      if (oldVersion < 2 || !d.objectStoreNames.contains(RESPONSE_CACHE_STORE)) {
        const cacheObjectStore = d.objectStoreNames.contains(RESPONSE_CACHE_STORE)
          ? e.target.transaction.objectStore(RESPONSE_CACHE_STORE)
          : d.createObjectStore(RESPONSE_CACHE_STORE, { keyPath: 'cacheKey' });
        if (!cacheObjectStore.indexNames.contains('cachedAt')) cacheObjectStore.createIndex('cachedAt', 'cachedAt', { unique: false });
        if (!cacheObjectStore.indexNames.contains('model')) cacheObjectStore.createIndex('model', 'model', { unique: false });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

function idbPut(store, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    s.put(data);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
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
  });
}

function idbClear(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function idbPutAll(store, items) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    s.clear();
    items.forEach(item => s.put(item));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function isResponseCacheEnabled() {
  return localStorage.getItem('llmCacheEnabled') !== 'false';
}

function normalizeForCache(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeForCache);
  const out = {};
  Object.keys(value).sort().forEach(key => {
    out[key] = normalizeForCache(value[key]);
  });
  return out;
}

function stableCacheJson(value) {
  return JSON.stringify(normalizeForCache(value));
}

function fallbackHash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'fallback_' + (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function getRequestAffectingSettings(model, format, toolPolicy = getToolPolicy()) {
  let extraParams = {};
  try { extraParams = JSON.parse(localStorage.getItem('llmExtraParams') || '{}'); } catch (e) {}
  const baseUrl = localStorage.getItem('llmProxyUrl') || '';
  return {
    cacheKeyVersion: 3,
    model: model || '',
    apiFormat: format || detectApiFormat(model),
    provider: inferProviderKey({ llmProxyUrl: baseUrl, llmApiFormat: format }),
    baseUrl,
    searchApiUrl: sanitizeStoredUrl(localStorage.getItem('llmSearchApiUrl') || ''),
    corsProxy: sanitizeStoredUrl(localStorage.getItem('llmCorsProxy') || ''),
    maxTokens: resolveMaxTokens(),
    temperature: localStorage.getItem('llmTemperature') || '',
    extraParams: normalizeForCache(extraParams),
    excludedParams: (localStorage.getItem('llmExcludeParams') || '').split(',').map(value => value.trim()).filter(Boolean).sort(),
    prefill: localStorage.getItem('llmPrefill') || '',
    thinking: localStorage.getItem('llmThinking') === 'true',
    thinkingEffort: localStorage.getItem('llmThinkingEffort') || '',
    forceSearch: localStorage.getItem('llmForceSearch') === 'true',
    toolPolicy: normalizeToolPolicy(toolPolicy)
  };
}

async function generateCacheKey(userMessage, model, systemMessages, requestContext = {}) {
  const payload = stableCacheJson({
    version: 3,
    model: model || '',
    userMessage,
    systemMessages: systemMessages || [],
    messages: requestContext.messages || [],
    settings: requestContext.settings || {},
    credentialScope: requestContext.credentialScope || ''
  });
  if (!window.crypto?.subtle) return fallbackHash(payload);
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getResponseCacheRequestParts(apiMessages) {
  const systemMessages = [];
  let userMessage = null;
  (apiMessages || []).forEach(message => {
    if (!message || !message.role) return;
    if (message.role === 'system') {
      systemMessages.push({ role: 'system', content: message.content || '' });
    } else if (message.role === 'user') {
      userMessage = { role: 'user', content: normalizeForCache(message.content) };
    }
  });
  return { userMessage, systemMessages, messages: normalizeForCache(apiMessages || []) };
}

async function cacheLookup(cacheKey) {
  if (!db || !cacheKey) return null;
  const entry = await idbGet(RESPONSE_CACHE_STORE, cacheKey);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt && entry.expiresAt <= now) {
    await cacheDelete(cacheKey);
    return null;
  }
  entry.hitCount = (entry.hitCount || 0) + 1;
  entry.lastHitAt = now;
  try { await idbPut(RESPONSE_CACHE_STORE, entry); } catch(e) { console.warn('Cache hit update failed:', e); }
  return entry;
}

async function cacheStore(entry) {
  if (!db || !entry?.cacheKey) return;
  const existing = await idbGet(RESPONSE_CACHE_STORE, entry.cacheKey).catch(() => null);
  const now = Date.now();
  const normalized = {
    ...entry,
    cachedAt: entry.cachedAt || now,
    expiresAt: entry.expiresAt || (now + RESPONSE_CACHE_TTL_MS),
    hitCount: existing?.hitCount || 0,
    lastHitAt: existing?.lastHitAt || null
  };
  await idbPut(RESPONSE_CACHE_STORE, normalized);
}

async function cacheDelete(cacheKey) {
  if (!db || !cacheKey) return;
  await idbDelete(RESPONSE_CACHE_STORE, cacheKey);
}

async function cacheClear() {
  if (!db) return;
  await idbClear(RESPONSE_CACHE_STORE);
}

async function cacheCleanupExpired() {
  if (!db) return 0;
  const now = Date.now();
  const entries = await idbGetAll(RESPONSE_CACHE_STORE);
  let deleted = 0;
  for (const entry of entries) {
    if (entry.expiresAt && entry.expiresAt <= now) {
      await idbDelete(RESPONSE_CACHE_STORE, entry.cacheKey);
      deleted++;
    }
  }
  return deleted;
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

async function cacheGetStats() {
  if (!db) return { count: 0, sizeBytes: 0, hits: 0, expired: 0 };
  const entries = await idbGetAll(RESPONSE_CACHE_STORE);
  const now = Date.now();
  return entries.reduce((stats, entry) => {
    stats.count++;
    stats.sizeBytes += stableCacheJson(entry).length * 2;
    stats.hits += entry.hitCount || 0;
    if (entry.expiresAt && entry.expiresAt <= now) stats.expired++;
    return stats;
  }, { count: 0, sizeBytes: 0, hits: 0, expired: 0 });
}

function buildResponseCacheEntry(cacheKey, userMessage, systemMessages, model, format, fullText, thinkingText, toolBlocks, assistantMsg, swipeIdx) {
  const now = Date.now();
  const images = assistantMsg.swipeImages?.[swipeIdx] || assistantMsg.images || [];
  return {
    cacheKey,
    cachedAt: now,
    expiresAt: now + RESPONSE_CACHE_TTL_MS,
    model,
    format,
    userMessage,
    systemMessages,
    response: {
      content: fullText || '',
      thinking: thinkingText || '',
      toolUse: normalizeForCache(toolBlocks || []),
      images: normalizeForCache(images || []),
      metadata: { model, format, timestamp: now }
    },
    hitCount: 0
  };
}

function restoreCachedResponse(entry, assistantMsg, swipeIdx, bubbleEl) {
  const response = entry?.response || {};
  const content = response.content || '';
  const thinking = response.thinking || '';
  const toolUse = Array.isArray(response.toolUse) ? response.toolUse : [];
  const images = Array.isArray(response.images) ? response.images : [];
  assistantMsg._responseCacheHit = true;
  assistantMsg.swipes = assistantMsg.swipes || [];
  assistantMsg.swipes[swipeIdx] = content;
  assistantMsg.content = content;
  if (thinking) {
    assistantMsg.swipeThinking = assistantMsg.swipeThinking || [];
    assistantMsg.swipeThinking[swipeIdx] = thinking;
  }
  if (toolUse.length > 0) {
    assistantMsg.swipeToolUse = assistantMsg.swipeToolUse || [];
    assistantMsg.swipeToolUse[swipeIdx] = toolUse;
  }
  if (images.length > 0) {
    assistantMsg.swipeImages = assistantMsg.swipeImages || [];
    assistantMsg.swipeImages[swipeIdx] = images;
    assistantMsg.images = images;
  }
  bubbleEl.innerHTML = renderThinkingHTML(thinking) + renderToolBlocksHTML(toolUse) + renderMarkdown(content) + renderGenImages(images);
  postRenderProcessing(bubbleEl);
  const msgsArea = document.getElementById('messagesArea');
  if (msgsArea) msgsArea.scrollTop = msgsArea.scrollHeight;
  updateMessageTokenMetadata(assistantMsg, swipeIdx);
  debugLog('Response cache hit', {
    model: entry.model,
    hits: entry.hitCount || 0,
    cachedAt: entry.cachedAt ? new Date(entry.cachedAt).toISOString() : ''
  });
}

// ============================================
// Conversation Management
// ============================================
function genId() { return 'conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

function saveConversations() {
  // Hard stop in share view. idbPutAll clears the store before writing, so saving an
  // empty in-memory `conversations` here would destroy the visitor's own history. The
  // hidden delete/fork/regenerate handlers still exist in the DOM, so guard centrally.
  if (readOnlyShare) return;
  try { localStorage.setItem('assistantActiveConvId', activeConvId || ''); } catch(e) {}
  if (!db) return;
  idbPutAll('conversations', conversations)
    .then(() => idbPut('meta', { key: 'activeConvId', value: activeConvId || '' }))
    .catch(e => console.error('IDB save error:', e));
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

function normalizeLoadedConversations(list) {
  const source = Array.isArray(list) ? list : [];
  const used = new Set();
  const normalized = source.map(raw => {
    const conv = normalizeConversationRecord(raw);
    if (used.has(conv.id)) conv.id = genId();
    used.add(conv.id);
    conv.messages.forEach(message => {
      if (message.role === 'assistant' && !message.swipes) {
        message.swipes = [typeof message.content === 'string' ? message.content : ''];
        message.swipeIndex = 0;
      }
    });
    return conv;
  });
  return { conversations: normalized, changed: recoverInterruptedRequests(normalized) };
}

function cloneDraftAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map(att => ({
    type: att.type,
    name: att.name || 'file',
    mime: att.mime || '',
    dataUrl: att.type === 'image' ? safeMediaUrl(att.dataUrl) : safeFileUrl(att.dataUrl),
    textContent: typeof att.textContent === 'string' ? att.textContent : '',
    binary: att.binary === true
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
  saveConversations();
  announce('Attachment added to the original conversation draft.');
}

function persistDraftFromUI() {
  const conv = getActiveConv();
  const input = document.getElementById('chatInput');
  if (!conv || !input || readOnlyShare) return;
  const text = input.value;
  const attachments = cloneDraftAttachments(pendingAttachments);
  if (!text && attachments.length === 0) delete conv.draft;
  else conv.draft = { text, attachments, updatedAt: Date.now() };
  debouncedSave();
}

function restoreActiveDraft() {
  const input = document.getElementById('chatInput');
  const conv = getActiveConv();
  if (!input || !conv) return;
  const draft = conv.draft || {};
  input.value = draft.text || '';
  pendingAttachments = cloneDraftAttachments(draft.attachments);
  renderPreviews();
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  updateTokenInfo();
  updateSendBtnState();
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
  if (changed) saveConversations();
}

async function loadConversations() {
  // Try IndexedDB first
  try {
    const convs = await idbGetAll('conversations');
    if (convs.length > 0) {
      const normalized = normalizeLoadedConversations(convs);
      conversations = normalized.conversations;
      const meta = await new Promise((resolve) => {
        const tx = db.transaction('meta', 'readonly');
        const req = tx.objectStore('meta').get('activeConvId');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });
      activeConvId = meta?.value || conversations[0].id;
      // Migrate characterSystemPrompt → persona
      migratePersonaField(conversations);
      if (normalized.changed) saveConversations();
      activeConvId = (conversations.find(c => c.id === activeConvId)) ? activeConvId : conversations[0].id;
      messages = getActiveConv().messages;
      renderSidebar();
      renderMessages();
      updateTokenInfo();
      updateCharacterUI();
      restoreActiveDraft();
      return;
    }
  } catch(e) { console.error('IDB load error:', e); }

  // Migrate from localStorage
  const saved = localStorage.getItem('assistantConversations');
  if (saved) {
    try { conversations = JSON.parse(saved); }
    catch (e) { console.error('Failed to parse conversations, resetting:', e); conversations = []; }
  }

  // Migrate legacy
  const legacy = localStorage.getItem('assistantChatHistory');
  if (legacy && conversations.length === 0) {
    try {
      conversations.push({ id: genId(), title: 'Chat', messages: JSON.parse(legacy), createdAt: Date.now(), updatedAt: Date.now() });
      localStorage.removeItem('assistantChatHistory');
    } catch (e) { console.error('Failed to parse legacy chat:', e); }
  }

  if (conversations.length === 0) {
    conversations.push({ id: genId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() });
  }

  // Normalize legacy records without changing their IDs or message history.
  conversations = normalizeLoadedConversations(conversations).conversations;

  // Migrate characterSystemPrompt → persona
  migratePersonaField(conversations);

  const savedActive = localStorage.getItem('assistantActiveConvId');
  activeConvId = (savedActive && conversations.find(c => c.id === savedActive)) ? savedActive : conversations[0].id;
  messages = getActiveConv().messages;

  // Write migrated data to IndexedDB and clean localStorage
  try {
    await idbPutAll('conversations', conversations);
    await idbPut('meta', { key: 'activeConvId', value: activeConvId || '' });
    localStorage.removeItem('assistantConversations');
    localStorage.removeItem('assistantActiveConvId');
  } catch(e) { console.error('IDB migration error:', e); }

  saveConversations();
  renderSidebar();
  renderMessages();
  updateTokenInfo();
  updateCharacterUI();
  restoreActiveDraft();
}

function getActiveConv() { return conversations.find(c => c.id === activeConvId); }

function createConversation(projectId) {
  if (readOnlyShare) return;
  persistDraftFromUI();
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
  announce('New conversation created.');
  if (window.innerWidth <= 768) toggleSidebar();
}

function switchConversation(id) {
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;
  persistDraftFromUI();
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
  if (window.innerWidth <= 768) toggleSidebar();
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
// Stored as a single record in the existing `meta` store rather than a new object store
// (which would force a DB version bump for ~20 records) or localStorage (project files
// are unbounded text — the same reason conversations moved to IndexedDB).

const PROJECT_DOC_CHAR_LIMIT = 20000;
let _projectEditId = null;

async function loadProjects() {
  try {
    const record = await idbGet('meta', 'projects');
    projects = (record && record.value) || [];
  } catch (e) {
    console.error('IDB projects load error:', e);
    projects = [];
  }
}

function saveProjects() {
  if (!db) return;
  idbPut('meta', { key: 'projects', value: projects })
    .catch(e => console.error('IDB projects save error:', e));
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
  // Detach, never cascade — deleting a folder must not delete the conversations in it.
  conversations.forEach(c => { if (c.projectId === id) delete c.projectId; });
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
  if (readOnlyShare) return;
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
  conversations.unshift(copy);
  activeConvId = copy.id;
  messages = copy.messages;
  saveConversations();
  renderSidebar();
  renderMessages();
  updateTokenInfo();
  restoreActiveDraft();
  announce('Conversation duplicated.');
}

function removeConversations(ids, showUndo = true) {
  if (readOnlyShare) return;
  const targets = conversations.filter(c => ids.includes(c.id));
  if (!targets.length) return;
  const publicCount = targets.filter(c => c.shareGistId || c.shareUrl || c.shareId).length;
  if (publicCount && !confirm(publicCount + ' selected conversation' + (publicCount === 1 ? ' has' : 's have') + ' public share IDs. Deleting locally does not revoke those links. Continue?')) return;
  const removed = targets.map(conv => ({ conv, index: conversations.indexOf(conv) }));
  conversations = conversations.filter(c => !ids.includes(c.id));
  if (!conversations.length) conversations.push({ id: genId(), title: 'New Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() });
  if (!conversations.some(c => c.id === activeConvId)) activeConvId = conversations[0].id;
  messages = getActiveConv()?.messages || [];
  saveConversations();
  renderSidebar();
  renderMessages();
  updateTokenInfo();
  restoreActiveDraft();
  selectedConversationIds.clear();
  if (!showUndo) return;
  showToast(targets.length + ' conversation' + (targets.length === 1 ? '' : 's') + ' deleted.', 'info', 5000, {
    label: 'Undo',
    onClick: () => {
      removed.sort((a, b) => a.index - b.index).forEach(({ conv, index }) => conversations.splice(Math.min(index, conversations.length), 0, conv));
      activeConvId = removed[0].conv.id;
      messages = getActiveConv().messages;
      saveConversations();
      renderSidebar();
      renderMessages();
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
  addItem('+ New project…', false, () => {
    const name = prompt('Project name:');
    if (name === null) return;
    const proj = createProject(name);
    assignConversationToProject(conv, proj.id);
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
  _projectEditId = projectId || (projects.length ? projects[0].id : null);
  renderProjectEditor();
  openModal('projectsModal');
}

function selectProjectInModal(id) {
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

function newProjectFromModal() {
  const name = prompt('Project name:');
  if (name === null) return;
  const proj = createProject(name);
  _projectEditId = proj.id;
  renderProjectEditor();
}

function saveProjectFromModal() {
  const proj = getProject(_projectEditId);
  if (!proj) { closeModal('projectsModal'); return; }
  proj.name = document.getElementById('projName').value.trim() || proj.name;
  proj.instructions = document.getElementById('projInstructions').value;
  proj.updatedAt = Date.now();
  saveProjects();
  renderSidebar();
  closeModal('projectsModal');
  showToast('Project saved.', 'success');
}

function removeProjectDoc(docId) {
  const proj = getProject(_projectEditId);
  if (!proj) return;
  proj.docs = proj.docs.filter(d => d.id !== docId);
  proj.updatedAt = Date.now();
  saveProjects();
  renderProjectEditor();
}

// Reuses readAttachmentFile so project files get the same PDF/DOCX/RTF/text extraction
// as chat attachments, instead of duplicating that dispatch. It appends to
// pendingAttachments, so drain what it added back off the end.
async function addProjectFiles(event) {
  const proj = getProject(_projectEditId);
  if (!proj) return;
  const files = Array.from(event.target.files || []);
  let skipped = 0;
  for (const file of files) {
    const before = pendingAttachments.length;
    try {
      await readAttachmentFile(file);
    } catch (e) {
      console.warn('Project file read failed:', file.name, e);
    }
    const added = pendingAttachments.splice(before);
    added.forEach(att => {
      const text = att.textContent || (att.file && att.file.textContent) || '';
      if (!text) { skipped++; return; }
      proj.docs.push({
        id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: att.name || (att.file && att.file.name) || 'file',
        text: text.slice(0, PROJECT_DOC_CHAR_LIMIT),
        createdAt: Date.now()
      });
    });
  }
  proj.updatedAt = Date.now();
  saveProjects();
  renderPreviews();
  renderProjectEditor();
  event.target.value = '';
  if (skipped) showToast(skipped + ' file(s) skipped — no readable text (images can’t be project files).');
}

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
    return p ? p.name.toLowerCase() : '￿';
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
    if (c.pinned) return 'Pinned';
    const p = getProject(c.projectId);
    if (p) return '\u{1F4C1} ' + p.name;
    const t = c.updatedAt || c.createdAt || 0;
    if (t >= todayStart) return 'Today';
    if (t >= yesterdayStart) return 'Yesterday';
    if (t >= weekStart) return 'Last 7 Days';
    if (t >= monthStart) return 'Last 30 Days';
    return 'Older';
  }

  let lastGroup = '';
  sorted.forEach((c, sortIdx) => {
    const group = getGroup(c);
    if (group !== lastGroup) {
      const header = document.createElement('div');
      header.className = 'conv-group-header';
      header.dataset.group = group;
      const proj = getProject(c.projectId);
      if (proj && !c.pinned) {
        header.classList.add('project-header');
        header.dataset.projectId = proj.id;
        const label = document.createElement('span');
        label.textContent = group;
        label.title = 'Edit project';
        label.onclick = () => openProjectsModal(proj.id);
        header.appendChild(label);
        const addBtn = document.createElement('button');
        addBtn.className = 'project-add-btn';
        addBtn.textContent = '+';
        addBtn.title = 'New chat in ' + proj.name;
        addBtn.setAttribute('aria-label', 'New chat in ' + proj.name);
        addBtn.onclick = (e) => { e.stopPropagation(); createConversation(proj.id); };
        header.appendChild(addBtn);
      } else {
        header.textContent = group;
      }
      list.appendChild(header);
      lastGroup = group;
    }

    const div = document.createElement('div');
    div.className = 'conv-item' + (c.id === activeConvId ? ' active' : '') + (c.archivedAt ? ' archived' : '');
    div.onclick = () => switchConversation(c.id);
    div.dataset.convId = c.id;

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
      conversations.forEach((x, i) => x.sortOrder = i);
      saveConversations();
      renderSidebar();
    });

    const pinBtn = document.createElement('button');
    pinBtn.className = 'conv-pin' + (c.pinned ? ' pinned' : '');
    pinBtn.innerHTML = '&#128204;';
    pinBtn.title = c.pinned ? 'Unpin' : 'Pin';
    pinBtn.setAttribute('aria-label', c.pinned ? 'Unpin conversation' : 'Pin conversation');
    pinBtn.onclick = (e) => {
      e.stopPropagation();
      c.pinned = !c.pinned;
      saveConversations();
      renderSidebar();
    };

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

    const title = document.createElement('span');
    title.className = 'conv-title';
    title.textContent = c.title;
    title.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'conv-rename-input';
      input.value = c.title;
      input.onclick = (ev) => ev.stopPropagation();
      const commit = () => {
        const val = input.value.trim();
        if (val && val !== c.title) {
          c.title = val;
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
    });

    const del = document.createElement('button');
    del.className = 'conv-delete';
    del.innerHTML = '&times;';
    del.title = 'Delete';
    del.setAttribute('aria-label', 'Delete conversation');
    del.onclick = (e) => deleteConversation(c.id, e);

    div.appendChild(pinBtn);
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
    state.textContent = c.archivedAt ? 'Archived' : '';
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
    const tagBtn = document.createElement('button');
    tagBtn.className = 'conv-delete';
    tagBtn.innerHTML = '&#127991;';
    tagBtn.title = 'Tag';
    tagBtn.style.fontSize = '12px';
    tagBtn.setAttribute('aria-label', 'Tag conversation');
    tagBtn.onclick = (e) => { e.stopPropagation(); showTagPicker(c, tagBtn); };
    div.appendChild(tagBtn);
    const projBtn = document.createElement('button');
    projBtn.className = 'conv-delete';
    projBtn.innerHTML = '&#128193;';
    projBtn.title = 'Project';
    projBtn.style.fontSize = '12px';
    projBtn.setAttribute('aria-label', 'Move conversation to a project');
    projBtn.onclick = (e) => { e.stopPropagation(); showProjectPicker(c, projBtn); };
    div.appendChild(projBtn);
    const archiveBtn = document.createElement('button');
    archiveBtn.className = 'conv-delete conv-archive';
    archiveBtn.textContent = c.archivedAt ? '\u21A9' : '\u21E7';
    archiveBtn.title = c.archivedAt ? 'Restore conversation' : 'Archive conversation';
    archiveBtn.setAttribute('aria-label', archiveBtn.title);
    archiveBtn.onclick = e => { e.stopPropagation(); archiveConversation(c.id); };
    div.appendChild(archiveBtn);
    const duplicateBtn = document.createElement('button');
    duplicateBtn.className = 'conv-delete conv-duplicate';
    duplicateBtn.textContent = '\u2398';
    duplicateBtn.title = 'Duplicate conversation';
    duplicateBtn.setAttribute('aria-label', 'Duplicate conversation');
    duplicateBtn.onclick = e => { e.stopPropagation(); duplicateConversation(c.id); };
    div.appendChild(duplicateBtn);
    div.appendChild(del);
    list.appendChild(div);
  });
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
  none.onclick = () => { delete conv.tag; saveConversations(); renderSidebar(); picker.remove(); };
  picker.appendChild(none);
  TAG_COLORS.forEach(tc => {
    const btn = document.createElement('button');
    btn.className = 'tag-picker-item' + (conv.tag === tc.name ? ' active' : '');
    btn.style.background = tc.color;
    btn.title = tc.name;
    btn.onclick = () => { conv.tag = tc.name; saveConversations(); renderSidebar(); picker.remove(); };
    picker.appendChild(btn);
  });
  document.body.appendChild(picker);
  const closePicker = (e) => { if (!picker.contains(e.target) && e.target !== anchorEl) { picker.remove(); document.removeEventListener('click', closePicker); } };
  setTimeout(() => document.addEventListener('click', closePicker), 0);
}

function renderTagFilterBar() {
  const bar = document.getElementById('tagFilterBar');
  const usedTags = [...new Set(conversations.filter(c => c.tag).map(c => c.tag))];
  if (usedTags.length === 0) { bar.innerHTML = ''; return; }
  let html = '<button class="tag-filter-btn' + (!activeTagFilter ? ' active' : '') + '" onclick="setTagFilter(null)">All</button>';
  usedTags.forEach(tag => {
    const tc = TAG_COLORS.find(t => t.name === tag);
    html += '<button class="tag-filter-btn' + (activeTagFilter === tag ? ' active' : '') + '" style="' + (activeTagFilter === tag ? 'background:' + (tc ? tc.color : 'var(--accent)') + ';border-color:' + (tc ? tc.color : 'var(--accent)') : '') + '" onclick="setTagFilter(\'' + tag + '\')">' + tag + '</button>';
  });
  bar.innerHTML = html;
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
  const query = searchEl ? searchEl.value.toLowerCase() : '';
  const items = document.querySelectorAll('.conv-item');
  items.forEach(item => {
    const title = item.querySelector('.conv-title').textContent.toLowerCase();
    const convId = item.dataset.convId;
    const conv = conversations.find(c => c.id === convId);
    const matchesSearch = !query || title.includes(query);
    const matchesTag = !activeTagFilter || (conv && conv.tag === activeTagFilter);
    item.style.display = (matchesSearch && matchesTag) ? '' : 'none';
  });
  // Hide empty group headers
  document.querySelectorAll('.conv-group-header').forEach(header => {
    let next = header.nextElementSibling;
    let hasVisible = false;
    while (next && !next.classList.contains('conv-group-header')) {
      if (next.classList.contains('conv-item') && next.style.display !== 'none') hasVisible = true;
      next = next.nextElementSibling;
    }
    header.style.display = hasVisible ? '' : 'none';
  });
}

function isConversationVisibleInSidebar(conv) {
  if (!conv || (conversationView === 'archived') !== Boolean(conv.archivedAt)) return false;
  const query = document.getElementById('sidebarSearch')?.value.trim().toLowerCase() || '';
  const title = String(conv.title || '').toLowerCase();
  return (!query || title.includes(query)) && (!activeTagFilter || conv.tag === activeTagFilter);
}

// ============================================
// Sidebar Toggle
// ============================================
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  sb.classList.toggle('collapsed');
  overlay.classList.toggle('open', !sb.classList.contains('collapsed') && window.innerWidth <= 768);
}

// ============================================
// Toolbar Menu
// ============================================
function toggleToolbarMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('toolbarMenu');
  const open = menu.classList.toggle('open');
  document.getElementById('toolbarMoreBtn')?.setAttribute('aria-expanded', String(open));
  if (open) {
    toolbarMenuFocusReturn = document.activeElement;
    menu.querySelector('[role="menuitem"]')?.focus();
  } else {
    toolbarMenuFocusReturn = null;
  }
}
function closeToolbarMenu() {
  document.getElementById('toolbarMenu').classList.remove('open');
  document.getElementById('toolbarMoreBtn')?.setAttribute('aria-expanded', 'false');
  if (toolbarMenuFocusReturn && document.contains(toolbarMenuFocusReturn)) toolbarMenuFocusReturn.focus();
  toolbarMenuFocusReturn = null;
}
document.addEventListener('click', () => closeToolbarMenu());

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
  const keyLabel = inputs.key?.closest('form')?.querySelector('label[for="' + inputs.key.id + '"]');
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
  const providerName = inputs.provider?.value || inferProviderKey({ llmProxyUrl: baseUrl });
  const key = inputs.key?.value.trim() || '';
  const preset = getProviderPreset(providerName);
  if (!baseUrl || (preset.keyRequired && !key)) {
    renderConnectionStatus(target, preset.keyRequired ? 'Base URL and key required.' : 'Base URL required.', 'error');
    return;
  }
  const started = performance.now();
  renderConnectionStatus(target, 'Testing...', 'testing');
  announce('Testing ' + preset.label + ' connection.');
  try {
    const metadata = await fetchAvailableModelMetadata(baseUrl, key, providerName, inputs.format?.value || '');
    const elapsed = Math.max(0, Math.round(performance.now() - started));
    renderConnectionStatus(target, 'Success · ' + metadata.length + ' models · ' + elapsed + ' ms', 'success');
    announce('Connection succeeded. ' + metadata.length + ' models discovered.');
    if (metadata.length) {
      const ids = metadata.map(model => model.id);
      localStorage.setItem('llmModelList', JSON.stringify(ids));
      localStorage.setItem('llmModelMetadata', JSON.stringify(Object.fromEntries(metadata.filter(m => m.context_length).map(m => [m.id, m.context_length]))));
      populateModelSelect(target, ids);
    }
  } catch (err) {
    const elapsed = Math.max(0, Math.round(performance.now() - started));
    renderConnectionStatus(target, 'Failed · ' + elapsed + ' ms · ' + sanitizeErrorDetail(err), 'error');
    announce('Connection failed.');
  }
}

function getSelectedModel(target) {
  const manualEl = document.getElementById(target === 'setup' ? 'setupModelManual' : 'setModelManual');
  const selectEl = document.getElementById(target === 'setup' ? 'setupModelSelect' : 'setModelSelect');
  const manual = manualEl.value.trim();
  if (manual) return manual;
  return selectEl.value || localStorage.getItem('llmModel') || '';
}

function saveSetup() {
  let proxy = document.getElementById('setupProxy').value.trim();
  const key = document.getElementById('setupKey').value.trim();
  const provider = document.getElementById('setupProvider').value || 'custom';
  if (!proxy || (providerRequiresKey({ llmProvider: provider }) && !key)) { showToast(providerRequiresKey({ llmProvider: provider }) ? 'Base URL and API Key are required.' : 'Base URL is required.', 'error'); return; }
  proxy = proxy.replace(/\/(chat\/completions|messages)\/?$/, '');
  const model = getSelectedModel('setup');
  if (!model) { showToast('Choose or enter a model.', 'error'); return; }
  localStorage.setItem('llmProxyUrl', proxy);
  localStorage.setItem('llmProvider', provider);
  setApiKey(key, getSelectedKeyStorage('setup'));
  localStorage.setItem('llmModel', model);
  localStorage.setItem('llmApiFormat', document.getElementById('setupApiFormat')?.value || getProviderPreset(provider).apiFormat);
  closeModal('setupModal');
  renderConnectionChip();
  announce('Provider settings saved.');
  // Try to fetch models in the background
  if (key || !providerRequiresKey({ llmProvider: provider })) fetchAvailableModels(proxy, key).then(models => {
    localStorage.setItem('llmModelList', JSON.stringify(models));
    loadCachedModels('settings');
  }).catch(() => {});
}

function switchSettingsTab(tabName, btn) {
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-tab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('settingsTab-' + tabName).classList.add('active');
  if (tabName === 'data') renderStorageSummary();
}

function toggleCache(enabled) {
  localStorage.setItem('llmCacheEnabled', enabled ? 'true' : 'false');
  updateCacheStats();
  showToast(enabled ? 'Response cache enabled.' : 'Response cache disabled.', 'info');
}

async function clearResponseCache() {
  if (!confirm('Clear all cached responses?')) return;
  try {
    await cacheClear();
    await updateCacheStats();
    showToast('Response cache cleared.', 'success');
  } catch (err) {
    showToast('Could not clear cache: ' + (err.message || err), 'error');
  }
}

async function cleanupExpiredCache() {
  try {
    const deleted = await cacheCleanupExpired();
    await updateCacheStats();
    showToast(deleted ? ('Removed ' + deleted + ' expired cache ' + (deleted === 1 ? 'entry.' : 'entries.')) : 'No expired cache entries.', 'info');
  } catch (err) {
    showToast('Cache cleanup failed: ' + (err.message || err), 'error');
  }
}

async function updateCacheStats() {
  const el = document.getElementById('cacheStats');
  if (!el) return;
  if (!db) {
    el.textContent = 'Unavailable';
    return;
  }
  el.textContent = 'Loading...';
  try {
    const stats = await cacheGetStats();
    const parts = [
      stats.count + ' ' + (stats.count === 1 ? 'entry' : 'entries'),
      formatCacheBytes(stats.sizeBytes),
      stats.hits + ' ' + (stats.hits === 1 ? 'hit' : 'hits')
    ];
    if (stats.expired) parts.push(stats.expired + ' expired');
    el.textContent = parts.join(' | ');
  } catch (err) {
    el.textContent = 'Could not load';
  }
}

function openSettings() {
  document.getElementById('setProxy').value = localStorage.getItem('llmProxyUrl') || '';
  document.getElementById('setKey').value = getApiKey();
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
  document.getElementById('setWebSearch').checked = localStorage.getItem('llmWebSearch') === 'true';
  document.getElementById('setForceSearch').checked = localStorage.getItem('llmForceSearch') === 'true';
  document.getElementById('setUrlFetch').checked = localStorage.getItem('llmUrlFetch') !== 'false';
  document.getElementById('setToolConfirm').checked = localStorage.getItem('llmToolConfirm') === 'true';
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
  const cacheEnabled = document.getElementById('cacheEnabled');
  if (cacheEnabled) cacheEnabled.checked = isResponseCacheEnabled();
  updateCacheStats();
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

  openModal('settingsModal', '#setProxy');
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
    llmInputCost: document.getElementById('setInputCost').value.trim(),
    llmOutputCost: document.getElementById('setOutputCost').value.trim(),
    llmEnableStMacros: document.getElementById('setEnableStMacros').checked ? 'true' : 'false',
    llmRpUserName: document.getElementById('setRpUserName').value.trim()
  };
}

function applyProfileToInputs(settings) {
  document.getElementById('setProxy').value = settings.llmProxyUrl || '';
  document.getElementById('setKey').value = settings.llmApiKey || getApiKey();
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
  document.getElementById('setUrlFetch').checked = settings.llmUrlFetch !== 'false';
  document.getElementById('setToolConfirm').checked = settings.llmToolConfirm === 'true';
  document.getElementById('setSearchApiUrl').value = settings.llmSearchApiUrl || '';
  document.getElementById('setSearchApiKey').value = settings.llmSearchApiKey || '';
  document.getElementById('setCorsProxy').value = normalizeCorsProxyUrl(settings.llmCorsProxy);
  document.getElementById('setMemory').checked = parseEnabledSetting(settings.llmMemoryEnabled);
  document.getElementById('setHoldScreenshot').checked = settings.llmHoldScreenshot === 'true';
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
  const settings = profile.settings || {};
  Object.entries(settings).forEach(([k, v]) => {
    if (v === null || v === undefined) return;
    if (k === 'llmApiKey') return;
    localStorage.setItem(k, v);
  });
  if (settings.llmApiKey) setApiKey(settings.llmApiKey, getKeyStorageMode());
  localStorage.setItem('assistantActiveProfileId', profile.id);
  applyProfileToInputs(settings);
  renderProfileSummary();
  renderConnectionChip();
  showToast('Profile applied: ' + profile.name, 'success');
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

function saveSettings() {
  // Validate extra params JSON
  const extraParamsField = document.getElementById('setExtraParams');
  const extraParamsVal = extraParamsField.value.trim();
  if (extraParamsVal) {
    try {
      JSON.parse(extraParamsVal);
      extraParamsField.classList.remove('invalid');
    } catch(e) {
      extraParamsField.classList.add('invalid');
      showToast('Extra Parameters must be valid JSON.', 'error');
      return;
    }
  } else {
    extraParamsField.classList.remove('invalid');
  }

  let proxy = document.getElementById('setProxy').value.trim();
  proxy = proxy.replace(/\/(chat\/completions|messages)\/?$/, '');
  const providerName = document.getElementById('setProvider').value || 'custom';
  const keyValue = document.getElementById('setKey').value.trim();
  if (!proxy || (providerRequiresKey({ llmProvider: providerName }) && !keyValue)) {
    showToast(providerRequiresKey({ llmProvider: providerName }) ? 'Base URL and API Key are required.' : 'Base URL is required.', 'error');
    return;
  }
  const selectedModel = getSelectedModel('settings');
  if (!selectedModel) { showToast('Choose or enter a model.', 'error'); return; }
  localStorage.setItem('llmProxyUrl', proxy);
  localStorage.setItem('llmProvider', providerName);
  setApiKey(keyValue, getSelectedKeyStorage('settings'));
  localStorage.setItem('llmModel', selectedModel);
  localStorage.setItem('llmApiFormat', document.getElementById('setApiFormat').value);
  localStorage.setItem('llmExtraParams', extraParamsVal);
  localStorage.setItem('llmExcludeParams', document.getElementById('setExcludeParams').value.trim());
  const personaVal = document.getElementById('setPersona').value;
  { const c = getActiveConv();
    if (c) { c.persona = personaVal; saveConversations(); }
    // Only update global default if this is not a character-card conversation
    if (!c || !c.characterCard) localStorage.setItem('llmPersona', personaVal);
  }
  localStorage.setItem('llmEnableStMacros', document.getElementById('setEnableStMacros').checked ? 'true' : 'false');
  localStorage.setItem('llmRpUserName', document.getElementById('setRpUserName').value.trim());
  localStorage.setItem('llmPrefill', document.getElementById('setPrefill').value);
  localStorage.setItem('llmStreaming', document.getElementById('setStreaming').checked ? 'true' : 'false');
  localStorage.setItem('llmEnterSend', document.getElementById('setEnterSend').checked ? 'true' : 'false');
  const tempVal = document.getElementById('setTemperature').value.trim();
  localStorage.setItem('llmTemperature', tempVal);
  localStorage.setItem('llmMaxTokens', document.getElementById('setMaxTokens').value.trim());
  localStorage.setItem('llmContextWindow', document.getElementById('setContextWindow').value.trim());
  localStorage.setItem('llmPromptCache', document.getElementById('setPromptCache').checked ? 'true' : 'false');
  localStorage.setItem('llmThinking', document.getElementById('setThinking').checked ? 'true' : 'false');
  localStorage.setItem('llmThinkingEffort', document.getElementById('setThinkingEffort').value);
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
  localStorage.setItem('llmHoldScreenshot', document.getElementById('setHoldScreenshot').checked ? 'true' : 'false');
  setDebugPreference();
  syncSaveSettings(false);

  // Warn if web search enabled for non-Anthropic without search URL
  if (document.getElementById('setWebSearch').checked) {
    const fmt = document.getElementById('setApiFormat').value;
    const searchUrl = document.getElementById('setSearchApiUrl').value.trim();
    if (fmt !== 'anthropic' && fmt !== 'auto' && !searchUrl) {
      showToast('Web search enabled but no Search API URL set — search won\'t work for OpenAI-compatible models.', 'error');
    }
  }

  // Theme
  const themeName = document.getElementById('setTheme').value;
  if (themeName === 'custom') {
    localStorage.setItem('assistantCustomTheme', JSON.stringify(getCustomThemeFromPickers()));
  }
  applyTheme(themeName);

  // Message overrides
  const msgFs = document.getElementById('setMsgFontSize').value.trim();
  const msgMw = document.getElementById('setMsgMaxWidth').value.trim();
  msgFs ? localStorage.setItem('assistantMsgFontSize', msgFs) : localStorage.removeItem('assistantMsgFontSize');
  msgMw ? localStorage.setItem('assistantMsgMaxWidth', msgMw) : localStorage.removeItem('assistantMsgMaxWidth');
  applyMsgOverrides();

  // Font
  const fontName = document.getElementById('setFont').value.trim();
  localStorage.setItem('assistantFont', fontName);
  loadCustomFont(fontName);

  // Try to fetch models in background
  const key = document.getElementById('setKey').value.trim();
  if (proxy && (key || !providerRequiresKey({ llmProvider: providerName }))) {
    fetchAvailableModels(proxy, key).then(models => {
      localStorage.setItem('llmModelList', JSON.stringify(models));
    }).catch(() => {});
  }

  closeModal('settingsModal');
  renderConnectionChip();
  announce('Settings saved.');
}

function closeSettings() {
  closeModal('settingsModal');
  // Revert theme if user didn't save
  loadTheme();
}

// ============================================
// System Prompt Presets
// ============================================
function loadPresets() {
  let presets = [];
  try { presets = JSON.parse(localStorage.getItem('assistantPresets') || '[]'); } catch(e) { console.warn('Presets parse error:', e); }
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
  let presets = [];
  try { presets = JSON.parse(localStorage.getItem('assistantPresets') || '[]'); } catch(e) { console.warn('Presets parse error:', e); }
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
}

function saveCurrentAsPreset() {
  const name = prompt('Preset name:');
  if (!name) return;
  let presets = [];
  try { presets = JSON.parse(localStorage.getItem('assistantPresets') || '[]'); } catch(e) { console.warn('Presets parse error:', e); }
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
  loadPresets();
  document.getElementById('setPresetSelect').value = preset.id;
  showToast('Preset saved: ' + name, 'success');
}

function deleteSelectedPreset() {
  const select = document.getElementById('setPresetSelect');
  const id = select.value;
  if (!id) { showToast('Select a preset to delete.', 'info'); return; }
  let presets = [];
  try { presets = JSON.parse(localStorage.getItem('assistantPresets') || '[]'); } catch(e) { console.warn('Presets parse error:', e); }
  const preset = presets.find(p => p.id === id);
  if (!preset) return;
  if (!confirm('Delete preset "' + preset.name + '"?')) return;
  presets = presets.filter(p => p.id !== id);
  localStorage.setItem('assistantPresets', JSON.stringify(presets));
  loadPresets();

  // Clear imported prompt entries and extra params
  savePromptEntries([{ id: 'pe_' + Date.now() + '_sys', name: 'System Prompt', content: '', enabled: true }]);
  renderPromptEntries();
  document.getElementById('setTemperature').value = '';
  document.getElementById('setExtraParams').value = '';
  document.getElementById('setPersona').value = '';

  showToast('Preset deleted.', 'info');
}

function importSTPreset(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';
  const reader = new FileReader();
  reader.onload = function(e) {
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
    let presets = [];
    try { presets = JSON.parse(localStorage.getItem('assistantPresets') || '[]'); } catch(e) { console.warn('Presets parse error:', e); }
    const preset = {
      id: 'preset_' + Date.now(),
      name: presetName,
      promptEntries: loadPromptEntries(),
      temperature: temperature !== null ? String(temperature) : '',
      extraParams: document.getElementById('setExtraParams').value.trim()
    };
    presets.push(preset);
    localStorage.setItem('assistantPresets', JSON.stringify(presets));
    loadPresets();
    document.getElementById('setPresetSelect').value = preset.id;
    showToast('Imported ST preset: ' + presetName, 'success');
  };
  reader.readAsText(file);
}

// ============================================
// Prompt Manager
// ============================================
function loadPromptEntries() {
  try { return JSON.parse(localStorage.getItem('llmPromptEntries') || '[]'); } catch(e) { return []; }
}

function savePromptEntries(entries) {
  localStorage.setItem('llmPromptEntries', JSON.stringify(entries));
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
    div.draggable = true;

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
    expandBtn.textContent = '▼';
    expandBtn.title = 'Expand/collapse';
    expandBtn.onclick = () => {
      const body = div.querySelector('.prompt-entry-body');
      body.classList.toggle('open');
      expandBtn.textContent = body.classList.contains('open') ? '▲' : '▼';
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
  const project = getProject(conv && conv.projectId);
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
  const mem = await getMemoryPrompt();
  if (mem) msgs.push({ role: 'system', content: mem });
  return msgs;
}

function isFailedAssistantMessage(message) {
  if (!message || message.role !== 'assistant') return false;
  const request = message.swipeRequests?.[message.swipeIndex || 0];
  return ['failed', 'stopped', 'interrupted'].includes(request?.status) || /^\s*(Error:|Request failed:|Request interrupted\.)/i.test(getMsgText(message));
}

function isPendingAssistantMessage(message) {
  if (!message || message.role !== 'assistant') return false;
  const request = message.swipeRequests?.[message.swipeIndex || 0];
  return !String(getMsgText(message) || '').trim() || ['pending', 'streaming'].includes(request?.status);
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
    if (message.includeInContext === false) {
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
  const manual = Number(getActiveProfile()?.settings?.llmContextWindow || localStorage.getItem('llmContextWindow') || 0);
  if (manual > 0) return manual;
  try {
    const metadata = JSON.parse(localStorage.getItem('llmModelMetadata') || '{}');
    const value = Number(metadata[model]?.context_length ?? metadata[model]);
    return value > 0 ? value : null;
  } catch(e) { return null; }
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

function guardContextLimit(requestContext) {
  const stats = getRequestContextStats(requestContext?.messages, requestContext?.excluded);
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

async function openContextPreview() {
  const body = document.getElementById('contextPreviewBody');
  if (!body) return;
  body.textContent = 'Building request preview...';
  openModal('contextPreviewModal');
  try {
    const data = await buildContextPreviewData();
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
    body.textContent = 'Could not build preview: ' + sanitizeErrorDetail(err);
  }
}

async function compactOlderTurns() {
  if (readOnlyShare) return;
  const conv = getActiveConv();
  const candidates = messages.map((message, index) => ({ message, index })).filter(item => item.message.role !== 'system' && item.message.includeInContext !== false && !isFailedAssistantMessage(item.message));
  if (candidates.length <= 8) { showToast('There are not enough older turns to compact.', 'info'); return; }
  const older = candidates.slice(0, -8);
  const transcript = older.map(item => (item.message.role === 'assistant' ? 'Assistant: ' : 'User: ') + getMsgText(item.message)).join('\n');
  try {
    announce('Generating a nondestructive summary of older turns.');
    const summary = (await callApiNonStreaming([
      { role: 'system', content: 'Summarize these older conversation turns into a concise context note. Preserve facts, decisions, preferences, and unresolved tasks. Do not invent details.' },
      { role: 'user', content: transcript }
    ])).trim();
    if (!summary) throw new Error('The provider returned an empty summary.');
    conv.summary = conv.summary ? conv.summary + '\n\n' + summary : summary;
    conv.summaryUpdatedAt = Date.now();
    older.forEach(item => { item.message.includeInContext = false; });
    conv.updatedAt = Date.now();
    await saveConversationImmediately();
    showToast('Older turns summarized and excluded from future requests. History remains intact.', 'success');
    announce('Older turns compacted successfully.');
    await openContextPreview();
  } catch (err) {
    showToast('Compaction failed: ' + sanitizeErrorDetail(err), 'error');
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

function renderMessages() {
  closeChatSearch();
  const area = document.getElementById('messagesArea');
  area.innerHTML = '';

  if (messages.length === 0) {
    area.innerHTML = '<div class="chat-placeholder">Start a conversation...</div>';
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
      bubble.innerHTML = renderThinkingHTML(_hThink) + renderToolBlocksHTML(toolData || []) + renderMarkdown(_h.content) + renderGenImages(imgData);
      postRenderProcessing(bubble);
    } else {
      bubble.textContent = msg.content;
    }

    if (msg.role === 'assistant') maybeAddAvatar(wrapper);
    wrapper.appendChild(bubble);

    // Message actions
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.setAttribute('aria-label', 'Copy message');
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(getMsgText(msg));
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = 'Copy', 1500);
    };
    actions.appendChild(copyBtn);

    if (msg.role === 'assistant') {
      const speakBtn = document.createElement('button');
      speakBtn.className = 'msg-action-btn';
      speakBtn.textContent = 'Speak';
      speakBtn.setAttribute('aria-label', 'Read message aloud');
      speakBtn.onclick = () => speakMessage(msg, speakBtn);
      actions.appendChild(speakBtn);

      const toolData = msg.swipeToolUse && msg.swipeToolUse[msg.swipeIndex];
      const hasSources = (msg.swipeSources?.[msg.swipeIndex]?.length > 0) || (toolData && toolData.some(tb =>
        (tb.type === 'url_fetch' && (tb.content || tb.url)) ||
        (tb.results || []).some(r => r.url)
      ));
      if (hasSources) {
        const srcBtn = document.createElement('button');
        srcBtn.className = 'msg-action-btn';
        srcBtn.textContent = 'Sources';
        srcBtn.setAttribute('aria-label', 'View sources');
        srcBtn.onclick = () => openSourcesDrawer(msg);
        actions.appendChild(srcBtn);
      }
    }

    const contextBtn = document.createElement('button');
    contextBtn.className = 'msg-action-btn context-toggle-btn';
    contextBtn.textContent = msg.includeInContext === false ? 'Include' : 'Exclude';
    contextBtn.setAttribute('aria-label', (msg.includeInContext === false ? 'Include ' : 'Exclude ') + msg.role + ' message from context');
    contextBtn.onclick = () => {
      msg.includeInContext = msg.includeInContext === false;
      saveConversations();
      renderMessages();
      updateTokenInfo();
      announce(msg.includeInContext === false ? 'Message excluded from future context.' : 'Message included in future context.');
    };
    actions.appendChild(contextBtn);

    if (msg.role === 'user') {
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn';
      editBtn.textContent = 'Edit';
      editBtn.setAttribute('aria-label', 'Edit message');
      editBtn.onclick = () => { msg._editing = true; renderMessages(); };
      actions.appendChild(editBtn);
    }

    const forkBtn = document.createElement('button');
    forkBtn.className = 'msg-action-btn';
    forkBtn.textContent = 'Fork';
    forkBtn.setAttribute('aria-label', 'Fork conversation');
    forkBtn.onclick = () => forkBranch(idx);
    actions.appendChild(forkBtn);

    if (msg.role === 'assistant' && msg.swipes && msg.swipes.length > 1) {
      const delSwipeBtn = document.createElement('button');
      delSwipeBtn.className = 'msg-action-btn';
      delSwipeBtn.textContent = 'Delete Swipe';
      delSwipeBtn.setAttribute('aria-label', 'Delete current swipe');
      delSwipeBtn.onclick = () => {
        if (!confirm('Delete this swipe?')) return;
        const si = msg.swipeIndex;
        msg.swipes.splice(si, 1);
        if (msg.swipeThinking) msg.swipeThinking.splice(si, 1);
        if (msg.swipeToolUse) msg.swipeToolUse.splice(si, 1);
        if (msg.swipeImages) msg.swipeImages.splice(si, 1);
        msg.swipeIndex = Math.min(si, msg.swipes.length - 1);
        msg.content = msg.swipes[msg.swipeIndex];
        if (msg.swipeImages) msg.images = msg.swipeImages[msg.swipeIndex] || [];
        saveConversations();
        renderMessages();
        updateTokenInfo();
      };
      actions.appendChild(delSwipeBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'msg-action-btn';
    delBtn.textContent = 'Delete';
    delBtn.setAttribute('aria-label', 'Delete message');
    delBtn.onclick = () => {
      if (msg.role === 'assistant' && !confirm('Delete this response?')) return;
      messages.splice(idx, 1);
      saveConversations();
      renderMessages();
      updateTokenInfo();
    };
    actions.appendChild(delBtn);

    wrapper.appendChild(actions);

    const metaEl = renderMessageMeta(msg);
    if (metaEl) wrapper.appendChild(metaEl);
    const requestMeta = renderRequestMeta(msg);
    if (requestMeta) wrapper.appendChild(requestMeta);

    // Branch controls for user messages
    if (msg.role === 'user' && msg.branches && msg.branches.length > 1) {
      const branchDiv = document.createElement('div');
      branchDiv.className = 'branch-controls has-branches';
      const bPrev = document.createElement('button');
      bPrev.textContent = '\u25C0';
      bPrev.disabled = msg.branchIndex <= 0;
      bPrev.onclick = () => switchBranch(idx, -1);
      bPrev.setAttribute('aria-label', 'Previous branch');
      const bCounter = document.createElement('span');
      bCounter.textContent = (msg.branchIndex + 1) + '/' + msg.branches.length;
      const bNext = document.createElement('button');
      bNext.textContent = '\u25B6';
      bNext.disabled = msg.branchIndex >= msg.branches.length - 1;
      bNext.onclick = () => switchBranch(idx, 1);
      bNext.setAttribute('aria-label', 'Next branch');
      branchDiv.appendChild(bPrev);
      branchDiv.appendChild(bCounter);
      branchDiv.appendChild(bNext);
      wrapper.appendChild(branchDiv);
    }

    if (msg.role === 'assistant') {
      const request = getSwipeRequest(msg);
      if (request && ['failed', 'interrupted', 'stopped'].includes(request.status)) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'msg-action-btn retry-btn';
        retryBtn.textContent = 'Retry';
        retryBtn.setAttribute('aria-label', 'Retry failed request');
        retryBtn.onclick = () => retryRequest(idx);
        actions.appendChild(retryBtn);
        const detailsBtn = document.createElement('button');
        detailsBtn.className = 'msg-action-btn';
        detailsBtn.textContent = 'Details';
        detailsBtn.setAttribute('aria-label', 'Show request details');
        detailsBtn.onclick = () => showRequestDetails(request);
        actions.appendChild(detailsBtn);
      }
      // Swipe controls
      const swipeDiv = document.createElement('div');
      swipeDiv.className = 'swipe-controls' + (msg.swipes && msg.swipes.length > 1 ? ' has-swipes' : '');
      const prev = document.createElement('button');
      prev.textContent = '\u25C0';
      prev.disabled = !msg.swipes || msg.swipeIndex <= 0;
      prev.onclick = () => swipeMsg(idx, -1);
      prev.setAttribute('aria-label', 'Previous swipe');
      const counter = document.createElement('span');
      counter.textContent = msg.swipes ? (msg.swipeIndex + 1) + '/' + msg.swipes.length : '1/1';
      const next = document.createElement('button');
      next.textContent = '\u25B6';
      next.disabled = !msg.swipes || msg.swipeIndex >= msg.swipes.length - 1;
      next.onclick = () => swipeMsg(idx, 1);
      next.setAttribute('aria-label', 'Next swipe');
      swipeDiv.appendChild(prev);
      swipeDiv.appendChild(counter);
      swipeDiv.appendChild(next);
      wrapper.appendChild(swipeDiv);

      const regen = document.createElement('button');
      regen.className = 'regen-btn';
      regen.textContent = 'Regenerate';
      regen.setAttribute('aria-label', 'Regenerate response');
      regen.onclick = () => regenerate();

      const requestStatus = getSwipeRequest(msg)?.status;
      const canContinue = idx === messages.length - 1 &&
        Boolean(String(getMsgText(msg) || '').trim()) &&
        (!requestStatus || requestStatus === 'complete');
      if (canContinue) {
        const continueBtn = document.createElement('button');
        continueBtn.className = 'regen-btn';
        continueBtn.textContent = 'Continue';
        continueBtn.setAttribute('aria-label', 'Continue generation');
        continueBtn.onclick = () => continueMessage();

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:6px;justify-content:center';
        btnRow.appendChild(regen);
        btnRow.appendChild(continueBtn);
        wrapper.appendChild(btnRow);
      } else {
        wrapper.appendChild(regen);
      }
    }

    // Fade-in on last message only
    if (idx === messages.length - 1) wrapper.classList.add('msg-new');

    area.appendChild(wrapper);
  });

  area.scrollTop = area.scrollHeight;
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
  ta.value = getMsgText(msg);
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
    const editedText = ta.value;
    delete msg._editing;

    // Save old branch before truncating (deep clone to prevent mutation)
    const oldBranch = JSON.parse(JSON.stringify(messages.slice(idx)));
    if (!msg.branches) {
      msg.branches = [oldBranch];
    } else {
      msg.branches[msg.branchIndex] = oldBranch;
    }

    if (Array.isArray(msg.content)) {
      const attachments = msg.content.filter(c => c.type === 'image_url' || c.type === 'file');
      if (attachments.length > 0) {
        msg.content = [{ type: 'text', text: editedText }, ...attachments];
      } else {
        msg.content = editedText;
      }
    } else {
      msg.content = editedText;
    }
    updateMessageTokenMetadata(msg);
    messages.length = idx + 1;
    // Create new branch slot and switch to it
    msg.branchIndex = msg.branches.length;
    saveConversations();
    renderMessages();
    await resendAfterEdit();

    // Save new branch (after response)
    const newBranch = JSON.parse(JSON.stringify(messages.slice(idx)));
    msg.branches[msg.branchIndex] = newBranch;
    saveConversations();
    renderMessages();
  };

  editActions.appendChild(cancelBtn);
  editActions.appendChild(saveBtn);
  wrapper.appendChild(editActions);
  area.appendChild(wrapper);
}

async function resendAfterEdit() {
  if (readOnlyShare) return;
  const proxyUrl = localStorage.getItem('llmProxyUrl');
  const apiKey = getApiKey();
  const conv = getActiveConv();
  if (!proxyUrl || (providerRequiresKey() && !apiKey)) return;

  const assistantMsg = { role: 'assistant', content: '', swipes: [''], swipeIndex: 0, timestamp: Date.now() };
  messages.push(assistantMsg);

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

  const requestContext = await buildRequestMessages(conv, { messageList: messages });
  const apiMessages = requestContext.messages;
  if (guardContextLimit(requestContext)) {
    messages.pop();
    renderMessages();
    return;
  }

  await saveConversationImmediately().catch(error => { throw new Error('Could not save the edited prompt: ' + sanitizeErrorDetail(error)); });
  await streamResponse(apiMessages, assistantMsg, 0, bubble, null, null, { conv });

  if (assistantMsg._responseCacheHit || getSwipeRequest(assistantMsg)?.status !== 'complete') {
    delete assistantMsg._responseCacheHit;
  } else {
    extractMemories(apiMessages);
  }
  if (conv) conv.updatedAt = Date.now();
  saveConversations();
  renderMessages();
  updateTokenInfo();
}

// ============================================
// Swipe
// ============================================
function swipeMsg(idx, dir) {
  const msg = messages[idx];
  if (!msg || !msg.swipes) return;
  msg.swipeIndex = Math.max(0, Math.min(msg.swipes.length - 1, msg.swipeIndex + dir));
  msg.content = msg.swipes[msg.swipeIndex];
  if (msg.swipeImages) msg.images = msg.swipeImages[msg.swipeIndex] || [];
  debouncedSave();
  renderMessages();
  updateTokenInfo();
}

// ============================================
// Branch Switching
// ============================================
function switchBranch(msgIdx, dir) {
  const msg = messages[msgIdx];
  if (!msg || !msg.branches) return;
  // Save current continuation as the current branch (deep clone)
  msg.branches[msg.branchIndex] = JSON.parse(JSON.stringify(messages.slice(msgIdx)));
  // Switch
  const newIdx = Math.max(0, Math.min(msg.branches.length - 1, msg.branchIndex + dir));
  if (newIdx === msg.branchIndex) return;
  msg.branchIndex = newIdx;
  // Replace messages from msgIdx onward with the selected branch (deep clone)
  const branch = JSON.parse(JSON.stringify(msg.branches[msg.branchIndex]));
  messages.length = msgIdx;
  branch.forEach(m => messages.push(m));
  debouncedSave();
  renderMessages();
  updateTokenInfo();
}

function forkBranch(msgIdx) {
  if (readOnlyShare || streaming) return;
  const conv = getActiveConv();
  if (!conv) return;

  const forkedMessages = JSON.parse(JSON.stringify(messages.slice(0, msgIdx + 1)));

  const newConv = {
    id: genId(),
    title: conv.title + ' (fork)',
    messages: forkedMessages,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  if (conv.characterAvatar) newConv.characterAvatar = conv.characterAvatar;
  if (conv.characterData) newConv.characterData = JSON.parse(JSON.stringify(conv.characterData));

  conversations.unshift(newConv);
  activeConvId = newConv.id;
  messages = newConv.messages;
  saveConversations();
  renderSidebar();
  renderMessages();
  updateTokenInfo();
  updateCharacterUI();
}

// ============================================
// Thinking/Reasoning Rendering
// ============================================
function renderThinkingHTML(text) {
  if (!text) return '';
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<div class="thinking-block">' +
    '<div class="thinking-header" onclick="this.nextElementSibling.classList.toggle(\'open\');this.querySelector(\'.thinking-arrow\').textContent=this.nextElementSibling.classList.contains(\'open\')?\'\u25BE\':\'\u25B8\'">' +
    '\uD83D\uDCAD Thinking <span class="thinking-arrow">\u25B8</span></div>' +
    '<div class="thinking-content">' + escaped + '</div></div>';
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
        return '<div class="tool-use-block" role="status" aria-live="polite"><div class="tool-use-header">\u{1F310} Reading ' + displayUrl + '\u2026</div></div>';
      }
      if (tb.error) {
        return '<div class="tool-use-block" role="status" aria-live="polite"><div class="tool-use-header">\u{1F310} ' + displayUrl + ' \u00B7 <span style="color:var(--error-color,#ff7777)">' + escapeHTML(tb.error) + '</span></div></div>';
      }
      const charCount = (tb.content || '').length;
      const preview = escapeHTML((tb.content || '').slice(0, 300));
      return '<details class="tool-use-block" aria-label="URL fetch result">' +
        '<summary class="tool-use-header">\u{1F310} Fetched ' + displayUrl + ' \u00B7 ' + charCount.toLocaleString() + ' chars</summary>' +
        '<div class="tool-use-results"><div class="tool-result-snippet" style="max-height:200px;overflow-y:auto;white-space:pre-wrap;font-size:0.8em;padding:8px">' + preview + (charCount > 300 ? '\u2026' : '') + '</div></div></details>';
    }
    // --- web_search blocks (default) ---
    const query = tb.query || '';
    const results = tb.results || [];
    const searching = tb.searching;
    if (searching) {
      return '<div class="tool-use-block" role="status" aria-live="polite"><div class="tool-use-header">\u{1F50D} Searching\u2026</div></div>';
    }
    const escapedQuery = escapeHTML(query);
    if (tb.error) {
      return '<div class="tool-use-block" role="status" aria-live="polite"><div class="tool-use-header">\u{1F50D} Searched "' + escapedQuery + '" \u00B7 <span style="color:var(--error-color,#ff7777)">' + escapeHTML(tb.error) + '</span></div></div>';
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
    const headerText = '\u{1F50D} Searched "' + escapedQuery + '" \u00B7 ' + count + ' result' + (count !== 1 ? 's' : '');
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

function proxiedFetch(url, options) {
  const proxy = getCorsProxyUrl();
  return fetch(proxy + encodeURIComponent(url), options).catch(err => {
    if (err.name === 'AbortError') throw err;
    const msg = err.message || '';
    if (msg === 'Failed to fetch' || msg === 'Load failed' || msg.includes('NetworkError') || msg.includes('CORS')) {
      const fallbackProxy = 'https://api.allorigins.win/raw?url=';
      return fetch(fallbackProxy + encodeURIComponent(url), options);
    }
    throw err;
  });
}

async function fetchWebSearchWithFallback(url, options) {
  try {
    return await fetchApiWithHttpSupport(url, options, url);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (!isNetworkLikeFetchError(err)) throw err;
    return await proxiedFetch(url, options);
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

async function executeWebSearch(query, signal) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) {
    lastSearchStatus = { ok: false, error: 'Search query is empty.', at: Date.now(), query: '' };
    return { results: [], error: 'Search query is empty.' };
  }

  const searchUrl = (localStorage.getItem('llmSearchApiUrl') || 'https://purasearx.duckdns.org/search?format=json').trim();
  const searchKey = (localStorage.getItem('llmSearchApiKey') || '').trim();
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

    const resp = await fetchWebSearchWithFallback(fetchUrl, { headers: fetchHeaders, signal });
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

// Parse tool calls that models output as text instead of using the proper API mechanism
// Matches: <tool_call>{"name":"web_search",...}</tool_call>, ```json\n{"name":...}\n```, etc.
function parseTextToolCalls(text) {
  const calls = [];
  // Pattern 1: <tool_call>...</tool_call>
  const tagPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m;
  while ((m = tagPattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed.name && HANDLED_TOOLS.has(parsed.name)) {
        calls.push({ id: 'text_tc_' + calls.length, name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) });
      }
    } catch(e) {}
  }
  // Pattern 2: ```json\n{"name":"web_search",...}\n``` or ```\n{"name":...}\n```
  if (calls.length === 0) {
    const codePattern = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/gi;
    while ((m = codePattern.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(m[1]);
        if (parsed.name && HANDLED_TOOLS.has(parsed.name)) {
          calls.push({ id: 'text_tc_' + calls.length, name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) });
        }
      } catch(e) {}
    }
  }
  // Pattern 3: {"name": "web_search", "arguments": {...}} as bare JSON in text
  if (calls.length === 0) {
    const jsonPattern = /\{\s*"name"\s*:\s*"(web_search|url_fetch)"[\s\S]*?"arguments"\s*:\s*(\{[^}]*\})\s*\}/gi;
    while ((m = jsonPattern.exec(text)) !== null) {
      try {
        const args = JSON.parse(m[2]);
        if (HANDLED_TOOLS.has(m[1])) {
          calls.push({ id: 'text_tc_' + calls.length, name: m[1], arguments: JSON.stringify(args) });
        }
      } catch(e) {}
    }
  }
  return calls;
}

function stripTextToolCalls(text) {
  return text
    .replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/gi, '')
    .replace(/```(?:json)?\s*\n?\s*\{\s*"name"\s*:\s*"(?:web_search|url_fetch)"[\s\S]*?\}\s*\n?\s*```/gi, '')
    .replace(/\{\s*"name"\s*:\s*"(?:web_search|url_fetch)"[\s\S]*?"arguments"\s*:\s*\{[^}]*\}\s*\}/gi, '')
    .trim();
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
  return [
    'https://r.jina.ai/http://' + url,
    'https://r.jina.ai/http://' + stripped
  ];
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

async function executeUrlFetch(url, signal) {
  const targetUrl = safeHttpUrl(url);
  if (!targetUrl) {
    return { content: '', error: 'Invalid URL. Use a full URL starting with http:// or https://.' };
  }

  let primaryReadable = '';
  let lastError = '';

  try {
    const resp = await proxiedFetch(targetUrl, { signal });
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
  assistantMsg.swipeRequests[swipeIdx] = request;
  return request;
}

function finishRequestMetadata(request, status, error = '', httpStatus = null) {
  if (!request) return;
  request.status = status;
  request.completedAt = Date.now();
  request.durationMs = request.startedAt ? Math.max(0, request.completedAt - request.startedAt) : null;
  request.httpStatus = Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : request.httpStatus || null;
  request.error = sanitizeErrorDetail(error);
}

async function authorizeExternalTool(toolName, conv, authorization) {
  if (!canUseTool(toolName, conv)) return false;
  const policy = getToolPolicy(conv);
  if (!policy.confirm) return true;
  if (authorization.confirmed == null) {
    authorization.confirmed = window.confirm('The assistant wants to use ' + (toolName === 'web_search' ? 'web search' : 'URL fetching') + ' for this response. Allow it?');
    announce(authorization.confirmed ? 'External tool approved for this response.' : 'External tool denied.');
  }
  return authorization.confirmed;
}

async function executeAuthorizedTool(toolName, args, conv, signal, authorization) {
  if (!(await authorizeExternalTool(toolName, conv, authorization))) {
    return { results: [], content: '', error: 'Tool call denied by user; no external request was made.', denied: true };
  }
  if (toolName === 'web_search') return executeWebSearch(extractWebSearchQueryFromArgs(args), signal);
  return executeUrlFetch(args?.url || '', signal);
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
  const baseUrl = (localStorage.getItem('llmProxyUrl') || '').replace(/\/+$/, '');
  const apiKey = getApiKey();
  const model = overrideModel || localStorage.getItem('llmModel') || '';
  const format = detectApiFormat(model);
  const requestConv = requestOptions.conv || getActiveConv();
  const toolPolicy = getToolPolicy(requestConv);
  const authorization = { confirmed: null };
  const contextStats = getRequestContextStats(apiMessages, [], model);
  const request = createRequestMetadata(assistantMsg, swipeIdx, {
    model,
    apiFormat: format,
    messageCount: apiMessages?.length || 0,
    promptTokens: contextStats.includedTokens,
    contextWindow: contextStats.contextWindow
  });
  const sourceRegistry = sourceRegistryFor(assistantMsg, swipeIdx);
  activeSourceRegistry = sourceRegistry;
  setAssistantLlmMetadata(assistantMsg, swipeIdx, model, format);
  saveConversationImmediately().catch(error => console.warn('Could not persist pending request:', error));

  // Extra params & excludes
  let extra = {};
  try { extra = JSON.parse(localStorage.getItem('llmExtraParams') || '{}'); } catch(e) { console.warn('Extra params parse error:', e); }
  const exclude = (localStorage.getItem('llmExcludeParams') || '').split(',').map(s => s.trim()).filter(Boolean);

  let responseCacheKey = '';
  let responseCacheUserMessage = null;
  let responseCacheSystemMessages = [];
  if (isResponseCacheEnabled() && !prefixText) {
    try {
      const cacheParts = getResponseCacheRequestParts(apiMessages);
      responseCacheUserMessage = cacheParts.userMessage;
      responseCacheSystemMessages = cacheParts.systemMessages;
      if (responseCacheUserMessage) {
        responseCacheKey = await generateCacheKey(responseCacheUserMessage, model, responseCacheSystemMessages, {
          messages: cacheParts.messages,
          settings: getRequestAffectingSettings(model, format, toolPolicy),
          credentialScope: fallbackHash(getApiKey() + '\0' + (localStorage.getItem('llmSearchApiKey') || ''))
        });
        const cached = await cacheLookup(responseCacheKey);
        if (cached) {
          restoreCachedResponse(cached, assistantMsg, swipeIdx, bubbleEl);
          finishRequestMetadata(request, 'complete');
          activeSourceRegistry = null;
          showToast('Loaded cached response.', 'success');
          return;
        }
      }
    } catch (cacheErr) {
      console.warn('Response cache lookup failed:', cacheErr);
      responseCacheKey = '';
    }
  }

  abortController = new AbortController();
  streaming = true;
  request.status = 'streaming';
  announce('Generating response.');
  userScrolledAway = false;
  const btn = document.getElementById('sendBtn');
  btn.textContent = 'Stop';
  btn.classList.add('streaming');
  btn.disabled = false;

  let fullText = prefixText || '';
  let thinkingText = '';
  let lastRender = 0;
  let toolBlocks = [];
  let currentBlockType = null;
  let inputJsonBuf = '';
  let toolCallBuffers = {};
  let currentToolUseId = null;
  let currentToolUseName = null;
  let pendingAnthropicToolCalls = [];
  let responseStatus = null;

  try {
    let url, headers, body;
    const useStream = localStorage.getItem('llmStreaming') !== 'false';

    // Assistant prefill. A trailing assistant turn is rejected with a 400 by Claude 4.6
    // and later, so skip it there rather than failing every request; the settings field
    // carries a matching note.
    const prefillBlocked = format === 'anthropic' && /opus-5|sonnet-5|opus-4-[678]|sonnet-4-6|fable-5|mythos-5/i.test(model);
    const prefill = prefillBlocked ? '' : (localStorage.getItem('llmPrefill') || '');
    if (prefill && !prefixText) {
      apiMessages.push({ role: 'assistant', content: prefill });
      fullText = prefill;
    }

    if (format === 'anthropic') {
      url = baseUrl + '/messages';
      headers = buildProviderHeaders('anthropic', apiKey);
      const prepared = prepareAnthropicMessages(apiMessages);
      const thinkingOn = localStorage.getItem('llmThinking') === 'true';
      const thinkingEffort = localStorage.getItem('llmThinkingEffort') || '';
      body = {
        model,
        system: prepared.system,
        messages: prepared.messages,
        max_tokens: resolveMaxTokens(),
        stream: useStream,
        // Adaptive thinking only. budget_tokens is rejected by Opus 4.7+ / Sonnet 5 /
        // Fable 5; display defaults to "omitted" there, which renders an empty pane.
        ...(thinkingOn ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
        ...(thinkingEffort ? { output_config: { effort: thinkingEffort } } : {}),
        ...extra
      };
      if (toolPolicy.webSearch || toolPolicy.urlFetch) {
        body.tools = (body.tools || []).concat([
          ...(toolPolicy.webSearch ? [toolPolicy.confirm ? ANTHROPIC_WEB_SEARCH_TOOL : { type: 'web_search_20250305', name: 'web_search', max_uses: 20 }] : []),
          ...(toolPolicy.urlFetch ? [ANTHROPIC_URL_FETCH_TOOL] : [])
        ]);
        if (toolPolicy.webSearch && localStorage.getItem('llmForceSearch') === 'true') {
          body.tool_choice = { type: 'any' };
          body.system = (body.system || '') + '\n\nIMPORTANT: You MUST call the web_search tool to look up information before answering. Do NOT answer from memory or training data. Always search first, then synthesize your answer from the results.';
        }
      }
      // Prompt caching. Must run AFTER the force-search concat above, which appends to
      // body.system as a string. Breakpoint goes on the system block only: `system`
      // survives the { ...body } spreads into tool follow-up requests, whereas a
      // breakpoint on the last message would go stale as soon as `messages` is replaced.
      if (typeof body.system === 'string' && body.system && localStorage.getItem('llmPromptCache') !== 'false') {
        body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }];
      }
    } else {
      url = baseUrl + '/chat/completions';
      headers = buildProviderHeaders('openai', apiKey);
      const processedMessages = apiMessages.map(m => {
        if (!Array.isArray(m.content)) return m;
        // Strip image parts from assistant messages — most APIs don't accept them
        if (m.role === 'assistant') {
          const textParts = m.content.filter(p => p.type === 'text');
          const hadImages = m.content.some(p => p.type === 'image_url');
          if (hadImages) textParts.push({ type: 'text', text: '[Generated image]' });
          const joined = textParts.map(p => p.text).join('');
          return { ...m, content: joined || '[Generated image]' };
        }
        return {
          ...m,
          content: m.content.map(part => {
            if (part.type === 'image_url' && part.image_url) {
              return { type: 'image_url', image_url: { url: part.image_url.url } };
            }
            if (part.type === 'file') {
              const name = part.file?.name || 'file';
              const text = part.file?.textContent;
              if (typeof text === 'string') {
                return { type: 'text', text: `--- ${name} ---\n${text}\n--- end ${name} ---` };
              }
              return { type: 'text', text: `[Attached file: ${name}]` };
            }
            return part;
          })
        };
      });
      body = { model, messages: processedMessages, stream: useStream, ...extra };
      // Inject web search tool for OpenAI-compatible models
      if (toolPolicy.webSearch || toolPolicy.urlFetch) {
        body.tools = (body.tools || []).concat([
          ...(toolPolicy.webSearch ? [OPENAI_WEB_SEARCH_TOOL] : []),
          ...(toolPolicy.urlFetch ? [OPENAI_URL_FETCH_TOOL] : [])
        ]);
        if (toolPolicy.webSearch && localStorage.getItem('llmForceSearch') === 'true') {
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
      const temp = parseFloat(localStorage.getItem('llmTemperature'));
      if (!isNaN(temp)) body.temperature = temp;
    }
    // Sampling params are rejected with a 400 by current Claude models. This block runs
    // for both API formats, so without the strip a saved temperature breaks every
    // request on those models with no hint as to why.
    if (format === 'anthropic' && NO_SAMPLING_PARAMS_RE.test(model)) {
      delete body.temperature; delete body.top_p; delete body.top_k;
    }
    exclude.forEach(k => delete body[k]);
    debugLogPayload('API request', body, { url, format, model });

    let resp = await fetchApiWithHttpSupport(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal
    }, baseUrl);
    responseStatus = resp.status;

    // If tool_choice caused a 400 (e.g. Gemini doesn't support "required"), retry without it
    if (!resp.ok && resp.status === 400 && body.tool_choice) {
      const saved = body.tool_choice;
      delete body.tool_choice;
      console.warn('Retrying without tool_choice (was:', saved, ')');
      resp = await fetchApiWithHttpSupport(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal
      }, baseUrl);
      responseStatus = resp.status;
    }

    if (!resp.ok) {
      let errText = '';
      try { errText = await resp.text(); } catch(e) { console.warn('Error reading response text:', e); }
      throw new Error('API returned ' + resp.status + (errText ? ': ' + errText.slice(0, 200) : ''));
    }

    const ct = resp.headers.get('content-type') || '';

    if (ct.includes('application/json')) {
      const data = await resp.json();
      if (format === 'anthropic') {
        fullText = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
        // Extract thinking blocks from non-streaming response
        thinkingText = (data.content || []).filter(c => c.type === 'thinking').map(c => c.thinking).join('');
        // Extract tool blocks from non-streaming response
        for (const block of (data.content || [])) {
          if (block.type === 'server_tool_use' && block.name === 'web_search') {
            toolBlocks.push({ query: extractWebSearchQueryFromArgs(block.input), results: [], searching: false });
          } else if (block.type === 'web_search_tool_result') {
            const tb = toolBlocks[toolBlocks.length - 1] || { query: '', results: [], searching: false };
            if (!toolBlocks.length) toolBlocks.push(tb);
            tb.results = (block.content || []).filter(r => r.type === 'web_search_result').map(r => ({
              title: r.title,
              url: r.url,
              snippet: r.snippet || r.content || r.description || r.summary || ''
            }));
            tb.searching = false;
          } else if (block.type === 'tool_use' && HANDLED_TOOLS.has(block.name)) {
            if (block.name === 'url_fetch') {
              toolBlocks.push({ type: 'url_fetch', url: block.input?.url || '', content: '', searching: true });
            } else {
              toolBlocks.push({ query: extractWebSearchQueryFromArgs(block.input), results: [], searching: true });
            }
            pendingAnthropicToolCalls.push({ id: block.id, name: block.name, input: block.input || {}, toolBlockIndex: toolBlocks.length - 1 });
          }
        }
        // Execute pending Anthropic custom tool calls (non-streaming)
        if (pendingAnthropicToolCalls.length > 0) {
          const toolUseContentBlocks = [];
          const toolResultBlocks = [];
          for (const call of pendingAnthropicToolCalls) {
            toolUseContentBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
            if (call.name === 'url_fetch') {
              const tb = toolBlocks[call.toolBlockIndex];
              const fetchUrl = call.input?.url || '';
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
              const { content, error } = await executeAuthorizedTool('url_fetch', { url: fetchUrl }, requestConv, abortController.signal, authorization);
              if (tb) { tb.content = content; tb.searching = false; if (error) tb.error = error; }
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
              toolResultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: formatUrlFetchResultForModel(content, error, fetchUrl) });
            } else if (call.name === 'web_search') {
              const tb = toolBlocks[call.toolBlockIndex];
              const query = extractWebSearchQueryFromArgs(call.input);
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
              const { results, error } = await executeAuthorizedTool('web_search', { query }, requestConv, abortController.signal, authorization);
              if (tb) { tb.results = results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet })); tb.searching = false; if (error) tb.error = error; }
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
              toolResultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: formatSearchResultsForModel(results, error) });
            }
          }
          // Follow-up non-streaming request
          const prepared = prepareAnthropicMessages(apiMessages);
          const followUpMessages = [
            ...prepared.messages,
            { role: 'assistant', content: [
              ...(fullText && fullText !== 'No response.' ? [{ type: 'text', text: fullText }] : []),
              ...toolUseContentBlocks
            ]},
            { role: 'user', content: toolResultBlocks }
          ];
          const followUpBody = { ...body, messages: followUpMessages, stream: false };
          delete followUpBody.tools;
          delete followUpBody.tool_choice;
          exclude.forEach(k => delete followUpBody[k]);
          debugLogPayload('API follow-up request', followUpBody, { url, format, model, stage: 'anthropic-tools' });
          const followUpResp = await fetchApiWithHttpSupport(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(followUpBody),
            signal: abortController.signal
          }, baseUrl);
          if (!followUpResp.ok) {
            let errText = '';
            try { errText = await followUpResp.text(); } catch(e) {}
            throw new Error('Follow-up API returned ' + followUpResp.status + (errText ? ': ' + errText.slice(0, 200) : ''));
          }
          const followUpData = await followUpResp.json();
          if (followUpData.type === 'error' || followUpData.error) {
            console.warn('Follow-up API error:', followUpData.error?.message || JSON.stringify(followUpData.error));
          }
          const followUpText = (followUpData.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
          if (followUpText) fullText = followUpText;
          const followThink = (followUpData.content || []).filter(c => c.type === 'thinking').map(c => c.thinking).join('');
          if (followThink) thinkingText += followThink;
          pendingAnthropicToolCalls = [];
        }
      } else {
        const extracted = extractImages(data.choices?.[0]?.message || data);
        fullText = extracted.text || '';
        if (extracted.images.length) {
          assistantMsg.swipeImages = assistantMsg.swipeImages || [];
          assistantMsg.swipeImages[swipeIdx] = extracted.images;
          assistantMsg.images = extracted.images;
        }
        thinkingText = data.choices?.[0]?.message?.reasoning_content
          || data.choices?.[0]?.message?.reasoning || '';
        // Handle OpenAI tool calls (non-streaming)
        const msgToolCalls = (data.choices?.[0]?.message?.tool_calls || []).filter(tc => HANDLED_TOOLS.has(tc.function?.name));
        // Fallback: parse text-based tool calls (separate path — uses user message follow-up)
        let textBasedToolCalls = [];
        if (msgToolCalls.length === 0 && fullText) {
          const textCalls = parseTextToolCalls(fullText);
          if (textCalls.length > 0) textBasedToolCalls = textCalls;
        }
        if (msgToolCalls.length > 0) {
          const assistantToolMsg = {
            role: 'assistant',
            content: fullText || null,
            tool_calls: msgToolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.function.name, arguments: tc.function.arguments }
            }))
          };
          const toolResultMsgs = [];
          for (const tc of msgToolCalls) {
            const toolName = tc.function?.name;
            let args = {};
            try { args = JSON.parse(tc.function.arguments); } catch(e) {}
            if (toolName === 'url_fetch') {
              const fetchUrl = args.url || '';
              toolBlocks.push({ type: 'url_fetch', url: fetchUrl, content: '', searching: true });
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
              const { content, error } = await executeAuthorizedTool('url_fetch', { url: fetchUrl }, requestConv, abortController.signal, authorization);
              const tb = toolBlocks[toolBlocks.length - 1];
              tb.content = content;
              tb.searching = false;
              if (error) tb.error = error;
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
              toolResultMsgs.push({ role: 'tool', tool_call_id: tc.id, content: formatUrlFetchResultForModel(content, error, fetchUrl) });
            } else {
              const query = extractWebSearchQueryFromArgs(args);
              toolBlocks.push({ query, results: [], searching: true });
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
              const { results, error } = await executeAuthorizedTool('web_search', { query }, requestConv, abortController.signal, authorization);
              const tb = toolBlocks[toolBlocks.length - 1];
              tb.results = results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
              tb.searching = false;
              if (error) tb.error = error;
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
              toolResultMsgs.push({ role: 'tool', tool_call_id: tc.id, content: formatSearchResultsForModel(results, error) });
            }
          }
          // Follow-up non-streaming request
          const followUpMessages = [...body.messages, assistantToolMsg, ...toolResultMsgs];
          const followUpBody = { ...body, messages: followUpMessages, stream: false };
          delete followUpBody.tools;
          delete followUpBody.tool_choice;
          exclude.forEach(k => delete followUpBody[k]);
          debugLogPayload('API follow-up request', followUpBody, { url, format, model, stage: 'openai-tools' });
          const followUpResp = await fetchApiWithHttpSupport(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(followUpBody),
            signal: abortController.signal
          }, baseUrl);
          if (!followUpResp.ok) {
            let errText = '';
            try { errText = await followUpResp.text(); } catch(e) {}
            throw new Error('Follow-up API returned ' + followUpResp.status + (errText ? ': ' + errText.slice(0, 200) : ''));
          }
          const followUpData = await followUpResp.json();
          if (followUpData.error) {
            console.warn('Follow-up API error:', followUpData.error?.message || JSON.stringify(followUpData.error));
          }
          const followExtracted = extractImages(followUpData.choices?.[0]?.message || followUpData);
          if (followExtracted.text) fullText = followExtracted.text;
          if (followExtracted.images.length) {
            assistantMsg.swipeImages = assistantMsg.swipeImages || [];
            assistantMsg.swipeImages[swipeIdx] = followExtracted.images;
            assistantMsg.images = followExtracted.images;
          }
          const followThinking = followUpData.choices?.[0]?.message?.reasoning_content
            || followUpData.choices?.[0]?.message?.reasoning || '';
          if (followThinking) thinkingText += followThinking;
        }
        // Handle text-based tool calls (separate from API tool calls — uses user message follow-up)
        if (textBasedToolCalls.length > 0 && msgToolCalls.length === 0) {
          const savedText = fullText;
          fullText = stripTextToolCalls(fullText);
          const textToolResults = [];
          for (const tc of textBasedToolCalls) {
            let args = {};
            try { args = JSON.parse(tc.arguments); } catch(e) {}
            if (tc.name === 'url_fetch') {
              const fetchUrl = args.url || '';
              toolBlocks.push({ type: 'url_fetch', url: fetchUrl, content: '', searching: true });
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
              const { content, error } = await executeAuthorizedTool('url_fetch', { url: fetchUrl }, requestConv, abortController.signal, authorization);
              const tb = toolBlocks[toolBlocks.length - 1];
              tb.content = content; tb.searching = false;
              if (error) tb.error = error;
              textToolResults.push('URL Fetch (' + fetchUrl + '):\n' + formatUrlFetchResultForModel(content, error, fetchUrl));
            } else {
              const query = extractWebSearchQueryFromArgs(args);
              toolBlocks.push({ query, results: [], searching: true });
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
              const { results, error } = await executeAuthorizedTool('web_search', { query }, requestConv, abortController.signal, authorization);
              const tb = toolBlocks[toolBlocks.length - 1];
              tb.results = results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
              tb.searching = false;
              if (error) tb.error = error;
              textToolResults.push('Web Search (' + query + '):\n' + formatSearchResultsForModel(results, error));
            }
            bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
          }
          const followUpMessages = [...body.messages,
            { role: 'assistant', content: savedText },
            { role: 'user', content: 'Here are the tool results:\n\n' + textToolResults.join('\n\n') + '\n\nPlease synthesize a response using these results.' }
          ];
          const followUpBody = { ...body, messages: followUpMessages, stream: false };
          delete followUpBody.tools;
          delete followUpBody.tool_choice;
          exclude.forEach(k => delete followUpBody[k]);
          debugLogPayload('API follow-up request', followUpBody, { url, format, model, stage: 'text-tools' });
          try {
            const followUpResp = await fetchApiWithHttpSupport(url, { method: 'POST', headers, body: JSON.stringify(followUpBody), signal: abortController.signal }, baseUrl);
            if (followUpResp.ok) {
              const followUpData = await followUpResp.json();
              const followText = followUpData.choices?.[0]?.message?.content || '';
              if (followText) fullText = followText;
            }
          } catch(e) { console.warn('Text tool call follow-up failed:', e); }
          if (!fullText) fullText = savedText;
        }
        if (!fullText && !toolBlocks.some(block => block.content || (block.results || []).length)) {
          fullText = 'No response received. Retry to try again.';
          finishRequestMetadata(request, 'failed', 'Provider returned an empty response.', responseStatus);
        }
      }
      const stripped = stripThinkTags(fullText);
      if (stripped.thinking) thinkingText += stripped.thinking;
      fullText = stripped.content;
      assistantMsg.swipes[swipeIdx] = fullText;
      assistantMsg.content = fullText;
      if (thinkingText) {
        assistantMsg.swipeThinking = assistantMsg.swipeThinking || [];
        assistantMsg.swipeThinking[swipeIdx] = thinkingText;
      }
      if (toolBlocks.length > 0) {
        assistantMsg.swipeToolUse = assistantMsg.swipeToolUse || [];
        assistantMsg.swipeToolUse[swipeIdx] = toolBlocks;
      }
      bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
      postRenderProcessing(bubbleEl);
    } else {
      // SSE streaming
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const streamImages = [];

      const renderStreamProgress = () => {
        assistantMsg.swipes[swipeIdx] = fullText;
        assistantMsg.content = fullText;
        const now = Date.now();
        if (now - lastRender > 80) {
          const msgsArea = document.getElementById('messagesArea');
          const savedScrollTop = userScrolledAway ? msgsArea.scrollTop : null;
          _suppressScrollFlag = true;
          const stripped = stripThinkTags(fullText);
          const displayThinking = stripped.thinking ? thinkingText + stripped.thinking : thinkingText;
          bubbleEl.innerHTML = renderThinkingHTML(displayThinking) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(stripped.content) + renderGenImages(streamImages);
          if (savedScrollTop !== null) msgsArea.scrollTop = savedScrollTop;
          else msgsArea.scrollTop = msgsArea.scrollHeight;
          _suppressScrollFlag = false;
          lastRender = now;
        }
      };

      const readOpenAiTextStream = async (streamResp) => {
        const ct = streamResp.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const data = await streamResp.json();
          if (data.error) console.warn('Recovery API error:', data.error?.message || JSON.stringify(data.error));
          const extracted = extractImages(data.choices?.[0]?.message || data);
          if (extracted.text) fullText += extracted.text;
          if (extracted.images.length) streamImages.push(...extracted.images);
          const reasoning = data.choices?.[0]?.message?.reasoning_content
            || data.choices?.[0]?.message?.reasoning || '';
          if (reasoning) thinkingText += reasoning;
          renderStreamProgress();
          return;
        }

        const reader = streamResp.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let streamBuffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          streamBuffer += decoder.decode(value, { stream: true });
          const lines = streamBuffer.split('\n');
          streamBuffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const json = JSON.parse(payload);
              if (json.error) console.warn('Recovery stream error:', json.error?.message || JSON.stringify(json.error));
              const delta = json.choices?.[0]?.delta?.content;
              if (typeof delta === 'string') {
                fullText += delta;
              } else if (Array.isArray(delta)) {
                for (const part of delta) {
                  if (part.type === 'text') fullText += part.text;
                  else {
                    const extracted = extractImages({ content: [part] });
                    if (extracted.images.length) streamImages.push(...extracted.images);
                  }
                }
              }
              const finishMsg = json.choices?.[0]?.message;
              if (finishMsg) {
                const extracted = extractImages(finishMsg);
                if (extracted.images.length) streamImages.push(...extracted.images);
                if (extracted.text && !fullText) fullText = extracted.text;
              }
              const reasoning = json.choices?.[0]?.delta?.reasoning_content
                || json.choices?.[0]?.delta?.reasoning;
              if (reasoning) thinkingText += reasoning;
              const reasoningDetails = json.choices?.[0]?.delta?.reasoning_details;
              if (Array.isArray(reasoningDetails)) {
                for (const rd of reasoningDetails) {
                  if (rd.type === 'reasoning.text' && rd.text) thinkingText += rd.text;
                }
              }
            } catch(e) {}
          }
          renderStreamProgress();
        }
      };

      const readAnthropicTextStream = async (streamResp) => {
        const ct = streamResp.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const data = await streamResp.json();
          if (data.type === 'error' || data.error) console.warn('Recovery API error:', data.error?.message || JSON.stringify(data.error));
          fullText += (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('') || '';
          const thinking = (data.content || []).filter(c => c.type === 'thinking').map(c => c.thinking).join('');
          if (thinking) thinkingText += thinking;
          renderStreamProgress();
          return;
        }

        const reader = streamResp.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let streamBuffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          streamBuffer += decoder.decode(value, { stream: true });
          const lines = streamBuffer.split('\n');
          streamBuffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            try {
              const json = JSON.parse(payload);
              if (json.type === 'error') {
                console.warn('Recovery stream error:', json.error?.message || JSON.stringify(json.error));
              } else if (json.type === 'content_block_delta') {
                if (json.delta?.type === 'text_delta' && json.delta?.text) fullText += json.delta.text;
                else if (json.delta?.type === 'thinking_delta' && json.delta?.thinking) thinkingText += json.delta.thinking;
              }
            } catch(e) {}
          }
          renderStreamProgress();
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (format === 'anthropic') {
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            try {
              const json = JSON.parse(payload);
              if (json.type === 'content_block_start') {
                const cb = json.content_block;
                if (cb && cb.type === 'server_tool_use') {
                  currentBlockType = 'server_tool_use';
                  inputJsonBuf = '';
                  toolBlocks.push({ query: '', results: [], searching: true });
                } else if (cb && cb.type === 'tool_use' && HANDLED_TOOLS.has(cb.name)) {
                  currentBlockType = 'tool_use';
                  currentToolUseId = cb.id || '';
                  currentToolUseName = cb.name;
                  inputJsonBuf = '';
                  if (cb.name === 'url_fetch') {
                    toolBlocks.push({ type: 'url_fetch', url: '', content: '', searching: true });
                  } else {
                    toolBlocks.push({ query: '', results: [], searching: true });
                  }
                } else if (cb && cb.type === 'web_search_tool_result') {
                  currentBlockType = 'web_search_tool_result';
                  const tb = toolBlocks[toolBlocks.length - 1];
                  if (tb) {
                    tb.results = (cb.content || []).filter(r => r.type === 'web_search_result').map(r => ({
                      title: r.title,
                      url: r.url,
                      snippet: r.snippet || r.content || r.description || r.summary || ''
                    }));
                    tb.searching = false;
                  }
                } else if (cb && cb.type === 'text') {
                  currentBlockType = 'text';
                } else if (cb && cb.type === 'thinking') {
                  currentBlockType = 'thinking';
                }
              } else if (json.type === 'content_block_delta') {
                if (json.delta?.type === 'text_delta' && json.delta?.text) {
                  fullText += json.delta.text;
                } else if (json.delta?.type === 'thinking_delta' && json.delta?.thinking) {
                  thinkingText += json.delta.thinking;
                } else if (json.delta?.type === 'input_json_delta' && json.delta?.partial_json) {
                  inputJsonBuf += json.delta.partial_json;
                }
              } else if (json.type === 'content_block_stop') {
                if (currentBlockType === 'server_tool_use' && inputJsonBuf) {
                  try {
                    const parsed = JSON.parse(inputJsonBuf);
                    const tb = toolBlocks[toolBlocks.length - 1];
                    if (tb && parsed.query) tb.query = parsed.query;
                  } catch(e) {}
                  inputJsonBuf = '';
                } else if (currentBlockType === 'tool_use' && currentToolUseName && inputJsonBuf) {
                  try {
                    const parsed = JSON.parse(inputJsonBuf);
                    const tb = toolBlocks[toolBlocks.length - 1];
                    if (currentToolUseName === 'url_fetch') {
                      if (tb) tb.url = parsed.url || '';
                    } else if (tb && parsed.query) {
                      tb.query = parsed.query;
                    }
                    pendingAnthropicToolCalls.push({ id: currentToolUseId, name: currentToolUseName, input: parsed, toolBlockIndex: toolBlocks.length - 1 });
                  } catch(e) {}
                  inputJsonBuf = '';
                  currentToolUseId = null;
                  currentToolUseName = null;
                }
                currentBlockType = null;
              } else if (json.type === 'message_stop') {
                // done
              } else if (json.type === 'error') {
                throw new Error(json.error?.message || 'Anthropic API error');
              }
            } catch(e) { if (e.message && !e.message.startsWith('Unexpected')) throw e; }
          } else {
            // OpenAI format
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const json = JSON.parse(payload);
              const delta = json.choices?.[0]?.delta?.content;
              if (typeof delta === 'string') {
                fullText += delta;
              } else if (Array.isArray(delta)) {
                for (const part of delta) {
                  if (part.type === 'text') fullText += part.text;
                  else {
                    const ex = extractImages({ content: [part] });
                    if (ex.images.length) streamImages.push(...ex.images);
                  }
                }
              }
              // Some proxies deliver images in the final chunk's message field
              const finishMsg = json.choices?.[0]?.message;
              if (finishMsg) {
                const ex = extractImages(finishMsg);
                if (ex.images.length) streamImages.push(...ex.images);
                if (ex.text && !fullText) fullText = ex.text;
              }
              const reasoning = json.choices?.[0]?.delta?.reasoning_content
                || json.choices?.[0]?.delta?.reasoning;
              if (reasoning) thinkingText += reasoning;
              const reasoningDetails = json.choices?.[0]?.delta?.reasoning_details;
              if (Array.isArray(reasoningDetails)) {
                for (const rd of reasoningDetails) {
                  if (rd.type === 'reasoning.text' && rd.text) thinkingText += rd.text;
                }
              }
              // Accumulate tool call fragments
              const deltaToolCalls = json.choices?.[0]?.delta?.tool_calls;
              if (deltaToolCalls) {
                for (const tc of deltaToolCalls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallBuffers[idx]) toolCallBuffers[idx] = { id: '', name: '', arguments: '' };
                  if (tc.id) toolCallBuffers[idx].id = tc.id;
                  if (tc.function?.name) toolCallBuffers[idx].name = tc.function.name;
                  if (tc.function?.arguments) toolCallBuffers[idx].arguments += tc.function.arguments;
                }
              }
            } catch(e) {}
          }
        }

        assistantMsg.swipes[swipeIdx] = fullText;
        assistantMsg.content = fullText;
        const now = Date.now();
        if (now - lastRender > 80) {
          // Preserve scroll position when user has scrolled away
          const msgsArea = document.getElementById('messagesArea');
          const savedScrollTop = userScrolledAway ? msgsArea.scrollTop : null;
          // Preserve open/closed state of thinking & tool blocks
          const thinkingOpen = bubbleEl.querySelector('.thinking-content.open') !== null;
          const toolOpen = Array.from(bubbleEl.querySelectorAll('details.tool-use-block')).map(el => el.open);
          _suppressScrollFlag = true;
          const _st = stripThinkTags(fullText);
          const _displayText = _st.content;
          const _displayThinking = _st.thinking ? thinkingText + _st.thinking : thinkingText;
          bubbleEl.innerHTML = renderThinkingHTML(_displayThinking) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(_displayText) + renderGenImages(streamImages);
          if (thinkingOpen) {
            const tc = bubbleEl.querySelector('.thinking-content');
            const ta = bubbleEl.querySelector('.thinking-arrow');
            if (tc) tc.classList.add('open');
            if (ta) ta.textContent = '\u25BE';
          }
          toolOpen.forEach((open, i) => {
            if (open) {
              const details = bubbleEl.querySelectorAll('details.tool-use-block')[i];
              if (details) details.open = true;
            }
          });
          if (savedScrollTop !== null) {
            msgsArea.scrollTop = savedScrollTop;
          } else {
            msgsArea.scrollTop = msgsArea.scrollHeight;
          }
          _suppressScrollFlag = false;
          lastRender = now;
        }
      }
      // === Anthropic custom tool call execution (url_fetch etc.) ===
      let anthropicToolRound = 0;
      while (pendingAnthropicToolCalls.length > 0 && format === 'anthropic' && anthropicToolRound < 20) {
        anthropicToolRound++;
        const toolUseContentBlocks = [];
        const toolResultBlocks = [];
        for (const call of pendingAnthropicToolCalls) {
          toolUseContentBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
          if (call.name === 'url_fetch') {
            const tb = toolBlocks[call.toolBlockIndex];
            const fetchUrl = call.input?.url || '';
            if (tb) tb.url = fetchUrl;
            bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
            const msgsAreaTmp = document.getElementById('messagesArea');
            if (!userScrolledAway) msgsAreaTmp.scrollTop = msgsAreaTmp.scrollHeight;
            const { content, error } = await executeAuthorizedTool('url_fetch', { url: fetchUrl }, requestConv, abortController.signal, authorization);
            if (tb) {
              tb.content = content;
              tb.searching = false;
              if (error) tb.error = error;
            }
            bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
            if (!userScrolledAway) msgsAreaTmp.scrollTop = msgsAreaTmp.scrollHeight;
            toolResultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: formatUrlFetchResultForModel(content, error, fetchUrl) });
          } else if (call.name === 'web_search') {
            const tb = toolBlocks[call.toolBlockIndex];
            const query = extractWebSearchQueryFromArgs(call.input);
            if (tb) tb.query = query;
            bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
            const msgsAreaTmp = document.getElementById('messagesArea');
            if (!userScrolledAway) msgsAreaTmp.scrollTop = msgsAreaTmp.scrollHeight;
            const { results, error } = await executeAuthorizedTool('web_search', { query }, requestConv, abortController.signal, authorization);
            if (tb) {
              tb.results = results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
              tb.searching = false;
              if (error) tb.error = error;
            }
            bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
            if (!userScrolledAway) msgsAreaTmp.scrollTop = msgsAreaTmp.scrollHeight;
            toolResultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: formatSearchResultsForModel(results, error) });
          }
        }
        // Build follow-up request
        const prepared = prepareAnthropicMessages(apiMessages);
        const followUpMessages = [
          ...prepared.messages,
          { role: 'assistant', content: [
            ...(fullText ? [{ type: 'text', text: fullText }] : []),
            ...toolUseContentBlocks
          ]},
          { role: 'user', content: toolResultBlocks }
        ];
        const followUpBody = { ...body, messages: followUpMessages, stream: true };
        delete followUpBody.tool_choice;
        if (anthropicToolRound >= 20) delete followUpBody.tools;
        exclude.forEach(k => delete followUpBody[k]);
        debugLogPayload('API follow-up request', followUpBody, { url, format, model, stage: 'anthropic-stream-tools' });
        const followUpResp = await fetchApiWithHttpSupport(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(followUpBody),
          signal: abortController.signal
        }, baseUrl);
        if (!followUpResp.ok) {
          let errText = '';
          try { errText = await followUpResp.text(); } catch(e) {}
          throw new Error('Follow-up API returned ' + followUpResp.status + (errText ? ': ' + errText.slice(0, 200) : ''));
        }
        const preToolText = fullText;
        fullText = '';
        pendingAnthropicToolCalls = [];
        let followInputJsonBuf = '';
        let followBlockType = null;
        let followToolUseId = null;
        let followToolUseName = null;
        const followCt = followUpResp.headers.get('content-type') || '';
        if (followCt.includes('application/json')) {
          const followData = await followUpResp.json();
          if (followData.type === 'error' || followData.error) {
            console.warn('Follow-up API error:', followData.error?.message || JSON.stringify(followData.error));
          }
          fullText = (followData.content || []).filter(c => c.type === 'text').map(c => c.text).join('') || '';
          const followThink = (followData.content || []).filter(c => c.type === 'thinking').map(c => c.thinking).join('');
          if (followThink) thinkingText += followThink;
          for (const block of (followData.content || [])) {
            if (block.type === 'tool_use' && HANDLED_TOOLS.has(block.name)) {
              if (block.name === 'url_fetch') {
                toolBlocks.push({ type: 'url_fetch', url: block.input?.url || '', content: '', searching: true });
              } else {
                toolBlocks.push({ query: extractWebSearchQueryFromArgs(block.input), results: [], searching: true });
              }
              pendingAnthropicToolCalls.push({ id: block.id, name: block.name, input: block.input || {}, toolBlockIndex: toolBlocks.length - 1 });
            }
          }
        } else {
          const followReader = followUpResp.body.getReader();
          const followDecoder = new TextDecoder();
          let followBuffer = '';
          while (true) {
            const { done, value } = await followReader.read();
            if (done) break;
            followBuffer += followDecoder.decode(value, { stream: true });
            const fLines = followBuffer.split('\n');
            followBuffer = fLines.pop() || '';
            for (const fLine of fLines) {
              const ft = fLine.trim();
              if (!ft.startsWith('data:')) continue;
              const fp = ft.slice(5).trim();
              if (!fp) continue;
              try {
                const fj = JSON.parse(fp);
                if (fj.type === 'error') {
                  console.warn('Follow-up stream error:', fj.error?.message || JSON.stringify(fj.error));
                } else if (fj.type === 'content_block_start') {
                  const cb = fj.content_block;
                  if (cb && cb.type === 'tool_use' && HANDLED_TOOLS.has(cb.name)) {
                    followBlockType = 'tool_use';
                    followToolUseId = cb.id || '';
                    followToolUseName = cb.name;
                    followInputJsonBuf = '';
                    if (cb.name === 'url_fetch') {
                      toolBlocks.push({ type: 'url_fetch', url: '', content: '', searching: true });
                    } else {
                      toolBlocks.push({ query: '', results: [], searching: true });
                    }
                  } else if (cb && cb.type === 'server_tool_use') {
                    followBlockType = 'server_tool_use';
                    followInputJsonBuf = '';
                    toolBlocks.push({ query: '', results: [], searching: true });
                  } else if (cb && cb.type === 'web_search_tool_result') {
                    followBlockType = 'web_search_tool_result';
                    const tb = toolBlocks[toolBlocks.length - 1];
                    if (tb) {
                      tb.results = (cb.content || []).filter(r => r.type === 'web_search_result').map(r => ({
                        title: r.title, url: r.url, snippet: r.snippet || r.content || r.description || r.summary || ''
                      }));
                      tb.searching = false;
                    }
                  } else if (cb && (cb.type === 'text' || cb.type === 'thinking')) {
                    followBlockType = cb.type;
                  }
                } else if (fj.type === 'content_block_delta') {
                  if (fj.delta?.type === 'text_delta' && fj.delta?.text) fullText += fj.delta.text;
                  else if (fj.delta?.type === 'thinking_delta' && fj.delta?.thinking) thinkingText += fj.delta.thinking;
                  else if (fj.delta?.type === 'input_json_delta' && fj.delta?.partial_json) followInputJsonBuf += fj.delta.partial_json;
                } else if (fj.type === 'content_block_stop') {
                  if (followBlockType === 'server_tool_use' && followInputJsonBuf) {
                    try {
                      const parsed = JSON.parse(followInputJsonBuf);
                      const tb = toolBlocks[toolBlocks.length - 1];
                      if (tb && parsed.query) tb.query = parsed.query;
                    } catch(e) {}
                    followInputJsonBuf = '';
                  } else if (followBlockType === 'tool_use' && followToolUseName && followInputJsonBuf) {
                    try {
                      const parsed = JSON.parse(followInputJsonBuf);
                      const tb = toolBlocks[toolBlocks.length - 1];
                      if (followToolUseName === 'url_fetch') {
                        if (tb) tb.url = parsed.url || '';
                      } else if (tb && parsed.query) {
                        tb.query = parsed.query;
                      }
                      pendingAnthropicToolCalls.push({ id: followToolUseId, name: followToolUseName, input: parsed, toolBlockIndex: toolBlocks.length - 1 });
                    } catch(e) {}
                    followInputJsonBuf = '';
                    followToolUseId = null;
                    followToolUseName = null;
                  }
                  followBlockType = null;
                }
              } catch(e) {}
            }
            assistantMsg.swipes[swipeIdx] = fullText;
            assistantMsg.content = fullText;
            const now2 = Date.now();
            if (now2 - lastRender > 80) {
              const msgsArea2 = document.getElementById('messagesArea');
              const savedST = userScrolledAway ? msgsArea2.scrollTop : null;
              _suppressScrollFlag = true;
              const _st2 = stripThinkTags(fullText);
              bubbleEl.innerHTML = renderThinkingHTML(_st2.thinking ? thinkingText + _st2.thinking : thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(_st2.content) + renderGenImages(streamImages);
              if (savedST !== null) msgsArea2.scrollTop = savedST;
              else msgsArea2.scrollTop = msgsArea2.scrollHeight;
              _suppressScrollFlag = false;
              lastRender = now2;
            }
          }
        }
        if (!fullText && pendingAnthropicToolCalls.length === 0) {
          try {
            const recoveryBody = { ...body, messages: followUpMessages, stream: true };
            // body.system may be a cache_control block array — append a second block
            // rather than string-joining it, which would stringify to "[object Object]".
            recoveryBody.system = Array.isArray(body.system)
              ? body.system.concat([{ type: 'text', text: TOOL_FINAL_ANSWER_NUDGE }])
              : [body.system, TOOL_FINAL_ANSWER_NUDGE].filter(Boolean).join('\n\n');
            delete recoveryBody.tools;
            delete recoveryBody.tool_choice;
            exclude.forEach(k => delete recoveryBody[k]);
            debugLogPayload('API recovery request', recoveryBody, { url, format, model, stage: 'anthropic-stream-tools-recovery' });
            const recoveryResp = await fetchApiWithHttpSupport(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(recoveryBody),
              signal: abortController.signal
            }, baseUrl);
            if (recoveryResp.ok) {
              await readAnthropicTextStream(recoveryResp);
            } else {
              let errText = '';
              try { errText = await recoveryResp.text(); } catch(e) {}
              console.warn('Recovery API returned ' + recoveryResp.status + (errText ? ': ' + errText.slice(0, 200) : ''));
            }
          } catch(e) {
            if (e.name === 'AbortError') throw e;
            console.warn('Anthropic tool recovery failed:', e);
          }
        }
        if (!fullText && preToolText) fullText = preToolText;
      }
      // === Parse text-based tool calls (models like Gemini output tool calls as text) ===
      // These can't use the standard OpenAI tool loop because the API never produced real
      // tool_calls — fake IDs get rejected. Instead, execute directly and follow up as a user message.
      if (format !== 'anthropic' && Object.keys(toolCallBuffers).length === 0) {
        const textToolCalls = parseTextToolCalls(fullText);
        if (textToolCalls.length > 0) {
          const savedText = fullText;
          fullText = stripTextToolCalls(fullText);
          const textToolResults = [];
          for (const tc of textToolCalls) {
            let args = {};
            try { args = JSON.parse(tc.arguments); } catch(e) {}
            if (tc.name === 'url_fetch') {
              const fetchUrl = args.url || '';
              toolBlocks.push({ type: 'url_fetch', url: fetchUrl, content: '', searching: true });
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
            const { content, error } = await executeAuthorizedTool('url_fetch', { url: fetchUrl }, requestConv, abortController.signal, authorization);
              const tb = toolBlocks[toolBlocks.length - 1];
              tb.content = content; tb.searching = false;
              if (error) tb.error = error;
              textToolResults.push('URL Fetch (' + fetchUrl + '):\n' + formatUrlFetchResultForModel(content, error, fetchUrl));
            } else {
              const query = extractWebSearchQueryFromArgs(args);
              toolBlocks.push({ query, results: [], searching: true });
              bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
            const { results, error } = await executeAuthorizedTool('web_search', { query }, requestConv, abortController.signal, authorization);
              const tb = toolBlocks[toolBlocks.length - 1];
              tb.results = results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
              tb.searching = false;
              if (error) tb.error = error;
              textToolResults.push('Web Search (' + query + '):\n' + formatSearchResultsForModel(results, error));
            }
            bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
          }
          // Follow up with results as a user message (compatible with all APIs)
          const followUpMessages = [...(body.messages || []),
            { role: 'assistant', content: savedText },
            { role: 'user', content: 'Here are the tool results:\n\n' + textToolResults.join('\n\n') + '\n\nPlease synthesize a response using these results.' }
          ];
          const followUpBody = { ...body, messages: followUpMessages, stream: true };
          delete followUpBody.tools;
          delete followUpBody.tool_choice;
          exclude.forEach(k => delete followUpBody[k]);
          debugLogPayload('API follow-up request', followUpBody, { url, format, model, stage: 'stream-text-tools' });
          try {
            const followUpResp = await fetchApiWithHttpSupport(url, { method: 'POST', headers, body: JSON.stringify(followUpBody), signal: abortController.signal }, baseUrl);
            if (followUpResp.ok && followUpResp.body) {
              fullText = '';
              const fReader = followUpResp.body.getReader();
              const fDecoder = new TextDecoder();
              let fBuf = '';
              while (true) {
                const { done, value } = await fReader.read();
                if (done) break;
                fBuf += fDecoder.decode(value, { stream: true });
                const fLines = fBuf.split('\n');
                fBuf = fLines.pop() || '';
                for (const fl of fLines) {
                  const ft = fl.trim();
                  if (!ft.startsWith('data:')) continue;
                  const fp = ft.slice(5).trim();
                  if (fp === '[DONE]') continue;
                  try {
                    const fj = JSON.parse(fp);
                    const fd = fj.choices?.[0]?.delta?.content;
                    if (typeof fd === 'string') fullText += fd;
                  } catch(e) {}
                }
                assistantMsg.swipes[swipeIdx] = fullText;
                assistantMsg.content = fullText;
                const now = Date.now();
                if (now - lastRender > 80) {
                  bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
                  lastRender = now;
                }
              }
            }
          } catch(e) {
            console.warn('Text tool call follow-up failed:', e);
          }
          if (!fullText) fullText = savedText;
        }
      }
      // === OpenAI tool call execution loop ===
      let openaiToolRound = 0;
      let openaiPendingToolCalls = Object.values(toolCallBuffers).filter(tc => HANDLED_TOOLS.has(tc.name));
      let openaiRunningMessages = body.messages ? [...body.messages] : [];
      while (openaiPendingToolCalls.length > 0 && format !== 'anthropic' && openaiToolRound < 20) {
        openaiToolRound++;
        // Build the assistant message with tool_calls
        const assistantToolMsg = {
          role: 'assistant',
          content: fullText || null,
          tool_calls: openaiPendingToolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments }
          }))
        };
        const toolResultMsgs = [];
        for (const tc of openaiPendingToolCalls) {
          const toolName = tc.name;
          let args = {};
          try { args = JSON.parse(tc.arguments); } catch(e) {}
          const msgsAreaTmp = document.getElementById('messagesArea');
          if (toolName === 'url_fetch') {
            const fetchUrl = args.url || '';
            toolBlocks.push({ type: 'url_fetch', url: fetchUrl, content: '', searching: true });
            bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
            if (!userScrolledAway) msgsAreaTmp.scrollTop = msgsAreaTmp.scrollHeight;
            const { content, error } = await executeAuthorizedTool('url_fetch', { url: fetchUrl }, requestConv, abortController.signal, authorization);
            const tb = toolBlocks[toolBlocks.length - 1];
            tb.content = content;
            tb.searching = false;
            if (error) tb.error = error;
            bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
            if (!userScrolledAway) msgsAreaTmp.scrollTop = msgsAreaTmp.scrollHeight;
            toolResultMsgs.push({ role: 'tool', tool_call_id: tc.id, content: formatUrlFetchResultForModel(content, error, fetchUrl) });
          } else {
            const query = extractWebSearchQueryFromArgs(args);
            // Show searching state
            toolBlocks.push({ query, results: [], searching: true });
            bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
            if (!userScrolledAway) msgsAreaTmp.scrollTop = msgsAreaTmp.scrollHeight;
            // Execute search
            const { results, error } = await executeAuthorizedTool('web_search', { query }, requestConv, abortController.signal, authorization);
            const tb = toolBlocks[toolBlocks.length - 1];
            tb.results = results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet }));
            tb.searching = false;
            if (error) tb.error = error;
            bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
            if (!userScrolledAway) msgsAreaTmp.scrollTop = msgsAreaTmp.scrollHeight;
            toolResultMsgs.push({ role: 'tool', tool_call_id: tc.id, content: formatSearchResultsForModel(results, error) });
          }
        }
        // Follow-up streaming request with tool results
        openaiRunningMessages = [...openaiRunningMessages, assistantToolMsg, ...toolResultMsgs];
        const followUpBody = { ...body, messages: openaiRunningMessages, stream: true };
        delete followUpBody.tool_choice;
        if (openaiToolRound >= 20) delete followUpBody.tools;
        exclude.forEach(k => delete followUpBody[k]);
        debugLogPayload('API follow-up request', followUpBody, { url, format, model, stage: 'openai-stream-tools' });
        const followUpResp = await fetchApiWithHttpSupport(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(followUpBody),
          signal: abortController.signal
        }, baseUrl);
        if (!followUpResp.ok) {
          let errText = '';
          try { errText = await followUpResp.text(); } catch(e) {}
          throw new Error('Follow-up API returned ' + followUpResp.status + (errText ? ': ' + errText.slice(0, 200) : ''));
        }
        const preToolText = fullText;
        fullText = '';
        toolCallBuffers = {};
        const followReader = followUpResp.body.getReader();
        const followDecoder = new TextDecoder();
        let followBuffer = '';
        while (true) {
          const { done, value } = await followReader.read();
          if (done) break;
          followBuffer += followDecoder.decode(value, { stream: true });
          const fLines = followBuffer.split('\n');
          followBuffer = fLines.pop() || '';
          for (const fLine of fLines) {
            const ft = fLine.trim();
            if (!ft.startsWith('data:')) continue;
            const fp = ft.slice(5).trim();
            if (fp === '[DONE]') continue;
            try {
              const fj = JSON.parse(fp);
              if (fj.error) {
                console.warn('Follow-up stream error:', fj.error?.message || JSON.stringify(fj.error));
              }
              const fd = fj.choices?.[0]?.delta?.content;
              if (typeof fd === 'string') fullText += fd;
              const fr = fj.choices?.[0]?.delta?.reasoning_content
                || fj.choices?.[0]?.delta?.reasoning;
              if (fr) thinkingText += fr;
              const frd = fj.choices?.[0]?.delta?.reasoning_details;
              if (Array.isArray(frd)) {
                for (const rd of frd) {
                  if (rd.type === 'reasoning.text' && rd.text) thinkingText += rd.text;
                }
              }
              const deltaToolCalls = fj.choices?.[0]?.delta?.tool_calls;
              if (deltaToolCalls) {
                for (const tc of deltaToolCalls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallBuffers[idx]) toolCallBuffers[idx] = { id: '', name: '', arguments: '' };
                  if (tc.id) toolCallBuffers[idx].id = tc.id;
                  if (tc.function?.name) toolCallBuffers[idx].name = tc.function.name;
                  if (tc.function?.arguments) toolCallBuffers[idx].arguments += tc.function.arguments;
                }
              }
            } catch(e) {}
          }
          assistantMsg.swipes[swipeIdx] = fullText;
          assistantMsg.content = fullText;
          const now2 = Date.now();
          if (now2 - lastRender > 80) {
            const msgsArea2 = document.getElementById('messagesArea');
            const savedST = userScrolledAway ? msgsArea2.scrollTop : null;
            _suppressScrollFlag = true;
            const _st2 = stripThinkTags(fullText);
            const _displayText2 = _st2.content;
            const _displayThinking2 = _st2.thinking ? thinkingText + _st2.thinking : thinkingText;
            bubbleEl.innerHTML = renderThinkingHTML(_displayThinking2) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(_displayText2) + renderGenImages(streamImages);
            if (savedST !== null) msgsArea2.scrollTop = savedST;
            else msgsArea2.scrollTop = msgsArea2.scrollHeight;
            _suppressScrollFlag = false;
            lastRender = now2;
          }
        }
        openaiPendingToolCalls = Object.values(toolCallBuffers).filter(tc => HANDLED_TOOLS.has(tc.name));
        if (!fullText && openaiPendingToolCalls.length === 0) {
          try {
            const recoveryMessages = [...openaiRunningMessages, { role: 'system', content: TOOL_FINAL_ANSWER_NUDGE }];
            const recoveryBody = { ...body, messages: recoveryMessages, stream: true };
            delete recoveryBody.tools;
            delete recoveryBody.tool_choice;
            exclude.forEach(k => delete recoveryBody[k]);
            debugLogPayload('API recovery request', recoveryBody, { url, format, model, stage: 'openai-stream-tools-recovery' });
            const recoveryResp = await fetchApiWithHttpSupport(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(recoveryBody),
              signal: abortController.signal
            }, baseUrl);
            if (recoveryResp.ok) {
              await readOpenAiTextStream(recoveryResp);
            } else {
              let errText = '';
              try { errText = await recoveryResp.text(); } catch(e) {}
              console.warn('Recovery API returned ' + recoveryResp.status + (errText ? ': ' + errText.slice(0, 200) : ''));
            }
          } catch(e) {
            if (e.name === 'AbortError') throw e;
            console.warn('OpenAI tool recovery failed:', e);
          }
        }
        if (!fullText && preToolText) fullText = preToolText;
      }
      const emptyResponse = !String(fullText || '').trim() && !streamImages.length && !toolBlocks.some(block => block.content || (block.results || []).length);
      if (emptyResponse) {
        fullText = 'No response received. Retry to try again.';
        finishRequestMetadata(request, 'failed', 'Provider returned an empty response.', responseStatus);
      }
      const stripped = stripThinkTags(fullText);
      if (stripped.thinking) thinkingText += stripped.thinking;
      fullText = stripped.content;
      assistantMsg.swipes[swipeIdx] = fullText;
      assistantMsg.content = fullText;
      if (streamImages.length) {
        assistantMsg.swipeImages = assistantMsg.swipeImages || [];
        assistantMsg.swipeImages[swipeIdx] = streamImages;
        assistantMsg.images = streamImages;
      }
      if (thinkingText) {
        assistantMsg.swipeThinking = assistantMsg.swipeThinking || [];
        assistantMsg.swipeThinking[swipeIdx] = thinkingText;
      }
      if (toolBlocks.length > 0) {
        assistantMsg.swipeToolUse = assistantMsg.swipeToolUse || [];
        assistantMsg.swipeToolUse[swipeIdx] = toolBlocks;
      }
      const msgsArea = document.getElementById('messagesArea');
      const savedScrollTop = userScrolledAway ? msgsArea.scrollTop : null;
      _suppressScrollFlag = true;
      bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(streamImages);
      postRenderProcessing(bubbleEl);
      if (savedScrollTop !== null) {
        msgsArea.scrollTop = savedScrollTop;
      } else {
        msgsArea.scrollTop = msgsArea.scrollHeight;
      }
      _suppressScrollFlag = false;
    }
    if (responseCacheKey && fullText && !abortController?.signal?.aborted) {
      try {
        await cacheStore(buildResponseCacheEntry(
          responseCacheKey,
          responseCacheUserMessage,
          responseCacheSystemMessages,
          model,
          format,
          fullText,
          thinkingText,
          toolBlocks,
          assistantMsg,
          swipeIdx
        ));
        debugLog('Response cached', { model, format, cacheKey: responseCacheKey });
      } catch (cacheErr) {
        console.warn('Response cache storage failed:', cacheErr);
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!fullText) fullText = '(stopped)';
      finishRequestMetadata(request, 'stopped', 'Generation stopped by the user.', responseStatus);
      announce('Generation stopped.');
    } else {
      const detail = sanitizeErrorDetail(e);
      fullText = 'Request failed: ' + detail;
      finishRequestMetadata(request, 'failed', detail, responseStatus);
      announce('Request failed. Retry is available.');
    }
    const strippedErr = stripThinkTags(fullText);
    if (strippedErr.thinking) thinkingText += strippedErr.thinking;
    fullText = strippedErr.content;
    assistantMsg.swipes[swipeIdx] = fullText;
    assistantMsg.content = fullText;
    if (thinkingText) {
      assistantMsg.swipeThinking = assistantMsg.swipeThinking || [];
      assistantMsg.swipeThinking[swipeIdx] = thinkingText;
    }
    if (toolBlocks.length > 0) {
      assistantMsg.swipeToolUse = assistantMsg.swipeToolUse || [];
      assistantMsg.swipeToolUse[swipeIdx] = toolBlocks;
    }
    const msgsArea = document.getElementById('messagesArea');
    const savedScrollTop = userScrolledAway ? msgsArea.scrollTop : null;
    _suppressScrollFlag = true;
    bubbleEl.innerHTML = renderThinkingHTML(thinkingText) + renderToolBlocksHTML(toolBlocks) + renderMarkdown(fullText) + renderGenImages(assistantMsg.images);
    if (savedScrollTop !== null) {
      msgsArea.scrollTop = savedScrollTop;
    } else {
      msgsArea.scrollTop = msgsArea.scrollHeight;
    }
    _suppressScrollFlag = false;
  } finally {
    persistSwipeSources(assistantMsg, swipeIdx, sourceRegistry);
    if (request.status === 'pending' || request.status === 'streaming') finishRequestMetadata(request, abortController?.signal?.aborted ? 'stopped' : 'complete', '', responseStatus);
    if (request.status === 'complete') announce('Response complete.');
    updateMessageTokenMetadata(assistantMsg, swipeIdx);
    debugLog('API response', {
      model,
      format,
      outputTokens: getMessageTokenCount(assistantMsg),
      toolBlocks: toolBlocks.length,
      hasThinking: Boolean(thinkingText)
    });
    streaming = false;
    abortController = null;
    btn.classList.remove('streaming');
    btn.disabled = false;
    updateSendBtnState();
    activeSourceRegistry = null;
  }
}

// ============================================
// Send Button State
// ============================================
function updateSendBtnState() {
  const btn = document.getElementById('sendBtn');
  if (streaming) return;
  const input = document.getElementById('chatInput');
  const hasInput = input.value.trim() || pendingAttachments.length > 0;
  const lastMsg = messages[messages.length - 1];
  if (!hasInput && lastMsg && lastMsg.role === 'user') {
    btn.textContent = 'Regenerate';
  } else {
    btn.textContent = 'Send';
  }
}

function resolveWebSearchEnabled(conv = getActiveConv()) {
  return canUseTool('web_search', conv);
}

function closeComposerTools() {
  const popover = document.getElementById('composerToolsPopover');
  if (popover) popover.remove();
  const button = document.getElementById('toolsBtn');
  if (button) button.setAttribute('aria-expanded', 'false');
  if (composerToolsFocusReturn && document.contains(composerToolsFocusReturn)) composerToolsFocusReturn.focus();
  composerToolsFocusReturn = null;
}

function toggleComposerTools(event) {
  event?.stopPropagation();
  const existing = document.getElementById('composerToolsPopover');
  if (existing) { closeComposerTools(); return; }
  const conv = getActiveConv();
  if (!conv) return;
  const policy = getToolPolicy(conv);
  const popover = document.createElement('div');
  popover.id = 'composerToolsPopover';
  composerToolsFocusReturn = document.activeElement;
  popover.className = 'composer-tools-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Conversation tool policy');
  popover.innerHTML =
    '<strong>Tools for this chat</strong>' +
    '<label><input type="checkbox" data-tool="webSearch" ' + (policy.webSearch ? 'checked' : '') + '> Web search</label>' +
    '<label><input type="checkbox" data-tool="urlFetch" ' + (policy.urlFetch ? 'checked' : '') + '> URL fetching</label>' +
    '<label><input type="checkbox" data-tool="confirm" ' + (policy.confirm ? 'checked' : '') + '> Ask before external tools</label>' +
    '<small>Global Tools settings are defaults. This choice applies only to this conversation.</small>' +
    '<div class="composer-tools-actions"><button type="button" class="btn btn-secondary" data-tool-cancel>Cancel</button><button type="button" class="btn btn-primary" data-tool-save>Save</button></div>';
  document.querySelector('.input-row')?.appendChild(popover);
  const button = document.getElementById('toolsBtn');
  if (button) button.setAttribute('aria-expanded', 'true');
  popover.querySelector('[data-tool-cancel]').onclick = closeComposerTools;
  popover.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeComposerTools();
      button?.focus();
    }
  });
  popover.querySelector('[data-tool-save]').onclick = async () => {
    conv.toolPolicy = {
      webSearch: popover.querySelector('[data-tool="webSearch"]').checked,
      urlFetch: popover.querySelector('[data-tool="urlFetch"]').checked,
      confirm: popover.querySelector('[data-tool="confirm"]').checked
    };
    conv.updatedAt = Date.now();
    await saveConversationImmediately();
    closeComposerTools();
    announce('Conversation tool policy saved.');
    showToast('Tools updated for this conversation.', 'success');
  };
  popover.querySelector('[data-tool-save]').focus();
}

// ============================================
// Send Message
// ============================================
async function sendMessage() {
  if (streaming && abortController) { streaming = false; abortController.abort(); return; }
  if (readOnlyShare) return;

  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  const lastMsg = messages[messages.length - 1];
  const isRegenFromFork = !text && pendingAttachments.length === 0 && lastMsg && lastMsg.role === 'user';
  if (!text && pendingAttachments.length === 0 && !isRegenFromFork) return;

  const proxyUrl = localStorage.getItem('llmProxyUrl');
  const apiKey = getApiKey();
  const conv = getActiveConv();

  if (!isRegenFromFork) {
    const cmd = parseCommand(text);
    if (cmd) {
      if (pendingAttachments.length > 0) { showToast('Commands cannot include attachments.', 'error'); return; }
      if (!cmd.query) { renderCommandMenu(input, cmd.cmd); return; }
      input.value = '';
      input.style.height = 'auto';
      closeCommandDropdown();
      persistDraftFromUI();
      await handleCommand(cmd, conv);
      return;
    }
  }

  if (!proxyUrl || (providerRequiresKey() && !apiKey)) {
    openModal('setupModal', '#setupProxy');
    return;
  }

  const queuedAttachments = cloneDraftAttachments(pendingAttachments);
  const addedDocs = [];
  const previousTitle = conv?.title;
  if (!isRegenFromFork) {
    let userContent;
    if (pendingAttachments.length > 0) {
      if (conv) {
        const docs = conv.docs || (conv.docs = []);
        pendingAttachments.forEach(att => {
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
      userContent = buildComposerMessage(text, pendingAttachments).content;
    } else {
      userContent = text;
    }

    const userMsg = { role: 'user', content: userContent, timestamp: Date.now() };
    updateMessageTokenMetadata(userMsg);
    messages.push(userMsg);
    if (conv) {
      delete conv.draft;
      conv.updatedAt = Date.now();
    }
    try {
      await saveConversationImmediately();
    } catch (err) {
      if (conv) conv.draft = { text: input.value, attachments: queuedAttachments, updatedAt: Date.now() };
      if (conv && addedDocs.length) conv.docs = (conv.docs || []).filter(doc => !addedDocs.includes(doc));
      messages.pop();
      pendingAttachments = queuedAttachments;
      renderPreviews();
      showToast('Could not save your message before sending: ' + sanitizeErrorDetail(err), 'error');
      return;
    }
    pendingAttachments = [];
    document.getElementById('imagePreview').innerHTML = '';
    input.value = '';
    input.style.height = 'auto';

    // Auto-title
    if (conv && conv.title === 'New Chat') {
      conv.title = (text || 'Attachment chat').slice(0, 40);
      conv.updatedAt = Date.now();
      renderSidebar();
    }
  }

  renderMessages();

  const assistantMsg = { role: 'assistant', content: '', swipes: [''], swipeIndex: 0, timestamp: Date.now() };
  messages.push(assistantMsg);

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

  const requestContext = await buildRequestMessages(conv, { messageList: messages });
  const apiMessages = requestContext.messages;
  if (guardContextLimit(requestContext)) {
    messages.pop();
    if (!isRegenFromFork) {
      messages.pop();
      if (conv) {
        if (addedDocs.length) conv.docs = (conv.docs || []).filter(doc => !addedDocs.includes(doc));
        conv.draft = { text, attachments: queuedAttachments, updatedAt: Date.now() };
        if (previousTitle) conv.title = previousTitle;
      }
      pendingAttachments = queuedAttachments;
      renderPreviews();
    }
    saveConversationImmediately().catch(() => {});
    renderMessages();
    return;
  }

  // Capture and clear model override
  const overrideModel = modelOverride;
  clearModelOverride();

  await streamResponse(apiMessages, assistantMsg, 0, bubble, overrideModel, null, { conv });

  if (assistantMsg._responseCacheHit || getSwipeRequest(assistantMsg)?.status !== 'complete') {
    delete assistantMsg._responseCacheHit;
  } else {
    extractMemories(apiMessages);
  }
  if (conv) conv.updatedAt = Date.now();
  debouncedSave();
  renderMessages();
  updateTokenInfo();
}

// ============================================
// Regenerate
// ============================================
async function regenerate() {
  if (readOnlyShare || streaming) return;
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastIdx = i; break; }
  }
  if (lastIdx === -1) return;

  const msg = messages[lastIdx];
  const conv = getActiveConv();
  const requestContext = await buildRequestMessages(conv, { messageList: messages, untilIndex: lastIdx });
  if (guardContextLimit(requestContext)) return;
  if (!msg.swipes) msg.swipes = [msg.content];
  msg.swipes.push('');
  msg.swipeIndex = msg.swipes.length - 1;
  msg.content = '';
  renderMessages();

  const area = document.getElementById('messagesArea');
  const wrappers = area.querySelectorAll('.msg-wrapper.assistant');
  const lastWrapper = wrappers[wrappers.length - 1];
  const bubble = lastWrapper.querySelector('.msg-bubble');
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

  const apiMessages = requestContext.messages;

  await saveConversationImmediately();
  await streamResponse(apiMessages, msg, msg.swipeIndex, bubble, null, null, { conv });
  if (msg._responseCacheHit) delete msg._responseCacheHit;

  if (conv) conv.updatedAt = Date.now();
  debouncedSave();
  renderMessages();
  updateTokenInfo();
}

// ============================================
// Continue Message
// ============================================
async function continueMessage() {
  if (readOnlyShare || streaming) return;
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastIdx = i; break; }
  }
  if (lastIdx === -1) return;

  const msg = messages[lastIdx];
  const existingText = typeof msg.content === 'string' ? msg.content : '';
  if (!existingText.trim()) return;

  const conv = getActiveConv();
  const requestContext = await buildRequestMessages(conv, {
    messageList: messages,
    untilIndex: lastIdx + 1,
    targetIndex: lastIdx,
    includeTarget: true
  });
  const apiMessages = requestContext.messages;
  if (guardContextLimit(requestContext)) return;

  const area = document.getElementById('messagesArea');
  const wrappers = area.querySelectorAll('.msg-wrapper.assistant');
  const lastWrapper = wrappers[wrappers.length - 1];
  const bubble = lastWrapper.querySelector('.msg-bubble');

  await saveConversationImmediately();
  await streamResponse(apiMessages, msg, msg.swipeIndex, bubble, null, existingText, { conv });
  if (msg._responseCacheHit) delete msg._responseCacheHit;

  if (conv) conv.updatedAt = Date.now();
  debouncedSave();
  renderMessages();
  updateTokenInfo();
}

// ============================================
// Clear Chat
// ============================================
function clearChat() {
  if (readOnlyShare) return;
  if (!confirm('Clear this conversation?')) return;
  const conv = getActiveConv();
  if (conv) {
    conv.messages = [];
    conv.title = 'New Chat';
    conv.summary = '';
    conv.summaryUpdatedAt = null;
    conv.docs = [];
    messages = conv.messages;
    saveConversations();
    renderSidebar();
  }
  renderMessages();
  updateTokenInfo();
}

// ============================================
// Export / Import
// ============================================
const EXPORT_SCHEMA = 'synapse-export';
const EXPORT_VERSION = 2;
const IMPORT_SETTING_ALLOWLIST = [
  'llmProvider', 'llmProxyUrl', 'llmModel', 'llmApiFormat', 'llmStreaming', 'llmEnterSend',
  'llmTemperature', 'llmMaxTokens', 'llmContextWindow', 'llmPromptCache', 'llmThinking',
  'llmThinkingEffort', 'llmExtraParams', 'llmExcludeParams', 'llmPrefill', 'llmPersona',
  'llmEnableStMacros', 'llmRpUserName', 'llmInputCost', 'llmOutputCost', 'llmWebSearch',
  'llmForceSearch', 'llmMemoryEnabled', 'llmHoldScreenshot', 'llmCacheEnabled', 'llmPromptEntries',
  'llmUrlFetch', 'llmToolConfirm', 'llmSearchApiUrl', 'llmCorsProxy',
  'assistantTheme', 'assistantCustomTheme', 'assistantFont', 'assistantMsgFontSize', 'assistantMsgMaxWidth'
];
const IMPORT_SETTING_URL_KEYS = new Set(['llmProxyUrl', 'llmSearchApiUrl', 'llmCorsProxy']);

function buildSafeExportSettings() {
  const settings = {};
  IMPORT_SETTING_ALLOWLIST.forEach(key => {
    const value = localStorage.getItem(key);
    if (value !== null) settings[key] = IMPORT_SETTING_URL_KEYS.has(key) ? sanitizeStoredUrl(value) : value;
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

function exportAllConversations() {
  const data = {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    conversations: conversations,
    // Advertised as a full backup, so project instructions and files ride along too.
    projects: projects,
    memories: [],
    drafts: conversations.filter(conv => conv.draft).map(conv => ({ conversationId: conv.id, ...conv.draft })),
    exportedAt: new Date().toISOString(),
    settings: buildSafeExportSettings(),
    profiles: buildSafeExportProfiles()
  };
  loadMemories().then(memories => {
    data.memories = memories;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'assistant-export-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }).catch(() => showToast('Could not prepare export.', 'error'));
}

function normalizeImportedData(data) {
  if (!data || typeof data !== 'object') throw new Error('The file is not a JSON object.');
  if (data.schema && data.schema !== EXPORT_SCHEMA) throw new Error('Unsupported export schema.');
  if (data.version != null && (!Number.isInteger(Number(data.version)) || Number(data.version) < 1 || Number(data.version) > EXPORT_VERSION)) throw new Error('Unsupported export version.');
  let rawConversations = Array.isArray(data.conversations) ? data.conversations : [];
  if (!rawConversations.length && data.conversation && typeof data.conversation === 'object') rawConversations = [data.conversation];
  if (!rawConversations.length && Array.isArray(data.messages)) rawConversations = [{ id: genId(), title: data.title || 'Imported Chat', messages: data.messages }];
  const importedConversations = rawConversations.map(raw => normalizeConversationRecord(JSON.parse(JSON.stringify(raw))));
  if (!importedConversations.length) throw new Error('No conversations found in this file.');
  importedConversations.forEach(conv => conv.messages.forEach(message => {
    if (message.role === 'assistant' && !Array.isArray(message.swipes)) {
      message.swipes = [typeof message.content === 'string' ? message.content : ''];
      message.swipeIndex = 0;
    }
  }));
  const importedProjects = (Array.isArray(data.projects) ? data.projects : []).filter(project => project && project.id).map(project => ({
    ...JSON.parse(JSON.stringify(project)),
    docs: Array.isArray(project.docs) ? project.docs : []
  }));
  const importedMemories = normalizeMemoryList(Array.isArray(data.memories) ? data.memories : []).memories;
  const drafts = Array.isArray(data.drafts) ? data.drafts.map(draft => ({ ...draft })) : [];
  const settings = {};
  Object.keys(data.settings || {}).forEach(key => {
    if (IMPORT_SETTING_ALLOWLIST.includes(key)) {
      const value = String(data.settings[key] ?? '');
      settings[key] = IMPORT_SETTING_URL_KEYS.has(key) ? sanitizeStoredUrl(value) : value;
    }
  });
  const profiles = Array.isArray(data.profiles) ? data.profiles.map(sanitizeProfileRecord) : [];
  return { conversations: importedConversations, projects: importedProjects, memories: importedMemories, drafts, settings, profiles };
}

function renderImportPreview(data) {
  const body = document.getElementById('importPreviewBody');
  if (!body) return;
  body.innerHTML = '';
  const rows = [
    ['Conversations', data.conversations.length],
    ['Projects', data.projects.length],
    ['Messages', data.conversations.reduce((total, conv) => total + conv.messages.length, 0)],
    ['Drafts', data.drafts.length + data.conversations.filter(conv => conv.draft).length],
    ['Memories', data.memories.length],
    ['Safe settings', Object.keys(data.settings).length]
  ];
  const intro = document.createElement('p');
  intro.textContent = 'Parsed successfully. API keys, search keys, sync tokens, and other secret profile fields will not be imported.';
  body.appendChild(intro);
  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'import-preview-row';
    row.innerHTML = '<strong></strong><span></span>';
    row.querySelector('strong').textContent = label;
    row.querySelector('span').textContent = String(value);
    body.appendChild(row);
  });
}

function importConversation(event) {
  if (readOnlyShare) return;
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      pendingImport = normalizeImportedData(JSON.parse(e.target.result));
      renderImportPreview(pendingImport);
      openModal('importPreviewModal');
    } catch (err) { showToast('Could not parse import: ' + sanitizeErrorDetail(err), 'error'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function mergeConversationRecords(localList, importedList) {
  const byId = new Map((localList || []).map(raw => {
    const conv = normalizeConversationRecord(raw);
    return [conv.id, conv];
  }));
  (importedList || []).forEach(raw => {
    const incoming = normalizeConversationRecord(raw);
    const current = byId.get(incoming.id);
    if (!current || Number(incoming.updatedAt) > Number(current.updatedAt)) byId.set(incoming.id, incoming);
  });
  return Array.from(byId.values());
}

function applySafeImportedSettings(settings, profiles = []) {
  Object.entries(settings || {}).forEach(([key, value]) => {
    if (IMPORT_SETTING_ALLOWLIST.includes(key)) {
      const safeValue = IMPORT_SETTING_URL_KEYS.has(key) ? sanitizeStoredUrl(value) : String(value);
      localStorage.setItem(key, safeValue);
    }
  });
  if (profiles.length) {
    const existing = loadProfiles();
    const merged = mergeByUpdatedId(existing, profiles);
    saveProfiles(merged);
  }
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

async function applyImport(mode = 'merge') {
  if (readOnlyShare || !pendingImport) return;
  if (!['merge', 'copy', 'replace'].includes(mode)) return;
  const imported = pendingImport;
  if (mode === 'replace' && !confirm('Replace imported categories? This removes local conversations, projects, memories, and drafts.')) return;
  if ((mode === 'replace' && hasPublicShareIds(conversations)) || (mode !== 'replace' && hasPublicShareIds(imported.conversations))) {
    if (!confirm('Some records have public share IDs. Deleting or replacing them does not revoke the public links. Continue?')) return;
  }
  let importedConversations = imported.conversations.map(conv => normalizeConversationRecord(JSON.parse(JSON.stringify(conv))));
  let importedProjects = JSON.parse(JSON.stringify(imported.projects));
  let importedMemories = imported.memories.slice();
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
      if (copy.projectId) copy.projectId = projectIds.get(copy.projectId) || copy.projectId;
      delete copy.shareGistId;
      delete copy.shareUrl;
      delete copy.shareId;
      copy.messages.forEach(message => delete message._editing);
      return copy;
    });
    importedMemories = importedMemories.map(memory => ({ ...memory, id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) }));
  }
  if (mode === 'replace') {
    conversations = importedConversations;
    projects = importedProjects;
    await saveMemories(importedMemories);
  } else {
    conversations = mode === 'copy' ? conversations.concat(importedConversations) : mergeConversationRecords(conversations, importedConversations);
    projects = mode === 'copy' ? projects.concat(importedProjects) : mergeByUpdatedId(projects, importedProjects);
    const localMemories = await loadMemories();
    await saveMemories(mode === 'copy' ? localMemories.concat(importedMemories) : syncMergeMemoryLists(localMemories, importedMemories));
  }
  imported.drafts.forEach(draft => {
    const conversationId = mode === 'copy' ? copyConversationIds.get(draft.conversationId) : draft.conversationId;
    const conv = conversations.find(item => item.id === conversationId);
    if (conv && (!conv.draft || Number(draft.updatedAt || 0) > Number(conv.draft.updatedAt || 0))) conv.draft = { text: draft.text || '', attachments: cloneDraftAttachments(draft.attachments), updatedAt: draft.updatedAt || Date.now() };
  });
  applySafeImportedSettings(imported.settings, imported.profiles);
  activeConvId = conversations[0]?.id || null;
  messages = getActiveConv()?.messages || [];
  await saveConversationImmediately();
  saveProjects();
  pendingImport = null;
  closeModal('importPreviewModal');
  renderSidebar();
  renderMessages();
  restoreActiveDraft();
  updateTokenInfo();
  renderConnectionChip();
  showToast('Import applied (' + mode + ').', 'success');
}

async function renderStorageSummary() {
  const el = document.getElementById('storageSummary');
  if (!el) return;
  const approximate = [
    ['Conversations', JSON.stringify(conversations).length],
    ['Projects', JSON.stringify(projects).length],
    ['Drafts', JSON.stringify(conversations.map(conv => conv.draft || null)).length],
    ['Memories', (await loadMemories()).reduce((total, memory) => total + JSON.stringify(memory).length, 0)]
  ];
  const cacheStats = await cacheGetStats();
  approximate.push(['Response cache', cacheStats.sizeBytes]);
  let usageText = 'Storage estimate unavailable.';
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.usage != null) usageText = 'Browser storage: ' + formatCacheBytes(estimate.usage) + (estimate.quota ? ' used of ' + formatCacheBytes(estimate.quota) : ' used');
  } catch (e) {}
  el.innerHTML = approximate.map(([label, bytes]) => '<div><span>' + escapeHTML(label) + '</span><strong>' + formatCacheBytes(bytes * 2) + '</strong></div>').join('') + '<p>' + escapeHTML(usageText) + '</p>';
}

async function clearDataCategory(category) {
  if (readOnlyShare) return;
  const labels = { conversations: 'conversations', drafts: 'drafts', memories: 'memories', cache: 'response cache', credentials: 'provider, search, and sync credentials' };
  if (!labels[category] || !confirm('Clear ' + labels[category] + '? This cannot be undone.')) return;
  if (category === 'conversations') {
    if (hasPublicShareIds(conversations) && !confirm('Some links may remain public after local deletion. Continue?')) return;
    conversations = [];
    activeConvId = null;
    await idbClear('conversations').catch(() => {});
    createConversation();
  } else if (category === 'drafts') {
    conversations.forEach(conv => delete conv.draft);
    pendingAttachments = [];
    const input = document.getElementById('chatInput');
    if (input) input.value = '';
    renderPreviews();
    await saveConversationImmediately();
  } else if (category === 'memories') {
    await saveMemories([]);
  } else if (category === 'cache') {
    await cacheClear();
  } else if (category === 'credentials') {
    ['llmApiKey', 'llmSearchApiKey'].forEach(key => { localStorage.removeItem(key); sessionStorage.removeItem(key); });
    ['assistantSyncGistToken', 'assistantSyncPassphrase', 'assistantSyncGistId', 'assistantSyncSalt', 'assistantSyncLastHash'].forEach(key => localStorage.removeItem(key));
    scrubProfileSecrets();
  }
  await renderStorageSummary();
  renderConnectionChip();
  showToast('Cleared ' + labels[category] + '.', 'success');
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
    const merged = mergeConversationRecords([{ id: 'same', updatedAt: 1, messages: [] }], [{ id: 'same', updatedAt: 2, messages: [{ role: 'user', content: 'newer' }] }]);
    assert(merged[0].messages.length === 1, 'import merge');
    const result = { ok: true, checks: ['normalization', 'context filtering', 'source numbering', 'legacy import', 'updatedAt merge'] };
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

function syncGetConfigFromInputs() {
  const tokenEl = document.getElementById('setSyncToken');
  const gistEl = document.getElementById('setSyncGistId');
  const passEl = document.getElementById('setSyncPassphrase');
  return {
    token: tokenEl ? tokenEl.value.trim() : (localStorage.getItem('assistantSyncGistToken') || ''),
    gistId: gistEl ? gistEl.value.trim() : (localStorage.getItem('assistantSyncGistId') || ''),
    passphrase: passEl ? passEl.value : (localStorage.getItem('assistantSyncPassphrase') || '')
  };
}

function syncSaveSettings(showSavedToast = true) {
  const cfg = syncGetConfigFromInputs();
  syncSetStoredValue('assistantSyncGistToken', cfg.token);
  syncSetStoredValue('assistantSyncGistId', cfg.gistId);
  syncSetStoredValue('assistantSyncPassphrase', cfg.passphrase);
  renderSyncSettings();
  if (showSavedToast) showToast('Sync settings saved.', 'success');
  return cfg;
}

function syncSetStatus(state, message, details) {
  const status = document.getElementById('syncStatus');
  const detailsEl = document.getElementById('syncDetails');
  if (status) {
    status.textContent = message || 'Not configured';
    status.className = 'debug-status-pill ' + (state || 'unknown');
  }
  if (detailsEl) detailsEl.textContent = details || '';
}

function renderSyncSettings() {
  const tokenEl = document.getElementById('setSyncToken');
  const gistEl = document.getElementById('setSyncGistId');
  const passEl = document.getElementById('setSyncPassphrase');
  if (tokenEl) tokenEl.value = localStorage.getItem('assistantSyncGistToken') || '';
  if (gistEl) gistEl.value = localStorage.getItem('assistantSyncGistId') || '';
  if (passEl) passEl.value = localStorage.getItem('assistantSyncPassphrase') || '';

  const token = localStorage.getItem('assistantSyncGistToken') || '';
  const gistId = localStorage.getItem('assistantSyncGistId') || '';
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

async function fetchGist(url, options = {}, token = '') {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {})
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) throw new Error(syncFormatGistError(response, await response.text()));
  if (response.status === 204) return null;
  return response.json();
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
  const content = await syncGetGistFileContent(gist, 'manifest.json', token);
  const manifest = JSON.parse(content);
  if (!manifest || manifest.app !== 'Synapse' || manifest.schema !== 'gist-sync-v1') {
    throw new Error('This Gist does not look like a Synapse sync Gist.');
  }
  return manifest;
}

function syncConversationFileName(id) {
  const safeId = String(id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return (safeId.startsWith('conv_') ? safeId : 'conv_' + safeId) + '.json.enc';
}

function syncCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function syncNormalizeConversation(conv) {
  const normalized = conv && typeof conv === 'object' ? syncCloneJson(conv) : {};
  normalized.id = normalized.id || genId();
  normalized.title = normalized.title || 'Untitled Chat';
  normalized.createdAt = Number(normalized.createdAt) || Date.now();
  normalized.updatedAt = Number(normalized.updatedAt) || normalized.createdAt || Date.now();
  normalized.messages = Array.isArray(normalized.messages) ? normalized.messages : [];
  normalized.messages.forEach(m => {
    if (m.role === 'assistant' && !m.swipes) {
      m.swipes = [typeof m.content === 'string' ? m.content : ''];
      m.swipeIndex = 0;
    }
  });
  return normalized;
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

function syncCollectSettings() {
  const settings = {};
  SYNC_SETTINGS_KEYS.forEach(key => {
    const value = localStorage.getItem(key);
    if (value === null) return;
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

function syncApplySettings(settings) {
  if (!settings || typeof settings !== 'object') return;
  SYNC_SETTINGS_KEYS.forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) {
      return;
    }
    let value = settings[key];
    if (key === 'assistantProfiles') {
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
  applyTheme(localStorage.getItem('assistantTheme') || 'dark');
  loadCustomFont(localStorage.getItem('assistantFont') || '');
  applyMsgOverrides();
  renderPromptEntries();
  loadPresets();
  renderProfileSelect();
  renderProfileSummary();
}

async function syncBuildGistFiles(passphrase, existingManifest = null) {
  clearTimeout(_saveDebounceTimer);
  if (db) {
    await idbPutAll('conversations', conversations);
    await idbPut('meta', { key: 'activeConvId', value: activeConvId || '' });
  }

  const existingSalt = existingManifest?.salt || localStorage.getItem('assistantSyncSalt') || '';
  const context = await syncBuildCryptoContext(passphrase, existingSalt || null);
  localStorage.setItem('assistantSyncSalt', context.saltBase64);

  const now = Date.now();
  const settingsPayload = { version: 1, exportedAt: new Date(now).toISOString(), settings: syncCollectSettings() };
  const memoriesPayload = { version: 1, exportedAt: new Date(now).toISOString(), memories: await loadMemories() };
  const projectsPayload = { version: 1, exportedAt: new Date(now).toISOString(), projects };
  const localConversations = conversations.map(syncNormalizeConversation);
  const files = {
    'settings.json.enc': { content: await syncEncryptPayloadWithKey(settingsPayload, context) },
    'memories.json.enc': { content: await syncEncryptPayloadWithKey(memoriesPayload, context) },
    'projects.json.enc': { content: await syncEncryptPayloadWithKey(projectsPayload, context) }
  };

  const conversationEntries = [];
  for (const conv of localConversations) {
    const filename = syncConversationFileName(conv.id);
    const payload = { version: 1, exportedAt: new Date(now).toISOString(), conversation: conv };
    files[filename] = { content: await syncEncryptPayloadWithKey(payload, context) };
    conversationEntries.push({
      id: conv.id,
      file: filename,
      updatedAt: Number(conv.updatedAt) || 0,
      hash: await syncSha256Hex(conv)
    });
  }

  const manifest = {
    version: 1,
    app: 'Synapse',
    schema: 'gist-sync-v1',
    updatedAt: now,
    deviceId: syncGetDeviceId(),
    salt: context.saltBase64,
    kdf: { name: 'PBKDF2-SHA256', iterations: SYNC_KDF_ITERATIONS },
    files: {
      settings: 'settings.json.enc',
      memories: 'memories.json.enc',
      projects: 'projects.json.enc',
      conversations: conversationEntries
    },
    hashes: {
      settings: await syncSha256Hex(settingsPayload.settings),
      memories: await syncSha256Hex(memoriesPayload.memories),
      projects: await syncSha256Hex(projectsPayload.projects)
    }
  };
  files['manifest.json'] = { content: JSON.stringify(manifest, null, 2) };
  return { files, manifest };
}

function syncIsOwnedFileName(name) {
  return name === 'manifest.json'
    || name === 'settings.json.enc'
    || name === 'memories.json.enc'
    || name === 'projects.json.enc'
    || (name.startsWith('conv_') && name.endsWith('.json.enc'));
}

async function syncPushToGist() {
  const cfg = syncSaveSettings(false);
  try {
    syncValidateConfig(cfg, false);
    syncSetStatus('checking', 'Pushing...', 'Encrypting local data and writing Gist files.');
    let gist = null;
    let existingManifest = null;
    if (cfg.gistId) {
      gist = await fetchGist(SYNC_GIST_API_URL + '/' + encodeURIComponent(cfg.gistId), { cache: 'no-store' }, cfg.token);
      try {
        existingManifest = await syncReadManifest(gist, cfg.token);
      } catch(e) {
        throw new Error('Existing Gist is not a Synapse sync Gist. Clear the Gist ID to create a new one.');
      }
    }

    const built = await syncBuildGistFiles(cfg.passphrase, existingManifest);
    if (cfg.gistId) {
      const patchFiles = { ...built.files };
      Object.keys(gist?.files || {}).forEach(name => {
        if (syncIsOwnedFileName(name) && !patchFiles[name]) patchFiles[name] = null;
      });
      const nonDeletedFiles = Object.values(patchFiles).filter(value => value !== null).length;
      if (!nonDeletedFiles) patchFiles['manifest.json'] = built.files['manifest.json'];
      await fetchGist(SYNC_GIST_API_URL + '/' + encodeURIComponent(cfg.gistId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Synapse encrypted sync data', files: patchFiles })
      }, cfg.token);
    } else {
      gist = await fetchGist(SYNC_GIST_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Synapse encrypted sync data', public: false, files: built.files })
      }, cfg.token);
      cfg.gistId = gist.id;
      localStorage.setItem('assistantSyncGistId', cfg.gistId);
      const gistEl = document.getElementById('setSyncGistId');
      if (gistEl) gistEl.value = cfg.gistId;
    }

    localStorage.setItem('assistantSyncLastPushAt', String(Date.now()));
    localStorage.setItem('assistantSyncLastHash', await syncSha256Hex(built.manifest));
    renderSyncSettings();
    syncSetStatus('current', 'Pushed', 'Encrypted sync Gist updated with ' + conversations.length + ' conversations.');
    showToast('Sync push complete.', 'success');
  } catch (err) {
    console.error('Sync push failed:', err);
    syncSetStatus('unknown', 'Push failed', err.message || 'Unable to push sync data.');
    showToast('Sync push failed: ' + (err.message || err), 'error', 6000);
  }
}

async function syncMergeConversationLists(localList, remoteList) {
  const merged = new Map();
  let added = 0;
  let updated = 0;
  let tied = 0;
  localList.map(syncNormalizeConversation).forEach(conv => merged.set(conv.id, conv));

  for (const remoteRaw of remoteList) {
    const remote = syncNormalizeConversation(remoteRaw);
    const local = merged.get(remote.id);
    if (!local) {
      merged.set(remote.id, remote);
      added++;
      continue;
    }
    const remoteUpdated = Number(remote.updatedAt) || 0;
    const localUpdated = Number(local.updatedAt) || 0;
    if (remoteUpdated > localUpdated) {
      merged.set(remote.id, remote);
      updated++;
      continue;
    }
    if (remoteUpdated === localUpdated) {
      const localHash = await syncSha256Hex(local);
      const remoteHash = await syncSha256Hex(remote);
      if (remoteHash !== localHash && remoteHash > localHash) {
        merged.set(remote.id, remote);
        tied++;
      }
    }
  }

  return { conversations: Array.from(merged.values()), added, updated, tied };
}

function syncMergeProjectLists(localList, remoteList) {
  const byId = new Map();
  (localList || []).forEach(p => { if (p && p.id) byId.set(p.id, p); });
  (remoteList || []).forEach(p => {
    if (!p || !p.id) return;
    const existing = byId.get(p.id);
    if (!existing || (Number(p.updatedAt) || 0) >= (Number(existing.updatedAt) || 0)) {
      byId.set(p.id, { ...p, docs: Array.isArray(p.docs) ? p.docs : [] });
    }
  });
  return Array.from(byId.values()).sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
}

function syncMergeMemoryLists(localList, remoteList) {
  const localNormalized = normalizeMemoryList(localList || []).memories;
  const remoteNormalized = normalizeMemoryList(remoteList || []).memories;
  const byId = new Map();
  localNormalized.forEach(memory => byId.set(memory.id, memory));
  remoteNormalized.forEach(memory => {
    const existing = byId.get(memory.id);
    if (!existing || Number(memory.createdAt) >= Number(existing.createdAt)) byId.set(memory.id, memory);
  });
  return Array.from(byId.values()).sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

async function syncPullFromGist() {
  const cfg = syncSaveSettings(false);
  try {
    syncValidateConfig(cfg, true);
    syncSetStatus('checking', 'Pulling...', 'Fetching and decrypting sync files.');
    const gist = await fetchGist(SYNC_GIST_API_URL + '/' + encodeURIComponent(cfg.gistId), { cache: 'no-store' }, cfg.token);
    const manifest = await syncReadManifest(gist, cfg.token);
    if (manifest.salt) localStorage.setItem('assistantSyncSalt', manifest.salt);
    const keyCache = {};

    const settingsFile = manifest.files?.settings || 'settings.json.enc';
    const memoriesFile = manifest.files?.memories || 'memories.json.enc';
    const settingsPayload = await syncDecryptPayload(await syncGetGistFileContent(gist, settingsFile, cfg.token), cfg.passphrase, keyCache);
    const memoriesPayload = await syncDecryptPayload(await syncGetGistFileContent(gist, memoriesFile, cfg.token), cfg.passphrase, keyCache);

    const remoteConversations = [];
    const entries = Array.isArray(manifest.files?.conversations) ? manifest.files.conversations : [];
    for (const entry of entries) {
      if (!entry?.file) continue;
      const payload = await syncDecryptPayload(await syncGetGistFileContent(gist, entry.file, cfg.token), cfg.passphrase, keyCache);
      if (payload?.conversation) remoteConversations.push(payload.conversation);
    }

    syncApplySettings(settingsPayload.settings || {});
    const mergedMemories = syncMergeMemoryLists(await loadMemories(), memoriesPayload.memories || []);
    await saveMemories(mergedMemories);

    // Guarded on the manifest key so pulling from a gist written by an older client
    // (which has no projects file) is a no-op rather than an error.
    if (manifest.files?.projects) {
      try {
        const projectsPayload = await syncDecryptPayload(
          await syncGetGistFileContent(gist, manifest.files.projects, cfg.token), cfg.passphrase, keyCache);
        projects = syncMergeProjectLists(projects, projectsPayload.projects || []);
        saveProjects();
      } catch (e) {
        console.warn('Project sync pull failed:', e);
      }
    }

    const merged = await syncMergeConversationLists(conversations, remoteConversations);
    conversations = merged.conversations;
    if (conversations.length > 0 && !conversations.find(c => c.id === activeConvId)) activeConvId = conversations[0].id;
    if (conversations.length === 0) activeConvId = null;
    messages = getActiveConv()?.messages || [];
    if (db) {
      await idbPutAll('conversations', conversations);
      await idbPut('meta', { key: 'activeConvId', value: activeConvId || '' });
    }
    localStorage.setItem('assistantActiveConvId', activeConvId || '');

    renderSidebar();
    renderMessages();
    updateTokenInfo();
    updateCharacterUI();
    localStorage.setItem('assistantSyncLastPullAt', String(Date.now()));
    renderSyncSettings();
    syncSetStatus('current', 'Pulled', 'Merged ' + remoteConversations.length + ' remote conversations. Added ' + merged.added + ', updated ' + merged.updated + '.');
    showToast('Sync pull complete.', 'success');
  } catch (err) {
    console.error('Sync pull failed:', err);
    const message = err.name === 'OperationError' ? 'Could not decrypt sync data. Check the passphrase.' : (err.message || 'Unable to pull sync data.');
    syncSetStatus('unknown', 'Pull failed', message);
    showToast('Sync pull failed: ' + message, 'error', 6000);
  }
}

function syncGeneratePassphrase() {
  try {
    const passphrase = syncBytesToBase64Url(syncRandomBytes(24)).match(/.{1,6}/g).join('-');
    const passEl = document.getElementById('setSyncPassphrase');
    if (passEl) passEl.value = passphrase;
    syncSaveSettings(false);
    showToast('Sync passphrase generated.', 'success');
  } catch (err) {
    showToast('Could not generate passphrase: ' + (err.message || err), 'error');
  }
}

function syncBuildPairingText() {
  const cfg = syncSaveSettings(false);
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
  try {
    const source = text || document.getElementById('syncPairingCode')?.value || '';
    const payload = syncParsePairingText(source);
    const gistEl = document.getElementById('setSyncGistId');
    const passEl = document.getElementById('setSyncPassphrase');
    const tokenEl = document.getElementById('setSyncToken');
    if (gistEl) gistEl.value = payload.gistId;
    if (passEl) passEl.value = payload.passphrase;
    if (payload.token && tokenEl) tokenEl.value = payload.token;
    syncSaveSettings(false);
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
  syncLoadScriptOnce.promises[id] = new Promise((resolve, reject) => {
    const existing = document.getElementById(id);
    if (existing) {
      existing.addEventListener('load', () => resolve(globalName ? window[globalName] : true), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load ' + src)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.id = id;
    script.src = src;
    script.onload = () => resolve(globalName ? window[globalName] : true);
    script.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(script);
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
    await syncLoadScriptOnce('syncQrCodeScript', 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js', 'QRCode');
    if (!window.QRCode?.toCanvas) throw new Error('QR generator did not load.');
    await window.QRCode.toCanvas(canvas, text, {
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
    if (part.type === 'image_url') {
      const url = safeMediaUrl(part.image_url?.url);
      return url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[Image attachment omitted]' };
    }
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
        if (m.role === 'assistant') {
          const images = ((m.swipeImages && m.swipeImages[m.swipeIndex || 0]) || m.images || []).map(safeMediaUrl).filter(Boolean);
          if (images.length) { out.swipeImages = [images]; out.swipeIndex = 0; }
        }
        return out;
      })
  };
}

function shareLinkFor(gistId) {
  return location.origin + location.pathname + '?share=' + encodeURIComponent(gistId);
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

async function shareConversation() {
  const conv = getActiveConv();
  if (!conv || !(conv.messages || []).length) {
    showToast('Nothing to share in this chat yet.', 'error');
    return;
  }
  const token = localStorage.getItem('assistantSyncGistToken') || '';
  if (!token) {
    showToast('Add a GitHub token in Settings → Sync first.', 'error');
    return;
  }
  const payload = buildSharePayload(conv);
  const json = JSON.stringify(payload);
  if (json.length > SHARE_MAX_BYTES) {
    showToast('Too large to share — inline images push this past the Gist size limit.', 'error');
    return;
  }
  if (!conv.shareGistId && !confirm(
    'Publish this chat to a secret GitHub Gist?\n\n' +
    'Anyone with the link can read it. Your API key, files, personas, memories and ' +
    'alternate responses are not included.')) return;

  try {
    showToast('Publishing…');
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
    saveConversations();
    const link = shareLinkFor(gist.id);
    const copied = await copyShareText(link);
    showToast(copied ? 'Link copied. Anyone with it can read this chat.' : 'Shared: ' + link, 'success');
  } catch (err) {
    showToast('Share failed: ' + (err.message || err), 'error');
  }
}

async function unshareConversation() {
  const conv = getActiveConv();
  if (!conv || !conv.shareGistId) {
    showToast('This chat isn’t shared.');
    return;
  }
  const token = localStorage.getItem('assistantSyncGistToken') || '';
  if (!token) {
    showToast('Add a GitHub token in Settings → Sync first.', 'error');
    return;
  }
  try {
    await fetchGist(SYNC_GIST_API_URL + '/' + encodeURIComponent(conv.shareGistId), { method: 'DELETE' }, token);
  } catch (err) {
    showToast('Unshare failed: ' + (err.message || err), 'error');
    return;
  }
  delete conv.shareGistId;
  saveConversations();
  showToast('Link revoked.', 'success');
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
    tag: 'SECRET_TAG', shareGistId: 'SECRET_GIST',
    docs: [{ id: 'd', name: 'n', text: 'SECRET_DOC' }],
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'hi <think>SECRET_INLINE</think>' },
        { type: 'file', file: { name: 'a.txt', url: 'data:SECRET_URL', textContent: 'SECRET_FILE' } }
      ] },
      { role: 'assistant', content: 'ok', swipes: ['ok', 'SECRET_SWIPE'], swipeIndex: 0,
        swipeThinking: ['SECRET_THINK'], swipeToolUse: [[{ url: 'SECRET_TOOL' }]],
        llm: { profileName: 'SECRET_PROFILE', providerName: 'SECRET_PROVIDER' } },
      { role: 'system', content: 'SECRET_SYSTEM' }
    ]
  };
  const json = JSON.stringify(buildSharePayload(conv));
  const leaks = ['SECRET_SUMMARY', 'SECRET_PERSONA', 'SECRET_CHAR', 'SECRET_SYSPROMPT', 'SECRET_TAG',
    'SECRET_GIST', 'SECRET_DOC', 'SECRET_URL', 'SECRET_FILE', 'SECRET_SWIPE', 'SECRET_THINK',
    'SECRET_TOOL', 'SECRET_PROFILE', 'SECRET_PROVIDER', 'SECRET_SYSTEM', 'SECRET_INLINE', 'proj_1', 'conv_1']
    .filter(s => json.includes(s));
  if (leaks.length) throw new Error('share payload leaked: ' + leaks.join(', '));
  if (!json.includes('a.txt')) throw new Error('share payload lost the file name');
  if (!json.includes('hi')) throw new Error('share payload lost the message text');
  console.log('shareSelfTest OK');
  return true;
}

function exportMarkdown() {
  const conv = getActiveConv();
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
  if (messages.length === 0) { showToast('No messages to screenshot.', 'info'); return; }
  _selectMode = true;
  _justEnteredSelectMode = true;
  _selectedMsgs.clear();
  document.getElementById('messagesArea').classList.add('select-mode');
  document.getElementById('selectToolbar').classList.add('visible');
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
      clone.querySelectorAll('.msg-actions, .regen-btn, .swipe-nav, .branch-controls, .msg-meta, .msg-timestamp').forEach(el => el.remove());
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
  popup.style.width = '500px';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-modal', 'true');
  popup.setAttribute('aria-labelledby', 'globalSearchTitle');
  popup.setAttribute('tabindex', '-1');
  popup.innerHTML = '<h3 id="globalSearchTitle">Search All Messages</h3>' +
    '<input type="text" id="globalSearchInput" placeholder="Type to search across all conversations..." style="width:100%;padding:10px;font-family:inherit;font-size:0.9em;background:var(--hover);border:1px solid var(--card-border);border-radius:8px;color:var(--text-primary);margin-bottom:12px;outline:none">' +
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
      const text = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.filter(p => p.type === 'text').map(p => p.text).join(' ') : '');
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
  container.innerHTML = displayed.map(r =>
    '<div class="global-search-result" data-conv-id="' + r.convId + '" tabindex="0" role="button" aria-label="Open conversation ' + escapeHTML(r.convTitle) + '">' +
    '<div class="global-search-result-title">' + escapeHTML(r.convTitle) + ' <span style="font-weight:400;color:var(--text-secondary)">(' + escapeHTML(r.role) + ')</span></div>' +
    '<div class="global-search-result-snippet">' + r.snippet + '</div></div>'
  ).join('') + (results.length > 50 ? '<div style="color:var(--text-secondary);font-size:0.8em;text-align:center;padding:8px">Showing 50 of ' + results.length + ' results</div>' : '');
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

  const area = document.getElementById('messagesArea');
  const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT, null, false);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

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
  return new Promise((resolve) => {
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
    img.onerror = () => { URL.revokeObjectURL(img.src); resolve(null); };
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

async function readAttachmentFile(file) {
  const mime = (file.type || '').toLowerCase();
  const name = file.name || 'file';
  const originConvId = activeConvId;
  const fail = (message) => {
    queueAttachmentForConversation(originConvId, { type: 'file', name, mime: file.type || 'application/octet-stream', textContent: message });
  };

  try {
    const isImage = mime.startsWith('image/');
    if (isImage) {
      const resizedUrl = await resizeImageIfNeeded(file, 1536, 0.85);
      if (resizedUrl) {
        queueAttachmentForConversation(originConvId, { type: 'image', dataUrl: resizedUrl, name, mime: 'image/jpeg' });
      } else {
        queueAttachmentForConversation(originConvId, { type: 'image', dataUrl: await readFileAsDataURL(file), name, mime: file.type });
      }
    } else if (mime === 'application/pdf' || /\.pdf$/i.test(name)) {
      const text = await extractPdfText(await file.arrayBuffer());
      queueAttachmentForConversation(originConvId, { type: 'file', name, mime: file.type || 'application/pdf', textContent: limitAttachmentText(text, name) || '[PDF contains no extractable text]' });
    } else if (DOCX_EXTENSIONS.test(name) || DOCX_MIMES.has(mime)) {
      const text = await extractDocxText(await file.arrayBuffer());
      queueAttachmentForConversation(originConvId, { type: 'file', name, mime: file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', textContent: limitAttachmentText(text, name) || '[DOCX contains no extractable text]' });
    } else if (/\.rtf$/i.test(name) || RTF_MIMES.has(mime)) {
      const text = extractRtfText(await file.text());
      queueAttachmentForConversation(originConvId, { type: 'file', name, mime: file.type || 'text/rtf', textContent: limitAttachmentText(text, name) || '[RTF contains no extractable text]' });
    } else if (DOC_EXTENSIONS.test(name) || DOC_MIMES.has(mime)) {
      const text = extractLegacyDocText(await file.arrayBuffer());
      queueAttachmentForConversation(originConvId, { type: 'file', name, mime: file.type || 'application/msword', textContent: limitAttachmentText(text, name) || '[Legacy DOC could not be read as text]' });
    } else if (isTextLikeFile(file)) {
      const text = await file.text();
      queueAttachmentForConversation(originConvId, { type: 'file', name, mime: file.type || 'text/plain', textContent: limitAttachmentText(text, name) });
    } else {
      const buffer = await file.arrayBuffer();
      if (isProbablyTextBuffer(buffer)) {
        const text = new TextDecoder('utf-8').decode(buffer);
        queueAttachmentForConversation(originConvId, { type: 'file', name, mime: file.type || 'text/plain', textContent: limitAttachmentText(text, name) });
        return;
      }
      queueAttachmentForConversation(originConvId, {
        type: 'file',
        dataUrl: await readFileAsDataURL(file),
        name,
        mime: file.type || 'application/octet-stream',
        binary: true,
        textContent: `[Binary file attached: ${name} (${file.type || 'unknown type'}, ${file.size.toLocaleString()} bytes). This provider may only receive file contents if it supports document uploads.]`
      });
    }
  } catch (e) {
    console.error('File attachment failed:', e);
    fail(`[${name} could not be read]`);
  }
}

function handleFileSelect(event) {
  Array.from(event.target.files).forEach(readAttachmentFile);
  event.target.value = '';
}

function renderPreviews() {
  const container = document.getElementById('imagePreview');
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
  let models = [];
  try { models = JSON.parse(localStorage.getItem('llmModelList') || '[]'); } catch(e) { console.warn('Model list parse error:', e); }
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

  try {
    let rawCard = null;
    let avatarDataUrl = null;

    if (file.name.toLowerCase().endsWith('.png')) {
      const arrayBuffer = await file.arrayBuffer();
      rawCard = extractCharaFromPNG(arrayBuffer);
      if (!rawCard) { showToast('No character data found in PNG.', 'error'); return; }
      // Also store the PNG as avatar
      const blob = new Blob([arrayBuffer], { type: 'image/png' });
      avatarDataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.readAsDataURL(blob);
      });
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

    conversations.unshift(conv);
    activeConvId = conv.id;
    messages = conv.messages;
    saveConversations();
    renderSidebar();
    renderMessages();
    updateTokenInfo();
    updateCharacterUI();

    showToast('Character imported: ' + charName, 'success');
    if (window.innerWidth <= 768) toggleSidebar();
  } catch (err) {
    showToast('Error importing character: ' + err.message, 'error');
  }
}

function updateCharacterUI() {
  const conv = getActiveConv();
  const infoBtn = document.getElementById('charInfoBtn');
  const titleEl = document.querySelector('.toolbar-title');
  if (conv && conv.characterCard) {
    infoBtn.style.display = '';
    titleEl.textContent = conv.characterCard.name || conv.title;
  } else {
    infoBtn.style.display = 'none';
    titleEl.textContent = 'Synapse';
  }
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
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const btn = document.getElementById('voiceBtn');

  if (voiceRec) {
    voiceRec.stop();
    voiceRec = null;
    btn.classList.remove('recording');
    return;
  }

  voiceRec = new SR();
  voiceRec.lang = 'en-US';
  voiceRec.interimResults = true;
  voiceRec.continuous = true;

  const input = document.getElementById('chatInput');
  const startText = input.value;
  btn.classList.add('recording');

  voiceRec.onresult = (e) => {
    let transcript = '';
    for (let i = 0; i < e.results.length; i++) transcript += e.results[i][0].transcript;
    input.value = startText + transcript;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
    persistDraftFromUI();
  };

  voiceRec.onend = () => { btn.classList.remove('recording'); voiceRec = null; };
  voiceRec.onerror = () => { btn.classList.remove('recording'); voiceRec = null; };
  voiceRec.start();
}

// Window bridge for inline handlers and external hooks
const __windowBridge = {
  // Share links (inline onclick in index.html; shareSelfTest is for the console)
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
  extractMemories,
  cleanupMemories,
  openManageMemories,
  openSearchTest,
  openSourcesDrawer,
  buildSnippet,
  searchLocalDocs,
  openFileSearch,
  openSummaryModal,
  openStatusPanel,
  parseCommand,
  handleCommand,
  handleManualSearch,
  handleFileSearch,
  buildConversationTranscript,
  deleteMemory,
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
  setAssistantLlmMetadata,
  prepareAnthropicMessages,
  renderGenImages,
  buildApiContent,
  extractImages,
  renderMarkdown,
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
  generateCacheKey,
  cacheLookup,
  cacheStore,
  cacheDelete,
  cacheClear,
  cacheCleanupExpired,
  cacheGetStats,
  toggleCache,
  clearResponseCache,
  cleanupExpiredCache,
  updateCacheStats,
  genId,
  saveConversations,
  debouncedSave,
  migratePersonaField,
  loadConversations,
  getActiveConv,
  createConversation,
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
  toggleToolbarMenu,
  closeToolbarMenu,
  getSelectedModel,
  saveSetup,
  switchSettingsTab,
  openSettings,
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
  compactOlderTurns,
  toggleComposerTools,
  closeComposerTools,
  maybeAddAvatar,
  renderMessages,
  renderEditMode,
  resendAfterEdit,
  swipeMsg,
  switchBranch,
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
  regenerate,
  continueMessage,
  clearChat,
  exportConversation,
  exportAllConversations,
  importConversation,
  normalizeImportedData,
  applyImport,
  renderStorageSummary,
  clearDataCategory,
  synapseSelfTest,
  closeCommandDropdown,
  handleCommandInput,
  handleCommandKeydown,
  syncSaveSettings,
  renderSyncSettings,
  syncPushToGist,
  syncPullFromGist,
  syncGeneratePassphrase,
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
