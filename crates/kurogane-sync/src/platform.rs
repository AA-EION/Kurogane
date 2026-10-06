//! Pinned engine artefacts. Bumping a version means updating the hashes from
//! the PGP-signed `SHA256SUMS` published at downloads.rclone.org.

pub const RCLONE_VERSION: &str = "1.75.1";
pub const RCLONE_DOWNLOAD_BASE: &str = "https://downloads.rclone.org";

/// Multi-arch OCI index digest for `rclone/rclone:1.75.1`. Pinning by digest
/// means a re-tagged or compromised tag on Docker Hub cannot change what runs.
pub const RCLONE_IMAGE: &str =
    "docker.io/rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5";

/// (rust target_os, rust target_arch, rclone os, rclone arch, sha256 of zip)
const PINNED: &[(&str, &str, &str, &str, &str)] = &[
    ("linux", "x86_64", "linux", "amd64", "982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab"),
    ("linux", "aarch64", "linux", "arm64", "03f2504174034b6d004152ed7369251c9a9ec1f7e0836eda420f5c7a5ec0dff9"),
    ("macos", "x86_64", "osx", "amd64", "29253d0288b8fbbac46baad6e5f6add6cb01d462c79f10805bbd4631c4cdf82c"),
    ("macos", "aarch64", "osx", "arm64", "c61d7a371c62bcbbe882c3423aa4b8bf63485c248dd0f692997b8f0c3f6d0c6f"),
    ("windows", "x86_64", "windows", "amd64", "200eb602c126d82aa38b51e0f6b9ae837473ff99b51278d3f6f837574c494d6e"),
    ("windows", "aarch64", "windows", "arm64", "c3c6cd0424dd49076ad179c30c3f9e5cde2c004ec07ea9fe6911f23e32eafe0f"),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RcloneAsset {
    pub file_name: String,
    pub url: String,
    pub sha256: &'static str,
    pub binary_name: &'static str,
}

pub fn asset_for(os: &str, arch: &str) -> Option<RcloneAsset> {
    PINNED.iter().find(|(o, a, ..)| *o == os && *a == arch).map(|(o, _, ros, rarch, sha)| {
        let file_name = format!("rclone-v{RCLONE_VERSION}-{ros}-{rarch}.zip");
        RcloneAsset {
            url: format!("{RCLONE_DOWNLOAD_BASE}/v{RCLONE_VERSION}/{file_name}"),
            file_name,
            sha256: sha,
            binary_name: if *o == "windows" { "rclone.exe" } else { "rclone" },
        }
    })
}

pub fn current_asset() -> Option<RcloneAsset> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_desktop_target_is_pinned() {
        for (os, arch) in [("linux", "x86_64"), ("linux", "aarch64"), ("macos", "x86_64"), ("macos", "aarch64"), ("windows", "x86_64")] {
            let a = asset_for(os, arch).unwrap_or_else(|| panic!("{os}/{arch}"));
            assert_eq!(a.sha256.len(), 64);
            assert!(a.url.starts_with("https://downloads.rclone.org/v1.75.1/rclone-v1.75.1-"));
        }
        assert_eq!(asset_for("windows", "x86_64").unwrap().binary_name, "rclone.exe");
        assert!(RCLONE_IMAGE.contains("@sha256:"));
    }
}
