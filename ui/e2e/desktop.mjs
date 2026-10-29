// Drives the real desktop app (Rust core, encrypted vault, platform webview)
// through the same scenario on Linux and Windows, and saves screenshots.
//
//   node e2e/desktop.mjs --app <binary> --vault <file> --password-env <VAR>
//                        --topology <unlock --json output> --out <dir> [--native-driver <path>]
//
// Both platforms use tauri-driver: WebKitWebDriver on Linux (WebKitGTK) and
// Microsoft Edge WebDriver on Windows (WebView2, pass --native-driver).
// macOS runs the equivalent scenario in the SwiftUI harness (src-tauri/tests/NativePreview.swift).

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, v, i, all) => (v.startsWith('--') ? [...pairs, [v.slice(2), all[i + 1]]] : pairs), []));
for (const key of ['app', 'vault', 'password-env', 'topology', 'out']) if (!args[key]) throw new Error(`missing --${key}`);
const password = process.env[args['password-env']];
if (!password) throw new Error(`${args['password-env']} is not set`);
const topo = JSON.parse(readFileSync(args.topology, 'utf8'));
const expectedNodes = 1 + topo.tenants.length + topo.hosts.length + topo.services.length + topo.proxies.filter((p) => !p.serviceId).length;
mkdirSync(args.out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[desktop-e2e]', ...a);
const children = [];

// ------------------------------------------------------------------ drivers

async function webdriver() {
  const driver = spawn('tauri-driver', args['native-driver'] ? ['--native-driver', path.resolve(args['native-driver'])] : [], { stdio: 'inherit' });
  children.push(driver);
  const base = 'http://127.0.0.1:4444';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${url}: ${JSON.stringify(json.value ?? json).slice(0, 400)}`);
    return json.value;
  };
  for (let i = 0; ; i++) {
    try { await call('GET', '/status'); break; } catch (e) { if (i > 60) throw e; await sleep(500); }
  }
  const session = await call('POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: path.resolve(args.app), args: [path.resolve(args.vault)] } } },
  });
  const id = session.sessionId;
  await call('POST', `/session/${id}/window/rect`, { width: 1440, height: 900 }).catch((e) => log('window resize skipped:', e.message));
  return {
    exec: (fn, ...a) => call('POST', `/session/${id}/execute/sync`, { script: `return (${fn})(...arguments)`, args: a }),
    screenshot: async (file) => writeFileSync(file, Buffer.from(await call('GET', `/session/${id}/screenshot`), 'base64')),
    close: () => call('DELETE', `/session/${id}`).catch(() => undefined),
  };
}

// ------------------------------------------------------------------ scenario

async function until(d, what, fn, ...a) {
  for (let i = 0; i < 120; i++) {
    const v = await d.exec(fn, ...a).catch(() => undefined);
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Camera has stopped moving. */
async function settle(d) {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const now = await d.exec(() => document.querySelector('.react-flow__viewport')?.getAttribute('style') ?? '');
    if (now && now === last) return;
    last = now;
    await sleep(200);
  }
}

const results = [];
const scriptErrors = [];
const armErrors = (d) => d.exec(() => { window.__kgErrors = []; window.addEventListener('error', (e) => window.__kgErrors.push(String(e.message))); });
const collectErrors = async (d) => scriptErrors.push(...((await d.exec(() => window.__kgErrors ?? []).catch(() => [])) ?? []));
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    log('✓', name);
  } catch (e) {
    results.push({ name, ok: false, error: String(e) });
    log('✗', name, e);
  }
}

async function shot(d, name) {
  await settle(d);
  await d.screenshot(path.join(args.out, `${name}.png`));
}

const d = await webdriver();
try {
  await step('opens the vault at the lock screen', () => until(d, 'lock screen', () => !!document.querySelector('input[type=password]')));
  await d.screenshot(path.join(args.out, '00-lock-screen.png')).catch(() => undefined);

  await step('unlocks with the master password', async () => {
    await armErrors(d);
    await d.exec((pw) => {
      const input = document.querySelector('input[type=password]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, pw);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.form.requestSubmit();
    }, password);
    await until(d, 'graph', () => document.querySelectorAll('[data-node]').length > 0);
  });

  await step(`draws every record (${expectedNodes} nodes)`, async () => {
    const count = await until(d, 'all nodes', (n) => { const c = document.querySelectorAll('[data-node]').length; return c >= n && c; }, expectedNodes);
    if (count !== expectedNodes) throw new Error(`expected ${expectedNodes} nodes, found ${count}`);
    await shot(d, '01-overview-light');
  });

  await step('selecting a service lights its trace and opens the inspector', async () => {
    await d.exec(() => document.querySelector('.react-flow__node[aria-label^="Service gitea"]').click());
    await until(d, 'inspector', () => document.querySelector('.drawer h2')?.textContent === 'gitea');
    await until(d, 'a lit trace (2+ edges)', () => document.querySelectorAll('.react-flow__edge.is-lit').length >= 2);
    await shot(d, '02-service-trace');
  });

  await step('Escape clears the selection', async () => {
    await d.exec(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await until(d, 'no inspector', () => !document.querySelector('.drawer'));
  });

  await step('company filter narrows the map', async () => {
    const before = await d.exec(() => document.querySelectorAll('[data-node]').length);
    await d.exec(() => {
      const select = document.querySelector('.g-filter select');
      const option = [...select.options].find((o) => o.text === 'Client Alpha');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(d, 'filtered graph', (n) => document.querySelectorAll('[data-node]').length < n, before);
    await shot(d, '03-filter-client-alpha');
    await d.exec(() => document.querySelector('.g-filter-clear').click());
    await until(d, 'unfiltered graph', (n) => document.querySelectorAll('[data-node]').length === n, before);
  });

  await step('dark appearance', async () => {
    await collectErrors(d);
    await d.exec(() => { localStorage.setItem('kurogane.appearance', 'dark'); location.reload(); });
    await sleep(1000);
    await until(d, 'reloaded page', () => !!document.querySelector('#root'));
    await armErrors(d);
    await until(d, 'graph after reload', (n) => document.documentElement.dataset.theme === 'dark' && document.querySelectorAll('[data-node]').length === n, expectedNodes);
    await shot(d, '04-overview-dark');
    await d.exec(() => document.querySelector('.react-flow__node[aria-label^="Service gitea"]').click());
    await until(d, 'inspector', () => document.querySelector('.drawer h2')?.textContent === 'gitea');
    await shot(d, '05-service-trace-dark');
    await d.exec(() => localStorage.setItem('kurogane.appearance', 'light'));
  });

  await step('no script errors', async () => {
    await collectErrors(d);
    if (scriptErrors.length) throw new Error(scriptErrors.join('\n'));
  });
} finally {
  await d.close();
  for (const c of children) c.kill();
  writeFileSync(path.join(args.out, 'results.json'), JSON.stringify(results, null, 2));
}
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
