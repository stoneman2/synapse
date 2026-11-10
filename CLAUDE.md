# Synapse — Project Notes for Claude

## Build: synapse.html

`assistant/synapse.html` is a single-file standalone build of the app. **After any change to these source files, you must regenerate it:**

- `assistant/index.html`
- `assistant/styles.css`
- `assistant/js/main.js`
- `assistant/js/lib/dom-utils.js`
- `assistant/js/lib/text-utils.js`

### How to rebuild

Run this from the repo root:

```bash
cd assistant && python3 << 'PYEOF'
import re

with open('index.html', 'r') as f:
    html = f.read()
with open('styles.css', 'r') as f:
    css = f.read()
with open('js/lib/dom-utils.js', 'r') as f:
    dom_utils = f.read()
with open('js/lib/text-utils.js', 'r') as f:
    text_utils = f.read()
with open('js/main.js', 'r') as f:
    main_js = f.read()

main_js = re.sub(r"^import\s+\{[^}]+\}\s+from\s+'[^']+';\s*\n", '', main_js, flags=re.MULTILINE)
main_js = re.sub(r'^export ', '', main_js, flags=re.MULTILINE)
dom_utils = dom_utils.replace('export ', '')
text_utils = text_utils.replace('export ', '')

css_link = re.search(r'<link\s+rel="stylesheet"\s+href="\./styles\.css[^"]*">', html).group()
html = html.replace(css_link, '<style>\n' + css + '\n</style>')

script_tag = re.search(r'<script\s+type="module"\s+src="\./js/main\.js[^"]*"></script>', html).group()
combined_js = '// == dom-utils ==\n' + dom_utils + '\n// == text-utils ==\n' + text_utils + '\n// == main ==\n' + main_js
html = html.replace(script_tag, '<script>\n' + combined_js + '\n</script>')

html = html.replace('<link rel="icon" href="favicon.ico" type="image/x-icon">\n', '')

with open('synapse.html', 'w') as f:
    f.write(html)

import os
print(f'synapse.html rebuilt ({os.path.getsize("synapse.html"):,} bytes)')
PYEOF
```

Include the regenerated `synapse.html` in the same commit as the source changes.