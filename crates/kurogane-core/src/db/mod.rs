//! SQLCipher-backed data layer.

pub mod models;
mod repo;
pub mod seed;

use std::path::Path;

use rusqlite::{Connection, OptionalExtension};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::secure::Key256;

/// Ordered migrations. Index + 1 = `PRAGMA user_version` after applying.
const MIGRATIONS: &[&str] = &[include_str!("schema_v1.sql")];

pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

pub struct Database {
    conn: Connection,
}

impl std::fmt::Debug for Database {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Database").finish_non_exhaustive()
    }
}

impl Database {
    /// Open (or create) a SQLCipher database with a raw 256-bit key.
    ///
    /// The raw-key form (`x'…'`) skips SQLCipher's internal PBKDF2: our key is
    /// already the output of Argon2id + HKDF, so stretching it again would only
    /// slow down unlock.
    pub fn open(path: &Path, key: &Key256) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn, key)
    }

    /// In-memory encrypted database (tests, fixture generation).
    pub fn open_in_memory(key: &Key256) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn, key)
    }

    fn init(conn: Connection, key: &Key256) -> Result<Self> {
        let cipher_version: Option<String> =
            conn.query_row("PRAGMA cipher_version", [], |r| r.get(0)).optional()?;
        if cipher_version.as_deref().map_or(true, str::is_empty) {
            return Err(Error::SqlCipherMissing);
        }
        // Wrong-key attempts are reported to the caller; keep SQLCipher quiet on stderr.
        conn.execute_batch("PRAGMA cipher_log_level = NONE;").ok();
        let pragma = Zeroizing::new(format!("PRAGMA key = \"x'{}'\";", crate::crypto::hex(key.expose())));
        conn.execute_batch(&pragma)?;
        // Wipe/lock SQLCipher's own page buffers.
        conn.execute_batch("PRAGMA cipher_memory_security = ON;")?;
        // First read verifies the key (HMAC failure → "file is not a database").
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
            .map_err(|_| Error::AuthFailed)?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = DELETE;
             PRAGMA secure_delete = ON;
             PRAGMA temp_store = MEMORY;",
        )?;
        let db = Database { conn };
        db.migrate()?;
        Ok(db)
    }

    pub fn schema_version(&self) -> Result<u32> {
        Ok(self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    fn migrate(&self) -> Result<()> {
        let current = self.schema_version()?;
        if current > SCHEMA_VERSION {
            return Err(Error::malformed(format!(
                "vault schema v{current} is newer than this build (v{SCHEMA_VERSION}); please update Kurogane"
            )));
        }
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
            let tx = self.conn.unchecked_transaction()?;
            tx.execute_batch(sql)?;
            tx.execute_batch(&format!("PRAGMA user_version = {};", i + 1))?;
            tx.commit()?;
        }
        Ok(())
    }

    /// Flush everything to the main file so it can be copied into the container.
    pub fn checkpoint(&self) -> Result<()> {
        // journal_mode=DELETE means no WAL; this is a cheap safety net.
        self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();
        Ok(())
    }

    pub fn cipher_version(&self) -> Result<String> {
        Ok(self.conn.query_row("PRAGMA cipher_version", [], |r| r.get(0))?)
    }

    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlcipher_is_present_and_key_is_enforced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let key = Key256::random();
        {
            let db = Database::open(&path, &key).unwrap();
            assert!(!db.cipher_version().unwrap().is_empty());
            assert_eq!(db.schema_version().unwrap(), SCHEMA_VERSION);
        }
        // Raw file must not contain the SQLite plaintext header.
        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.starts_with(b"SQLite format 3"));
        // Wrong key fails closed.
        assert!(matches!(Database::open(&path, &Key256::random()), Err(Error::AuthFailed)));
        // Right key reopens without re-running migrations.
        assert!(Database::open(&path, &key).is_ok());
    }
}
