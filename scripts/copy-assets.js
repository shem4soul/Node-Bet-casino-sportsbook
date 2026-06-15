// Copies non-TS assets into dist/ after `tsc` (OpenAPI spec).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const assets = [['src/docs/openapi.yaml', 'dist/docs/openapi.yaml']];

for (const [from, to] of assets) {
  const src = path.join(root, from);
  const dest = path.join(root, to);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`copied ${from} -> ${to}`);
}
