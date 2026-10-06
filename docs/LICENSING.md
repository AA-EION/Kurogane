# Licensing and compatibility audit

Kurogane's original code, documentation and project-created assets are licensed
under **AGPL-3.0-or-later**. The unmodified license is in [LICENSE](../LICENSE);
[NOTICE](../NOTICE) applies it to the project. This choice was explicitly approved
by the project owner on 2026-10-06 after clarifying commercial-use implications.

## What this choice means

AGPL permits commercial use, charging for copies and paid support. Covered
derivatives cannot be conveyed as closed proprietary software while withholding
the Corresponding Source required by the license. Modified versions supporting
remote interaction must prominently offer their Corresponding Source to those
users under section 13. Private modifications do not by themselves require public
publication. Independent programs merely run alongside Kurogane are not
automatically covered. Users' vaults, secrets and inventory exports are their data.

Do not append a noncommercial or no-sale restriction to this license. That would
contradict the approved open-source choice. See the [AGPL text](https://www.gnu.org/licenses/agpl-3.0.html),
[GNU FAQ](https://www.gnu.org/licenses/gpl-faq.html#NoMilitary) and
[Open Source Definition](https://opensource.org/osd).

## Reviewed repository and dependencies

The review covered Rust core/sync/CLI, Tauri configuration and handlers, SwiftUI
and the graph bridge, React/TypeScript/CSS/SVG, schema/fixtures, docs and assets,
build workflows, runtime rclone provisioning, and both complete lockfiles.

| Area | Evidence and handling |
| --- | --- |
| 582 registry crates | Exact Cargo archive SHA-256 checked before manifest/notice extraction, all platforms and build/development packages included. |
| 86 npm packages | Exact lockfile SRI checked before extraction, including optional architecture binaries. |
| 35 upstream license expressions | Reviewed in `docs/legal/license-decisions.json`; preserve AND obligations and select a permitted OR alternative. Upstream legacy slash notation is retained as evidence. |
| MIT/BSD/ISC/Zlib/Boost/Unicode/Apache | Preserve copyright/license and applicable notice/patent terms. Apache 2 is GPLv3 compatible; see [Apache's explanation](https://www.apache.org/licenses/GPL-compatibility). |
| MPL-2.0 | Preserve file-level terms and provide source. No Exhibit B secondary-license exclusion was detected in audited source headers. No MPL files were relicensed or modified by this task. See [Mozilla's compatibility guidance](https://www.mozilla.org/en-US/MPL/2.0/FAQ/). |
| Certificate-root data | `webpki-roots` is CDLA-Permissive-2.0; preserve its agreement with data. See [the agreement](https://cdla.dev/permissive-2-0/). |
| SQLCipher/OpenSSL/ring | Original nested license texts collected, not just the outer Rust crate license. SQLCipher community code is BSD-3-Clause; vendored OpenSSL 3 is Apache-2.0; ring includes Apache/ISC and embedded notices. |
| Isoflow/FossFLOW | Preserve the original MIT attribution in adapted canvas code and the full grant in `THIRD_PARTY_NOTICES.md`. The export schema is interoperability, not a bundled FossFLOW dependency. |
| rclone 1.75.1 | Official unmodified checksum-pinned runtime download. Its exact MIT `COPYING` is now retained beside the engine, including previously installed engines. It is a subprocess, not linked into Kurogane. |
| Design references/fonts | Boundless/EION are references; no reference font files or source packages are bundled. Web typography uses installed system fonts. |
| Images/icons | Repository-supplied project assets fall under the owner's license grant; no external raster/icon pack dependency is present. Historical screenshots and the original application-icon provenance have not been independently established. Their original creators' rights cannot be established by a package scan. See `docs/img/PROVENANCE.md`. |

The current locked package set has no detected AGPL-incompatible license choice.
This is an engineering audit of concrete source/metadata and provenance, not a
guarantee about undocumented ownership, patents or every possible future use.
Third-party grants remain intact; project licensing does not override them.

## Platforms and installer contents

Apple's installed SwiftUI/AppKit/WebKit/SF Symbols and Swift/compiler runtime are
platform components under their own terms; no Apple SDK is redistributed as source.
Windows uses WebView2 and the Microsoft Evergreen bootstrapper under Microsoft's
[distribution terms](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).
These vendor runtimes are not claimed to be AGPL licensed. OS/system-library
exclusions are governed by AGPL section 1; they do not waive vendor terms.

Linux AppImages copy distro libraries/plugins. The artifact workflow embeds a
documented superset of the runner's distro copyright notices and common license
texts, inventories actual ELF files against dpkg packages, records exact source
package versions, and downloads matching distro source archives alongside the
installer. Any unmapped ELF file needs explicit review before public distribution.
AppImage's loader/launcher and bundling tools retain upstream terms; they are
separate from the application's Rust/npm graph. Their original project notices
are in `docs/legal/appimage-NOTICES.txt`; the runtime version is retained in a
platform evidence artifact. The observed `8f39b89` runtime was matched to its
official build log: FUSE 3.15.0, squashfuse 0.5.2, musl 1.2.5, zstd 1.5.6,
zlib 1.3.2 and mimalloc 2.1.7. Their original notices and checksum-verified
source archives are retained, including the runtime's FUSE patch/build scripts.
FUSE library code is LGPL-2.1-or-later; zstd uses its BSD alternative. The MIT
mimalloc notice is included even though the runtime's top-level license list
omitted it. CI rejects a changed runtime until this separate audit is updated.
Alpine build recipes/patches can be located at the build-date snapshot
`alpinelinux/aports@b82a90a26fc0965ffd03cca90dfb1daed17101cc` for the package
revisions identified in the upstream build log. Preserve required patches and
source access when distributing; no static LGPL relinking rights are restricted.
LGPL libraries remain replaceable
in an extracted AppDir; preserve their source and modification/relinking rights.

The workflow packages `LICENSE`, `NOTICE`, third-party text and this policy under
the installed `legal` resource directory. About and CLI help show the license,
copyright, source location and absence of warranty. The web About screen includes
the complete license offline; macOS opens the installed license document.

## Source delivery and redistribution

Each artifact run publishes an exact `git archive` source artifact alongside its
installers, plus a separate checksum-verified archive of all locked registry
packages. It includes the Rust/Swift/TypeScript sources, assets, lockfiles,
configuration, build scripts, notices and the dependency inventory. Exact upstream
crate/npm archive checksums and URLs are listed in the inventory; retain
access to all required Corresponding Source, including any locally modified
dependencies and bundled copyleft libraries. The Linux source artifact additionally
includes the selected distro source packages and patches. A source URL alone is
not a waiver of the distributor's duty to ensure source remains available.

Before distribution, retain exact binary/source matching, include upstream notices,
resolve unmapped platform files and asset-rights questions, and provide the source
using an AGPL section 6 method. If distributing a modified network service, implement
the source offer required by section 13. No release is published by this workflow.
Earlier UI-preview artifacts predate this license/notice packaging and should be
replaced by the new artifacts for distribution.

To modify/relink the separate AppImage runtime, unpack its source archive and the
library sources under `dependency-source/AppImage/`. The runtime's upstream
`scripts/` and `patches/libfuse/` control its build; retain the LGPL terms on FUSE.
Build a replacement runtime with the modified library, then repack the extracted
AppDir using `appimagetool --runtime-file <replacement-runtime>`. Kurogane places
no signing, license or technical restriction on using that replacement.

## Keeping the audit current

`node scripts/license-audit.mjs` fetches and checksum-verifies locked archives,
extracts original notices, and records exact-commit/shared-package supplements for
upstreams that omitted files. Review changed evidence and new expressions before
updating decisions. `node scripts/license-audit.mjs --check` runs offline in CI and
installer builds, rejecting stale lockfiles, missing notice evidence and unreviewed
expressions. Full source/license texts are in `THIRD_PARTY_LICENSES.txt`; inventory
and decisions live in `docs/legal/`. Do not simply allow an unknown license to make
the check pass. Contributions use the project's AGPL terms without copyright transfer.
