# Synapse — Project Notes for Claude

## Build: synapse.html

`assistant/synapse.html` is a single-file standalone build of the app. **After any change to these source files, you must regenerate it:**

- `assistant/index.html`
- `assistant/styles.css`
- `assistant/js/main.js`
- `assistant/js/lib/dom-utils.js`
- `assistant/js/lib/text-utils.js`

### How to rebuild

Run this from the repo root before publishing:

```bash
python assistant/build.py
```

The build helper stamps HTML asset URLs, imported module URLs, the service-worker cache, `APP_VERSION`, and `version.json` together. It embeds the sprite files so the standalone keeps working offline. Include all generated changes in the same commit as the source changes and publish them together. Do not hand-edit individual version stamps.
