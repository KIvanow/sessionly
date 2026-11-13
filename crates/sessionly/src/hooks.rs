//! Install and remove the Sessionly capture hooks in Claude Code settings files.
//!
//! Edits are surgical: only hook entries whose command is ours are added or
//! removed, everything else in the file (other hooks, other settings, key order)
//! is preserved. The previous file is kept as `settings.json.sessionly-bak`.

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

/// Observe-only events without a tool matcher. Left out on purpose (see
/// docs/hook-data.md): WorktreeCreate/WorktreeRemove replace behaviour instead of
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

/// The command Claude Code runs for every hook: this binary's `capture` subcommand.
pub fn capture_command(exe: &Path) -> String {
    format!("\"{}\" capture", exe.display())
}

/// `<project>/.claude/settings.json`, or the user-level `~/.claude/settings.json`.
pub fn settings_path(project: Option<&Path>) -> PathBuf {
    match project {
        Some(dir) => dir.join(".claude").join("settings.json"),
        None => crate::paths::home_dir()
            .join(".claude")
            .join("settings.json"),
    }
}

fn is_ours(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|cmd| cmd.contains("sessionly") && cmd.trim_end().ends_with(" capture"))
}

/// Remove every Sessionly hook, dropping groups and events left empty.
pub fn strip_ours(settings: &mut Value) {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    for groups in hooks.values_mut() {
        let Some(list) = groups.as_array_mut() else {
            continue;
        };
        list.retain_mut(|group| {
            let Some(entries) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            if entries.is_empty() {
                return true;
            }
            entries.retain(|h| !is_ours(h));
            !entries.is_empty()
        });
    }
    hooks.retain(|_, groups| groups.as_array().is_none_or(|l| !l.is_empty()));
    if hooks.is_empty() {
        settings.as_object_mut().unwrap().remove("hooks");
    }
}

/// Append one Sessionly hook group per event.
pub fn add_ours(settings: &mut Value, command: &str) -> Result<()> {
    let root = settings
        .as_object_mut()
        .context("settings file is not a JSON object")?;
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .context("\"hooks\" in settings is not an object")?;
    for event in all_events() {
        let mut group = Map::new();
        if TOOL_EVENTS.contains(&event) {
            group.insert("matcher".into(), json!("*"));
        }
        group.insert(
            "hooks".into(),
            json!([{ "type": "command", "command": command }]),
        );
        let list = hooks
            .entry(event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .with_context(|| format!("\"hooks.{event}\" in settings is not an array"))?;
        list.push(Value::Object(group));
    }
    Ok(())
}

pub fn install(path: &Path, command: &str) -> Result<()> {
    let mut settings = load(path)?;
    strip_ours(&mut settings);
    add_ours(&mut settings, command)?;
    save(path, &settings)
}

pub fn uninstall(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let mut settings = load(path)?;
    strip_ours(&mut settings);
    save(path, &settings)
}

/// Events that currently have a Sessionly hook in `path`.
pub fn installed_events(path: &Path) -> Result<Vec<String>> {
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
                    .any(is_ours)
            })
        })
        .map(|(event, _)| event.clone())
        .collect())
}

fn load(path: &Path) -> Result<Value> {
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

fn save(path: &Path, settings: &Value) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if path.exists() {
        fs::copy(path, path.with_extension("json.sessionly-bak"))?;
    }
    let tmp = path.with_extension("json.sessionly-tmp");
    fs::write(&tmp, serde_json::to_string_pretty(settings)? + "\n")?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CMD: &str = "\"/usr/local/bin/sessionly\" capture";

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

    #[test]
    fn install_keeps_other_hooks_and_settings() {
        let mut s = existing();
        add_ours(&mut s, CMD).unwrap();
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
        add_ours(&mut s, CMD).unwrap();
        strip_ours(&mut s);
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
        add_ours(&mut s, CMD).unwrap();
        strip_ours(&mut s);
        assert_eq!(s, json!({ "theme": "dark" }));
    }

    #[test]
    fn install_is_idempotent_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, serde_json::to_string_pretty(&existing()).unwrap()).unwrap();
        install(&path, CMD).unwrap();
        let once = fs::read_to_string(&path).unwrap();
        install(&path, CMD).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), once);
        assert_eq!(installed_events(&path).unwrap().len(), event_count());
        uninstall(&path).unwrap();
        assert!(installed_events(&path).unwrap().is_empty());
        let restored: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(restored, existing());
    }

    #[test]
    fn refuses_to_touch_invalid_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        assert!(install(&path, CMD).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn only_capture_commands_count_as_ours() {
        assert!(is_ours(&json!({ "command": CMD })));
        assert!(!is_ours(&json!({ "command": "/opt/sessionly/other-tool" })));
        assert!(!is_ours(&json!({ "command": "/opt/other/capture" })));
    }
}
