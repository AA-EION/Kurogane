# Contributing

Contributions to Kurogane's original code, documentation and assets are accepted
under AGPL-3.0-or-later, the project's license. Contributors retain their copyright.
Only submit material you have authority to contribute under these terms.

Preserve third-party copyright and license notices. Identify copied/adapted code
and its exact upstream source; do not replace its notice with Kurogane's copyright.
Design references do not grant permission to copy fonts, artwork, logos or code.

Dependency updates must regenerate `docs/legal/dependency-inventory.json` and
`THIRD_PARTY_LICENSES.txt` with `node scripts/license-audit.mjs`. Review any new
license expression, attribution or source obligation before adding its decision
to `docs/legal/license-decisions.json`. Run `node scripts/license-audit.mjs --check`.
The check rejects stale lockfiles, missing notices and unreviewed expressions.

See `docs/LICENSING.md` for distribution requirements and the limits of the audit.
