//! The local ledger: normalized sessions in SQLite at `~/.sessionly/ledger.db`.
//!
//! Each row keeps the full session record as JSON plus the columns needed to
//! list and filter without parsing it. The ledger is derived data: it can be
//! deleted and rebuilt from the raw capture with `sessionly sync --force`.

use std::path::Path;

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};

use crate::session::Session;

/// Bump to change the table layout; older ledgers are rebuilt on open.
const DB_VERSION: i64 = 1;

const TABLES: &str = "
CREATE TABLE sessions (
    session_id       TEXT PRIMARY KEY,
    source           TEXT NOT NULL,
    schema_version   INTEGER NOT NULL,
    started_at       TEXT,
    ended_at         TEXT,
    duration_ms      INTEGER,
    active_ms        INTEGER NOT NULL,
    cwd              TEXT,
    repo_root        TEXT,
    repo_remote      TEXT,
    branch           TEXT,
    user_name        TEXT,
    user_email       TEXT,
    title            TEXT,
    models           TEXT NOT NULL,
    cost_usd         REAL,
    cost_source      TEXT,
    input_tokens     INTEGER NOT NULL,
    output_tokens    INTEGER NOT NULL,
    prompts          INTEGER NOT NULL,
    tool_calls       INTEGER NOT NULL,
    tool_failures    INTEGER NOT NULL,
    files_changed    INTEGER NOT NULL,
    lines_added      INTEGER NOT NULL,
    lines_removed    INTEGER NOT NULL,
    record           TEXT NOT NULL,
    raw_bytes        INTEGER NOT NULL,
    transcript_path  TEXT,
    transcript_bytes INTEGER NOT NULL,
    synced_at        TEXT NOT NULL
);
CREATE INDEX sessions_started ON sessions(started_at);
CREATE INDEX sessions_repo ON sessions(repo_root);
CREATE TABLE session_files (
    session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    path          TEXT NOT NULL,
    reads         INTEGER NOT NULL,
    writes        INTEGER NOT NULL,
    created       INTEGER NOT NULL,
    lines_added   INTEGER NOT NULL,
    lines_removed INTEGER NOT NULL,
    PRIMARY KEY (session_id, path)
);
CREATE INDEX session_files_path ON session_files(path);
";

/// What a stored session was built from, used to skip unchanged sessions.
#[derive(Debug, Clone, PartialEq)]
pub struct Fingerprint {
    pub schema_version: u32,
    pub raw_bytes: u64,
    pub transcript_path: Option<String>,
    pub transcript_bytes: u64,
}

pub struct Ledger {
    conn: Connection,
}

impl Ledger {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        conn.pragma_update(None, "foreign_keys", true)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version != DB_VERSION {
            // Derived data: drop and let the next sync rebuild it.
            conn.execute_batch(
                "DROP TABLE IF EXISTS session_files; DROP TABLE IF EXISTS sessions;",
            )?;
            conn.execute_batch(TABLES)?;
            conn.pragma_update(None, "user_version", DB_VERSION)?;
        }
        Ok(Ledger { conn })
    }

    pub fn fingerprint(&self, session_id: &str) -> Result<Option<Fingerprint>> {
        Ok(self
            .conn
            .query_row(
                "SELECT schema_version, raw_bytes, transcript_path, transcript_bytes
                 FROM sessions WHERE session_id = ?1",
                [session_id],
                |r| {
                    Ok(Fingerprint {
                        schema_version: r.get(0)?,
                        raw_bytes: r.get(1)?,
                        transcript_path: r.get(2)?,
                        transcript_bytes: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// Insert or replace a session and its file rows.
    pub fn upsert(&mut self, s: &Session, built_from: &Fingerprint) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM sessions WHERE session_id = ?1",
            [&s.session_id],
        )?;
        let repo = s.repo.as_ref();
        let user = s.user.as_ref();
        tx.execute(
            "INSERT INTO sessions VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
             ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30)",
            params![
                s.session_id,
                s.source,
                s.schema_version,
                s.started_at.map(|t| t.to_rfc3339()),
                s.ended_at.map(|t| t.to_rfc3339()),
                s.duration_ms,
                s.active_ms,
                s.cwd,
                repo.map(|r| &r.root),
                repo.and_then(|r| r.remote.as_ref()),
                repo.and_then(|r| r.branch.as_ref()),
                user.and_then(|u| u.name.as_ref()),
                user.and_then(|u| u.email.as_ref()),
                s.title,
                s.models.join(","),
                s.cost.as_ref().map(|c| c.total_usd),
                s.cost.as_ref().map(|c| &c.source),
                s.usage.iter().map(|u| u.input_tokens).sum::<u64>(),
                s.usage.iter().map(|u| u.output_tokens).sum::<u64>(),
                s.counts.prompts,
                s.counts.tool_calls,
                s.counts.tool_failures,
                s.counts.files_changed,
                s.counts.lines_added,
                s.counts.lines_removed,
                serde_json::to_string(s)?,
                built_from.raw_bytes,
                built_from.transcript_path,
                built_from.transcript_bytes,
                chrono::Utc::now().to_rfc3339(),
            ],
        )?;
        {
            let mut insert =
                tx.prepare("INSERT INTO session_files VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")?;
            for f in &s.files {
                insert.execute(params![
                    s.session_id,
                    f.path,
                    f.reads,
                    f.writes,
                    f.created,
                    f.lines_added,
                    f.lines_removed
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Look a session up by id or unique id prefix.
    pub fn get(&self, id_or_prefix: &str) -> Result<Option<Session>> {
        let mut query = self.conn.prepare(
            "SELECT session_id, record FROM sessions
             WHERE substr(session_id, 1, length(?1)) = ?1 ORDER BY session_id LIMIT 6",
        )?;
        let rows: Vec<(String, String)> = query
            .query_map([id_or_prefix], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let record = match rows.as_slice() {
            [] => return Ok(None),
            [(_, record)] => record,
            many => match many.iter().find(|(id, _)| id == id_or_prefix) {
                Some((_, record)) => record,
                None => bail!(
                    "\"{id_or_prefix}\" matches several sessions: {}",
                    many.iter()
                        .map(|(id, _)| id.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            },
        };
        Ok(Some(serde_json::from_str(record)?))
    }

    pub fn count(&self) -> Result<u64> {
        Ok(self
            .conn
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{FileTouched, SCHEMA_VERSION};

    fn session(id: &str) -> Session {
        Session {
            schema_version: SCHEMA_VERSION,
            source: "claude-code".into(),
            session_id: id.into(),
            files: vec![FileTouched {
                path: "/r/a.rs".into(),
                writes: 1,
                lines_added: 3,
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    fn fingerprint(raw_bytes: u64) -> Fingerprint {
        Fingerprint {
            schema_version: SCHEMA_VERSION,
            raw_bytes,
            transcript_path: None,
            transcript_bytes: 0,
        }
    }

    #[test]
    fn stores_and_replaces_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let mut ledger = Ledger::open(&dir.path().join("l.db")).unwrap();
        let mut s = session("abc-1");
        ledger.upsert(&s, &fingerprint(10)).unwrap();
        s.title = Some("renamed".into());
        ledger.upsert(&s, &fingerprint(20)).unwrap();
        assert_eq!(ledger.count().unwrap(), 1);
        assert_eq!(ledger.get("abc-1").unwrap(), Some(s));
        assert_eq!(ledger.fingerprint("abc-1").unwrap(), Some(fingerprint(20)));
        assert_eq!(ledger.fingerprint("nope").unwrap(), None);
        let files: u64 = ledger
            .conn
            .query_row("SELECT count(*) FROM session_files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(files, 1);
    }

    #[test]
    fn finds_by_unique_prefix_only() {
        let dir = tempfile::tempdir().unwrap();
        let mut ledger = Ledger::open(&dir.path().join("l.db")).unwrap();
        for id in ["abc-1", "abc-2", "abd"] {
            ledger.upsert(&session(id), &fingerprint(1)).unwrap();
        }
        assert_eq!(ledger.get("abd").unwrap().unwrap().session_id, "abd");
        assert_eq!(ledger.get("abc-2").unwrap().unwrap().session_id, "abc-2");
        assert!(ledger.get("abc").is_err());
        assert!(ledger.get("zzz").unwrap().is_none());
    }

    #[test]
    fn reopening_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("l.db");
        Ledger::open(&path)
            .unwrap()
            .upsert(&session("s"), &fingerprint(1))
            .unwrap();
        assert_eq!(Ledger::open(&path).unwrap().count().unwrap(), 1);
    }
}
