//! Clipboard worker: owns the OS clipboard on one thread (required on X11 /
//! Wayland so contents survive) and clears secrets after a deadline — but
//! only if the clipboard still holds *our* secret (compared by SHA-256), so
//! it never wipes something the user copied afterwards.

use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

enum Msg {
    SetSecret(Zeroizing<String>, Duration),
    SetPlain(String),
    ClearIfOurs,
}

#[derive(Clone)]
pub struct ClipboardWorker {
    tx: Sender<Msg>,
}

fn digest(s: &str) -> [u8; 32] {
    Sha256::digest(s.as_bytes()).into()
}

impl ClipboardWorker {
    pub fn spawn() -> Self {
        let (tx, rx) = channel::<Msg>();
        std::thread::Builder::new()
            .name("kurogane-clipboard".into())
            .spawn(move || {
                let mut cb = match arboard::Clipboard::new() {
                    Ok(c) => Some(c),
                    Err(e) => {
                        eprintln!("clipboard unavailable: {e}");
                        None
                    }
                };
                let mut armed: Option<([u8; 32], Instant)> = None;
                let clear = |cb: &mut Option<arboard::Clipboard>, armed: &mut Option<([u8; 32], Instant)>| {
                    if let (Some(c), Some((h, _))) = (cb.as_mut(), armed.as_ref()) {
                        let current = c.get_text().unwrap_or_default();
                        if digest(&current) == *h {
                            let _ = c.set_text(String::new());
                            let _ = c.clear();
                        }
                    }
                    *armed = None;
                };
                loop {
                    let wait = armed.map(|(_, at)| at.saturating_duration_since(Instant::now())).unwrap_or(Duration::from_secs(3600));
                    match rx.recv_timeout(wait) {
                        Ok(Msg::SetSecret(text, ttl)) => {
                            if let Some(c) = cb.as_mut() {
                                if c.set_text(text.as_str().to_owned()).is_ok() {
                                    armed = Some((digest(&text), Instant::now() + ttl));
                                }
                            }
                        }
                        Ok(Msg::SetPlain(text)) => {
                            if let Some(c) = cb.as_mut() {
                                let _ = c.set_text(text);
                            }
                        }
                        Ok(Msg::ClearIfOurs) => clear(&mut cb, &mut armed),
                        Err(RecvTimeoutError::Timeout) => {
                            if armed.is_some_and(|(_, at)| Instant::now() >= at) {
                                clear(&mut cb, &mut armed);
                            }
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            clear(&mut cb, &mut armed);
                            break;
                        }
                    }
                }
            })
            .expect("spawn clipboard thread");
        Self { tx }
    }

    pub fn copy_secret(&self, secret: Zeroizing<String>, ttl: Duration) {
        let _ = self.tx.send(Msg::SetSecret(secret, ttl));
    }

    pub fn copy_plain(&self, text: String) {
        let _ = self.tx.send(Msg::SetPlain(text));
    }

    /// Called on lock: a copied password must not outlive the session.
    pub fn clear_if_ours(&self) {
        let _ = self.tx.send(Msg::ClearIfOurs);
    }
}
