# Native macOS port

Every visible macOS view is SwiftUI: vault creation and unlock, cloud connection, inventory navigation and search, map and zoom controls, inspectors, all entity editors, nested interfaces/ports/routes, credentials, deletion impact, settings/security/sync, import preview and exports.

The existing Tauri NSWindow hosts one NSHostingView. React does not mount on macOS, and no WKWebView is embedded in the native view tree. Tauri supplies window lifecycle and platform services. The same Rust core owns encryption, persistence, clipboard, launchers, dialogs and cloud sync; there is no second database or vault process.

`src-tauri/src/native.rs` accepts a finite allow-list of existing commands through an asynchronous C ABI. Swift copies callbacks before Rust frees and wipes the transport buffer. Secret-free topology and events reach the native model. Plaintext crosses into Swift only for password/key entry and explicit audited Reveal; revealed values hide after 15 seconds or on lock. Copy and launchers retain plaintext in Rust. Real keyboard/mouse input touches the session; status polling does not. Lock events discard inventory and dismiss sheets. Generation checks prevent delayed responses restoring locked inventory.

Navigation uses Apple's `glassEffect` on macOS 26 and newer and ultra-thin system material on macOS 13–25. The app defaults to Light, with persisted Dark and System choices. System fonts, SF Symbols, native controls and sheet behavior carry the shared white/charcoal material language. The map uses SwiftUI Canvas for grounds, machine slabs and connectors, with native accessible selection controls.

Build with Xcode 26 or newer. `build.rs` compiles all `macos/*.swift` for each Rust architecture and links system frameworks. The universal DMG combines Apple silicon and Intel; deployment starts at macOS 13. The artifact workflow verifies its universal binary and ad-hoc signature without publishing a release.

`native.yml` typechecks both architectures and runs a separate SwiftUI layout/validation harness on macOS. Its fixture sources are under `src-tauri/tests` and are excluded from shipping builds. CI additionally enables the runner-only `native-smoke` Cargo feature to create a temporary encrypted vault through the real native bridge, exercise all entity types, reveal a fixture secret, inspect dependencies, save settings, lock and reopen. Shipping installers never enable this feature. Review captures are uploaded as workflow artifacts.

Live cloud consent needs the user's account and browser. OAuth token parsing has regression tests for raw JSON and rclone's encoded config response; no cloud tokens are placed in logs or fixtures.