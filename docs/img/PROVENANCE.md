# Current UI captures

- `map.png`: actual development browser capture (headless Chromium via Playwright) at 1440 × 900 of the React Flow topology view in the dark theme, fitted overview with nothing selected, using the development-only synthetic inventory (`?demo=1`). Captured on 2026-10-29 with the React Flow migration.
- `map-light.jpg`: the same setup in the light theme with the gitea service selected from the sidebar: its route trace is lit and the inspector is open. Captured on 2026-10-29 with the React Flow migration.
- `macos-map.png`: actual native window capture on the GitHub macOS runner: SwiftUI navigation and inspector around the previous SVG graph in WKWebView, before the React Flow migration. It is no longer shown in the README; regenerate it from the `native-ui-review` artifact of the next macOS verification run. Original capture: 14 synthetic machines and 15 services. Source: `workspace-light.png` in `native-ui-review` from [verification run 37487691096](https://github.com/AA-EION/Kurogane/actions/runs/37487691096), commit `1212307`. Native rendering and the actual webview snapshot are captured at their window positions. That run also checks 34 light/dark workspace and attached-sheet captures.

These are presentation captures, not evidence of a live cloud account or successful OAuth consent. They contain no real credentials. Older images in this directory predate the refactor and are no longer shown in the README.

`accounts.png`, `import-export.png`, `service-form.png`, `sync.png` and `wizard.png` were already present at commit `f4a074d`. Their original capture environment and inventory are unverified; embedded origin metadata marks them as historical, and their pixels are unchanged.
