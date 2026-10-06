//! rclone invocation building, isolated environments, config sections and
//! OAuth output parsing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{Result, SyncError};

/// Fixed section name used inside every materialised rclone.conf.
pub const REMOTE_NAME: &str = "kgremote";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Drive,
    OneDrive,
    Mega,
    WebDav,
    Local,
}

impl Provider {
    pub fn rclone_type(self) -> &'static str {
        match self {
            Provider::Drive => "drive",
            Provider::OneDrive => "onedrive",
            Provider::Mega => "mega",
            Provider::WebDav => "webdav",
            Provider::Local => "local",
        }
    }
    pub fn from_rclone_type(t: &str) -> Option<Self> {
        Some(match t {
            "drive" => Provider::Drive,
            "onedrive" => Provider::OneDrive,
            "mega" => Provider::Mega,
            "webdav" => Provider::WebDav,
            "local" => Provider::Local,
            _ => return None,
        })
    }
    /// Providers whose login is an OAuth browser consent via rclone's built-in client.
    pub fn uses_oauth(self) -> bool {
        matches!(self, Provider::Drive | Provider::OneDrive)
    }
    /// Extra options passed to `rclone authorize` as rclone's base64 JSON blob.
    /// Drive is restricted to `drive.file`: Kurogane can only see files it
    /// created itself, never the rest of the user's Drive.
    pub fn authorize_options(self) -> Option<&'static str> {
        match self {
            Provider::Drive => Some(r#"{"scope":"drive.file"}"#),
            _ => None,
        }
    }
}

/// One `[kgremote]` section of an rclone.conf. Values may include OAuth
/// tokens, so the type zeroizes on drop and redacts on Debug.
#[derive(Clone, PartialEq, Eq)]
pub struct RemoteSection {
    pub provider: Provider,
    pub options: BTreeMap<String, Zeroizing<String>>,
}

impl std::fmt::Debug for RemoteSection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteSection").field("provider", &self.provider).field("keys", &self.options.keys().collect::<Vec<_>>()).finish()
    }
}

impl RemoteSection {
    pub fn new(provider: Provider) -> Self {
        let mut s = Self { provider, options: BTreeMap::new() };
        if provider == Provider::Drive {
            s.set("scope", "drive.file");
        }
        s
    }

    pub fn set(&mut self, k: &str, v: &str) -> &mut Self {
        self.options.insert(k.to_string(), Zeroizing::new(v.to_string()));
        self
    }

    pub fn get(&self, k: &str) -> Option<&str> {
        self.options.get(k).map(|v| v.as_str())
    }

    /// Body without the `[name]` line — the form sealed into the vault.
    pub fn to_body(&self) -> Zeroizing<String> {
        let mut out = Zeroizing::new(format!("type = {}\n", self.provider.rclone_type()));
        for (k, v) in &self.options {
            if k != "type" {
                out.push_str(&format!("{k} = {}\n", v.as_str()));
            }
        }
        out
    }

    pub fn to_conf(&self) -> Zeroizing<String> {
        Zeroizing::new(format!("[{REMOTE_NAME}]\n{}", self.to_body().as_str()))
    }

    /// Parse either a bare body or a full rclone.conf (picks `[kgremote]`).
    pub fn parse(text: &str) -> Result<Self> {
        let mut in_section = !text.trim_start().starts_with('[');
        let mut opts = BTreeMap::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
                continue;
            }
            if line.starts_with('[') {
                in_section = line == format!("[{REMOTE_NAME}]");
                continue;
            }
            if in_section {
                if let Some((k, v)) = line.split_once('=') {
                    opts.insert(k.trim().to_string(), Zeroizing::new(v.trim().to_string()));
                }
            }
        }
        let t = opts.remove("type").ok_or_else(|| SyncError::Config("rclone section has no type".into()))?;
        let provider = Provider::from_rclone_type(&t).ok_or_else(|| SyncError::Config(format!("unsupported rclone type {}", t.as_str())))?;
        Ok(Self { provider, options: opts })
    }
}

/// `kgremote:<path>` with validation (no leading `-`, no `..` traversal).
/// Leading `/` is kept: it is root-relative on cloud backends and absolute
/// for the `local` backend.
pub fn remote_spec(path: &str) -> Result<String> {
    let p = path.trim_start_matches('/');
    if p.is_empty() || p.starts_with('-') || p.split('/').any(|s| s == "..") || path.chars().any(|c| c.is_control()) {
        return Err(SyncError::Config(format!("invalid remote path {path:?}")));
    }
    Ok(format!("{REMOTE_NAME}:{path}"))
}

/// Paths are abstract until a runner maps them (host path vs container mount).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Arg {
    Lit(String),
    /// A local file the command reads or writes.
    Local(PathBuf),
}

impl From<&str> for Arg {
    fn from(s: &str) -> Self {
        Arg::Lit(s.to_string())
    }
}
impl From<String> for Arg {
    fn from(s: String) -> Self {
        Arg::Lit(s)
    }
}

/// Flags applied to every invocation (the runner adds `--config`).
pub fn common_flags() -> Vec<Arg> {
    [
        "--ask-password=false",
        "--log-level", "NOTICE",
        "--stats", "0",
        "--retries", "3",
        "--low-level-retries", "10",
        "--contimeout", "30s",
        "--timeout", "5m",
        "--use-mmap",
    ]
    .into_iter()
    .map(Arg::from)
    .collect()
}

/// Environment for a sandboxed host binary: cleared, then rebuilt so rclone
/// can only see Kurogane's sandbox.
pub fn isolated_env(home: &Path, cache: &Path, config: &Path, tmp: &Path) -> Vec<(String, String)> {
    let mut env = vec![
        ("HOME".to_string(), home.display().to_string()),
        ("USERPROFILE".into(), home.display().to_string()),
        ("APPDATA".into(), home.join("AppData").display().to_string()),
        ("LOCALAPPDATA".into(), home.join("AppData").display().to_string()),
        ("XDG_CONFIG_HOME".into(), home.join(".config").display().to_string()),
        ("XDG_CACHE_HOME".into(), cache.display().to_string()),
        ("RCLONE_CONFIG".into(), config.display().to_string()),
        ("RCLONE_CACHE_DIR".into(), cache.join("rclone").display().to_string()),
        ("TMPDIR".into(), tmp.display().to_string()),
        ("TEMP".into(), tmp.display().to_string()),
        ("TMP".into(), tmp.display().to_string()),
        ("PATH".into(), String::new()),
    ];
    for k in crate::process::PASSTHROUGH_ENV {
        if let Ok(v) = std::env::var(k) {
            env.push((k.to_string(), v));
        }
    }
    env
}

/// Extract the token JSON from `rclone authorize` stdout:
///
/// ```text
/// Paste the following into your remote machine --->
/// {"access_token":"…","token_type":"Bearer","refresh_token":"…","expiry":"…"}
/// <---End paste
/// ```
pub fn parse_authorize_output(stdout: &str) -> Result<Zeroizing<String>> {
    let start = stdout.find("--->").ok_or_else(|| SyncError::Auth("no token in rclone output".into()))? + 4;
    let end = stdout[start..].find("<---End paste").ok_or_else(|| SyncError::Auth("unterminated token block".into()))? + start;
    let token = stdout[start..end].trim();
    let v: serde_json::Value = serde_json::from_str(token).map_err(|_| SyncError::Auth("token is not JSON".into()))?;
    if v.get("access_token").is_none() && v.get("refresh_token").is_none() {
        return Err(SyncError::Auth("token JSON has no access/refresh token".into()));
    }
    Ok(Zeroizing::new(token.to_string()))
}

/// Find the local consent URL rclone prints when told not to open a browser.
pub fn parse_auth_url(line: &str) -> Option<String> {
    let i = line.find("http://127.0.0.1:53682/")?;
    let url: String = line[i..].chars().take_while(|c| !c.is_whitespace()).collect();
    Some(url)
}

/// rclone's base64 option blob for `rclone authorize <type> <blob>`.
pub fn authorize_blob(json: &str) -> String {
    data_encoding::BASE64URL_NOPAD.encode(json.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_roundtrip_and_redaction() {
        let mut s = RemoteSection::new(Provider::Drive);
        s.set("token", r#"{"access_token":"ya29.SECRET"}"#);
        let conf = s.to_conf();
        assert!(conf.starts_with("[kgremote]\ntype = drive\n"));
        assert!(conf.contains("scope = drive.file"));
        let back = RemoteSection::parse(&conf).unwrap();
        assert_eq!(back, s);
        assert_eq!(RemoteSection::parse(&s.to_body()).unwrap(), s);
        assert!(!format!("{s:?}").contains("SECRET"));
    }

    #[test]
    fn parses_authorize_output() {
        let out = "2026/10/06 NOTICE: ...\nPaste the following into your remote machine --->\n{\"access_token\":\"a\",\"refresh_token\":\"r\",\"expiry\":\"2026-10-06T05:00:00Z\"}\n<---End paste\n";
        assert_eq!(parse_authorize_output(out).unwrap().as_str(), r#"{"access_token":"a","refresh_token":"r","expiry":"2026-10-06T05:00:00Z"}"#);
        assert!(parse_authorize_output("nothing").is_err());
        let line = "NOTICE: Log in and authorize rclone for access\nNOTICE: please go to the following link: http://127.0.0.1:53682/auth?state=abc123";
        assert_eq!(parse_auth_url(line).unwrap(), "http://127.0.0.1:53682/auth?state=abc123");
    }

    #[test]
    fn remote_paths_are_validated() {
        assert_eq!(remote_spec("Kurogane/infra.kurogane").unwrap(), "kgremote:Kurogane/infra.kurogane");
        assert!(remote_spec("../x").is_err());
        assert!(remote_spec("--config=/etc/passwd").is_err());
    }
}
