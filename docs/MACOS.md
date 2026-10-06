# macOS SwiftUI shell

The macOS build integrates `src-tauri/macos/KuroganeShell.swift` into the existing application as a native SwiftUI navigation shell. It is a hybrid port: the toolbar is SwiftUI, while the inventory, map and editors remain the shared React workspace. It is not a complete Swift-only rewrite.

On macOS 26 and newer, the navigation controls use Apple's native `glassEffect`. macOS 13–25 use the system's ultra-thin material. Newer OS versions inherit the native implementation through the availability check. No unsupported “Golden Gate” API or guessed OS version is hard-coded.

The Swift view is installed on Tauri's existing NSWindow on the main thread. It sends only fixed navigation actions to React and receives appearance, title, availability and sync state. Rust continues to own the vault, encryption, clipboard, launchers and cloud credentials. No secret values cross the Swift bridge and no second process opens the vault.

Build with Xcode 26 or newer and the macOS 26 SDK. `build.rs` compiles the Swift module for each Rust target and links the system frameworks; the universal DMG combines Intel and Apple silicon. The deployment target is macOS 13.

The GitHub artifact workflow verifies the universal binary and ad-hoc signature. UI behavior and native Liquid Glass still need a hands-on macOS check; a Windows preview cannot verify AppKit rendering.
