# Current UI captures

- `map-light.jpg`: actual development browser capture at 1440 × 900 of the React interface with corrected light-theme contrast and a selected service, using the development-only synthetic inventory. Captured on 2026-10-06 at commit `1212307`.
- `macos-map.png`: actual native window capture on the GitHub macOS runner: SwiftUI navigation and inspector around the original IsoCanvas graph in WKWebView, with 14 synthetic machines and 15 services. Source: `workspace-light.png` in `native-ui-review` from [verification run 37487691096](https://github.com/AA-EION/Kurogane/actions/runs/37487691096), commit `1212307`. Native rendering and the actual webview snapshot are captured at their window positions. That run also checks 34 light/dark workspace and attached-sheet captures.

These are presentation captures, not evidence of a live cloud account or successful OAuth consent. They contain no real credentials. Older images in this directory predate the refactor and are no longer shown in the README.

`accounts.png`, `import-export.png`, `map.png`, `service-form.png`, `sync.png` and `wizard.png` were already present at commit `f4a074d`. Their original capture environment and inventory are unverified; embedded origin metadata marks them as historical, and their pixels are unchanged.
