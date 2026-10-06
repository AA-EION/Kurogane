// Preserve the exact reviewed registry archives alongside installer artifacts.
// No package code is executed or installed by this script.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventory = JSON.parse(await fs.readFile(path.join(root, 'docs/legal/dependency-inventory.json')));
const output = path.join(root, 'dependency-source');
await fs.mkdir(output, { recursive: true });
let next = 0;
const manifest = [];
async function worker() {
  while (next < inventory.packages.length) {
    const p = inventory.packages[next++];
    const filename = `${p.ecosystem}-${p.name.replaceAll('/', '_')}-${p.version}.tgz`;
    const verify = bytes => {
      if (p.ecosystem === 'cargo') return crypto.createHash('sha256').update(bytes).digest('hex') === p.integrity;
      return p.integrity.split(/\s+/).some(sri => {
        const split = sri.indexOf('-');
        const algorithm = sri.slice(0, split);
        return ['sha256', 'sha384', 'sha512'].includes(algorithm)
          && crypto.createHash(algorithm).update(bytes).digest('base64') === sri.slice(split + 1);
      });
    };
    let bytes;
    try { bytes = await fs.readFile(path.join(root, '.license-cache', filename)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes) {
      if (!p.archiveUrl?.startsWith('https://')) throw Error(`Invalid source URL for ${filename}`);
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(p.archiveUrl, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw Error(`${response.status}: ${p.archiveUrl}`);
        bytes = Buffer.from(await response.arrayBuffer());
        if (verify(bytes)) break;
      }
    }
    if (!verify(bytes)) throw Error(`Source archive integrity mismatch: ${filename}`);
    await fs.writeFile(path.join(output, filename), bytes);
    manifest.push({ file: filename, url: p.archiveUrl, integrity: p.integrity, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
manifest.sort((a, b) => a.file.localeCompare(b.file));
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await fs.writeFile(path.join(output, 'README.txt'), 'Exact locked registry archives; hashes checked against the reviewed dependency inventory. Each .tgz is a gzip-compressed tar archive. Rust crates contain their original source and manifests; npm platform binary archives are also retained as distribution evidence. Project source, build instructions, lockfiles and complete notices accompany these archives in the per-platform source artifact. Do not discard upstream copyright/license files when unpacking.\n');
console.log(`Archived and verified ${manifest.length} locked packages.`);
