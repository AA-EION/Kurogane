import { defineConfig, devices, type Project } from '@playwright/test';

/**
 * End-to-end and visual checks of the React interface against the in-memory
 * development backend (`?demo=1`, `?demo=multi`).
 *
 * KG_E2E_ENGINES picks the browser engines (comma-separated). CI runs every
 * operating system with Chromium plus the engine behind that platform's
 * desktop webview: WebKit for WKWebView (macOS) and WebKitGTK (Linux), and
 * Microsoft Edge for WebView2 (Windows).
 */
const viewport = { width: 1440, height: 900 };
const engines = (process.env.KG_E2E_ENGINES ?? 'chromium').split(',').map((e) => e.trim()).filter(Boolean);
const chromiumPath = process.env.KG_CHROMIUM_PATH;
const project = (name: string): Project => {
  switch (name) {
    case 'webkit':
      return { name, use: { ...devices['Desktop Safari'], viewport, deviceScaleFactor: 1 } };
    case 'msedge':
      return { name, use: { ...devices['Desktop Edge'], channel: 'msedge', viewport, deviceScaleFactor: 1 } };
    case 'chromium':
      return { name, use: { ...devices['Desktop Chrome'], viewport, deviceScaleFactor: 1, ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}) } };
    default:
      throw new Error(`Unknown engine ${name}`);
  }
};

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { outputFolder: 'e2e-report', open: 'never' }]],
  outputDir: 'e2e-results',
  use: { baseURL: 'http://127.0.0.1:1420', acceptDownloads: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev', url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI, timeout: 120_000 },
  projects: engines.map(project),
});
