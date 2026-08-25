# Synapse

Synapse is my browser-only chat app for API-backed assistants. It runs from static files, stores your chats locally, and sends requests only to the endpoint you configure.

Use it from GitHub Pages, run it from a local server, or download the standalone `synapse.html` file.

## What It Does

### Providers and Models

- Setup and API settings include OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, and Custom presets.
- Test a connection and discover models without saving settings. Model metadata is used for context estimates when the provider supplies a context length.
- Supports local model servers such as LM Studio, Ollama, and text-generation-webui.
- Lets you save connection profiles for different base URLs, models, and request settings; API keys stay in the selected device/tab credential store and are scrubbed from profiles, exports, and sync payloads.
- Supports streaming responses, stop generation, and one-message model overrides with `@model-name`.
- The toolbar chip opens a searchable profile and model picker. Each assistant swipe records lifecycle, timing, HTTP, and sanitised error metadata.
- Compare two models before sending. Synapse makes two non-streaming requests and stores both replies as response swipes. A cross-provider key stays in memory only for that comparison.

API keys can be saved as **Remember on this device** (`localStorage`) or **This tab only** (`sessionStorage`). Legacy `llmApiKey` values remain remembered until changed. Browser storage is not an encrypted vault.

### Chats

- Create, rename, tag, search, import, and export conversations. Active and Archived views, collapsible project groups, duplicate/archive/restore, bulk selection, and Updated/Created/Title/Manual sorting are available in the sidebar.
- Export one chat as JSON or Markdown, or make a full backup from Data settings.
- Temporary chats stay only in the current loaded tab, ignore saved memories and project context, and can't be exported, shared, or saved as screenshots by Synapse. Your selected provider still receives the messages.
- Four editable starter prompts fill the composer locally. They make no API request and can be hidden in Prompts settings.
- 'Complete draft' and 'Suggest follow-ups' call the selected provider only when you ask. Suggestions fill the composer and never send themselves.
- Edit a user message and resend from that point.
- Regenerate assistant messages and switch between swipes.
- Fork a chat from any message. Parent and child links stay available in the Context panel.
- Set a per-chat goal and generate or save a conversation summary for context.
- Use the right Context panel for goals, request previews, per-chat tools, summaries, sources, and related forks. Individual messages can be included or excluded; compaction summarizes older turns without deleting them.
- Queue follow-up messages, attachments, and one-message model overrides while a response is streaming. Queues persist across reloads but remain paused until you choose Resume.
- Draft text and pending attachments are saved per conversation and restored after switching chats or reloading.
- Select message ranges for screenshots.

### Files

- Attach images, PDFs, DOCX/DOC, JSON, RTF, CSV, HTML, Markdown, code, and plain text files.
- Images are sent for vision-capable models.
- Text is extracted from supported document formats before sending.
- Large text attachments are capped so one file does not flood the request.

### Roleplay and Prompting

- Import SillyTavern character cards from `.png` or `.json`.
- Set a persona for the user.
- Manage ordered prompt entries with enable/disable controls and drag reordering.
- Save, load, and import prompt presets, including SillyTavern presets.
- Supports common SillyTavern macros such as `{{user}}` and `{{char}}`.

### Tools and Diagnostics

- Web search through Anthropic tools, SearXNG, Brave, or a custom search endpoint.
- Composer commands include `/search`, `/files`, `/goal`, `/context`, `/summary`, `/tools`, `/settings`, and `/projects`. Per-chat web-search, URL-fetch, and confirmation policies override global defaults.
- Tool calls show their state, require one confirmation per response when enabled, and persist deduplicated numbered sources for citations and the Sources drawer.
- Optional memory across conversations.
- Status and diagnostics panel for connection/search checks.
- Debug tab with redacted request logging, optional full text logging, and a snapshot copy button.
- Local update indicator when a local build can be compared against `version.json` or a `/version` endpoint.

### Appearance

- A muted forest-green workbench theme by default, plus built-in themes, a custom colour picker, and light/dark/system toggle.
- Custom font, message width, font size, and border radius settings.
- Syntax highlighting, LaTeX, Mermaid diagrams, tables, code blocks, spoilers, and generated image display.
- Optional local emotion sprites for Claude, GPT, and Gemini output tags, with automatic or manual sprite-set selection.
- Mobile layout with touch-friendly controls.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Send, or queue a follow-up while streaming, if enabled |
| `Shift+Enter` | New line |
| `Ctrl/Cmd+Enter` | Send message |
| `Ctrl/Cmd+N` | New conversation |
| `Ctrl/Cmd+/` | Focus input |
| `Ctrl/Cmd+K` | Search conversations |
| `Ctrl/Cmd+F` | Search current chat |
| `Ctrl/Cmd+Shift+E` | Export backup |
| `Ctrl/Cmd+Shift+R` | Regenerate last response |
| `Escape` | Close modal or stop generation |
| `@model` | Override the model for one message |

Typing `/` in the composer opens the command menu with usage and aliases. Focus a message with Tab to reveal its actions, including Include/Exclude, Retry, and request Details.

## Run It

### Standalone File

Download `synapse.html` and open it in your browser:

```bash
open synapse.html       # macOS
xdg-open synapse.html   # Linux
start synapse.html      # Windows
```

Some browsers block requests from `file://` pages. If API calls fail from the standalone file, use a local HTTP server.

### Source Files

If you cloned the repo, you can open `assistant/index.html` directly:

```bash
open assistant/index.html       # macOS
xdg-open assistant/index.html   # Linux
start assistant/index.html      # Windows
```

### Local Server

Any static server works:

```bash
cd assistant
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

Other options:

```bash
npx serve assistant
php -S localhost:8000 -t assistant
```

## Setup

On first launch, choose a provider preset, test the connection if desired, then enter:

1. Base URL (presets fill the common values).
2. API key when the provider requires one.
3. Model name, either fetched from the provider or typed manually. Synapse does not assume a model name.

Keys and settings stay in your browser. Synapse does not run a server and does not proxy your traffic.

## Storage

Synapse uses browser storage:

| Storage | Contents |
|---|---|
| IndexedDB | Persistent conversations, messages, drafts, queued follow-ups, goals, and memories |
| `localStorage` | API settings, themes, profiles, prompt entries, presets, cached model list, and UI preferences |
| `sessionStorage` | A key selected as “This tab only” |

Important keys include:

| Key | Contents |
|---|---|
| `llmProxyUrl` | API base URL |
| `llmApiKey` | Remembered API key (legacy and current compatibility key) |
| `llmModel` | Active model |
| `assistantProfiles` | Saved connection profiles |
| `assistantTheme` | Current theme |
| `assistantCustomTheme` | Custom theme colors |
| `llmPromptEntries` | Prompt entries |
| `assistantStarterPrompts` | Local starter prompts |
| `assistantDebug` | Debug logging toggle |

Temporary chats never enter browser storage and disappear on reload or close. Use 'Export backup' in Data settings when you want a copy of everything persistent.

Optional GitHub Gist sync encrypts conversations, memories, projects, prompts, presets, and appearance settings before storing them in a private Gist. Push now creates or updates it; Pull now is always manual. After the first push, you can opt into debounced automatic pushes from the Sync tab. Automatic push is off by default and never pulls or runs on shared read-only pages.

The Data settings tab reports approximate category sizes and browser usage/quota, provides separate confirmed clear actions, and previews imports before applying them. Imports accept schema-less legacy single-chat files and current bulk files. Merge uses newer `updatedAt` values; Copy remaps IDs; Replace requires an additional confirmation. Export schema version is `synapse-export` version 2. Credentials are excluded from settings/profiles in exports and imports.

## Project Files

```text
assistant/
  index.html          App shell and modals
  styles.css          Styles, themes, and responsive layout
  synapse.html        Standalone build with CSS and JS inlined
  version.json        Build metadata for local update checks
  favicon.ico
  assets/
    emotion-sprites/  CC0 emotion sprite images from N8python/claudesona
  js/
    main.js           App logic
    lib/
      dom-utils.js    Focus helpers
      text-utils.js   HTML escaping and color helpers
```

## Browser Support

Synapse targets current Chrome, Firefox, Safari, and Edge. Some features depend on browser APIs:

- Voice input needs `SpeechRecognition`.
- DOCX extraction needs `DecompressionStream`.
- PDF extraction loads PDF.js from a CDN.
- API calls may need a CORS-friendly endpoint or proxy.

## Credit

Made by [purachina](https://platberlitz.github.io/).

Emotion sprites are from [N8python/claudesona](https://github.com/N8python/claudesona) under CC0 1.0 Universal.
