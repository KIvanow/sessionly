//! `sessionly turn start|end`: a reduced record of a Codex cloud task.
//!
//! Codex's cloud runs no hooks, the agent itself is not in the sandbox (only
//! what runs its commands is), and it leaves no session file there. Checked
//! on 2026-11-17: hooks in the repository and in the home directory, a
//! setup script, `~/.bashrc`. What it does do is read the repository's
//! `AGENTS.md`, so `sessionly install --repo` asks the agent there to run
//! one command before it changes anything in a turn and one after.
//!
//! The two are stored as the events hooks would have sent for a turn with a
//! single piece of work in it, and the working tree is compared between
//! them as it is around a shell command (see `changes`). So such a session
//! has its turns, when they began and ended, and the files and lines each
//! changed. It has no prompt text, no tool calls, no model, no tokens and no
//! cost, and it has a turn only if the agent did as it was asked.
//!
//! Like `capture`, this prints nothing and always exits 0.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::changes::TURN_TOOL;

/// What is needed to store one event of the thread.
struct Thread {
    id: String,
    cwd: String,
    /// Holds the id of the turn that began and has not ended.
    open: PathBuf,
    /// Nothing of the thread has been stored yet.
    new: bool,
}

impl Thread {
    fn here(id: String, data_dir: &Path) -> Option<Thread> {
        let cwd = std::env::current_dir().ok()?;
        let cwd = crate::git::repo_root(&cwd).unwrap_or(cwd);
        let stem = crate::capture::file_stem(Some(&id));
        let raw = data_dir.join("raw").join(crate::paths::CODEX);
        Some(Thread {
            cwd: cwd.to_string_lossy().into_owned(),
            open: data_dir.join("turns").join(&stem),
            new: !raw.join(format!("{stem}.jsonl")).exists(),
            id,
        })
    }

    fn store(&self, hook: &str, turn: &str, more: Value) {
        let mut payload = json!({
            "session_id": self.id,
            "hook_event_name": hook,
            "cwd": self.cwd,
            "turn_id": turn,
        });
        for (key, value) in more.as_object().into_iter().flatten() {
            payload[key] = value.clone();
        }
        crate::capture::store(&payload);
    }

    fn open_turn(&self) -> Option<String> {
        let turn = fs::read_to_string(&self.open).ok()?;
        (!turn.trim().is_empty()).then(|| turn.trim().to_string())
    }

    /// A turn begins: its prompt, of which only the time is known.
    fn begin(&self) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let turn = format!("turn-{now}");
        if self.new {
            self.store("SessionStart", &turn, json!({ "source": "startup" }));
        }
        self.store("UserPromptSubmit", &turn, json!({ "prompt": "" }));
        turn
    }

    fn work(&self, hook: &str, turn: &str) {
        let work = json!({ "tool_name": TURN_TOOL, "tool_use_id": turn, "tool_input": {} });
        self.store(hook, turn, work);
    }

    fn start(&self) {
        // The turn before never said it ended: it ends where this one begins.
        if let Some(before) = self.open_turn() {
            self.work("PostToolUse", &before);
            self.store("Stop", &before, json!({}));
        }
        let turn = self.begin();
        self.work("PreToolUse", &turn);
        if let Some(dir) = self.open.parent() {
            let _ = crate::paths::create_private_dir(dir);
        }
        let _ = fs::write(&self.open, &turn);
    }

    fn end(&self) {
        let turn = match self.open_turn() {
            Some(turn) => {
                self.work("PostToolUse", &turn);
                let _ = fs::remove_file(&self.open);
                turn
            }
            // Its start was not run: the turn is known, what it changed is not.
            None => self.begin(),
        };
        self.store("Stop", &turn, json!({}));
    }
}

pub fn run(which: &str) -> i32 {
    // Codex names its thread to every command, on a person's machine too:
    // there its hooks and its session files say all of this and more.
    let Some(thread) = crate::runtime::codex_cloud() else {
        return 0;
    };
    let Ok(data_dir) = crate::paths::data_dir() else {
        return 0;
    };
    let Some(thread) = Thread::here(thread, &data_dir) else {
        return 0;
    };
    match which {
        "start" => thread.start(),
        "end" => {
            thread.end();
            // Not in the background, as after a hook: what a command leaves
            // running in this sandbox may not outlive the command.
            if std::env::var_os("SESSIONLY_NO_AUTO").is_none() {
                crate::auto::run(0);
            }
        }
        _ => {}
    }
    0
}
