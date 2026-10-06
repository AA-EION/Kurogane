//! Crash-safe file replacement with a rolling `.bak`.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::Result;

/// `vault.kurogane` → `vault.kurogane.bak`
pub fn backup_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".bak");
    PathBuf::from(s)
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    PathBuf::from(s)
}

/// Create a file readable only by the current user.
pub fn create_private(path: &Path) -> std::io::Result<File> {
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
}

pub fn create_private_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Atomically replace `path` with `bytes`:
///
/// 1. write + fsync a sibling temp file (same filesystem → rename is atomic),
/// 2. if `path` exists and `keep_backup`, copy it to `path.bak` and fsync,
/// 3. rename temp over `path` (atomic replace on POSIX and on Windows via
///    `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`), then fsync the directory.
///
/// A crash at any point leaves either the old or the new file intact.
pub fn atomic_write(path: &Path, bytes: &[u8], keep_backup: bool) -> Result<()> {
    let tmp = tmp_path(path);
    let result = (|| -> Result<()> {
        let mut f = create_private(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        if keep_backup && path.exists() {
            let bak = backup_path(path);
            fs::copy(path, &bak)?;
            // Windows FlushFileBuffers requires a handle with write access;
            // a read-only File::open fails even though the copy succeeded.
            OpenOptions::new().write(true).open(&bak)?.sync_all()?;
        }
        fs::rename(&tmp, path)?;
        sync_parent(path);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn sync_parent(path: &Path) {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        let dir = if parent.as_os_str().is_empty() { Path::new(".") } else { parent };
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Best-effort secure removal. On SSDs/CoW filesystems the overwrite may not
/// reach the original blocks, which is why the working database is *also*
/// SQLCipher-encrypted: leftovers are ciphertext.
pub fn shred(path: &Path) {
    if let Ok(meta) = fs::metadata(path) {
        if let Ok(mut f) = OpenOptions::new().write(true).open(path) {
            let zeros = vec![0u8; 64 * 1024];
            let mut left = meta.len();
            while left > 0 {
                let n = left.min(zeros.len() as u64) as usize;
                if f.write_all(&zeros[..n]).is_err() {
                    break;
                }
                left -= n as u64;
            }
            let _ = f.sync_all();
        }
    }
    let _ = fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_keeps_previous_as_bak() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("v.kurogane");
        atomic_write(&p, b"one", true).unwrap();
        assert!(!backup_path(&p).exists());
        atomic_write(&p, b"two", true).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"two");
        assert_eq!(fs::read(backup_path(&p)).unwrap(), b"one");
        atomic_write(&p, b"three", true).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"three");
        assert_eq!(fs::read(backup_path(&p)).unwrap(), b"two");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
