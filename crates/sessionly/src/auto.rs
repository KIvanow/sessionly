//! Automatic sync: when a turn or a session ends, bring the ledger up to date and
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
use chrono::{DateTime, SecondsFormat, Utc};

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

/// How often a background run asks whether a newer release is out.
const UPDATE_INTERVAL: chrono::Duration = chrono::Duration::hours(24);

const LOG_LIMIT_BYTES: u64 = 256 * 1024;

/// Called by the capture hook after an event is stored. Starts a background
/// run if this event calls for one. Never fails and never waits.
pub fn maybe_spawn(hook: &str, data_dir: &Path) {
    // Cursor names its events in camel case: `stop`, `sessionEnd`.
    let hook = hook.to_lowercase();
    let delay_ms = match hook.as_str() {
        "sessionend" => SESSION_END_DELAY_MS,
        "stop" => 0,
        _ => return,
    };
    if std::env::var_os("SESSIONLY_NO_AUTO").is_some() || !auto_sync_enabled(data_dir) {
        return;
    }
    let stamp = data_dir.join("auto.stamp");
    // A sandbox can be gone minutes after a turn, and Cursor's cloud never
    // says that a session ended: there, every turn's end is acted on.
    let often = crate::runtime::in_cloud();
    if hook == "stop" && !often && age(&stamp).is_some_and(|age| age < TURN_INTERVAL) {
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
    flag(data_dir, "auto_sync", true)
}

/// `update_check` from the config file, without creating the file. On by default.
fn update_check_enabled(data_dir: &Path) -> bool {
    flag(data_dir, "update_check", true)
}

/// A boolean setting, or `default` when the file or the setting is absent.
fn flag(data_dir: &Path, name: &str, default: bool) -> bool {
    fs::read_to_string(data_dir.join("config.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|config| config.get(name)?.as_bool())
        .unwrap_or(default)
}

/// What a background run remembered of the newest release.
#[derive(serde::Deserialize)]
struct UpdateCheck {
    checked_at: String,
    latest: Option<String>,
}

fn read_update_check(path: &Path) -> Option<UpdateCheck> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Whether `checked_at` is less than a day ago, and not in the future. One
/// that cannot be read is not. A future one is not either: a clock that was
/// ahead, and is then put right, would otherwise wait out the whole gap.
fn asked_within_a_day(checked_at: &str) -> bool {
    let Ok(at) = DateTime::parse_from_rfc3339(checked_at) else {
        return false;
    };
    let age = Utc::now().signed_duration_since(at);
    age >= chrono::Duration::zero() && age < UPDATE_INTERVAL
}

/// The line for `status` (and for `list` and `summary` in a terminal) when a
/// newer release was recorded. Nothing in a cloud environment, where the
/// repository's script picks the version, or when the setting is off.
pub fn pending_update(data_dir: &Path) -> Option<String> {
    if crate::runtime::in_cloud() || !update_check_enabled(data_dir) {
        return None;
    }
    let latest = read_update_check(&data_dir.join("update-check.json"))?.latest?;
    let this = env!("CARGO_PKG_VERSION");
    crate::update::newer(&latest, this)
        .then(|| format!("sessionly {latest} is out (this is {this}). Run `sessionly update`."))
}

/// Why nothing will ask whether a newer release is out, or `None` when a
/// background upload will. The check is off, this is a cloud environment,
/// auto-sync is off, or no server is set. A server named only in the
/// environment counts, because that is the config a background run loads.
/// `SESSIONLY_NO_AUTO` is not one of these: a hook sets it, and `settings`
/// cannot see that environment.
pub(crate) fn update_check_blocker(config: &Config) -> Option<&'static str> {
    if !config.update_check {
        return Some("off");
    }
    if crate::runtime::in_cloud() {
        return Some("on, but not asked in a cloud environment");
    }
    if !config.auto_sync {
        return Some("on, but nothing asks while auto-sync is off");
    }
    if config.clone().with_environment().server.is_none() {
        return Some("on, but nothing asks until a server is set (`sessionly connect`)");
    }
    None
}

/// Ask, at most once a day, whether a newer release is out, and remember the
/// version the release page named in `update-check.json`. A failed ask is
/// silent and is not tried again until the day is up. The request carries no
/// account or session. `config` is the one this run already loaded. Nothing
/// is asked when `update_check_blocker` says so.
fn note_release(data_dir: &Path, config: &Config) {
    if update_check_blocker(config).is_some() {
        return;
    }
    let path = data_dir.join("update-check.json");
    let previous = read_update_check(&path);
    if previous
        .as_ref()
        .is_some_and(|check| asked_within_a_day(&check.checked_at))
    {
        return;
    }
    let kept = previous.and_then(|check| check.latest);
    // Remember the attempt before asking, at the time it starts. If this
    // cannot be written, or the process stops during the ask, the next run
    // must not ask again at once. The version saved afterwards keeps this
    // time: a check that took a few seconds must not push the next one on.
    let checked_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    if !write_update_check(&path, kept.as_deref(), &checked_at) {
        return;
    }
    let Ok(version) = crate::update::latest() else {
        return;
    };
    let _ = write_update_check(&path, Some(&version), &checked_at);
}

fn write_update_check(path: &Path, latest: Option<&str>, checked_at: &str) -> bool {
    let Ok(text) = serde_json::to_string_pretty(&serde_json::json!({
        "checked_at": checked_at,
        "latest": latest,
    })) else {
        return false;
    };
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options
        .open(&tmp)
        .and_then(|mut file| file.write_all(format!("{text}\n").as_bytes()));
    if written.is_ok() && fs::rename(&tmp, path).is_ok() {
        return true;
    }
    let _ = fs::remove_file(&tmp);
    false
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
    let (outcome, config) = match locked(&data_dir) {
        Ok(Some(_lock)) => once(),
        Ok(None) => ("skipped: another run was still going".to_string(), None),
        Err(err) => (format!("failed: {err:#}"), None),
    };
    // The lock is dropped, and the log line is written, before asking GitHub.
    // A session ending meanwhile waits on the lock, not on that request.
    log(&data_dir, &outcome);
    // After the upload, and never from a hook: the hooks stay offline.
    // A config that could not be read means nothing is asked.
    if let Some(config) = config {
        note_release(&data_dir, &config);
    }
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

/// What the run did, and the config it loaded. A failed upload still has one,
/// when the file could be read: the release check uses that config, not a
/// second reading of the file. A config that cannot be read is none.
fn once() -> (String, Option<Config>) {
    let config = match crate::paths::config_path().and_then(|path| Config::load(&path)) {
        Ok(config) => config.with_environment(),
        Err(err) => return (format!("failed: {err:#}"), None),
    };
    let outcome = (|| -> Result<String> {
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
    })()
    .unwrap_or_else(|err| format!("failed: {err:#}"));
    (outcome, Some(config))
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
    fn the_update_check_is_on_unless_switched_off() {
        let dir = tempfile::tempdir().unwrap();
        assert!(update_check_enabled(dir.path()));
        fs::write(dir.path().join("config.json"), r#"{"machine_id":"m"}"#).unwrap();
        assert!(update_check_enabled(dir.path()));
        fs::write(dir.path().join("config.json"), r#"{"update_check":false}"#).unwrap();
        assert!(!update_check_enabled(dir.path()));
        assert!(pending_update(dir.path()).is_none());
    }

    #[test]
    fn a_check_is_fresh_for_a_day() {
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        assert!(asked_within_a_day(&now));
        let yesterday =
            (Utc::now() - chrono::Duration::hours(25)).to_rfc3339_opts(SecondsFormat::Secs, true);
        assert!(!asked_within_a_day(&yesterday));
        assert!(!asked_within_a_day("not a time"));
        let ahead =
            (Utc::now() + chrono::Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
        assert!(!asked_within_a_day(&ahead));
        // Written, and not newer than this binary: nothing to say.
        let path = tempfile::tempdir().unwrap();
        write_update_check(&path.path().join("update-check.json"), Some("0.0.1"), &now);
        assert!(pending_update(path.path()).is_none());
    }

    #[test]
    fn a_saved_version_keeps_the_time_the_check_started() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("update-check.json");
        let at = "2026-11-18T12:00:00Z";
        assert!(write_update_check(&path, Some("0.4.0"), at));
        assert!(write_update_check(&path, Some("0.5.0"), at));
        let saved = read_update_check(&path).unwrap();
        assert_eq!(saved.checked_at, at);
        assert_eq!(saved.latest.as_deref(), Some("0.5.0"));
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
