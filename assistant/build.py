"""Stamp one release and rebuild the standalone, including its embedded sprites."""

import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import re


root = Path(__file__).resolve().parent
now = datetime.now(timezone.utc).replace(microsecond=0)
stamp = now.strftime('%Y%m%d%H%M%S')
build_date = now.isoformat().replace('+00:00', 'Z')

html = (root / 'index.html').read_text(encoding='utf-8')
main = (root / 'js/main.js').read_text(encoding='utf-8')
worker = (root / 'sw.js').read_text(encoding='utf-8')
metadata = json.loads((root / 'version.json').read_text(encoding='utf-8'))

# One command updates every release marker, including imported module URLs.
html = re.sub(r'(\./(?:styles\.css|js/main\.js)\?v=)\d+', rf'\g<1>{stamp}', html)
main = re.sub(r"(buildDate: ')[^']+", rf'\g<1>{build_date}', main, count=1)
main = re.sub(r'(\./lib/[\w-]+\.js\?v=)\d+', rf'\g<1>{stamp}', main)
worker = re.sub(r"(const CACHE_VERSION = 'synapse-)\d+", rf'\g<1>{stamp}', worker)
worker = re.sub(r'(\?v=)\d+', rf'\g<1>{stamp}', worker)
metadata['buildDate'] = build_date

css = (root / 'styles.css').read_text(encoding='utf-8')
modules = []
for name in ['dom-utils', 'text-utils']:
    source = (root / f'js/lib/{name}.js').read_text(encoding='utf-8')
    modules.append(f'// == {name} ==\n' + re.sub(r'^export ', '', source, flags=re.M))
standalone_main = re.sub(r'^import .*\n', '', main, flags=re.M)
standalone_main = re.sub(r'^export ', '', standalone_main, flags=re.M)
sprites = {
    path.stem: 'data:image/webp;base64,' + base64.b64encode(path.read_bytes()).decode('ascii')
    for path in sorted((root / 'assets/emotion-sprites').glob('*.webp'))
}
standalone_main = standalone_main.replace(
    'const EMOTION_SPRITE_ASSET_URLS = {};',
    'const EMOTION_SPRITE_ASSET_URLS = ' + json.dumps(sprites, separators=(',', ':')) + ';'
)
modules.append('// == main ==\n' + standalone_main)
standalone = re.sub(r'<link rel="stylesheet" href="\./styles\.css[^\"]*">',
                    lambda _: '<style>\n' + css + '\n</style>', html)
standalone = re.sub(r'<script type="module" src="\./js/main\.js[^\"]*"></script>',
                    lambda _: '<script>\n' + '\n'.join(modules) + '\n</script>', standalone)
standalone = standalone.replace('<link rel="icon" href="favicon.ico" type="image/x-icon">\n', '')

for name, content in [('index.html', html), ('js/main.js', main), ('sw.js', worker),
                      ('version.json', json.dumps(metadata, indent=2) + '\n'), ('synapse.html', standalone)]:
    (root / name).write_text(content, encoding='utf-8')
print(f'Built {build_date} ({stamp}); embedded {len(sprites)} sprites')
