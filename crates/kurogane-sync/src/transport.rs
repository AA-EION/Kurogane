//! Transports move vault blobs between the local disk and a remote.
//!
//! [`RcloneTransport`] drives rclone through a [`Runner`]:
//! * [`BinaryRunner`] — the sandboxed, pinned host binary (cleared env);
//! * [`ContainerRunner`] — an ephemeral, locked-down Docker/Podman sidecar.
//!
//! [`FolderTransport`] targets a plain directory (USB stick, NAS mount) and
//! doubles as the test transport for the sync pipeline.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use zeroize::Zeroizing;

use crate::error::{Result, SyncError};
use crate::process::{self, Output};
use crate::rclone::{self, Arg, Provider, RemoteSection};
use crate::sandbox::{RunDir, Sandbox};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransportKind {
    Container,
    Binary,
    Folder,
}

pub trait Transport: Send + Sync {
    fn kind(&self) -> TransportKind;
    /// First `n` bytes of the remote file, or `None` if it does not exist.
    fn read_head(&self, remote: &RemoteSection, path: &str, n: usize) -> Result<Option<Vec<u8>>>;
    fn download(&self, remote: &RemoteSection, path: &str, local: &Path) -> Result<()>;
    /// Upload via a temporary name, keep the previous remote copy as `.bak`,
    /// then rename into place.
    fn upload(&self, local: &Path, remote: &RemoteSection, path: &str) -> Result<()>;
    /// If rclone refreshed OAuth tokens during the last call, the updated
    /// section to re-seal into the vault.
    fn take_refreshed(&self) -> Option<RemoteSection> {
        None
    }
}

// --------------------------------------------------------------------------
// Runners
// --------------------------------------------------------------------------

pub trait Runner: Send + Sync {
    fn kind(&self) -> TransportKind;
    fn run(&self, run: &RunDir, args: &[Arg], stdin: Option<&[u8]>, timeout: Duration) -> Result<Output>;
}

pub struct BinaryRunner {
    pub binary: PathBuf,
    pub sandbox: Sandbox,
}

impl BinaryRunner {
    fn command(&self, run: &RunDir) -> Command {
        let mut cmd = Command::new(&self.binary);
        cmd.env_clear();
        for (k, v) in rclone::isolated_env(&self.sandbox.home(), &self.sandbox.cache(), &run.config_path(), run.path()) {
            cmd.env(k, v);
        }
        cmd.current_dir(run.path());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        cmd
    }
}

impl Runner for BinaryRunner {
    fn kind(&self) -> TransportKind {
        TransportKind::Binary
    }

    fn run(&self, run: &RunDir, args: &[Arg], stdin: Option<&[u8]>, timeout: Duration) -> Result<Output> {
        let mut cmd = self.command(run);
        cmd.arg("--config").arg(run.config_path()).arg("--cache-dir").arg(self.sandbox.cache().join("rclone"));
        for a in args {
            match a {
                Arg::Lit(s) => cmd.arg(s),
                Arg::Local(p) => cmd.arg(p),
            };
        }
        process::run(cmd, stdin, timeout)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeFlavor {
    Docker,
    Podman,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRuntime {
    pub flavor: RuntimeFlavor,
    pub binary: PathBuf,
    pub server_version: String,
}

impl ContainerRuntime {
    /// First healthy runtime: Docker (incl. Docker Desktop), then Podman.
    pub fn detect() -> Option<Self> {
        for (name, flavor) in [("docker", RuntimeFlavor::Docker), ("podman", RuntimeFlavor::Podman)] {
            let Ok(binary) = which::which(name) else { continue };
            let format = match flavor {
                RuntimeFlavor::Docker => "{{.ServerVersion}}",
                RuntimeFlavor::Podman => "{{.Version.Version}}",
            };
            let mut cmd = Command::new(&binary);
            cmd.args(["info", "--format", format]);
            if let Ok(out) = process::run(cmd, None, Duration::from_secs(8)) {
                let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if out.success() && !v.is_empty() {
                    return Some(ContainerRuntime { flavor, binary, server_version: v });
                }
            }
        }
        None
    }

    /// Pull the digest-pinned image if it is not present yet.
    pub fn ensure_image(&self, image: &str) -> Result<()> {
        let mut inspect = Command::new(&self.binary);
        inspect.args(["image", "inspect", "--format", "{{.Id}}", image]);
        if process::run(inspect, None, Duration::from_secs(15))?.success() {
            return Ok(());
        }
        let mut pull = Command::new(&self.binary);
        pull.args(["pull", image]);
        process::run(pull, None, Duration::from_secs(600))?.into_result().map(|_| ())
    }
}

pub struct ContainerRunner {
    pub runtime: ContainerRuntime,
    pub image: String,
}

impl ContainerRunner {
    /// Map host paths to container mounts; returns (args, mounts).
    fn map_args(args: &[Arg]) -> Result<(Vec<String>, Vec<(PathBuf, String)>)> {
        let mut mounts: Vec<(PathBuf, String)> = Vec::new();
        let mut mapped = Vec::with_capacity(args.len());
        for a in args {
            match a {
                Arg::Lit(s) => mapped.push(s.clone()),
                Arg::Local(p) => {
                    let parent = p.parent().ok_or_else(|| SyncError::Config(format!("no parent dir for {}", p.display())))?.to_path_buf();
                    let name = p.file_name().ok_or_else(|| SyncError::Config(format!("no file name in {}", p.display())))?.to_string_lossy().into_owned();
                    let idx = match mounts.iter().position(|(d, _)| *d == parent) {
                        Some(i) => i,
                        None => {
                            mounts.push((parent, format!("/data{}", mounts.len())));
                            mounts.len() - 1
                        }
                    };
                    mapped.push(format!("{}/{name}", mounts[idx].1));
                }
            }
        }
        Ok((mapped, mounts))
    }

    pub fn docker_argv(&self, run: &RunDir, args: &[Arg], interactive: bool) -> Result<Vec<String>> {
        let (mapped, mounts) = Self::map_args(args)?;
        let selinux = if self.runtime.flavor == RuntimeFlavor::Podman && cfg!(target_os = "linux") { ",Z" } else { "" };
        let mut v: Vec<String> = [
            "run", "--rm", "--pull=never", "--network=bridge", "--read-only", "--cap-drop=ALL",
            "--security-opt=no-new-privileges", "--pids-limit=256", "--memory=512m",
            "--tmpfs", "/tmp:rw,size=64m,mode=1777",
            "-e", "HOME=/tmp", "-e", "RCLONE_CONFIG=/config/rclone.conf", "-e", "RCLONE_CACHE_DIR=/tmp/cache",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        if interactive {
            v.push("-i".into());
        }
        for k in ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"] {
            if let Ok(val) = std::env::var(k) {
                v.push("-e".into());
                v.push(format!("{k}={val}"));
            }
        }
        match self.runtime.flavor {
            RuntimeFlavor::Podman => v.push("--userns=keep-id".into()),
            RuntimeFlavor::Docker => {
                #[cfg(unix)]
                {
                    // SAFETY: getuid/getgid have no preconditions.
                    let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
                    v.push("--user".into());
                    v.push(format!("{uid}:{gid}"));
                }
            }
        }
        v.push("-v".into());
        v.push(format!("{}:/config:rw{selinux}", run.path().display()));
        for (host, ctr) in &mounts {
            v.push("-v".into());
            v.push(format!("{}:{ctr}:rw{selinux}", host.display()));
        }
        v.push(self.image.clone());
        v.extend(["--config".to_string(), "/config/rclone.conf".to_string(), "--cache-dir".into(), "/tmp/cache".into()]);
        v.extend(mapped);
        Ok(v)
    }
}

impl Runner for ContainerRunner {
    fn kind(&self) -> TransportKind {
        TransportKind::Container
    }

    fn run(&self, run: &RunDir, args: &[Arg], stdin: Option<&[u8]>, timeout: Duration) -> Result<Output> {
        let argv = self.docker_argv(run, args, stdin.is_some())?;
        let mut cmd = Command::new(&self.runtime.binary);
        cmd.args(&argv);
        process::run(cmd, stdin, timeout)
    }
}

// --------------------------------------------------------------------------
// rclone-backed transport
// --------------------------------------------------------------------------

pub struct RcloneTransport {
    runner: Box<dyn Runner>,
    sandbox: Sandbox,
    refreshed: Mutex<Option<RemoteSection>>,
    pub timeout: Duration,
}

impl RcloneTransport {
    pub fn new(runner: Box<dyn Runner>, sandbox: Sandbox) -> Self {
        Self { runner, sandbox, refreshed: Mutex::new(None), timeout: Duration::from_secs(600) }
    }

    fn exec(&self, section: &RemoteSection, args: Vec<Arg>) -> Result<Output> {
        let run = self.sandbox.new_run_dir()?;
        {
            use std::io::Write;
            let mut f = kurogane_core::fsutil::create_private(&run.config_path())?;
            f.write_all(section.to_conf().as_bytes())?;
        }
        let mut full = args;
        full.extend(rclone::common_flags());
        let out = self.runner.run(&run, &full, None, self.timeout)?;
        // Capture tokens rclone refreshed and wrote back into the config.
        if let Ok(text) = fs::read_to_string(run.config_path()) {
            let text = Zeroizing::new(text);
            if let Ok(after) = RemoteSection::parse(&text) {
                if &after != section {
                    *self.refreshed.lock().unwrap() = Some(after);
                }
            }
        }
        Ok(out) // `run` drops here → config shredded
    }

    fn is_not_found(out: &Output) -> bool {
        // rclone exit codes: 3 = directory not found, 4 = file not found.
        matches!(out.status, Some(3) | Some(4)) || out.stderr.contains("not found") || out.stderr.contains("doesn't exist")
    }
}

impl Transport for RcloneTransport {
    fn kind(&self) -> TransportKind {
        self.runner.kind()
    }

    fn read_head(&self, remote: &RemoteSection, path: &str, n: usize) -> Result<Option<Vec<u8>>> {
        let spec = rclone::remote_spec(path)?;
        let out = self.exec(remote, vec!["cat".into(), spec.into(), "--count".into(), n.to_string().into()])?;
        if out.success() && !out.stdout.is_empty() {
            Ok(Some(out.stdout))
        } else if Self::is_not_found(&out) || (out.success() && out.stdout.is_empty()) {
            Ok(None)
        } else {
            Err(out.into_result().err().unwrap())
        }
    }

    fn download(&self, remote: &RemoteSection, path: &str, local: &Path) -> Result<()> {
        let spec = rclone::remote_spec(path)?;
        self.exec(remote, vec!["copyto".into(), spec.into(), Arg::Local(local.to_path_buf())])?.into_result()?;
        Ok(())
    }

    fn upload(&self, local: &Path, remote: &RemoteSection, path: &str) -> Result<()> {
        let final_spec = rclone::remote_spec(path)?;
        let tmp_spec = rclone::remote_spec(&format!("{path}.{}.partial", &uuid::Uuid::new_v4().simple().to_string()[..8]))?;
        let bak_spec = rclone::remote_spec(&format!("{path}.bak"))?;
        self.exec(remote, vec!["copyto".into(), Arg::Local(local.to_path_buf()), tmp_spec.clone().into()])?.into_result()?;
        if self.read_head(remote, path, 1)?.is_some() {
            // Server-side copy where the provider supports it.
            self.exec(remote, vec!["copyto".into(), final_spec.clone().into(), bak_spec.into()])?.into_result()?;
        }
        self.exec(remote, vec!["moveto".into(), tmp_spec.into(), final_spec.into()])?.into_result()?;
        Ok(())
    }

    fn take_refreshed(&self) -> Option<RemoteSection> {
        self.refreshed.lock().unwrap().take()
    }
}

// --------------------------------------------------------------------------
// Plain folder transport
// --------------------------------------------------------------------------

pub struct FolderTransport {
    pub root: PathBuf,
}

impl FolderTransport {
    fn resolve(&self, path: &str) -> Result<PathBuf> {
        rclone::remote_spec(path)?; // same validation as remote paths
        Ok(self.root.join(path.trim_start_matches('/')))
    }
}

impl Transport for FolderTransport {
    fn kind(&self) -> TransportKind {
        TransportKind::Folder
    }

    fn read_head(&self, _: &RemoteSection, path: &str, n: usize) -> Result<Option<Vec<u8>>> {
        use std::io::Read;
        match fs::File::open(self.resolve(path)?) {
            Ok(f) => {
                let mut buf = Vec::with_capacity(n);
                f.take(n as u64).read_to_end(&mut buf)?;
                Ok(Some(buf))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn download(&self, _: &RemoteSection, path: &str, local: &Path) -> Result<()> {
        fs::copy(self.resolve(path)?, local)?;
        Ok(())
    }

    fn upload(&self, local: &Path, _: &RemoteSection, path: &str) -> Result<()> {
        let dest = self.resolve(path)?;
        if let Some(p) = dest.parent() {
            fs::create_dir_all(p)?;
        }
        kurogane_core::fsutil::atomic_write(&dest, &fs::read(local)?, true)?;
        Ok(())
    }
}

// --------------------------------------------------------------------------
// Account linking — no developer registration required
// --------------------------------------------------------------------------

/// Run `rclone authorize <provider>` with rclone's built-in OAuth client.
/// `on_url` receives the local consent URL to open in the user's browser.
pub fn authorize_oauth(
    binary: &Path,
    sandbox: &Sandbox,
    provider: Provider,
    on_url: &mut dyn FnMut(&str),
    timeout: Duration,
) -> Result<RemoteSection> {
    use std::io::{BufRead, BufReader};
    if !provider.uses_oauth() {
        return Err(SyncError::Config(format!("{provider:?} does not use OAuth")));
    }
    let run = sandbox.new_run_dir()?;
    let runner = BinaryRunner { binary: binary.to_path_buf(), sandbox: sandbox.clone() };
    let mut cmd = runner.command(&run);
    cmd.arg("authorize").arg(provider.rclone_type());
    if let Some(opts) = provider.authorize_options() {
        cmd.arg(rclone::authorize_blob(opts));
    }
    cmd.arg("--auth-no-open-browser").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stderr = child.stderr.take().expect("piped");
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let reader = std::thread::spawn(move || {
        let mut all = String::new();
        for line in BufReader::new(stderr).lines().map_while(|l| l.ok()) {
            if let Some(url) = rclone::parse_auth_url(&line) {
                let _ = tx.send(url);
            }
            all.push_str(&line);
            all.push('\n');
        }
        all
    });
    let stdout = child.stdout.take().expect("piped");
    let out_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut BufReader::new(stdout), &mut s);
        Zeroizing::new(s)
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        while let Ok(url) = rx.try_recv() {
            on_url(&url);
        }
        if let Some(st) = child.try_wait()? {
            break st;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return Err(SyncError::Timeout(timeout));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let stderr_all = reader.join().unwrap_or_default();
    let stdout_all = out_reader.join().unwrap_or_default();
    if !status.success() {
        return Err(SyncError::Auth(stderr_all.lines().last().unwrap_or("rclone authorize failed").to_string()));
    }
    let token = rclone::parse_authorize_output(&stdout_all)?;
    let mut section = RemoteSection::new(provider);
    section.set("token", &token);
    if provider == Provider::OneDrive {
        let (drive_id, drive_type) = onedrive_default_drive(&token)?;
        section.set("drive_id", &drive_id).set("drive_type", &drive_type);
    }
    Ok(section)
}

/// OneDrive remotes need the drive id/type rclone normally asks for
/// interactively; read them from Microsoft Graph with the fresh token.
fn onedrive_default_drive(token_json: &str) -> Result<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(token_json)?;
    let access = v.get("access_token").and_then(|a| a.as_str()).ok_or_else(|| SyncError::Auth("no access token".into()))?;
    let agent = ureq::AgentBuilder::new().try_proxy_from_env(true).timeout(Duration::from_secs(30)).build();
    let resp: serde_json::Value = agent
        .get("https://graph.microsoft.com/v1.0/me/drive")
        .set("Authorization", &format!("Bearer {access}"))
        .call()
        .map_err(|e| SyncError::Auth(format!("Graph /me/drive: {e}")))
        .and_then(|r| serde_json::from_reader(r.into_reader()).map_err(SyncError::from))?;
    let id = resp.get("id").and_then(|x| x.as_str()).ok_or_else(|| SyncError::Auth("drive id missing".into()))?;
    let ty = resp.get("driveType").and_then(|x| x.as_str()).unwrap_or("personal");
    Ok((id.to_string(), ty.to_string()))
}

/// MEGA uses the account login directly. The password goes to rclone over
/// stdin (never argv, which other local users can read) to be obscured.
pub fn mega_section(binary: &Path, sandbox: &Sandbox, user: &str, password: &str) -> Result<RemoteSection> {
    let run = sandbox.new_run_dir()?;
    let runner = BinaryRunner { binary: binary.to_path_buf(), sandbox: sandbox.clone() };
    let mut input = Zeroizing::new(password.as_bytes().to_vec());
    input.push(b'\n');
    let out = runner.run(&run, &[Arg::from("obscure"), Arg::from("-")], Some(&input), Duration::from_secs(30))?.into_result()?;
    let obscured = Zeroizing::new(String::from_utf8_lossy(&out.stdout).trim().to_string());
    let mut s = RemoteSection::new(Provider::Mega);
    s.set("user", user).set("pass", &obscured);
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_argv_is_locked_down_and_maps_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let sb = Sandbox::open(tmp.path()).unwrap();
        let run = sb.new_run_dir().unwrap();
        let r = ContainerRunner {
            runtime: ContainerRuntime { flavor: RuntimeFlavor::Docker, binary: "docker".into(), server_version: "27".into() },
            image: crate::platform::RCLONE_IMAGE.into(),
        };
        let local = tmp.path().join("staging").join("v.kurogane");
        let argv = r.docker_argv(&run, &[Arg::from("copyto"), Arg::from("kgremote:a"), Arg::Local(local)], false).unwrap();
        let joined = argv.join(" ");
        for must in ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--network=bridge", "--rm", "--pull=never"] {
            assert!(argv.iter().any(|a| a == must), "missing {must}");
        }
        assert!(joined.contains(":/config:rw"));
        assert!(joined.contains(":/data0:rw"));
        assert!(joined.ends_with("copyto kgremote:a /data0/v.kurogane"));
        assert!(joined.contains("@sha256:"));
        // Host HOME / rclone config are never mounted.
        assert!(!joined.contains(".config/rclone"));
    }

    #[test]
    fn folder_transport_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let t = FolderTransport { root: tmp.path().join("remote") };
        let sec = RemoteSection::new(Provider::Local);
        assert!(t.read_head(&sec, "v.kurogane", 4).unwrap().is_none());
        let local = tmp.path().join("l");
        fs::write(&local, b"KUROGANE\0rest").unwrap();
        t.upload(&local, &sec, "Kurogane/v.kurogane").unwrap();
        assert_eq!(t.read_head(&sec, "Kurogane/v.kurogane", 8).unwrap().unwrap(), b"KUROGANE");
        assert!(t.read_head(&sec, "../escape", 1).is_err());
    }
}
