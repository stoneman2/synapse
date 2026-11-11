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

API keys can be saved as **Remember on this device** (`localStorage`) or **This tab only** (`sessionStorage`). Each key is bound to its provider, base URL and API format, so changing the connection in another tab can't send it somewhere else. Older saved keys need one confirmation: review the prefilled connection and save it. Browser storage is not an encrypted vault.

### Chats

- Create, rename, tag, search, import, and export conversations. Active and Archived views, collapsible project groups, duplicate/archive/restore, bulk selection, and Updated/Created/Title/Manual sorting are available in the sidebar.
- Export one chat as JSON or Markdown, or make a full backup from Data settings.
- Temporary chats stay only in the current loaded tab, ignore saved memories and project context, and can't be exported, shared, or saved as screenshots by Synapse. Your selected provider still receives the messages.
- Four editable starter prompts fill the composer locally. They make no API request and can be hidden in Prompts settings.
- 'Complete draft' and 'Suggest follow-ups' call the selected provider only when you ask. Suggestions fill the composer and never send themselves.
- Edit a user message and resend from that point.
- Regenerate assistant messages and switch between swipes.
- Failed or interrupted responses keep the text already received. Retry and Continue create another version instead of replacing the old one. A failed response or Stop pauses the follow-up queue.
- Fork a chat from any message. Parent and child links stay available in the Context panel.
- Set a per-chat goal and generate or save a conversation summary for context.
- Use the right Context panel for goals, request previews, per-chat tools, summaries, sources, and related forks. Individual messages can be included or excluded; compaction summarises older turns without deleting them. Summaries track which turns they cover, and edits or forks discard summaries that cross the changed history.
- Unfinished Context edits survive redraws and chat switches until you save or discard them. They're session-only, unlike the saved composer draft.
- Queue follow-up messages, attachments, and one-message model overrides while a response is streaming. Queues persist across reloads but remain paused until you choose Resume.
- Draft text and pending attachments are saved per conversation and restored after switching chats or reloading.
- Select message ranges for screenshots.

### Files

- Attach images, PDFs, DOCX/DOC, JSON, RTF, CSV, HTML, Markdown, code, and plain text files.
- Images are sent for vision-capable models.
- Text is extracted from supported document formats before sending.
- Large text attachments are capped so one file does not flood the request.

### Image Generation

- **Settings → Images** has a custom OpenAI-compatible base URL, image model name, API key, and device-local enable switch. There is no image-provider catalogue. The chat model only needs tool calling.
- The `generate_image` tool sends `POST <base URL>/images/generations` with `{ model, prompt, n: 1 }`. Each call needs its own spending approval unless **Auto-approve images** is checked in Settings → Images (off by default, saved only on this device). Auto-approval skips image confirmations and may incur charges; search/fetch confirmations are unchanged.
- Base64 and downloadable URL responses are supported. Synapse downloads and validates PNG, JPEG, WebP, or GIF bytes (maximum 10 MiB), rather than saving expiring remote URLs. Returned URLs receive no API key or cookies and must support browser CORS.
- Images are per-message, per-swipe attachments. Markdown such as `![Description](attachment:img_abc123)` places an attachment inline, with text before and after it. Synapse assigns the IDs and inserts references at tool-call positions. Referenced attachments are not duplicated at the bottom; unreferenced attachments fall back there, and missing ones show an unavailable placeholder.
- Inline progress, Cancel, and Retry image controls retain the same attachment position. Stop cancels the local request, but the service may still finish and bill it. Synapse never automatically retries a paid image POST; Retry image asks for fresh approval unless image auto-approval is enabled and can incur a new charge.
- Image connection settings, key, and permission stay on this device, outside profiles, exports, and sync. Browser storage is not an encrypted vault. Image bytes and references travel with JSON conversation exports and encrypted indexed backups, including alternate swipes. Public chat shares omit image bytes. Legacy backups can omit large images; use indexed backups for portability.
- Use HTTPS or a local image API. Non-local HTTP APIs on an HTTPS page require a trusted CORS proxy configured under Tools; the paid POST is sent once, without fallback retries. Standalone-file browser restrictions still apply.

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
- Optional local emotion sprites for Claude, GPT and Gemini, plus Cat, Butler, Maid, Calico Plushie and Zom with 24 expressions each. Choose a character in Appearance to use it with any model; Auto still follows the model.
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

If you cloned the repo, serve the `assistant` directory over HTTP using the instructions below. Opening the source `index.html` directly from disk can block its JavaScript modules; direct file opening is for the standalone build.

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
| `llmApiKey` | API key and its approved connection, in the selected device or tab store |
| `llmModel` | Active model |
| `assistantProfiles` | Saved connection profiles |
| `assistantTheme` | Current theme |
| `assistantCustomTheme` | Custom theme colours |
| `llmPromptEntries` | Prompt entries |
| `assistantStarterPrompts` | Local starter prompts |
| `assistantDebug` | Debug logging toggle |

Temporary chats never enter browser storage and disappear on reload or close. Use 'Export backup' in Data settings when you want a copy of everything persistent.

Local cross-tab persistence and older Gist archives keep conflicting histories as separate, labelled copies. Choose which one to continue. New indexed Gists instead merge individual messages as described below.

Optional GitHub Gist sync encrypts conversations, memories, projects, prompts, presets and font and message display settings. Theme selection and custom theme colors stay on each device; pulls ignore theme values in older Gists. Pull now is always manual, including applying remote deletions. After the first push, you can opt into automatic pushes from the Sync tab; they're off by default, wait for generation and attachment reads to finish, and never run on shared read-only pages. A secret Gist is unlisted rather than access-controlled; keep its encryption passphrase safe.

The Sync tab has device-local checkboxes for Settings, Memories, Projects, and Conversations. Existing category coverage and existing chats remain enabled. Use a chat's sidebar actions menu to enable or stop syncing it on this device; stopping does not delete its remote backup. New chats start local-only unless **Automatically enable sync for new conversations** is checked. That default never changes older chats. Pull discovers remote chats with sync enabled unless that chat was explicitly disabled locally. Unchecked categories are neither uploaded nor applied by Pull, and re-enabling them allows a fresh pull even when the remote Gist has not changed. Conversation deletion records remain eligible for upload even after that chat's ongoing sync is stopped, but require the Conversations category to be enabled. Projects must be enabled separately to transfer shared project instructions and supported file data.

New Gists use an encrypted `gist-sync-index-v4` index. Each conversation has an ordered list of immutable encrypted parts and integrity hashes. Small conversations normally use one part; large conversations split below GitHub's inline-file threshold. Embedded data URLs (including message images/files, swipe images, avatars, draft attachments, and queued attachments) are extracted, split when needed, and reused by reference. Supported extracted document text is preserved too. Temporary `blob:` URLs cannot form a portable backup and cause an explicit incomplete-backup error rather than being silently dropped. Original files that the app never retained cannot be reconstructed from extracted text.

Push merges changed conversations with the published version without applying it locally. Messages have stable unique IDs, locally tracked edit times, and explicit deletion records; missing conversations or messages never imply deletion. The newest edit wins per message; an explicit message deletion wins an equal-time tie. Edit ordering depends on device clocks. The indexed sync path never creates conflict copies. A locally changed title or individual setting, memory, or project replaces that item's published value on a successful push; unchanged stale items are not republished. Ordinary local cross-tab persistence retains its existing conflict protection. Same-browser pushes use Web Locks where supported; older browsers lack that protection. Independent devices can still race at publication: a revision recheck catches common overlap, but there is no cross-device lock or guarantee against the final simultaneous-write window.

Parts are staged in paced batches and verified before the encrypted index switches. Publication switches the whole index, not individual conversations. The previous complete version stays published during staging. Once the new index verifies, superseded remote parts are automatically deleted in a separate maintenance step. This bounds the current backup, not GitHub's underlying revision history, and it is not a permanent application-level edit history. The app allows 250 published files including the index and manifest, with staging headroom up to 290 total files, an 80% file-count warning, a 512 MiB total read/staging safeguard, a 1 MiB encrypted-index limit, and a 64 MiB per-object safeguard. These are app safety limits, not claims about GitHub's storage quotas. Capacity is checked against encrypted sizes before staging; if replacement cannot fit alongside the previous version, it stops safely rather than deleting the old version first.

Unfinished work and per-item upload receipts persist on this device. **Retry unfinished work** reuses verified staged uploads and cached encrypted downloads after a reload. A changed local selection is respected when replanning a retry. Pull commits only after all selected records and their attachments finish downloading and verifying; failed downloads never apply a partial conversation. A completed backup with failed cleanup is labeled separately, and even a no-change push retries that cleanup. Rate-limit errors leave work queued for a later retry rather than hammering GitHub. Disposable encrypted download caches are pruned after successful operations. Browser storage still needs room for the complete downloaded data and temporary cached parts.

Older encrypted Gists stay on the existing archive path; there is no automatic migration. That path retains its previous 250-file/32 MiB archive, 8 MiB snapshot, 64 MiB read, and large-attachment restrictions. To start an indexed backup, pull/export anything you need, clear the Gist ID, then push to create a fresh Gist. Keep the old Gist and passphrase until you've checked the new backup. Update Synapse on every participating device: older builds do not understand the indexed format. Generating a replacement passphrase requires explicit consent to start a new Gist.

The Data tab reports approximate storage usage, provides confirmed clear actions and previews imports. Merge preserves divergent chat versions; Copy assigns new IDs; Replace needs another confirmation. Full backups include saved presets. Export schema is `synapse-export` version 2; legacy single-chat files still import. Credentials and unsupported profile settings are excluded.

Import and encrypted sync require a working browser database. Local fallback storage supports editing and exporting, but not the same cross-tab protections. Failed imports leave the database unchanged and restore settings still owned by that attempt. A browser or device crash between database and settings writes isn't an all-or-nothing operation across both stores, so keep backups. If another tab reports a storage upgrade, reload it before editing.

## Building and updating the hosted site

Run `python assistant/build.py` from the repository root before publishing. It stamps the HTML, JavaScript imports, service-worker cache, and version metadata together, and rebuilds `synapse.html` with its embedded sprites. Deploy the generated files together; do not update just the standalone file when hosting `index.html`.

Hosted app code is fetched fresh online, bypassing the browser's HTTP cache, with cached files used offline or during server errors. Fonts, rendering libraries, and sprites remain cache-first. Service-worker updates bypass HTTP caching and are checked again when returning to a long-lived app window. Updates never automatically reload a chat or interrupt generation.

For a stuck hosted copy, use **Settings → Data → Refresh app files** while online. It saves the current draft, removes only Synapse's app-file caches, then reloads the same site. It does not clear IndexedDB, localStorage, credentials, or generated images. Save/discard unfinished edits and wait for generation or sync to finish first. Temporary chats are tab-only and will be lost on reload; the confirmation warns about them. If the network check fails, the offline cache is kept.

On the first deployment of this cache fix, an already-open old build may need a reload to install the new worker and another reload to use it. If the wrapper still serves old HTML, open the same address with a fresh query string (for example `?update=cache-fix`) without changing its host or path. This preserves the site's saved data. No site-data wipe is needed. These rules cannot override a stale hosting/CDN deployment; serve `sw.js`, HTML, and `version.json` with revalidation rather than long-lived immutable caching where the host allows it.

## Checks

With Node, Playwright Core and its matching Chromium already available, run from the repository root:

```bash
node assistant/tests/run.cjs
node assistant/tests/run.cjs --standalone
node assistant/tests/run.cjs release
```

Set `PLAYWRIGHT_MODULE` to an installed Playwright Core module path if Node can't resolve it. The checks use disposable browser storage and mocked providers, with nonlocal requests blocked. They don't exercise real accounts, microphones or physical touch devices. These suites block service workers; cache/update behavior also needs testing with an actual controlling service worker and a previously cached build. Run `python assistant/build.py` after changing source files.

## Project Files

```text
assistant/
  index.html          App shell and modals
  build.py            Release stamps and standalone build, including sprites
  styles.css          Styles, themes, and responsive layout
  synapse.html        Standalone build with CSS and JS inlined
  version.json        Build metadata for local update checks
  favicon.ico
  assets/
    emotion-sprites/  Provider sprites and original character artwork
  js/
    main.js           App logic
    lib/
      dom-utils.js    Focus helpers
      text-utils.js   HTML escaping and colour helpers
  tests/              Isolated browser regression checks
```

## Browser Support

Synapse targets current Chrome, Firefox, Safari, and Edge. Some features depend on browser APIs:

- Voice input needs `SpeechRecognition`.
- DOCX extraction needs `DecompressionStream`.
- PDF extraction loads PDF.js from a CDN.
- API calls may need a CORS-friendly endpoint or proxy.

## Credit

Forked by Stoneman from [purachina](https://platberlitz.github.io/).

Claude, GPT and Gemini emotion sprites are from [N8python/claudesona](https://github.com/N8python/claudesona) under CC0 1.0 Universal. Cat, Butler, Maid and Calico Plushie are original artwork for Synapse. Zom's expression set is based on a supplied character reference and is separate from that CC0 collection.
