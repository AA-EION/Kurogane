# Cryptographic & container blueprint

All constants below are implemented in `crates/kurogane-core/src/{kdf,keys,container,crypto,totp}.rs` and covered by tests. Those tests include the RFC 9106 Argon2id vector and the RFC 6238 TOTP vectors for SHA-1, SHA-256 and SHA-512.

## 1. Key hierarchy

```
master password
   │  Argon2id v1.3 (RFC 9106), salt = 32 random bytes, output = 32 bytes
   ▼
MEK  (Master Encryption Key) — exists only during unlock / password change
   │  AES-256-GCM unwrap, nonce = wrap_nonce, AAD = header[0..72]
   ▼
VDK  (Vault Data Key) — 32 random bytes, generated once per vault
   │  HKDF-SHA256(ikm = VDK, salt = vault_id, info = …)
   ├── "kurogane/v1/payload"    → K_payload   AES-256-GCM over the archive
   ├── "kurogane/v1/sqlcipher"  → K_db        raw SQLCipher key (x'…')
   ├── "kurogane/v1/field"      → K_field     sealed credential columns
   ├── "kurogane/v1/totp"       → K_totp      sealed TOTP seed
   └── "kurogane/v1/sync"       → K_sync      sealed rclone remote sections
```

Why wrap a random VDK instead of using the MEK directly:

* **Password change is O(1).** Only the 48-byte `wrapped_vdk` changes. No data is re-encrypted, and a device that already holds the VDK keeps working after another device changes the password (`UnlockedVault::reload`).
* The MEK is dropped (zeroized and munlocked) immediately after unwrapping. Only VDK-derived keys live for the session.
* Domain separation: a bug in one consumer (say, field sealing) cannot be leveraged against another consumer's key.

### Argon2id parameters

| Profile | Memory | Passes (t) | Lanes (p) | Use |
|---|---|---|---|---|
| `STANDARD` (default) | 256 MiB | 3 | 4 | Local vaults. About 0.5–1.5 s on 2020+ laptops. |
| `HARDENED` | 1 GiB | 4 | 4 | Vaults synced to third-party clouds. |
| Recommended floor | 64 MiB | 3 | 1 | RFC 9106 §4 memory-constrained option. Below this the UI warns and offers to re-key. |
| Accepted bounds when opening | 8·p KiB – 4 GiB | 1 – 64 | 1 – 64 | Stops a hostile header from forcing unbounded allocation. |

The parameters live in clear in the header, so any machine can re-derive the MEK. They sit inside the AAD of the VDK wrap, so tampering with them (a downgrade attack) makes the unwrap fail rather than silently weakening the vault. The `argon2` crate is built with `zeroize`, so its working memory is wiped after hashing.

## 2. `.kurogane` byte layout

All integers are little-endian. The header is exactly 256 bytes.

```
off  len  field                notes
---  ---  -------------------  --------------------------------------------------------
  0    9  magic                "KUROGANE\0"  (4B 55 52 4F 47 41 4E 45 00)
  9    2  format_version       u16 = 1
 11    2  header_len           u16 = 256
 13    1  kdf_id               1 = Argon2id v1.3
 14    1  aead_id              1 = AES-256-GCM
 15    1  argon2_lanes         u8
 16    4  argon2_m_cost        u32, KiB
 20    4  argon2_t_cost        u32
 24   32  kdf_salt             random
 56   16  vault_id             UUIDv4, fixed for the vault's lifetime
 ──── 72  ─────────────────    end of the KEY-BINDING region (AAD of the VDK wrap)
 72   12  wrap_nonce           random, renewed on every (re-)wrap
 84   48  wrapped_vdk          AES-256-GCM(MEK, VDK) = ciphertext[32] ‖ tag[16]
132    4  flags                bit0 TOTP_REQUIRED (UI hint), bit1 DB_SQLCIPHER; others must be 0
136    8  generation           u64, +1 per save
144   16  save_id              random per save
160   16  parent_save_id       save_id this save descends from (zeros for the first save)
176    8  saved_at_ms          i64, Unix epoch ms
184   12  payload_nonce        random per save
196    8  payload_len          u64 = len(archive) + 16
204   52  reserved             must be zero (rejected otherwise)
256    …  payload              AES-256-GCM(K_payload, archive, AAD = header[0..256])
```

Authentication coverage:

| Bytes | Protected by |
|---|---|
| 0–71 (identity, KDF params, salt) | the VDK wrap (wrong or altered means unwrap fails) **and** the payload AAD |
| 72–255 (wrap, flags, lineage, nonce, length, reserved) | the payload AAD (the whole 256-byte header is the AAD) |
| 256… | the GCM tag |

Opening is fail-closed and coarse: a wrong password, a modified header and a corrupted payload all return the same `AuthFailed`, so the UI is not an oracle. The parser checks magic, version, header length, algorithm ids, unknown flag bits, reserved bytes, KDF bounds, the 1 GiB payload cap and `file_len == 256 + payload_len` *before* any expensive work.

Nonces: random 96-bit nonces under one key. `K_payload` encrypts once per save, and the wrap key changes with every password change. Usage stays many orders of magnitude below the 2³² random-nonce limit in NIST SP 800-38D.

### Archive (`KGPK`, the plaintext inside the payload)

```
0   4  magic "KGPK"
4   2  version u16 = 1
6   4  entry_count u32 (1 … 4096)
10  …  entry*: path_len u16 ‖ path (UTF-8) ‖ data_len u64 ‖ data
```

* Entry 0 is always `MANIFEST.json`:
  `{ "format": "kurogane-archive/1", "vaultId", "generation", "entries": [{ "path", "size", "sha256" }] }`.
  Decoding rejects a manifest whose `vaultId`/`generation` disagree with the header, and any entry that is missing, extra, duplicated or has a SHA-256 mismatch.
* `db/vault.db` is the SQLCipher database file. It is itself encrypted with `K_db`, so the working copy on disk is never plaintext.
* `icons/*.svg|png` hold custom infrastructure icons. Paths are limited to `[A-Za-z0-9._-]` segments, with no `..`, no empty segments and no absolute paths. That prevents zip-slip if the icons are ever extracted.
* There is no compression. The dominant entry is SQLCipher ciphertext, which does not compress, and skipping it avoids compression-oracle questions.

### Saving

`container::seal` advances the lineage (`generation += 1`, `parent_save_id = save_id`, new `save_id`), encodes the archive and encrypts it. `fsutil::atomic_write` then:

1. writes `vault.kurogane.<uuid>.tmp` (mode 0600) and `fsync`s it,
2. copies the current file to **`vault.kurogane.bak`** and `fsync`s it,
3. `rename`s the temp file over the vault (atomic on POSIX and on Windows' `MoveFileExW(REPLACE_EXISTING)`), then `fsync`s the directory.

A crash at any step leaves either the old or the new vault intact, plus the previous version in `.bak`.

## 3. Field sealing (defence in depth inside SQLCipher)

`credentials.secret_sealed`, `private_key_sealed`, `notes_sealed`, `vault_security.totp_secret_sealed` and `sync_remotes.rclone_section_sealed` use:

```
0x01 ‖ nonce[12] ‖ AES-256-GCM(key, plaintext, AAD = "<table>:<row id>:<column>")
```

The AAD binds each ciphertext to its row and column, so copying one row's secret into another fails to decrypt (tested in `sealed_fields_are_bound_to_their_row`). Because secrets are sealed, `load_topology()` cannot leak one even by mistake; a test asserts the topology JSON contains none of the seeded secrets.

## 4. Portable offline TOTP

* **Enrolment** (optional; offered right after creating a vault and any time later under *Settings → Security*): the seed is 160 random bits (RFC 4226 §4), with SHA1 / 6 digits / 30 s for universal authenticator support. It is sealed with `K_totp` (AAD includes `vault_id`) and stored in `vault_security`. The UI shows an `otpauth://` URI and a QR code rendered by the `qrcode` crate in Rust. The user confirms one code. Only then is `totp_enabled = 1` set, and the header flag `TOTP_REQUIRED` raised so the unlock screen knows to show the code field.
* **Verification** (unlock): password → MEK → VDK → payload → SQLCipher, then unseal the seed and check the code at the current time ±1 step. All candidate steps are compared in constant time without early exit. Counters `<= totp_last_counter` are rejected (replay protection), and the matched counter is stored.
* **Portability**: the seed travels *inside* the encrypted vault. Copying `infra.kurogane` to another machine and entering the master password recovers it, so the user's existing authenticator entry works with no re-pairing. This is verified end to end with the CLI and two separate work directories in `create_unlock_with_portable_totp`.

**Threat-model note (read this).** Any offline verifier must possess the seed, and here the seed is protected by the master password. TOTP therefore acts as a **policy factor enforced by the application**. It stops someone who has shoulder-surfed or key-logged the password from unlocking at the keyboard without the phone. It adds **no cryptographic strength** against an attacker who holds both the vault file *and* the master password and runs their own code. If that threat matters, the right tool is a hardware-bound factor that contributes key material (FIDO2 `hmac-secret` / YubiKey challenge-response mixed into the KDF). The header has reserved space and a `kdf_id` byte to add that as format v2 without breaking v1 files.

A related limit: replay protection stores the last counter in the working database, and it is persisted with the next real save. A copy of an older vault file has an older counter.

## 5. Memory hygiene

* `SecretBox<N>` allocates **whole, page-aligned pages** per secret. `munlock` does not reference-count, so sharing a page would unlock a neighbour. Each box is `mlock`/`VirtualLock`ed, marked `MADV_DONTDUMP` on Linux, and zeroized with `zeroize` (volatile writes that cannot be optimised away) before being unlocked and freed. `Debug` prints `[REDACTED]`.
* If locking fails (a tiny `RLIMIT_MEMLOCK`), the app keeps working and shows a **"memory not locked"** badge.
* Passwords and revealed secrets in transit use `Zeroizing<String>`. That covers Tauri command arguments too, via zeroize's serde feature.
* SQLCipher runs with `cipher_memory_security = ON`, so its page cache is locked and wiped.
* Honest limits: once a secret has been **revealed**, it exists in the webview's JS heap until garbage collection. That is why Copy is the default action and Reveal auto-hides after 15 s. The OS clipboard is outside our control once written; it is cleared after 30 s only if unchanged.
