//! 1-click operations: SSH in the native terminal, RDP via a generated `.rdp`
//! file, and web UIs in the default browser.
//!
//! Every value that reaches a command line is validated against a strict
//! allow-list first. This is what stops a malicious vault entry (e.g. a host
//! named `-oProxyCommand=…`) from turning a click into code execution.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{Error, Result};

/// Hostname, IPv4, or IPv6 (optionally bracketed). No leading `-`.
pub fn validate_host(host: &str) -> Result<&str> {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    let ok = !h.is_empty()
        && h.len() <= 253
        && !h.starts_with('-')
        && h.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b':' | b'_' | b'%'));
    if ok {
        Ok(h)
    } else {
        Err(Error::invalid(format!("refusing to launch: suspicious host {host:?}")))
    }
}

/// POSIX-ish user names plus `DOMAIN\user` and `user@realm` for RDP.
pub fn validate_user(user: &str) -> Result<&str> {
    let ok = !user.is_empty()
        && user.len() <= 128
        && !user.starts_with('-')
        && user.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b'\\' | b'@' | b'$'));
    if ok {
        Ok(user)
    } else {
        Err(Error::invalid(format!("refusing to launch: suspicious user {user:?}")))
    }
}

/// Only http(s) URLs are opened; `file:`, `javascript:` and custom schemes are refused.
pub fn validate_web_url(url: &str) -> Result<&str> {
    let lower = url.to_ascii_lowercase();
    let ok = (lower.starts_with("https://") || lower.starts_with("http://"))
        && !url.chars().any(|c| c.is_control() || c.is_whitespace() || c == '"' || c == '`');
    if ok {
        Ok(url)
    } else {
        Err(Error::invalid(format!("refusing to open non-http URL {url:?}")))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshTarget {
    pub user: Option<String>,
    pub host: String,
    pub port: u16,
    /// Temporary identity file materialised from the vault (0600, auto-deleted).
    pub identity_file: Option<PathBuf>,
}

impl SshTarget {
    /// `ssh -p 2222 -l root [-i key] -- 10.0.0.21`
    pub fn argv(&self) -> Result<Vec<String>> {
        let host = validate_host(&self.host)?;
        let mut v = vec!["ssh".to_string(), "-p".into(), self.port.to_string()];
        if let Some(u) = &self.user {
            v.push("-l".into());
            v.push(validate_user(u)?.to_string());
        }
        if let Some(id) = &self.identity_file {
            v.push("-i".into());
            v.push(id.display().to_string());
            v.push("-o".into());
            v.push("IdentitiesOnly=yes".into());
        }
        v.push("--".into());
        v.push(host.to_string());
        Ok(v)
    }

    /// `ssh://user@host:port` for OS-level URL handlers.
    pub fn url(&self) -> Result<String> {
        let host = validate_host(&self.host)?;
        let host = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
        Ok(match &self.user {
            Some(u) => format!("ssh://{}@{host}:{}", validate_user(u)?, self.port),
            None => format!("ssh://{host}:{}", self.port),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RdpTarget {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
}

impl RdpTarget {
    /// `.rdp` file body. The password is **never** written here: the client
    /// prompts, or (Windows) Kurogane can stage a short-lived `cmdkey` entry.
    pub fn rdp_file(&self) -> Result<String> {
        let host = validate_host(&self.host)?;
        let mut lines = vec![
            format!("full address:s:{host}:{}", self.port),
            "prompt for credentials:i:1".into(),
            "screen mode id:i:2".into(),
            "use multimon:i:0".into(),
            "session bpp:i:32".into(),
            "authentication level:i:2".into(),
            "enablecredsspsupport:i:1".into(),
            "redirectclipboard:i:1".into(),
            "redirectdrives:i:0".into(),
            "redirectprinters:i:0".into(),
            "audiomode:i:0".into(),
        ];
        if let Some(u) = &self.user {
            lines.push(format!("username:s:{}", validate_user(u)?));
        }
        Ok(lines.join("\r\n") + "\r\n")
    }

    /// FreeRDP command line for Linux hosts without a `.rdp` handler.
    pub fn freerdp_argv(&self, binary: &str) -> Result<Vec<String>> {
        let host = validate_host(&self.host)?;
        let mut v = vec![binary.to_string(), format!("/v:{host}:{}", self.port), "/dynamic-resolution".into(), "+clipboard".into()];
        if let Some(u) = &self.user {
            v.push(format!("/u:{}", validate_user(u)?));
        }
        Ok(v)
    }
}

/// Quote one argument for a POSIX shell (used only for the macOS `.command`
/// fallback; arguments are already allow-listed).
pub fn sh_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// Ordered list of terminal invocations to try on Linux.
pub fn linux_terminal_candidates(argv: &[String]) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    if let Ok(t) = std::env::var("TERMINAL") {
        if !t.is_empty() && !t.contains(char::is_whitespace) {
            out.push([vec![t, "-e".into()], argv.to_vec()].concat());
        }
    }
    let with = |prefix: &[&str]| [prefix.iter().map(|s| s.to_string()).collect::<Vec<_>>(), argv.to_vec()].concat();
    out.push(with(&["x-terminal-emulator", "-e"]));
    out.push(with(&["gnome-terminal", "--"]));
    out.push(with(&["konsole", "-e"]));
    out.push(with(&["kitty"]));
    out.push(with(&["alacritty", "-e"]));
    out.push(with(&["wezterm", "start", "--"]));
    out.push(with(&["foot"]));
    out.push(with(&["xfce4-terminal", "-x"]));
    out.push(with(&["xterm", "-e"]));
    out
}

fn spawn_first(candidates: &[Vec<String>]) -> Result<String> {
    for c in candidates {
        if which::which(&c[0]).is_ok() {
            Command::new(&c[0])
                .args(&c[1..])
                .spawn()
                .map_err(|e| Error::Launch(format!("{}: {e}", c[0])))?;
            return Ok(c[0].clone());
        }
    }
    Err(Error::Launch("no supported terminal emulator found".into()))
}

/// Open an interactive SSH session in the platform's terminal.
pub fn launch_ssh(target: &SshTarget, scratch: &Path) -> Result<String> {
    let argv = target.argv()?;
    if cfg!(target_os = "windows") {
        if which::which("wt.exe").is_ok() {
            Command::new("wt.exe").arg("new-tab").args(&argv).spawn().map_err(|e| Error::Launch(e.to_string()))?;
            return Ok("Windows Terminal".into());
        }
        Command::new("cmd.exe")
            .args(["/C", "start", "\"Kurogane SSH\""])
            .args(&argv)
            .spawn()
            .map_err(|e| Error::Launch(e.to_string()))?;
        Ok("cmd.exe".into())
    } else if cfg!(target_os = "macos") {
        if target.identity_file.is_none() {
            // Terminal.app is the default ssh:// handler on macOS.
            Command::new("open").arg(target.url()?).spawn().map_err(|e| Error::Launch(e.to_string()))?;
            return Ok("ssh:// handler".into());
        }
        let script = scratch.join(format!("kurogane-ssh-{}.command", uuid::Uuid::new_v4().simple()));
        let body = format!("#!/bin/sh\nrm -f {}\nexec {}\n", sh_quote(&script.display().to_string()), argv.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" "));
        std::fs::write(&script, body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
        }
        Command::new("open").args(["-a", "Terminal"]).arg(&script).spawn().map_err(|e| Error::Launch(e.to_string()))?;
        Ok("Terminal.app".into())
    } else {
        spawn_first(&linux_terminal_candidates(&argv))
    }
}

/// Write a `.rdp` file into `scratch` and hand it to the platform client.
pub fn launch_rdp(target: &RdpTarget, scratch: &Path) -> Result<String> {
    let file = scratch.join(format!("kurogane-{}.rdp", uuid::Uuid::new_v4().simple()));
    std::fs::write(&file, target.rdp_file()?)?;
    if cfg!(target_os = "windows") {
        Command::new("mstsc.exe").arg(&file).spawn().map_err(|e| Error::Launch(e.to_string()))?;
        Ok("mstsc".into())
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(&file).spawn().map_err(|e| Error::Launch(e.to_string()))?;
        Ok("Windows App / Microsoft Remote Desktop".into())
    } else {
        for bin in ["xfreerdp3", "xfreerdp", "wlfreerdp"] {
            if which::which(bin).is_ok() {
                let argv = target.freerdp_argv(bin)?;
                Command::new(&argv[0]).args(&argv[1..]).spawn().map_err(|e| Error::Launch(e.to_string()))?;
                let _ = std::fs::remove_file(&file);
                return Ok(bin.into());
            }
        }
        if which::which("remmina").is_ok() {
            Command::new("remmina").arg("-c").arg(&file).spawn().map_err(|e| Error::Launch(e.to_string()))?;
            return Ok("remmina".into());
        }
        Err(Error::Launch("no RDP client found (install FreeRDP or Remmina)".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_argv_is_injection_safe() {
        let t = SshTarget { user: Some("root".into()), host: "10.10.0.21".into(), port: 2222, identity_file: None };
        assert_eq!(t.argv().unwrap(), ["ssh", "-p", "2222", "-l", "root", "--", "10.10.0.21"]);
        assert_eq!(t.url().unwrap(), "ssh://root@10.10.0.21:2222");
        let evil = SshTarget { user: None, host: "-oProxyCommand=touch /tmp/pwn".into(), port: 22, identity_file: None };
        assert!(evil.argv().is_err());
        let evil_user = SshTarget { user: Some("x;rm -rf ~".into()), host: "h".into(), port: 22, identity_file: None };
        assert!(evil_user.argv().is_err());
        let v6 = SshTarget { user: None, host: "fe80::1".into(), port: 22, identity_file: None };
        assert_eq!(v6.url().unwrap(), "ssh://[fe80::1]:22");
    }

    #[test]
    fn rdp_file_never_contains_password_and_validates() {
        let t = RdpTarget { host: "10.10.0.5".into(), port: 3389, user: Some("CORP\\kadmin".into()) };
        let f = t.rdp_file().unwrap();
        assert!(f.contains("full address:s:10.10.0.5:3389\r\n"));
        assert!(f.contains("username:s:CORP\\kadmin"));
        assert!(!f.to_lowercase().contains("password"));
        assert!(RdpTarget { host: "a\r\nalternate shell:s:cmd".into(), port: 1, user: None }.rdp_file().is_err());
    }

    #[test]
    fn web_urls_are_http_only() {
        assert!(validate_web_url("https://git.corp.example/").is_ok());
        assert!(validate_web_url("javascript:alert(1)").is_err());
        assert!(validate_web_url("file:///etc/passwd").is_err());
        assert!(validate_web_url("https://x/ y").is_err());
    }

    #[test]
    fn shell_quote() {
        assert_eq!(sh_quote("a'b"), "'a'\\''b'");
    }
}
