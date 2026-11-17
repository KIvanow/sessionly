//! Where a session runs: on the machine of the person who started it, or in
//! a sandbox a cloud platform started for them.
//!
//! In a sandbox the usual sources of "who" are wrong: git is set up as the
//! agent (`Claude <noreply@anthropic.com>`, `Cursor Agent
//! <cursoragent@cursor.com>`), and the home directory is new each time. What
//! the platform says instead is read here, when a hook runs, and stored with
//! the event:
//!
//! - Claude Code's cloud sessions put it in the environment
//!   (`CLAUDE_CODE_REMOTE=true`, the cloud session id, how the session was
//!   started, the person's email).
//! - Cursor's cloud agents serve it from a Unix socket (`$CURSOR_AGENT_SOCKET`).
//! - Codex's cloud is the exception: git there is set up as the person, and
//!   the environment names the thread (`CODEX_THREAD_ID`) and, only there,
//!   the cloud environment (`CODEX_ENVIRONMENT_ID`).
//!
//! Checked against one real session on each platform, 2026-11-14, and on
//! Codex's cloud 2026-11-17.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::paths::{CLAUDE_CODE, CODEX, CURSOR};

/// The machine id every sandbox uses. A sandbox is new each time, so an id of
/// its own would file one session under several machines when it moves.
pub const CLOUD_MACHINE_ID: &str = "cloud";

const DEFAULT_CURSOR_SOCKET: &str = "/run/cursor/api.sock";

/// What the process environment says, for the checks below. Tests pass their own.
pub struct Surroundings<'a> {
    pub env: &'a dyn Fn(&str) -> Option<String>,
}

impl Surroundings<'_> {
    fn var(&self, name: &str) -> Option<String> {
        (self.env)(name).filter(|value| !value.trim().is_empty())
    }

    fn claude_cloud(&self) -> bool {
        self.var("CLAUDE_CODE_REMOTE").as_deref() == Some("true")
    }

    /// The metadata socket of a Cursor cloud agent, if this is one.
    fn cursor_socket(&self) -> Option<PathBuf> {
        let path = self
            .var("CURSOR_AGENT_SOCKET")
            .unwrap_or_else(|| DEFAULT_CURSOR_SOCKET.to_string());
        let path = PathBuf::from(path);
        is_socket(&path).then_some(path)
    }

    /// The thread of a Codex cloud task, if a command runs in one. Codex
    /// names the thread to every command it runs, on a person's machine
    /// too; the cloud environment it names only in its cloud.
    pub fn codex_cloud(&self) -> Option<String> {
        self.var("CODEX_ENVIRONMENT_ID")?;
        self.var("CODEX_THREAD_ID")
    }

    pub fn in_cloud(&self) -> bool {
        self.claude_cloud() || self.cursor_socket().is_some() || self.codex_cloud().is_some()
    }

    /// What to store with a hook event of `source`: null outside a cloud
    /// session. Cursor's socket is only asked when a prompt is sent and when a
    /// turn ends; every other event just says that it ran in the cloud.
    pub fn describe(&self, source: &str, hook: &str) -> Option<Value> {
        match source {
            CLAUDE_CODE if self.claude_cloud() => Some(json!({
                "kind": "cloud",
                "id": self.var("CLAUDE_CODE_REMOTE_SESSION_ID"),
                "started_from": self.var("CLAUDE_CODE_ENTRYPOINT"),
                "user_email": self.var("CLAUDE_CODE_USER_EMAIL"),
            })),
            CURSOR => {
                let socket = self.cursor_socket()?;
                let hook = hook.to_lowercase();
                if hook != "beforesubmitprompt" && hook != "stop" {
                    return Some(json!({ "kind": "cloud" }));
                }
                let ask = |key: &str| metadata(&socket, key);
                Some(json!({
                    "kind": "cloud",
                    "id": ask("agent/id"),
                    "started_from": ask("agent/source").map(|s| s.to_lowercase()),
                    // An agent belongs to one person, whoever sent this turn.
                    "user_email": ask("owner/user-email").or_else(|| ask("turn/user-email")),
                }))
            }
            // Git in Codex's sandbox is set up as the person who started the
            // task, so it is asked: without this the session would be nobody's.
            CODEX => {
                let thread = self.codex_cloud()?;
                let email = std::env::current_dir()
                    .ok()
                    .and_then(|dir| crate::git::user(&dir).1);
                Some(json!({
                    "kind": "cloud",
                    "id": thread,
                    "started_from": null,
                    "user_email": email,
                }))
            }
            _ => None,
        }
    }
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Whether this process runs in a cloud session's sandbox.
pub fn in_cloud() -> bool {
    Surroundings { env: &process_env }.in_cloud()
}

/// See [`Surroundings::codex_cloud`].
pub fn codex_cloud() -> Option<String> {
    Surroundings { env: &process_env }.codex_cloud()
}

/// See [`Surroundings::describe`].
pub fn describe(source: &str, hook: &str) -> Option<Value> {
    Surroundings { env: &process_env }.describe(source, hook)
}

/// What the events of one session say about where it ran: each field as it
/// was last reported. `None` for a session on a person's own machine.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Seen {
    pub id: Option<String>,
    pub started_from: Option<String>,
    pub user_email: Option<String>,
}

impl Seen {
    pub fn of(events: &[Value]) -> Option<Seen> {
        let mut seen = None::<Seen>;
        for event in events {
            Seen::note(&mut seen, event);
        }
        seen
    }

    /// Take in what one stored event says.
    pub fn note(seen: &mut Option<Seen>, event: &Value) {
        let said = &event["runtime"];
        if said["kind"] != "cloud" {
            return;
        }
        let seen = seen.get_or_insert_with(Seen::default);
        let text = |key: &str| said[key].as_str().filter(|v| !v.is_empty());
        for (field, key) in [
            (&mut seen.id, "id"),
            (&mut seen.started_from, "started_from"),
            (&mut seen.user_email, "user_email"),
        ] {
            if let Some(value) = text(key) {
                *field = Some(value.to_string());
            }
        }
    }

    /// As stored with an event.
    pub fn to_json(&self) -> Value {
        json!({
            "kind": "cloud",
            "id": self.id,
            "started_from": self.started_from,
            "user_email": self.user_email,
        })
    }
}

#[cfg(unix)]
fn is_socket(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::metadata(path).is_ok_and(|m| m.file_type().is_socket())
}

#[cfg(not(unix))]
fn is_socket(_path: &Path) -> bool {
    false
}

/// One value from Cursor's metadata socket: `GET /v1/meta-data/<key>`. `None`
/// if it is not served, or the socket does not answer within a moment (a
/// hook must not hold the session up).
#[cfg(unix)]
fn metadata(socket: &Path, key: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::time::Duration;

    const WAIT: Duration = Duration::from_millis(400);
    const MAX_ANSWER: usize = 16 * 1024;

    let mut stream = std::os::unix::net::UnixStream::connect(socket).ok()?;
    stream.set_read_timeout(Some(WAIT)).ok()?;
    stream.set_write_timeout(Some(WAIT)).ok()?;
    let request = format!(
        "GET /v1/meta-data/{key} HTTP/1.1\r\nHost: cursor-agent\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut answer = Vec::new();
    let mut chunk = [0u8; 2048];
    // Until the socket closes, the answer is complete, or it takes too long.
    while answer.len() < MAX_ANSWER {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => answer.extend_from_slice(&chunk[..n]),
        }
        if body_of(&answer).is_some_and(|(_, complete)| complete) {
            break;
        }
    }
    let (body, _) = body_of(&answer)?;
    let value = body.trim();
    (!value.is_empty() && value.len() <= 300 && !value.contains('\n')).then(|| value.to_string())
}

#[cfg(not(unix))]
fn metadata(_socket: &Path, _key: &str) -> Option<String> {
    None
}

/// The body of an HTTP/1.1 answer with status 200, and whether all of it has
/// arrived. `None` for any other status, or before the headers end.
#[cfg_attr(not(unix), allow(dead_code))]
fn body_of(answer: &[u8]) -> Option<(String, bool)> {
    let text = String::from_utf8_lossy(answer);
    let (head, body) = text.split_once("\r\n\r\n")?;
    let mut lines = head.split("\r\n");
    if lines.next()?.split_whitespace().nth(1)? != "200" {
        return None;
    }
    let header = |name: &str| {
        head.split("\r\n").skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_lowercase())
        })
    };
    if header("transfer-encoding").is_some_and(|v| v.contains("chunked")) {
        let mut out = String::new();
        let mut rest = body;
        loop {
            let Some((size, after)) = rest.split_once("\r\n") else {
                return Some((out, false));
            };
            let size = size.split(';').next().unwrap_or_default().trim();
            let Ok(size) = usize::from_str_radix(size, 16) else {
                return Some((out, false));
            };
            if size == 0 {
                return Some((out, true));
            }
            let Some(piece) = after.get(..size) else {
                return Some((out, false));
            };
            out.push_str(piece);
            rest = after.get(size..)?.trim_start_matches("\r\n");
        }
    }
    match header("content-length").and_then(|v| v.parse::<usize>().ok()) {
        Some(length) => Some((
            body.get(..length.min(body.len()))?.to_string(),
            body.len() >= length,
        )),
        // No length given: the body runs until the socket closes.
        None => Some((body.to_string(), false)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn with<'a>(vars: &'a HashMap<&'static str, String>) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| vars.get(name).cloned()
    }

    #[test]
    fn a_session_on_someones_own_machine_says_nothing() {
        let vars = HashMap::from([("CURSOR_AGENT_SOCKET", "/nonexistent/api.sock".to_string())]);
        let env = with(&vars);
        let here = Surroundings { env: &env };
        assert!(!here.in_cloud());
        assert_eq!(here.describe(CLAUDE_CODE, "SessionStart"), None);
        assert_eq!(here.describe(CURSOR, "beforeSubmitPrompt"), None);
        assert_eq!(here.describe("grok", "SessionStart"), None);
    }

    #[test]
    fn claude_codes_cloud_says_who_and_how_in_the_environment() {
        let vars = HashMap::from([
            ("CLAUDE_CODE_REMOTE", "true".to_string()),
            ("CLAUDE_CODE_REMOTE_SESSION_ID", "cse_01abc".to_string()),
            ("CLAUDE_CODE_ENTRYPOINT", "remote_mobile".to_string()),
            ("CLAUDE_CODE_USER_EMAIL", "ann@example.com".to_string()),
            ("CURSOR_AGENT_SOCKET", "/nonexistent/api.sock".to_string()),
        ]);
        let env = with(&vars);
        let here = Surroundings { env: &env };
        assert!(here.in_cloud());
        assert_eq!(
            here.describe(CLAUDE_CODE, "Stop"),
            Some(json!({
                "kind": "cloud",
                "id": "cse_01abc",
                "started_from": "remote_mobile",
                "user_email": "ann@example.com",
            }))
        );
        // Another agent's events in the same sandbox are not Claude Code's.
        assert_eq!(here.describe(CURSOR, "stop"), None);

        // A sandbox started ahead of time has no person and no session yet.
        let vars = HashMap::from([
            ("CLAUDE_CODE_REMOTE", "true".to_string()),
            ("CURSOR_AGENT_SOCKET", "/nonexistent/api.sock".to_string()),
        ]);
        let env = with(&vars);
        let early = Surroundings { env: &env }.describe(CLAUDE_CODE, "SessionStart");
        assert_eq!(
            early,
            Some(json!({ "kind": "cloud", "id": null, "started_from": null, "user_email": null }))
        );
    }

    #[test]
    fn codex_names_its_cloud_only_there() {
        let nowhere = ("CURSOR_AGENT_SOCKET", "/nonexistent/api.sock".to_string());
        // On a person's machine Codex names the thread and nothing more.
        let vars = HashMap::from([nowhere.clone(), ("CODEX_THREAD_ID", "t-1".to_string())]);
        let env = with(&vars);
        let here = Surroundings { env: &env };
        assert!(!here.in_cloud());
        assert_eq!(here.describe(CODEX, "Stop"), None);

        let vars = HashMap::from([
            nowhere,
            ("CODEX_THREAD_ID", "t-1".to_string()),
            ("CODEX_ENVIRONMENT_ID", "ccarenv_1".to_string()),
        ]);
        let env = with(&vars);
        let there = Surroundings { env: &env };
        assert!(there.in_cloud());
        let said = there.describe(CODEX, "Stop").unwrap();
        assert_eq!(said["kind"], "cloud");
        assert_eq!(said["id"], "t-1");
        // Another agent's events are not Codex's.
        assert_eq!(there.describe(CLAUDE_CODE, "Stop"), None);
    }

    /// Serves Cursor's metadata on a socket in `dir`: `answers` by path.
    #[cfg(unix)]
    fn serve(dir: &Path, answers: &[(&str, &str)], chunked: bool) -> PathBuf {
        use std::io::{Read, Write};
        let path = dir.join("api.sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let answers: HashMap<String, String> = answers
            .iter()
            .map(|(k, v)| (format!("/v1/meta-data/{k}"), v.to_string()))
            .collect();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut request = [0u8; 1024];
                let n = stream.read(&mut request).unwrap_or(0);
                let request = String::from_utf8_lossy(&request[..n]).into_owned();
                let asked = request.split_whitespace().nth(1).unwrap_or_default();
                let reply = match answers.get(asked) {
                    Some(value) if chunked => format!(
                        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{value}\r\n0\r\n\r\n",
                        value.len()
                    ),
                    Some(value) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\r\n{value}",
                        value.len()
                    ),
                    None => {
                        let body = r#"{"error":"not_found","usage":"GET /v1/meta-data[/<path>]"}"#;
                        format!(
                            "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        )
                    }
                };
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        path
    }

    #[cfg(unix)]
    #[test]
    fn cursors_cloud_is_asked_at_its_socket_when_a_turn_starts_or_ends() {
        for chunked in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let socket = serve(
                dir.path(),
                &[
                    ("agent/id", "bc-64f0fb8f"),
                    ("agent/source", "WEBSITE\n"),
                    ("owner/user-email", "ann@example.com"),
                    ("turn/user-email", "someone-else@example.com"),
                ],
                chunked,
            );
            let vars =
                HashMap::from([("CURSOR_AGENT_SOCKET", socket.to_string_lossy().into_owned())]);
            let env = with(&vars);
            let here = Surroundings { env: &env };
            assert!(here.in_cloud());
            let full = json!({
                "kind": "cloud",
                "id": "bc-64f0fb8f",
                "started_from": "website",
                "user_email": "ann@example.com",
            });
            assert_eq!(
                here.describe(CURSOR, "beforeSubmitPrompt"),
                Some(full.clone())
            );
            assert_eq!(here.describe(CURSOR, "stop"), Some(full));
            // Every other event costs nothing: the socket is not asked.
            assert_eq!(
                here.describe(CURSOR, "preToolUse"),
                Some(json!({ "kind": "cloud" }))
            );
            assert_eq!(here.describe(CLAUDE_CODE, "Stop"), None);
            // What the socket does not serve is left out, not stored as an error.
            assert_eq!(metadata(&socket, "workspace/branch-name"), None);
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_owner_is_the_one_who_sent_the_turn_when_no_owner_is_served() {
        let dir = tempfile::tempdir().unwrap();
        let socket = serve(dir.path(), &[("turn/user-email", "bo@example.com")], false);
        let vars = HashMap::from([("CURSOR_AGENT_SOCKET", socket.to_string_lossy().into_owned())]);
        let env = with(&vars);
        let said = Surroundings { env: &env }.describe(CURSOR, "stop").unwrap();
        assert_eq!(said["user_email"], "bo@example.com");
        assert_eq!(said["id"], Value::Null);
    }

    #[test]
    fn reads_an_answer_whichever_way_its_length_is_given() {
        let ok = |rest: &str| format!("HTTP/1.1 200 OK\r\n{rest}");
        assert_eq!(
            body_of(ok("Content-Length: 5\r\n\r\nhello").as_bytes()),
            Some(("hello".into(), true))
        );
        assert_eq!(
            body_of(ok("content-length: 5\r\n\r\nhel").as_bytes()),
            Some(("hel".into(), false))
        );
        assert_eq!(
            body_of(
                ok("Transfer-Encoding: chunked\r\n\r\n3\r\nhel\r\n2\r\nlo\r\n0\r\n\r\n").as_bytes()
            ),
            Some(("hello".into(), true))
        );
        assert_eq!(
            body_of(ok("Transfer-Encoding: chunked\r\n\r\n3\r\nhel\r\n").as_bytes()),
            Some(("hel".into(), false))
        );
        assert_eq!(
            body_of(ok("Server: x\r\n\r\nhello").as_bytes()),
            Some(("hello".into(), false))
        );
        assert_eq!(body_of(b"HTTP/1.1 404 Not Found\r\n\r\nno"), None);
        assert_eq!(body_of(b"HTTP/1.1 200 OK\r\nContent-Le"), None);
    }

    #[test]
    fn a_sessions_events_are_summed_up_field_by_field() {
        let event = |runtime: Value| json!({ "hook": "x", "runtime": runtime });
        assert_eq!(Seen::of(&[json!({ "hook": "x" })]), None);
        let seen = Seen::of(&[
            event(json!({ "kind": "cloud", "id": null, "user_email": null })),
            event(json!({ "kind": "cloud", "id": "cse_1", "started_from": "remote", "user_email": "ann@example.com" })),
            event(json!({ "kind": "cloud" })),
            json!({ "hook": "x" }),
        ])
        .unwrap();
        assert_eq!(seen.id.as_deref(), Some("cse_1"));
        assert_eq!(seen.started_from.as_deref(), Some("remote"));
        assert_eq!(seen.user_email.as_deref(), Some("ann@example.com"));
        assert_eq!(Seen::of(&[event(seen.to_json())]), Some(seen));
        // A session that only ever said "cloud" is still a cloud session.
        assert_eq!(
            Seen::of(&[event(json!({ "kind": "cloud" }))]),
            Some(Seen::default())
        );
    }
}
