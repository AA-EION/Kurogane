# Third-party notices

## Isoflow / FossFLOW — MIT

The isometric projection constants (`UNPROJECTED_TILE_SIZE`, `TILE_PROJECTION_MULTIPLIERS`), the tile→screen
formula, the ground-plane matrix and the grid/A* connector-routing model in `ui/src/canvas/` are adapted from
Isoflow (https://github.com/markmanx/isoflow) and its fork FossFLOW (https://github.com/stan-smith/FossFLOW).
The FossFLOW export targets the `fossflow@1.0.5` model schema.

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
| rclone 1.75.1 | MIT | sync engine, downloaded at runtime (not redistributed in this repo) |
| SQLCipher (via rusqlite `bundled-sqlcipher`) | BSD-3-Clause | encrypted database |
| OpenSSL 3 (vendored, crypto provider for SQLCipher) | Apache-2.0 | |
| Tauri v2 | MIT / Apache-2.0 | desktop shell |
| RustCrypto crates (aes-gcm, argon2, hkdf, hmac, sha1, sha2) | MIT / Apache-2.0 | |
| rust_xlsxwriter, calamine | MIT / Apache-2.0, MIT | Excel template, export and import |
| tauri-plugin-dialog, -opener, -single-instance | MIT / Apache-2.0 | file dialogs, opening links, one window per user |
| React | MIT | UI |

Full dependency license lists: `cargo license` (Rust) and `npx license-checker` (ui/).
