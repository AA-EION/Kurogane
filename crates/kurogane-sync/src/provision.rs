//! Runtime download of the pinned rclone binary into the sandbox.
//!
//! The zip is streamed to `*.part` with a size cap, its SHA-256 compared to
//! the compiled-in pin, and only the single executable entry is extracted.
//! The binary's own hash is then recorded and re-checked before every use, so
//! a swapped executable is detected rather than run.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{Result, SyncError};
use crate::platform::{self, RcloneAsset, RCLONE_VERSION};
use crate::sandbox::Sandbox;

const MAX_ZIP_BYTES: u64 = 200 * 1024 * 1024;

pub struct Provisioner<'a> {
    sandbox: &'a Sandbox,
    asset: RcloneAsset,
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(data_encoding::HEXLOWER.encode(&h.finalize()))
}

impl<'a> Provisioner<'a> {
    pub fn new(sandbox: &'a Sandbox) -> Result<Self> {
        let asset = platform::current_asset()
            .ok_or_else(|| SyncError::UnsupportedPlatform(format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH)))?;
        Ok(Self { sandbox, asset })
    }

    pub fn with_asset(sandbox: &'a Sandbox, asset: RcloneAsset) -> Self {
        Self { sandbox, asset }
    }

    fn dir(&self) -> PathBuf {
        self.sandbox.engines().join("rclone").join(RCLONE_VERSION)
    }

    pub fn binary_path(&self) -> PathBuf {
        self.dir().join(self.asset.binary_name)
    }

    fn record_path(&self) -> PathBuf {
        self.dir().join(format!("{}.sha256", self.asset.binary_name))
    }

    /// Path of a verified, previously installed binary.
    pub fn installed(&self) -> Result<Option<PathBuf>> {
        let bin = self.binary_path();
        if !bin.exists() {
            return Ok(None);
        }
        let recorded = fs::read_to_string(self.record_path()).unwrap_or_default();
        let actual = sha256_file(&bin)?;
        if recorded.trim() != actual {
            return Err(SyncError::Checksum { what: "installed rclone binary".into(), expected: recorded.trim().into(), actual });
        }
        Ok(Some(bin))
    }

    /// Return the verified binary, downloading it first if necessary.
    /// `progress(done, total)` is called as bytes arrive.
    pub fn ensure(&self, mut progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf> {
        match self.installed() {
            Ok(Some(p)) => return Ok(p),
            Ok(None) => {}
            Err(SyncError::Checksum { .. }) => {
                // Tampered or half-written: wipe and reinstall from the pinned source.
                let _ = fs::remove_dir_all(self.dir());
            }
            Err(e) => return Err(e),
        }
        kurogane_core::fsutil::create_private_dir(&self.dir())?;
        let part = self.dir().join(format!("{}.part", self.asset.file_name));
        self.download(&part, &mut progress)?;
        let result = self.install_from_zip(&part);
        let _ = fs::remove_file(&part);
        result
    }

    fn download(&self, dest: &Path, progress: &mut impl FnMut(u64, Option<u64>)) -> Result<()> {
        let agent = ureq::AgentBuilder::new()
            .try_proxy_from_env(true)
            .timeout_connect(std::time::Duration::from_secs(30))
            .timeout_read(std::time::Duration::from_secs(60))
            .user_agent(concat!("kurogane/", env!("CARGO_PKG_VERSION")))
            .build();
        let resp = agent.get(&self.asset.url).call().map_err(|e| SyncError::Download(e.to_string()))?;
        let total = resp.header("Content-Length").and_then(|v| v.parse::<u64>().ok());
        if total.is_some_and(|t| t > MAX_ZIP_BYTES) {
            return Err(SyncError::Download("archive larger than expected".into()));
        }
        let mut reader = resp.into_reader().take(MAX_ZIP_BYTES + 1);
        let mut f = fs::File::create(dest)?;
        let mut buf = vec![0u8; 128 * 1024];
        let mut done = 0u64;
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            done += n as u64;
            if done > MAX_ZIP_BYTES {
                return Err(SyncError::Download("archive larger than expected".into()));
            }
            f.write_all(&buf[..n])?;
            progress(done, total);
        }
        f.sync_all()?;
        Ok(())
    }

    /// Install from a zip already on disk (air-gapped machines: the user
    /// downloads the official zip elsewhere). Still verified against the pin.
    pub fn install_from_zip(&self, zip_path: &Path) -> Result<PathBuf> {
        let actual = sha256_file(zip_path)?;
        if actual != self.asset.sha256 {
            return Err(SyncError::Checksum { what: self.asset.file_name.clone(), expected: self.asset.sha256.into(), actual });
        }
        kurogane_core::fsutil::create_private_dir(&self.dir())?;
        let mut archive = zip::ZipArchive::new(fs::File::open(zip_path)?).map_err(|e| SyncError::Download(e.to_string()))?;
        let mut found = false;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| SyncError::Download(e.to_string()))?;
            let is_binary = entry.is_file() && Path::new(entry.name()).file_name().is_some_and(|n| n == self.asset.binary_name);
            if !is_binary {
                continue;
            }
            let tmp = self.dir().join(format!("{}.new", self.asset.binary_name));
            {
                let mut out = fs::File::create(&tmp)?;
                std::io::copy(&mut entry, &mut out)?;
                out.sync_all()?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&tmp, fs::Permissions::from_mode(0o700))?;
            }
            fs::rename(&tmp, self.binary_path())?;
            found = true;
            break;
        }
        if !found {
            return Err(SyncError::Download(format!("{} not found in archive", self.asset.binary_name)));
        }
        fs::write(self.record_path(), sha256_file(&self.binary_path())?)?;
        Ok(self.binary_path())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_zip(dir: &Path) -> (PathBuf, String) {
        let path = dir.join("rclone-test.zip");
        let mut w = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
        w.start_file("rclone-v0-test/README.txt", opts).unwrap();
        w.write_all(b"readme").unwrap();
        w.start_file("rclone-v0-test/rclone", opts).unwrap();
        w.write_all(b"#!/bin/sh\necho fake rclone\n").unwrap();
        w.finish().unwrap();
        let sha = sha256_file(&path).unwrap();
        (path, sha)
    }

    #[test]
    fn verifies_pin_and_detects_tampering() {
        let tmp = tempfile::tempdir().unwrap();
        let sb = Sandbox::open(tmp.path().join("sb")).unwrap();
        let (zip, sha) = fake_zip(tmp.path());
        let leaked: &'static str = Box::leak(sha.into_boxed_str());
        let asset = RcloneAsset { file_name: "rclone-test.zip".into(), url: String::new(), sha256: leaked, binary_name: "rclone" };
        let p = Provisioner::with_asset(&sb, asset.clone());
        assert!(p.installed().unwrap().is_none());
        let bin = p.install_from_zip(&zip).unwrap();
        assert_eq!(p.installed().unwrap(), Some(bin.clone()));
        fs::write(&bin, b"malware").unwrap();
        assert!(matches!(p.installed(), Err(SyncError::Checksum { .. })));

        let wrong = RcloneAsset { sha256: "00", ..asset };
        assert!(matches!(Provisioner::with_asset(&sb, wrong).install_from_zip(&zip), Err(SyncError::Checksum { .. })));
    }
}
