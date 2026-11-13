//! What leaves the machine: turning a local session record into the payload a
//! server receives.
//!
//! Two things happen to every record before upload, whatever the settings:
//! paths are made relative (to the repository, else to the home directory),
//! and the record is marked with the content level it was reduced to. With
//! the default level, `metadata`, every piece of text taken from prompts,
//! commands and output is removed as well.

use anyhow::Result;
use chrono::{DateTime, Utc};

use crate::ledger::Ledger;
use crate::rewrite::REWRITTEN_BELOW;
use crate::session::{Content, RewriteFile, RewriteMeasurement, Session, Upload, SCHEMA_VERSION};

/// `path` without the machine-specific part: relative to the repository if it
/// is inside it, else `~/…` if it is under the home directory, else unchanged.
pub fn relative_path(path: &str, repo_root: Option<&str>, home: Option<&str>) -> String {
    let inside = |base: &str| -> Option<&str> {
        let base = base.trim_end_matches(['/', '\\']);
        if base.is_empty() {
            return None;
        }
        let rest = path.strip_prefix(base)?;
        match rest.chars().next() {
            None => Some(""),
            Some('/' | '\\') => Some(&rest[1..]),
            Some(_) => None, // `/src/web-old` is not inside `/src/web`
        }
    };
    if let Some(rest) = repo_root.and_then(inside) {
        return if rest.is_empty() {
            ".".into()
        } else {
            rest.to_string()
        };
    }
    if let Some(rest) = home.and_then(inside) {
        return if rest.is_empty() {
            "~".into()
        } else {
            format!("~/{rest}")
        };
    }
    path.to_string()
}

/// The record as it may be uploaded at the given content level.
pub fn redact(session: &Session, content: Content, home: Option<&str>) -> Session {
    if content == Content::Local {
        return session.clone();
    }
    let mut s = session.clone();
    s.content = content;

    let root = session.repo.as_ref().map(|r| r.root.clone());
    let rel = |path: &str| relative_path(path, root.as_deref(), home);
    for file in &mut s.files {
        file.path = rel(&file.path);
    }
    for call in &mut s.tool_calls {
        call.file_path = call.file_path.as_deref().map(rel);
    }
    for path in &mut s.instruction_files {
        *path = rel(path);
    }
    // The repository root and working directory are only shortened to `~/…`:
    // relative to the repository they would both be ".".
    s.cwd = s.cwd.as_deref().map(|p| relative_path(p, None, home));
    if let Some(repo) = &mut s.repo {
        repo.root = relative_path(&repo.root, None, home);
    }

    if content == Content::Metadata {
        s.title = None;
        for prompt in &mut s.prompts {
            prompt.text.preview.clear();
            // An unsalted hash of a short prompt can be guessed; drop it too.
            prompt.text.sha256.clear();
        }
        for call in &mut s.tool_calls {
            call.input_summary = None;
            call.input_sha256.clear();
            call.error = None;
        }
        for subagent in &mut s.subagents {
            subagent.description = None;
        }
    }
    s
}

/// The latest rewrite measurement of a session, with paths as in the
/// uploaded record. `None` if nothing was measured.
fn rewrite_measurement(
    ledger: &Ledger,
    session: &Session,
    home: Option<&str>,
) -> Result<Option<RewriteMeasurement>> {
    let (rows, measured_at) = ledger.rewrite_of(&session.session_id)?;
    if rows.is_empty() {
        return Ok(None);
    }
    let root = session.repo.as_ref().map(|r| r.root.as_str());
    let rewritten =
        |added: u64, surviving: u64| (surviving as f64) < REWRITTEN_BELOW * added as f64;
    Ok(Some(RewriteMeasurement {
        measured_at: measured_at
            .and_then(|t| DateTime::parse_from_rfc3339(&t).ok())
            .map(|t| t.with_timezone(&Utc)),
        branch: rows.iter().find_map(|r| r.branch.clone()),
        head: rows.iter().find_map(|r| r.head.clone()),
        files_measured: rows.len() as u64,
        files_rewritten: rows
            .iter()
            .filter(|r| rewritten(r.added, r.surviving))
            .count() as u64,
        lines_added: rows.iter().map(|r| r.added).sum(),
        lines_surviving: rows.iter().map(|r| r.surviving).sum(),
        files: rows
            .iter()
            .map(|r| RewriteFile {
                path: relative_path(&r.path, root, home),
                lines_added: r.added,
                lines_surviving: r.surviving,
                exists: r.file_exists,
            })
            .collect(),
    }))
}

/// Everything a server gets for one session.
pub fn build(ledger: &Ledger, session: &Session, content: Content) -> Result<Upload> {
    let home = crate::paths::home_dir().map(|h| h.to_string_lossy().into_owned());
    Ok(Upload {
        schema_version: SCHEMA_VERSION,
        session: redact(session, content, home.as_deref()),
        rewrite: rewrite_measurement(ledger, session, home.as_deref())?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::*;

    #[test]
    fn makes_paths_relative() {
        let rel = |p: &str| relative_path(p, Some("/home/ann/src/web"), Some("/home/ann"));
        assert_eq!(rel("/home/ann/src/web/app/main.rs"), "app/main.rs");
        assert_eq!(rel("/home/ann/src/web"), ".");
        assert_eq!(rel("/home/ann/src/web-old/x.rs"), "~/src/web-old/x.rs");
        assert_eq!(rel("/home/ann/.claude/CLAUDE.md"), "~/.claude/CLAUDE.md");
        assert_eq!(rel("/home/ann"), "~");
        assert_eq!(rel("/etc/hosts"), "/etc/hosts");
        assert_eq!(rel("already/relative.rs"), "already/relative.rs");
        assert_eq!(relative_path("/a/b", None, None), "/a/b");
        assert_eq!(relative_path("/a/b", Some(""), Some("/")), "/a/b");
        assert_eq!(
            relative_path(
                r"C:\Users\ann\web\src\a.rs",
                Some(r"C:\Users\ann\web"),
                None
            ),
            r"src\a.rs"
        );
    }

    /// A record holding a marker string in every content-bearing field.
    fn local_record() -> Session {
        let secret = "SECRET-sk-live-123";
        Session {
            schema_version: SCHEMA_VERSION,
            source: "claude-code".into(),
            session_id: "s1".into(),
            machine_id: "m1".into(),
            title: Some(format!("title {secret}")),
            cwd: Some("/home/ann/src/web/sub".into()),
            repo: Some(Repo {
                root: "/home/ann/src/web".into(),
                remote: Some("github.com/acme/web".into()),
                branch: Some("main".into()),
            }),
            user: Some(User {
                name: Some("Ann".into()),
                email: Some("ann@example.com".into()),
            }),
            prompts: vec![Prompt {
                prompt_id: Some("p1".into()),
                text: Text {
                    sha256: "abc123".into(),
                    chars: 40,
                    preview: format!("deploy with {secret}"),
                },
                outcome: Some(Outcome::Completed),
                ..Default::default()
            }],
            tool_calls: vec![ToolCall {
                tool_use_id: "t1".into(),
                tool: "Bash".into(),
                status: ToolStatus::Failed,
                file_path: Some("/home/ann/src/web/app/main.rs".into()),
                input_sha256: "def456".into(),
                input_summary: Some(format!("curl -H 'Authorization: {secret}'")),
                error: Some(format!("denied: {secret}")),
                output_bytes: Some(12),
                ..Default::default()
            }],
            files: vec![FileTouched {
                path: "/home/ann/src/web/app/main.rs".into(),
                writes: 1,
                ..Default::default()
            }],
            subagents: vec![Subagent {
                agent_id: "a1".into(),
                description: Some(format!("look for {secret}")),
                ..Default::default()
            }],
            instruction_files: vec!["/home/ann/.claude/CLAUDE.md".into()],
            counts: Counts {
                prompts: 1,
                tool_calls: 1,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn metadata_level_carries_no_text_from_the_session() {
        let record = redact(&local_record(), Content::Metadata, Some("/home/ann"));
        let json = serde_json::to_string(&record).unwrap();
        assert!(!json.contains("SECRET"), "{json}");
        assert!(!json.contains("/home/ann"), "{json}");
        assert!(!json.contains("abc123") && !json.contains("def456"));
        assert_eq!(record.content, Content::Metadata);
        // what a dashboard needs is still there
        assert_eq!(record.prompts[0].text.chars, 40);
        assert_eq!(record.prompts[0].outcome, Some(Outcome::Completed));
        assert_eq!(record.tool_calls[0].tool, "Bash");
        assert_eq!(record.tool_calls[0].status, ToolStatus::Failed);
        assert_eq!(
            record.tool_calls[0].file_path.as_deref(),
            Some("app/main.rs")
        );
        assert_eq!(record.files[0].path, "app/main.rs");
        assert_eq!(record.instruction_files, ["~/.claude/CLAUDE.md"]);
        assert_eq!(record.cwd.as_deref(), Some("~/src/web/sub"));
        let repo = record.repo.unwrap();
        assert_eq!(
            (repo.root.as_str(), repo.remote.as_deref()),
            ("~/src/web", Some("github.com/acme/web"))
        );
        assert_eq!(
            record.user.unwrap().email.as_deref(),
            Some("ann@example.com")
        );
        assert_eq!(
            (record.machine_id.as_str(), record.counts.prompts),
            ("m1", 1)
        );
    }

    #[test]
    fn previews_level_keeps_text_but_not_absolute_paths() {
        let record = redact(&local_record(), Content::Previews, Some("/home/ann"));
        assert_eq!(record.content, Content::Previews);
        assert!(record.prompts[0].text.preview.contains("SECRET"));
        assert!(record.tool_calls[0]
            .error
            .as_deref()
            .unwrap()
            .contains("SECRET"));
        assert_eq!(record.prompts[0].text.sha256, "abc123");
        assert_eq!(record.files[0].path, "app/main.rs");
        assert!(!serde_json::to_string(&record)
            .unwrap()
            .contains("/home/ann"));
    }

    #[test]
    fn local_level_is_left_alone() {
        let record = local_record();
        assert_eq!(redact(&record, Content::Local, Some("/home/ann")), record);
    }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

use crate::config::{Config, Server};
use sha2::{Digest, Sha256};
use std::time::Duration;

const USER_AGENT: &str = concat!("sessionly/", env!("CARGO_PKG_VERSION"));

/// Give up on a run after this many requests in a row could not reach the server.
const MAX_UNREACHABLE: usize = 3;

/// Why a request did not succeed.
#[derive(Debug, PartialEq)]
pub enum SendError {
    /// The server does not accept the token (401 or 403).
    Auth(String),
    /// The server refused this payload (another 4xx). Retrying won't help.
    Rejected(String),
    /// The server could not be reached or failed (network error or 5xx).
    Unavailable(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Auth(m) => write!(f, "the server did not accept the token ({m})"),
            SendError::Rejected(m) => write!(f, "the server refused it ({m})"),
            SendError::Unavailable(m) => write!(f, "the server could not be reached ({m})"),
        }
    }
}

pub struct Client {
    agent: ureq::Agent,
    base: String,
    token: String,
}

impl Client {
    pub fn new(server: &Server) -> Client {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .user_agent(USER_AGENT)
            .build()
            .into();
        Client {
            agent,
            base: server.url.trim_end_matches('/').to_string(),
            token: server.token.clone(),
        }
    }

    fn check(
        result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    ) -> Result<(), SendError> {
        let mut response = result.map_err(|e| SendError::Unavailable(e.to_string()))?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let body = response.body_mut().read_to_string().unwrap_or_default();
        let body: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
        let detail: String = body.chars().take(200).collect();
        let message = if detail.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}: {detail}")
        };
        Err(match status {
            401 | 403 => SendError::Auth(message),
            400..=499 => SendError::Rejected(message),
            _ => SendError::Unavailable(message),
        })
    }

    /// Check that the server is there and accepts the token.
    pub fn ping(&self) -> Result<(), SendError> {
        Self::check(
            self.agent
                .get(format!("{}/api/v1/ping", self.base))
                .header("Authorization", format!("Bearer {}", self.token))
                .call(),
        )
    }

    /// Store or replace one session on the server.
    pub fn put_session(&self, upload: &Upload) -> Result<(), SendError> {
        let s = &upload.session;
        let url = format!(
            "{}/api/v1/sessions/{}/{}/{}",
            self.base,
            url_segment(&s.machine_id),
            url_segment(&s.source),
            url_segment(&s.session_id)
        );
        Self::check(
            self.agent
                .put(url)
                .header("Authorization", format!("Bearer {}", self.token))
                .send_json(upload),
        )
    }
}

/// Percent-encode everything outside `[A-Za-z0-9._-]`.
fn url_segment(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' => (b as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// Hash of a payload's content, used to skip sessions the server already has.
/// The time of the rewrite measurement is left out: re-measuring with the same
/// result is not a change.
pub fn payload_hash(upload: &Upload) -> String {
    let mut upload = upload.clone();
    if let Some(rewrite) = &mut upload.rewrite {
        rewrite.measured_at = None;
    }
    let json = serde_json::to_vec(&upload).expect("payload serializes");
    Sha256::digest(&json)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub sent: u64,
    /// Sessions the server already has in their current form.
    pub unchanged: u64,
    /// Sessions that could not be sent, with the reason.
    pub failed: Vec<(String, String)>,
    /// Set when the run stopped early; nothing after that point was tried.
    pub stopped: Option<String>,
}

impl Report {
    pub fn summary(&self) -> String {
        let mut text = format!(
            "uploaded {} ({} unchanged, {} failed)",
            self.sent,
            self.unchanged,
            self.failed.len()
        );
        if let Some(reason) = &self.stopped {
            text.push_str(&format!("; stopped: {reason}"));
        }
        text
    }
}

/// Send every session the server doesn't have in its current form. With
/// `dry_run`, only count what would be sent.
pub fn run(ledger: &mut Ledger, config: &Config, dry_run: bool) -> Result<Report> {
    let Some(server) = &config.server else {
        anyhow::bail!("no server is configured; run: sessionly connect <url>");
    };
    let client = Client::new(server);
    let mut report = Report::default();
    let mut unreachable = 0;
    for id in ledger.session_ids()? {
        let Some(session) = ledger.get(&id)? else {
            continue;
        };
        let payload = build(ledger, &session, config.upload_content)?;
        let hash = payload_hash(&payload);
        if ledger.uploaded_hash(&id, &server.url)?.as_deref() == Some(hash.as_str()) {
            report.unchanged += 1;
            continue;
        }
        if dry_run {
            report.sent += 1;
            continue;
        }
        match client.put_session(&payload) {
            Ok(()) => {
                ledger.mark_uploaded(&id, &server.url, &hash)?;
                report.sent += 1;
                unreachable = 0;
            }
            Err(err @ SendError::Auth(_)) => {
                report.stopped = Some(err.to_string());
                break;
            }
            Err(err @ SendError::Rejected(_)) => report.failed.push((id, err.to_string())),
            Err(err @ SendError::Unavailable(_)) => {
                report.failed.push((id, err.to_string()));
                unreachable += 1;
                if unreachable >= MAX_UNREACHABLE {
                    report.stopped = Some(err.to_string());
                    break;
                }
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod send_tests {
    use super::*;
    use crate::session::Session;

    #[test]
    fn hash_ignores_only_the_measurement_time() {
        let mut upload = Upload {
            schema_version: 1,
            session: Session {
                session_id: "s".into(),
                ..Default::default()
            },
            rewrite: Some(RewriteMeasurement {
                lines_added: 4,
                lines_surviving: 4,
                ..Default::default()
            }),
        };
        let before = payload_hash(&upload);
        upload.rewrite.as_mut().unwrap().measured_at = Some(Utc::now());
        assert_eq!(payload_hash(&upload), before);
        upload.rewrite.as_mut().unwrap().lines_surviving = 3;
        assert_ne!(payload_hash(&upload), before);
        assert_eq!(before.len(), 64);
    }

    #[test]
    fn url_segments_are_safe() {
        assert_eq!(url_segment("abc-123_x.y"), "abc-123_x.y");
        assert_eq!(url_segment("a/b ?#"), "a%2Fb%20%3F%23");
        assert_eq!(url_segment("é"), "%C3%A9");
    }
}
