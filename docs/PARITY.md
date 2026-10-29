# Platform parity tests

Kurogane ships the same React interface on three platforms, each inside a different webview: WebView2 (Chromium) on Windows, WebKitGTK on Linux, and WKWebView inside the SwiftUI shell on macOS. [`.github/workflows/parity.yml`](../.github/workflows/parity.yml) runs the same checks and screenshots on all three GitHub runners on every push and pull request.

| Job | Runners | What runs | Artifact |
|---|---|---|---|
| `browser` | ubuntu-24.04, macos-latest, windows-latest | `ui/e2e/topology.spec.ts` (Playwright) against the development backend, in Chromium and in each platform's webview engine: WebKit on Linux and macOS, Microsoft Edge on Windows | `e2e-<os>` (screenshots, HTML report, failure traces) |
| `desktop` | ubuntu-22.04, windows-latest | The release desktop app opens a real encrypted demo vault (`kurogane demo-vault`), is unlocked with its master password and is driven by `ui/e2e/desktop.mjs` through tauri-driver: WebKitWebDriver on Linux, Microsoft Edge WebDriver (matched to the WebView2 runtime) on Windows | `desktop-<os>` (screenshots, `results.json`) |
| `macos-native` | macos-latest | [`native.yml`](../.github/workflows/native.yml): the SwiftUI shell with the shared graph in WKWebView, for both the single- and multi-company fixtures, light, dark and compact, plus native editors and sheets | `native-ui-review` |
| `gallery` | ubuntu-latest | `scripts/parity-gallery.mjs` puts every capture side by side: one row per scenario, one column per platform and engine | `parity-gallery` (open `index.html`) |

`ci.yml` complements this with the Rust core tests and clippy, the UI typecheck, unit tests and build, and release builds of the desktop shell, all on the three operating systems. On macOS it also runs a smoke test of the native bridge against a real encrypted vault.

## What the scenarios check

Browser e2e, on every engine:

- Every record of the demo vault becomes a node (Internet + companies + machines + services + standalone proxies), in light and dark, with no console errors.
- Selecting a service lights its trace and dims the rest. The node stays clear of the inspector, and route labels stay inside the map and out from under the inspector.
- Search (Ctrl+K) focuses a record at 100% zoom, and Escape clears the selection.
- Keyboard focus plus Enter selects a node.
- Badges are never cut in half.
- PNG and SVG exports cover the whole graph and contain no secrets.
- In a 1024×640 window, the selection stays visible.
- Multi-company vault: five companies with cross-company services. The company filter keeps only what the chosen company depends on, labels other companies as context, traces a guest service, and clears itself when search jumps outside the slice. The filter can also be set from the company inspector.

Desktop app (Linux and Windows), against the real Rust core:

1. The app opens the vault at the lock screen.
2. It unlocks with the master password.
3. The graph draws every record of the vault.
4. Selecting a service lights its trace and opens the inspector, and Escape clears it.
5. The company filter narrows the map, and Show all restores it.
6. Dark appearance, overview and trace.
7. No script errors.

macOS native: the harness requires the same node count as the other platforms, then captures the workspace in light, dark and compact sizes, and every native editor and sheet.

## Running locally

```bash
cd ui
npx playwright install chromium webkit
KG_E2E_ENGINES=chromium,webkit npm run e2e      # screenshots in ui/e2e-screenshots/
```

To drive the real desktop app on Linux, install the Tauri Linux dependencies plus `webkit2gtk-driver`, then:

```bash
cargo install tauri-driver --locked
(cd ui && npm ci && npm run build)
cargo build -p kurogane-app --features custom-protocol --release
cargo build -p kurogane-cli --features demo-seed --release
export KUROGANE_HOME=/tmp/kg KUROGANE_PASSWORD=parity-demo-password KG_PARITY_PASSWORD=parity-demo-password
target/release/kurogane demo-vault /tmp/demo.kurogane
target/release/kurogane unlock /tmp/demo.kurogane --json > /tmp/topology.json
xvfb-run -a node ui/e2e/desktop.mjs --app target/release/kurogane-desktop --vault /tmp/demo.kurogane \
  --password-env KG_PARITY_PASSWORD --topology /tmp/topology.json --out desktop-screenshots/linux
```

`kurogane demo-vault` exists only in CLI builds with the `demo-seed` feature, and installers never include it. The vault and its password are throwaway test values.

## Limits

- The browser job runs Playwright's WebKit and Edge builds, which are close to WebKitGTK, WKWebView and WebView2 but are not those webviews. The desktop and native jobs cover the real webviews.
- The desktop scenario does not save PNG/SVG exports, because saving opens the native file dialog. The browser job covers exports on all three engines.
- macOS uses the SwiftUI harness rather than WebDriver, because WKWebView has no WebDriver for desktop apps.
