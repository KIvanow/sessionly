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
use crate::session::{
    AddedLines, Content, RewriteFile, RewriteMeasurement, Session, Upload, SCHEMA_VERSION,
};

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

/// The lines the session's agent added, as hashes, with paths as in the
/// uploaded record.
fn added_lines(ledger: &Ledger, session: &Session, home: Option<&str>) -> Result<Vec<AddedLines>> {
    let root = session.repo.as_ref().map(|r| r.root.as_str());
    let mut lines = Vec::new();
    for file in ledger.lines_of(&session.session_id)? {
        let path = relative_path(&file.path, root, home);
        for (model, hashes) in file.by_model {
            lines.push(AddedLines {
                path: path.clone(),
                model,
                hashes: hashes.into_iter().map(crate::rewrite::hash_hex).collect(),
            });
        }
    }
    Ok(lines)
}

/// Everything a server gets for one session. `line_hashes` adds the hashes
/// of the lines the agent wrote.
pub fn build(
    ledger: &Ledger,
    session: &Session,
    content: Content,
    line_hashes: bool,
) -> Result<Upload> {
    let home = crate::paths::home_dir().map(|h| h.to_string_lossy().into_owned());
    let home = home.as_deref();
    Ok(Upload {
        schema_version: SCHEMA_VERSION,
        session: redact(session, content, home),
        rewrite: rewrite_measurement(ledger, session, home)?,
        lines: if line_hashes && content != Content::Local {
            added_lines(ledger, session, home)?
        } else {
            Vec::new()
        },
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

/// The repository a server files a session under: its remote, or its root,
/// or the working directory. Empty remote is kept, matching the server,
/// which uses `remote ?? root ?? cwd` and does not skip an empty string.
pub fn submitted_repo(session: &Session) -> Option<String> {
    if let Some(repo) = &session.repo {
        if let Some(remote) = &repo.remote {
            return Some(remote.clone());
        }
        return Some(repo.root.clone());
    }
    session.cwd.clone()
}

// Which name stops which sessions. The rule itself is written in
// `packages/schema/src/repo.ts`, which the server and the dashboard use; the
// four functions below follow it, name for name.

/// A name as rules are written: trimmed, slashes one way, no trailing slash.
/// `/` and nothing are no name.
fn written(text: &str) -> String {
    let mut name = text.trim().replace('\\', "/");
    while name.len() > 1 && name.ends_with('/') {
        name.pop();
    }
    if name == "/" {
        name.clear();
    }
    name
}

/// A path, which covers what is inside it. Anything else is a remote.
fn is_path(name: &str) -> bool {
    name == "~" || name.starts_with("~/") || name.starts_with('/')
}

/// Whether sessions filed under `repo` are stopped by `rule`. `~/Downloads`
/// covers `~/Downloads/notes` and not `~/Downloads-backup`.
pub fn repo_covered(repo: &str, rule: &str) -> bool {
    let name = repo.replace('\\', "/");
    let stopped = written(rule);
    if stopped.is_empty() {
        return false;
    }
    name == stopped || (is_path(&stopped) && name.starts_with(&format!("{stopped}/")))
}

/// Whether one session is stopped by one of `rules`. A path also stops a
/// session that ran inside it and is filed under something else: a clone
/// with a remote, in a stopped folder.
pub fn session_excluded(session: &Session, rules: &[String]) -> bool {
    let filed = submitted_repo(session);
    let root = session.repo.as_ref().map(|repo| repo.root.as_str());
    rules.iter().any(|rule| {
        let places = if is_path(&written(rule)) {
            [filed.as_deref(), root, session.cwd.as_deref()]
        } else {
            [filed.as_deref(), None, None]
        };
        places
            .into_iter()
            .flatten()
            .any(|name| repo_covered(name, rule))
    })
}

/// The repository `text` names, as a server files sessions.
///
/// A directory that exists is the repository it is in: the origin remote,
/// if it has one, otherwise the path shortened to `~/…`. Anything else is
/// already a name, such as `github.com/owner/name` or `~/Documents`.
pub fn repository_name(text: &str) -> Result<String> {
    let path = expand_home(text.trim());
    let resolved = if path.is_dir() {
        // `.` and `Documents` are directories too: named from the root of
        // the file system, as sessions are, or they would match none.
        let path = absolute(&path);
        let root = crate::git::repo_root(&path).unwrap_or(path);
        if let Some(remote) = crate::git::origin_remote(&root) {
            remote
        } else {
            // The directory the command runs in is named as the file system
            // knows it, which need not be how the home directory is named
            // (on macOS `/var` is a link to `/private/var`): both are tried.
            let home = crate::paths::home_dir();
            let real = home.as_deref().and_then(|dir| dir.canonicalize().ok());
            let root = root.to_string_lossy();
            [home, real]
                .into_iter()
                .flatten()
                .map(|home| relative_path(&root, None, Some(&home.to_string_lossy())))
                .find(|short| short.starts_with('~'))
                .unwrap_or_else(|| root.into_owned())
        }
    } else {
        text.to_string()
    };
    // The same shape the server accepts. `/` exists as a directory, and is
    // still not a repository name.
    let repo = written(&resolved);
    if repo.is_empty() {
        anyhow::bail!("name the repository");
    }
    if repo.chars().count() > 1024 {
        anyhow::bail!("that repository name is too long");
    }
    if repo.chars().any(|c| c.is_control()) {
        anyhow::bail!("that repository name is not valid");
    }
    Ok(repo)
}

/// `path` from the root of the file system, with `.` and `..` worked out.
/// Links are not followed: where one leads need not be the name the
/// sessions were filed under.
fn absolute(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let full = std::env::current_dir()
        .map(|dir| dir.join(path))
        .unwrap_or_else(|_| path.to_path_buf());
    let mut out = std::path::PathBuf::new();
    for part in full.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// `~/…` and `~` from the home directory. Anything else is used as given,
/// so a name like `github.com/owner/name` is not looked up as a path
/// unless that path exists.
fn expand_home(text: &str) -> std::path::PathBuf {
    let Some(home) = crate::paths::home_dir() else {
        return std::path::PathBuf::from(text);
    };
    if text == "~" {
        return home;
    }
    text.strip_prefix("~/")
        .map(|rest| home.join(rest))
        .unwrap_or_else(|| std::path::PathBuf::from(text))
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

use crate::config::{Config, Server};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
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

/// What one session upload did. `excluded` means the repository is stopped.
pub struct PutResult {
    pub excluded: bool,
}

/// What the server says of the repositories this person stopped.
pub struct Stopped {
    pub repos: Vec<String>,
    /// How many times they allowed one again. What stopping deleted can be
    /// sent again from then on, so a number this machine has not seen means
    /// asking which of its sessions the server still has.
    pub allowed_again: u64,
}

impl SendError {
    /// The server has no such route: it is older than stopping a repository.
    /// (Allowing a repository that is not stopped is a 404 too, and says so.)
    pub fn no_such_route(&self) -> bool {
        matches!(
            self,
            SendError::Rejected(message)
                if message.starts_with("HTTP 404") && !message.contains("no such repository")
        )
    }
}

/// Whose certificates to accept: those in the file `SSL_CERT_FILE` names,
/// if it names one with certificates in it, else the list built into the
/// binary. A sandbox whose outbound HTTPS is re-signed on the way out (a
/// Claude Code cloud session) names its own certificate that way, as curl
/// and git expect; without this every upload from there would be refused.
fn root_certs(file: Option<&std::path::Path>) -> ureq::tls::RootCerts {
    use ureq::tls::{parse_pem, PemItem, RootCerts};
    let certs: Vec<_> = file
        .and_then(|path| std::fs::read(path).ok())
        .map(|pem| {
            parse_pem(&pem)
                .filter_map(|item| match item {
                    Ok(PemItem::Certificate(cert)) => Some(cert),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    if certs.is_empty() {
        RootCerts::WebPki
    } else {
        RootCerts::new_with_certs(&certs)
    }
}

fn agent() -> ureq::Agent {
    let cert_file = std::env::var_os("SSL_CERT_FILE").filter(|v| !v.is_empty());
    let roots = root_certs(cert_file.as_deref().map(std::path::Path::new));
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .user_agent(USER_AGENT)
        .tls_config(ureq::tls::TlsConfig::builder().root_certs(roots).build())
        .build()
        .into()
}

/// The body of a public page, for a 2xx answer. No token is sent.
pub fn fetch_text(url: &str) -> Result<String> {
    let mut response = agent().get(url).call()?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        anyhow::bail!("HTTP {status}");
    }
    Ok(response.body_mut().read_to_string()?)
}

impl Client {
    pub fn new(server: &Server) -> Client {
        let agent = agent();
        Client {
            agent,
            base: server.url.trim_end_matches('/').to_string(),
            token: server.token.clone(),
        }
    }

    /// The response body as JSON (null if there is none) for a 2xx answer.
    fn check(
        result: Result<ureq::http::Response<ureq::Body>, ureq::Error>,
    ) -> Result<serde_json::Value, SendError> {
        let mut response = result.map_err(|e| SendError::Unavailable(e.to_string()))?;
        let status = response.status().as_u16();
        let body = response.body_mut().read_to_string().unwrap_or_default();
        if (200..300).contains(&status) {
            return Ok(serde_json::from_str(&body).unwrap_or(serde_json::Value::Null));
        }
        // Prefer the server's own message over the raw body.
        let said = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["error"].as_str().map(String::from))
            .unwrap_or_else(|| body.split_whitespace().collect::<Vec<_>>().join(" "));
        let detail: String = said.chars().take(200).collect();
        let message = if detail.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}: {detail}")
        };
        Err(match status {
            401 | 403 if !is_license_refusal(&body) => SendError::Auth(message),
            400..=499 => SendError::Rejected(message),
            _ => SendError::Unavailable(message),
        })
    }

    /// Check that the server is there and accepts the token.
    pub fn ping(&self) -> Result<(), SendError> {
        self.get("/api/v1/ping").map(|_| ())
    }

    pub fn get(&self, path: &str) -> Result<serde_json::Value, SendError> {
        Self::check(
            self.agent
                .get(format!("{}{path}", self.base))
                .header("Authorization", format!("Bearer {}", self.token))
                .call(),
        )
    }

    pub fn post(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, SendError> {
        Self::check(
            self.agent
                .post(format!("{}{path}", self.base))
                .header("Authorization", format!("Bearer {}", self.token))
                .send_json(body),
        )
    }

    pub fn put(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, SendError> {
        Self::check(
            self.agent
                .put(format!("{}{path}", self.base))
                .header("Authorization", format!("Bearer {}", self.token))
                .send_json(body),
        )
    }

    pub fn delete(&self, path: &str) -> Result<serde_json::Value, SendError> {
        Self::check(
            self.agent
                .delete(format!("{}{path}", self.base))
                .header("Authorization", format!("Bearer {}", self.token))
                .call(),
        )
    }

    /// The repositories this person stopped. None from a server that is
    /// older than stopping one: nothing is stopped there.
    pub fn stopped(&self) -> Result<Option<Stopped>, SendError> {
        let value = match self.get("/api/v1/repos/excluded") {
            Ok(value) => value,
            Err(err) if err.no_such_route() => return Ok(None),
            Err(err) => return Err(err),
        };
        // An older server may answer any address with the dashboard's page.
        let Some(repos) = value.get("repos").and_then(|repos| repos.as_array()) else {
            return Ok(None);
        };
        Ok(Some(Stopped {
            repos: repos
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect(),
            allowed_again: value
                .get("allowed_again")
                .and_then(|n| n.as_u64())
                .unwrap_or(0),
        }))
    }

    /// The sessions of this person the server has from `machine`, as
    /// (source, session id). None if the answer is not a list of them.
    pub fn held_sessions(
        &self,
        machine: &str,
    ) -> Result<Option<HashSet<(String, String)>>, SendError> {
        let value = self.get(&format!(
            "/api/v1/sessions/held?machine={}",
            url_segment(machine)
        ))?;
        let Some(list) = value.get("sessions").and_then(|list| list.as_array()) else {
            return Ok(None);
        };
        Ok(Some(
            list.iter()
                .filter_map(|item| {
                    Some((
                        item.get("source")?.as_str()?.to_string(),
                        item.get("session_id")?.as_str()?.to_string(),
                    ))
                })
                .collect(),
        ))
    }

    /// Stop submitting `repo` and delete the sessions already submitted from it.
    pub fn exclude_repo(&self, repo: &str) -> Result<serde_json::Value, SendError> {
        self.put(
            "/api/v1/repos/excluded",
            &serde_json::json!({ "repo": repo }),
        )
    }

    /// Submit `repo` again. Sessions already deleted are not restored by this.
    pub fn include_repo(&self, repo: &str) -> Result<serde_json::Value, SendError> {
        self.delete(&format!(
            "/api/v1/repos/excluded?repo={}",
            url_segment(repo)
        ))
    }

    /// Store or replace one session on the server.
    pub fn put_session(&self, upload: &Upload) -> Result<PutResult, SendError> {
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
        .map(|body| PutResult {
            excluded: body.get("excluded").and_then(|v| v.as_bool()) == Some(true),
        })
    }
}

/// A 403 about the license or the caller's role is about this request, not
/// about the token being wrong.
fn is_license_refusal(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["code"].as_str().map(String::from))
        .is_some_and(|code| code.starts_with("license_") || code == "admins_only")
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
    /// Sessions from a repository this person stopped submitting.
    pub excluded: u64,
    /// Sessions that could not be sent, with the reason.
    pub failed: Vec<(String, String)>,
    /// Set when the run stopped early; nothing after that point was tried.
    pub stopped: Option<String>,
    /// Set when a dry run could not ask the server what is stopped or what
    /// it still has, with the reason: it counted without knowing.
    pub unasked: Option<String>,
}

impl Report {
    pub fn summary(&self) -> String {
        let mut text = format!(
            "uploaded {} ({} unchanged, {} excluded, {} failed)",
            self.sent,
            self.unchanged,
            self.excluded,
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
    // The server's list is what decides, and the server refuses a stopped
    // repository itself. Asking first keeps such a session from being sent
    // at all. A token that only uploads (a cloud environment's) may not
    // ask, and is answered 403: it sends, and the server sorts it out.
    let stopped = match client.stopped() {
        Ok(stopped) => stopped,
        Err(SendError::Auth(message)) if message.starts_with("HTTP 403") => None,
        // Counting needs no server. Without one, nothing is known to be stopped.
        Err(err) if dry_run => {
            report.unasked = Some(err.to_string());
            None
        }
        // A server that does not answer this would not take a session either.
        Err(err) => {
            report.stopped = Some(err.to_string());
            return Ok(report);
        }
    };
    let allowed_again = stopped.as_ref().map(|stopped| stopped.allowed_again);
    let mut rules = stopped.map(|stopped| stopped.repos).unwrap_or_default();
    // A repository was allowed again since this machine last looked. What
    // stopping it deleted is still marked here as sent, from this machine
    // or while another did the stopping and allowing: ask what is there.
    let mut held = None;
    if let Some(times) = allowed_again {
        if times != ledger.allowed_again_seen(&server.url)? {
            match client.held_sessions(&config.machine_id) {
                Ok(sessions) => held = sessions,
                Err(err) if dry_run => report.unasked = Some(err.to_string()),
                Err(err) => {
                    report.stopped = Some(err.to_string());
                    return Ok(report);
                }
            }
        }
    }
    for id in ledger.session_ids()? {
        let Some(session) = ledger.get(&id)? else {
            continue;
        };
        let payload = build(
            ledger,
            &session,
            config.upload_content,
            config.upload_line_hashes,
        )?;
        if session_excluded(&payload.session, &rules) {
            report.excluded += 1;
            continue;
        }
        let hash = payload_hash(&payload);
        let sent = ledger.uploaded_hash(&id, &server.url)?;
        // Sent once, and the server does not have it: it was deleted when
        // its repository was stopped, and is sent again.
        let deleted = sent.is_some()
            && held.as_ref().is_some_and(|held| {
                let s = &payload.session;
                !held.contains(&(s.source.clone(), s.session_id.clone()))
            });
        if deleted && !dry_run {
            ledger.forget_upload(&id, &server.url)?;
        }
        if !deleted && sent.as_deref() == Some(hash.as_str()) {
            report.unchanged += 1;
            continue;
        }
        if dry_run {
            report.sent += 1;
            continue;
        }
        match client.put_session(&payload) {
            Ok(result) if result.excluded => {
                // Stopped since the list was read, or the list could not be
                // read. The rest of that repository need not be sent to learn it.
                if let Some(name) = submitted_repo(&payload.session) {
                    if !rules.iter().any(|rule| rule == &name) {
                        rules.push(name);
                    }
                }
                ledger.forget_upload(&id, &server.url)?;
                report.excluded += 1;
                unreachable = 0;
            }
            Ok(_) => {
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
    // Every session was compared with what the server has: nothing more to
    // ask until a repository is allowed again.
    if let Some(times) = allowed_again {
        if held.is_some() && !dry_run && report.stopped.is_none() {
            ledger.saw_allowed_again(&server.url, times)?;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod send_tests {
    use super::*;
    use crate::session::Session;

    const TEST_ROOT: &str = "-----BEGIN CERTIFICATE-----\n\
MIIBkzCCATmgAwIBAgIUMqwuwKivQuHPdTx3XTffenXz6iYwCgYIKoZIzj0EAwIw\n\
HjEcMBoGA1UEAwwTU2Vzc2lvbmx5IHRlc3Qgcm9vdDAgFw0yNjExMTQxMzU3NTla\n\
GA8yMTI2MTAyMTEzNTc1OVowHjEcMBoGA1UEAwwTU2Vzc2lvbmx5IHRlc3Qgcm9v\n\
dDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABH9Q+GgpnZUzUofUH5yy7dBItB5q\n\
FGyQ3n7LC0ZtfYV28Gnq/zwh/61wHQvi0Jp72rJxczUEAzxMX8vPhRY82KqjUzBR\n\
MB0GA1UdDgQWBBSqcwZMe68cUp5A6/V80aZWP+7NAzAfBgNVHSMEGDAWgBSqcwZM\n\
e68cUp5A6/V80aZWP+7NAzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gA\n\
MEUCIQD/GGpV2axLeXGbkqFDKzVOvVXX3KKC6M9MGVUtLgk8vwIgNRUflMHi/u/P\n\
JTGUMfPdGlEUsqI/6GEgOApBFCDeE5Y=\n\
-----END CERTIFICATE-----\n";

    #[test]
    fn a_named_certificate_file_replaces_the_built_in_list() {
        use ureq::tls::RootCerts;
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(root_certs(None), RootCerts::WebPki));
        assert!(matches!(
            root_certs(Some(&dir.path().join("missing.pem"))),
            RootCerts::WebPki
        ));
        let empty = dir.path().join("empty.pem");
        std::fs::write(&empty, "nothing to see\n").unwrap();
        assert!(matches!(root_certs(Some(&empty)), RootCerts::WebPki));

        let bundle = dir.path().join("ca.pem");
        std::fs::write(&bundle, format!("# a bundle\n{TEST_ROOT}\n{TEST_ROOT}")).unwrap();
        match root_certs(Some(&bundle)) {
            RootCerts::Specific(certs) => assert_eq!(certs.len(), 2),
            _ => panic!("the file's certificates were not used"),
        }
    }

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
            lines: Vec::new(),
        };
        let before = payload_hash(&upload);
        upload.rewrite.as_mut().unwrap().measured_at = Some(Utc::now());
        assert_eq!(payload_hash(&upload), before);
        upload.rewrite.as_mut().unwrap().lines_surviving = 3;
        assert_ne!(payload_hash(&upload), before);
        assert_eq!(before.len(), 64);
    }

    #[test]
    fn line_hashes_are_sent_only_when_switched_on() {
        use crate::ledger::Fingerprint;
        use crate::rewrite::FileLines;
        use crate::session::{Content, FileTouched, Repo};
        let dir = tempfile::tempdir().unwrap();
        let mut ledger = Ledger::open(&dir.path().join("ledger.db")).unwrap();
        let session = Session {
            session_id: "s".into(),
            repo: Some(Repo {
                root: "/w/repo".into(),
                ..Default::default()
            }),
            files: vec![FileTouched {
                path: "/w/repo/src/a.rs".into(),
                writes: 1,
                ..Default::default()
            }],
            ..Default::default()
        };
        let lines = [FileLines {
            path: "/w/repo/src/a.rs".into(),
            by_model: vec![
                (None, vec![0x0807_0605_0403_0201]),
                (Some("claude-opus-5-5".into()), vec![2, 3]),
            ],
        }];
        let built_from = Fingerprint {
            built_with: "test".into(),
            raw_bytes: 1,
            transcript_path: None,
            transcript_bytes: 0,
        };
        ledger.upsert(&session, &built_from, &lines).unwrap();

        let off = build(&ledger, &session, Content::Metadata, false).unwrap();
        assert!(off.lines.is_empty());
        assert!(!serde_json::to_string(&off).unwrap().contains("\"lines\""));

        let on = build(&ledger, &session, Content::Metadata, true).unwrap();
        let sent: Vec<_> = on
            .lines
            .iter()
            .map(|l| (l.path.as_str(), l.model.as_deref(), l.hashes.clone()))
            .collect();
        assert_eq!(
            sent,
            [
                ("src/a.rs", None, vec!["0102030405060708".to_string()]),
                (
                    "src/a.rs",
                    Some("claude-opus-5-5"),
                    vec![
                        "0200000000000000".to_string(),
                        "0300000000000000".to_string()
                    ]
                ),
            ]
        );
        assert_ne!(payload_hash(&on), payload_hash(&off));
        // a record that stays on the machine carries none
        assert!(build(&ledger, &session, Content::Local, true)
            .unwrap()
            .lines
            .is_empty());
    }

    #[test]
    fn url_segments_are_safe() {
        assert_eq!(url_segment("abc-123_x.y"), "abc-123_x.y");
        assert_eq!(url_segment("a/b ?#"), "a%2Fb%20%3F%23");
        assert_eq!(url_segment("é"), "%C3%A9");
    }
}

#[cfg(test)]
mod repo_rules {
    use super::*;

    #[test]
    fn a_path_covers_what_is_inside_it_and_a_remote_does_not() {
        assert!(repo_covered("~/Downloads", "~/Downloads"));
        assert!(repo_covered("~/Downloads/notes", "~/Downloads"));
        assert!(repo_covered("~/Downloads\\notes", "~/Downloads"));
        assert!(repo_covered("~/Downloads/a", "~/Downloads/"));
        assert!(!repo_covered("~/Downloads-backup", "~/Downloads"));
        assert!(!repo_covered("~/downloads", "~/Downloads"));
        assert!(repo_covered("github.com/acme/web", "github.com/acme/web"));
        assert!(!repo_covered(
            "github.com/acme/web-ui",
            "github.com/acme/web"
        ));
        assert!(!repo_covered(
            "github.com/acme/web/extra",
            "github.com/acme/web"
        ));
        assert!(repo_covered("~/Documents", "~"));
        assert!(repo_covered("~/Documents", "~/"));
        assert!(!repo_covered("/tmp/x", "~"));
        assert!(!repo_covered("github.com/acme/web", "~"));
        assert!(repo_covered("~/100%_done/child", "~/100%_done"));
        assert!(!repo_covered("~/100XYdone/child", "~/100%_done"));
        assert!(!repo_covered("", "~/Documents"));
        assert!(!repo_covered("~/Documents", ""));
        assert!(!repo_covered("~/Documents", " "));
        assert!(!repo_covered("~/Documents", "/"));
    }

    #[test]
    fn a_stopped_folder_covers_a_clone_inside_it_that_is_filed_under_its_remote() {
        let rules = |rule: &str| vec![rule.to_string()];
        let clone = Session {
            cwd: Some("~/Documents/client-x/app".into()),
            repo: Some(crate::session::Repo {
                root: "~/Documents/client-x".into(),
                remote: Some("github.com/acme/client-x".into()),
                branch: None,
            }),
            ..Default::default()
        };
        assert!(session_excluded(&clone, &rules("~/Documents")));
        assert!(session_excluded(&clone, &rules("~/Documents/client-x/app")));
        assert!(session_excluded(&clone, &rules("github.com/acme/client-x")));
        assert!(!session_excluded(&clone, &rules("~/Docs")));
        assert!(!session_excluded(&clone, &[]));
        // A remote is only the name a session is filed under.
        let odd = Session {
            repo: Some(crate::session::Repo {
                root: "github.com/acme/other".into(),
                remote: Some("github.com/acme/web".into()),
                branch: None,
            }),
            ..Default::default()
        };
        assert!(!session_excluded(&odd, &rules("github.com/acme/other")));
        let loose = Session {
            cwd: Some("~/Downloads/notes".into()),
            ..Default::default()
        };
        assert!(session_excluded(&loose, &rules("~/Downloads")));
        assert!(!session_excluded(&Session::default(), &rules("~")));
    }

    #[test]
    fn a_path_is_worked_out_from_the_root_without_following_links() {
        let here = std::env::current_dir().unwrap();
        assert_eq!(absolute(std::path::Path::new(".")), here);
        assert_eq!(absolute(std::path::Path::new("notes/../.")), here);
        assert_eq!(absolute(std::path::Path::new("notes")), here.join("notes"));
        #[cfg(unix)]
        assert_eq!(
            absolute(std::path::Path::new("/a/./b/../c")),
            std::path::Path::new("/a/c")
        );
    }

    #[test]
    fn a_directory_is_named_as_its_remote_or_its_shortened_path() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}");
        };
        git(&["init", "--quiet", "--initial-branch", "main"]);
        let path = dir.path().to_string_lossy().into_owned();
        let home = crate::paths::home_dir().map(|home| home.to_string_lossy().into_owned());
        assert_eq!(
            repository_name(&path).unwrap(),
            relative_path(&path, None, home.as_deref())
        );

        git(&["remote", "add", "origin", "git@github.com:acme/hidden.git"]);
        assert_eq!(repository_name(&path).unwrap(), "github.com/acme/hidden");
        let nested = dir.path().join("docs");
        std::fs::create_dir(&nested).unwrap();
        assert_eq!(
            repository_name(&nested.to_string_lossy()).unwrap(),
            "github.com/acme/hidden"
        );

        assert_eq!(
            repository_name("github.com/acme/web").unwrap(),
            "github.com/acme/web"
        );
        assert_eq!(
            repository_name(" ~/sessionly-test-no-such-repo-9f3a/ ").unwrap(),
            "~/sessionly-test-no-such-repo-9f3a"
        );
        assert_eq!(
            repository_name("~\\sessionly-test-no-such-repo-9f3a\\notes").unwrap(),
            "~/sessionly-test-no-such-repo-9f3a/notes"
        );
        assert_eq!(repository_name("~").unwrap(), "~");
        assert_eq!(repository_name("~/").unwrap(), "~");
        assert!(repository_name("").is_err());
        assert!(repository_name("   ").is_err());
        assert!(repository_name("/").is_err());
        assert!(repository_name(&"a".repeat(1025)).is_err());
        assert!(repository_name("has\nbreak").is_err());
        // As the server checks a name: any control character, and length in characters.
        assert!(repository_name("has\u{85}a control").is_err());
        assert!(repository_name(&"😀".repeat(1024)).is_ok());
        assert!(repository_name(&"😀".repeat(1025)).is_err());
    }
}
