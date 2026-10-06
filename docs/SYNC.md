# Isolated sync engine

**Goal:** sync a `.kurogane` file with Google Drive, OneDrive or MEGA. The user must not need a cloud developer account, an API key or an OAuth app, and Kurogane must never touch the cloud desktop clients or CLIs already logged in on the host.

Four destinations are offered under *Settings → Sync*:

| Destination | How it works |
|---|---|
| Google Drive, OneDrive, MEGA | Kurogane's own pinned rclone (below), linked with a browser login. The vault lands in a `Kurogane/` folder of that account. |
| **A synced folder** | Any folder another tool already keeps in sync: Dropbox, iCloud Drive, Syncthing, a NAS share, a USB stick. Kurogane copies the vault there with the same lineage checks (`FolderTransport`), so no rclone is needed at all. Stored as provider `local`. |

**When it syncs (desktop app):** 2 s after unlock, 15 s after the last edit (debounced), every 5 minutes, and immediately before an idle or manual lock and before quitting, so edits never wait for the next unlock. Each round shows in the top bar (*Synced just now*, *Syncing…*, *Sync failed*). Automatic sync can be turned off; *Sync now* still works.

**Connecting on a second computer:** on the first-run screen choose *Get it from the cloud*, pick the provider (or the synced folder), then pick the vault file. It is downloaded, verified and opened with the same master password. No re-pairing of the authenticator is needed.

**Conflicts:** if both computers changed the vault since their last sync, a banner offers two choices. *Keep this computer’s* uploads the local copy (the other one stays in the remote `.bak`). *Use Google Drive’s* (or OneDrive’s, MEGA’s, the folder’s) validates the other copy with your keys, then replaces the local file, which is kept as `.bak`.

## Engine: pinned rclone

[rclone](https://rclone.org) (MIT) speaks all three providers. It also ships **public OAuth client IDs** for Drive and OneDrive, so linking an account is a single browser consent screen. Kurogane pins one version (`platform.rs`):

| Artefact | Pin |
|---|---|
| Binary zips (linux/macOS/windows × amd64/arm64) | SHA-256 from the PGP-signed `SHA256SUMS` of **v1.75.1**, compiled into the binary |
| OCI image | `docker.io/rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5` (multi-arch index digest) |

Upgrading means bumping the version and pasting new hashes. Nothing is resolved from a mutable tag or "latest" at runtime.

## Two runners, one transport

```
              ┌────────────── RcloneTransport (read_head / download / upload) ─────────────┐
              │                                                                            │
   ContainerRunner (preferred when Docker/Podman is healthy)      BinaryRunner (fallback)
   docker|podman run --rm --pull=never                             <sandbox>/engines/rclone/1.75.1/rclone
     --read-only --cap-drop=ALL                                      env_clear()
     --security-opt=no-new-privileges                                HOME, USERPROFILE, APPDATA,
     --pids-limit=256 --memory=512m                                  XDG_CONFIG_HOME, XDG_CACHE_HOME,
     --network=bridge --tmpfs /tmp                                   RCLONE_CONFIG, RCLONE_CACHE_DIR,
     --user $UID:$GID   (podman: --userns=keep-id, :Z)               TMP* → all inside the sandbox
     -v <run-dir>:/config   -v <staging>:/data0                      PATH="" (+ proxy/CA vars only)
     rclone/rclone@sha256:…  --config /config/rclone.conf …          --config <run-dir>/rclone.conf …
```

`select_transport(Auto)` probes `docker info`, then `podman info` (8 s timeout each). If one answers, it makes sure the digest-pinned image exists (`image inspect`, else `pull`) and uses the container. Otherwise it **provisions the binary**:

1. Stream `https://downloads.rclone.org/v1.75.1/rclone-v1.75.1-<os>-<arch>.zip` to `*.part`, capped at 200 MB, honouring `HTTPS_PROXY` and the OS trust store.
2. Compare its SHA-256 against the compiled-in pin. On mismatch, delete it and fail.
3. Extract **only** the `rclone`/`rclone.exe` entry (mode 0700) and record that binary's SHA-256 next to it.
4. Before every later use, re-hash the binary. A modified executable is wiped and re-provisioned, never run.

For air-gapped machines, `Provisioner::install_from_zip` takes the official zip from a USB stick and still enforces the pin.

The binary lives in Kurogane's app-data directory. Nothing goes into `PATH`, `/usr/local`, the registry or `Program Files`, and no admin rights are needed.

## Sandbox layout

```
<app-data>/sandbox/            (0700)
  engines/rclone/1.75.1/       pinned binary + .sha256 tamper record
  home/                        fake $HOME — rclone never sees the real one
  cache/                       rclone cache
  run/<uuid>/rclone.conf       one per invocation, shredded on drop
  staging/                     downloads awaiting validation
  state/sync-state.json        device-local lineage (last synced save_id per remote)
```

Because rclone never sees the real `HOME`, `APPDATA` or `XDG_*` directories, a pre-existing `~/.config/rclone/rclone.conf` and any running Drive/OneDrive desktop client are out of reach. rclone's own startup notice confirms it resolves its config inside the sandbox: `Config file "<sandbox>/home/.config/rclone/rclone.conf" not found - using defaults`.

## Credentials: sealed in the vault, materialised per command

* Linking produces an rclone remote section (`type = drive`, `scope = drive.file`, `token = {...}`). It is stored **inside the vault** in `sync_remotes.rclone_section_sealed`, sealed with `K_sync`. Moving the vault to another machine carries the cloud link with it.
* For each rclone call, `RcloneTransport::exec` writes the section to `run/<uuid>/rclone.conf` (0600) and runs the command. It then **reads the file back**: if rclone refreshed or rotated the OAuth token, the new section is returned as `SyncReport::refreshed_section` and re-sealed into the vault. Finally the run directory is dropped, which overwrites and deletes the file.
* **Least privilege on Google Drive:** Kurogane authorises with scope `drive.file`, so the token can only see files rclone/Kurogane created, never the rest of the user's Drive. This was verified against the real binary: the consent redirect requests exactly `https://www.googleapis.com/auth/drive.file`.

### Linking flows (no developer registration)

| Provider | Flow |
|---|---|
| Google Drive | `rclone authorize drive <base64url({"scope":"drive.file"})> --auth-no-open-browser`. Kurogane parses `http://127.0.0.1:53682/auth?state=…` from stderr, opens it in the default browser, waits up to 5 min, then parses the token block between `--->` and `<---End paste`. |
| OneDrive | The same with `onedrive`. Afterwards Kurogane calls Graph `GET /me/drive` with the fresh token to fill `drive_id`/`drive_type`, which rclone would otherwise ask for interactively. |
| MEGA | E-mail + password. The password goes to `rclone obscure -` over **stdin**, never argv, which other local users can read. |

The OAuth handshake always runs through the sandboxed binary, because the container's loopback is not the browser's loopback. Data transfers use whichever runner was selected.

## Sync algorithm

Each save stamps a random `save_id` and the previous one as `parent_save_id`. Both are inside the authenticated header, so a cloud provider or attacker cannot forge lineage without the key. Each device also records the `save_id` it last synced, per remote.

```
remote header ← rclone cat kgremote:<path> --count 256      (cheap peek, no full download)
decide(local, remote, last_synced):
  vault_id differs                         → ForeignVault (refuse)
  local.save_id == remote.save_id          → InSync
  last_synced == local.save_id             → Pull       (only remote changed)
  last_synced == remote.save_id            → Push       (only local changed)
  no base & remote.parent == local.save_id → Pull       (one-step fast-forward)
  no base & local.parent == remote.save_id → Push
  otherwise                                → Conflict
```

| Action | Steps |
|---|---|
| **Push** | `copyto local → <path>.<rand>.partial`; server-side `copyto <path> → <path>.bak` (remote backup); `moveto .partial → <path>`; re-peek the header and require `save_id` to match. |
| **Pull** | `copyto <path> → staging/<uuid>.kurogane`; parse the header; check `vault_id`; **full validation** when unlocked (`validate_candidate` decrypts with the session key ring and verifies the manifest); keep the local file as `.kurogane.bak`; atomic replace; `UnlockedVault::reload()`. |
| **Conflict** | Download the remote copy as `<name>.conflict-<save8>.kurogane` next to the vault. The local vault is **not** modified. The UI asks the user which to keep. Row-level 3-way merge is on the roadmap: every row has a UUID and `updated_at`, and deletions leave `tombstones`. |

A cross-process `fd-lock` on `<vault>.sync.lock` prevents concurrent rounds.

## Verified end to end

This round trip was run against the **real** rclone 1.75.1, downloaded and pin-verified by the provisioner, using an rclone `local` remote in place of a cloud:

```text
$ kurogane --home A engine provision            → rclone ready (verified)
$ kurogane --home A create infra.kurogane
$ kurogane --home A totp infra.kurogane            # optional two-factor
$ kurogane --home A sync devA/infra.kurogane --transport binary --local-remote ./cloud
FirstUpload: {"kind":"pushed",…}
$ kurogane --home B sync devB/infra.kurogane --transport binary --local-remote ./cloud
FirstDownload: {"kind":"pulled",…}
$ kurogane --home B unlock devB/infra.kurogane --totp <same authenticator>
E2E: same tenants, hosts, services, proxies and credentials as device A · keys mlocked: true
$ kurogane --home B sync …                      → InSync
```

The push → pull → conflict logic for two devices is also covered offline by `engine::tests::two_device_round_trip_and_conflict`. Not yet exercised in this environment: real Google/Microsoft/MEGA accounts, and the container runner (no Docker daemon here). The container argv is covered by a unit test.

## Extending

* Another engine (e.g. a dedicated MEGAcmd container) is a new `Transport` impl. The reconciliation and pipeline do not change.
* Additional rclone backends (WebDAV/Nextcloud, S3, SFTP) need only a `Provider` variant and a linking flow.
