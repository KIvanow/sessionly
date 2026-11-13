//! Tests that run the built binary the way Claude Code and a user would.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

fn sessionly(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_sessionly"));
    cmd.env("HOME", home)
        .env("SESSIONLY_HOME", home.join("data"))
        // no background runs unless a test asks for them
        .env("SESSIONLY_NO_AUTO", "1")
        .env_remove("SESSIONLY_TOKEN")
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("USERPROFILE");
    cmd
}

fn run_with_stdin(mut cmd: Command, stdin: &[u8]) -> Output {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // The child may exit without reading everything; that is its business.
    let _ = child.stdin.take().unwrap().write_all(stdin);
    child.wait_with_output().unwrap()
}

fn assert_silent_success(out: &Output, what: &str) {
    assert!(out.status.success(), "{what}: exit {:?}", out.status.code());
    assert!(out.stdout.is_empty(), "{what}: printed to stdout");
    assert!(out.stderr.is_empty(), "{what}: printed to stderr");
}

fn stdout(out: Output) -> String {
    assert!(
        out.status.success(),
        "exit {:?}: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn capture_is_silent_and_exits_zero_whatever_happens() {
    let home = tempfile::tempdir().unwrap();
    let payload = br#"{"session_id":"s1","hook_event_name":"Stop"}"#;

    let mut cmd = sessionly(home.path());
    cmd.arg("capture");
    assert_silent_success(&run_with_stdin(cmd, payload), "normal payload");
    let raw = home.path().join("data/raw/claude-code/s1.jsonl");
    assert_eq!(fs::read_to_string(&raw).unwrap().lines().count(), 1);

    for (what, input) in [("garbage", &b"\xff not json"[..]), ("empty", &b""[..])] {
        let mut cmd = sessionly(home.path());
        cmd.arg("capture");
        assert_silent_success(&run_with_stdin(cmd, input), what);
    }

    // Arguments it doesn't know must not turn into a usage error.
    let mut cmd = sessionly(home.path());
    cmd.args(["capture", "--unknown-flag", "extra"]);
    assert_silent_success(&run_with_stdin(cmd, payload), "unknown arguments");

    // An unwritable data directory.
    let blocked = home.path().join("file-not-dir");
    fs::write(&blocked, "x").unwrap();
    let mut cmd = sessionly(home.path());
    cmd.arg("capture").env("SESSIONLY_HOME", &blocked);
    assert_silent_success(&run_with_stdin(cmd, payload), "unwritable data dir");
}

#[test]
fn capture_without_a_home_writes_nothing() {
    let cwd = tempfile::tempdir().unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_sessionly"));
    cmd.arg("capture")
        .current_dir(cwd.path())
        .env_remove("HOME")
        .env_remove("USERPROFILE")
        .env_remove("SESSIONLY_HOME");
    let out = run_with_stdin(cmd, br#"{"session_id":"s1"}"#);
    assert_silent_success(&out, "no home");
    assert_eq!(fs::read_dir(cwd.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn data_directories_are_private_whichever_command_creates_them() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    stdout(sessionly(home.path()).arg("sync").output().unwrap());
    let mut cmd = sessionly(home.path());
    cmd.arg("capture");
    run_with_stdin(cmd, br#"{"session_id":"s1","hook_event_name":"Stop"}"#);
    for dir in ["data", "data/raw", "data/raw/claude-code"] {
        let mode = fs::metadata(home.path().join(dir))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0, "{dir} is {:o}", mode & 0o777);
    }
    let mode = |f: &str| {
        fs::metadata(home.path().join(f))
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    };
    assert_eq!(mode("data/ledger.db"), 0o600);
    assert_eq!(mode("data/raw/claude-code/s1.jsonl"), 0o600);
}

#[test]
fn install_status_uninstall_round_trip() {
    let home = tempfile::tempdir().unwrap();
    let project = home.path().join("proj");
    let settings = project.join(".claude/settings.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let original = r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"/opt/other/stop"}]}]}}"#;
    fs::write(&settings, original).unwrap();
    let run = |args: &[&str]| {
        stdout(
            sessionly(home.path())
                .args(args)
                .arg("--project")
                .arg(&project)
                .output()
                .unwrap(),
        )
    };

    assert!(run(&["install"]).contains("Installed Sessionly hooks for 20 events"));
    assert!(run(&["install"]).contains("already installed"));
    assert!(run(&["status"]).contains("20/20 events"));
    let installed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
    assert_eq!(installed["hooks"]["Stop"].as_array().unwrap().len(), 2);

    assert!(run(&["uninstall"]).contains("Removed"));
    assert!(run(&["uninstall"]).contains("No Sessionly hooks"));
    assert!(run(&["status"]).contains("0/20 events"));
    let restored: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
    assert_eq!(
        restored,
        serde_json::from_str::<serde_json::Value>(original).unwrap()
    );
    // the backup is the file from before the first install
    assert_eq!(
        fs::read_to_string(project.join(".claude/settings.json.sessionly-bak")).unwrap(),
        original
    );
}

#[test]
fn the_installed_command_really_runs_capture() {
    // Install with a binary path that needs quoting, then run the stored
    // command through a shell exactly as a hook runner would.
    if cfg!(windows) {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let odd_dir = home.path().join("it's a \"dir\" $HOME");
    fs::create_dir_all(&odd_dir).unwrap();
    let exe = odd_dir.join("sessionly");
    fs::copy(env!("CARGO_BIN_EXE_sessionly"), &exe).unwrap();

    let project = home.path().join("proj");
    let mut install = Command::new(&exe);
    install
        .env("HOME", home.path())
        .env("SESSIONLY_HOME", home.path().join("data"))
        .args(["install", "--project"])
        .arg(&project);
    // Running a file right after copying it can fail with "text file busy"
    // while another test thread is spawning a process; retry briefly.
    let installed = (0..50)
        .find_map(|_| match install.output() {
            Err(err) if err.raw_os_error() == Some(26) => {
                std::thread::sleep(std::time::Duration::from_millis(20));
                None
            }
            other => Some(other.unwrap()),
        })
        .expect("copied binary stayed busy");
    stdout(installed);
    let settings: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project.join(".claude/settings.json")).unwrap())
            .unwrap();
    let command = settings["hooks"]["Stop"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();

    let mut hook = Command::new("sh");
    hook.arg("-c")
        .arg(command)
        .env("SESSIONLY_NO_AUTO", "1")
        .env("HOME", home.path())
        .env("SESSIONLY_HOME", home.path().join("data"));
    let out = run_with_stdin(hook, br#"{"session_id":"s9","hook_event_name":"Stop"}"#);
    assert_silent_success(&out, "installed hook command");
    assert!(home.path().join("data/raw/claude-code/s9.jsonl").exists());
}

#[test]
fn capture_then_show() {
    let home = tempfile::tempdir().unwrap();
    for payload in [
        r#"{"session_id":"abc-123","hook_event_name":"SessionStart","source":"startup","cwd":"/nowhere"}"#,
        r#"{"session_id":"abc-123","hook_event_name":"UserPromptSubmit","prompt_id":"p1","prompt":"hello there"}"#,
        r#"{"session_id":"abc-123","hook_event_name":"Stop","prompt_id":"p1"}"#,
    ] {
        let mut cmd = sessionly(home.path());
        cmd.arg("capture");
        run_with_stdin(cmd, payload.as_bytes());
    }
    let json = stdout(
        sessionly(home.path())
            .args(["show", "abc", "--json"])
            .output()
            .unwrap(),
    );
    let record: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(record["session_id"], "abc-123");
    assert_eq!(record["counts"]["prompts"], 1);
    assert_eq!(record["prompts"][0]["outcome"], "completed");
    assert_eq!(record["captured_from_start"], true);
    assert!(record["cost"].is_null());

    let text = stdout(
        sessionly(home.path())
            .args(["show", "abc"])
            .output()
            .unwrap(),
    );
    assert!(text.contains("hello there"));
    let missing = sessionly(home.path())
        .args(["show", "zzz"])
        .output()
        .unwrap();
    assert!(!missing.status.success());
}

#[test]
fn parallel_first_sync_on_a_new_ledger() {
    let home = tempfile::tempdir().unwrap();
    let children: Vec<_> = (0..8)
        .map(|_| {
            sessionly(home.path())
                .arg("sync")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    for child in children {
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

/// Feed one hook payload to `sessionly capture`.
fn capture(home: &Path, payload: serde_json::Value) {
    let mut cmd = sessionly(home);
    cmd.arg("capture");
    let out = run_with_stdin(cmd, payload.to_string().as_bytes());
    assert_silent_success(&out, "capture");
}

/// A session in `cwd` that created `new.txt` (four lines) and added two lines to `old.txt`.
fn capture_editing_session(home: &Path, id: &str, cwd: &Path) {
    use serde_json::json;
    let base = |hook: &str| json!({ "session_id": id, "hook_event_name": hook, "cwd": cwd });
    let mut start = base("SessionStart");
    start["source"] = json!("startup");
    capture(home, start);
    let mut prompt = base("UserPromptSubmit");
    prompt["prompt_id"] = json!("p1");
    prompt["prompt"] = json!("Add the Parser module and wire it in");
    capture(home, prompt);

    let mut write = base("PostToolUse");
    write["tool_use_id"] = json!("t1");
    write["tool_name"] = json!("Write");
    write["tool_input"] = json!({ "file_path": cwd.join("new.txt"),
                                  "content": "alpha one\nbeta two\ngamma three\ndelta four\n" });
    write["tool_response"] = json!({ "type": "create", "structuredPatch": [] });
    capture(home, write);

    let mut edit = base("PostToolUse");
    edit["tool_use_id"] = json!("t2");
    edit["tool_name"] = json!("Edit");
    edit["tool_input"] = json!({ "file_path": cwd.join("old.txt") });
    edit["tool_response"] = json!({ "structuredPatch": [{ "lines":
        [" existing line", "-removed line", "+added first", "+added second", "+}"] }] });
    capture(home, edit);

    let mut stop = base("Stop");
    stop["prompt_id"] = json!("p1");
    capture(home, stop);
}

fn json_of(home: &Path, args: &[&str]) -> serde_json::Value {
    serde_json::from_str(&stdout(sessionly(home).args(args).output().unwrap())).unwrap()
}

#[test]
fn rewrite_rate_follows_the_files_on_disk() {
    let home = tempfile::tempdir().unwrap();
    let repo = home.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    capture_editing_session(home.path(), "edit-1", &repo);
    // The files as the agent left them.
    fs::write(
        repo.join("new.txt"),
        "alpha one\nbeta two\ngamma three\ndelta four\n",
    )
    .unwrap();
    fs::write(
        repo.join("old.txt"),
        "existing line\nadded first\nadded second\n}\n",
    )
    .unwrap();

    let rewrite = |home: &Path| json_of(home, &["list", "--json"])[0]["rewrite"].clone();
    let fresh = rewrite(home.path());
    assert_eq!(fresh["files_measured"], 2);
    assert_eq!(fresh["files_rewritten"], 0);
    // four lines in new.txt, two in old.txt: the lone "}" is not tracked
    assert_eq!(
        (
            fresh["lines_added"].as_u64(),
            fresh["lines_surviving"].as_u64()
        ),
        (Some(6), Some(6))
    );

    // Someone rewrites most of new.txt and re-indents old.txt.
    fs::write(
        repo.join("new.txt"),
        "alpha one\nsomething else\nentirely\ndifferent\n",
    )
    .unwrap();
    fs::write(
        repo.join("old.txt"),
        "existing line\n    added first\n\tadded second\n}\n",
    )
    .unwrap();
    let later = rewrite(home.path());
    assert_eq!(later["files_rewritten"], 1);
    assert_eq!(later["lines_surviving"], 3);
    let shown = stdout(
        sessionly(home.path())
            .args(["show", "edit-1"])
            .output()
            .unwrap(),
    );
    assert!(
        shown.contains("1 of 2 changed files rewritten since"),
        "{shown}"
    );
    assert!(shown.contains("kept 25%"), "{shown}");
    assert!(shown.contains("kept 100%"), "{shown}");

    // A deleted file counts as rewritten.
    fs::remove_file(repo.join("old.txt")).unwrap();
    assert_eq!(rewrite(home.path())["files_rewritten"], 2);
    let shown = stdout(
        sessionly(home.path())
            .args(["show", "edit-1"])
            .output()
            .unwrap(),
    );
    assert!(shown.contains("deleted"), "{shown}");

    // If the whole directory is gone nothing can be measured: the last result stays.
    fs::remove_dir_all(&repo).unwrap();
    let sync = stdout(sessionly(home.path()).arg("sync").output().unwrap());
    assert!(
        sync.contains("2 in directories that no longer exist"),
        "{sync}"
    );
    assert_eq!(rewrite(home.path())["files_rewritten"], 2);
}

#[test]
fn list_filters_and_summary_groups() {
    let home = tempfile::tempdir().unwrap();
    for (id, dir) in [("aaa-1", "storefront"), ("bbb-2", "billing-svc")] {
        let repo = home.path().join(dir);
        fs::create_dir_all(&repo).unwrap();
        capture_editing_session(home.path(), id, &repo);
    }
    let ids = |args: &[&str]| -> Vec<String> {
        let mut all = vec!["list", "--json"];
        all.extend(args);
        json_of(home.path(), &all)
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["session_id"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(ids(&[]).len(), 2);
    assert_eq!(ids(&["--repo", "STOREFRONT"]), ["aaa-1"]);
    assert_eq!(ids(&["--file", "billing-svc/new.txt"]), ["bbb-2"]);
    assert_eq!(ids(&["--search", "parser module"]).len(), 2);
    assert_eq!(ids(&["--search", "no such text"]).len(), 0);
    assert_eq!(ids(&["--since", "1h"]).len(), 2);
    assert_eq!(ids(&["--until", "1h"]).len(), 0);
    assert_eq!(ids(&["--since", "2999-01-01"]).len(), 0);
    assert_eq!(ids(&["--limit", "1"]).len(), 1);
    assert_eq!(ids(&["--min-cost", "0.01"]).len(), 0); // no transcript, so no cost

    let table = stdout(sessionly(home.path()).arg("list").output().unwrap());
    assert!(
        table.contains("aaa-1") && table.contains("Add the Parser module"),
        "{table}"
    );
    let bad = sessionly(home.path())
        .args(["list", "--since", "soon"])
        .output()
        .unwrap();
    assert!(!bad.status.success());

    let by_repo = json_of(home.path(), &["summary", "--by", "repo", "--json"]);
    let groups = by_repo.as_array().unwrap();
    assert_eq!(groups.len(), 3);
    assert_eq!(groups[2]["key"], "total");
    assert_eq!(groups[2]["sessions"], 2);
    assert_eq!(groups[2]["sessions_without_cost"], 2);
    assert_eq!(groups[2]["files_changed"], 4);
    let table = stdout(
        sessionly(home.path())
            .args(["summary", "--by", "day"])
            .output()
            .unwrap(),
    );
    assert!(
        table.contains("DAY (UTC)") && table.contains("total"),
        "{table}"
    );
    let none = stdout(
        sessionly(home.path())
            .args(["summary", "--user", "nobody"])
            .output()
            .unwrap(),
    );
    assert!(none.contains("No sessions match"));
}

#[test]
fn export_shows_what_would_leave_the_machine() {
    let home = tempfile::tempdir().unwrap();
    let repo = home.path().join("repo");
    fs::create_dir_all(repo.join(".git")).unwrap();
    capture_editing_session(home.path(), "exp-1", &repo);
    fs::write(repo.join("new.txt"), "alpha one\nbeta two\n").unwrap();
    let home_text = home.path().to_string_lossy().into_owned();

    // Default level: no text from the session, no absolute paths.
    let text = stdout(
        sessionly(home.path())
            .args(["export", "exp"])
            .output()
            .unwrap(),
    );
    assert!(!text.contains("Parser module"), "{text}");
    assert!(!text.contains(&home_text), "{text}");
    let payload: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(payload["schema_version"], 1);
    let session = &payload["session"];
    assert_eq!(session["content"], "metadata");
    assert_eq!(session["captured_by"], "hooks");
    assert_eq!(session["machine_id"].as_str().unwrap().len(), 36);
    assert_eq!(session["repo"]["root"], "~/repo");
    assert_eq!(session["files"][0]["path"], "new.txt");
    assert_eq!(session["prompts"][0]["text"]["preview"], "");
    assert_eq!(session["prompts"][0]["text"]["chars"], 36);
    assert_eq!(session["tool_calls"][0]["status"], "ok");
    let rewrite = &payload["rewrite"];
    assert_eq!(rewrite["files_measured"], 2);
    assert_eq!(rewrite["files_rewritten"], 1); // old.txt was never written to disk
    assert_eq!(rewrite["files"][0]["path"], "new.txt");
    assert_eq!(rewrite["files"][0]["lines_surviving"], 2);

    // Previews are opt-in; paths stay relative.
    let previews = stdout(
        sessionly(home.path())
            .args(["export", "exp", "--content", "previews"])
            .output()
            .unwrap(),
    );
    assert!(previews.contains("Parser module"));
    assert!(!previews.contains(&home_text));
    // "local" is not something that can be exported
    let local = sessionly(home.path())
        .args(["export", "exp", "--content", "local"])
        .output()
        .unwrap();
    assert!(!local.status.success());

    // The machine id is stable and part of every record.
    let again = json_of(home.path(), &["export", "exp"]);
    assert_eq!(again["session"]["machine_id"], session["machine_id"]);
    let schema = stdout(
        sessionly(home.path())
            .args(["schema", "upload"])
            .output()
            .unwrap(),
    );
    assert!(schema.contains("\"Upload\"") && schema.contains("RewriteMeasurement"));
}

// ---------------------------------------------------------------------------
// Upload, against a stand-in server
// ---------------------------------------------------------------------------

use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
struct Received {
    method: String,
    path: String,
    auth: Option<String>,
    body: String,
}

/// A minimal HTTP server that records requests and answers with `status`.
struct StubServer {
    url: String,
    received: Arc<Mutex<Vec<Received>>>,
    status: Arc<AtomicU16>,
}

impl StubServer {
    fn start() -> StubServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let received = Arc::new(Mutex::new(Vec::new()));
        let status = Arc::new(AtomicU16::new(200));
        let (log, code) = (received.clone(), status.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or_default().to_string();
                let (mut auth, mut length) = (None, 0usize);
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':') {
                        match name.to_ascii_lowercase().as_str() {
                            "authorization" => auth = Some(value.trim().to_string()),
                            "content-length" => length = value.trim().parse().unwrap_or(0),
                            _ => {}
                        }
                    }
                }
                let mut body = vec![0u8; length];
                let _ = reader.read_exact(&mut body);
                log.lock().unwrap().push(Received {
                    method,
                    path,
                    auth,
                    body: String::from_utf8_lossy(&body).into_owned(),
                });
                let status = code.load(Ordering::SeqCst);
                let answer = r#"{"error":"stub says no"}"#;
                let _ = reader.get_mut().write_all(
                    format!(
                        "HTTP/1.1 {status} Stub\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                        answer.len()
                    )
                    .as_bytes(),
                );
            }
        });
        StubServer {
            url,
            received,
            status,
        }
    }

    fn requests(&self) -> Vec<Received> {
        self.received.lock().unwrap().clone()
    }

    fn puts(&self) -> Vec<Received> {
        self.requests()
            .into_iter()
            .filter(|r| r.method == "PUT")
            .collect()
    }

    fn answer_with(&self, status: u16) {
        self.status.store(status, Ordering::SeqCst);
    }
}

fn run(home: &Path, args: &[&str]) -> Output {
    sessionly(home).args(args).output().unwrap()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

#[test]
fn upload_sends_each_session_once_and_again_when_it_changes() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    for (id, dir) in [("up-1", "one"), ("up-2", "two")] {
        let repo = home.path().join(dir);
        fs::create_dir_all(&repo).unwrap();
        capture_editing_session(home.path(), id, &repo);
    }

    // Not connected: nothing to upload to.
    let out = run(home.path(), &["upload"]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("sessionly connect"),
        "{}",
        stderr(&out)
    );

    // Connecting checks the server and the token before saving anything.
    let connected = stdout(run(
        home.path(),
        &["connect", &server.url, "--token", "secret-token"],
    ));
    assert!(
        connected.contains("Connected to") && connected.contains("metadata"),
        "{connected}"
    );
    let ping = &server.requests()[0];
    assert_eq!(
        (ping.method.as_str(), ping.path.as_str()),
        ("GET", "/api/v1/ping")
    );
    assert_eq!(ping.auth.as_deref(), Some("Bearer secret-token"));

    let dry = stdout(run(home.path(), &["upload", "--dry-run"]));
    assert!(dry.contains("Would upload 2 sessions"), "{dry}");
    assert!(server.puts().is_empty());

    let sent = stdout(run(home.path(), &["upload"]));
    assert!(sent.contains("Uploaded 2 sessions"), "{sent}");
    let puts = server.puts();
    assert_eq!(puts.len(), 2);
    let machine_id = json_of(home.path(), &["export", "up-1"])["session"]["machine_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        puts[0].path,
        format!("/api/v1/sessions/{machine_id}/claude-code/up-1")
    );
    assert_eq!(puts[0].auth.as_deref(), Some("Bearer secret-token"));
    let body: serde_json::Value = serde_json::from_str(&puts[0].body).unwrap();
    assert_eq!(body["schema_version"], 1);
    assert_eq!(body["session"]["session_id"], "up-1");
    assert_eq!(body["session"]["content"], "metadata");
    assert_eq!(body["rewrite"]["files_measured"], 2);
    assert!(!puts[0].body.contains("Parser module"));
    assert!(!puts[0].body.contains(&*home.path().to_string_lossy()));

    // Nothing changed: nothing is sent, even though rewrite was re-measured.
    let again = stdout(run(home.path(), &["upload"]));
    assert!(
        again.contains("Uploaded 0 sessions") && again.contains("2 already up to date"),
        "{again}"
    );
    assert_eq!(server.puts().len(), 2);
    let status = stdout(run(home.path(), &["status"]));
    assert!(status.contains("Uploaded:   2 of 2 sessions"), "{status}");
    assert!(status.contains(&server.url), "{status}");

    // One session gets another prompt: only that one is sent again.
    capture(
        home.path(),
        serde_json::json!({ "session_id": "up-2", "hook_event_name": "UserPromptSubmit",
                            "prompt_id": "p2", "prompt": "one more thing" }),
    );
    let changed = stdout(run(home.path(), &["upload"]));
    assert!(changed.contains("Uploaded 1 sessions"), "{changed}");
    assert!(server.puts()[2].path.ends_with("/up-2"));

    // Choosing previews changes what is sent, so everything goes again.
    stdout(run(home.path(), &["settings", "--content", "previews"]));
    stdout(run(home.path(), &["upload"]));
    assert_eq!(server.puts().len(), 5);
    assert!(server.puts()[3].body.contains("Parser module"));
}

#[test]
fn upload_failures_are_reported_and_retried_later() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    let repo = home.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    capture_editing_session(home.path(), "fail-1", &repo);
    stdout(run(home.path(), &["connect", &server.url, "--token", "t"]));

    server.answer_with(401);
    let out = run(home.path(), &["upload"]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("did not accept the token"),
        "{}",
        stderr(&out)
    );

    server.answer_with(422);
    let out = run(home.path(), &["upload"]);
    assert!(!out.status.success());
    let text = stderr(&out);
    assert!(
        text.contains("fail-1 was not uploaded") && text.contains("stub says no"),
        "{text}"
    );

    server.answer_with(503);
    assert!(!run(home.path(), &["upload"]).status.success());

    // Once the server is healthy the same session goes through.
    server.answer_with(200);
    let sent = stdout(run(home.path(), &["upload"]));
    assert!(sent.contains("Uploaded 1 sessions"), "{sent}");

    let gone = stdout(run(home.path(), &["disconnect"]));
    assert!(gone.contains("Disconnected"), "{gone}");
    assert!(!run(home.path(), &["upload"]).status.success());
    assert!(stdout(run(home.path(), &["disconnect"])).contains("Not connected"));
}

#[test]
fn connect_refuses_unsafe_or_unreachable_servers() {
    let home = tempfile::tempdir().unwrap();
    let out = run(
        home.path(),
        &["connect", "http://example.com", "--token", "t"],
    );
    assert!(!out.status.success());
    assert!(stderr(&out).contains("https://"), "{}", stderr(&out));

    // A port nothing listens on.
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port())
    };
    let out = run(home.path(), &["connect", &closed, "--token", "t"]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("Nothing was saved"),
        "{}",
        stderr(&out)
    );
    assert!(stdout(run(home.path(), &["settings"])).contains("not connected"));

    // A wrong token is caught by the check too.
    let server = StubServer::start();
    server.answer_with(403);
    let out = run(home.path(), &["connect", &server.url, "--token", "wrong"]);
    assert!(
        stderr(&out).contains("did not accept the token"),
        "{}",
        stderr(&out)
    );

    // --no-check saves without contacting the server; the token comes from stdin.
    let mut cmd = sessionly(home.path());
    cmd.args(["connect", &closed, "--no-check"]);
    let out = run_with_stdin(cmd, b"typed-token\n");
    assert!(out.status.success(), "{}", stderr(&out));
    let config = fs::read_to_string(home.path().join("data/config.json")).unwrap();
    assert!(config.contains("typed-token") && config.contains(&closed));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(home.path().join("data/config.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    // the token is never printed
    let shown = stdout(run(home.path(), &["settings"]));
    assert!(!shown.contains("typed-token"), "{shown}");
}

#[test]
fn a_session_ending_uploads_in_the_background() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    stdout(run(home.path(), &["connect", &server.url, "--token", "t"]));
    let hook = |payload: serde_json::Value| {
        let mut cmd = sessionly(home.path());
        cmd.arg("capture")
            .env_remove("SESSIONLY_NO_AUTO")
            .env("SESSIONLY_AUTO_DELAY_MS", "0");
        let out = run_with_stdin(cmd, payload.to_string().as_bytes());
        assert_silent_success(&out, "capture with auto sync");
    };
    let wait_for_puts = |count: usize| {
        for _ in 0..150 {
            if server.puts().len() >= count {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        false
    };

    hook(
        serde_json::json!({ "session_id": "bg-1", "hook_event_name": "UserPromptSubmit",
                             "prompt_id": "p1", "prompt": "hello" }),
    );
    assert!(server.puts().is_empty(), "a prompt alone starts nothing");
    hook(
        serde_json::json!({ "session_id": "bg-1", "hook_event_name": "SessionEnd", "reason": "other" }),
    );
    assert!(
        wait_for_puts(1),
        "no upload arrived after the session ended"
    );
    assert!(server.puts()[0].path.ends_with("/claude-code/bg-1"));
    let log = fs::read_to_string(home.path().join("data/auto.log")).unwrap();
    assert!(
        log.contains("synced 1") && log.contains("uploaded 1"),
        "{log}"
    );
    assert!(stdout(run(home.path(), &["status"])).contains("last started"));

    // Switched off: a session ending does nothing.
    stdout(run(home.path(), &["settings", "--auto-sync", "off"]));
    hook(
        serde_json::json!({ "session_id": "bg-2", "hook_event_name": "SessionEnd", "reason": "other" }),
    );
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert_eq!(server.puts().len(), 1);
}
