//! # kurogane-sync
//!
//! Cloud sync for `.kurogane` vaults **without** cloud developer accounts, API
//! keys, or interference with the host's own cloud clients.
//!
//! * The engine is **rclone**, either as a pinned OCI image run as an
//!   ephemeral, locked-down container sidecar (Docker/Podman), or as a
//!   pinned, SHA-256-verified binary downloaded into Kurogane's own sandbox.
//!   Nothing is installed system-wide.
//! * OAuth uses rclone's built-in public clients (Google Drive, OneDrive), so
//!   the user only ever clicks "Allow" in their browser. MEGA uses the
//!   account login directly.
//! * Every invocation runs with a **cleared environment**: its own `HOME`,
//!   `XDG_*`, `RCLONE_CONFIG` and cache inside the sandbox. A host
//!   `~/.config/rclone/rclone.conf` or a logged-in Drive/OneDrive desktop
//!   client is never read or written.
//! * Remote credentials are stored *sealed inside the vault* and materialised
//!   into a throw-away run directory only for the duration of one command;
//!   refreshed tokens are captured back and the file is shredded.

pub mod engine;
pub mod error;
pub mod platform;
pub mod process;
pub mod provision;
pub mod rclone;
pub mod reconcile;
pub mod sandbox;
pub mod state;
pub mod transport;

pub use error::{Result, SyncError};
