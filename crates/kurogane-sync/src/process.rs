//! Subprocess helpers: cleared environments and hard timeouts.

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::{Result, SyncError};

pub struct Output {
    pub status: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn success(&self) -> bool {
        self.status == Some(0)
    }
    pub fn into_result(self) -> Result<Output> {
        if self.success() {
            Ok(self)
        } else {
            Err(SyncError::Rclone { code: self.status, stderr: tail(&self.stderr, 2000) })
        }
    }
}

fn tail(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        let mut start = s.len() - n;
        while !s.is_char_boundary(start) {
            start += 1;
        }
        format!("…{}", &s[start..])
    }
}

/// Environment variables forwarded from the host into the sandbox: only what
/// is needed for networking (proxies, custom CAs) and for Windows' network stack.
pub const PASSTHROUGH_ENV: &[&str] = &[
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "ComSpec",
    "PATHEXT",
];

pub fn run(mut cmd: Command, stdin: Option<&[u8]>, timeout: Duration) -> Result<Output> {
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(data)?;
    }
    wait(child, timeout)
}

pub fn wait(mut child: Child, timeout: Duration) -> Result<Output> {
    let mut out_pipe = child.stdout.take();
    let mut err_pipe = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(p) = out_pipe.as_mut() {
            let _ = p.read_to_end(&mut b);
        }
        b
    });
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(p) = err_pipe.as_mut() {
            let _ = p.read_to_end(&mut b);
        }
        String::from_utf8_lossy(&b).into_owned()
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break st;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SyncError::Timeout(timeout));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    Ok(Output { status: status.code(), stdout: out_t.join().unwrap_or_default(), stderr: err_t.join().unwrap_or_default() })
}
