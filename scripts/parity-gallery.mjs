// Collects the screenshots of a parity.yml run into one page: one row per
// scenario, one column per platform and engine.
//
//   node scripts/parity-gallery.mjs <downloaded-artifacts-dir> <out-dir>

import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) throw new Error('usage: parity-gallery.mjs <captures> <out>');

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      // Playwright's report and failure traces are not presentation captures.
      if (!['e2e-report', 'e2e-results', 'parity-gallery'].includes(name)) walk(full);
    } else if (name.endsWith('.png')) files.push(full);
  }
};
walk(src);

/** Column label from the artifact layout: e2e-<os>/e2e-screenshots/<os>-<engine>, desktop-<os>/<os>, native-ui-review/<fixture>. */
const column = (file) => {
  const parts = path.relative(src, path.dirname(file)).split(path.sep);
  if (parts[0].startsWith('e2e-')) return `browser · ${parts.at(-1)}`;
  if (parts[0].startsWith('desktop-')) return `desktop app · ${parts[0].slice('desktop-'.length)}`;
  if (parts[0] === 'native-ui-review') return `macOS native · ${parts.at(-1) === 'native-ui-review' ? 'demo-topology' : parts.at(-1)}`;
  return parts.join('/');
};

const grid = new Map();
const columns = new Set();
for (const file of files) {
  const col = column(file);
  const row = path.basename(file, '.png');
  columns.add(col);
  if (!grid.has(row)) grid.set(row, new Map());
  const dest = path.join('img', col.replace(/[^\w.-]+/g, '_'), path.basename(file));
  mkdirSync(path.join(out, path.dirname(dest)), { recursive: true });
  copyFileSync(file, path.join(out, dest));
  grid.get(row).set(col, dest);
}

const cols = [...columns].sort();
const rows = [...grid.keys()].sort();
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kurogane platform parity</title>
<style>
  body { font: 13px/1.4 system-ui, sans-serif; margin: 16px; background: #eeece7; color: #20211f; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #d1cec6; padding: 6px; vertical-align: top; background: #fcfbf8; }
  th { position: sticky; top: 0; background: #e5e3dd; }
  td.name { font-family: ui-monospace, monospace; white-space: nowrap; }
  img { width: 360px; display: block; }
  .missing { color: #62635d; font-style: italic; }
</style>
<h1>Kurogane platform parity</h1>
<p>${files.length} captures · ${cols.length} platform/engine columns · ${rows.length} scenarios. Click an image for full size.</p>
<table>
  <tr><th>Scenario</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
  ${rows.map((r) => `<tr><td class="name">${esc(r)}</td>${cols.map((c) => {
    const img = grid.get(r).get(c);
    return img ? `<td><a href="${esc(img)}"><img src="${esc(img)}" alt="${esc(`${r} — ${c}`)}" loading="lazy"></a></td>` : '<td class="missing">—</td>';
  }).join('')}</tr>`).join('\n  ')}
</table>
`;
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'index.html'), html);
console.log(`gallery: ${files.length} captures in ${cols.length} columns → ${path.join(out, 'index.html')}`);
