//! Install and remove the Sessionly capture hooks in Claude Code settings
//! files, and in Codex's `hooks.json`, which has the same layout.
//!
//! Edits are surgical: only hook entries that run our own `capture` command are
//! added or removed. Other hooks, other settings, key order and number
//! formatting are preserved, as are the file's permissions and a symlinked
//! location. The file as it was before our first change is kept next to it as
//! `settings.json.sessionly-bak` and never overwritten.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};

/// Tool events take a `"*"` matcher so every tool is captured.
pub const TOOL_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "PermissionDenied",
];

/// Observe-only events without a tool matcher. Left out on purpose:
/// WorktreeCreate/WorktreeRemove replace behaviour instead of
/// observing it, PreModelSwitch blocks the switch on timeout, MessageDisplay
/// fires per streamed chunk, and the rest are low value for a ledger.
pub const OTHER_EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "UserPromptExpansion",
    "Stop",
    "StopFailure",
    "Notification",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "PostModelSwitch",
    "TaskCreated",
    "TaskCompleted",
    "InstructionsLoaded",
];

pub fn all_events() -> impl Iterator<Item = &'static str> {
    TOOL_EVENTS.iter().chain(OTHER_EVENTS).copied()
}

/// The events Codex has (read from its source at 0.169.0), tool events
/// first. Left out: PreModelRequest and PostModelRequest fire for every
/// request to the model, and Interrupt adds nothing the session file lacks.
pub const CODEX_TOOL_EVENTS: &[&str] = &["PreToolUse", "PostToolUse", "PermissionRequest"];
pub const CODEX_OTHER_EVENTS: &[&str] = &[
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
];

/// Whose hooks file is being written.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    fn tool_events(self) -> &'static [&'static str] {
        match self {
            Agent::Claude => TOOL_EVENTS,
            Agent::Codex => CODEX_TOOL_EVENTS,
        }
    }

    pub fn events(self) -> impl Iterator<Item = &'static str> {
        let other = match self {
            Agent::Claude => OTHER_EVENTS,
            Agent::Codex => CODEX_OTHER_EVENTS,
        };
        self.tool_events().iter().chain(other).copied()
    }
}

/// Codex's hooks file: `$CODEX_HOME/hooks.json`, or `~/.codex/hooks.json`.
pub fn codex_hooks_path() -> Result<PathBuf> {
    Ok(crate::paths::codex_home()
        .context("cannot find the home directory")?
        .join("hooks.json"))
}

/// Quote a string as one POSIX shell word. Hook commands are run by a shell,
/// so a path with spaces, quotes or `$` must not be interpreted.
pub(crate) fn shell_quote(text: &str) -> String {
    let plain = |c: char| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c);
    if !text.is_empty() && text.chars().all(plain) {
        text.to_string()
    } else {
        format!("'{}'", text.replace('\'', r"'\''"))
    }
}

/// The command Claude Code runs for every hook: this binary's `capture` subcommand.
pub fn capture_command(exe: &Path) -> String {
    format!("{} capture", shell_quote(&exe.to_string_lossy()))
}

/// Split a shell command into its first word (quotes resolved) and the rest.
fn first_word(command: &str) -> Option<(String, &str)> {
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.char_indices();
    while let Some((i, c)) = chars.next() {
        match (quote, c) {
            (None, c) if c.is_whitespace() => return Some((word, &command[i..])),
            (None, '\'' | '"') => quote = Some(c),
            (Some(q), c) if c == q => quote = None,
            (None | Some('"'), '\\') => word.push(chars.next()?.1),
            (_, c) => word.push(c),
        }
    }
    quote.is_none().then_some((word, ""))
}

/// The two hooks Sessionly installs. They live side by side: a repository's
/// settings file can have both, and each is installed and removed on its own.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    /// `<path to sessionly> capture`: this machine's binary, for sessions on
    /// this machine.
    Machine,
    /// `…/.sessionly/hook.sh <agent>`: the script committed to a repository,
    /// for sessions in the cloud (see `repo`).
    Repo,
}

/// Which of our hooks a command is, if either.
pub fn kind_of(command: &str) -> Option<Kind> {
    let (program, rest) = first_word(command.trim())?;
    let name = program.rsplit(['/', '\\']).next().unwrap_or_default();
    if rest.trim() == "capture" && matches!(name, "sessionly" | "sessionly.exe") {
        return Some(Kind::Machine);
    }
    let script = program == ".sessionly/hook.sh" || program.ends_with("/.sessionly/hook.sh");
    (script && matches!(rest.trim(), "claude" | "cursor")).then_some(Kind::Repo)
}

/// True for a hook entry that runs our command of this kind.
pub(crate) fn is_ours(hook: &Value, kind: Kind) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| kind_of(command) == Some(kind))
}

/// `<project>/.claude/settings.json`, or the user-level `~/.claude/settings.json`.
pub fn settings_path(project: Option<&Path>) -> Result<PathBuf> {
    let base = match project {
        Some(dir) => dir.to_path_buf(),
        None => crate::paths::home_dir().context("cannot find the home directory")?,
    };
    Ok(base.join(".claude").join("settings.json"))
}

/// Remove every Sessionly hook of one kind. Groups and events are dropped
/// only if removing our hook is what emptied them.
pub fn strip_ours(settings: &mut Value, kind: Kind) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    let mut removed_any = false;
    let mut emptied_events = Vec::new();
    for (event, groups) in hooks.iter_mut() {
        let Some(list) = groups.as_array_mut() else {
            continue;
        };
        let groups_before = list.len();
        list.retain_mut(|group| {
            let Some(entries) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let before = entries.len();
            entries.retain(|h| !is_ours(h, kind));
            let removed = entries.len() < before;
            removed_any |= removed;
            !(removed && entries.is_empty())
        });
        if list.is_empty() && groups_before > 0 {
            emptied_events.push(event.clone());
        }
    }
    for event in emptied_events {
        hooks.shift_remove(&event);
    }
    if removed_any && hooks.is_empty() {
        settings.as_object_mut().unwrap().shift_remove("hooks");
    }
}

/// Append one Sessionly hook group per event.
pub fn add_ours(settings: &mut Value, command: &str, agent: Agent) -> Result<()> {
    let root = settings
        .as_object_mut()
        .context("settings file is not a JSON object")?;
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .context("\"hooks\" in settings is not an object")?;
    for event in agent.events() {
        let mut handler = json!({ "type": "command", "command": command });
        // Codex then neither waits for the capture nor shows it running. It
        // runs SessionEnd in step whatever is asked, and warns if asked otherwise.
        if agent == Agent::Codex && event != "SessionEnd" {
            handler["async"] = json!(true);
        }
        let mut group = Map::new();
        if agent.tool_events().contains(&event) {
            group.insert("matcher".into(), json!("*"));
        }
        group.insert("hooks".into(), json!([handler]));
        let list = hooks
            .entry(event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .with_context(|| format!("\"hooks.{event}\" in settings is not an array"))?;
        list.push(Value::Object(group));
    }
    Ok(())
}

/// Install `command`, replacing an earlier hook of the same kind. Returns
/// whether the file was changed.
pub fn install(path: &Path, command: &str) -> Result<bool> {
    install_for(path, command, Agent::Claude)
}

/// `install`, into the hooks file of `agent`.
pub fn install_for(path: &Path, command: &str, agent: Agent) -> Result<bool> {
    let kind = kind_of(command).context("not a Sessionly hook command")?;
    let before = load(path)?;
    let mut settings = before.clone();
    strip_ours(&mut settings, kind);
    add_ours(&mut settings, command, agent)?;
    if settings == before {
        return Ok(false);
    }
    // A file in a repository is under version control: no copy is kept.
    save(path, &settings, kind == Kind::Machine)?;
    Ok(true)
}

/// Returns whether the file was changed.
pub fn uninstall(path: &Path, kind: Kind) -> Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let before = load(path)?;
    let mut settings = before.clone();
    strip_ours(&mut settings, kind);
    if settings == before {
        return Ok(false);
    }
    save(path, &settings, kind == Kind::Machine)?;
    Ok(true)
}

/// Events that currently have a Sessionly hook of this kind in `path`.
pub fn installed_events(path: &Path, kind: Kind) -> Result<Vec<String>> {
    let settings = load(path)?;
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return Ok(vec![]);
    };
    Ok(hooks
        .iter()
        .filter(|(_, groups)| {
            groups.as_array().into_iter().flatten().any(|g| {
                g.get("hooks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(|hook| is_ours(hook, kind))
            })
        })
        .map(|(event, _)| event.clone())
        .collect())
}

pub(crate) fn load(path: &Path) -> Result<Value> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    let value: Value = serde_json::from_str(&text)
        .with_context(|| format!("{} is not valid JSON; not touching it", path.display()))?;
    if !value.is_object() {
        bail!("{} is not a JSON object; not touching it", path.display());
    }
    Ok(value)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// Write `settings` to `path`. With `keep_original`, the file as it was
/// before our first change is kept next to it.
pub(crate) fn save(path: &Path, settings: &Value, keep_original: bool) -> Result<()> {
    // Write through a symlink (dotfile managers) instead of replacing it.
    let target = if path.is_symlink() {
        fs::canonicalize(path).with_context(|| format!("resolving {}", path.display()))?
    } else {
        path.to_path_buf()
    };
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut permissions = None;
    if target.exists() {
        let backup = with_suffix(path, ".sessionly-bak");
        if keep_original && !backup.exists() {
            fs::copy(&target, &backup)?;
        }
        permissions = Some(fs::metadata(&target)?.permissions());
    }
    // Write a sibling file and rename it into place, so a crash can't leave a
    // half-written settings file.
    let tmp = with_suffix(&target, ".sessionly-tmp");
    fs::write(&tmp, serde_json::to_string_pretty(settings)? + "\n")?;
    if let Some(permissions) = permissions {
        fs::set_permissions(&tmp, permissions)?;
    }
    fs::rename(&tmp, &target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CMD: &str = "/usr/local/bin/sessionly capture";

    fn existing() -> Value {
        json!({
            "model": "opus",
            "hooks": {
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "/opt/other/start" }] }],
                "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "/opt/other/pre" }] }]
            },
            "theme": "dark"
        })
    }

    fn event_count() -> usize {
        all_events().count()
    }

    fn is_ours_machine(hook: &Value) -> bool {
        is_ours(hook, Kind::Machine)
    }

    #[test]
    fn the_repository_hook_is_told_from_the_machines() {
        for command in [
            r#""$CLAUDE_PROJECT_DIR"/.sessionly/hook.sh claude"#,
            ".sessionly/hook.sh cursor",
            "/work/repo/.sessionly/hook.sh claude",
        ] {
            assert_eq!(kind_of(command), Some(Kind::Repo), "{command}");
        }
        assert_eq!(kind_of(CMD), Some(Kind::Machine));
        for command in [
            ".sessionly/hook.sh",
            ".sessionly/hook.sh grok",
            "tools/not.sessionly/hook.sh claude",
            "other/hook.sh claude",
            "echo .sessionly/hook.sh claude",
        ] {
            assert_eq!(kind_of(command), None, "{command}");
        }
        // Each kind is installed and removed without touching the other.
        let mut s = json!({});
        add_ours(&mut s, CMD, Agent::Claude).unwrap();
        add_ours(&mut s, ".sessionly/hook.sh claude", Agent::Claude).unwrap();
        strip_ours(&mut s, Kind::Repo);
        assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(s["hooks"]["Stop"][0]["hooks"][0]["command"], CMD);
        strip_ours(&mut s, Kind::Machine);
        assert_eq!(s, json!({}));
    }

    fn write(path: &Path, value: &Value) {
        fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn install_keeps_other_hooks_and_settings() {
        let mut s = existing();
        add_ours(&mut s, CMD, Agent::Claude).unwrap();
        assert_eq!(s["model"], "opus");
        assert_eq!(s["hooks"]["SessionStart"].as_array().unwrap().len(), 2);
        assert_eq!(
            s["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "/opt/other/start"
        );
        assert_eq!(s["hooks"]["PreToolUse"][1]["matcher"], "*");
        assert!(s["hooks"]["Stop"][0].get("matcher").is_none());
        assert_eq!(s["hooks"].as_object().unwrap().len(), event_count());
    }

    #[test]
    fn uninstall_restores_original() {
        let mut s = existing();
        add_ours(&mut s, CMD, Agent::Claude).unwrap();
        strip_ours(&mut s, Kind::Machine);
        assert_eq!(s, existing());
        // key order is preserved too
        assert_eq!(
            serde_json::to_string(&s).unwrap(),
            serde_json::to_string(&existing()).unwrap()
        );
    }

    #[test]
    fn strip_removes_hooks_key_when_only_ours() {
        let mut s = json!({ "theme": "dark" });
        add_ours(&mut s, CMD, Agent::Claude).unwrap();
        strip_ours(&mut s, Kind::Machine);
        assert_eq!(s, json!({ "theme": "dark" }));
    }

    #[test]
    fn strip_keeps_what_was_already_empty() {
        // Empty lists and groups that have nothing to do with us are left alone.
        let original = json!({ "hooks": { "Notification": [], "Stop": [{ "hooks": [] }] } });
        let mut s = original.clone();
        strip_ours(&mut s, Kind::Machine);
        assert_eq!(s, original);
        let mut untouched = json!({ "hooks": {} });
        strip_ours(&mut untouched, Kind::Machine);
        assert_eq!(untouched, json!({ "hooks": {} }));
        // After an install, removing our hook keeps the other tool's group.
        let mut s = original.clone();
        add_ours(&mut s, CMD, Agent::Claude).unwrap();
        strip_ours(&mut s, Kind::Machine);
        assert_eq!(s["hooks"]["Stop"], original["hooks"]["Stop"]);
    }

    #[test]
    fn only_our_exact_command_counts_as_ours() {
        let ours = |cmd: &str| is_ours_machine(&json!({ "command": cmd }));
        assert!(ours(CMD));
        assert!(ours("\"/usr/local/bin/sessionly\" capture")); // older quoting
        assert!(!ours("'/home/it's me/bin/sessionly' capture")); // unbalanced quote
        assert!(ours(r"'/home/it'\''s me/bin/sessionly' capture"));
        assert!(ours(r"'C:\tools\sessionly.exe' capture"));
        // other tools that merely mention the name or the word
        assert!(!ours("/home/me/sessionly-notes/bin/screenshot capture"));
        assert!(!ours("cd ~/code/sessionly && ./tools/audit.sh capture"));
        assert!(!ours("/opt/sessionly/other-tool capture"));
        assert!(!ours("/opt/other/capture"));
        assert!(!ours("/usr/local/bin/sessionly capture --verbose"));
        assert!(!ours("/usr/local/bin/sessionly watch"));
        assert!(!is_ours_machine(
            &json!({ "type": "http", "url": "http://x" })
        ));
    }

    #[test]
    fn codex_gets_its_own_events_in_the_background() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hooks.json");
        fs::write(
            &path,
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/opt/other/stop"}]}]}}"#,
        )
        .unwrap();
        assert!(install_for(&path, CMD, Agent::Codex).unwrap());
        assert!(!install_for(&path, CMD, Agent::Codex).unwrap());
        let file = load(&path).unwrap();
        // Codex refuses a hooks file with any other key at the top.
        let keys: Vec<&String> = file.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["hooks"]);
        let events: Vec<&str> = Agent::Codex.events().collect();
        assert_eq!(
            installed_events(&path, Kind::Machine).unwrap().len(),
            events.len()
        );
        assert!(!events.contains(&"PostToolUseFailure"));
        assert_eq!(file["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(
            file["hooks"]["PostToolUse"][0],
            json!({ "matcher": "*", "hooks": [{ "type": "command", "command": CMD, "async": true }] })
        );
        assert_eq!(file["hooks"]["Stop"][1].get("matcher"), None);
        assert_eq!(
            file["hooks"]["SessionEnd"][0]["hooks"][0].get("async"),
            None
        );

        assert!(uninstall(&path, Kind::Machine).unwrap());
        assert_eq!(
            load(&path).unwrap(),
            json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "/opt/other/stop" }] }] } })
        );
    }

    #[test]
    fn install_leaves_lookalike_hooks_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let lookalike = "/home/me/sessionly-notes/bin/screenshot capture";
        write(
            &path,
            &json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": lookalike }] }] } }),
        );
        install(&path, CMD).unwrap();
        uninstall(&path, Kind::Machine).unwrap();
        assert_eq!(
            read(&path)["hooks"]["Stop"][0]["hooks"][0]["command"],
            lookalike
        );
    }

    #[test]
    fn command_survives_awkward_paths() {
        for exe in [
            "/usr/local/bin/sessionly",
            "/home/a b/bin/sessionly",
            "/home/it's \"quoted\"/$HOME/`x`/sessionly",
        ] {
            let command = capture_command(Path::new(exe));
            let (program, rest) = first_word(&command).unwrap();
            assert_eq!(program, exe, "{command}");
            assert_eq!(rest.trim(), "capture");
            assert!(is_ours_machine(&json!({ "command": command })));
        }
        assert_eq!(
            capture_command(Path::new("/usr/bin/sessionly")),
            "/usr/bin/sessionly capture"
        );
    }

    #[test]
    fn install_is_idempotent_and_backup_stays_pristine() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        write(&path, &existing());
        assert!(install(&path, CMD).unwrap());
        let once = fs::read_to_string(&path).unwrap();
        assert!(!install(&path, CMD).unwrap()); // nothing to change
        assert_eq!(fs::read_to_string(&path).unwrap(), once);
        assert_eq!(
            installed_events(&path, Kind::Machine).unwrap().len(),
            event_count()
        );
        // a different binary path replaces our hooks instead of adding more
        assert!(install(&path, "/opt/new/sessionly capture").unwrap());
        assert_eq!(read(&path)["hooks"]["Stop"].as_array().unwrap().len(), 1);

        assert!(uninstall(&path, Kind::Machine).unwrap());
        assert!(installed_events(&path, Kind::Machine).unwrap().is_empty());
        assert_eq!(read(&path), existing());
        assert!(!uninstall(&path, Kind::Machine).unwrap());
        // the backup is still the file from before the first install
        assert_eq!(
            read(&dir.path().join("settings.json.sessionly-bak")),
            existing()
        );
    }

    #[test]
    fn preserves_number_formatting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            r#"{"big": 12345678901234567890123, "exp": 1e2, "f": 1.50}"#,
        )
        .unwrap();
        install(&path, CMD).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        // values keep their digits; an exponent may be respelled (1e2 -> 1e+2)
        for literal in ["12345678901234567890123", "1e+2", "1.50"] {
            assert!(text.contains(literal), "{literal} missing in {text}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn preserves_permissions_and_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("dotfiles-settings.json");
        write(&real, &existing());
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("settings.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        install(&link, CMD).unwrap();
        assert!(link.is_symlink());
        assert_eq!(
            installed_events(&real, Kind::Machine).unwrap().len(),
            event_count()
        );
        assert_eq!(
            fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn refuses_to_touch_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(install(&path, CMD).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
