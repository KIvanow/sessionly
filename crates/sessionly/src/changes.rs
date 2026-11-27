//! What a shell command changed.
//!
//! An agent's file tools say what they changed. A shell command does not, and
//! in a cloud sandbox agents often edit with the shell (`sed -i`, a heredoc),
//! so a session there could show no changed file at all. This module looks at
//! the working tree just before a shell command runs and again just after,
//! and stores what differs with the command's event: the files, and the lines
//! added and removed.
//!
//! The working tree is read with git, into an index and an object directory
//! kept under the data directory. The repository's own index, objects and
//! HEAD are never written.
//!
//! In a sandbox (see `runtime`) the agent is the only one working, and all
//! that differs is the command's. On a person's machine whatever the person
//! saved while a command ran would be put down to the agent, and so would
//! what another session changed meanwhile. There only what is sure to be the
//! command's is counted, unless the person asks for all of it or for none
//! (`sessionly settings --shell-edits`):
//!
//! - everything, when the command was over within `QUICK_MS` and no other
//!   session was seen at work in the repository meanwhile: nobody saves a
//!   file in that time;
//! - otherwise the added lines that the command's own text spells out (a
//!   heredoc, a script given inline), and nothing of a file where it spells
//!   out none.
//!
//! What is kept for a session is removed when the session ends. A home
//! directory that is itself a repository is not looked at there.
//!
//! A command that begins `cd <somewhere> &&` is looked at where it goes, if
//! that is another worktree of the session's repository: an agent given a
//! worktree of its own often works that way. Other repositories are left alone.
//!
//! Deliberate limits:
//! - A command that moves HEAD to commits it did not make itself (`git pull`,
//!   `git checkout main`, a rebase) is not counted: what it brought in is
//!   other people's work.
//! - What git itself restores with HEAD staying put (`git stash pop`,
//!   `git checkout <branch> -- <file>`) counts as the command's.
//! - A command that carries on in the background is counted up to when the
//!   call returned.
//! - Files git ignores are not looked at. New files over 1 MB are left out.

use std::collections::HashMap;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::git::Stop;

/// The shell tool as Claude Code and as Cursor name it.
const SHELL_TOOLS: &[&str] = &["Bash", "Shell"];

/// Codex's file tool, as its hooks name it.
const PATCH_TOOL: &str = "apply_patch";

/// Not a tool: a whole turn of an agent that runs no hooks (see `turn`). Its
/// start and end are looked at as a shell command's are.
pub const TURN_TOOL: &str = "Turn";

/// How long looking at the working tree may take for one event. A hook must
/// not stall the session: past this, the look is abandoned and no more are
/// tried in that session.
const BUDGET: Duration = Duration::from_secs(5);

/// A comparison longer than this is not stored.
const MAX_PATCH_BYTES: usize = 8 * 1024 * 1024;

/// New files larger than this are left out, and so are new files past this many at once.
const MAX_NEW_FILE_BYTES: u64 = 1024 * 1024;
const MAX_NEW_FILES: usize = 2000;

const LOCK_WAIT: Duration = Duration::from_secs(3);

/// Tools that only read: the file they name is not being changed.
const READ_ONLY: &[&str] = &["Read", "Grep", "Glob", "LS"];

/// A file tool seen to start and never to end is taken to be at work this long.
const EDIT_LASTS_MS: u64 = 60_000;

/// On a person's machine, a command over within this long is taken to be the
/// only thing that changed a file meanwhile.
const QUICK_MS: u64 = 2_000;

/// A line of at least this many characters tells whose it is by being in a
/// command's text as one of its lines; one of twice as many, by being
/// anywhere in it. Shorter ones are in too many files to tell.
const TELLING: usize = 16;

/// Another session's shell command seen to start and never to end is taken
/// to be running this long.
const COMMAND_LASTS_MS: u64 = 60 * 60_000;

/// What was kept for a session not heard of for this long is removed: it
/// ended without saying so.
const KEPT_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// What is remembered between the events of one session.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct State {
    /// The repository this is about.
    root: String,
    /// The working tree as last seen, as a git tree.
    tree: Option<String>,
    /// The commit that was checked out then.
    head: Option<String>,
    /// When it was last seen, in milliseconds.
    seen_at: u64,
    /// When a shell command last began, in milliseconds.
    at: u64,
    /// Shell commands that have begun and not ended.
    open: u32,
    /// Repositories where looking took too long once: there it is not tried again.
    too_slow: Vec<String>,
    /// Files the agent's file tools are changing or changed lately.
    edited: Vec<Edited>,
}

/// A file one of the agent's file tools was seen at work on.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Edited {
    path: String,
    /// When the tool was last heard of, in milliseconds.
    at: u64,
    /// The tool began and has not been seen to end.
    open: bool,
}

/// One event, as far as it matters here.
enum Event<'a> {
    /// A shell command began, or ended, in the repository at `root`. With
    /// `sure`, only what is sure to be the command's is counted, going by
    /// its text in `command`.
    Shell {
        root: &'a Path,
        ended: bool,
        command: &'a str,
        sure: bool,
    },
    /// A file tool began, or ended, its work on a file.
    Edit { path: PathBuf, ended: bool },
}

/// Called with each captured tool event. For a shell command's start it
/// notes the working tree; for its end it answers what to store with the
/// event: `{"changes": [{"path", "status", "lines"}]}`, or
/// `{"changes_skipped": "<why>"}` when a change was seen and not counted.
/// `lines` are patch lines, `+added` and `-removed`. With `sure`, as on a
/// person's own machine, only what is sure to be the command's is answered.
///
/// Agents run tools side by side, so a file tool may change a file while a
/// shell command runs. That tool reports the change itself: its events are
/// noted here so the file is not counted a second time as the command's.
pub fn observe(data_dir: &Path, record: &Value, at: Where) -> Option<Value> {
    // The clock is read first: waiting for the lock and looking at the tree
    // take time in which a file can change too.
    let began = Instant::now();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let p = &record["payload"];
    let ended = match record["hook"].as_str()?.to_lowercase().as_str() {
        "pretooluse" => false,
        "posttooluse" | "posttoolusefailure" | "afterfileedit" => true,
        _ => return None,
    };
    fn text(v: &Value) -> Option<&Path> {
        v.as_str().filter(|text| !text.is_empty()).map(Path::new)
    }
    let cwd = [&p["cwd"], &p["workspace_roots"][0]]
        .into_iter()
        .find_map(text);
    let tool = p["tool_name"].as_str().unwrap_or_default();
    // Codex's file tool names its files in the patch it applies, and there
    // may be several: each is noted as a file tool's work.
    if tool == PATCH_TOOL {
        let dir = data_dir
            .join("snapshots")
            .join(crate::capture::file_stem(record["session_id"].as_str()));
        for path in patched(p["tool_input"]["command"].as_str()?, cwd) {
            step(&dir, Event::Edit { path, ended }, now, began);
        }
        return None;
    }
    let root;
    let event = if SHELL_TOOLS.contains(&tool) || tool == TURN_TOOL {
        let command = p["tool_input"]["command"].as_str().unwrap_or_default();
        let own = crate::git::repo_root(cwd?);
        root = goes_to(command, cwd?)
            .and_then(|there| root_there(&there, own.as_deref()))
            .or(own)?;
        let sure = match at {
            Where::Sandbox => false,
            Where::Machine { sure } => {
                // Some keep their home directory in git. That is not a
                // repository an agent is at work in: it is everything.
                if crate::paths::home_dir().is_some_and(|home| real(&home) == real(&root)) {
                    return None;
                }
                sure
            }
        };
        Event::Shell {
            root: &root,
            ended,
            command,
            sure,
        }
    } else if READ_ONLY.contains(&tool) {
        return None;
    } else {
        let input = &p["tool_input"];
        let named = [
            &p["file_path"],
            &input["file_path"],
            &input["notebook_path"],
            &input["path"],
            &input["target_file"],
        ]
        .into_iter()
        .find_map(text)?;
        let path = if named.is_absolute() {
            named.to_path_buf()
        } else {
            cwd?.join(named)
        };
        Event::Edit { path, ended }
    };
    let stem = crate::capture::file_stem(record["session_id"].as_str());
    step(&data_dir.join("snapshots").join(stem), event, now, began)
}

/// Where an event was captured, for what of a shell command's changes may be
/// counted there.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Where {
    /// A cloud agent's sandbox: the agent is alone, and all of it is counted.
    Sandbox,
    /// A person's own machine: with `sure`, only what is sure to be the command's.
    Machine { sure: bool },
}

/// A directory as the file system knows it: links followed, `..` taken out.
/// As it is given when it cannot be found.
fn real(dir: &Path) -> PathBuf {
    fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf())
}

/// The directory git keeps a repository's objects in, shared by all of its
/// worktrees: `.git` itself, or for a worktree what its `.git` file leads to.
fn common_dir(root: &Path) -> Option<PathBuf> {
    let git = root.join(".git");
    if git.is_dir() {
        return Some(real(&git));
    }
    let text = fs::read_to_string(&git).ok()?;
    let own = root.join(text.trim().strip_prefix("gitdir:")?.trim());
    // A worktree's own directory is `<common>/worktrees/<name>`.
    let named = own.parent()?;
    let common = named.parent()?;
    (named.file_name()? == "worktrees").then(|| real(common))
}

/// The repository a command went to, given where it said it goes (`there`)
/// and the repository the session is in (`own`). Only the session's own
/// repository is looked at: a directory inside it, under the name the session
/// knows it by, or another worktree of it. A command that goes anywhere else
/// is none of this session's work on its repository.
fn root_there(there: &Path, own: Option<&Path>) -> Option<PathBuf> {
    let own = own?;
    let root = crate::git::repo_root(&fs::canonicalize(there).ok()?)?;
    if root == real(own) {
        return Some(own.to_path_buf());
    }
    (common_dir(&root)? == common_dir(own)?).then_some(root)
}

/// The files a Codex patch names: those it adds, updates, deletes or moves to.
fn patched(patch: &str, cwd: Option<&Path>) -> Vec<PathBuf> {
    const NAMES: [&str; 4] = [
        "*** Add File: ",
        "*** Update File: ",
        "*** Delete File: ",
        "*** Move to: ",
    ];
    patch
        .lines()
        .filter_map(|line| NAMES.iter().find_map(|name| line.strip_prefix(name)))
        .map(|named| Path::new(named.trim()))
        .filter_map(|named| match (named.is_absolute(), cwd) {
            (true, _) => Some(named.to_path_buf()),
            (false, Some(cwd)) => Some(cwd.join(named)),
            (false, None) => None,
        })
        .collect()
}

/// The session of `record` is over: drop what was kept to compare against.
/// One that starts again begins with a fresh look. What sessions that ended
/// without saying so left behind goes too.
pub fn forget(data_dir: &Path, record: &Value) {
    let kept = data_dir.join("snapshots");
    let stem = crate::capture::file_stem(record["session_id"].as_str());
    let _ = fs::remove_dir_all(kept.join(stem));
    for other in fs::read_dir(&kept).into_iter().flatten().flatten() {
        let heard =
            fs::metadata(other.path().join("state.json")).and_then(|state| state.modified());
        if heard.is_ok_and(|at| at.elapsed().is_ok_and(|ago| ago > KEPT_FOR)) {
            let _ = fs::remove_dir_all(other.path());
        }
    }
}

/// Where a command says it goes before anything else: the `<somewhere>` of
/// `cd <somewhere> && …`, from `cwd`. None when it does not begin that way,
/// or names the place in a way only a shell can work out.
fn goes_to(command: &str, cwd: &Path) -> Option<PathBuf> {
    let rest = command.trim_start().strip_prefix("cd ")?.trim_start();
    let (place, then) = match rest.chars().next()? {
        quote @ ('"' | '\'') => {
            let end = rest[1..].find(quote)? + 1;
            (&rest[1..end], &rest[end + 1..])
        }
        _ => rest.split_at(rest.find([' ', '\t', '\n', ';', '&']).unwrap_or(rest.len())),
    };
    let then = then.trim_start_matches([' ', '\t']);
    let goes_on = then.starts_with("&&") || then.starts_with([';', '\n']);
    let plain =
        !place.is_empty() && !place.starts_with('~') && !place.contains(['$', '`', '\\', '*', '?']);
    (goes_on && plain).then(|| cwd.join(place))
}

/// Whether another session was seen at work in the repository at `root`
/// since `since`: a shell command of its own, or a file tool on a file there.
/// `dir` is where this session's own state is kept, next to the others'.
fn others_at_work(dir: &Path, root: &Path, since: u64, now: u64) -> bool {
    let Some(all) = dir.parent() else {
        return false;
    };
    // Two sessions may know one repository by two names, through a link say.
    let root = &real(root);
    fs::read_dir(all)
        .into_iter()
        .flatten()
        .flatten()
        .any(|other| {
            if other.path() == dir {
                return false;
            }
            let Some(state) = fs::read_to_string(other.path().join("state.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<State>(&text).ok())
            else {
                return false;
            };
            let here = !state.root.is_empty() && real(Path::new(&state.root)) == *root;
            let command = here
                && (state.seen_at >= since
                    || (state.open > 0 && now.saturating_sub(state.at) < COMMAND_LASTS_MS));
            let edit = state.edited.iter().any(|edited| {
                Path::new(&edited.path).starts_with(root)
                    && (edited.at >= since
                        || (edited.open && now.saturating_sub(edited.at) < EDIT_LASTS_MS))
            });
            command || edit
        })
}

/// Of the files a command may have changed, what its own text shows it
/// changed: the added lines the text spells out. A file all of whose added
/// lines it spells out is the command's as it is, with what was removed. A
/// file where it spells out fewer than half is left out: there the few are
/// more likely someone else's lines that happen to read the same.
///
/// A line is spelled out when it is a whole line of the command (a heredoc's,
/// or a script's given inline), or is long and stands somewhere in it. A
/// short line says nothing either way, and goes with the rest of its file:
/// `else:` or `}` is in any script, and in whatever a person saved meanwhile.
fn spelled_out(files: Vec<Value>, command: &str) -> Vec<Value> {
    let whole: std::collections::HashSet<&str> = command.lines().map(str::trim).collect();
    let says = |line: &str| {
        let text = line[1..].trim();
        let length = text.chars().count();
        (length >= TELLING && text.chars().any(char::is_alphanumeric))
            .then(|| whole.contains(text) || (length >= 2 * TELLING && command.contains(text)))
    };
    files
        .into_iter()
        .filter_map(|mut file| {
            let lines: Vec<&str> = file["lines"]
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .collect();
            let added = || lines.iter().filter(|line| line.starts_with('+'));
            let told: Vec<bool> = added().filter_map(|line| says(line)).collect();
            let spelled = told.iter().filter(|told| **told).count();
            if spelled == 0 || spelled * 2 < told.len() {
                return None;
            }
            if told.contains(&false) {
                let sure: Vec<&str> = added()
                    .filter(|line| says(line) == Some(true))
                    .copied()
                    .collect();
                file["lines"] = json!(sure);
            }
            Some(file)
        })
        .collect()
}

/// A path as the file system knows it, as far as it exists yet, so that two
/// ways of naming one file (through a link, say) compare equal.
fn place(path: &Path) -> PathBuf {
    for known in path.ancestors().skip(1) {
        if let (Ok(real), Ok(rest)) = (fs::canonicalize(known), path.strip_prefix(known)) {
            return real.join(rest);
        }
    }
    path.to_path_buf()
}

/// One event at `now` (in milliseconds), which was `began`, with `dir` to
/// keep what is remembered.
fn step(dir: &Path, event: Event, now: u64, began: Instant) -> Option<Value> {
    crate::paths::create_private_dir(dir).ok()?;
    // Hooks run in parallel: one at a time looks at the tree.
    let lock = File::create(dir.join("lock")).ok()?;
    let deadline = Instant::now() + LOCK_WAIT;
    while lock.try_lock().is_err() {
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(2));
    }

    let state_path = dir.join("state.json");
    let mut state: State = fs::read_to_string(&state_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let said = match event {
        Event::Edit { path, ended } => {
            let path = place(&path).to_string_lossy().into_owned();
            state.edited.retain(|edited| edited.path != path);
            state.edited.push(Edited {
                path,
                at: now,
                open: !ended,
            });
            None
        }
        Event::Shell {
            root,
            ended,
            command,
            sure,
        } => {
            let sure = sure.then_some(command);
            shell(dir, &mut state, root, ended, sure, now, began)
        }
    };
    if let Ok(text) = serde_json::to_string(&state) {
        let _ = fs::write(&state_path, text);
    }
    said
}

/// A shell command's start or end: look at the working tree, and at its end
/// answer what changed since the last look. With `sure`, the command's text,
/// only what is sure to be the command's.
fn shell(
    dir: &Path,
    state: &mut State,
    root: &Path,
    ended: bool,
    sure: Option<&str>,
    now: u64,
    began: Instant,
) -> Option<Value> {
    let root_text = root.to_string_lossy();
    if state.too_slow.iter().any(|slow| *slow == root_text) {
        return None;
    }
    if state.root != root_text {
        // Another repository than last time: start over there. Each has an
        // index of its own, so coming back to one is not a first look again.
        *state = State {
            root: root_text.into_owned(),
            edited: std::mem::take(&mut state.edited),
            too_slow: std::mem::take(&mut state.too_slow),
            ..State::default()
        };
    }
    let git = Git {
        root,
        dir,
        deadline: Instant::now() + BUDGET,
    };
    let before = state.tree.take();
    let head_before = state.head.take();
    let seen_before = state.seen_at;
    let mut said = None;
    match git.snapshot() {
        Ok((tree, head)) => {
            // Only what changed while a shell command ran is the command's:
            // without its start having been seen, the last look may be from
            // before an edit a file tool made.
            if let Some(from) = before.filter(|from| ended && state.open > 0 && *from != tree) {
                let moved = head_before != head;
                let since = state.at / 1000;
                said = Some(
                    if moved && !git.made_since(head_before.as_deref(), head.as_deref(), since) {
                        json!({ "changes_skipped": "the commit checked out changed" })
                    } else {
                        match git.diff(&from, &tree) {
                            Ok(mut files) => {
                                // A file tool at work since the last look
                                // reports what it changed itself.
                                files.retain(|file| {
                                    let path =
                                        place(Path::new(file["path"].as_str().unwrap_or("")));
                                    !state.edited.iter().any(|edited| {
                                        Path::new(&edited.path) == path
                                            && (edited.at >= seen_before
                                                || (edited.open
                                                    && now.saturating_sub(edited.at)
                                                        < EDIT_LASTS_MS))
                                    })
                                });
                                // Where others work too, a command that took
                                // a while, or ran beside another session,
                                // changed for sure only what its text says.
                                if let Some(command) = sure {
                                    // From when the look before began to
                                    // the end of this one: a file saved
                                    // while either was under way is in it.
                                    let took = now.saturating_sub(seen_before)
                                        + began.elapsed().as_millis() as u64;
                                    let alone = took <= QUICK_MS
                                        && !others_at_work(dir, root, seen_before, now);
                                    if !alone {
                                        files = spelled_out(files, command);
                                    }
                                }
                                if files.is_empty() {
                                    Value::Null
                                } else {
                                    json!({ "changes": files })
                                }
                            }
                            Err(Stop::TooLarge) => json!({ "changes_skipped": "too large" }),
                            Err(_) => json!({ "changes_skipped": "could not be compared" }),
                        }
                    },
                );
            }
            state.tree = Some(tree);
            state.head = head;
            state.seen_at = now;
            if ended {
                state.open = state.open.saturating_sub(1);
            } else {
                state.open += 1;
                state.at = now;
            }
        }
        Err(stop) => {
            state.open = 0;
            if stop == Stop::TimedOut {
                state.too_slow.push(state.root.clone());
            }
            if ended {
                said = Some(json!({ "changes_skipped": "the working tree could not be read" }));
            }
        }
    }
    // File tools heard of long ago no longer matter.
    state
        .edited
        .retain(|edited| now.saturating_sub(edited.at) < 10 * EDIT_LASTS_MS);
    said.filter(|said| !said.is_null())
}

/// Git, run in a repository with an index and an object directory of our own.
struct Git<'a> {
    root: &'a Path,
    /// Where the index and the objects are kept.
    dir: &'a Path,
    /// When to stop waiting for git.
    deadline: Instant,
}

impl Git<'_> {
    /// Run git and return what it printed, as far as it fits, and whether it
    /// all fit. `private` reads and writes our index and objects instead of
    /// the repository's.
    fn run(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        private: Option<&Path>,
    ) -> Result<(Vec<u8>, bool), Stop> {
        let mut command = crate::git::command(self.root);
        command.args(args);
        if let Some(objects) = private {
            command
                .env("GIT_INDEX_FILE", self.index())
                .env("GIT_OBJECT_DIRECTORY", self.dir.join("objects"))
                .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", objects);
        }
        crate::git::bounded(command, input, MAX_PATCH_BYTES, self.deadline)
    }

    /// Our index for this repository. A session that works in two (a
    /// worktree beside the checkout it began in) has one for each.
    fn index(&self) -> PathBuf {
        // FNV-1a over the root: a name that stays the same from run to run.
        let name = self
            .root
            .as_os_str()
            .as_encoded_bytes()
            .iter()
            .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
                (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
            });
        self.dir.join(format!("index-{name:016x}"))
    }

    fn text(&self, args: &[&str], private: Option<&Path>) -> Result<String, Stop> {
        let (out, _) = self.run(args, None, private)?;
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    }

    /// The working tree as it is now, as a git tree, and the commit checked
    /// out. Files git ignores are left out; files not yet added are in.
    fn snapshot(&self) -> Result<(String, Option<String>), Stop> {
        let paths = self.text(
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "index",
                "--git-path",
                "objects",
            ],
            None,
        )?;
        let (index, objects) = paths.split_once('\n').ok_or(Stop::Failed)?;
        let objects = Path::new(objects.trim());
        fs::create_dir_all(self.dir.join("objects")).map_err(|_| Stop::Failed)?;
        // Our index starts as a copy of the repository's, so git knows which
        // files it has already read. From then on it is the last tree seen.
        let ours = self.index();
        if !ours.exists() && Path::new(index).is_file() {
            fs::copy(index, &ours).map_err(|_| Stop::Failed)?;
        }
        let private = Some(objects);
        self.run(&["add", "--update", "--ignore-errors"], None, private)?;
        let (others, _) = self.run(
            &["ls-files", "--others", "--exclude-standard", "-z"],
            None,
            private,
        )?;
        let mut new: Vec<u8> = Vec::new();
        others
            .split(|byte| *byte == 0)
            .filter_map(|name| std::str::from_utf8(name).ok())
            // A name ending in a slash is another repository inside this one.
            .filter(|name| !name.is_empty() && !name.ends_with('/'))
            .filter(|name| {
                fs::symlink_metadata(self.root.join(name))
                    .is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_NEW_FILE_BYTES)
            })
            .take(MAX_NEW_FILES)
            .for_each(|name| {
                new.extend_from_slice(name.as_bytes());
                new.push(0);
            });
        if !new.is_empty() {
            self.run(
                &["update-index", "--add", "-z", "--stdin"],
                Some(&new),
                private,
            )?;
        }
        let tree = self.text(&["write-tree"], private)?;
        let head = self.text(&["rev-parse", "--verify", "--quiet", "HEAD"], None);
        Ok((tree, head.ok().filter(|head| !head.is_empty())))
    }

    /// Whether the commits that took HEAD from `from` to `to` were all made
    /// at or after `since` (in seconds): the command committed its own work.
    /// Anything else moved HEAD to work that was already there.
    fn made_since(&self, from: Option<&str>, to: Option<&str>, since: u64) -> bool {
        let Some(to) = to else { return false };
        if let Some(from) = from {
            if self
                .run(&["merge-base", "--is-ancestor", from, to], None, None)
                .is_err()
            {
                return false;
            }
        }
        let range = from.map_or(to.to_string(), |from| format!("{from}..{to}"));
        let Ok(listed) = self.text(
            &["rev-list", "--max-count=500", "--format=%ct", &range],
            None,
        ) else {
            return false;
        };
        let times: Vec<u64> = listed.lines().filter_map(|l| l.parse().ok()).collect();
        // A clock read a moment apart on each side may differ by a second.
        times.len() < 500 && times.iter().all(|at| at + 2 >= since)
    }

    /// What differs between two trees: one entry per file, with its patch lines.
    fn diff(&self, from: &str, to: &str) -> Result<Vec<Value>, Stop> {
        let objects = self.text(
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "objects",
            ],
            None,
        )?;
        let private = Some(Path::new(&objects));
        let compare = ["diff-tree", "-r", "-M", "--no-ext-diff", "--no-textconv"];
        let (names, fits) = self.run(
            &[&compare[..], &["-z", "--name-status", from, to]].concat(),
            None,
            private,
        )?;
        if !fits {
            return Err(Stop::TooLarge);
        }
        let (patch, fits) = self.run(
            &[&compare[..], &["-p", "-U0", "--no-color", from, to]].concat(),
            None,
            private,
        )?;
        if !fits {
            return Err(Stop::TooLarge);
        }
        let mut lines = patch_lines(&String::from_utf8_lossy(&patch)).into_iter();
        let files = name_status(&names);
        // Both list the files in the same order. Should they ever not agree,
        // the files are still known, without their lines.
        let agree = lines.len() == files.len();
        Ok(files
            .into_iter()
            .map(|(status, path)| {
                let lines = lines.next().filter(|_| agree).unwrap_or_default();
                json!({
                    "path": self.root.join(path).to_string_lossy(),
                    "status": status,
                    "lines": lines,
                })
            })
            .collect())
    }
}

/// The files of `git diff-tree -z --name-status`: a status letter and the
/// path. A renamed file is listed under its new name.
fn name_status(out: &[u8]) -> Vec<(String, String)> {
    let mut fields = out
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8_lossy(field).into_owned());
    let mut files = Vec::new();
    while let Some(status) = fields.next().filter(|status| !status.is_empty()) {
        let letter = status[..1].to_string();
        // A rename or a copy names two paths: where from, then where to.
        if matches!(letter.as_str(), "R" | "C") {
            fields.next();
        }
        let Some(path) = fields.next() else { break };
        files.push((letter, path));
    }
    files
}

/// The added and removed lines of each file in a patch, as `+line` and
/// `-line`, one list per file in the patch's order.
fn patch_lines(patch: &str) -> Vec<Vec<String>> {
    let mut files: Vec<Vec<String>> = Vec::new();
    let mut in_hunk = false;
    for line in patch.lines() {
        // Inside a hunk every line begins with `+`, `-`, a space or a
        // backslash, so these two can only be the patch's own.
        if line.starts_with("diff --git ") {
            files.push(Vec::new());
            in_hunk = false;
        } else if line.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk && (line.starts_with('+') || line.starts_with('-')) {
            if let Some(file) = files.last_mut() {
                file.push(line.to_string());
            }
        }
    }
    files
}

/// What the captures at `paths` say shell commands changed, by the id of the
/// command's call: `changes`, or `changes_skipped`. For an agent whose
/// sessions are built from its own files, which know the commands and not
/// what they changed. A capture that cannot be read says nothing.
pub fn seen_in<'a>(paths: impl Iterator<Item = &'a PathBuf>) -> HashMap<String, Value> {
    let mut seen = HashMap::new();
    for path in paths {
        let _ = crate::jsonl::for_each(path, |record| {
            let said: serde_json::Map<String, Value> = ["changes", "changes_skipped"]
                .into_iter()
                .filter(|key| !record[*key].is_null())
                .map(|key| (key.to_string(), record[key].clone()))
                .collect();
            if let (Some(id), false) = (record["payload"]["tool_use_id"].as_str(), said.is_empty())
            {
                seen.insert(id.to_string(), Value::Object(said));
            }
        });
    }
    seen
}

/// Put what captures saw shell commands change (`seen`, from `seen_in`) with
/// the same commands in `events` built from elsewhere. Only with a shell
/// command that ended, and that says nothing of its own.
pub fn add_seen(events: &mut [Value], seen: &HashMap<String, Value>) {
    if seen.is_empty() {
        return;
    }
    for event in events {
        let ended = matches!(
            event["hook"].as_str(),
            Some("PostToolUse" | "PostToolUseFailure")
        );
        let p = &event["payload"];
        let shell = p["tool_name"]
            .as_str()
            .is_some_and(|tool| SHELL_TOOLS.contains(&tool));
        if !ended || !shell || !event["changes"].is_null() {
            continue;
        }
        let Some(Value::Object(said)) = p["tool_use_id"].as_str().and_then(|id| seen.get(id))
        else {
            continue;
        };
        for (key, value) in said {
            event[key] = value.clone();
        }
    }
}

/// The files a shell command's event says it changed: path, whether the file
/// is new, and its patch lines.
pub fn of(record: &Value) -> impl Iterator<Item = (&str, bool, impl Iterator<Item = &str>)> {
    record["changes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| {
            let lines = file["lines"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str);
            Some((file["path"].as_str()?, file["status"] == "A", lines))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// One event at `now`, looked at in no time.
    fn step(dir: &Path, event: Event, now: u64) -> Option<Value> {
        super::step(dir, event, now, Instant::now())
    }

    struct Repo {
        _home: tempfile::TempDir,
        root: PathBuf,
        dir: PathBuf,
        /// The time, in milliseconds: each command begins later than the last.
        now: std::cell::Cell<u64>,
    }

    impl Repo {
        fn new() -> Repo {
            let home = tempfile::tempdir().unwrap();
            let root = home.path().join("repo");
            fs::create_dir_all(&root).unwrap();
            let repo = Repo {
                dir: home.path().join("snapshots/s1"),
                _home: home,
                root,
                now: std::cell::Cell::new(1_700_000_000_000),
            };
            repo.git(&["init", "--quiet", "--initial-branch", "main"]);
            repo.write(".gitignore", "target/\n");
            repo.write(
                "hello.py",
                "def greet(name):\n    return \"hello \" + name\n",
            );
            repo.write("old.txt", "one\ntwo\n");
            repo.commit("first");
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args([
                    "-c",
                    "user.name=Agent",
                    "-c",
                    "user.email=agent@example.com",
                ])
                .args(["-c", "commit.gpgsign=false"])
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success(), "git {args:?}: {out:?}");
            String::from_utf8_lossy(&out.stdout).into_owned()
        }

        /// Commit everything, at the time it is now.
        fn commit(&self, message: &str) {
            self.git(&["add", "--all"]);
            let date = format!("@{} +0000", self.now.get() / 1000);
            let out = Command::new("git")
                .arg("-C")
                .arg(&self.root)
                .args([
                    "-c",
                    "user.name=Agent",
                    "-c",
                    "user.email=agent@example.com",
                ])
                .args(["-c", "commit.gpgsign=false"])
                .args(["commit", "--quiet", "-m", message])
                .env("GIT_COMMITTER_DATE", &date)
                .env("GIT_AUTHOR_DATE", &date)
                .output()
                .unwrap();
            assert!(out.status.success(), "{out:?}");
        }

        fn write(&self, name: &str, content: &str) {
            let path = self.root.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        /// A shell command's start, then `during`, then what its end answers.
        fn command(&self, during: impl FnOnce()) -> Option<Value> {
            self.now.set(self.now.get() + 100_000);
            assert_eq!(self.shell(false), None);
            self.now.set(self.now.get() + 1000);
            during();
            self.now.set(self.now.get() + 1000);
            self.shell(true)
        }

        /// A shell command's start or end, now.
        fn shell(&self, ended: bool) -> Option<Value> {
            let root = &self.root;
            let event = Event::Shell {
                root,
                ended,
                command: "",
                sure: false,
            };
            step(&self.dir, event, self.now.get())
        }

        /// A shell command with this text that took `ms`, on a person's own
        /// machine: `during` is what happens to the files while it runs.
        fn sure(&self, command: &str, ms: u64, during: impl FnOnce()) -> Option<Value> {
            let event = |ended| Event::Shell {
                root: &self.root,
                ended,
                command,
                sure: true,
            };
            self.now.set(self.now.get() + 10_000);
            step(&self.dir, event(false), self.now.get());
            during();
            self.now.set(self.now.get() + ms);
            step(&self.dir, event(true), self.now.get())
        }

        /// A file tool's start or end on a file, now. It answers nothing.
        fn edit(&self, name: &str, ended: bool) {
            let path = self.root.join(name);
            let said = step(&self.dir, Event::Edit { path, ended }, self.now.get());
            assert_eq!(said, None);
        }

        /// The changed files as (name, status, lines).
        fn changes(&self, said: Option<Value>) -> Vec<(String, String, Vec<String>)> {
            let said = said.expect("nothing was said");
            let prefix = format!("{}/", self.root.display());
            said["changes"]
                .as_array()
                .unwrap_or_else(|| panic!("{said}"))
                .iter()
                .map(|file| {
                    let lines = file["lines"].as_array().unwrap().iter();
                    (
                        file["path"].as_str().unwrap().replace(&prefix, ""),
                        file["status"].as_str().unwrap().to_string(),
                        lines.map(|l| l.as_str().unwrap().to_string()).collect(),
                    )
                })
                .collect()
        }
    }

    fn file(name: &str, status: &str, lines: &[&str]) -> (String, String, Vec<String>) {
        (
            name.to_string(),
            status.to_string(),
            lines.iter().map(|l| l.to_string()).collect(),
        )
    }

    #[test]
    fn what_a_shell_command_changed_is_told_and_the_repository_is_left_alone() {
        let repo = Repo::new();
        let objects = || repo.git(&["count-objects", "-v"]);
        let (status, before) = (repo.git(&["status", "--porcelain"]), objects());
        let said = repo.command(|| {
            repo.write(
                "hello.py",
                "def greet(name):\n    \"\"\"Greet.\"\"\"\n    return \"hello \" + name\n",
            );
            repo.write("src/new.py", "print(1)\nprint(2)\n");
            repo.write("target/built.o", "not looked at\n");
            fs::remove_file(repo.root.join("old.txt")).unwrap();
        });
        assert_eq!(
            repo.changes(said),
            [
                file("hello.py", "M", &["+    \"\"\"Greet.\"\"\""]),
                file("old.txt", "D", &["-one", "-two"]),
                file("src/new.py", "A", &["+print(1)", "+print(2)"]),
            ]
        );
        // Nothing was staged and no object was written to the repository.
        assert_eq!(repo.git(&["status", "--porcelain"]).lines().count(), 3);
        assert_ne!(repo.git(&["status", "--porcelain"]), status);
        assert_eq!(objects(), before);
        assert!(repo.git(&["diff", "--cached", "--name-only"]).is_empty());

        // A command that changes nothing says nothing.
        assert_eq!(repo.command(|| {}), None);
    }

    #[test]
    fn only_what_changed_while_a_command_ran_is_the_commands() {
        let repo = Repo::new();
        assert_eq!(repo.command(|| {}), None);
        // A file tool's edit, between two commands: it reports itself.
        repo.write("hello.py", "edited by a file tool\n");
        let said = repo.command(|| repo.write("old.txt", "one\ntwo\nthree\n"));
        assert_eq!(repo.changes(said), [file("old.txt", "M", &["+three"])]);

        // An end whose start was not seen: nothing can be said of it.
        repo.write("hello.py", "edited again\n");
        assert_eq!(repo.shell(true), None);
        // The next command is seen whole again.
        let said = repo.command(|| repo.write("old.txt", "one\n"));
        assert_eq!(
            repo.changes(said),
            [file("old.txt", "M", &["-two", "-three"])]
        );
    }

    #[test]
    fn a_file_tools_edit_while_a_command_runs_is_not_the_commands() {
        let repo = Repo::new();
        // Side by side: a file tool writes one file, the command another.
        let said = repo.command(|| {
            repo.edit("hello.py", false);
            repo.write("hello.py", "written by a file tool\n");
            repo.edit("hello.py", true);
            repo.write("old.txt", "one\n");
        });
        assert_eq!(repo.changes(said), [file("old.txt", "M", &["-two"])]);
        // The tool began before the command and is still writing as it ends.
        repo.now.set(repo.now.get() + 5000);
        repo.edit("src/new.py", false);
        repo.now.set(repo.now.get() + 1000);
        assert_eq!(repo.shell(false), None);
        repo.write("src/new.py", "print(1)\n");
        repo.now.set(repo.now.get() + 1000);
        assert_eq!(repo.shell(true), None);
        repo.edit("src/new.py", true);

        // One after the other: the tool has finished, so what the command
        // then does to the same file is the command's.
        let said = repo.command(|| repo.write("hello.py", "written by a file tool\nand sed\n"));
        assert_eq!(repo.changes(said), [file("hello.py", "M", &["+and sed"])]);
    }

    #[test]
    fn a_commit_the_command_made_counts_and_one_it_moved_to_does_not() {
        let repo = Repo::new();
        // Edit and commit in one command.
        let said = repo.command(|| {
            repo.git(&["checkout", "--quiet", "-b", "work"]);
            repo.write("old.txt", "one\ntwo\nmine\n");
            repo.commit("mine");
        });
        assert_eq!(repo.changes(said), [file("old.txt", "M", &["+mine"])]);

        // Back to the branch it came from: those lines are not new work,
        // and nor are another branch's when it is checked out.
        let said = repo.command(|| {
            repo.git(&["checkout", "--quiet", "main"]);
        });
        assert_eq!(
            said,
            Some(json!({ "changes_skipped": "the commit checked out changed" }))
        );
        let said = repo.command(|| {
            repo.git(&["merge", "--quiet", "--ff-only", "work"]);
        });
        assert_eq!(
            said,
            Some(json!({ "changes_skipped": "the commit checked out changed" }))
        );

        // A rename is one file, with the lines that changed in it.
        let said = repo.command(|| {
            repo.git(&["mv", "hello.py", "greeting.py"]);
        });
        assert_eq!(repo.changes(said), [file("greeting.py", "R", &[])]);
    }

    #[test]
    fn reads_the_files_and_lines_of_a_comparison() {
        assert_eq!(
            name_status(b"M\0a b.txt\0R090\0old.rs\0new.rs\0A\0c.txt\0"),
            [
                ("M".to_string(), "a b.txt".to_string()),
                ("R".to_string(), "new.rs".to_string()),
                ("A".to_string(), "c.txt".to_string()),
            ]
        );
        let patch = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n\
                     -old\n+new\n+++ not a header\n\\ No newline at end of file\n\
                     diff --git a/bin b/bin\nBinary files a/bin and b/bin differ\n";
        assert_eq!(
            patch_lines(patch),
            [vec!["-old", "+new", "+++ not a header"], vec![]]
        );
    }

    #[test]
    fn only_shell_commands_in_a_repository_are_looked_at() {
        let repo = Repo::new();
        let data = repo.dir.parent().unwrap().parent().unwrap();
        let event = |hook: &str, tool: &str, cwd: &Path| {
            json!({ "hook": hook, "session_id": "s1",
                    "payload": { "tool_name": tool, "cwd": cwd } })
        };
        let observe = |data: &Path, record: &Value| super::observe(data, record, Where::Sandbox);
        assert_eq!(
            observe(data, &event("PreToolUse", "Edit", &repo.root)),
            None
        );
        assert_eq!(observe(data, &event("Stop", "Bash", &repo.root)), None);
        assert_eq!(
            observe(data, &event("PreToolUse", "Bash", Path::new("/"))),
            None
        );
        assert!(!repo.dir.exists());

        // A file tool's events are only noted.
        let mut write = event("PreToolUse", "Write", &repo.root);
        write["payload"]["tool_input"] = json!({ "file_path": "hello.py" });
        assert_eq!(observe(data, &write), None);
        let state = fs::read_to_string(repo.dir.join("state.json")).unwrap();
        assert!(
            state.contains("hello.py") && state.contains(r#""open":true"#),
            "{state}"
        );
        assert_eq!(
            fs::read_dir(&repo.dir).unwrap().count(),
            2,
            "a lock and what is noted"
        );

        // Cursor names the events and the tool its own way, and the folder too.
        let cursor = |hook: &str| {
            json!({ "hook": hook, "session_id": "s1",
                    "payload": { "tool_name": "Shell", "cwd": "", "workspace_roots": [repo.root] } })
        };
        assert_eq!(observe(data, &cursor("preToolUse")), None);
        repo.write("old.txt", "one\n");
        let said = observe(data, &cursor("postToolUseFailure"));
        assert_eq!(repo.changes(said), [file("old.txt", "M", &["-two"])]);
    }

    #[test]
    fn where_others_work_a_quick_command_alone_changed_all_that_changed() {
        let repo = Repo::new();
        // Nobody saves a file in half a second: whatever the command is.
        let said = repo.sure("sed -i s/two/2/ old.txt && rm hello.py", 500, || {
            repo.write("old.txt", "one\n2\n");
            fs::remove_file(repo.root.join("hello.py")).unwrap();
        });
        assert_eq!(
            repo.changes(said),
            [
                file(
                    "hello.py",
                    "D",
                    &["-def greet(name):", "-    return \"hello \" + name"]
                ),
                file("old.txt", "M", &["-two", "+2"]),
            ]
        );
    }

    #[test]
    fn where_others_work_a_long_command_changed_what_its_text_spells_out() {
        let repo = Repo::new();
        let command = "cat > new.py <<'EOF'\ndef one_more_time():\n    try:\n        \
                       return 'one more time'\n    else:\n        return result\n\nEOF\n\
                       python3 - <<'EOF'\ns = s.replace('two', 'three is what the script puts here')\n\
                       EOF\nmake test > /dev/null 2>&1";
        let said = repo.sure(command, 90_000, || {
            // A file the command writes out in full, and a line it puts in another.
            repo.write(
                "new.py",
                "def one_more_time():\n    try:\n        return 'one more time'\n\n",
            );
            // In that other file someone saved a line of their own meanwhile.
            repo.write(
                "old.txt",
                "one\nthree is what the script puts here\nmine, typed by hand\n",
            );
            // A file the command says nothing of.
            repo.write("hello.py", "def greet(name):\n    return \"hi \" + name\n");
            // Files someone saved with lines any script has, and with a few
            // characters that are somewhere in this one.
            repo.write("theirs.py", "try:\nelse:\n    return result\n1\nnull\n");
            // And one where a single line of many happens to read the same.
            repo.write(
                "also_theirs.py",
                "def one_more_time():\n    a line of their own\n    and another of their own\n",
            );
        });
        assert_eq!(
            repo.changes(said),
            [
                // All of it is in the command: the file is the command's as it is.
                file(
                    "new.py",
                    "A",
                    &[
                        "+def one_more_time():",
                        "+    try:",
                        "+        return 'one more time'",
                        "+"
                    ]
                ),
                // Only the line that is.
                file("old.txt", "M", &["+three is what the script puts here"]),
            ]
        );
        // Nothing the text spells out: nothing is said, and the next command starts from here.
        let said = repo.sure("make format", 90_000, || repo.write("old.txt", "one\n"));
        assert_eq!(said, None);
        let said = repo.sure("true", 500, || repo.write("old.txt", "one\nfour\n"));
        assert_eq!(repo.changes(said), [file("old.txt", "M", &["+four"])]);
    }

    #[test]
    fn where_others_work_a_command_beside_another_session_is_not_alone() {
        let repo = Repo::new();
        let other = repo.dir.with_file_name("s2");
        let beside = |name: &str| {
            let path = repo.root.join(name);
            step(
                &other,
                Event::Edit { path, ended: true },
                repo.now.get() + 100,
            );
        };
        // Another session's file tool was at work in the repository meanwhile.
        let said = repo.sure(
            "echo 'three, as the command itself says it' >> old.txt",
            500,
            || {
                beside("hello.py");
                repo.write(
                    "old.txt",
                    "one\ntwo\nthree, as the command itself says it\n",
                );
                repo.write("hello.py", "def greet(name):\n    return name\n");
            },
        );
        assert_eq!(
            repo.changes(said),
            [file(
                "old.txt",
                "M",
                &["+three, as the command itself says it"]
            )]
        );
        // What it did before this command began does not matter, nor what it does elsewhere.
        let said = repo.sure("make", 500, || {
            let path = repo.root.with_file_name("elsewhere/a.txt");
            step(
                &other,
                Event::Edit { path, ended: true },
                repo.now.get() + 100,
            );
            repo.write("old.txt", "one\n");
        });
        assert_eq!(
            repo.changes(said),
            [file(
                "old.txt",
                "M",
                &["-two", "-three, as the command itself says it"]
            )]
        );

        // The other session may know the repository by another name.
        #[cfg(unix)]
        {
            let link = repo.root.with_file_name("link");
            std::os::unix::fs::symlink(&repo.root, &link).unwrap();
            let third = repo.dir.with_file_name("s3");
            let said = repo.sure("make", 500, || {
                let event = Event::Shell {
                    root: &link,
                    ended: false,
                    command: "make",
                    sure: true,
                };
                step(&third, event, repo.now.get() + 100);
                repo.write("old.txt", "one\nfive\n");
            });
            assert_eq!(said, None);
        }
    }

    #[test]
    fn a_command_that_goes_somewhere_first_is_looked_at_there() {
        let cwd = Path::new("/work/app");
        let to = |command: &str| goes_to(command, cwd);
        assert_eq!(to("cd /tmp/tree && make"), Some("/tmp/tree".into()));
        assert_eq!(
            to("  cd packages/web; ls"),
            Some("/work/app/packages/web".into())
        );
        assert_eq!(
            to("cd \"/tmp/my tree\" && make"),
            Some("/tmp/my tree".into())
        );
        assert_eq!(to("cd '/tmp/tree'\nmake"), Some("/tmp/tree".into()));
        // Not first, not followed by anything, or only a shell knows where.
        for command in [
            "make && cd /tmp/tree",
            "cd /tmp/tree",
            "cd $ROOT/tree && make",
            "cd ~/tree && make",
            "cd /tmp/tree | cat",
            "cdx /tmp && ls",
            "cd",
        ] {
            assert_eq!(to(command), None, "{command}");
        }

        // A worktree of the repository, somewhere else: the command names it.
        let repo = Repo::new();
        let tree = repo.root.with_file_name("tree");
        repo.git(&[
            "worktree",
            "add",
            "--quiet",
            tree.to_str().unwrap(),
            "-b",
            "side",
        ]);
        let data = repo.dir.parent().unwrap().parent().unwrap();
        let command = format!("cd {} && echo two >> a.txt", tree.display());
        let event = |hook: &str| {
            json!({ "hook": hook, "session_id": "s1",
                    "payload": { "tool_name": "Bash", "cwd": repo.root, "tool_input": { "command": command } } })
        };
        let local = Where::Machine { sure: true };
        let tree = &fs::canonicalize(&tree).unwrap();
        assert_eq!(observe(data, &event("PreToolUse"), local), None);
        fs::write(tree.join("a.txt"), "two\n").unwrap();
        let said = observe(data, &event("PostToolUse"), local).expect("nothing was said");
        assert_eq!(said["changes"][0]["path"], json!(tree.join("a.txt")));
        assert_eq!(said["changes"][0]["lines"], json!(["+two"]));

        // Back in the repository it began in, by whatever way round: the
        // files are named as the session knows them.
        fs::create_dir_all(repo.root.join("sub/dir")).unwrap();
        let at = |hook: &str, cwd: &Path, command: &str| {
            let event = json!({ "hook": hook, "session_id": "s1",
                "payload": { "tool_name": "Bash", "cwd": cwd, "tool_input": { "command": command } } });
            observe(data, &event, local)
        };
        for (cwd, command) in [
            (repo.root.join("sub/dir"), "cd ../.. && make"),
            (repo.root.clone(), "cd sub/dir && make"),
            (repo.root.clone(), "cd sub/../sub && make"),
        ] {
            assert_eq!(at("PreToolUse", &cwd, command), None);
            let mut text = fs::read_to_string(repo.root.join("old.txt")).unwrap();
            text.push_str("more\n");
            repo.write("old.txt", &text);
            let said = at("PostToolUse", &cwd, command);
            assert_eq!(
                repo.changes(said),
                [file("old.txt", "M", &["+more"])],
                "{command}"
            );
        }
        // Going from one to the other and back is not a first look each time.
        let indexes = fs::read_dir(&repo.dir).unwrap().flatten();
        let indexes =
            indexes.filter(|file| file.file_name().to_string_lossy().starts_with("index-"));
        assert_eq!(indexes.count(), 2);

        // Another repository altogether is none of this session's work.
        let other = repo.root.with_file_name("other");
        fs::create_dir_all(&other).unwrap();
        let init = Command::new("git")
            .arg("-C")
            .arg(&other)
            .args(["init", "--quiet"])
            .output();
        assert!(init.unwrap().status.success());
        let command = format!("cd {} && make", other.display());
        assert_eq!(at("PreToolUse", &repo.root, &command), None);
        fs::write(other.join("b.txt"), "theirs\n").unwrap();
        repo.write("old.txt", "one\n");
        let said = at("PostToolUse", &repo.root, &command).expect("nothing was said");
        // It is looked at where the session is, as any command is.
        assert!(
            said["changes"][0]["path"]
                .as_str()
                .unwrap()
                .ends_with("repo/old.txt"),
            "{said}"
        );
        assert_eq!(said["changes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_repository_too_slow_to_look_at_is_left_alone_and_the_others_are_not() {
        let repo = Repo::new();
        let slow = repo.root.with_file_name("slow");
        let mut state = State {
            root: repo.root.to_string_lossy().into_owned(),
            too_slow: vec![slow.to_string_lossy().into_owned()],
            ..State::default()
        };
        let began = Instant::now();
        assert_eq!(
            shell(&repo.dir, &mut state, &slow, false, None, 1, began),
            None
        );
        // Nothing was looked at, and what is known of the other stays.
        assert_eq!(state.root, repo.root.to_string_lossy());
        fs::create_dir_all(&repo.dir).unwrap();
        assert_eq!(
            shell(&repo.dir, &mut state, &repo.root, false, None, 2, began),
            None
        );
        repo.write("old.txt", "one\n");
        let said = shell(&repo.dir, &mut state, &repo.root, true, None, 3, began);
        assert_eq!(repo.changes(said), [file("old.txt", "M", &["-two"])]);
        assert_eq!(state.too_slow.len(), 1);
    }

    #[test]
    fn a_codex_patch_while_a_command_runs_is_not_the_commands() {
        let repo = Repo::new();
        let data = repo.dir.parent().unwrap().parent().unwrap();
        let observe = |record: &Value| super::observe(data, record, Where::Sandbox);
        let event = |hook: &str, tool: &str, input: Value| {
            json!({ "hook": hook, "session_id": "s1",
                    "payload": { "tool_name": tool, "cwd": repo.root, "tool_input": input } })
        };
        let shell = |hook: &str| event(hook, "Bash", json!({ "command": "make" }));
        // The patch names its files itself, by where the session is or in full.
        let patch = format!(
            "*** Begin Patch\n*** Update File: hello.py\n@@\n-old\n+new\n\
             *** Add File: {}\n+made\n*** End Patch\n",
            repo.root.join("made.txt").display()
        );
        let patching = |hook: &str| event(hook, "apply_patch", json!({ "command": patch }));

        assert_eq!(observe(&shell("PreToolUse")), None);
        assert_eq!(observe(&patching("PreToolUse")), None);
        repo.write("hello.py", "def greet(name):\n    return name\n");
        repo.write("made.txt", "made\n");
        assert_eq!(observe(&patching("PostToolUse")), None);
        repo.write("old.txt", "one\n");
        let said = observe(&shell("PostToolUse"));
        // The patch's two files are the patch's: Codex's own files say so.
        assert_eq!(repo.changes(said), [file("old.txt", "M", &["-two"])]);

        assert_eq!(
            patched(
                "*** Update File: a.txt\n*** Move to: b/c.txt\n*** Delete File: /x/d.txt\n",
                None
            ),
            [PathBuf::from("/x/d.txt")]
        );
    }

    #[test]
    fn what_a_capture_saw_is_put_with_the_same_command_from_elsewhere() {
        let dir = tempfile::tempdir().unwrap();
        let capture = dir.path().join("capture.jsonl");
        let changes = json!([{ "path": "/repo/a.txt", "status": "M", "lines": ["+one"] }]);
        let lines = [
            json!({ "hook": "PreToolUse", "payload": { "tool_use_id": "c1", "tool_name": "Bash" } }),
            json!({ "hook": "PostToolUse", "payload": { "tool_use_id": "c1", "tool_name": "Bash" },
                    "changes": changes }),
            json!({ "hook": "PostToolUse", "payload": { "tool_use_id": "c2", "tool_name": "Bash" },
                    "changes_skipped": "too large" }),
            json!({ "hook": "PostToolUse", "payload": { "tool_use_id": "c3", "tool_name": "Bash" } }),
            json!({ "hook": "PostToolUse", "payload": { "tool_use_id": "c4", "tool_name": "Bash" },
                    "changes": changes }),
        ];
        let text: Vec<String> = lines.iter().map(Value::to_string).collect();
        fs::write(&capture, text.join("\n") + "\nnot json\n").unwrap();
        let missing = dir.path().join("none.jsonl");
        let seen = seen_in([&capture, &missing].into_iter());
        assert_eq!(seen.len(), 3);

        let ended = |id: &str, tool: &str| json!({ "hook": "PostToolUse", "payload": { "tool_use_id": id, "tool_name": tool } });
        let mut events = vec![
            json!({ "hook": "PreToolUse", "payload": { "tool_use_id": "c1", "tool_name": "Bash" } }),
            ended("c1", "Bash"),
            ended("c2", "Bash"),
            ended("c3", "Bash"),
            // A patch run through the shell is written down as an edit, with
            // its lines from the patch: the capture's are not added to them.
            ended("c4", "Edit"),
            ended("c9", "Bash"),
        ];
        add_seen(&mut events, &seen);
        assert_eq!(events[0].get("changes"), None);
        assert_eq!(events[1]["changes"], changes);
        assert_eq!(events[2]["changes_skipped"], "too large");
        for untouched in &events[3..] {
            assert_eq!(untouched.as_object().unwrap().len(), 2, "{untouched}");
        }
    }

    #[test]
    fn a_home_directory_kept_in_git_is_not_looked_at_on_a_persons_machine() {
        let Some(home) = crate::paths::home_dir() else {
            return;
        };
        // Only where the home directory really is one: nothing is made there.
        if !home.join(".git").exists() {
            assert_eq!(real(&home), real(&home.join(".")));
            return;
        }
        let data = tempfile::tempdir().unwrap();
        let event = json!({ "hook": "PreToolUse", "session_id": "s1",
            "payload": { "tool_name": "Bash", "cwd": home, "tool_input": { "command": "ls" } } });
        observe(data.path(), &event, Where::Machine { sure: true });
        assert!(!data.path().join("snapshots").exists());
    }
}
