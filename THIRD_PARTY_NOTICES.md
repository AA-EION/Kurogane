# Third-party notices

## Isoflow / FossFLOW — MIT

The isometric projection constants (`UNPROJECTED_TILE_SIZE`, `TILE_PROJECTION_MULTIPLIERS`), the tile→screen
formula, the ground-plane matrix and the grid/A* connector-routing model in `ui/src/canvas/` are adapted from
Isoflow (https://github.com/markmanx/isoflow) and its fork FossFLOW (https://github.com/stan-smith/FossFLOW).
The FossFLOW export targets the `fossflow@1.0.5` model schema; that package is not installed or bundled. FossFLOW's license is available at its [current GitLab location](https://gitlab.com/stan-smith1/FossFLOW/-/blob/master/LICENSE). Its notice below retains the 2023 copyright; current [Isoflow](https://github.com/markmanx/isoflow/blob/main/LICENSE) additionally carries Copyright (c) 2025 Mark Mankarious.

    MIT License — Copyright (c) 2023 Mark Mankarious

    Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
    documentation files (the "Software"), to deal in the Software without restriction, including without limitation
    the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
    to permit persons to whom the Software is furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all copies or substantial portions
    of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
    THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
    CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
    IN THE SOFTWARE.

## Runtime-downloaded / embedded components

| Component | License | Use |
|---|---|---|
| rclone 1.75.1 | MIT | official executable downloaded at runtime; exact upstream notice is installed beside it as `COPYING` |
| SQLCipher (via rusqlite `bundled-sqlcipher`) | BSD-3-Clause | encrypted database |
| OpenSSL 3 (vendored, crypto provider for SQLCipher) | Apache-2.0 | |
| Tauri v2 | MIT / Apache-2.0 | desktop shell |
| RustCrypto crates (aes-gcm, argon2, hkdf, hmac, sha1, sha2) | MIT / Apache-2.0 | |
| rust_xlsxwriter, calamine | MIT | Excel template, export and import |
| tauri-plugin-dialog, -opener, -single-instance | MIT / Apache-2.0 | file dialogs, opening links, one window per user |
| React | MIT | UI |

## Complete locked dependency inventory

The audit covers all 582 registry crates in `Cargo.lock` and all 86 npm packages in `ui/package-lock.json`, including optional platform bindings and development/build packages. Registry archives were verified against their lockfile SHA-256/SRI before reading their manifests and notices.

- [Machine-readable inventory](docs/legal/dependency-inventory.json): versions, declared expressions, archive integrity, license paths/hashes and supplemental provenance.
- [Original license/copyright texts](THIRD_PARTY_LICENSES.txt): including SQLCipher and vendored OpenSSL, ring/BoringSSL and Unicode/certificate-root data notices.
- [Reviewed expressions](docs/legal/license-decisions.json): selected permissive alternatives, conjunctive obligations and MPL requirements. Historical slash-style dual licenses are preserved as upstream declarations, not represented as valid SPDX expressions.
- [Distribution policy and audit boundaries](docs/LICENSING.md).

Some upstream packages omit a standalone license file. The inventory identifies notices recovered from the exact source commit, an original source-file header, or the corresponding shared upstream package. Platform-only npm binaries use the notices of the exact locked wrapper version. This is explicit supplemental evidence, not a claim those archives contained the missing files.

Third-party licenses remain in force. AGPL applies to Kurogane's original work and the combined covered application; it does not replace permissive grants, MPL file-level terms, LGPL obligations or platform vendor agreements.

## Design, fonts, icons and platform components

Boundless and EION Studios were design references. No font files or source packages from them are bundled in this repository. Kurogane's web fonts resolve to the installed platform font stacks. The repository identifies the SVG pictograms as original, and keeps screenshot origins in [docs/img/PROVENANCE.md](docs/img/PROVENANCE.md). Historical screenshot and application-icon provenance is not independently established by a dependency scan; project owners remain responsible for rights in first-party supplied assets.

Apple SwiftUI/AppKit/WebKit/SF Symbols and Microsoft WebView2 are platform components, not AGPL relicensed code. The Windows installer uses Microsoft's Evergreen bootstrapper under its redistribution terms. Linux AppImages may bundle GTK/WebKit and other distro libraries; their original notices, exact package/source versions and source access must accompany those artifacts. See the platform manifest generated by the artifact workflow.

AppImageKit, type2-runtime, linuxdeploy and its AppImage plugin retain their original notices in [AppImage licensing evidence](docs/legal/appimage-NOTICES.txt). These project grants do not replace the licenses of their embedded libraries. The installer workflow records the actual runtime version; static LGPL source/relinking obligations must be verified separately from dynamically bundled distro libraries before release.
