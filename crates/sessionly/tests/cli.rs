//! Tests that run the built binary the way Claude Code and a user would.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

fn sessionly(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_sessionly"));
    cmd.env("HOME", home)
        .env("SESSIONLY_HOME", home.join("data"))
        .env_remove("CODEX_HOME")
        .env_remove("OPENCODE_DB")
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME")
        // no background runs unless a test asks for them
        .env("SESSIONLY_NO_AUTO", "1")
        // A release check that is not pointed elsewhere asks GitHub. A file
        // that is not there fails at once, and a failed check is silent. A
        // test that wants an answer sets this itself.
        .env(
            "SESSIONLY_RELEASE_LATEST",
            format!("file://{}", home.join("no-such-release.json").display()),
        )
        .env_remove("SESSIONLY_TOKEN")
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("USERPROFILE");
    // These tests may themselves run inside a cloud session: the binary
    // under test is on a person's own machine unless a test says otherwise.
    for name in [
        "CLAUDE_CODE_REMOTE",
        "CLAUDE_CODE_REMOTE_SESSION_ID",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_USER_EMAIL",
        "CODEX_THREAD_ID",
        "CODEX_ENVIRONMENT_ID",
        "SESSIONLY_URL",
        "SESSIONLY_CONTENT",
        "SESSIONLY_LINE_HASHES",
        "SESSIONLY_OUTCOMES",
    ] {
        cmd.env_remove(name);
    }
    cmd.env("CURSOR_AGENT_SOCKET", home.join("no-such-socket"));
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
        .env_remove("SESSIONLY_HOME")
        .env_remove("CODEX_HOME")
        .env_remove("OPENCODE_DB")
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME");
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
        .env_remove("CODEX_HOME")
        .env_remove("OPENCODE_DB")
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME")
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
        .env("SESSIONLY_HOME", home.path().join("data"))
        .env_remove("CODEX_HOME")
        .env_remove("OPENCODE_DB")
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME");
    let out = run_with_stdin(hook, br#"{"session_id":"s9","hook_event_name":"Stop"}"#);
    assert_silent_success(&out, "installed hook command");
    assert!(home.path().join("data/raw/claude-code/s9.jsonl").exists());
}

/// Every command in a hooks file, wherever it sits.
fn hook_commands(value: &serde_json::Value) -> Vec<&str> {
    match value {
        serde_json::Value::Object(map) => map
            .iter()
            .flat_map(|(key, child)| match (key.as_str(), child.as_str()) {
                ("command", Some(command)) => vec![command],
                _ => hook_commands(child),
            })
            .collect(),
        serde_json::Value::Array(items) => items.iter().flat_map(hook_commands).collect(),
        _ => Vec::new(),
    }
}

#[test]
fn codex_hooks_are_installed_only_when_codex_home_exists() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join(".codex")).unwrap();

    let run = |args: &[&str]| stdout(sessionly(home.path()).args(args).output().unwrap());
    run(&["install"]);
    let hooks_path = home.path().join(".codex/hooks.json");
    let installed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&hooks_path).unwrap()).unwrap();
    // the path is quoted when it has a space or the like in it
    let exe = env!("CARGO_BIN_EXE_sessionly");
    let ours = [format!("{exe} capture"), format!("'{exe}' capture")];
    let commands = hook_commands(&installed);
    assert_eq!(commands.len(), 11);
    assert!(commands.iter().all(|c| ours.iter().any(|o| o == c)));
    assert!(run(&["status"])
        .lines()
        .any(|line| line.starts_with("Codex:")));

    run(&["uninstall"]);
    let uninstalled: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&hooks_path).unwrap()).unwrap();
    assert!(hook_commands(&uninstalled).is_empty());

    let empty_home = tempfile::tempdir().unwrap();
    stdout(
        sessionly(empty_home.path())
            .arg("install")
            .output()
            .unwrap(),
    );
    assert!(!empty_home.path().join(".codex/hooks.json").exists());
}

#[test]
fn a_broken_codex_hooks_file_does_not_break_the_rest() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join(".codex")).unwrap();
    fs::write(home.path().join(".codex/hooks.json"), "{ not json").unwrap();

    for args in [["install"], ["status"], ["uninstall"]] {
        let out = run(home.path(), &args);
        assert!(out.status.success(), "{args:?}: {}", stderr(&out));
    }
    // Claude's hooks went in and out as usual, and the broken file was left alone
    let settings = fs::read_to_string(home.path().join(".claude/settings.json")).unwrap();
    assert!(!settings.contains("sessionly"));
    assert_eq!(
        fs::read_to_string(home.path().join(".codex/hooks.json")).unwrap(),
        "{ not json"
    );
    let installed = run(home.path(), &["install"]);
    assert!(stderr(&installed).contains("Codex hooks not installed"));
    assert!(stdout(run(home.path(), &["status"]))
        .lines()
        .any(|line| line.starts_with("Codex:") && line.contains("unreadable")));
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
/// A DELETE has an answer of its own (`deleting`): at first that the
/// session was there and is removed.
struct StubServer {
    url: String,
    received: Arc<Mutex<Vec<Received>>>,
    status: Arc<AtomicU16>,
    deleting: Arc<Mutex<(u16, &'static str)>>,
    routes: Arc<Mutex<Vec<Route>>>,
}

/// An answer of its own for some requests.
struct Route {
    method: String,
    path: String,
    status: u16,
    body: String,
}

impl StubServer {
    fn start() -> StubServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let received = Arc::new(Mutex::new(Vec::new()));
        let status = Arc::new(AtomicU16::new(200));
        let routes = Arc::new(Mutex::new(Vec::<Route>::new()));
        let deleting = Arc::new(Mutex::new((200, r#"{"removed":true}"#)));
        let (log, code, answer_routes) = (received.clone(), status.clone(), routes.clone());
        let taking_back = deleting.clone();
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
                let own = answer_routes
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|route| route.method == method && path.starts_with(&route.path))
                    .map(|route| (route.status, route.body.clone()));
                let (status, answer) = own.unwrap_or_else(|| {
                    let (status, answer) = match method.as_str() {
                        "DELETE" => *taking_back.lock().unwrap(),
                        _ => (code.load(Ordering::SeqCst), r#"{"error":"stub says no"}"#),
                    };
                    (status, answer.to_string())
                });
                log.lock().unwrap().push(Received {
                    method,
                    path,
                    auth,
                    body: String::from_utf8_lossy(&body).into_owned(),
                });
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
            deleting,
            routes,
        }
    }

    fn deletes(&self) -> Vec<Received> {
        self.requests()
            .into_iter()
            .filter(|r| r.method == "DELETE")
            .collect()
    }

    fn answer_deletes_with(&self, status: u16, body: &'static str) {
        *self.deleting.lock().unwrap() = (status, body);
    }

    /// Answer `method` requests whose path starts with `path` this way from
    /// now on, whatever the other requests are answered.
    fn answer_route(&self, method: &str, path: &str, status: u16, body: &str) {
        let mut routes = self.routes.lock().unwrap();
        routes.retain(|route| !(route.method == method && route.path == path));
        routes.push(Route {
            method: method.to_string(),
            path: path.to_string(),
            status,
            body: body.to_string(),
        });
    }

    /// What `GET /repos/excluded` answers: the stopped repositories, and how
    /// many times one was allowed again.
    fn stopped(&self, repos: &[&str], allowed_again: u64) {
        let body = serde_json::json!({ "repos": repos, "allowed_again": allowed_again });
        self.answer_route("GET", "/api/v1/repos/excluded", 200, &body.to_string());
    }

    /// What `GET /sessions/held` answers: the sessions the server has.
    fn holds(&self, ids: &[&str]) {
        let sessions: Vec<_> = ids
            .iter()
            .map(|id| serde_json::json!({ "source": "claude-code", "session_id": id }))
            .collect();
        let body = serde_json::json!({ "sessions": sessions });
        self.answer_route("GET", "/api/v1/sessions/held", 200, &body.to_string());
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

/// On a person's own machine a shell command's changes are counted as far
/// as they are sure to be the command's, unless that person asks for all of
/// them or for none.
#[test]
fn shell_edits_are_counted_on_this_machine_as_far_as_they_are_sure() {
    use serde_json::json;
    let home = tempfile::tempdir().unwrap();
    let repo = home.path().join("work/app");
    fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", stderr(&out));
    };
    git(&["init", "--quiet", "--initial-branch", "main"]);
    fs::write(repo.join("a.txt"), "one\n").unwrap();

    // One command that appends a line to a.txt, as the hooks see it: one
    // that is over at once, or one that takes a while.
    let command = |session: &str, id: &str, text: &str, line: &str, long: bool| {
        for hook in ["PreToolUse", "PostToolUse"] {
            if hook == "PostToolUse" {
                let mut text = fs::read_to_string(repo.join("a.txt")).unwrap();
                text.push_str(line);
                fs::write(repo.join("a.txt"), text).unwrap();
                if long {
                    std::thread::sleep(std::time::Duration::from_millis(2200));
                }
            }
            let mut cmd = sessionly(home.path());
            cmd.arg("capture");
            let payload = json!({ "session_id": session, "hook_event_name": hook, "cwd": repo,
                "tool_use_id": id, "tool_name": "Bash",
                "tool_input": { "command": text }, "tool_response": {} });
            let out = run_with_stdin(cmd, payload.to_string().as_bytes());
            assert_silent_success(&out, "capture");
        }
    };
    let files = |session: &str| {
        let shown = stdout(run(home.path(), &["show", session, "--json"]));
        let shown: serde_json::Value = serde_json::from_str(&shown).unwrap();
        shown["files"].clone()
    };

    let added = |session: &str| {
        let changed = files(session);
        assert!(changed[0]["path"].as_str().unwrap().ends_with("a.txt"));
        changed[0]["lines_added"].clone()
    };

    // As installed: a command that is over at once changed what changed.
    let said = stdout(run(home.path(), &["settings"]));
    assert!(said.contains("Shell:      sure"), "{said}");
    command("sure-1", "t1", "make", "two\n", false);
    assert_eq!(added("sure-1"), 1);
    // One that took a while changed what its text spells out, and no more.
    command("sure-2", "t2", "make", "three\n", true);
    assert_eq!(files("sure-2"), json!([]));
    command(
        "sure-3",
        "t3",
        "echo 'four, as the command itself says it' >> a.txt; make",
        "four, as the command itself says it\nfive, which only a person typed\n",
        true,
    );
    assert_eq!(added("sure-3"), 1);

    // All of it, by the name the setting had before as well.
    for all in ["all", "on"] {
        let said = stdout(run(home.path(), &["settings", "--shell-edits", all]));
        assert!(said.contains("Shell:      all"), "{said}");
    }
    command("on-1", "t4", "make", "six\nseven\n", true);
    assert_eq!(added("on-1"), 2);

    // None of it: the files are not even looked at.
    let said = stdout(run(home.path(), &["settings", "--shell-edits", "off"]));
    assert!(said.contains("Shell:      off"), "{said}");
    command("off-1", "t5", "echo eight >> a.txt", "eight\n", false);
    assert_eq!(files("off-1"), json!([]));
    assert!(!home.path().join("data/snapshots/off-1").exists());

    // What was kept to compare against goes when the session ends.
    let kept = home.path().join("data/snapshots/on-1");
    assert!(kept.exists());
    let mut cmd = sessionly(home.path());
    cmd.arg("capture");
    let end = json!({ "session_id": "on-1", "hook_event_name": "SessionEnd", "reason": "other" });
    run_with_stdin(cmd, end.to_string().as_bytes());
    assert!(!kept.exists());
}

const CODEX_MAIN: &str = "019a8f00-0000-7000-8000-00000000000a";
const CODEX_SUB: &str = "019a8f00-0000-7000-8000-00000000000b";

/// A Codex thread of the session `CODEX_MAIN`: its rollout with one finished
/// turn, and a hook event that names it. `spawned` makes it a subagent's.
fn codex_thread(home: &Path, id: &str, spawned: bool) {
    use serde_json::json;
    let day = home.join(".codex/sessions/2026/11/16");
    fs::create_dir_all(&day).unwrap();
    let source = match spawned {
        true => json!({ "subagent": { "thread_spawn":
                        { "parent_thread_id": CODEX_MAIN, "depth": 1 } } }),
        false => json!("cli"),
    };
    let at = "2026-11-16T10:00:00.000Z";
    let rows = [
        json!({ "timestamp": at, "type": "session_meta", "payload": {
            "session_id": CODEX_MAIN, "id": id, "cwd": "/work", "source": source } }),
        json!({ "timestamp": at, "type": "event_msg",
                "payload": { "type": "task_started", "turn_id": "t1" } }),
        json!({ "timestamp": at, "type": "event_msg",
                "payload": { "type": "user_message", "message": "look around" } }),
        json!({ "timestamp": at, "type": "event_msg",
                "payload": { "type": "task_complete", "turn_id": "t1" } }),
    ];
    let rollout = day.join(format!("rollout-2026-11-16T10-00-00-{id}.jsonl"));
    let text: String = rows.iter().map(|row| format!("{row}\n")).collect();
    fs::write(&rollout, text).unwrap();
    let mut cmd = sessionly(home);
    cmd.arg("capture");
    let payload = json!({ "session_id": id, "turn_id": "t1", "hook_event_name": "Stop",
                          "transcript_path": rollout });
    assert_silent_success(
        &run_with_stdin(cmd, payload.to_string().as_bytes()),
        "capture",
    );
}

/// A machine whose Codex subagents were each uploaded to `server` as a
/// session of their own: the session that spawned them is not known yet.
fn upload_subagents_alone(home: &Path, server: &StubServer, subagents: &[&str]) {
    for id in subagents {
        codex_thread(home, id, true);
    }
    stdout(run(
        home,
        &["connect", &server.url, "--token", "secret-token"],
    ));
    let alone = stdout(run(home, &["upload"]));
    let sent = format!("Uploaded {} sessions", subagents.len());
    assert!(alone.contains(&sent), "{alone}");
    assert!(server.deletes().is_empty());
}

/// A Codex subagent's thread can be uploaded as a session before the session
/// that spawned it is known. Once it is part of that one, the server is told
/// to drop its own copy, so its work is not there twice.
#[test]
fn a_subagent_uploaded_alone_is_taken_back_once_it_is_part_of_its_session() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    upload_subagents_alone(home.path(), &server, &[CODEX_SUB]);
    assert!(server.puts()[0]
        .path
        .ends_with(&format!("/codex/{CODEX_SUB}")));

    // The session that spawned it turns up: the subagent is part of that.
    codex_thread(home.path(), CODEX_MAIN, false);
    let folded = stdout(run(home.path(), &["upload"]));
    assert!(
        folded.contains("Uploaded 1 sessions") && folded.contains("Took back 1"),
        "{folded}"
    );
    let puts = server.puts();
    assert_eq!(puts.len(), 2);
    assert!(puts[1].path.ends_with(&format!("/codex/{CODEX_MAIN}")));
    let taken = server.deletes();
    assert_eq!(taken.len(), 1);
    assert_eq!(taken[0].path, puts[0].path);
    assert_eq!(taken[0].auth.as_deref(), Some("Bearer secret-token"));

    // Once is enough.
    let again = stdout(run(home.path(), &["upload"]));
    assert!(!again.contains("Took back"), "{again}");
    assert_eq!(server.deletes().len(), 1);
}

/// The server's copy of a subagent is all it has of that work until the
/// session it is part of has arrived there.
#[test]
fn a_subagent_is_not_taken_back_before_the_server_has_its_session() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    upload_subagents_alone(home.path(), &server, &[CODEX_SUB]);

    // The session that spawned it is refused: too large, say. (What is
    // stopped is still answered: only the session is too large.)
    codex_thread(home.path(), CODEX_MAIN, false);
    server.stopped(&[], 0);
    server.answer_with(413);
    let refused = run(home.path(), &["upload"]);
    assert!(!refused.status.success());
    let text = stderr(&refused);
    assert!(
        text.contains(&format!("{CODEX_MAIN} was not uploaded")),
        "{text}"
    );
    assert!(server.deletes().is_empty());

    // Once it is there, the copy goes.
    server.answer_with(200);
    let sent = stdout(run(home.path(), &["upload"]));
    assert!(
        sent.contains("Uploaded 1 sessions") && sent.contains("Took back 1"),
        "{sent}"
    );
    assert_eq!(server.deletes().len(), 1);
}

/// A server that cannot take a session back, or will not for this token, has
/// still stored every upload: that is no failure, and it is asked again later.
#[test]
fn a_take_back_the_server_cannot_do_waits_and_fails_nothing() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    upload_subagents_alone(home.path(), &server, &[CODEX_SUB]);
    codex_thread(home.path(), CODEX_MAIN, false);

    // A token that only uploads, on a server that lets it do nothing else.
    server.answer_deletes_with(403, r#"{"error":"this token only uploads sessions"}"#);
    let out = run(home.path(), &["upload"]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert!(stderr(&out).is_empty(), "{}", stderr(&out));
    let text = stdout(out);
    assert!(
        text.contains("Uploaded 1 sessions") && !text.contains("Took back"),
        "{text}"
    );
    assert_eq!(server.deletes().len(), 1);

    // A server from before sessions could be taken back.
    server.answer_deletes_with(404, r#"{"error":"not found"}"#);
    let text = stdout(run(home.path(), &["upload"]));
    assert!(!text.contains("Took back"), "{text}");
    assert_eq!(server.deletes().len(), 2);

    // A server that fails: said for what it is, not as a failed upload.
    server.answer_deletes_with(503, r#"{"error":"try later"}"#);
    let out = run(home.path(), &["upload"]);
    assert!(!out.status.success());
    let text = stderr(&out);
    assert!(
        text.contains(&format!("{CODEX_SUB} was not taken back")) && text.contains("try later"),
        "{text}"
    );
    assert!(!text.contains("not uploaded"), "{text}");
    assert_eq!(server.deletes().len(), 3);

    // The server has none of this person's: nothing was taken back, and
    // there is nothing more to ask.
    server.answer_deletes_with(200, r#"{"removed":false}"#);
    let text = stdout(run(home.path(), &["upload"]));
    assert!(!text.contains("Took back"), "{text}");
    assert_eq!(server.deletes().len(), 4);
    stdout(run(home.path(), &["upload"]));
    assert_eq!(server.deletes().len(), 4);
}

/// A server that is down is not asked once for every session to take back.
#[test]
fn take_backs_stop_when_the_server_cannot_be_reached() {
    const SUBS: [&str; 5] = [
        "019a8f00-0000-7000-8000-0000000000b1",
        "019a8f00-0000-7000-8000-0000000000b2",
        "019a8f00-0000-7000-8000-0000000000b3",
        "019a8f00-0000-7000-8000-0000000000b4",
        "019a8f00-0000-7000-8000-0000000000b5",
    ];
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    upload_subagents_alone(home.path(), &server, &SUBS);
    codex_thread(home.path(), CODEX_MAIN, false);

    server.answer_deletes_with(503, r#"{"error":"try later"}"#);
    let out = run(home.path(), &["upload"]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("upload stopped early"),
        "{}",
        stderr(&out)
    );
    assert_eq!(server.deletes().len(), 3);

    // All of them, once it is back.
    server.answer_deletes_with(200, r#"{"removed":true}"#);
    let text = stdout(run(home.path(), &["upload"]));
    assert!(text.contains("Took back 5"), "{text}");
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

/// Switched off, outcomes are neither read nor sent, and what was counted
/// stays: on again, they are sent once more, and only where a server may
/// not have them.
#[test]
fn outcomes_switched_off_are_kept_and_neither_read_nor_sent() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    let repo = home.path().join("repo");
    fs::create_dir_all(repo.join(".git")).unwrap();
    capture_editing_session(home.path(), "out-1", &repo);
    stdout(run(home.path(), &["sync"]));
    // A count kept by an earlier reading of the history.
    let db = rusqlite::Connection::open(home.path().join("data/ledger.db")).unwrap();
    let ended: String = db
        .query_row(
            "SELECT ended_at FROM sessions WHERE session_id = 'out-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    db.execute(
        "INSERT INTO outcome_checkpoints (session_id, checkpoint, lines_tracked, fix_commits,
           likely_fix_commits, lines_fixed, rework_commits, lines_reworked, revert_commits,
           lines_reverted, relanded, computed_at, age_seconds, ended_at, late, scope)
         VALUES ('out-1', '1d', 6, 1, 1, 2, 0, 0, 0, 0, 0, ?1, 86400, ?1, 0, 'head_only')",
        [&ended],
    )
    .unwrap();
    let kept = || -> i64 {
        db.query_row("SELECT count(*) FROM outcome_checkpoints", [], |r| r.get(0))
            .unwrap()
    };
    stdout(run(
        home.path(),
        &["connect", &server.url, "--token", "secret-token"],
    ));
    stdout(run(home.path(), &["upload"]));
    let sent = |k: usize| -> serde_json::Value {
        serde_json::from_str(&session_puts(&server)[k].body).unwrap()
    };
    assert_eq!(sent(0)["outcomes"][0]["fix_commits"], 1);

    // Off in the environment of a command that syncs: nothing is forgotten.
    let out = sessionly(home.path())
        .env("SESSIONLY_OUTCOMES", "off")
        .arg("list")
        .output()
        .unwrap();
    stdout(out);
    assert_eq!(kept(), 1);

    // Off in the settings: not exported or sent, and kept. The server
    // keeps what it has, so nothing is sent again for it.
    stdout(run(home.path(), &["settings", "--outcomes", "off"]));
    assert!(json_of(home.path(), &["export", "out-1"])
        .get("outcomes")
        .is_none());
    let again = stdout(run(home.path(), &["upload"]));
    assert!(again.contains("1 already up to date"), "{again}");
    assert_eq!(kept(), 1);
    // What else changes is sent without them,
    stdout(run(home.path(), &["settings", "--content", "previews"]));
    stdout(run(home.path(), &["upload"]));
    assert_eq!(session_puts(&server).len(), 2);
    assert!(sent(1).get("outcomes").is_none());
    // and on again, with them.
    stdout(run(home.path(), &["settings", "--outcomes", "on"]));
    stdout(run(home.path(), &["upload"]));
    assert_eq!(session_puts(&server).len(), 3);
    assert_eq!(sent(2)["outcomes"][0]["fix_commits"], 1);
    let last = stdout(run(home.path(), &["upload"]));
    assert!(last.contains("1 already up to date"), "{last}");
}

/// Sessions sent to the server, ignoring the requests that stop a repository.
fn session_puts(server: &StubServer) -> Vec<Received> {
    server
        .requests()
        .into_iter()
        .filter(|r| r.method == "PUT" && r.path.starts_with("/api/v1/sessions/"))
        .collect()
}

#[test]
fn stopping_a_repository_skips_it_until_it_is_allowed_again() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    let private = home.path().join("private-notes");
    let public = home.path().join("public-notes");
    fs::create_dir_all(&private).unwrap();
    fs::create_dir_all(&public).unwrap();
    // Their own repositories, so an ancestor's remote is not what they are filed under.
    for dir in [&private, &public] {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["init", "--quiet", "--initial-branch", "main"])
            .output()
            .unwrap();
        assert!(out.status.success(), "git init: {}", stderr(&out));
    }
    capture_editing_session(home.path(), "priv-1", &private);
    capture_editing_session(home.path(), "pub-1", &public);

    let early = run(home.path(), &["exclude"]);
    assert!(!early.status.success());
    assert!(
        stderr(&early).contains("sessionly connect"),
        "{}",
        stderr(&early)
    );

    stdout(run(home.path(), &["connect", &server.url, "--token", "t"]));
    let sent = stdout(run(home.path(), &["upload"]));
    assert!(sent.contains("Uploaded 2 sessions"), "{sent}");
    assert_eq!(session_puts(&server).len(), 2);

    // The list is the server's, and is kept nowhere on this machine.
    server.stopped(&["github.com/acme/web"], 0);
    let listed = stdout(run(home.path(), &["exclude"]));
    assert!(listed.contains("github.com/acme/web"), "{listed}");
    let config = fs::read_to_string(home.path().join("data/config.json")).unwrap();
    assert!(!config.contains("github.com/acme/web"), "{config}");
    server.stopped(&[], 0);
    assert!(stdout(run(home.path(), &["exclude"])).contains("Nothing is stopped."));

    let exported = json_of(home.path(), &["export", "priv-1"]);
    let session = &exported["session"];
    let name = session["repo"]["remote"]
        .as_str()
        .filter(|value| !value.is_empty())
        .or_else(|| {
            session["repo"]["root"]
                .as_str()
                .filter(|value| !value.is_empty())
        })
        .or_else(|| session["cwd"].as_str())
        .unwrap()
        .to_string();
    let asked_to_stop = || {
        let put = server
            .requests()
            .into_iter()
            .rfind(|r| r.method == "PUT" && r.path == "/api/v1/repos/excluded")
            .unwrap();
        serde_json::from_str::<serde_json::Value>(&put.body).unwrap()["repo"].clone()
    };
    server.answer_route(
        "PUT",
        "/api/v1/repos/excluded",
        200,
        &format!(r#"{{"repo":{name:?},"sessions_removed":1,"covers_folders":true}}"#),
    );
    // A directory named from where the command runs is the same repository.
    let here = sessionly(home.path())
        .current_dir(&private)
        .args(["exclude", "."])
        .output()
        .unwrap();
    assert!(here.status.success(), "{}", stderr(&here));
    assert_eq!(asked_to_stop(), name);
    let beside = sessionly(home.path())
        .current_dir(&public)
        .args(["exclude", "../public-notes/../private-notes"])
        .output()
        .unwrap();
    assert!(beside.status.success(), "{}", stderr(&beside));
    assert_eq!(asked_to_stop(), name);

    let stopped = stdout(run(home.path(), &["exclude", &private.to_string_lossy()]));
    assert!(
        stopped.contains(&format!("Stopped submitting {name}.")),
        "{stopped}"
    );
    assert!(stopped.contains("1 session already submitted"), "{stopped}");
    assert!(
        stopped.contains("Directories inside it are stopped too."),
        "{stopped}"
    );
    assert!(
        stopped.contains(&format!("sessionly include {name}")),
        "{stopped}"
    );
    assert_eq!(asked_to_stop(), name);

    // While it is stopped it is counted and not sent, by a dry run and a real one.
    server.stopped(&[&name], 0);
    let puts_before = session_puts(&server).len();
    for args in [&["upload", "--dry-run"][..], &["upload"]] {
        let skipped = stdout(run(home.path(), args));
        assert!(
            skipped.contains("upload 0 sessions") || skipped.contains("Uploaded 0 sessions"),
            "{skipped}"
        );
        assert!(
            skipped.contains("1 from repositories you stopped submitting"),
            "{skipped}"
        );
    }
    assert_eq!(session_puts(&server).len(), puts_before);

    // Allowed again. The server deleted the session when it was stopped,
    // and says so when this machine asks what it still has.
    server.answer_route(
        "DELETE",
        "/api/v1/repos/excluded",
        200,
        &format!(r#"{{"repo":{name:?},"removed":true}}"#),
    );
    let allowed = stdout(run(home.path(), &["include", &name]));
    assert!(allowed.contains("will be submitted again"), "{allowed}");
    server.stopped(&[], 1);
    server.holds(&["pub-1"]);
    let asked_what_is_held = || {
        server
            .requests()
            .into_iter()
            .filter(|r| r.method == "GET" && r.path.starts_with("/api/v1/sessions/held"))
            .collect::<Vec<_>>()
    };
    // A dry run counts it, and leaves it to be sent.
    let dry = stdout(run(home.path(), &["upload", "--dry-run"]));
    assert!(
        dry.contains("Would upload 1 sessions") && dry.contains("1 already up to date"),
        "{dry}"
    );
    assert_eq!(session_puts(&server).len(), puts_before);
    let resent = stdout(run(home.path(), &["upload"]));
    assert!(
        resent.contains("Uploaded 1 sessions") && resent.contains("1 already up to date"),
        "{resent}"
    );
    assert_eq!(session_puts(&server).len(), puts_before + 1);
    assert!(session_puts(&server)
        .last()
        .unwrap()
        .path
        .ends_with("/priv-1"));
    let machine_id = exported["session"]["machine_id"].as_str().unwrap();
    assert_eq!(
        asked_what_is_held().last().unwrap().path,
        format!("/api/v1/sessions/held?machine={machine_id}")
    );

    // Nothing was allowed since: the server is not asked what it has again.
    let asked = asked_what_is_held().len();
    server.holds(&[]);
    let level = stdout(run(home.path(), &["upload"]));
    assert!(
        level.contains("Uploaded 0 sessions") && level.contains("2 already up to date"),
        "{level}"
    );
    assert_eq!(asked_what_is_held().len(), asked);

    // Stopped and allowed again while this machine ran no upload at all,
    // from the dashboard or another machine: it is sent again all the same.
    server.stopped(&[], 2);
    server.holds(&["pub-1"]);
    let again = stdout(run(home.path(), &["upload"]));
    assert!(again.contains("Uploaded 1 sessions"), "{again}");
    assert_eq!(session_puts(&server).len(), puts_before + 2);
    assert!(session_puts(&server)
        .last()
        .unwrap()
        .path
        .ends_with("/priv-1"));

    server.answer_route(
        "DELETE",
        "/api/v1/repos/excluded",
        404,
        r#"{"error":"no such repository"}"#,
    );
    let missing = run(home.path(), &["include", &name]);
    assert!(!missing.status.success());
    assert!(
        stderr(&missing).contains("is not stopped"),
        "{}",
        stderr(&missing)
    );

    // A server from before a repository could be stopped.
    for method in ["GET", "PUT", "DELETE"] {
        server.answer_route(
            method,
            "/api/v1/repos/excluded",
            404,
            r#"{"error":"not found"}"#,
        );
    }
    for args in [
        &["exclude"][..],
        &["exclude", "github.com/acme/missing"],
        &["include", "github.com/acme/missing"],
    ] {
        let old = run(home.path(), args);
        assert!(!old.status.success());
        assert!(stderr(&old).contains("newer version"), "{}", stderr(&old));
    }
    // Nothing is stopped there, and uploading goes on as before.
    let plain = stdout(run(home.path(), &["upload"]));
    assert!(
        plain.contains("Uploaded 0 sessions") && plain.contains("2 already up to date"),
        "{plain}"
    );
}

#[test]
fn a_token_that_only_uploads_sends_without_asking_what_is_stopped() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    let repo = home.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    capture_editing_session(home.path(), "env-1", &repo);
    stdout(run(home.path(), &["connect", &server.url, "--token", "t"]));
    // What a server answers a cloud environment's token on any other route.
    for path in ["/api/v1/repos/excluded", "/api/v1/sessions/held"] {
        server.answer_route(
            "GET",
            path,
            403,
            r#"{"error":"this token only uploads sessions"}"#,
        );
    }
    let dry = run(home.path(), &["upload", "--dry-run"]);
    assert!(!stderr(&dry).contains("warning"), "{}", stderr(&dry));
    assert!(stdout(dry).contains("Would upload 1 sessions"));

    // The server refuses a session whose person stopped its repository,
    // and says so. It is not marked as sent.
    server.answer_route(
        "PUT",
        "/api/v1/sessions/",
        200,
        r#"{"stored":false,"excluded":true}"#,
    );
    let refused = stdout(run(home.path(), &["upload"]));
    assert!(
        refused.contains("Uploaded 0 sessions")
            && refused.contains("from repositories you stopped submitting"),
        "{refused}"
    );
    server.answer_route("PUT", "/api/v1/sessions/", 200, r#"{"stored":true}"#);
    let sent = stdout(run(home.path(), &["upload"]));
    assert!(sent.contains("Uploaded 1 sessions"), "{sent}");
    assert_eq!(session_puts(&server).len(), 2);
}

#[test]
fn a_server_that_cannot_say_what_is_stopped_is_sent_nothing() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    let repo = home.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    capture_editing_session(home.path(), "ask-1", &repo);
    stdout(run(home.path(), &["connect", &server.url, "--token", "t"]));
    server.answer_route(
        "GET",
        "/api/v1/repos/excluded",
        503,
        r#"{"error":"try later"}"#,
    );
    let out = run(home.path(), &["upload"]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("upload stopped early"),
        "{}",
        stderr(&out)
    );
    assert!(session_puts(&server).is_empty());

    // Counting needs no server: a dry run counts, and says what it did not know.
    let dry = run(home.path(), &["upload", "--dry-run"]);
    assert!(dry.status.success(), "{}", stderr(&dry));
    assert!(
        stderr(&dry).contains("was not asked which repositories are stopped"),
        "{}",
        stderr(&dry)
    );
    assert!(stdout(dry).contains("Would upload 1 sessions"));

    // The list arrives, and what the server still has does not: nothing is
    // marked as compared, and the next run asks again.
    server.stopped(&[], 1);
    server.answer_route(
        "GET",
        "/api/v1/sessions/held",
        503,
        r#"{"error":"try later"}"#,
    );
    assert!(!run(home.path(), &["upload"]).status.success());
    assert!(session_puts(&server).is_empty());
    server.holds(&[]);
    let sent = stdout(run(home.path(), &["upload"]));
    assert!(sent.contains("Uploaded 1 sessions"), "{sent}");
}

#[test]
fn a_removed_person_refuses_one_session_and_the_run_goes_on() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    let repo = home.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    // Oldest first, so the refusal is met before the session that should go.
    capture_editing_session(home.path(), "removed-1", &repo);
    capture_editing_session(home.path(), "kept-1", &repo);
    stdout(run(home.path(), &["connect", &server.url, "--token", "t"]));
    let config: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(home.path().join("data/config.json")).unwrap())
            .unwrap();
    let machine = config["machine_id"].as_str().unwrap();
    server.answer_route(
        "PUT",
        &format!("/api/v1/sessions/{machine}/claude-code/removed-1"),
        403,
        r#"{"error":"this person has been removed","stored":false,"code":"person_removed"}"#,
    );
    let out = run(home.path(), &["upload"]);
    assert!(!out.status.success());
    let err = stderr(&out);
    assert!(
        err.contains("removed-1 was not uploaded")
            && err.contains("this person has been removed")
            && !err.contains("did not accept the token")
            && !err.contains("stopped early"),
        "{err}"
    );
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(text.contains("Uploaded 1 sessions"), "{text}");
    assert_eq!(session_puts(&server).len(), 2);
}

#[test]
fn upload_failures_are_reported_and_retried_later() {
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    let repo = home.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    capture_editing_session(home.path(), "fail-1", &repo);
    stdout(run(home.path(), &["connect", &server.url, "--token", "t"]));
    // What is stopped is answered throughout: it is the uploads that fail.
    server.stopped(&[], 0);

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
    // The run writes its log line after the upload has been answered.
    let log_path = home.path().join("data/auto.log");
    let mut log = String::new();
    for _ in 0..100 {
        log = fs::read_to_string(&log_path).unwrap_or_default();
        if log.contains("uploaded") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
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

/// A Claude Code cloud session, as its hooks and environment were on
/// 2026-11-14: the sandbox is started ahead of time under another session
/// id, git is set up as the agent, and nobody runs `sessionly connect`.
#[test]
fn a_cloud_session_is_uploaded_at_each_turns_end_for_whoever_started_it() {
    use serde_json::json;
    let home = tempfile::tempdir().unwrap();
    let server = StubServer::start();
    let repo = home.path().join("user/probe");
    fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", stderr(&out));
    };
    git(&["init", "--quiet", "--initial-branch", "main"]);
    git(&["config", "user.name", "Claude"]);
    git(&["config", "user.email", "noreply@anthropic.com"]);
    git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/acme/probe.git",
    ]);

    let hook = |payload: serde_json::Value, person: bool| {
        let mut cmd = sessionly(home.path());
        cmd.arg("capture")
            .env_remove("SESSIONLY_NO_AUTO")
            .env("SESSIONLY_AUTO_DELAY_MS", "0")
            .env("CLAUDE_CODE_REMOTE", "true")
            .env("SESSIONLY_URL", &server.url)
            .env("SESSIONLY_TOKEN", "environment-token")
            .env("SESSIONLY_LINE_HASHES", "on");
        if person {
            cmd.env("CLAUDE_CODE_REMOTE_SESSION_ID", "cse_01probe")
                .env("CLAUDE_CODE_ENTRYPOINT", "remote_mobile")
                .env("CLAUDE_CODE_USER_EMAIL", "ann@example.com");
        }
        let out = run_with_stdin(cmd, payload.to_string().as_bytes());
        assert_silent_success(&out, "capture in a sandbox");
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
    let wait_for_log = |text: &str| {
        for _ in 0..150 {
            let log = fs::read_to_string(home.path().join("data/auto.log")).unwrap_or_default();
            if log.contains(text) {
                return log;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        panic!("the background run never logged {text:?}");
    };
    let event =
        |id: &str, hook: &str| json!({ "session_id": id, "hook_event_name": hook, "cwd": repo });

    // The sandbox being started: a session nobody is in. Nothing to upload.
    let mut early = event("warm-up", "SessionStart");
    early["source"] = json!("startup");
    hook(early, false);
    let mut gone = event("warm-up", "SessionEnd");
    gone["reason"] = json!("other");
    hook(gone, false);
    wait_for_log("synced 0");
    assert!(server.puts().is_empty(), "an empty session was uploaded");

    // The session that moves in. The agent makes its branch while it works.
    let mut start = event("cl-1", "SessionStart");
    start["source"] = json!("startup");
    hook(start, true);
    let mut prompt = event("cl-1", "UserPromptSubmit");
    prompt["prompt_id"] = json!("p1");
    prompt["prompt"] = json!("add a greeting");
    hook(prompt, true);
    git(&["checkout", "--quiet", "-b", "ccr-4d29d410-k9pftj"]);
    let mut write = event("cl-1", "PostToolUse");
    write["tool_use_id"] = json!("t1");
    write["tool_name"] = json!("Write");
    write["tool_input"] = json!({ "file_path": repo.join("hello.py"),
                                  "content": "def greet(name):\n    return name\n" });
    write["tool_response"] = json!({ "type": "create", "structuredPatch": [] });
    fs::write(repo.join("hello.py"), "def greet(name):\n    return name\n").unwrap();
    hook(write, true);
    let mut stop = event("cl-1", "Stop");
    stop["prompt_id"] = json!("p1");
    hook(stop.clone(), true);
    assert!(wait_for_puts(1), "nothing was uploaded when the turn ended");

    let first = &server.puts()[0];
    assert_eq!(first.path, "/api/v1/sessions/cloud/claude-code/cl-1");
    assert_eq!(first.auth.as_deref(), Some("Bearer environment-token"));
    let sent: serde_json::Value = serde_json::from_str(&first.body).unwrap();
    let s = &sent["session"];
    assert_eq!(s["machine_id"], "cloud");
    assert_eq!(
        s["runtime"],
        json!({ "kind": "cloud", "id": "cse_01probe" })
    );
    // The person the platform named, not the agent git is set up as.
    assert_eq!(
        s["user"],
        json!({ "name": null, "email": "ann@example.com" })
    );
    assert_eq!(s["entrypoint"], "remote_mobile");
    assert_eq!(s["repo"]["remote"], "github.com/acme/probe");
    assert_eq!(s["repo"]["branch"], "ccr-4d29d410-k9pftj");
    assert_eq!(s["files"][0]["path"], "hello.py");
    assert_eq!(sent["lines"][0]["hashes"].as_array().unwrap().len(), 2);

    // A second turn straight after is uploaded too: the sandbox may not be
    // there in five minutes. This time the agent edits with the shell, which
    // tells hooks nothing of what it changed.
    let mut again = event("cl-1", "UserPromptSubmit");
    again["prompt_id"] = json!("p2");
    again["prompt"] = json!("and a docstring");
    hook(again, true);
    let shell = |hook_name: &str| {
        let mut call = event("cl-1", hook_name);
        call["prompt_id"] = json!("p2");
        call["tool_use_id"] = json!("t2");
        call["tool_name"] = json!("Bash");
        call["tool_input"] = json!({ "command": "sed -i ... hello.py && date > notes.txt" });
        call
    };
    hook(shell("PreToolUse"), true);
    fs::write(
        repo.join("hello.py"),
        "def greet(name):\n    \"\"\"Greet.\"\"\"\n    return name\n",
    )
    .unwrap();
    fs::write(repo.join("notes.txt"), "Sat Nov 14\n").unwrap();
    hook(shell("PostToolUse"), true);
    stop["prompt_id"] = json!("p2");
    hook(stop, true);
    assert!(wait_for_puts(2), "the second turn was not uploaded");
    let sent: serde_json::Value = serde_json::from_str(&server.puts()[1].body).unwrap();
    let s = &sent["session"];
    assert_eq!(s["counts"]["prompts"], 2);
    let files: Vec<_> = s["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["path"].as_str().unwrap(),
                f["created"] == true,
                &f["writes"],
                &f["lines_added"],
            )
        })
        .collect();
    assert_eq!(
        files,
        [
            ("hello.py", true, &json!(2), &json!(3)),
            ("notes.txt", true, &json!(1), &json!(1)),
        ]
    );
    assert_eq!(s["tool_calls"][1]["lines_added"], 2);
    let hashes = |file: usize| sent["lines"][file]["hashes"].as_array().unwrap().len();
    assert_eq!((hashes(0), hashes(1)), (3, 1));
    // Looking at the working tree left the repository as it was: nothing staged.
    let status = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["status", "--porcelain"])
        .output()
        .unwrap();
    assert_eq!(stdout(status), "?? hello.py\n?? notes.txt\n");

    // The token came from the environment and stays there.
    let config = fs::read_to_string(home.path().join("data/config.json")).unwrap();
    assert!(!config.contains("environment-token"), "{config}");
    assert!(config.contains(r#""machine_id": "cloud""#), "{config}");
    let shown = stdout(run(home.path(), &["show", "cl-1"]));
    assert!(
        shown.contains("the cloud (cse_01probe), started from remote_mobile"),
        "{shown}"
    );
    assert!(shown.contains("2 changed (+4 -0)"), "{shown}");

    // On a person's own machine the working tree is not looked at once that
    // person has said so: what changes while a command runs may be their
    // own typing. The sandbox's setting is not theirs to change.
    run(home.path(), &["settings", "--shell-edits", "off"]);
    let mut local = shell("PreToolUse");
    local["session_id"] = json!("local-1");
    capture(home.path(), local.clone());
    fs::write(repo.join("notes.txt"), "typed by a person\n").unwrap();
    local["hook_event_name"] = json!("PostToolUse");
    capture(home.path(), local);
    let raw = fs::read_to_string(home.path().join("data/raw/claude-code/local-1.jsonl")).unwrap();
    assert!(!raw.contains("changes"), "{raw}");
    assert!(home.path().join("data/snapshots/cl-1").is_dir());
    assert!(!home.path().join("data/snapshots/local-1").exists());
}

/// A repository set up with `install --repo`, and a release for its script to
/// fetch: this build, packed the way the release workflow packs it.
#[cfg(target_os = "linux")]
struct CloudRepo {
    dir: tempfile::TempDir,
}

#[cfg(target_os = "linux")]
impl CloudRepo {
    /// `honest` is whether the checksum written into the script is the
    /// archive's own.
    fn new(honest: bool) -> CloudRepo {
        let dir = tempfile::tempdir().unwrap();
        let version = env!("CARGO_PKG_VERSION");
        let archive = format!(
            "sessionly-{}-unknown-linux-musl.tar.gz",
            std::env::consts::ARCH
        );
        let release = dir.path().join(format!("release/v{version}"));
        fs::create_dir_all(&release).unwrap();
        fs::copy(env!("CARGO_BIN_EXE_sessionly"), release.join("sessionly")).unwrap();
        let packed = Command::new("tar")
            .args(["-czf", &archive, "sessionly"])
            .current_dir(&release)
            .status()
            .unwrap();
        assert!(packed.success());
        let sum = stdout(
            Command::new("sha256sum")
                .arg(release.join(&archive))
                .output()
                .unwrap(),
        );
        let sum = sum.split_whitespace().next().unwrap().to_string();
        let written = if honest { sum } else { "0".repeat(64) };
        let sums = dir.path().join("SHA256SUMS");
        fs::write(&sums, format!("{written}  {archive}\n")).unwrap();

        let repo = dir.path().join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let installed = stdout(
            sessionly(&dir.path().join("installer-home"))
                .args(["install", "--repo"])
                .arg(&repo)
                .arg("--checksums")
                .arg(&sums)
                .env(
                    "SESSIONLY_RELEASE_BASE",
                    format!("file://{}/release", dir.path().display()),
                )
                .output()
                .unwrap(),
        );
        assert!(
            installed.contains(".sessionly/hook.sh") && installed.contains("Commit"),
            "{installed}"
        );
        CloudRepo { dir }
    }

    fn home(&self, name: &str) -> std::path::PathBuf {
        self.dir.path().join(name)
    }

    /// Run the committed script as an agent would, with only `env` set.
    fn hook(
        &self,
        home: &str,
        via: &str,
        env: &[(&str, &str)],
        payload: &serde_json::Value,
    ) -> Output {
        let home = self.home(home);
        fs::create_dir_all(&home).unwrap();
        let mut cmd = Command::new("sh");
        cmd.arg(".sessionly/hook.sh")
            .arg(via)
            .current_dir(self.dir.path().join("repo"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("HOME", &home)
            .env("SESSIONLY_NO_AUTO", "1")
            .env("CURSOR_AGENT_SOCKET", home.join("no-such-socket"))
            .envs(env.iter().copied());
        run_with_stdin(cmd, payload.to_string().as_bytes())
    }

    fn captured(&self, home: &str, agent: &str, id: &str) -> Vec<serde_json::Value> {
        let path = self
            .home(home)
            .join(format!(".sessionly/raw/{agent}/{id}.jsonl"));
        fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

#[cfg(target_os = "linux")]
#[test]
fn the_repository_script_captures_in_a_sandbox_and_nowhere_else() {
    use serde_json::json;
    let repo = CloudRepo::new(true);
    let stop = json!({ "session_id": "s1", "hook_event_name": "Stop" });

    // A person's own machine: nothing happens, not even a folder.
    let out = repo.hook("laptop", "claude", &[], &stop);
    assert_silent_success(&out, "on a laptop");
    assert!(!repo.home("laptop").join(".sessionly").exists());

    // A Claude Code cloud session: the binary is fetched, checked and used.
    let cloud = [
        ("CLAUDE_CODE_REMOTE", "true"),
        ("CLAUDE_CODE_USER_EMAIL", "ann@example.com"),
    ];
    let out = repo.hook("sandbox", "claude", &cloud, &stop);
    assert_silent_success(&out, "first hook in a sandbox");
    let events = repo.captured("sandbox", "claude-code", "s1");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["runtime"]["kind"], "cloud");
    assert_eq!(events[0]["runtime"]["user_email"], "ann@example.com");
    let log = fs::read_to_string(repo.home("sandbox").join(".sessionly/bootstrap.log")).unwrap();
    assert!(log.contains("installed sessionly"), "{log}");
    // The second event finds it there.
    assert_silent_success(
        &repo.hook("sandbox", "claude", &cloud, &stop),
        "second hook",
    );
    assert_eq!(repo.captured("sandbox", "claude-code", "s1").len(), 2);
    let after = fs::read_to_string(repo.home("sandbox").join(".sessionly/bootstrap.log")).unwrap();
    assert_eq!(after, log, "the second hook had nothing to note");
    assert_eq!(log.matches("installed sessionly").count(), 1, "{log}");

    // Cursor's cloud runs both hook files: only its own entry captures.
    let socket = repo.home("cursor-vm").join("api.sock");
    fs::create_dir_all(socket.parent().unwrap()).unwrap();
    let _listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let socket = socket.to_string_lossy().into_owned();
    let vm = [
        ("CURSOR_AGENT_SOCKET", socket.as_str()),
        ("CURSOR_VERSION", "1.0.0"),
    ];
    let tool = json!({ "conversation_id": "bc-1", "session_id": "bc-1", "cursor_version": "1.0.0",
                       "hook_event_name": "preToolUse", "tool_name": "Read", "tool_use_id": "t1" });
    assert_silent_success(
        &repo.hook("cursor-vm", "claude", &vm, &tool),
        "the other file's entry",
    );
    assert!(repo.captured("cursor-vm", "cursor", "bc-1").is_empty());
    assert_silent_success(
        &repo.hook("cursor-vm", "cursor", &vm, &tool),
        "Cursor's own entry",
    );
    let events = repo.captured("cursor-vm", "cursor", "bc-1");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["runtime"], json!({ "kind": "cloud" }));
}

#[cfg(target_os = "linux")]
#[test]
fn hooks_arriving_together_share_one_download() {
    let repo = CloudRepo::new(true);
    let cloud = [("CLAUDE_CODE_REMOTE", "true")];
    std::thread::scope(|scope| {
        for n in 0..6 {
            let (repo, cloud) = (&repo, &cloud);
            scope.spawn(move || {
                let event = serde_json::json!({ "session_id": "s1", "hook_event_name": "PreToolUse", "n": n });
                assert_silent_success(&repo.hook("sandbox", "claude", cloud, &event), "a parallel hook");
            });
        }
    });
    assert_eq!(repo.captured("sandbox", "claude-code", "s1").len(), 6);
    let log = fs::read_to_string(repo.home("sandbox").join(".sessionly/bootstrap.log")).unwrap();
    let left: Vec<_> = fs::read_dir(repo.home("sandbox").join(".sessionly/bin"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    // Nothing is left behind: no lock, no half a download.
    assert_eq!(
        left,
        [format!("sessionly-{}", env!("CARGO_PKG_VERSION"))],
        "{log}"
    );
    // One download for all six. On CI about one run in ten had two hooks
    // each download. The script's own notes then showed why: on Ubuntu
    // 26.04 several hooks that ran mkdir at the same moment were each told
    // they had made the lock. The lock is no longer made with mkdir, but
    // the image that showed it is not one this can be tried on at will, so
    // a second download is still allowed here until CI has gone without
    // one for a while. It is whole and checked like the first, and costs
    // time only. Every hook downloading for itself still fails.
    let downloads = log.matches("installed sessionly").count();
    assert!(
        (1..=2).contains(&downloads),
        "{downloads} downloads:\n{log}"
    );
    // The script notes who took and released the lock, and when. The log of
    // a run with two downloads is kept where CI prints it.
    if downloads == 2 {
        let kept = Path::new(env!("CARGO_TARGET_TMPDIR"))
            .join(format!("two-downloads-{}.log", std::process::id()));
        fs::write(kept, &log).unwrap();
    }
}

#[cfg(target_os = "linux")]
#[test]
fn a_download_that_fails_its_checksum_is_not_run() {
    let repo = CloudRepo::new(false);
    let cloud = [("CLAUDE_CODE_REMOTE", "true")];
    let stop = serde_json::json!({ "session_id": "s1", "hook_event_name": "Stop" });
    for attempt in ["first", "second"] {
        assert_silent_success(&repo.hook("sandbox", "claude", &cloud, &stop), attempt);
    }
    assert!(repo.captured("sandbox", "claude-code", "s1").is_empty());
    let bin = repo.home("sandbox").join(".sessionly/bin");
    let kept: Vec<_> = fs::read_dir(&bin)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(kept, [format!("failed-{}", env!("CARGO_PKG_VERSION"))]);
    // It said why once, and did not try again straight away.
    let log = fs::read_to_string(repo.home("sandbox").join(".sessionly/bootstrap.log")).unwrap();
    assert_eq!(
        log.matches("does not match its checksum").count(),
        1,
        "{log}"
    );
}

#[test]
fn install_in_a_repository_round_trip() {
    let home = tempfile::tempdir().unwrap();
    let repo = home.path().join("repo");
    fs::create_dir_all(repo.join(".git")).unwrap();
    let sums = home.path().join("SHA256SUMS");
    fs::write(
        &sums,
        format!(
            "{}  sessionly-x86_64-unknown-linux-musl.tar.gz\n",
            "ab".repeat(32)
        ),
    )
    .unwrap();
    let repo_arg = repo.to_str().unwrap();

    // The option that only makes sense with --repo says so.
    let out = run(
        home.path(),
        &["install", "--checksums", sums.to_str().unwrap()],
    );
    assert!(!out.status.success());
    assert!(stderr(&out).contains("--repo"), "{}", stderr(&out));

    let text = stdout(run(
        home.path(),
        &[
            "install",
            "--repo",
            repo_arg,
            "--checksums",
            sums.to_str().unwrap(),
        ],
    ));
    assert!(text.contains("wrote      .sessionly/hook.sh"), "{text}");
    assert!(text.contains("SESSIONLY_URL"), "{text}");
    // Nothing of this machine's is touched or written into the repository.
    assert!(!home.path().join(".claude").exists());
    let settings = fs::read_to_string(repo.join(".claude/settings.json")).unwrap();
    assert!(
        !settings.contains(home.path().to_str().unwrap()),
        "{settings}"
    );

    let status = stdout(run(home.path(), &["status", "--repo", repo_arg]));
    assert!(
        status.contains(&format!("fetching sessionly {}", env!("CARGO_PKG_VERSION")))
            && status.contains("7/7 events in .cursor/hooks.json"),
        "{status}"
    );
    let again = stdout(run(
        home.path(),
        &[
            "install",
            "--repo",
            repo_arg,
            "--checksums",
            sums.to_str().unwrap(),
        ],
    ));
    assert!(!again.contains("wrote "), "{again}");

    let removed = stdout(run(home.path(), &["uninstall", "--repo", repo_arg]));
    assert_eq!(removed.lines().count(), 4, "{removed}");
    assert!(!repo.join(".sessionly").exists() && !repo.join(".claude").exists());
    assert!(!repo.join("AGENTS.md").exists());
    let status = stdout(run(home.path(), &["status", "--repo", repo_arg]));
    assert!(status.contains("not installed"), "{status}");
    assert!(status.contains("not asked in AGENTS.md"), "{status}");
}

/// A Codex cloud task, as its sandbox was on 2026-11-17: no hooks run and
/// there is no session file, git is set up as the person, and the agent
/// runs what `AGENTS.md` asks it to.
#[cfg(target_os = "linux")]
#[test]
fn a_codex_cloud_task_records_what_each_turn_changed() {
    use serde_json::json;
    let cloud = CloudRepo::new(true);
    let server = StubServer::start();
    let repo = cloud.dir.path().join("repo");
    let asked = fs::read_to_string(repo.join("AGENTS.md")).unwrap();
    assert!(
        asked.contains("sh .sessionly/hook.sh codex start"),
        "{asked}"
    );
    assert!(asked.contains("sh .sessionly/hook.sh codex end"), "{asked}");

    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", stderr(&out));
    };
    git(&["init", "--quiet", "--initial-branch", "work"]);
    git(&["config", "user.name", "Ann"]);
    git(&["config", "user.email", "ann@example.com"]);
    git(&[
        "remote",
        "add",
        "origin",
        "https://github.com/acme/probe.git",
    ]);
    fs::write(repo.join("hello.py"), "def greet():\n    pass\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "--quiet", "--no-gpg-sign", "-m", "start"]);

    // As the agent runs it: no payload, and only what the sandbox sets.
    let turn = |home: &str, which: &str, there: bool| {
        let home = cloud.home(home);
        fs::create_dir_all(&home).unwrap();
        let mut cmd = Command::new("sh");
        cmd.args([".sessionly/hook.sh", "codex", which])
            .current_dir(&repo)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("HOME", &home)
            .env("CURSOR_AGENT_SOCKET", home.join("no-such-socket"))
            .env("CODEX_THREAD_ID", "019a-thread")
            .env("SESSIONLY_URL", &server.url)
            .env("SESSIONLY_TOKEN", "environment-token")
            .env("SESSIONLY_LINE_HASHES", "on");
        if there {
            cmd.env("CODEX_ENVIRONMENT_ID", "ccarenv_1");
        }
        assert_silent_success(&run_with_stdin(cmd, b""), which);
    };

    // Codex on a person's own machine names the thread too: nothing happens.
    turn("laptop", "start", false);
    turn("laptop", "end", false);
    assert!(!cloud.home("laptop").join(".sessionly").exists());

    turn("sandbox", "start", true);
    fs::write(
        repo.join("hello.py"),
        "def greet():\n    return 'hi'\n\n# done\n",
    )
    .unwrap();
    fs::write(repo.join("notes.txt"), "Tue Nov 17\n").unwrap();
    // The upload is over when the command returns.
    turn("sandbox", "end", true);
    let puts = session_puts(&server);
    assert_eq!(puts.len(), 1, "the turn was not uploaded when it ended");
    assert_eq!(puts[0].path, "/api/v1/sessions/cloud/codex/019a-thread");
    let sent: serde_json::Value = serde_json::from_str(&puts[0].body).unwrap();
    let s = &sent["session"];
    assert_eq!(s["source"], "codex");
    assert_eq!(
        s["runtime"],
        json!({ "kind": "cloud", "id": "019a-thread" })
    );
    // Git there is the person's own.
    assert_eq!(
        s["user"],
        json!({ "name": null, "email": "ann@example.com" })
    );
    assert_eq!(s["repo"]["remote"], "github.com/acme/probe");
    assert_eq!(s["repo"]["branch"], "work");
    assert_eq!(s["counts"]["prompts"], 1);
    let files = |s: &serde_json::Value| -> Vec<(String, u64, u64)> {
        s["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f["path"].as_str().unwrap().to_string(),
                    f["lines_added"].as_u64().unwrap(),
                    f["lines_removed"].as_u64().unwrap(),
                )
            })
            .collect()
    };
    assert_eq!(
        files(s),
        [
            ("hello.py".to_string(), 3, 1),
            ("notes.txt".to_string(), 1, 0)
        ]
    );
    let hashes: usize = sent["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["hashes"].as_array().unwrap().len())
        .sum();
    assert!(hashes >= 3, "{}", sent["lines"]);

    // A turn the agent forgot to end is ended by the next one's start, and
    // one it forgot to start is still a turn, with nothing known to be its.
    turn("sandbox", "start", true);
    fs::write(repo.join("notes.txt"), "Tue Nov 17\nmore\n").unwrap();
    turn("sandbox", "start", true);
    fs::write(repo.join("notes.txt"), "Tue Nov 17\nmore\nand more\n").unwrap();
    turn("sandbox", "end", true);
    fs::write(repo.join("unseen.txt"), "nobody looked\n").unwrap();
    turn("sandbox", "end", true);
    let puts = session_puts(&server);
    let sent: serde_json::Value = serde_json::from_str(&puts.last().unwrap().body).unwrap();
    let s = &sent["session"];
    assert_eq!(s["counts"]["prompts"], 4);
    assert_eq!(
        files(s),
        [
            ("hello.py".to_string(), 3, 1),
            ("notes.txt".to_string(), 3, 0)
        ]
    );
    // Looking at the working tree staged nothing.
    let status = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["status", "--porcelain"])
        .output()
        .unwrap();
    assert_eq!(stdout(status), " M hello.py\n?? notes.txt\n?? unseen.txt\n");
}

/// A folder of releases as `SESSIONLY_RELEASE_BASE` names one, with a
/// release `version` in it whose "binary" is a script that says what
/// `says`. `honest` is whether its checksum is the archive's own.
#[cfg(target_os = "linux")]
fn release_of(dir: &Path, version: &str, says: &str, honest: bool) {
    let archive = format!(
        "sessionly-{}-unknown-linux-musl.tar.gz",
        std::env::consts::ARCH
    );
    let release = dir.join(format!("v{version}"));
    fs::create_dir_all(&release).unwrap();
    fs::write(
        release.join("sessionly"),
        format!("#!/bin/sh\necho '{says}'\n"),
    )
    .unwrap();
    let packed = Command::new("tar")
        .args(["-czf", &archive, "sessionly"])
        .current_dir(&release)
        .status()
        .unwrap();
    assert!(packed.success());
    let sum = stdout(
        Command::new("sha256sum")
            .arg(release.join(&archive))
            .output()
            .unwrap(),
    );
    let sum = sum.split_whitespace().next().unwrap().to_string();
    let written = if honest { sum } else { "0".repeat(64) };
    fs::write(
        release.join("SHA256SUMS"),
        format!("{written}  {archive}\n"),
    )
    .unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn update_replaces_the_binary_with_a_release_that_checks_out() {
    let home = tempfile::tempdir().unwrap();
    let this = env!("CARGO_PKG_VERSION");
    let releases = home.path().join("releases");
    release_of(&releases, "99.0.0", "sessionly 99.0.0", true);
    release_of(&releases, "99.0.1", "sessionly 99.0.1", false);
    release_of(&releases, "99.0.2", "sessionly 1.2.3", true);
    // Says the right thing and then fails: the quote ends the script's
    // `echo`, and the lines after it are the script's own.
    release_of(&releases, "99.0.3", "sessionly 99.0.3'\nexit 1\n: '", true);
    let latest = home.path().join("latest.json");
    let newest = |version: &str| {
        fs::write(&latest, format!(r#"{{"tag_name":"v{version}"}}"#)).unwrap();
    };

    // A copy to update, reached through a link as an installed one often is.
    let bin = home.path().join("opt/sessionly");
    fs::create_dir_all(bin.parent().unwrap()).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_sessionly"), &bin).unwrap();
    let link = home.path().join("sessionly");
    std::os::unix::fs::symlink(&bin, &link).unwrap();
    let before = fs::read(&bin).unwrap();
    let update = |args: &[&str]| {
        let mut cmd = Command::new(&link);
        cmd.arg("update")
            .args(args)
            .env("HOME", home.path())
            .env(
                "SESSIONLY_RELEASE_BASE",
                format!("file://{}", releases.display()),
            )
            .env(
                "SESSIONLY_RELEASE_LATEST",
                format!("file://{}", latest.display()),
            );
        cmd.output().unwrap()
    };
    let unchanged = || fs::read(&bin).unwrap() == before;

    // Nothing newer: nothing to do.
    newest(this);
    let said = stdout(update(&[]));
    assert!(said.contains("is the newest release"), "{said}");
    newest("0.0.1");
    let said = stdout(update(&[]));
    assert!(said.contains("is the newest release"), "{said}");
    assert!(unchanged());

    // Asked only whether there is one.
    newest("99.0.0");
    let said = stdout(update(&["--check"]));
    assert!(said.contains("sessionly 99.0.0 is out"), "{said}");
    assert!(unchanged());

    // A download that is not what its checksum says, and one that is not
    // the version it was published as, change nothing.
    let out = update(&["--version", "99.0.1"]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("does not match its checksum"),
        "{}",
        stderr(&out)
    );
    let out = update(&["--version", "99.0.2"]);
    assert!(!out.status.success());
    assert!(
        stderr(&out).contains("not sessionly 99.0.2"),
        "{}",
        stderr(&out)
    );
    // Nor does one that names its version and fails.
    let out = update(&["--version", "99.0.3"]);
    assert!(!out.status.success());
    assert!(stderr(&out).contains("does not run"), "{}", stderr(&out));
    let out = update(&["--version", "99.9.9"]);
    assert!(!out.status.success());
    assert!(stderr(&out).contains("checksums"), "{}", stderr(&out));
    assert!(unchanged());
    let left: Vec<_> = fs::read_dir(bin.parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left, ["sessionly"], "something was left beside the binary");

    // The newest one: the file is replaced where it is, and the link stays.
    let said = stdout(update(&[]));
    assert!(
        said.contains(&format!("Updated sessionly {this} to 99.0.0")),
        "{said}"
    );
    assert!(fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    let now = stdout(Command::new(&link).arg("--version").output().unwrap());
    assert_eq!(now.trim(), "sessionly 99.0.0");
}

/// A background upload asks once a day, and `status` says when a newer
/// release was recorded. `list` does not, unless its output is a terminal,
/// and `--json` never does. The setting turns the line off.
#[test]
fn a_background_upload_notes_a_newer_release_once_a_day() {
    let home = tempfile::tempdir().unwrap();
    let latest = home.path().join("latest.json");
    fs::write(&latest, r#"{"tag_name":"v99.0.0"}"#).unwrap();
    let url = format!("file://{}", latest.display());
    let this = env!("CARGO_PKG_VERSION");
    let auto = || {
        sessionly(home.path())
            .arg("auto")
            .env("SESSIONLY_RELEASE_LATEST", &url)
            .output()
            .unwrap()
    };

    // Not connected: nothing is uploaded, so nothing is asked.
    let disconnected = auto();
    assert!(
        disconnected.status.success(),
        "{}",
        String::from_utf8_lossy(&disconnected.stderr)
    );
    let check = home.path().join("data/update-check.json");
    assert!(!check.exists(), "a local ledger asked for a release");

    // The check is on, and auto-sync is on, but there is no server to upload to.
    let alone = stdout(sessionly(home.path()).arg("status").output().unwrap());
    assert!(
        alone.contains(
            "Update:     on, but nothing asks until a server is set (`sessionly connect`)"
        ),
        "{alone}"
    );

    let server = StubServer::start();
    stdout(run(home.path(), &["connect", &server.url, "--token", "t"]));

    let first = auto();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&check).unwrap()).unwrap();
    assert_eq!(saved["latest"], "99.0.0");
    let before = fs::read(&check).unwrap();

    // A different answer the same day is not asked for: the file is untouched.
    fs::write(&latest, r#"{"tag_name":"v99.1.0"}"#).unwrap();
    let second = auto();
    assert!(second.status.success());
    assert_eq!(fs::read(&check).unwrap(), before);

    let line = format!("sessionly 99.0.0 is out (this is {this}). Run `sessionly update`.");
    let status = stdout(sessionly(home.path()).arg("status").output().unwrap());
    assert!(status.contains(&line), "{status}");
    assert!(
        status.contains(
            "Update:     on (a background upload asks once a day, and status says when a newer release is out)"
        ),
        "{status}"
    );
    // Piped, so not a terminal: no line. `--json` is the machine-readable output.
    let listed = stdout(sessionly(home.path()).arg("list").output().unwrap());
    assert!(!listed.contains("99.0.0"), "{listed}");
    let json = stdout(
        sessionly(home.path())
            .args(["list", "--json"])
            .output()
            .unwrap(),
    );
    assert!(!json.contains("99.0.0"), "{json}");

    // The check is on, but a background run is what asks, and auto-sync is what starts one.
    stdout(
        sessionly(home.path())
            .args(["settings", "--auto-sync", "off"])
            .output()
            .unwrap(),
    );
    let held = stdout(sessionly(home.path()).arg("status").output().unwrap());
    assert!(
        held.contains("Update:     on, but nothing asks while auto-sync is off"),
        "{held}"
    );
    assert!(held.contains("Auto sync:  off"), "{held}");

    stdout(
        sessionly(home.path())
            .args(["settings", "--update-check", "off"])
            .output()
            .unwrap(),
    );
    let quiet = stdout(sessionly(home.path()).arg("status").output().unwrap());
    assert!(!quiet.contains("99.0.0"), "{quiet}");
    assert!(quiet.contains("Update:     off"), "{quiet}");
}
