# Synapse

Synapse is a browser-only chat app for API-backed assistants. It runs from static files, stores your chats locally, and sends requests only to the endpoint you configure.

Use it from GitHub Pages, run it from a local server, or download the standalone `synapse.html` file.

## What It Does

### Providers and Models

- Works with OpenAI, Anthropic, and OpenAI-compatible endpoints.
- Supports local model servers such as LM Studio, Ollama, and text-generation-webui.
- Lets you save connection profiles for different base URLs, keys, models, and request settings.
- Supports streaming responses, stop generation, and one-message model overrides with `@model-name`.
- Shows which model answered and an estimated token count on each message.

### Chats

- Create, rename, tag, search, import, and export conversations.
- Export one chat as JSON or Markdown, or export everything at once.
- Edit a user message and resend from that point.
- Regenerate assistant messages and switch between swipes.
- Fork a chat from any message.
- Generate and save a conversation summary for context.
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
- Optional memory across conversations.
- Status and diagnostics panel for connection/search checks.
- Debug tab with redacted request logging, optional full text logging, and a snapshot copy button.
- Local update indicator when a local build can be compared against `version.json` or a `/version` endpoint.

### Appearance

- Built-in themes, custom color picker, and light/dark/system toggle.
- Custom font, message width, font size, and border radius settings.
- Syntax highlighting, LaTeX, Mermaid diagrams, tables, code blocks, spoilers, and generated image display.
- Optional local emotion sprites for Claude, GPT, and Gemini output tags, with automatic or manual sprite-set selection.
- Mobile layout with touch-friendly controls.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Send message, if enabled |
| `Shift+Enter` | New line |
| `Ctrl+Enter` | Send message |
| `Ctrl+N` | New conversation |
| `Ctrl+/` | Focus input |
| `Ctrl+K` | Search conversations |
| `Ctrl+F` | Search current chat |
| `Ctrl+Shift+E` | Export all conversations |
| `Ctrl+Shift+R` | Regenerate last response |
| `Escape` | Close modal or stop generation |
| `@model` | Override the model for one message |

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

On first launch, enter:

1. Base URL, for example `https://api.openai.com/v1` or `http://localhost:1234/v1`.
2. API key.
3. Model name, either fetched from the provider or typed manually.

Keys and settings stay in your browser. Synapse does not run a server and does not proxy your traffic.

## Storage

Synapse uses browser storage:

| Storage | Contents |
|---|---|
| IndexedDB | Conversations, messages, and memories |
| `localStorage` | API settings, themes, profiles, prompt entries, presets, cached model list, and UI preferences |

Important keys include:

| Key | Contents |
|---|---|
| `llmProxyUrl` | API base URL |
| `llmApiKey` | API key |
| `llmModel` | Active model |
| `assistantProfiles` | Saved connection profiles |
| `assistantTheme` | Current theme |
| `assistantCustomTheme` | Custom theme colors |
| `llmPromptEntries` | Prompt entries |
| `assistantDebug` | Debug logging toggle |

Use "Export all chats" from the toolbar menu if you want a backup.

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
