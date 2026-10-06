# Architecture & framework choice

## Decision: Rust core + Tauri lifecycle + React/SVG or SwiftUI presentation

| Concern | Choice | Why |
|---|---|---|
| Language for anything touching keys | **Rust** | Memory safety without a GC (so key material is not copied around by a collector), deterministic `Drop` for zeroization, first-class `mlock`/`VirtualLock` via `region`, mature audited crypto (RustCrypto `aes-gcm`, `argon2`, `hkdf`). |
| Desktop shell | **Tauri v2** | Uses the OS webview (WebKitGTK / WKWebView / WebView2) instead of bundling Chromium: ~10 MB installers and a fraction of Electron's RAM. Its capability system means the webview can only call the commands we register. It targets macOS (Intel + Apple Silicon), Windows x64 and Linux x64/ARM64 from one codebase. |
| UI | **React 18 + TypeScript**, no UI framework | The canvas logic is adapted from FossFLOW/Isoflow, which are React too. The production bundle is about 90 KB gzipped. |
| Canvas renderer | **SVG** (with an isometric projection) | Crisp at any zoom, native hit-testing and accessibility, CSS animations for the route traces. Hundreds of nodes render comfortably. Beyond about 5,000 nodes, switch the block layer to Canvas2D/WebGL behind the same `Scene` model. |
| Database | **SQLite + SQLCipher 4** (`rusqlite`, `bundled-sqlcipher-vendored-openssl`) | Single-file, embedded, relational (foreign keys, triggers, partial indexes, views). SQLCipher gives page-level AES-256 + HMAC-SHA512. OpenSSL is vendored so builds are reproducible on all three OSes. |
| Sync engine | **rclone 1.75.1** (pinned), sandboxed binary or OCI sidecar | One engine for Drive, OneDrive and MEGA, with built-in public OAuth clients. MIT licensed. See [SYNC.md](SYNC.md). |

### Alternatives considered

* **Go + Wails**: a comparable footprint. Rejected because Go's GC moves and copies buffers, so reliably zeroizing a key is not possible, and the SQLCipher bindings need cgo anyway.
* **C++ / Qt 6**: an excellent native toolkit, but a much larger memory-unsafe surface for a security product. The licensing (LGPL/commercial) and the build complexity across three OSes are also heavier.
* **Slint / iced (pure Rust UI)**: attractive for the smallest attack surface. But the FossFLOW reuse mandate and the richness of web layout for the drawer and omnibox favoured a webview. The core is UI-agnostic (`kurogane-core` has no Tauri dependency). macOS now uses a complete SwiftUI presentation while Windows and Linux keep the React/SVG workspace.
* **Electron**: rejected per the brief. It brings ~150 MB of Chromium per app, and its sandboxing depends on careful configuration.

## Process & trust boundaries

```
┌──────────────────────────── Kurogane process ─────────────────────────────┐
│  WebView (untrusted renderer)            Rust core (trusted)              │
│  ┌──────────────────────────┐   IPC     ┌──────────────────────────────┐  │
│  │ React UI, SVG canvas     │◄────────► │ commands / io / sync (44)    │  │
│  │ topology (no secrets)    │  invoke   │ AppState { UnlockedVault }   │  │
│  │ revealed secret ≤ 15 s   │           │ SessionClock watchdog (1 Hz) │  │
│  └──────────────────────────┘           │ Clipboard worker (TTL clear) │  │
│        CSP: default-src 'self'          └──────────────┬───────────────┘  │
│        no plugin permissions                           │                  │
└────────────────────────────────────────────────────────┼──────────────────┘
                                                         │ spawn (cleared env)
                       ┌─────────────────────────────────┴─────────────┐
                       │ rclone sidecar: container (--read-only,       │
                       │ --cap-drop=ALL, digest-pinned) or sandboxed   │
                       │ binary (pinned SHA-256)                       │
                       └───────────────────────────────────────────────┘
```

* The webview never receives key material. It gets a **secret-free topology**: the `Topology` DTO carries only `has_secret`-style flags.
* A plaintext secret crosses IPC only for an explicit **Reveal**, which is audited and auto-hidden after 15 s. **Copy** and the launchers never send the secret to JS: Rust writes it to the clipboard and clears it after `clipboard_clear_secs` (default 30 s), but only if the clipboard still holds that same value.
* Launch targets are validated against allow-lists before reaching `Command::new` (no `-oProxyCommand=…` hosts, no `javascript:` URLs, no CR/LF in `.rdp` fields).
* File dialogs, URL opening and the clipboard are invoked **from Rust**. The capability file grants JS nothing beyond listening to Kurogane's own events.

On macOS, SwiftUI replaces every visible web view. Its native command allow-list calls the same Rust handlers through asynchronous C ABI requests and copies response buffers synchronously. Tauri owns window lifecycle; React does not mount. Native topology stays secret-free; explicit audited Reveal is the only secret output into Swift, and Copy/launchers remain in Rust. See [MACOS.md](MACOS.md) for sources and runner checks.

## Crates

| Crate | Responsibility | Depends on Tauri? |
|---|---|---|
| `kurogane-core` | KDF, key ring, container, SQLCipher DAL + schema + editing layer, Excel/JSON interchange, TOTP, session clock, launchers, atomic FS | no |
| `kurogane-sync` | Sandbox, provisioning, rclone runners (binary/container), folder transport, OAuth linking, reconciliation, conflict resolution | no |
| `kurogane-cli` (`kurogane`) | Headless vault + sync manager | no |
| `kurogane-app` (`src-tauri`) | Desktop shell: IPC commands, session watchdog, clipboard worker, sync scheduler, import/export dialogs, installer config | yes |

The three non-Tauri crates are the default workspace members, so `cargo test` runs on any machine without WebKit. That covers 54 tests, including RFC vectors, the editing and import layers, and a two-device sync simulation with conflict resolution.

## Session lifecycle

1. **Unlock**: Argon2id runs on a blocking thread. Then the VDK is unwrapped, the key ring derived (six mlocked pages), the payload decrypted, and the SQLCipher working copy opened. TOTP is verified with replay protection.
2. **Active**: every IPC call that touches the vault calls `SessionClock::touch()`. The UI also throttles a `touch` on pointer/keyboard activity, at most once per 10 s on Windows/Linux or once per second on macOS. Rendering and status polling never touch the session.
3. **Lock** (manual, `Ctrl/⌘+L`, inactivity timeout, suspend detected, app exit): pending sync is flushed first (except on suspend), then `save_if_dirty()` persists audit entries, then the `UnlockedVault` is dropped. That closes SQLCipher, shreds the working copy and zeroizes and unlocks every key page. The clipboard is cleared if it still holds a Kurogane secret. The UI receives `vault://locked` and discards the topology.

Suspend detection is portable: it compares wall-clock and monotonic deltas (`session.rs`). OS-specific screen-lock signals plug into `SessionClock::force_lock`. These are logind `Lock`/`PrepareForSleep`, `com.apple.screenIsLocked`, and `WTS_SESSION_LOCK` (see the roadmap in the README).
