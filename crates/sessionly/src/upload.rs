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
