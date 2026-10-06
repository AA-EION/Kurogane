// Audit exact locked packages, including optional/platform and build dependencies.
// Registry archives are verified against their lockfile integrity before reading.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (data, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(data).digest(encoding);
const cargoBytes = await fs.readFile(path.join(root, 'Cargo.lock'));
const npmBytes = await fs.readFile(path.join(root, 'ui/package-lock.json'));
const string = (block, key) => block.match(new RegExp(`^${key} = "([^"\\n]+)"`, 'm'))?.[1];
const cargo = cargoBytes.toString().split('[[package]]').slice(1).map(block => ({
  ecosystem: 'cargo', name: string(block, 'name'), version: string(block, 'version'),
  source: string(block, 'source'), integrity: string(block, 'checksum'),
})).filter(p => p.source);
const npm = Object.entries(JSON.parse(npmBytes).packages).filter(([key]) => key).map(([key, p]) => ({
  ecosystem: 'npm', name: key.split('node_modules/').at(-1), version: p.version,
  source: p.resolved, integrity: p.integrity, declaredLicense: p.license,
  development: Boolean(p.dev), optional: Boolean(p.optional), platforms: p.os ?? [], architectures: p.cpu ?? [],
}));
const fingerprint = { cargoLockSha256: hash(cargoBytes), npmLockSha256: hash(npmBytes) };
const inventoryPath = path.join(root, 'docs/legal/dependency-inventory.json');

if (process.argv.includes('--check')) {
  const inventory = JSON.parse(await fs.readFile(inventoryPath, 'utf8'));
  for (const key of Object.keys(fingerprint)) if (fingerprint[key] !== inventory[key]) throw Error(`${key}: dependency license inventory is stale; rerun the audit and review changes`);
  if (inventory.packages.length !== cargo.length + npm.length) throw Error('Incomplete package inventory');
  const decisions = JSON.parse(await fs.readFile(path.join(root, 'docs/legal/license-decisions.json'), 'utf8'));
  for (const p of inventory.packages) {
    if (!p.archiveVerified || !p.license || !p.notices.length) throw Error(`Unverified license/notice: ${p.ecosystem}:${p.name}@${p.version}`);
    if (!decisions.expressions[p.license]) throw Error(`Unreviewed license expression: ${p.license} (${p.name})`);
  }
  const notice = await fs.readFile(path.join(root, 'THIRD_PARTY_LICENSES.txt'));
  if (hash(notice) !== inventory.noticesSha256) throw Error('Generated third-party notices have changed; rerun the audit');
  console.log(`License inventory current: ${cargo.length} registry crates and ${npm.length} npm packages; all expressions reviewed and notice bundle verified.`);
  process.exit(0);
}
if (process.argv.includes('--count')) {
  console.log(JSON.stringify({ cargo: cargo.length, npm: npm.length, npmExpressions: [...new Set(npm.map(p => p.declaredLicense))] }, null, 2));
  process.exit(0);
}
const cache = path.join(root, '.license-cache');
await fs.mkdir(cache, { recursive: true });
await fs.mkdir(path.dirname(inventoryPath), { recursive: true });
const decoder = new TextDecoder();
function untar(bytes) {
  const files = new Map();
  let longName;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    const text = (start, count) => decoder.decode(header.subarray(start, start + count)).replace(/\0.*$/s, '');
    let name = text(0, 100);
    if (!name) break;
    const prefix = text(345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(text(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > bytes.length) throw Error('Invalid archive entry');
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    const type = text(156, 1);
    if (type === 'L') longName = decoder.decode(data).replace(/\0.*$/s, '');
    else if (type === '0' || type === '') { files.set(longName ?? name, data); longName = undefined; }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
async function archive(p) {
  if (!p.integrity) throw Error(`Missing lock integrity: ${p.name}`);
  const url = p.ecosystem === 'cargo' ? `https://static.crates.io/crates/${p.name}/${p.name}-${p.version}.crate` : p.source;
  if (!url?.startsWith('https://')) throw Error(`Unreviewed dependency source: ${p.name}: ${url}`);
  const filename = path.join(cache, `${p.ecosystem}-${p.name.replaceAll('/', '_')}-${p.version}.tgz`);
  let bytes;
  try { bytes = await fs.readFile(filename); } catch {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
        if (!response.ok) throw Error(`HTTP ${response.status} ${url}`);
        bytes = Buffer.from(await response.arrayBuffer()); break;
      } catch (error) { if (attempt === 2) throw error; }
    }
  }
  const verify = bytes => p.ecosystem === 'cargo' ? hash(bytes) === p.integrity : p.integrity.split(/\s+/).some(sri => {
    const separator = sri.indexOf('-');
    return hash(bytes, sri.slice(0, separator), 'base64') === sri.slice(separator + 1);
  });
  if (!verify(bytes)) {
    // Retry transport corruption, still requiring the original lock digest.
    const response = await fetch(url, { signal: AbortSignal.timeout(90000), cache: 'reload' });
    if (!response.ok) throw Error(`HTTP ${response.status} ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (!verify(bytes)) throw Error(`Archive integrity mismatch: ${p.name}@${p.version}`);
  await fs.writeFile(filename, bytes);
  return { files: untar(gunzipSync(bytes)), url };
}
const texts = new Map();
const remoteCache = new Map();
async function remote(url, json = false) {
  if (!remoteCache.has(url)) remoteCache.set(url, (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
    if (!response.ok) throw Error(`HTTP ${response.status}: ${url}`);
    return json ? response.json() : response.text();
  })());
  return remoteCache.get(url);
}
let done = 0;
async function audit(p) {
  if (p.ecosystem === 'cargo' && !p.source.startsWith('registry+')) throw Error(`Nonregistry source needs separate audit: ${p.source}`);
  const { files, url } = await archive(p);
  const manifestPath = `${p.ecosystem === 'cargo' ? `${p.name}-${p.version}` : 'package'}/${p.ecosystem === 'cargo' ? 'Cargo.toml' : 'package.json'}`;
  // DefinitelyTyped archives use their package name as the top directory.
  const manifestName = p.ecosystem === 'cargo' ? 'Cargo.toml' : 'package.json';
  const manifestData = files.get(manifestPath) ?? [...files].filter(([name]) => path.posix.basename(name) === manifestName).sort(([a], [b]) => a.split('/').length - b.split('/').length)[0]?.[1];
  if (!manifestData) throw Error('Registry archive has no package manifest');
  const manifest = decoder.decode(manifestData);
  const meta = p.ecosystem === 'npm' ? JSON.parse(manifest) : undefined;
  const license = p.ecosystem === 'cargo' ? string(manifest, 'license') : (typeof meta.license === 'string' ? meta.license : meta.license?.type);
  const licenseFile = p.ecosystem === 'cargo' ? string(manifest, 'license-file') : undefined;
  const repository = p.ecosystem === 'cargo' ? string(manifest, 'repository') : (typeof meta.repository === 'string' ? meta.repository : meta.repository?.url);
  const vcsData = [...files].find(([name]) => name.endsWith('/.cargo_vcs_info.json'))?.[1];
  const vcs = vcsData ? JSON.parse(decoder.decode(vcsData)) : undefined;
  const notices = [];
  for (const [filename, data] of files) {
    const relative = filename.split('/').slice(1).join('/');
    const basename = path.posix.basename(filename);
    if (!/^(licen[cs]e|copying|copyright|notice|authors)([.\-_]|$)/i.test(basename) && relative !== licenseFile) continue;
    if (data.includes(0) || data.length > 2_000_000 || /\.(png|jpg|pdf|rs|c|h|js|ts)$/i.test(basename)) continue;
    const content = decoder.decode(data);
    if (!content.trim()) continue;
    const sha256 = hash(data);
    texts.set(sha256, content);
    notices.push({ path: relative, sha256 });
  }
  const secondaryLicenseExclusions = license === 'MPL-2.0' ? [...files].filter(([name, data]) => /\.(rs|c|h|js|ts)$/.test(name) && /This Source Code Form is ["“]?Incompatible With Secondary Licenses/i.test(decoder.decode(data))).map(([name]) => name) : [];
  if (!notices.length && license === 'MPL-2.0') {
    for (const [name, data] of files) {
      if (!/\/lib\.rs$/.test(name)) continue;
      const header = decoder.decode(data).match(/^\/\*[\s\S]*?\*\//)?.[0];
      if (!header?.includes('Mozilla Public')) continue;
      const sha256 = hash(header); texts.set(sha256, header);
      notices.push({ path: `${name.split('/').slice(1).join('/')} (original license header)`, sha256 });
    }
  }
  if (!notices.length && p.ecosystem === 'cargo' && vcs?.git?.sha1 && repository?.startsWith('https://github.com/')) {
    const repo = repository.slice('https://github.com/'.length).replace(/\.git$/, '').split('/').slice(0, 2).join('/');
    const tree = await remote(`https://api.github.com/repos/${repo}/git/trees/${vcs.git.sha1}?recursive=1`, true);
    const parents = [''];
    let directory = vcs.path_in_vcs ?? '';
    while (directory && directory !== '.') { parents.push(directory); directory = path.posix.dirname(directory); }
    for (const entry of tree.tree ?? []) {
      if (entry.type !== 'blob' || !parents.includes(path.posix.dirname(entry.path) === '.' ? '' : path.posix.dirname(entry.path))) continue;
      if (!/^(licen[cs]e|copying|copyright|notice)([.\-_]|$)/i.test(path.posix.basename(entry.path))) continue;
      const source = `https://raw.githubusercontent.com/${repo}/${vcs.git.sha1}/${entry.path}`;
      const content = await remote(source);
      const sha256 = hash(content); texts.set(sha256, content);
      notices.push({ path: entry.path, sha256, source, sourceCommit: vcs.git.sha1 });
    }
  }
  done++;
  if (done % 50 === 0) console.log(`Audited ${done}/${cargo.length + npm.length} locked packages`);
  return { ...p, license: license ?? (licenseFile ? `LicenseRef-${p.name}` : null), licenseFile, repository, sourceCommit: vcs?.git?.sha1, secondaryLicenseExclusions, archiveUrl: url, archiveVerified: true, notices };
}
const pending = [...cargo, ...npm];
const results = [];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (pending.length) {
    const p = pending.shift();
    try { results.push(await audit(p)); } catch (error) { throw Error(`${p.ecosystem}:${p.name}@${p.version}: ${error.message}`); }
  }
}));
// Some platform/tool packages omit notices while their common source package
// carries them. Use exact locked siblings, recording the provenance explicitly.
for (const p of results.filter(p => !p.notices.length)) {
  const siblingName = p.name.startsWith('@rolldown/binding-') ? 'rolldown'
    : p.name.startsWith('@tauri-apps/cli-') ? '@tauri-apps/cli'
    : p.name.startsWith('winapi-') ? 'winapi'
    : p.name === 'libappindicator-sys' ? 'libappindicator' : undefined;
  const sibling = results.find(s => s.ecosystem === p.ecosystem && s.name === siblingName && (p.ecosystem !== 'npm' || s.version === p.version));
  if (sibling?.notices.length) p.notices = sibling.notices.map(n => ({ ...n, suppliedBy: `${sibling.ecosystem}:${sibling.name}@${sibling.version}`, source: n.source ?? sibling.archiveUrl }));
  // Stylo's license body lives below the repository's license directory.
  if (p.name === 'selectors') {
    const tree = await remote(`https://api.github.com/repos/servo/stylo/git/trees/${p.sourceCommit}?recursive=1`, true);
    for (const entry of tree.tree ?? []) {
      if (entry.type !== 'blob' || !/^license[s]?\//i.test(entry.path) || !/mpl/i.test(entry.path)) continue;
      const source = `https://raw.githubusercontent.com/servo/stylo/${p.sourceCommit}/${entry.path}`;
      const content = await remote(source), sha256 = hash(content); texts.set(sha256, content);
      p.notices.push({ path: entry.path, sha256, source, sourceCommit: p.sourceCommit });
    }
  }
}
results.sort((a, b) => `${a.ecosystem}:${a.name}@${a.version}`.localeCompare(`${b.ecosystem}:${b.name}@${b.version}`));
const lines = ['KUROGANE THIRD-PARTY LICENSE AND COPYRIGHT TEXTS', '',
  'Generated from integrity-verified Cargo.lock and ui/package-lock.json registry archives.',
  'Includes the full locked closure: runtime, build, development and optional/platform packages.',
  'Upstream notices retain their original terms; Kurogane does not relicense third-party code.', '',
  ...results.flatMap(p => [ `${p.ecosystem}:${p.name}@${p.version} — ${p.license ?? 'UNDECLARED'}`, `Source: ${p.archiveUrl}`,
    ...p.notices.map(n => `Notice ${n.sha256}: ${n.path}`), '' ]),
  ...[...texts].sort(([a], [b]) => a.localeCompare(b)).flatMap(([digest, content]) => [`========== NOTICE ${digest} ==========`, content, ''])];
const output = lines.join('\n');
await fs.writeFile(path.join(root, 'THIRD_PARTY_LICENSES.txt'), output);
const inventory = { schemaVersion: 1, ...fingerprint, noticesSha256: hash(output), packages: results };
await fs.writeFile(inventoryPath, JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify({ cargo: cargo.length, npm: npm.length, expressions: [...new Set(results.map(p => p.license))].sort(),
  missingNotices: results.filter(p => !p.notices.length).map(p => `${p.ecosystem}:${p.name}@${p.version}`), noticeBytes: Buffer.byteLength(output) }, null, 2));
