//! Pure sync decision logic over vault lineage.
//!
//! Each save stamps a fresh random `save_id` and records the previous one as
//! `parent_save_id` (both authenticated by the payload AEAD). Each device also
//! remembers the `save_id` it last synced. That is enough to distinguish a
//! fast-forward from a genuine fork without trusting timestamps.

use kurogane_core::container::Lineage;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    /// Neither side has a vault.
    Nothing,
    InSync,
    /// Only the local side changed since the last sync.
    Push,
    /// Only the remote side changed since the last sync.
    Pull,
    /// Remote is empty: upload the local vault.
    FirstUpload,
    /// No local vault (e.g. "Connect Cloud Vault" on a new machine).
    FirstDownload,
    /// Both sides changed: keep both, never overwrite.
    Conflict,
    /// The remote file is a different vault altogether.
    ForeignVault,
}

pub fn decide(local: Option<&Lineage>, remote: Option<&Lineage>, last_synced: Option<&str>) -> Decision {
    match (local, remote) {
        (None, None) => Decision::Nothing,
        (Some(_), None) => Decision::FirstUpload,
        (None, Some(_)) => Decision::FirstDownload,
        (Some(l), Some(r)) => {
            if l.vault_id != r.vault_id {
                return Decision::ForeignVault;
            }
            if l.save_id == r.save_id {
                return Decision::InSync;
            }
            match last_synced {
                Some(base) if base == l.save_id => Decision::Pull,
                Some(base) if base == r.save_id => Decision::Push,
                _ => {
                    // No (usable) base: accept a direct one-step fast-forward.
                    if r.parent_save_id == l.save_id {
                        Decision::Pull
                    } else if l.parent_save_id == r.save_id {
                        Decision::Push
                    } else {
                        Decision::Conflict
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lin(vault: &str, save: &str, parent: &str, generation: u64) -> Lineage {
        Lineage { vault_id: vault.into(), generation, save_id: save.into(), parent_save_id: parent.into(), saved_at_ms: 0 }
    }

    #[test]
    fn decision_table() {
        let a1 = lin("v", "a1", "a0", 1);
        let a2 = lin("v", "a2", "a1", 2);
        let b2 = lin("v", "b2", "a1", 2);
        let other = lin("w", "x", "y", 1);
        assert_eq!(decide(None, None, None), Decision::Nothing);
        assert_eq!(decide(Some(&a1), None, None), Decision::FirstUpload);
        assert_eq!(decide(None, Some(&a1), None), Decision::FirstDownload);
        assert_eq!(decide(Some(&a1), Some(&a1), Some("a1")), Decision::InSync);
        assert_eq!(decide(Some(&a1), Some(&a2), Some("a1")), Decision::Pull);
        assert_eq!(decide(Some(&a2), Some(&a1), Some("a1")), Decision::Push);
        // Both forked from a1.
        assert_eq!(decide(Some(&a2), Some(&b2), Some("a1")), Decision::Conflict);
        // Fresh device without history: one-step fast-forwards are safe.
        assert_eq!(decide(Some(&a1), Some(&a2), None), Decision::Pull);
        assert_eq!(decide(Some(&a2), Some(&a1), None), Decision::Push);
        assert_eq!(decide(Some(&a2), Some(&b2), None), Decision::Conflict);
        assert_eq!(decide(Some(&a1), Some(&other), None), Decision::ForeignVault);
        // Equal generations are NOT treated as equal content.
        assert_ne!(decide(Some(&a2), Some(&b2), Some("zzz")), Decision::InSync);
    }
}
