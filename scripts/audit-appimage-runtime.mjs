// Manual audit for the runtime observed in the Linux installer evidence.
// On upgrade, verify the upstream build log and update these exact versions.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const sources = [
  ['type2-runtime-8f39b89.tar.gz', 'https://codeload.github.com/AppImage/type2-runtime/tar.gz/8f39b89e2ac31e1640b3d3f7e9a5108e6ce805fa', 'MIT'],
  ['fuse-3.15.0.tar.xz', 'https://github.com/libfuse/libfuse/releases/download/fuse-3.15.0/fuse-3.15.0.tar.xz', 'LGPL-2.1-or-later'],
  ['squashfuse-0.5.2.tar.gz', 'https://github.com/vasi/squashfuse/archive/0.5.2.tar.gz', 'BSD-2-Clause'],
  ['musl-1.2.5.tar.gz', 'https://musl.libc.org/releases/musl-1.2.5.tar.gz', 'MIT and embedded permissive notices'],
  ['zstd-1.5.6.tar.gz', 'https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-1.5.6.tar.gz', 'BSD-3-Clause (selected alternative)'],
  ['zlib-1.3.2.tar.gz', 'https://zlib.net/fossils/zlib-1.3.2.tar.gz', 'Zlib'],
  ['mimalloc-2.1.7.tar.gz', 'https://codeload.github.com/microsoft/mimalloc/tar.gz/refs/tags/v2.1.7', 'MIT'],
];
await fs.mkdir('.license-cache/runtime', { recursive: true });
const records = [];
let notices = (await fs.readFile('docs/legal/appimage-NOTICES.txt', 'utf8')).split('\nEmbedded runtime component:')[0];
for (const [file, url, license] of sources) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (file.startsWith('fuse-') && sha256 !== '70589cfd5e1cff7ccd6ac91c86c01be340b227285c5e200baa284e401eea2ca0') throw Error('Fuse upstream checksum mismatch');
  if (file.startsWith('squashfuse-') && sha256 !== 'db0238c5981dabbd80ee09ae15387f390091668ca060a7bc38047912491443d3') throw Error('Squashfuse upstream checksum mismatch');
  const archive = '.license-cache/runtime/' + file;
  await fs.writeFile(archive, bytes);
  const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).split(/\r?\n/).filter(p => !p.endsWith('/') && /^(licen[cs]e|copying|copyright|notice|authors|lgpl2)(\.|$|-)/i.test(p.split('/').at(-1)) && p.split('/').length <= 3);
  for (const entry of entries) {
    const original = execFileSync('tar', ['-xOf', archive, entry], { encoding: 'utf8', maxBuffer: 2000000 });
    notices += `\nEmbedded runtime component: ${file}\nSource: ${url}\nOriginal file: ${entry}\n\n${original}\n`;
  }
  if (!entries.length && file.startsWith('zlib')) {
    const header = execFileSync('tar', ['-xOf', archive, 'zlib-1.3.2/zlib.h'], { encoding: 'utf8' });
    const original = header.slice(0, header.indexOf('*/') + 2);
    notices += `\nEmbedded runtime component: ${file}\nSource: ${url}\nOriginal file: zlib.h copyright/license header\n\n${original}\n`;
    entries.push('zlib.h copyright/license header');
  }
  if (!entries.length) throw Error('Missing runtime component notice: ' + file);
  records.push({ file, url, sha256, license, noticeFiles: entries });
  console.log(`${file}: ${entries.length} original notices`);
}
notices = notices.trimEnd() + '\n';
await fs.writeFile('docs/legal/appimage-NOTICES.txt', notices);
await fs.writeFile('docs/legal/appimage-source-inventory.json', JSON.stringify({
  runtimeCommit: '8f39b89e2ac31e1640b3d3f7e9a5108e6ce805fa',
  buildEvidence: 'https://github.com/AppImage/type2-runtime/actions/runs/36463736478',
  runtimeVersion: 'AppImage runtime version: https://github.com/AppImage/type2-runtime/commit/8f39b89',
  noticesSha256: crypto.createHash('sha256').update(notices.replaceAll('\r\n', '\n')).digest('hex'),
  sources: records,
}, null, 2) + '\n');
