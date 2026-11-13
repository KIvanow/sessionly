//! Automatic sync: when a session ends, bring the ledger up to date and
//! upload in the background, so nobody has to run a command.
//!
//! The capture hook starts a detached `sessionly auto` process and returns at
//! once. The background run is silent; what it did is appended to `auto.log`.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use anyhow::Result;
use chrono::{SecondsFormat, Utc};

use crate::config::Config;
use crate::ledger::Ledger;

/// A turn ending starts a background run at most this often. A session
/// ending always starts one.
const TURN_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Claude Code writes its cost total as it exits, just after the SessionEnd
/// hook. Waiting a moment lets the first run already see it.
const SESSION_END_DELAY_MS: u64 = 3000;

/// How long a run waits for another run to finish before giving up.
const LOCK_WAIT: Duration = Duration::from_secs(120);

const LOG_LIMIT_BYTES: u64 = 256 * 1024;

/// Called by the capture hook after an event is stored. Starts a background
/// run if this event calls for one. Never fails and never waits.
pub fn maybe_spawn(hook: &str, data_dir: &Path) {
    let delay_ms = match hook {
        "SessionEnd" => SESSION_END_DELAY_MS,
        "Stop" => 0,
        _ => return,
    };
    if std::env::var_os("SESSIONLY_NO_AUTO").is_some() || !auto_sync_enabled(data_dir) {
        return;
    }
    let stamp = data_dir.join("auto.stamp");
    if hook == "Stop" && age(&stamp).is_some_and(|age| age < TURN_INTERVAL) {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let delay_ms = std::env::var("SESSIONLY_AUTO_DELAY_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(delay_ms);
    let mut command = Command::new(exe);
    command
        .args(["auto", "--after-ms", &delay_ms.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Its own process group, so it outlives the hook and the agent's exit.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    if command.spawn().is_ok() {
        let _ = fs::write(&stamp, b"");
    }
}

/// `auto_sync` from the config file, without creating the file. On by default.
fn auto_sync_enabled(data_dir: &Path) -> bool {
    fs::read_to_string(data_dir.join("config.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|config| config.get("auto_sync")?.as_bool())
        .unwrap_or(true)
}

fn age(path: &Path) -> Option<Duration> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    SystemTime::now().duration_since(modified).ok()
}

/// When the last background run was started, as a duration ago.
pub fn last_started(data_dir: &Path) -> Option<Duration> {
    age(&data_dir.join("auto.stamp"))
}

/// The `sessionly auto` command: one background run. Prints nothing and
/// always exits 0; the outcome goes to `auto.log`.
pub fn run(after_ms: u64) -> i32 {
    std::thread::sleep(Duration::from_millis(after_ms));
    let Ok(data_dir) = crate::paths::data_dir() else {
        return 0;
    };
    let outcome = match locked(&data_dir) {
        Ok(Some(_lock)) => once().unwrap_or_else(|err| format!("failed: {err:#}")),
        Ok(None) => "skipped: another run was still going".to_string(),
        Err(err) => format!("failed: {err:#}"),
    };
    log(&data_dir, &outcome);
    0
}

/// Take the run lock, waiting for a run in progress: it may have read a
/// session's capture before that session's last events were written.
fn locked(data_dir: &Path) -> Result<Option<File>> {
    crate::paths::create_private_dir(data_dir)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join("auto.lock"))?;
    let deadline = Instant::now() + LOCK_WAIT;
    while file.try_lock().is_err() {
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(Some(file))
}

fn once() -> Result<String> {
    let config = Config::load(&crate::paths::config_path()?)?;
    let mut ledger = Ledger::open(&crate::paths::ledger_path()?)?;
    let (synced, _) = crate::sync::sync_all(&mut ledger, &config, false)?;
    let mut outcome = format!(
        "synced {} ({} unchanged, {} failed)",
        synced.synced,
        synced.unchanged,
        synced.failed.len()
    );
    if config.server.is_some() {
        let uploaded = crate::upload::run(&mut ledger, &config, false)?;
        outcome.push_str(&format!("; {}", uploaded.summary()));
    }
    Ok(outcome)
}

fn log(data_dir: &Path, outcome: &str) {
    let path = data_dir.join("auto.log");
    if fs::metadata(&path).is_ok_and(|m| m.len() > LOG_LIMIT_BYTES) {
        let _ = fs::rename(&path, data_dir.join("auto.log.old"));
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    if let Ok(mut file) = options.open(path) {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        let _ = writeln!(file, "{now} {outcome}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_sync_is_on_unless_switched_off() {
        let dir = tempfile::tempdir().unwrap();
        assert!(auto_sync_enabled(dir.path()));
        fs::write(dir.path().join("config.json"), r#"{"machine_id":"m"}"#).unwrap();
        assert!(auto_sync_enabled(dir.path()));
        fs::write(dir.path().join("config.json"), r#"{"auto_sync":false}"#).unwrap();
        assert!(!auto_sync_enabled(dir.path()));
        fs::write(dir.path().join("config.json"), "broken").unwrap();
        assert!(auto_sync_enabled(dir.path()));
    }

    #[test]
    fn only_turn_and_session_ends_start_a_run() {
        let dir = tempfile::tempdir().unwrap();
        for hook in ["PreToolUse", "PostToolUse", "SessionStart", "?"] {
            maybe_spawn(hook, dir.path());
        }
        assert!(last_started(dir.path()).is_none());
    }

    #[test]
    fn the_log_rolls_over() {
        let dir = tempfile::tempdir().unwrap();
        log(dir.path(), "first");
        let path = dir.path().join("auto.log");
        assert!(fs::read_to_string(&path).unwrap().ends_with(" first\n"));
        fs::write(&path, vec![b'x'; LOG_LIMIT_BYTES as usize + 1]).unwrap();
        log(dir.path(), "second");
        assert!(fs::read_to_string(&path).unwrap().ends_with(" second\n"));
        assert!(dir.path().join("auto.log.old").exists());
    }
}
