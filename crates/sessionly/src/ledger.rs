//! The local ledger: normalized sessions in SQLite at `~/.sessionly/ledger.db`.
//!
//! Each row keeps the full session record as JSON plus the columns needed to
//! list, filter and aggregate without parsing it. The ledger is derived data:
//! it can be deleted and rebuilt with `sessionly sync --force` from the raw
//! capture and the saved transcript facts.

use std::path::Path;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::types::Value as Sql;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row as SqlRow};
use serde::Serialize;

use crate::rewrite::{FileLines, CHECKPOINTS, REWRITTEN_BELOW};
use crate::session::{RewriteCheckpoint, Session};

/// Bump to change the table layout; older ledgers are rebuilt on open.
const DB_VERSION: i64 = 5;

const TABLES: &str = "
CREATE TABLE sessions (
    session_id       TEXT PRIMARY KEY,
    source           TEXT NOT NULL,
    schema_version   INTEGER NOT NULL,
    built_with       TEXT NOT NULL,
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
    first_prompt     TEXT,
    models           TEXT NOT NULL,
    primary_model    TEXT,
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
    search_text      TEXT NOT NULL,
    record           TEXT NOT NULL,
    raw_bytes        INTEGER NOT NULL,
    transcript_path  TEXT,
    transcript_bytes INTEGER NOT NULL,
    synced_at        TEXT NOT NULL
);
CREATE INDEX sessions_started ON sessions(started_at);
CREATE TABLE session_files (
    session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    path          TEXT NOT NULL,
    reads         INTEGER NOT NULL,
    writes        INTEGER NOT NULL,
    created       INTEGER NOT NULL,
    lines_added   INTEGER NOT NULL,
    lines_removed INTEGER NOT NULL,
    -- hashes of the lines the agent added (8 bytes each), for the rewrite rate
    added_hashes  BLOB,
    -- which model wrote them: JSON [[model or null, count], ...], in the
    -- order of the hashes
    added_models  TEXT,
    PRIMARY KEY (session_id, path)
);
CREATE INDEX session_files_path ON session_files(path);
-- Latest rewrite measurement per changed file. Not tied to the session row,
-- so it survives a session being rebuilt.
CREATE TABLE rewrite (
    session_id  TEXT NOT NULL,
    path        TEXT NOT NULL,
    added       INTEGER NOT NULL,
    surviving   INTEGER NOT NULL,
    file_exists INTEGER NOT NULL,
    branch      TEXT,
    head        TEXT,
    measured_at TEXT NOT NULL,
    PRIMARY KEY (session_id, path)
);
-- What each server was last sent for a session. Losing this table only
-- means everything is sent again, which a server treats as a replacement.
CREATE TABLE uploads (
    session_id  TEXT NOT NULL,
    server      TEXT NOT NULL,
    hash        TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    PRIMARY KEY (session_id, server)
);
";

/// What this machine last learned from each server. Made on open if it is
/// missing, so that adding it rebuilt no ledger (which would send every
/// session again). Losing it only means asking a server once more.
const SERVERS: &str = "
CREATE TABLE IF NOT EXISTS servers (
    server        TEXT PRIMARY KEY,
    -- how many times its person had allowed a repository again, when this
    -- machine last compared what it sent with what the server has
    allowed_again INTEGER NOT NULL
);
";

/// Sessions that were uploaded and are sessions no more (`Ledger::remove`):
/// each server that has one is still to be told, once it has the session
/// that one is part of now (`part_of`). Made apart from the tables above,
/// which a ledger of an earlier version has without it.
const WITHDRAWALS: &str = "
CREATE TABLE IF NOT EXISTS withdrawals (
    session_id TEXT NOT NULL,
    server     TEXT NOT NULL,
    source     TEXT NOT NULL,
    part_of    TEXT NOT NULL,
    PRIMARY KEY (session_id, server)
);
";

/// The rewrite measurement of a session as it was at fixed ages after it
/// ended (`rewrite::CHECKPOINTS`). A row is written once and never changed:
/// what was there on day 7 cannot be measured again on day 8. Made apart from
/// the tables above, so that a change to their layout, which drops them,
/// leaves these. Each says which end of the session its age was counted
/// from: one of another end is of a session that went on since, or whose
/// end was read again, and goes. `checkpoints_since` is when this ledger began keeping them:
/// an age a session reached before that was not measured then, and is not
/// made up later.
const CHECKPOINT_TABLES: &str = "
CREATE TABLE IF NOT EXISTS rewrite_checkpoints (
    session_id  TEXT NOT NULL,
    checkpoint  TEXT NOT NULL CHECK (checkpoint IN ('1d', '7d', '30d')),
    added       INTEGER NOT NULL,
    surviving   INTEGER NOT NULL,
    measured_at TEXT NOT NULL,
    -- how long after the session ended it was measured: the age, or more
    age_seconds INTEGER NOT NULL,
    -- when the session had ended, as the age was counted
    ended_at    TEXT NOT NULL,
    PRIMARY KEY (session_id, checkpoint)
);
CREATE TABLE IF NOT EXISTS checkpoints_since (
    only_row INTEGER PRIMARY KEY CHECK (only_row = 1),
    since    TEXT NOT NULL
);
";

/// A session a server has that is a session no more.
#[derive(Debug, PartialEq)]
pub struct Withdrawal {
    pub session_id: String,
    /// The agent it was of.
    pub source: String,
    /// The session that holds its work now.
    pub part_of: String,
}

/// Per-session rewrite totals, joined into listings.
const REWRITE_TOTALS: &str = "
    (SELECT session_id,
            count(*) AS rw_files,
            sum(surviving * 1.0 / added < ?1) AS rw_rewritten,
            sum(added) AS rw_added,
            sum(surviving) AS rw_surviving,
            max(measured_at) AS rw_measured_at
     FROM rewrite WHERE added > 0 GROUP BY session_id) r";

/// What a stored session was built from, used to skip unchanged sessions.
#[derive(Debug, Clone, PartialEq)]
pub struct Fingerprint {
    /// Collector and price-table version that built the record.
    pub built_with: String,
    pub raw_bytes: u64,
    pub transcript_path: Option<String>,
    pub transcript_bytes: u64,
}

/// A changed file whose surviving lines can be measured.
pub struct RewriteTarget {
    pub session_id: String,
    /// Repository root, or the session's working directory.
    pub base: Option<String>,
    pub path: String,
    pub hashes: Vec<u64>,
}

/// One file's measurement, as stored.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RewriteRow {
    pub session_id: String,
    pub path: String,
    /// Tracked lines the agent added.
    pub added: u64,
    /// How many of them are in the file now.
    pub surviving: u64,
    pub file_exists: bool,
    /// Branch and commit checked out when measured.
    pub branch: Option<String>,
    pub head: Option<String>,
}

/// Rewrite totals over a set of files.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Rewrite {
    pub files_measured: u64,
    /// Files where less than half of the agent's lines survive.
    pub files_rewritten: u64,
    pub lines_added: u64,
    pub lines_surviving: u64,
}

impl Rewrite {
    /// Share of measured files that were rewritten.
    pub fn rate(&self) -> Option<f64> {
        (self.files_measured > 0).then(|| self.files_rewritten as f64 / self.files_measured as f64)
    }

    /// Share of the agent's lines that are still there.
    pub fn line_survival(&self) -> Option<f64> {
        (self.lines_added > 0).then(|| self.lines_surviving as f64 / self.lines_added as f64)
    }
}

/// Which sessions to list or aggregate. Text filters match substrings,
/// ignoring case.
#[derive(Debug, Default, Clone)]
pub struct Filter {
    /// The agent: claude-code, cursor, grok or codex.
    pub tool: Option<String>,
    pub repo: Option<String>,
    pub user: Option<String>,
    pub model: Option<String>,
    /// A changed or read file path.
    pub file: Option<String>,
    /// Prompt previews, title, command summaries and file paths.
    pub text: Option<String>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    pub min_cost: Option<f64>,
}

/// One line of `sessionly list`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Listed {
    pub session_id: String,
    /// The agent the session ran in.
    pub source: String,
    pub started_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub active_ms: i64,
    pub cost_usd: Option<f64>,
    pub cost_source: Option<String>,
    pub models: String,
    pub prompts: u64,
    pub tool_calls: u64,
    pub tool_failures: u64,
    pub files_changed: u64,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub user: Option<String>,
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    pub rewrite: Rewrite,
    pub rewrite_measured_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, clap::ValueEnum)]
pub enum GroupBy {
    /// The agent: Claude Code, Cursor, Grok, Codex
    Tool,
    User,
    Repo,
    Model,
    Day,
}

/// One line of `sessionly summary`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Group {
    pub key: String,
    pub sessions: u64,
    pub cost_usd: f64,
    /// Sessions with no cost figure; `cost_usd` leaves them out.
    pub sessions_without_cost: u64,
    pub active_ms: i64,
    pub prompts: u64,
    pub tool_calls: u64,
    pub tool_failures: u64,
    pub files_changed: u64,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub rewrite: Rewrite,
}

fn rewrite_from(row: &SqlRow, first: usize) -> rusqlite::Result<Rewrite> {
    let n = |i: usize| -> rusqlite::Result<u64> {
        Ok(row.get::<_, Option<u64>>(first + i)?.unwrap_or(0))
    };
    Ok(Rewrite {
        files_measured: n(0)?,
        files_rewritten: n(1)?,
        lines_added: n(2)?,
        lines_surviving: n(3)?,
    })
}

fn like(text: &str) -> Sql {
    let escaped = text
        .to_lowercase()
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Sql::Text(format!("%{escaped}%"))
}

impl Filter {
    /// SQL conditions on `sessions s` and their parameters, numbered from `?2`
    /// (`?1` is the rewrite threshold).
    fn sql(&self) -> (String, Vec<Sql>) {
        let mut conditions: Vec<String> = Vec::new();
        let mut values: Vec<Sql> = vec![Sql::Real(REWRITTEN_BELOW)];
        let mut bind = |value: Sql| {
            values.push(value);
            format!("?{}", values.len())
        };
        if let Some(tool) = &self.tool {
            let p = bind(like(tool));
            conditions.push(format!("lower(s.source) LIKE {p} ESCAPE '\\'"));
        }
        if let Some(repo) = &self.repo {
            let p = bind(like(repo));
            conditions.push(format!(
                "lower(coalesce(s.repo_remote, '') || ' ' || coalesce(s.repo_root, s.cwd, '')) LIKE {p} ESCAPE '\\'"
            ));
        }
        if let Some(user) = &self.user {
            let p = bind(like(user));
            conditions.push(format!(
                "lower(coalesce(s.user_name, '') || ' ' || coalesce(s.user_email, '')) LIKE {p} ESCAPE '\\'"
            ));
        }
        if let Some(model) = &self.model {
            let p = bind(like(model));
            conditions.push(format!("lower(s.models) LIKE {p} ESCAPE '\\'"));
        }
        if let Some(file) = &self.file {
            let p = bind(like(file));
            conditions.push(format!(
                "EXISTS (SELECT 1 FROM session_files f WHERE f.session_id = s.session_id \
                 AND lower(f.path) LIKE {p} ESCAPE '\\')"
            ));
        }
        if let Some(text) = &self.text {
            let p = bind(like(text));
            conditions.push(format!("s.search_text LIKE {p} ESCAPE '\\'"));
        }
        if let Some(since) = self.since {
            let p = bind(Sql::Text(since.to_rfc3339()));
            conditions.push(format!("s.started_at >= {p}"));
        }
        if let Some(until) = self.until {
            let p = bind(Sql::Text(until.to_rfc3339()));
            conditions.push(format!("s.started_at < {p}"));
        }
        if let Some(min_cost) = self.min_cost {
            let p = bind(Sql::Real(min_cost));
            conditions.push(format!("s.cost_usd >= {p}"));
        }
        let clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        (clause, values)
    }
}

/// Lower-cased text a session can be found by.
fn search_text(s: &Session) -> String {
    let mut parts: Vec<&str> = Vec::new();
    parts.extend(s.title.as_deref());
    parts.extend(s.prompts.iter().map(|p| p.text.preview.as_str()));
    parts.extend(
        s.tool_calls
            .iter()
            .filter_map(|c| c.input_summary.as_deref()),
    );
    parts.extend(s.files.iter().map(|f| f.path.as_str()));
    parts.extend(s.subagents.iter().filter_map(|a| a.description.as_deref()));
    parts.join("\n").to_lowercase()
}

pub struct Ledger {
    conn: Connection,
}

impl Ledger {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            crate::paths::create_private_dir(dir)?;
        }
        let mut conn =
            Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        conn.busy_timeout(std::time::Duration::from_secs(10))?;
        conn.pragma_update(None, "foreign_keys", true)?;
        // Create or rebuild the tables in one transaction, so two processes
        // opening a new ledger at the same time don't trip over each other.
        // The ledger is derived data: a layout change drops it and the next
        // sync rebuilds it from the raw capture and the saved transcript facts.
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let version: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version != DB_VERSION {
            tx.execute_batch(
                "DROP TABLE IF EXISTS uploads; DROP TABLE IF EXISTS rewrite;
                 DROP TABLE IF EXISTS session_files; DROP TABLE IF EXISTS sessions;",
            )?;
            tx.execute_batch(TABLES)?;
            tx.pragma_update(None, "user_version", DB_VERSION)?;
        }
        tx.execute_batch(SERVERS)?;
        tx.execute_batch(WITHDRAWALS)?;
        // A build from before `part_of` made the table without it. What it
        // noted is kept, as part of a session nobody can name any more.
        let knows_part_of = tx
            .prepare("SELECT 1 FROM pragma_table_info('withdrawals') WHERE name = 'part_of'")?
            .exists([])?;
        if !knows_part_of {
            tx.execute_batch(
                "ALTER TABLE withdrawals ADD COLUMN part_of TEXT NOT NULL DEFAULT ''",
            )?;
        }
        tx.execute_batch(CHECKPOINT_TABLES)?;
        tx.execute(
            "INSERT OR IGNORE INTO checkpoints_since VALUES (1, ?1)",
            [Utc::now().to_rfc3339()],
        )?;
        tx.commit()?;
        Ok(Ledger { conn })
    }

    pub fn fingerprint(&self, session_id: &str) -> Result<Option<Fingerprint>> {
        Ok(self
            .conn
            .query_row(
                "SELECT built_with, raw_bytes, transcript_path, transcript_bytes
                 FROM sessions WHERE session_id = ?1",
                [session_id],
                |r| {
                    Ok(Fingerprint {
                        built_with: r.get(0)?,
                        raw_bytes: r.get(1)?,
                        transcript_path: r.get(2)?,
                        transcript_bytes: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// Insert or replace a session, its file rows, and the hashes of the lines
    /// the agent added to each file.
    pub fn upsert(
        &mut self,
        s: &Session,
        built_from: &Fingerprint,
        added_lines: &[FileLines],
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM sessions WHERE session_id = ?1",
            [&s.session_id],
        )?;
        let repo = s.repo.as_ref();
        let user = s.user.as_ref();
        tx.execute(
            "INSERT INTO sessions (
                session_id, source, schema_version, built_with, started_at, ended_at,
                duration_ms, active_ms, cwd, repo_root, repo_remote, branch, user_name,
                user_email, title, first_prompt, models, primary_model, cost_usd, cost_source,
                input_tokens, output_tokens, prompts, tool_calls, tool_failures, files_changed,
                lines_added, lines_removed, search_text, record, raw_bytes, transcript_path,
                transcript_bytes, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34)",
            params![
                s.session_id,
                s.source,
                s.schema_version,
                built_from.built_with,
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
                // The first one there is text of: a cloud agent's opening
                // prompt may never have reached a hook.
                s.prompts
                    .iter()
                    .map(|p| &p.text.preview)
                    .find(|text| !text.trim().is_empty()),
                s.models.join(","),
                s.models.first(),
                s.cost.as_ref().map(|c| c.total_usd),
                s.cost.as_ref().map(|c| c.source.as_str()),
                s.usage.iter().map(|u| u.input_tokens).sum::<u64>(),
                s.usage.iter().map(|u| u.output_tokens).sum::<u64>(),
                s.counts.prompts,
                s.counts.tool_calls,
                s.counts.tool_failures,
                s.counts.files_changed,
                s.counts.lines_added,
                s.counts.lines_removed,
                search_text(s),
                serde_json::to_string(s)?,
                built_from.raw_bytes,
                built_from.transcript_path,
                built_from.transcript_bytes,
                Utc::now().to_rfc3339(),
            ],
        )?;
        {
            let mut insert = tx
                .prepare("INSERT INTO session_files VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")?;
            for f in &s.files {
                let lines = added_lines.iter().find(|lines| lines.path == f.path);
                let hashes: Option<Vec<u8>> =
                    lines.map(|l| l.hashes().flat_map(|h| h.to_le_bytes()).collect());
                let models: Option<String> = lines.map(|l| {
                    let runs: Vec<(&Option<String>, usize)> =
                        l.by_model.iter().map(|(m, h)| (m, h.len())).collect();
                    serde_json::to_string(&runs).expect("serializes")
                });
                insert.execute(params![
                    s.session_id,
                    f.path,
                    f.reads,
                    f.writes,
                    f.created,
                    f.lines_added,
                    f.lines_removed,
                    hashes,
                    models
                ])?;
            }
        }
        // Measurements of files this session no longer lists are stale.
        tx.execute(
            "DELETE FROM rewrite WHERE session_id = ?1 AND path NOT IN
             (SELECT path FROM session_files WHERE session_id = ?1 AND added_hashes IS NOT NULL)",
            [&s.session_id],
        )?;
        // A checkpoint's age was counted from the end the session had then.
        // With another end (it was resumed, or more of it was read) that
        // age is not its age: its ages count from the end it has now.
        tx.execute(
            "DELETE FROM rewrite_checkpoints
             WHERE session_id = ?1 AND ended_at IS NOT ?2",
            params![s.session_id, s.ended_at.map(|t| t.to_rfc3339())],
        )?;
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

    /// All session ids, oldest first.
    pub fn session_ids(&self) -> Result<Vec<String>> {
        let mut query = self
            .conn
            .prepare("SELECT session_id FROM sessions ORDER BY started_at, session_id")?;
        let ids = query
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(ids)
    }

    /// Hash of what `server` was last sent for a session.
    pub fn uploaded_hash(&self, session_id: &str, server: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT hash FROM uploads WHERE session_id = ?1 AND server = ?2",
                [session_id, server],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn mark_uploaded(&mut self, session_id: &str, server: &str, hash: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO uploads VALUES (?1, ?2, ?3, ?4)",
            params![session_id, server, hash, Utc::now().to_rfc3339()],
        )?;
        // It is a session again: the server is to keep it.
        self.withdrawn(session_id, server)?;
        Ok(())
    }

    /// The sessions `server` has that are sessions no more.
    pub fn withdrawals(&self, server: &str) -> Result<Vec<Withdrawal>> {
        let mut query = self.conn.prepare(
            "SELECT session_id, source, part_of FROM withdrawals
             WHERE server = ?1 ORDER BY session_id",
        )?;
        let rows = query
            .query_map([server], |r| {
                Ok(Withdrawal {
                    session_id: r.get(0)?,
                    source: r.get(1)?,
                    part_of: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// `server` no longer has the session, or is not to be told after all.
    pub fn withdrawn(&mut self, session_id: &str, server: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM withdrawals WHERE session_id = ?1 AND server = ?2",
            [session_id, server],
        )?;
        Ok(())
    }

    /// Forget that `server` was sent a session. Called when the server does
    /// not have it: it refused it, or deleted it when its repository was
    /// stopped. An upload after the repository is allowed again sends it.
    pub fn forget_upload(&mut self, session_id: &str, server: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM uploads WHERE session_id = ?1 AND server = ?2",
            [session_id, server],
        )?;
        Ok(())
    }

    /// How many times `server` said a repository had been allowed again,
    /// when this machine last compared what it sent with what is there.
    pub fn allowed_again_seen(&self, server: &str) -> Result<u64> {
        Ok(self
            .conn
            .query_row(
                "SELECT allowed_again FROM servers WHERE server = ?1",
                [server],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    pub fn saw_allowed_again(&mut self, server: &str, times: u64) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO servers VALUES (?1, ?2)",
            params![server, times],
        )?;
        Ok(())
    }

    /// Remove every session whose id is not in `keep`, with its files and
    /// measurements. Returns how many were removed.
    pub fn retain(&mut self, keep: &[String]) -> Result<u64> {
        let tx = self.conn.transaction()?;
        tx.execute_batch("CREATE TEMP TABLE keep (session_id TEXT PRIMARY KEY)")?;
        {
            let mut insert = tx.prepare("INSERT OR IGNORE INTO keep VALUES (?1)")?;
            for id in keep {
                insert.execute([id])?;
            }
        }
        let gone = "session_id NOT IN (SELECT session_id FROM keep)";
        tx.execute(&format!("DELETE FROM rewrite WHERE {gone}"), [])?;
        tx.execute(&format!("DELETE FROM rewrite_checkpoints WHERE {gone}"), [])?;
        tx.execute(&format!("DELETE FROM uploads WHERE {gone}"), [])?;
        let removed = tx.execute(&format!("DELETE FROM sessions WHERE {gone}"), [])?;
        tx.execute_batch("DROP TABLE keep")?;
        tx.commit()?;
        Ok(removed as u64)
    }

    /// Remove one session that is a session no more, with its files and
    /// measurements: its work is in the session `part_of` now. Returns
    /// whether it was there. A server it was uploaded to still has it: that
    /// is noted, for an upload to take it back once that server has
    /// `part_of` (`withdrawals`).
    pub fn remove(&mut self, session_id: &str, part_of: &str) -> Result<bool> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR REPLACE INTO withdrawals
             SELECT u.session_id, u.server, s.source, ?2 FROM uploads u
             JOIN sessions s ON s.session_id = u.session_id WHERE u.session_id = ?1",
            [session_id, part_of],
        )?;
        tx.execute("DELETE FROM rewrite WHERE session_id = ?1", [session_id])?;
        tx.execute(
            "DELETE FROM rewrite_checkpoints WHERE session_id = ?1",
            [session_id],
        )?;
        tx.execute("DELETE FROM uploads WHERE session_id = ?1", [session_id])?;
        let removed = tx.execute("DELETE FROM sessions WHERE session_id = ?1", [session_id])?;
        tx.commit()?;
        Ok(removed > 0)
    }

    pub fn count(&self) -> Result<u64> {
        Ok(self
            .conn
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))?)
    }

    /// The lines a session added, per changed file and model.
    pub fn lines_of(&self, session_id: &str) -> Result<Vec<FileLines>> {
        let mut query = self.conn.prepare(
            "SELECT path, added_hashes, added_models FROM session_files
             WHERE session_id = ?1 AND added_hashes IS NOT NULL ORDER BY path",
        )?;
        let files = query
            .query_map([session_id], |r| {
                let blob: Vec<u8> = r.get(1)?;
                let runs: Option<String> = r.get(2)?;
                Ok((r.get::<_, String>(0)?, blob, runs))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(files
            .into_iter()
            .map(|(path, blob, runs)| {
                let mut hashes = blob
                    .as_chunks::<8>()
                    .0
                    .iter()
                    .map(|c| u64::from_le_bytes(*c));
                let runs: Vec<(Option<String>, usize)> = runs
                    .and_then(|r| serde_json::from_str(&r).ok())
                    .unwrap_or_default();
                let by_model = runs
                    .into_iter()
                    .map(|(model, n)| (model, hashes.by_ref().take(n).collect()))
                    .collect();
                FileLines { path, by_model }
            })
            .collect())
    }

    /// Every changed file with tracked added lines.
    pub fn rewrite_targets(&self) -> Result<Vec<RewriteTarget>> {
        let mut query = self.conn.prepare(
            "SELECT f.session_id, coalesce(s.repo_root, s.cwd), f.path, f.added_hashes
             FROM session_files f JOIN sessions s ON s.session_id = f.session_id
             WHERE f.added_hashes IS NOT NULL ORDER BY f.session_id, f.path",
        )?;
        let targets = query
            .query_map([], |r| {
                let blob: Vec<u8> = r.get(3)?;
                Ok(RewriteTarget {
                    session_id: r.get(0)?,
                    base: r.get(1)?,
                    path: r.get(2)?,
                    hashes: blob
                        .as_chunks::<8>()
                        .0
                        .iter()
                        .map(|c| u64::from_le_bytes(*c))
                        .collect(),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(targets)
    }

    pub fn store_rewrite(&mut self, rows: &[RewriteRow], measured_at: DateTime<Utc>) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut insert = tx.prepare(
                "INSERT OR REPLACE INTO rewrite VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for row in rows {
                insert.execute(params![
                    row.session_id,
                    row.path,
                    row.added,
                    row.surviving,
                    row.file_exists,
                    row.branch,
                    row.head,
                    measured_at.to_rfc3339()
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Latest measurement of each changed file of a session, and when it was taken.
    pub fn rewrite_of(&self, session_id: &str) -> Result<(Vec<RewriteRow>, Option<String>)> {
        let mut query = self.conn.prepare(
            "SELECT session_id, path, added, surviving, file_exists, branch, head, measured_at
             FROM rewrite WHERE session_id = ?1 AND added > 0 ORDER BY path",
        )?;
        let mut measured_at = None;
        let rows = query
            .query_map([session_id], |r| {
                measured_at = r.get(7)?;
                Ok(RewriteRow {
                    session_id: r.get(0)?,
                    path: r.get(1)?,
                    added: r.get(2)?,
                    surviving: r.get(3)?,
                    file_exists: r.get(4)?,
                    branch: r.get(5)?,
                    head: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok((rows, measured_at))
    }

    /// Keep what was just measured as the checkpoint of every age the
    /// session has reached and has none for. `measured` is each session
    /// measured now, with its tracked lines and how many are there. Age
    /// counts from when the session ended: one with no end known has no
    /// age, and no checkpoint. A checkpoint already kept is left
    /// as it is, and one whose age came before this ledger kept any is not
    /// made: nothing was measured then. One missed since (the machine was
    /// off that day) is taken now, and says how old the session really was.
    /// Returns how many were kept.
    pub fn keep_checkpoints(
        &mut self,
        measured: &[(String, u64, u64)],
        now: DateTime<Utc>,
    ) -> Result<u64> {
        let tx = self.conn.transaction()?;
        let since: String =
            tx.query_row("SELECT since FROM checkpoints_since", [], |r| r.get(0))?;
        let since = DateTime::parse_from_rfc3339(&since)?.with_timezone(&Utc);
        let mut kept = 0;
        {
            let mut ended_at = tx.prepare("SELECT ended_at FROM sessions WHERE session_id = ?1")?;
            let mut insert = tx.prepare(
                "INSERT OR IGNORE INTO rewrite_checkpoints VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for (session_id, added, surviving) in measured {
                if *added == 0 {
                    continue;
                }
                let ended: Option<String> = ended_at
                    .query_row([session_id], |r| r.get(0))
                    .optional()?
                    .flatten();
                let Some(ended) = ended.and_then(|t| DateTime::parse_from_rfc3339(&t).ok()) else {
                    continue;
                };
                let ended = ended.with_timezone(&Utc);
                let age = (now - ended).num_seconds();
                for (checkpoint, seconds) in CHECKPOINTS {
                    let due = ended + chrono::Duration::seconds(seconds);
                    if age < seconds || due < since {
                        continue;
                    }
                    kept += insert.execute(params![
                        session_id,
                        checkpoint,
                        added,
                        surviving,
                        now.to_rfc3339(),
                        age,
                        ended.to_rfc3339()
                    ])? as u64;
                }
            }
        }
        tx.commit()?;
        Ok(kept)
    }

    /// The checkpoints kept of a session, the earliest age first.
    pub fn checkpoints_of(&self, session_id: &str) -> Result<Vec<RewriteCheckpoint>> {
        let mut query = self.conn.prepare(
            "SELECT checkpoint, added, surviving, measured_at, age_seconds, ended_at
             FROM rewrite_checkpoints WHERE session_id = ?1",
        )?;
        let mut rows: Vec<RewriteCheckpoint> = query
            .query_map([session_id], |r| {
                let measured_at: String = r.get(3)?;
                let ended_at: String = r.get(5)?;
                let time = |text: &str| {
                    DateTime::parse_from_rfc3339(text)
                        .ok()
                        .map(|t| t.with_timezone(&Utc))
                };
                Ok(RewriteCheckpoint {
                    checkpoint: r.get(0)?,
                    added: r.get(1)?,
                    surviving: r.get(2)?,
                    measured_at: time(&measured_at),
                    age_seconds: r.get(4)?,
                    ended_at: time(&ended_at),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let order = |c: &RewriteCheckpoint| {
            CHECKPOINTS
                .iter()
                .position(|(name, _)| *name == c.checkpoint)
        };
        rows.sort_by_key(order);
        Ok(rows)
    }

    /// Sessions matching `filter`, newest first.
    pub fn list(&self, filter: &Filter, limit: Option<u64>) -> Result<Vec<Listed>> {
        let (clause, mut values) = filter.sql();
        values.push(Sql::Integer(limit.map_or(-1, |l| l as i64)));
        let sql = format!(
            "SELECT s.session_id, s.source, s.started_at, s.duration_ms, s.active_ms, s.cost_usd,
                    s.cost_source, s.models, s.prompts, s.tool_calls, s.tool_failures,
                    s.files_changed, s.lines_added, s.lines_removed,
                    coalesce(s.repo_remote, s.repo_root, s.cwd), s.branch,
                    coalesce(s.user_email, s.user_name), s.title, s.first_prompt,
                    r.rw_measured_at, r.rw_files, r.rw_rewritten, r.rw_added, r.rw_surviving
             FROM sessions s LEFT JOIN {REWRITE_TOTALS} ON r.session_id = s.session_id
             {clause} ORDER BY s.started_at DESC, s.session_id LIMIT ?{}",
            values.len()
        );
        let mut query = self.conn.prepare(&sql)?;
        let rows = query
            .query_map(params_from_iter(values), |r| {
                Ok(Listed {
                    session_id: r.get(0)?,
                    source: r.get(1)?,
                    started_at: r.get(2)?,
                    duration_ms: r.get(3)?,
                    active_ms: r.get(4)?,
                    cost_usd: r.get(5)?,
                    cost_source: r.get(6)?,
                    models: r.get(7)?,
                    prompts: r.get(8)?,
                    tool_calls: r.get(9)?,
                    tool_failures: r.get(10)?,
                    files_changed: r.get(11)?,
                    lines_added: r.get(12)?,
                    lines_removed: r.get(13)?,
                    repo: r.get(14)?,
                    branch: r.get(15)?,
                    user: r.get(16)?,
                    title: r.get(17)?,
                    first_prompt: r.get(18)?,
                    rewrite_measured_at: r.get(19)?,
                    rewrite: rewrite_from(r, 20)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Totals per group over the sessions matching `filter`, largest cost
    /// first (days: newest first), followed by a "total" row.
    pub fn summary(&self, filter: &Filter, by: GroupBy) -> Result<Vec<Group>> {
        let (clause, values) = filter.sql();
        let (key, order) = match by {
            GroupBy::Tool => ("s.source", "3 DESC, 1"),
            GroupBy::User => (
                "coalesce(s.user_email, s.user_name, '(unknown)')",
                "3 DESC, 1",
            ),
            GroupBy::Repo => (
                "coalesce(s.repo_remote, s.repo_root, s.cwd, '(unknown)')",
                "3 DESC, 1",
            ),
            GroupBy::Model => ("coalesce(s.primary_model, '(unknown)')", "3 DESC, 1"),
            GroupBy::Day => (
                "coalesce(substr(s.started_at, 1, 10), '(unknown)')",
                "1 DESC",
            ),
        };
        let select = |key: &str, tail: &str| {
            format!(
                "SELECT {key}, count(*), coalesce(sum(s.cost_usd), 0),
                        sum(s.cost_usd IS NULL), sum(s.active_ms), sum(s.prompts),
                        sum(s.tool_calls), sum(s.tool_failures), sum(s.files_changed),
                        sum(s.lines_added), sum(s.lines_removed),
                        sum(r.rw_files), sum(r.rw_rewritten), sum(r.rw_added), sum(r.rw_surviving)
                 FROM sessions s LEFT JOIN {REWRITE_TOTALS} ON r.session_id = s.session_id
                 {clause} {tail}"
            )
        };
        let read = |r: &SqlRow| -> rusqlite::Result<Group> {
            Ok(Group {
                key: r.get(0)?,
                sessions: r.get(1)?,
                cost_usd: r.get(2)?,
                sessions_without_cost: r.get::<_, Option<u64>>(3)?.unwrap_or(0),
                active_ms: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                prompts: r.get::<_, Option<u64>>(5)?.unwrap_or(0),
                tool_calls: r.get::<_, Option<u64>>(6)?.unwrap_or(0),
                tool_failures: r.get::<_, Option<u64>>(7)?.unwrap_or(0),
                files_changed: r.get::<_, Option<u64>>(8)?.unwrap_or(0),
                lines_added: r.get::<_, Option<u64>>(9)?.unwrap_or(0),
                lines_removed: r.get::<_, Option<u64>>(10)?.unwrap_or(0),
                rewrite: rewrite_from(r, 11)?,
            })
        };
        let mut groups: Vec<Group> = self
            .conn
            .prepare(&select(key, &format!("GROUP BY 1 ORDER BY {order}")))?
            .query_map(params_from_iter(values.clone()), read)?
            .collect::<rusqlite::Result<_>>()?;
        if !groups.is_empty() {
            let total =
                self.conn
                    .query_row(&select("'total'", ""), params_from_iter(values), read)?;
            groups.push(total);
        }
        Ok(groups)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Cost, CostSource, FileTouched, Prompt, Repo, Text, User, SCHEMA_VERSION};

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
            built_with: "test".into(),
            raw_bytes,
            transcript_path: None,
            transcript_bytes: 0,
        }
    }

    fn open() -> (tempfile::TempDir, Ledger) {
        let dir = tempfile::tempdir().unwrap();
        let ledger = Ledger::open(&dir.path().join("l.db")).unwrap();
        (dir, ledger)
    }

    #[test]
    fn stores_and_replaces_sessions() {
        let (_dir, mut ledger) = open();
        let mut s = session("abc-1");
        ledger.upsert(&s, &fingerprint(10), &[]).unwrap();
        s.title = Some("renamed".into());
        ledger.upsert(&s, &fingerprint(20), &[]).unwrap();
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
    fn remembers_what_each_server_was_sent_and_last_said() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("l.db");
        let (a, b) = ("https://a.example", "https://b.example");
        let mut ledger = Ledger::open(&path).unwrap();
        ledger.mark_uploaded("s1", a, "h1").unwrap();
        ledger.mark_uploaded("s1", b, "h1").unwrap();
        ledger.forget_upload("s1", a).unwrap();
        assert_eq!(ledger.uploaded_hash("s1", a).unwrap(), None);
        assert_eq!(
            ledger.uploaded_hash("s1", b).unwrap().as_deref(),
            Some("h1")
        );

        assert_eq!(ledger.allowed_again_seen(a).unwrap(), 0);
        ledger.saw_allowed_again(a, 2).unwrap();
        ledger.saw_allowed_again(a, 3).unwrap();
        assert_eq!(ledger.allowed_again_seen(a).unwrap(), 3);
        assert_eq!(ledger.allowed_again_seen(b).unwrap(), 0);
        // Opening again keeps both: adding the table rebuilt nothing.
        drop(ledger);
        let ledger = Ledger::open(&path).unwrap();
        assert_eq!(ledger.allowed_again_seen(a).unwrap(), 3);
        assert_eq!(
            ledger.uploaded_hash("s1", b).unwrap().as_deref(),
            Some("h1")
        );
    }

    #[test]
    fn what_an_earlier_build_noted_to_take_back_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("l.db");
        drop(Ledger::open(&path).unwrap());
        // The table as it was made before it said what a session became part of.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "DROP TABLE withdrawals;
             CREATE TABLE withdrawals (session_id TEXT NOT NULL, server TEXT NOT NULL,
                 source TEXT NOT NULL, PRIMARY KEY (session_id, server));
             INSERT INTO withdrawals VALUES ('sub-1', 'https://s.example.com', 'codex');",
        )
        .unwrap();
        drop(conn);
        let mut ledger = Ledger::open(&path).unwrap();
        assert_eq!(
            ledger.withdrawals("https://s.example.com").unwrap(),
            [Withdrawal {
                session_id: "sub-1".into(),
                source: "codex".into(),
                part_of: String::new(),
            }]
        );
        // And one can be noted in it as before.
        ledger
            .upsert(&session("sub-2"), &fingerprint(1), &[])
            .unwrap();
        assert!(ledger.remove("sub-2", "main-1").unwrap());
    }

    #[test]
    fn finds_by_unique_prefix_only() {
        let (_dir, mut ledger) = open();
        for id in ["abc-1", "abc-2", "abd"] {
            ledger.upsert(&session(id), &fingerprint(1), &[]).unwrap();
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
            .upsert(&session("s"), &fingerprint(1), &[])
            .unwrap();
        assert_eq!(Ledger::open(&path).unwrap().count().unwrap(), 1);
    }

    /// Three sessions: two by ann in repo web (one with rewrite data), one by
    /// bob in repo api without a cost.
    fn populated() -> (tempfile::TempDir, Ledger) {
        let (dir, mut ledger) = open();
        let make = |id: &str,
                    day: u32,
                    user: &str,
                    repo: &str,
                    model: &str,
                    cost: Option<f64>,
                    prompt: &str| {
            let mut s = session(id);
            s.started_at = Some(format!("2026-11-{day:02}T10:00:00Z").parse().unwrap());
            s.user = Some(User {
                name: None,
                email: Some(format!("{user}@example.com")),
            });
            s.repo = Some(Repo {
                root: format!("/src/{repo}"),
                remote: Some(format!("github.com/acme/{repo}")),
                branch: Some("main".into()),
            });
            s.models = vec![model.into()];
            s.cost = cost.map(|total_usd| Cost {
                total_usd,
                source: CostSource::Recorded,
                ..Default::default()
            });
            s.prompts = vec![Prompt {
                text: Text {
                    preview: prompt.into(),
                    ..Default::default()
                },
                ..Default::default()
            }];
            s.counts.prompts = 1;
            s.counts.files_changed = 1;
            s.counts.lines_added = 3;
            s.active_ms = 60_000;
            s
        };
        let lines = vec![FileLines {
            path: "/r/a.rs".into(),
            by_model: vec![
                (None, vec![1]),
                (Some("claude-opus-5-5".into()), vec![2, 3, 4]),
            ],
        }];
        ledger
            .upsert(
                &make(
                    "s1",
                    10,
                    "ann",
                    "web",
                    "claude-opus-5-5",
                    Some(2.0),
                    "Fix the Login_Form 100% please",
                ),
                &fingerprint(1),
                &lines,
            )
            .unwrap();
        ledger
            .upsert(
                &make(
                    "s2",
                    12,
                    "ann",
                    "web",
                    "claude-haiku-5-5",
                    Some(0.5),
                    "add tests",
                ),
                &fingerprint(1),
                &[],
            )
            .unwrap();
        ledger
            .upsert(
                &make(
                    "s3",
                    11,
                    "bob",
                    "api",
                    "claude-opus-5-5",
                    None,
                    "refactor billing",
                ),
                &fingerprint(1),
                &[],
            )
            .unwrap();
        (dir, ledger)
    }

    fn ids(rows: &[Listed]) -> Vec<&str> {
        rows.iter().map(|r| r.session_id.as_str()).collect()
    }

    #[test]
    fn lists_newest_first_with_filters() {
        let (_dir, ledger) = populated();
        let list = |f: Filter| ledger.list(&f, None).unwrap();
        assert_eq!(ids(&list(Filter::default())), ["s2", "s3", "s1"]);
        assert_eq!(
            ids(&ledger.list(&Filter::default(), Some(1)).unwrap()),
            ["s2"]
        );
        assert_eq!(
            ids(&list(Filter {
                user: Some("ANN".into()),
                ..Default::default()
            })),
            ["s2", "s1"]
        );
        assert_eq!(
            ids(&list(Filter {
                repo: Some("acme/api".into()),
                ..Default::default()
            })),
            ["s3"]
        );
        assert_eq!(
            ids(&list(Filter {
                model: Some("haiku".into()),
                ..Default::default()
            })),
            ["s2"]
        );
        assert_eq!(
            ids(&list(Filter {
                file: Some("a.rs".into()),
                ..Default::default()
            })),
            ["s2", "s3", "s1"]
        );
        assert_eq!(
            ids(&list(Filter {
                file: Some("nope".into()),
                ..Default::default()
            })),
            [] as [&str; 0]
        );
        assert_eq!(
            ids(&list(Filter {
                min_cost: Some(1.0),
                ..Default::default()
            })),
            ["s1"]
        );
        let day = |d: u32| Some(format!("2026-11-{d:02}T00:00:00Z").parse().unwrap());
        assert_eq!(
            ids(&list(Filter {
                since: day(11),
                until: day(12),
                ..Default::default()
            })),
            ["s3"]
        );
        // text search ignores case and treats % and _ literally
        assert_eq!(
            ids(&list(Filter {
                text: Some("login_form".into()),
                ..Default::default()
            })),
            ["s1"]
        );
        assert_eq!(
            ids(&list(Filter {
                text: Some("100%".into()),
                ..Default::default()
            })),
            ["s1"]
        );
        assert_eq!(
            ids(&list(Filter {
                text: Some("login%form".into()),
                ..Default::default()
            })),
            [] as [&str; 0]
        );
        let row = &list(Filter {
            text: Some("billing".into()),
            ..Default::default()
        })[0];
        assert_eq!(row.user.as_deref(), Some("bob@example.com"));
        assert_eq!(row.source, "claude-code");
        assert_eq!(
            ids(&list(Filter {
                tool: Some("Claude".into()),
                ..Default::default()
            }))
            .len(),
            3
        );
        assert_eq!(
            ids(&list(Filter {
                tool: Some("grok".into()),
                ..Default::default()
            }))
            .len(),
            0
        );
        assert_eq!(row.repo.as_deref(), Some("github.com/acme/api"));
        assert_eq!(row.cost_usd, None);
    }

    #[test]
    fn rewrite_measurements_roll_up() {
        let (_dir, mut ledger) = populated();
        let targets = ledger.rewrite_targets().unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].hashes, [1, 2, 3, 4]);
        assert_eq!(targets[0].base.as_deref(), Some("/src/web"));
        let row = |path: &str, added, surviving| RewriteRow {
            session_id: "s1".into(),
            path: path.into(),
            added,
            surviving,
            file_exists: true,
            branch: Some("main".into()),
            head: None,
        };
        let now = Utc::now();
        ledger
            .store_rewrite(&[row("/r/a.rs", 4, 1), row("/r/b.rs", 10, 9)], now)
            .unwrap();
        ledger.store_rewrite(&[row("/r/a.rs", 4, 3)], now).unwrap(); // re-measured

        let listed = ledger
            .list(
                &Filter {
                    text: Some("login".into()),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        let expected = Rewrite {
            files_measured: 2,
            files_rewritten: 0,
            lines_added: 14,
            lines_surviving: 12,
        };
        assert_eq!(listed[0].rewrite, expected);
        assert!(listed[0].rewrite_measured_at.is_some());
        let (files, measured_at) = ledger.rewrite_of("s1").unwrap();
        assert_eq!(files.len(), 2);
        assert!(measured_at.is_some());

        ledger.store_rewrite(&[row("/r/a.rs", 4, 1)], now).unwrap();
        let listed = ledger.list(&Filter::default(), None).unwrap();
        let s1 = listed.iter().find(|r| r.session_id == "s1").unwrap();
        assert_eq!(s1.rewrite.files_rewritten, 1);
        assert_eq!(s1.rewrite.rate(), Some(0.5));
        let s2 = listed.iter().find(|r| r.session_id == "s2").unwrap();
        assert_eq!(s2.rewrite, Rewrite::default());
        assert_eq!(s2.rewrite.rate(), None);

        // rebuilding the session drops the measurement of a file it no longer lists
        let s = ledger.get("s1").unwrap().unwrap();
        ledger
            .upsert(
                &s,
                &fingerprint(2),
                &[FileLines {
                    path: "/r/a.rs".into(),
                    by_model: vec![(None, vec![1])],
                }],
            )
            .unwrap();
        assert_eq!(ledger.rewrite_of("s1").unwrap().0.len(), 1);
    }

    #[test]
    fn summarizes_by_group_with_a_total() {
        let (_dir, mut ledger) = populated();
        let row = RewriteRow {
            session_id: "s1".into(),
            path: "/r/a.rs".into(),
            added: 4,
            surviving: 1,
            file_exists: true,
            branch: None,
            head: None,
        };
        ledger.store_rewrite(&[row], Utc::now()).unwrap();

        let by_user = ledger.summary(&Filter::default(), GroupBy::User).unwrap();
        let keys: Vec<_> = by_user.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, ["ann@example.com", "bob@example.com", "total"]);
        let ann = &by_user[0];
        assert_eq!(
            (ann.sessions, ann.cost_usd, ann.sessions_without_cost),
            (2, 2.5, 0)
        );
        assert_eq!(
            (ann.prompts, ann.active_ms, ann.lines_added),
            (2, 120_000, 6)
        );
        assert_eq!(ann.rewrite.files_rewritten, 1);
        assert_eq!(
            (by_user[1].cost_usd, by_user[1].sessions_without_cost),
            (0.0, 1)
        );
        let total = &by_user[2];
        assert_eq!(
            (total.sessions, total.cost_usd, total.sessions_without_cost),
            (3, 2.5, 1)
        );

        let keys = |by| -> Vec<String> {
            ledger
                .summary(&Filter::default(), by)
                .unwrap()
                .into_iter()
                .map(|g| g.key)
                .collect()
        };
        assert_eq!(
            keys(GroupBy::Repo),
            ["github.com/acme/web", "github.com/acme/api", "total"]
        );
        assert_eq!(
            keys(GroupBy::Model),
            ["claude-opus-5-5", "claude-haiku-5-5", "total"]
        );
        assert_eq!(
            keys(GroupBy::Day),
            ["2026-11-12", "2026-11-11", "2026-11-10", "total"]
        );

        let none = Filter {
            user: Some("nobody".into()),
            ..Default::default()
        };
        assert!(ledger.summary(&none, GroupBy::User).unwrap().is_empty());
        let bob = Filter {
            user: Some("bob".into()),
            ..Default::default()
        };
        assert_eq!(ledger.summary(&bob, GroupBy::Day).unwrap().len(), 2);
    }
}
