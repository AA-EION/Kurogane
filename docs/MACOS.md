# Native macOS workspace

SwiftUI owns vault creation and unlock, authenticator enrollment, cloud connection, inventory navigation and search, inspectors, all entity editors, nested interfaces/ports/routes, accounts, deletion impact, settings/security/sync, import preview and export controls. The graph pane retains the original React/SVG isometric renderer so company grounds, machines, hosted services, VMs and proxy-route traces use the same topology model on every platform.

The existing Tauri NSWindow hosts an NSHostingView containing NativeRoot. NativeGraphView embeds the existing WKWebView only in the graph pane. The web entry mounts NativeGraph instead of the full React App on macOS. Tauri supplies window lifecycle and platform services; the same Rust core owns encryption, persistence, clipboard, launchers, dialogs and cloud sync. There is no second database or vault process.

## Graph boundary

`src-tauri/macos/NativeGraph.swift` and `ui/src/NativeGraph.tsx` share a narrow controller protocol: secret-free topology, appearance, selection and Fit state enter the renderer; readiness, validated selections and generated map files return. Credential records are excluded from graph topology. Native forms, account inspection, settings and vault commands do not run in this webview. The controller verifies selected records against the current native inventory.

The graph reuses IsoCanvas, layoutTopology, mapToSvg, svgToPng and toFossflowModel. It fits populated scene bounds on initial layout, retains pan/zoom and camera selection behavior, and honors reduced motion. Native inspectors occupy a separate pane, so the graph camera uses the full graph width. Map PNG, SVG and FossFLOW exports return generated data to native save handling; controls remain disabled until the graph is ready and while an export is active. Lock clears the graph state as well as native inventory and sheets.

## Native command boundary

`src-tauri/src/native.rs` accepts a finite allow-list of existing commands through an asynchronous C ABI. Swift copies callbacks before Rust frees and wipes the transport buffer. Plaintext reaches native controls for password/key entry and explicit audited Reveal; revealed values hide after 15 seconds or on lock. Copy and launchers retain plaintext in Rust. The graph never receives those plaintext values.

Real keyboard/mouse input touches the session; status polling does not. Lock events discard inventory and dismiss sheets. Generation checks prevent delayed responses restoring locked inventory. Busy state prevents repeated operations and interactive sheet dismissal during active work; errors remain explicit.

## Materials, contrast and layout

Navigation uses Apple's `glassEffect` on macOS 26 and newer and ultra-thin system material on macOS 13–25. The app defaults to Light with persisted Dark and System choices. System fonts, SF Symbols, native controls and sheet behavior carry the white/charcoal material language. NativePalette supplies dynamic readable text, metadata, status and link colors. NativePrimaryButtonStyle keeps explicit contrasting fill and ink in both active and inactive windows rather than relying on a faded accent control.

The root fills the actual content rectangle; `contentMinSize` is 960 by 600 points. Native rail widths range from 185–240 points and inspector widths from 240–320 points. `nativeSheetSize` bounds requested dimensions against the parent's contentLayoutRect with horizontal and vertical margins. Forms scroll while footer actions stay outside the scrolling content. Create-vault and cloud views retain explicit labels. Review attached sheets at a compact 960 by 640 point parent window and verify every action row remains visible.

NativeFields explicitly wraps each editor field in a separate VStack row and uses an HStack for label/control alignment. This prevents grouped Form from flattening mixed picker and text-field children into merged labels. Required indicators, visible labels and accessibility labels remain associated with their individual controls.

The shared graph uses theme-aware steel and contrasting slab labels; company labels use semantic ink instead of company color or faded text. UI contrast tests require at least 4.5:1 for the defined text/status-on-surface pairings, primary-action gradients and rendered slab labels. Native active/inactive-window appearance still needs visual review.

## Build and verification

Build with Xcode 26 or newer. `build.rs` compiles the native Swift sources for each Rust architecture and links system frameworks. The universal DMG combines Apple silicon and Intel; deployment starts at macOS 13. The artifact workflow verifies its universal binary and ad-hoc signature without publishing a release.

`native.yml` typechecks both architectures and runs a separate SwiftUI layout harness on macOS. Its fixture sources are under `src-tauri/tests` and excluded from shipping builds. The harness loads the graph bundle with a populated inventory fixture, requires machines and services to be present before accepting graph captures, and captures real attached sheets after compact-window sizing. Earlier empty-fixture captures and images of the removed SwiftUI map do not validate the current implementation.

The runner-only `native-smoke` Cargo feature creates a temporary encrypted vault through the real native bridge, exercises entity operations, explicit reveal, dependency impact, settings, lock and reopen, and checks the original graph bridge. Shipping installers never enable this feature. Presentation captures, palette tests and bridge execution are separate evidence: attach each result to its tested revision, and do not carry an earlier pass forward over later layout or contrast changes.

At source commit `1212307`, [native verification 37487691096](https://github.com/AA-EION/Kurogane/actions/runs/37487691096) passed both architecture typechecks and produced 34 workspace/attached-sheet captures. Finish review returned **ship**, scoped to layout, topology and theme contrast: distinct form rows, bounded sheets and visible action footers, the original graph contained in its pane, and readable native text/actions in both appearances. Whole-map overview labels require zooming. This review does not certify live cloud consent or every interaction.

Live cloud consent requires the user's account and browser. OAuth parsing has regression coverage for raw JSON and rclone's encoded config response; screenshots or synthetic fixtures do not prove successful live authorization.
