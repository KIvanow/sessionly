//! Tests that run the built binary the way Claude Code and a user would.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

fn sessionly(home: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_sessionly"));
    cmd.env("HOME", home)
        .env("SESSIONLY_HOME", home.join("data"))
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
    child.stdin.take().unwrap().write_all(stdin).unwrap();
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
    stdout(install.output().unwrap());
    let settings: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(project.join(".claude/settings.json")).unwrap())
            .unwrap();
    let command = settings["hooks"]["Stop"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();

    let mut hook = Command::new("sh");
    hook.arg("-c")
        .arg(command)
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
