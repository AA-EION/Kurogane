import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Locator, type Page, type TestInfo, expect, test } from '@playwright/test';

/**
 * The same checks and captures on every platform and engine. Screenshots land
 * in e2e-screenshots/<os>-<engine>/ so CI artifacts can be compared side by side.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
const fixture = (name: string) => JSON.parse(readFileSync(path.join(here, '../src/graph/__fixtures__', name), 'utf8')).topology;
const demo = fixture('demo-topology.json');
const multi = fixture('multi-company.json');
/** Internet + companies + machines + services + standalone proxies. */
const nodeCount = (t: { tenants: unknown[]; hosts: unknown[]; services: unknown[]; proxies: { serviceId?: string | null }[] }) =>
  1 + t.tenants.length + t.hosts.length + t.services.length + t.proxies.filter((p) => !p.serviceId).length;

async function shot(page: Page, info: TestInfo, name: string) {
  const dir = path.join(here, '..', 'e2e-screenshots', `${OS}-${info.project.name}`);
  mkdirSync(dir, { recursive: true });
  await page.mouse.move(2, page.viewportSize()!.height - 2);
  await settle(page);
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file });
  await info.attach(name, { path: file, contentType: 'image/png' });
}

/** Wait until the camera stops moving (fit and focus animate, and may start a frame late). */
async function settle(page: Page) {
  let last = '';
  let stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    await page.waitForTimeout(150);
    const now = (await page.locator('.react-flow__viewport').getAttribute('style')) ?? '';
    stable = now && now === last ? stable + 1 : 0;
    last = now;
  }
}
const zoom = async (page: Page) => parseInt((await page.locator('.g-zoom-readout').textContent()) ?? '0', 10);

async function open(page: Page, which: '1' | 'multi', theme: 'light' | 'dark' = 'light') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // The packaged app runs with Tauri's freezePrototype; reproduce it so prototype-assignment bugs fail here too.
  await page.addInitScript(() => Object.freeze(Object.prototype));
  await page.addInitScript((t) => localStorage.setItem('kurogane.appearance', t), theme);
  await page.goto(`/?demo=${which}`);
  await expect(page.locator('[data-node]').first()).toBeVisible();
  await settle(page);
  return errors;
}

const node = (page: Page, label: string) => page.locator(`.react-flow__node[aria-label^="${label}"]`);
const drawerTitle = (page: Page) => page.locator('.drawer h2');

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b, 'element has a box').not.toBeNull();
  return b!;
}

async function download(page: Page, button: string): Promise<Buffer> {
  const pending = page.waitForEvent('download');
  await page.locator('button', { hasText: button }).click();
  return readFileSync((await (await pending).path())!);
}

test.describe('single-company vault', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`renders every record (${theme})`, async ({ page }, info) => {
      const errors = await open(page, '1', theme);
      await expect(page.locator('[data-node]')).toHaveCount(nodeCount(demo));
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await shot(page, info, `01-overview-${theme}`);
      expect(errors).toEqual([]);
    });
  }

  test('selecting a service traces its route beside the inspector', async ({ page }, info) => {
    await open(page, '1');
    await node(page, 'Service gitea').click();
    await expect(drawerTitle(page)).toHaveText('gitea');
    await settle(page);
    await expect.poll(() => page.locator('.react-flow__edge.is-lit').count()).toBeGreaterThanOrEqual(2);
    await expect.poll(() => page.locator('.react-flow__node.is-dim').count()).toBeGreaterThan(0);
    const drawer = await box(page.locator('.drawer'));
    const chip = await box(node(page, 'Service gitea'));
    expect(chip.x + chip.width, 'selected node is not under the inspector').toBeLessThanOrEqual(drawer.x);
    const pane = await box(page.locator('.react-flow'));
    const labels = page.locator('.g-edge-label');
    await expect(labels).not.toHaveCount(0);
    for (const label of await labels.all()) {
      const b = await box(label);
      expect(b.x, 'label inside the map').toBeGreaterThanOrEqual(pane.x - 1);
      expect(b.x + b.width, 'label clear of the inspector').toBeLessThanOrEqual(drawer.x + 1);
    }
    await shot(page, info, '02-service-trace');
  });

  test('search focuses a record and Escape clears the selection', async ({ page }, info) => {
    await open(page, '1');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('jellyfin');
    await page.keyboard.press('Enter');
    await expect(drawerTitle(page)).toHaveText('jellyfin');
    await expect.poll(() => zoom(page), { message: 'leaves are focused at 100%' }).toBeGreaterThanOrEqual(99);
    await shot(page, info, '03-search-focus');
    await page.keyboard.press('Escape');
    await expect(page.locator('.drawer')).toHaveCount(0);
    await expect(page.locator('.react-flow__node.is-dim')).toHaveCount(0);
  });

  test('keyboard focus and Enter select a node', async ({ page }) => {
    await open(page, '1');
    await node(page, 'Machine app-01').focus();
    await page.keyboard.press('Enter');
    await expect(drawerTitle(page)).toHaveText('app-01');
  });

  test('badges are never cut in half', async ({ page }) => {
    await open(page, '1');
    await page.locator('.sidebar .tree-row', { hasText: 'gitea' }).first().locator('.tree-main').click();
    await settle(page);
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.g-badges')].flatMap((row) => {
        const r = row.getBoundingClientRect();
        return [...row.querySelectorAll<HTMLElement>('.g-badge')]
          .map((b) => b.getBoundingClientRect())
          .filter((b) => b.top < r.bottom - 1 && (b.left < r.left - 1 || b.right > r.right + 1))
          .map((b) => `${row.textContent}: ${Math.round(b.left)}–${Math.round(b.right)} in ${Math.round(r.left)}–${Math.round(r.right)}`);
      }),
    );
    expect(clipped).toEqual([]);
  });

  test('whole-graph PNG and SVG export', async ({ page }) => {
    await open(page, '1');
    await page.locator('button[title="Settings"]').click();
    await page.locator('.settings-nav button', { hasText: 'Import & export' }).click();
    const png = await download(page, 'PNG image');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width, 'export covers the whole graph, not the viewport').toBeGreaterThan(1440);
    expect(height).toBeGreaterThan(900);
    const svg = (await download(page, 'SVG (vector)')).toString();
    expect(svg).toContain('<svg');
    expect(svg).toContain('gitea');
    expect(svg).not.toContain('Tama-hagane');
  });

  test('compact window keeps the selection visible', async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    await open(page, '1');
    await page.locator('.sidebar .tree-row', { hasText: 'gitea' }).first().locator('.tree-main').click();
    await expect(drawerTitle(page)).toHaveText('gitea');
    await settle(page);
    const drawer = await box(page.locator('.drawer'));
    const chip = await box(node(page, 'Service gitea'));
    expect(chip.x + chip.width).toBeLessThanOrEqual(drawer.x);
    await shot(page, info, '04-compact-1024');
  });
});

test.describe('multi-company vault', () => {
  test('renders five companies with cross-company services', async ({ page }, info) => {
    const errors = await open(page, 'multi');
    await expect(page.locator('[data-node]')).toHaveCount(nodeCount(multi));
    await expect(page.locator('.g-chip.is-owned')).toHaveCount(5);
    await shot(page, info, '05-multi-overview');
    expect(errors).toEqual([]);
  });

  test('company filter keeps only what the company depends on', async ({ page }, info) => {
    await open(page, 'multi');
    await page.locator('.g-filter select').selectOption({ label: 'Northwind Logistics' });
    await settle(page);
    await expect(node(page, 'Service tracking-api')).toHaveCount(1);
    await expect(node(page, 'Service license-server')).toHaveCount(1);
    await expect(node(page, 'Service pms')).toHaveCount(0);
    await expect(node(page, 'Company Kestrel Legal')).toHaveCount(0);
    await expect(page.locator('.g-company.is-context')).toHaveCount(1);
    await expect(page.locator('.g-company.is-context .g-company-sub')).toHaveText('Context · 2 of 4 machines');
    await expect(page.locator('.side-scope')).toContainText('Northwind Logistics');
    await shot(page, info, '06-filter-northwind');

    await node(page, 'Service tracking-api').click();
    await expect(drawerTitle(page)).toHaveText('tracking-api');
    await expect(page.locator('.react-flow__edge.is-lit')).toHaveCount(2);
    await shot(page, info, '07-filter-guest-trace');

    // Jumping to a record outside the slice shows every company again.
    await page.keyboard.press('Control+k');
    await page.keyboard.type('kestrel-fw');
    await page.keyboard.press('Enter');
    await expect(drawerTitle(page)).toHaveText('kestrel-fw');
    await expect(page.locator('.g-filter select')).toHaveValue('');
  });

  test('filter from the company inspector (dark)', async ({ page }, info) => {
    await open(page, 'multi', 'dark');
    await page.locator('.sidebar .tree-row.tenant', { hasText: 'Bluefin Dental' }).locator('.tree-main').click();
    await page.locator('.scope-btn').click();
    await settle(page);
    await expect(page.locator('.g-filter select')).not.toHaveValue('');
    await expect(node(page, 'Service patient-forms')).toHaveCount(1);
    await shot(page, info, '08-filter-from-inspector-dark');
  });
});
