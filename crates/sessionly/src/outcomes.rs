//! Outcomes: what later commits did to the lines an agent wrote in a session.
//!
//! The rewrite rate says how much of a session's work is still in the files.
//! This says why some of it went: a later commit removed or changed the
//! agent's lines, and its message says it reverts them, or that it is a fix,
//! or neither (rework). It is read from the repository's history with `git
//! log`, on this machine; only counts are uploaded.
//!
//! A commit **touches** a session when, after the session ended, it removes
//! at least `MIN_TOUCH_LINES` of the session's lines that no two other
//! sessions also wrote in that file (a modified line is removed and added),
//! and it is not one of the session's own commits: those that add its lines
//! where the history did not have them. Then it is:
//! - a **revert** when it says `This reverts commit <sha>` of one of the
//!   session's own commits, as a revert's message says it (not a squash
//!   merge's list of its branch's commits), or its subject begins with
//!   "revert" and it removes at least `REVERT_SHARE` of the session's lines
//!   still there, unless it reverts a revert (a revert of that is one again);
//! - a **fix** when its subject line has a fix word or a conventional `fix:`
//!   type. A fix that touches a session's lines is mostly a fix of something
//!   else that changed them along the way, so the figure is "changed by a
//!   fix", not "needed a fix"; a fix where at least `LIKELY_FIX` of the lines
//!   it removed were the session's is a **likely fix**;
//! - **rework** otherwise.
//!
//! Each session gets a count at 1, 7 and 30 days after it ended, kept for
//! good once taken. History stays, so an age reached before it was looked at
//! is counted later, and says it was late.
//!
//! Deliberate limits:
//! - The branch checked out and the remote's default branch are read, nothing
//!   else, and no further than a day past the longest age.
//! - Merge commits are not read, only what descends from what: a reverted
//!   merge counts only when the revert takes out most of the session's lines.
//! - A fix that only adds lines (a missing check next to the agent's code)
//!   removes none of them and is not counted.
//! - A line a commit removes and adds again, in that file or another, was
//!   moved, not changed: as for the rewrite rate, moved code counts as there.
//!   So a commit that removes a session's lines counts only when it could be
//!   read whole: not one over `MOST_LINES_SHOWN` (a vendored or moved tree),
//!   nor one whose patch is over `MAX_SHOWN_BYTES`. A reading with more than
//!   `MOST_SHOWN` such commits is read again for fewer sessions; for one
//!   alone, only its earliest are.
//! - A session's lines count from when a commit lands them in the history,
//!   and only in what descends from that commit: before it, or beside it (a
//!   branch from before it, the remote's branch without it), a line like them
//!   that a commit removes was someone else's. On a history without them, a
//!   commit lands them when it adds `LANDING_LINES` of them that few
//!   sessions wrote (all, for a session of fewer, as `LANDING_SHARE` of what
//!   it adds), with what commits of the session's time (from when it began
//!   to `SLACK` after it ended) added before it: two generic lines are not
//!   enough, nor lines like them that commits add over weeks. Where no
//!   commit read lands them so, one of its time lands them with less: two of
//!   its lines, half of them and `LANDING_SHARE` of what it adds, or all of
//!   them for a session of fewer. Lines a commit moves to another file are
//!   followed there, from when the session began, and are never more than
//!   the session wrote.
//! - Each commit counts against what its own history has of the lines: a fix
//!   on one branch and rework of the same lines on another both count, and a
//!   merge has what the two branches began from, with what each changed
//!   since. The same change made on both (a cherry-pick, or a backport
//!   whatever its subject) counts once; made again on one after it was
//!   undone there, it counts again.
//!
//! History is read in three steps that nothing in a commit can be mistaken
//! in: `rev-list` for the SHAs and times, `cat-file --batch` for the
//! messages (each with its size), `diff-tree --stdin` for the changes.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono::{DateTime, Utc};

use crate::git::Stop;
use crate::ledger::{Ledger, NotedRepo, OutcomeEvent, OutcomeRepo, OutcomeScan, OutcomeTarget};
use crate::rewrite::{line_hash, CHECKPOINTS};
use crate::session::{OutcomeBy, OutcomeCheckpoint};

/// A commit must remove at least this many of a session's lines to touch it:
/// one line is too often a generic one (`if (`, an import) that matched by chance.
pub const MIN_TOUCH_LINES: f64 = 2.0;

/// A commit whose subject begins with "revert" reverts a session when it
/// removes at least this share of the session's lines still there.
pub const REVERT_SHARE: f64 = 0.5;

/// A fix is a likely fix of the session when at least this share of the
/// lines it removed were the session's.
pub const LIKELY_FIX: f64 = 0.5;

/// A line written by this many sessions or more in the same file is common:
/// it does not make a touch on its own.
const COMMON_LINE: usize = 3;

/// A commit is one of a session's own when it adds at least this many of the
/// session's lines, or this share of the lines it adds to the session's files.
const LANDING_LINES: f64 = 3.0;
const LANDING_SHARE: f64 = 0.5;

/// The longest age counted, in seconds.
const LONGEST: i64 = 30 * 86_400;

/// Commit times are the committer's clock: look this much further back.
const SLACK: i64 = 86_400;

/// A history longer than this is not read on this sync.
const MAX_LOG_BYTES: usize = 64 * 1024 * 1024;
/// Nor commits read whole that are more than this, so many at a time.
#[cfg(not(test))]
const MAX_SHOWN_BYTES: usize = 64 * 1024 * 1024;
/// Less in tests, which make such commits.
#[cfg(test)]
const MAX_SHOWN_BYTES: usize = 1024 * 1024;
const SHOWN_AT_ONCE: usize = 250;

/// Commits read whole in one reading, to tell moved lines from changed ones;
/// more fail the reading.
const MOST_SHOWN: usize = 2000;

/// A commit that adds and removes more lines than this is not read whole,
/// and not counted: a vendored, generated or moved tree, not a change by hand.
const MOST_LINES_SHOWN: u64 = 100_000;

/// How long reading history may take: in all, and in each repository on a
/// sync, so that a slow one leaves time for the rest (readings for fewer
/// sessions, after one for more failed, have what is left of it); and
/// whether someone waits for it.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub all: Duration,
    pub repo: Duration,
    pub waited: bool,
}

/// A sync nobody waits for (`sessionly sync`, the automatic one), and one a
/// command waits for.
pub const PATIENT: Budget = Budget {
    all: Duration::from_secs(60),
    repo: Duration::from_secs(20),
    waited: false,
};
pub const WAITED_FOR: Budget = Budget {
    all: Duration::from_secs(10),
    repo: Duration::from_secs(10),
    waited: true,
};

/// A session's commits may be dated a little before it began: one made as
/// it started, a clock a little off.
const EARLY: i64 = 60;

/// A repository whose history could not be read is tried again after this
/// long, twice as long after each failure after that, up to `RETRY_AFTER << 7`.
const RETRY_AFTER: i64 = 3600;

/// Which refs were read: what is checked out, and the remote's default
/// branch when there is one.
pub const HEAD_AND_DEFAULT: &str = "head_and_default";
pub const HEAD_ONLY: &str = "head_only";

/// The words a commit's subject is read for. The defaults are those of
/// `action/test/outcome-signals.json`, which the GitHub Action reads too.
#[derive(Debug, Clone)]
pub struct Words {
    fix_words: HashSet<String>,
    fix_types: HashSet<String>,
}

pub const FIX_WORDS: &[&str] = &[
    "fix",
    "fixes",
    "fixed",
    "fixing",
    "bug",
    "bugs",
    "bugfix",
    "hotfix",
    "regression",
    "broken",
    "crash",
    "crashes",
    "crashed",
    "typo",
];
pub const FIX_TYPES: &[&str] = &["fix", "hotfix", "bugfix"];

impl Default for Words {
    fn default() -> Self {
        Words::new(None)
    }
}

impl Words {
    /// The default fix words, or `fix_words` instead of them. Of those, only
    /// the ones that are one word as a subject is read count; with none, the
    /// defaults do.
    pub fn new(fix_words: Option<&[String]>) -> Words {
        // A word as written, read as a subject's words are: split, then lowercased.
        let given: HashSet<String> = fix_words
            .unwrap_or_default()
            .iter()
            .map(|w| w.trim())
            .filter(|w| is_word(w))
            .map(str::to_lowercase)
            .collect();
        let fix_words = if given.is_empty() {
            FIX_WORDS.iter().map(|w| w.to_string()).collect()
        } else {
            given
        };
        Words {
            fix_words,
            fix_types: FIX_TYPES.iter().map(|w| w.to_string()).collect(),
        }
    }
}

/// Whether `text` is one word as a subject is read: letters and digits only.
pub fn is_word(text: &str) -> bool {
    !text.is_empty() && text.chars().all(char::is_alphanumeric)
}

/// A text's words: lowercased, split on everything that is not a letter or digit.
fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// A conventional commit subject (`fix(scope)!: rest`): its type and the rest.
fn conventional(subject: &str) -> Option<(String, &str)> {
    let (head, rest) = subject.split_once(':')?;
    let kind = head.strip_suffix('!').unwrap_or(head);
    let kind = match kind.split_once('(') {
        Some((kind, scope)) if scope.ends_with(')') => kind,
        Some(_) => return None,
        None => kind,
    };
    (!kind.is_empty() && kind.chars().all(|c| c.is_ascii_alphabetic()))
        .then(|| (kind.to_ascii_lowercase(), rest))
}

/// What a commit message says of itself: `fix_message`, `fix_conventional`,
/// `revert_subject`. Only the subject line is read.
pub fn signals(message: &str, words_of: &Words) -> Vec<&'static str> {
    let subject = message.lines().next().unwrap_or_default().trim();
    let mut found = Vec::new();
    if words(subject)
        .iter()
        .any(|w| words_of.fix_words.contains(w))
    {
        found.push("fix_message");
    }
    let conventional = conventional(subject);
    if conventional
        .as_ref()
        .is_some_and(|(kind, _)| words_of.fix_types.contains(kind))
    {
        found.push("fix_conventional");
    }
    // `Revert "…"`, `revert: …`, and `chore: revert …`.
    let reverting = match &conventional {
        Some((kind, rest)) => {
            kind == "revert" || words(rest).first().is_some_and(|w| w == "revert")
        }
        None => words(subject).first().is_some_and(|w| w == "revert"),
    };
    if reverting {
        found.push("revert_subject");
    }
    found
}

/// The commits a message says it reverts: each `This reverts commit <sha>`,
/// the words apart by any white space, the SHA 7 to 64 hex digits (SHA-1 or
/// SHA-256). Only in a revert's message, as git writes one: its subject
/// begins with "revert" or "reapply", or the body begins with that line. A
/// squash merge's message, which lists its branch's commits (a `Revert
/// "wip"` among them, with its line), says it reverts nothing.
pub fn reverts(message: &str) -> Vec<String> {
    let mut lines = message.lines();
    let subject = lines.next().unwrap_or_default();
    let tokens: Vec<&str> = match words(subject).first().map(String::as_str) {
        Some("revert" | "reapply") => message.split_whitespace().collect(),
        _ => {
            let first: Vec<&str> = lines
                .skip_while(|line| line.trim().is_empty())
                .take_while(|line| !line.trim().is_empty())
                .flat_map(str::split_whitespace)
                .collect();
            let begins = first.len() >= 3
                && ["this", "reverts", "commit"]
                    .iter()
                    .zip(&first)
                    .all(|(word, token)| token.eq_ignore_ascii_case(word));
            if !begins {
                return Vec::new();
            }
            first
        }
    };
    let mut found = Vec::new();
    for window in tokens.windows(4) {
        let [this, verb, commit, sha] = window else {
            continue;
        };
        if !this.eq_ignore_ascii_case("this")
            || !verb.eq_ignore_ascii_case("reverts")
            || !commit.eq_ignore_ascii_case("commit")
        {
            continue;
        }
        let sha = sha.trim_end_matches(['.', ',', ';', ':', ')']);
        if (7..=64).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit()) {
            found.push(sha.to_ascii_lowercase());
        }
    }
    found
}

/// One file of one commit: its lines removed and added, as hash counts.
#[derive(Debug, Default)]
struct FileDiff {
    added: HashMap<u64, u64>,
    removed: HashMap<u64, u64>,
}

#[derive(Debug)]
struct Commit {
    sha: String,
    at: i64,
    /// The commits it follows, as far as they were listed: what it
    /// descends from. A merge commit has more than one, and is not read.
    parents: Vec<String>,
    message: String,
    /// The files of the sessions it changed, or all of them when it was read
    /// whole; lines it moved are then in neither `removed` nor `added`.
    files: HashMap<String, FileDiff>,
    /// Tracked lines it removed in all its files, less those it moved, when
    /// it was read whole.
    removed_total: Option<f64>,
    /// Lines it moved from one file to another, when it was read whole.
    moves: Vec<Move>,
}

/// Git in `root`, for reading history: paths as they are, whatever the
/// environment says of pathspecs; no signature checked; nothing asked of
/// anyone (no prompt for a password, in a terminal or a window of its
/// own); and nothing fetched unless `lazy` (a partial clone, which has to).
fn history(root: &Path, lazy: bool) -> Command {
    let mut command = crate::git::command(root);
    command
        .args(["-c", "core.quotepath=off", "-c", "log.showSignature=false"])
        .arg("--literal-pathspecs")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS_REQUIRE", "never")
        .env("GCM_INTERACTIVE", "never");
    for name in [
        "GIT_GLOB_PATHSPECS",
        "GIT_NOGLOB_PATHSPECS",
        "GIT_ICASE_PATHSPECS",
        "GIT_LITERAL_PATHSPECS",
    ] {
        command.env_remove(name);
    }
    if !lazy {
        command.env("GIT_NO_LAZY_FETCH", "1");
    }
    command
}

/// Whether `git config --get-regexp` of `extensions.partialclone` and
/// `remote.*.promisor` says the repository is a partial clone: git before
/// 2.24 names the remote in the first, later git sets the second.
fn partial(config: &str) -> bool {
    config.lines().any(|line| {
        // A key with no value is true.
        let (key, value) = line.split_once(' ').unwrap_or((line, "true"));
        let value = value.trim();
        if key == "extensions.partialclone" {
            !value.is_empty()
        } else {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "true" | "yes" | "on" | "1"
            )
        }
    })
}

/// A full commit SHA as git prints one: SHA-1 or SHA-256, lowercase hex.
fn is_sha(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `rev-list --timestamp --parents`: each commit's SHA, time and parents.
fn parse_list(out: &[u8]) -> Vec<(String, i64, Vec<String>)> {
    String::from_utf8_lossy(out)
        .lines()
        .filter_map(|line| {
            let mut words = line.split(' ');
            let at = words.next()?.parse().ok()?;
            let sha = words.next().filter(|sha| is_sha(sha))?;
            let parents: Vec<String> = words.map(str::to_string).collect();
            parents.iter().all(|p| is_sha(p)).then_some(())?;
            Some((sha.to_string(), at, parents))
        })
        .collect()
}

/// `cat-file --batch`: each commit's message, by SHA. An object comes with
/// its size, so nothing in a message can be taken for the next one.
fn parse_batch(out: &[u8]) -> HashMap<String, String> {
    let mut messages = HashMap::new();
    let mut rest = out;
    while let Some(end) = rest.iter().position(|b| *b == b'\n') {
        let header = String::from_utf8_lossy(&rest[..end]).into_owned();
        rest = &rest[end + 1..];
        let mut words = header.split(' ');
        let (Some(sha), Some(kind), Some(size)) = (words.next(), words.next(), words.next()) else {
            // `<sha> missing`: no object follows.
            continue;
        };
        let Some(object) = size.parse::<usize>().ok().and_then(|n| rest.get(..n)) else {
            break;
        };
        rest = rest.get(object.len() + 1..).unwrap_or_default();
        if kind != "commit" || !is_sha(sha) {
            continue;
        }
        // The headers end at the first empty line; one may say the message
        // is not UTF-8.
        let (headers, body) = match object.windows(2).position(|w| w == b"\n\n") {
            Some(at) => (&object[..at], &object[at + 2..]),
            None => (object, &[][..]),
        };
        let latin1 = headers.split(|b| *b == b'\n').any(|line| {
            line.strip_prefix(b"encoding ").is_some_and(|name| {
                let name = String::from_utf8_lossy(name).to_ascii_lowercase();
                matches!(
                    name.trim(),
                    "iso-8859-1" | "iso8859-1" | "latin1" | "latin-1" | "l1"
                )
            })
        });
        let message = if latin1 {
            body.iter().map(|b| char::from(*b)).collect()
        } else {
            String::from_utf8_lossy(body).into_owned()
        };
        messages.insert(sha.to_string(), message.trim().to_string());
    }
    messages
}

/// `diff-tree --stdin --always` output, cut at each commit's SHA line: one
/// for every commit given, in the order given (a line of a patch always
/// begins with something else). Git leaves out one it cannot read and goes
/// on, and then what follows would be taken for another commit's: so none
/// of it is.
fn split_tree<'a>(text: &'a str, shas: &[&str]) -> Result<HashMap<String, &'a str>, Stop> {
    let mut parts = HashMap::new();
    let mut next = 0;
    let mut open: Option<(usize, usize)> = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches('\n');
        if is_sha(bare) {
            if shas.get(next) != Some(&bare) {
                return Err(Stop::Failed);
            }
            if let Some((i, start)) = open {
                parts.insert(shas[i].to_string(), &text[start..offset]);
            }
            open = Some((next, offset + line.len()));
            next += 1;
        }
        offset += line.len();
    }
    if let Some((i, start)) = open {
        parts.insert(shas[i].to_string(), &text[start..]);
    }
    if next < shas.len() {
        return Err(Stop::Failed);
    }
    Ok(parts)
}

/// A path in a patch header, without its `a/` or `b/`. Git ends one with a
/// space in it with a tab, and C-quotes one with a quote, a backslash or a
/// control character in it (`"a/x\"y"`).
fn header_path(rest: &str, prefix: &str) -> Option<String> {
    let rest = rest.strip_suffix('\t').unwrap_or(rest);
    if rest == "/dev/null" {
        return None;
    }
    let path = match rest.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
        Some(quoted) => unquote(quoted),
        None => rest.to_string(),
    };
    Some(
        path.strip_prefix(prefix)
            .map_or(path.clone(), str::to_string),
    )
}

/// Undo git's C quoting: `\\`, `\"`, `\t`, `\n`, … and octal bytes (`\303\251`).
fn unquote(text: &str) -> String {
    let mut bytes = Vec::new();
    let mut it = text.bytes().peekable();
    while let Some(b) = it.next() {
        if b != b'\\' {
            bytes.push(b);
            continue;
        }
        match it.next() {
            Some(b'n') => bytes.push(b'\n'),
            Some(b't') => bytes.push(b'\t'),
            Some(b'r') => bytes.push(b'\r'),
            Some(b'a') => bytes.push(7),
            Some(b'b') => bytes.push(8),
            Some(b'f') => bytes.push(12),
            Some(b'v') => bytes.push(11),
            Some(d @ b'0'..=b'7') => {
                let mut value = u32::from(d - b'0');
                for _ in 0..2 {
                    match it.peek() {
                        Some(&o @ b'0'..=b'7') => {
                            value = value * 8 + u32::from(o - b'0');
                            it.next();
                        }
                        _ => break,
                    }
                }
                bytes.push(value as u8);
            }
            Some(other) => bytes.push(other),
            None => bytes.push(b'\\'),
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// A diff's files with their removed and added lines. The file headers
/// (`---`/`+++`) come before a file's first hunk; after it, a line `---x` is
/// a removed `--x`.
fn parse_diff(diff: &str) -> HashMap<String, FileDiff> {
    let mut files: HashMap<String, FileDiff> = HashMap::new();
    let mut current: Option<String> = None;
    let mut header = false;
    let mut old: Option<String> = None;
    let path_of = |line: &str, prefix: &str| header_path(line.get(4..)?, prefix);
    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            header = true;
            current = None;
            old = None;
            continue;
        }
        if header {
            if line.starts_with("--- ") {
                old = path_of(line, "a/");
            } else if line.starts_with("+++ ") {
                current = path_of(line, "b/").or(old.take());
            } else if line.starts_with("@@") {
                header = false;
            }
            continue;
        }
        let Some(path) = &current else { continue };
        let (bag, text) = match line.as_bytes().first() {
            Some(b'+') => (true, &line[1..]),
            Some(b'-') => (false, &line[1..]),
            _ => continue,
        };
        let Some(hash) = line_hash(text) else {
            continue;
        };
        let file = files.entry(path.clone()).or_default();
        let counts = if bag {
            &mut file.added
        } else {
            &mut file.removed
        };
        *counts.entry(hash).or_insert(0) += 1;
    }
    files
}

/// What is done on one sync.
#[derive(Debug, Default, PartialEq)]
pub struct Report {
    /// Repositories whose history was read.
    pub scanned: u64,
    /// Repositories whose history could not be read now (too long, too slow).
    pub skipped: u64,
    /// Ages counted for good.
    pub kept: u64,
}

/// A session's files in one repository: paths relative to its top, and
/// the worktrees of it they are read in.
struct InRepo {
    target: usize,
    files: Vec<(String, Vec<u64>)>,
    roots: BTreeSet<PathBuf>,
}

/// One repository: the worktrees of it on this machine that sessions with
/// an age still to count wrote in, which share its history, and every
/// session with lines in it.
struct Repo {
    roots: BTreeSet<PathBuf>,
    sessions: Vec<InRepo>,
}

/// A worktree's repository is asked of git for no longer than this (nor
/// than a tenth of a sync's time): one that does not answer in it is not
/// asked again for `RETRY_AFTER`.
const ASKING: Duration = Duration::from_secs(2);

/// What a sync knows of a worktree's repository.
#[derive(Debug, Clone, PartialEq)]
enum Asked {
    /// Its common git directory; the worktree itself when git cannot say
    /// (read as a repository of its own, which git may not read either).
    Repo(PathBuf),
    /// Git did not answer in its time, now or lately: read later.
    NotNow,
    /// No time is left to ask in.
    OutOfTime,
}

/// Which repository each worktree is of: as noted on an earlier sync while
/// its `.git` still says so, or asked of git; and what this sync found, to
/// note.
struct Worktrees {
    noted: HashMap<String, NotedRepo>,
    found: Vec<(String, OutcomeRepo)>,
    known: HashMap<PathBuf, Asked>,
    /// This sync's time, in seconds.
    now: i64,
    /// How long git is asked for one.
    asking: Duration,
}

impl Worktrees {
    /// The repository of the worktree at `root`, which has a `.git`. Git
    /// is asked for `asking` at most, and not past `until`.
    fn of(&mut self, root: &Path, until: Instant) -> Asked {
        if let Some(known) = self.known.get(root) {
            return known.clone();
        }
        let name = root.to_string_lossy().into_owned();
        let noted = self.noted.get(&name);
        let asked = match (
            noted.and_then(|n| n.common_dir.as_deref()),
            noted.and_then(|n| n.failed),
        ) {
            // As noted, unless its `.git` names another repository now.
            (Some(dir), _)
                if Path::new(dir).is_dir()
                    && crate::git::named_common_dir(root)
                        .is_none_or(|named| named == Path::new(dir)) =>
            {
                Asked::Repo(PathBuf::from(dir))
            }
            (_, Some((at, timed_out))) if self.now - at.timestamp() < RETRY_AFTER => {
                if timed_out {
                    Asked::NotNow
                } else {
                    Asked::Repo(root.to_path_buf())
                }
            }
            _ => {
                let left = until.saturating_duration_since(Instant::now());
                let given = self.asking.min(left);
                if given.is_zero() {
                    return Asked::OutOfTime;
                }
                let at = DateTime::from_timestamp(self.now, 0).unwrap_or_default();
                match crate::git::common_dir(root, Instant::now() + given) {
                    Ok(dir) => {
                        let dir = dir.to_string_lossy().into_owned();
                        self.found.push((name, OutcomeRepo::Found(dir.clone())));
                        Asked::Repo(PathBuf::from(dir))
                    }
                    // Out of the sync's time, not of its own: asked again.
                    Err(Stop::TimedOut) if given < self.asking => return Asked::OutOfTime,
                    Err(Stop::TimedOut) => {
                        let timed_out = true;
                        self.found
                            .push((name, OutcomeRepo::Failed { at, timed_out }));
                        Asked::NotNow
                    }
                    Err(_) => {
                        let timed_out = false;
                        self.found
                            .push((name, OutcomeRepo::Failed { at, timed_out }));
                        Asked::Repo(root.to_path_buf())
                    }
                }
            }
        };
        self.known.insert(root.to_path_buf(), asked.clone());
        asked
    }
}

/// What reading a session's history in its repositories found: how many
/// were read, and while none failed, the events and which refs were read.
type Read = (usize, Option<(Vec<OutcomeEvent>, &'static str)>);

/// What a reading of one repository found.
type Found = Result<(Vec<OutcomeEvent>, &'static str), Stop>;

/// Where the files in `dir` are read: in the nearest directory above it
/// with a `.git`, with the paths from there; or, in a worktree Claude Code
/// made in the repository, removed since, in the repository, with the paths
/// as they were in the worktree. None in no repository, or when `dir` is
/// not there now: what is there now says nothing of what was written in it.
fn read_in(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let root = crate::git::repo_root(dir)?;
    match claude_worktree(dir) {
        Some((top, of)) if of == root => Some((top, of)),
        _ => dir.exists().then(|| (root.clone(), root)),
    }
}

/// The worktree `<root>/.claude/worktrees/<name>` that `dir` is in, as
/// Claude Code makes them, when it has no `.git` now (removed, merged) and
/// `<root>` has: where its paths start, and the repository it was of. What
/// was written in it is read in `<root>`, with the paths as they were in it.
fn claude_worktree(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    dir.ancestors().find_map(|top| {
        let worktrees = top.parent()?;
        let claude = worktrees.parent()?;
        let root = claude.parent()?;
        (worktrees.file_name()? == "worktrees"
            && claude.file_name()? == ".claude"
            && !top.join(".git").exists()
            && root.join(".git").exists())
        .then(|| (top.to_path_buf(), root.to_path_buf()))
    })
}

/// `path` with `.` and `..` taken out as they are written, links not
/// followed: a path into a repository and out of it again
/// (`repo/../notes.md`) is not in it.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            other => out.push(other),
        }
    }
    out
}

/// Count what later commits did to each session's lines, for every session
/// with an age (1, 7 or 30 days after it ended) reached and not yet counted.
/// History is read only when such an age needs it, so most syncs read none,
/// and for no longer than `budget` allows.
pub fn measure(
    ledger: &mut Ledger,
    words_of: &Words,
    now: DateTime<Utc>,
    budget: Budget,
) -> Result<Report> {
    let started = Instant::now();
    let deadline = started + budget.all;
    let mut report = Report::default();
    let mut targets = ledger.outcome_targets(false)?;
    let now_s = now.timestamp();
    let due = |t: &OutcomeTarget| -> Vec<(&'static str, i64)> {
        CHECKPOINTS
            .iter()
            .filter(|(name, seconds)| {
                t.ended_at.timestamp() + seconds <= now_s && !t.kept.iter().any(|k| k == name)
            })
            .copied()
            .collect()
    };
    let reached = |t: &OutcomeTarget, seconds: i64| {
        t.scanned_until
            .is_some_and(|u| u.timestamp() >= t.ended_at.timestamp() + seconds)
    };
    // Which sessions need their history read: an age is due that their last
    // reading did not reach, and they were not tried too recently.
    let needs_scan = |t: &OutcomeTarget| {
        let wait = RETRY_AFTER << t.failures.saturating_sub(1).min(7);
        due(t).iter().any(|(_, seconds)| !reached(t, *seconds))
            && t.tried_at
                .is_none_or(|tried| now_s - tried.timestamp() >= wait)
    };
    let ready = |t: &OutcomeTarget| due(t).iter().any(|(_, seconds)| reached(t, *seconds));

    // A session with an age still to count: what it wrote matters to a
    // reading, as do the worktrees it wrote in.
    let counting = |t: &OutcomeTarget| {
        CHECKPOINTS
            .iter()
            .any(|(name, _)| !t.kept.iter().any(|k| k == name))
    };

    // The repository of each worktree such a session ran or wrote in, noted
    // while it is there: one removed since is read from the repository's
    // own directory. Git is asked in a small part of the sync's time, and
    // what is left is asked on the next.
    let mut worktrees = Worktrees {
        noted: ledger.outcome_repos()?,
        found: Vec::new(),
        known: HashMap::new(),
        now: now_s,
        asking: ASKING.min(budget.all / 10),
    };
    let live: HashSet<&str> = targets
        .iter()
        .filter(|t| counting(t))
        .map(|t| t.session_id.as_str())
        .collect();
    let mut root_of: HashMap<PathBuf, Option<(PathBuf, PathBuf)>> = HashMap::new();
    let mut roots: BTreeSet<PathBuf> = targets
        .iter()
        .filter(|t| counting(t))
        .filter_map(|t| t.repo.as_ref().map(PathBuf::from))
        .collect();
    for (id, base, path) in ledger.outcome_paths()? {
        if !live.contains(id.as_str()) {
            continue;
        }
        let path = lexical(&match base {
            Some(base) => Path::new(&base).join(path),
            None => PathBuf::from(path),
        });
        let Some(dir) = path.parent() else { continue };
        let found = root_of
            .entry(dir.to_path_buf())
            .or_insert_with(|| read_in(dir));
        roots.extend(found.as_ref().map(|(_, root)| root.clone()));
    }
    let finding = (started + worktrees.asking * 2).min(deadline);
    for root in roots {
        if root.join(".git").exists() && worktrees.of(&root, finding) == Asked::OutOfTime {
            break;
        }
    }

    if !targets.iter().any(|t| needs_scan(t) || ready(t)) {
        ledger.keep_outcome_repos(&worktrees.found)?;
        return Ok(report);
    }
    ledger.outcome_files(&mut targets)?;

    // Each file in the repository it is in: an agent may write in a sibling
    // worktree, or outside any repository. Worktrees of one repository are
    // one history, read once.
    let mut repos: BTreeMap<PathBuf, Repo> = BTreeMap::new();
    // A worktree's repository, as far as this sync knows.
    let mut repo_of: HashMap<PathBuf, Asked> = HashMap::new();
    // Sessions whose repository, the one they ran in, is not there now
    // (unmounted, moved): read later, rather than counted without it.
    let mut unavailable: HashSet<usize> = HashSet::new();
    // Sessions whose repositories were not all found in this sync's time:
    // read on another.
    let mut deferred: HashSet<usize> = HashSet::new();
    // Each session's lines in the repositories read.
    let mut tracked: HashMap<usize, u64> = HashMap::new();
    // Worktrees removed since (merged, done with), or whose own directory in
    // the repository is gone (pruned), of a repository still here: what was
    // written in one is read from the repository's own directory, which has
    // what its main worktree has checked out, with the paths as they were in
    // that worktree.
    let removed: HashMap<PathBuf, PathBuf> = worktrees
        .noted
        .iter()
        .filter_map(|(root, noted)| {
            let (root, common) = (
                PathBuf::from(root),
                PathBuf::from(noted.common_dir.as_ref()?),
            );
            let gone = !root.join(".git").exists() || crate::git::named_common_dir(&root).is_none();
            (gone && common.is_dir()).then_some((root, common))
        })
        .collect();
    // Per repository: the worktrees, and the lines by file.
    type Placed = (BTreeSet<PathBuf>, BTreeMap<String, Vec<u64>>);
    // Where a session's files are read, by repository (of those in `only`,
    // when given); none when one could not be found in this sync's time,
    // for a session to read. One only read beside them (`only`) is placed
    // without that file: what it has in the others says whose their lines
    // are, and which agent made a commit.
    let mut place = |target: &OutcomeTarget,
                     only: Option<&HashSet<PathBuf>>|
     -> Option<BTreeMap<PathBuf, Placed>> {
        let mut by_repo: BTreeMap<PathBuf, Placed> = BTreeMap::new();
        for (path, hashes) in &target.files {
            let path = lexical(&match &target.base {
                Some(base) => Path::new(base).join(path),
                None => PathBuf::from(path),
            });
            // Where its path starts, where it is read, and which repository it is.
            let gone = path.ancestors().find_map(|at| removed.get_key_value(at));
            let (top, root, repo) = match gone {
                Some((gone, common)) => (gone.clone(), common.clone(), common.clone()),
                None => {
                    let Some(dir) = path.parent() else { continue };
                    let found = root_of
                        .entry(dir.to_path_buf())
                        .or_insert_with(|| read_in(dir))
                        .clone();
                    let Some((top, root)) = found else { continue };
                    let asked = repo_of.entry(root.clone()).or_insert_with(|| {
                        // Git is not asked of one in a repository nothing is read in.
                        let named = only.and_then(|only| {
                            crate::git::named_common_dir(&root).filter(|n| !only.contains(n))
                        });
                        match named {
                            Some(named) => Asked::Repo(named),
                            None => worktrees.of(&root, deadline),
                        }
                    });
                    let Asked::Repo(repo) = asked else {
                        if only.is_some() {
                            continue;
                        }
                        return None;
                    };
                    (top, root, repo.clone())
                }
            };
            if only.is_some_and(|only| !only.contains(&repo)) {
                continue;
            }
            let Ok(relative) = path.strip_prefix(&top) else {
                continue;
            };
            let relative = relative.to_string_lossy().into_owned();
            if relative.is_empty() {
                continue;
            }
            let (roots, files) = by_repo.entry(repo).or_default();
            roots.insert(root);
            // The same file written in two worktrees: as many of a line as either has.
            let kept = files.entry(relative).or_default();
            *kept = if kept.is_empty() {
                hashes.clone()
            } else {
                most_of(kept, hashes)
            };
        }
        Some(by_repo)
    };
    // The sessions to read first, then the others in the repositories they
    // are in: no repository is made up for nothing to read in it.
    let mut placed: BTreeMap<usize, BTreeMap<PathBuf, Placed>> = BTreeMap::new();
    let mut due_repos: HashSet<PathBuf> = HashSet::new();
    let mut late = false;
    for scanning in [true, false] {
        for (index, target) in targets.iter().enumerate() {
            if needs_scan(target) != scanning || late {
                continue;
            }
            if target.repo.as_ref().is_some_and(|repo| {
                let repo = Path::new(repo);
                !repo.join(".git").exists()
                    && !removed.contains_key(repo)
                    && claude_worktree(repo).is_none()
            }) {
                unavailable.insert(index);
                continue;
            }
            if Instant::now() >= deadline {
                late = true;
                break;
            }
            match place(target, (!scanning).then_some(&due_repos)) {
                Some(by_repo) if scanning => {
                    due_repos.extend(by_repo.keys().cloned());
                    placed.insert(index, by_repo);
                }
                Some(by_repo) => {
                    placed.insert(index, by_repo);
                }
                None => {
                    deferred.insert(index);
                }
            }
        }
    }
    // Out of time before every session was placed: what is read is read
    // with all the lines in it, on another sync.
    if late {
        deferred.extend(0..targets.len());
    }
    for (index, by_repo) in placed {
        let mut lines = 0;
        for (repo, (roots, files)) in by_repo {
            let entry = repos.entry(repo).or_insert_with(|| Repo {
                roots: BTreeSet::new(),
                sessions: Vec::new(),
            });
            // What each worktree a session still counted wrote in has checked out is read.
            if counting(&targets[index]) {
                entry.roots.extend(roots.iter().cloned());
            }
            lines += files.values().map(|h| h.len() as u64).sum::<u64>();
            entry.sessions.push(InRepo {
                target: index,
                files: files.into_iter().collect(),
                roots: roots.into_iter().collect(),
            });
        }
        tracked.insert(index, lines);
    }
    ledger.keep_outcome_repos(&worktrees.found)?;

    // A session's history is read once every repository it is in was: what
    // one of them said is kept only with what the others said.
    let mut in_repos: HashMap<usize, usize> = HashMap::new();
    for repo in repos.values() {
        for s in &repo.sessions {
            *in_repos.entry(s.target).or_default() += 1;
        }
    }
    let mut read: HashMap<usize, Read> = HashMap::new();
    // The repository tried least recently first, so that a slow one cannot
    // keep the rest from being read.
    let mut order: Vec<&Repo> = repos.values().collect();
    order.sort_by_key(|repo| {
        repo.sessions
            .iter()
            .filter_map(|s| targets[s.target].tried_at)
            .max()
    });
    // Time enough to tell that a repository is too slow: half what one may have.
    let enough = budget.repo.min(budget.all) / 2;
    'repos: for repo in order {
        let mut scanning: Vec<usize> = (0..repo.sessions.len())
            .filter(|k| {
                let t = repo.sessions[*k].target;
                needs_scan(&targets[t]) && !deferred.contains(&t)
            })
            .collect();
        if scanning.is_empty() {
            continue;
        }
        // One that failed before is left to a sync nobody waits for.
        if budget.waited
            && scanning
                .iter()
                .any(|k| targets[repo.sessions[*k].target].failures > 0)
        {
            continue;
        }
        let given = budget
            .repo
            .min(deadline.saturating_duration_since(Instant::now()));
        if given.is_zero() {
            break;
        }
        let until = Instant::now() + given;
        // Newest first: a reading too big for them all is read in halves,
        // down to one session, so that the newest are read first.
        scanning.sort_by_key(|k| std::cmp::Reverse(targets[repo.sessions[*k].target].ended_at));
        let mut groups = std::collections::VecDeque::from([scanning]);
        // A reading of more failed here on this sync, in the repository's time.
        let mut split = false;
        while let Some(group) = groups.pop_front() {
            let scanning: Vec<&InRepo> = group.iter().map(|k| &repo.sessions[*k]).collect();
            let found = if Instant::now() < until {
                scan(
                    &repo.roots,
                    &repo.sessions,
                    &scanning,
                    &targets,
                    words_of,
                    until,
                )
            } else {
                Err(Stop::TimedOut)
            };
            match &found {
                // Too big, or failing, for them all: one session's paths may
                // be past what git takes, or not paths it can read.
                Err(Stop::TooLarge | Stop::Failed) if group.len() > 1 => {
                    let (newer, older) = group.split_at(group.len() / 2);
                    groups.push_front(older.to_vec());
                    groups.push_front(newer.to_vec());
                    split = true;
                    continue;
                }
                // Out of this sync's time, not of the repository's: read on
                // another, which is tried longest ago first.
                Err(Stop::TimedOut) if given < enough => break 'repos,
                // Out of what a reading of more that failed left: not too
                // slow. This one is read on the next sync, and those after it
                // wait to be tried again, so that it is read with less.
                Err(Stop::TimedOut) if split => {
                    report.skipped += 1;
                    let rest: Vec<usize> = groups.iter().flatten().copied().collect();
                    note(&mut read, &repo.sessions, &rest, &found, &targets);
                    break;
                }
                Err(Stop::TimedOut) => {
                    // Too slow. A command gives up on them all, for a sync
                    // nobody waits for to read; that one on the older half,
                    // and reads the newer on its next sync, down to one.
                    report.skipped += 1;
                    let slow = if budget.waited || group.len() == 1 {
                        &group[..]
                    } else {
                        &group[group.len() / 2..]
                    };
                    note(&mut read, &repo.sessions, slow, &found, &targets);
                    break;
                }
                Ok(_) => report.scanned += 1,
                Err(_) => report.skipped += 1,
            }
            note(&mut read, &repo.sessions, &group, &found, &targets);
        }
    }
    let mut scans = Vec::new();
    for (index, target) in targets.iter().enumerate() {
        if !needs_scan(target) || deferred.contains(&index) {
            continue;
        }
        let result = match (in_repos.get(&index), read.remove(&index)) {
            // Its repository not there now, or in none: nothing can be read,
            // which is tried again later.
            _ if unavailable.contains(&index) => None,
            (None, _) => None,
            (Some(n), Some((done, result))) if done == *n => {
                result.map(|(events, scope)| (events, scope.to_string()))
            }
            // Not every repository was read on this sync.
            _ => continue,
        };
        scans.push(OutcomeScan {
            session_id: target.session_id.clone(),
            ended_at: target.ended_at,
            read: result,
            tracked: tracked.get(&index).copied().unwrap_or(0),
        });
    }
    ledger.store_outcome_scans(&scans, now)?;

    // Count every age that is due and whose history has been read up to it.
    let mut targets = ledger.outcome_targets(false)?;
    targets.retain(ready);
    ledger.outcome_files(&mut targets)?;
    let mut windows = Vec::new();
    for target in &targets {
        let events = ledger.outcome_events_of(&target.session_id)?;
        // A reading by a build that did not note them: all its lines.
        let tracked = target
            .tracked
            .unwrap_or_else(|| target.files.iter().map(|(_, h)| h.len() as u64).sum());
        for (name, seconds) in due(target) {
            if !reached(target, seconds) {
                continue;
            }
            windows.push((
                target.session_id.clone(),
                window(&events, target, name, seconds, tracked, now),
            ));
        }
    }
    report.kept = ledger.keep_outcome_windows(&windows)?;
    Ok(report)
}

/// Keep what reading one repository found for the sessions `group` (of
/// `sessions`), with what the others they are in found.
fn note(
    read: &mut HashMap<usize, Read>,
    sessions: &[InRepo],
    group: &[usize],
    found: &Found,
    targets: &[OutcomeTarget],
) {
    for s in group.iter().map(|k| &sessions[*k]) {
        let entry = read
            .entry(s.target)
            .or_insert((0, Some((Vec::new(), HEAD_AND_DEFAULT))));
        entry.0 += 1;
        match (found, &mut entry.1) {
            (Ok((events, scope)), Some((kept, kept_scope))) => {
                let id = &targets[s.target].session_id;
                for event in events.iter().filter(|e| &e.session_id == id) {
                    // The same commit in two clones of one repository.
                    if !kept.iter().any(|k| k.sha == event.sha) {
                        kept.push(event.clone());
                    }
                }
                if *scope == HEAD_ONLY {
                    *kept_scope = HEAD_ONLY;
                }
            }
            (Err(_), slot) => *slot = None,
            _ => {}
        }
    }
}

/// Lines as many times as either list has each.
fn most_of(a: &[u64], b: &[u64]) -> Vec<u64> {
    let mut counts: BTreeMap<u64, (usize, usize)> = BTreeMap::new();
    for hash in a {
        counts.entry(*hash).or_default().0 += 1;
    }
    for hash in b {
        counts.entry(*hash).or_default().1 += 1;
    }
    counts
        .into_iter()
        .flat_map(|(hash, (x, y))| std::iter::repeat_n(hash, x.max(y)))
        .collect()
}

/// The count of one age, from the session's events.
fn window(
    events: &[OutcomeEvent],
    target: &OutcomeTarget,
    name: &str,
    seconds: i64,
    tracked: u64,
    now: DateTime<Utc>,
) -> OutcomeCheckpoint {
    let ended = target.ended_at;
    let end = ended + chrono::Duration::seconds(seconds);
    let inside: Vec<&OutcomeEvent> = events.iter().filter(|e| e.at <= end).collect();
    let of = |kind: &'static str| inside.iter().filter(move |e| e.kind == kind);
    let reverts: Vec<&&OutcomeEvent> = of("revert").collect();
    let age = (now - ended).num_seconds().max(0) as u64;
    OutcomeCheckpoint {
        checkpoint: name.to_string(),
        lines_tracked: tracked,
        fix_commits: of("fix").count() as u64,
        likely_fix_commits: of("fix").filter(|e| e.strength >= LIKELY_FIX).count() as u64,
        lines_fixed: of("fix").map(|e| e.lines).sum(),
        rework_commits: of("rework").count() as u64,
        lines_reworked: of("rework").map(|e| e.lines).sum(),
        revert_commits: reverts.len() as u64,
        lines_reverted: reverts.iter().map(|e| e.lines).sum(),
        // Every revert in the age was itself reverted in it.
        relanded: !reverts.is_empty()
            && reverts
                .iter()
                .all(|e| e.relanded_at.is_some_and(|at| at <= end)),
        computed_at: Some(now),
        age_seconds: age,
        ended_at: Some(ended),
        late: age as i64 >= seconds + 86_400,
        scope: target.scope.clone().unwrap_or_else(|| HEAD_ONLY.into()),
        by_agent: by_agent(&inside),
    }
}

/// The events of an age that were other agent sessions' own commits, by agent.
fn by_agent(inside: &[&OutcomeEvent]) -> Vec<OutcomeBy> {
    let mut by: Vec<OutcomeBy> = Vec::new();
    for e in inside {
        let Some(source) = &e.by_source else { continue };
        let i = match by.iter().position(|b| &b.source == source) {
            Some(i) => i,
            None => {
                by.push(OutcomeBy {
                    source: source.clone(),
                    ..Default::default()
                });
                by.len() - 1
            }
        };
        let b = &mut by[i];
        match e.kind.as_str() {
            "fix" => {
                b.fix_commits += 1;
                b.likely_fix_commits += u64::from(e.strength >= LIKELY_FIX);
                b.lines_fixed += e.lines;
            }
            "revert" => {
                b.revert_commits += 1;
                b.lines_reverted += e.lines;
            }
            _ => {
                b.rework_commits += 1;
                b.lines_reworked += e.lines;
            }
        }
    }
    by.sort_by(|a, b| a.source.cmp(&b.source));
    by
}

const PATCH: &[&str] = &[
    "-p",
    "-U0",
    "--no-renames",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

/// How many times a reading follows the sessions' lines to where a commit
/// moved them (a file renamed, code moved to another file).
const MOST_PASSES: usize = 3;

/// Past `deadline`, a reading stops: what it does between commands takes
/// time too.
fn in_time(deadline: Instant) -> Result<(), Stop> {
    if Instant::now() < deadline {
        Ok(())
    } else {
        Err(Stop::TimedOut)
    }
}

/// Read one repository's history and find what touched each session in
/// `scanning`. `sessions` is every session with lines there: a line several
/// of them wrote is shared among them. `roots` are its worktrees here: what
/// each has checked out is read, with the remote's default branch; one that
/// cannot be read is read without, unless a session in `scanning` wrote in it.
fn scan(
    roots: &BTreeSet<PathBuf>,
    sessions: &[InRepo],
    scanning: &[&InRepo],
    targets: &[OutcomeTarget],
    words_of: &Words,
    deadline: Instant,
) -> Result<(Vec<OutcomeEvent>, &'static str), Stop> {
    let wrote_in: BTreeSet<&PathBuf> = scanning.iter().flat_map(|s| &s.roots).collect();
    let root = *wrote_in.first().ok_or(Stop::Failed)?;
    let in_root = |at: &Path, args: &[&str], input: Option<&[u8]>, most: usize, lazy: bool| {
        let mut command = history(at, lazy);
        command.args(args);
        match crate::git::bounded(command, input, most, deadline)? {
            (out, true) => Ok(out),
            (_, false) => Err(Stop::TooLarge),
        }
    };
    // What git says of a name, or none when there is no such name. One it
    // cannot answer (too slow, a repository it will not read) fails the
    // reading: read without it, the reading would say less than it does.
    let look = |at: &Path, args: &[&str]| {
        let mut command = history(at, false);
        command.args(args);
        crate::git::lookup(command, deadline)
    };
    // A partial clone fetches what it does not have; any other reads only what is here.
    let lazy = look(
        root,
        &[
            "config",
            "--get-regexp",
            r"^(extensions\.partialclone|remote\..*\.promisor)$",
        ],
    )?
    .is_some_and(|found| partial(&found));
    let run =
        |args: &[&str], input: Option<&[u8]>, most: usize| in_root(root, args, input, most, lazy);

    // What each worktree has checked out, and the remote's default branch.
    let mut refs: Vec<String> = Vec::new();
    let every: BTreeSet<&PathBuf> = roots.iter().chain(wrote_in.iter().copied()).collect();
    for at in every {
        // One no session being read wrote in is asked for `ASKING` at most:
        // broken since, not this person's, or on a disk that does not
        // answer, it is read without.
        let optional = !wrote_in.contains(at);
        let until = if optional {
            deadline.min(Instant::now() + ASKING)
        } else {
            deadline
        };
        let mut command = history(at, false);
        command.args(["rev-parse", "--verify", "--quiet", "HEAD"]);
        let head = match crate::git::lookup(command, until) {
            Ok(head) => head,
            Err(Stop::Failed | Stop::TooLarge) if optional => continue,
            Err(Stop::TimedOut) if optional && Instant::now() < deadline => continue,
            Err(stop) => return Err(stop),
        };
        if let Some(head) = head
            .filter(|sha| is_sha(sha))
            .filter(|sha| !refs.contains(sha))
        {
            refs.push(head);
        }
    }
    let heads = refs.len();
    let default = match look(
        root,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    )? {
        Some(name) if name.starts_with("refs/remotes/") => {
            look(root, &["rev-parse", "--verify", "--quiet", &name])?.filter(|sha| is_sha(sha))
        }
        _ => None,
    };
    if let Some(default) = &default {
        if !refs.contains(default) {
            refs.push(default.clone());
        }
    }
    let scope = if heads > 0 && default.is_some() {
        HEAD_AND_DEFAULT
    } else {
        HEAD_ONLY
    };
    if refs.is_empty() {
        // A repository with no commit yet has no later ones: read, and
        // nothing found. One with commits on no branch here (an orphan
        // branch checked out) is read when it has one.
        let any = run(&["for-each-ref", "--count=1"], None, 4096)?;
        return if any.iter().all(u8::is_ascii_whitespace) {
            Ok((Vec::new(), HEAD_ONLY))
        } else {
            Err(Stop::Failed)
        };
    }

    // From a day before the earliest start (committers' clocks) to a day
    // after the latest longest age, as numbers of seconds: `--since` would
    // read a small one as a date. Nothing later can be counted, and a
    // reading of a session long after it ended reads no more than one
    // made when its ages were reached.
    let since = scanning
        .iter()
        .map(|s| targets[s.target].started_at.timestamp())
        .min()
        .unwrap_or_default()
        .saturating_sub(SLACK)
        .max(0);
    let until = scanning
        .iter()
        .map(|s| targets[s.target].ended_at.timestamp())
        .max()
        .unwrap_or_default()
        .saturating_add(LONGEST + SLACK);
    let held: HashSet<(&str, u64)> = sessions
        .iter()
        .flat_map(|s| {
            s.files
                .iter()
                .flat_map(|(path, hashes)| hashes.iter().map(move |h| (path.as_str(), *h)))
        })
        .collect();
    // From when a session being read began to its longest age: what moves
    // its lines before it ended counts as much as what moves them later.
    let watched = |at: i64| {
        scanning.iter().any(|s| {
            let t = &targets[s.target];
            at >= t.started_at.timestamp() - EARLY && at <= t.ended_at.timestamp() + LONGEST
        })
    };
    let mut paths: BTreeSet<String> = scanning
        .iter()
        .flat_map(|s| s.files.iter().map(|(p, _)| p.clone()))
        .collect();
    // Where commits moved the sessions' lines to: read again with those paths.
    let mut moved: HashSet<(String, u64)> = HashSet::new();
    let mut pass = 0;
    let commits = loop {
        in_time(deadline)?;
        pass += 1;
        let wanted = Wanted {
            refs: &refs,
            since,
            until,
            paths: &paths,
        };
        let commits = read_commits(
            &run,
            &wanted,
            &|path, hash| held.contains(&(path, hash)) || moved.contains(&(path.to_string(), hash)),
            &watched,
            scanning.len() == 1,
            deadline,
        )?;
        // Lines moved again, or to a file read already: those are read whole
        // there now too.
        let mut more = false;
        for commit in &commits {
            for (from, to, hash, _) in &commit.moves {
                if held.contains(&(from.as_str(), *hash)) || moved.contains(&(from.clone(), *hash))
                {
                    more |= moved.insert((to.clone(), *hash));
                    more |= paths.insert(to.clone());
                }
            }
        }
        if !more || pass == MOST_PASSES {
            break commits;
        }
    };

    let scanned: HashSet<usize> = scanning.iter().map(|s| s.target).collect();
    Ok((
        attribute(&commits, sessions, targets, words_of, &scanned, deadline)?,
        scope,
    ))
}

/// What a reading reads: the commits on `refs` from `since` to `until`
/// (seconds) that changed `paths`.
struct Wanted<'a> {
    refs: &'a [String],
    since: i64,
    until: i64,
    paths: &'a BTreeSet<String>,
}

/// The commits `wanted`, in the order git walks them (parents first), with
/// their parents, messages and changes; merge commits only for what
/// descends from what. One that removes a line `held` says is a session's,
/// while a session being read is `watched`, is read whole: a line it adds
/// back elsewhere was moved, not changed, and what it adds to other files
/// says whose it was. Too many such commits fail the reading, so that it is
/// read for fewer sessions; for one session (`alone`), only the earliest
/// are read whole. One too big to read whole is not counted.
fn read_commits(
    run: &Git,
    wanted: &Wanted,
    held: &dyn Fn(&str, u64) -> bool,
    watched: &dyn Fn(i64) -> bool,
    alone: bool,
    deadline: Instant,
) -> Result<Vec<Commit>, Stop> {
    // From `since`: a commit dated before it (one rebased with its author's
    // date) is left out, and not, as `--max-age` leaves them out, the
    // commits it follows from too, the session's own with them.
    let since = if crate::git::filters_since() {
        format!("--since-as-filter=@{} +0000", wanted.since)
    } else {
        format!("--max-age={}", wanted.since)
    };
    let min_age = format!("--min-age={}", wanted.until);
    let mut args = vec![
        "rev-list",
        "--parents",
        "--full-history",
        "--topo-order",
        "--reverse",
        "--timestamp",
        "--stdin",
        since.as_str(),
        min_age.as_str(),
    ];
    args.extend(wanted.refs.iter().map(String::as_str));
    // The paths as it reads them, a line each after `--`: more than a
    // command line takes, for a session of many files. One with a line's
    // end in it on the command line.
    let (odd, plain): (Vec<&String>, Vec<&String>) = wanted
        .paths
        .iter()
        .partition(|path| path.contains('\n') || path.ends_with('\r'));
    if !odd.is_empty() {
        args.push("--");
        args.extend(odd.iter().map(|path| path.as_str()));
    }
    let paths: String = std::iter::once("--")
        .chain(plain.iter().map(|path| path.as_str()))
        .map(|line| format!("{line}\n"))
        .collect();
    let mut seen = HashSet::new();
    let listed: Vec<(String, i64, Vec<String>)> =
        parse_list(&run(&args, Some(paths.as_bytes()), MAX_LOG_BYTES)?)
            .into_iter()
            .filter(|(sha, _, _)| seen.insert(sha.clone()))
            .collect();
    if listed.is_empty() {
        return Ok(Vec::new());
    }
    // Merge commits say what descends from what, and are not read.
    let shas: Vec<&str> = listed
        .iter()
        .filter(|(_, _, parents)| parents.len() < 2)
        .map(|(sha, _, _)| sha.as_str())
        .collect();
    let input: String = shas.iter().map(|sha| format!("{sha}\n")).collect();
    let messages = parse_batch(&run(
        &["cat-file", "--batch"],
        Some(input.as_bytes()),
        MAX_LOG_BYTES,
    )?);
    // Their changes to the paths, so many paths at a time: a commit's are
    // those of each part.
    let mut diffs: HashMap<String, HashMap<String, FileDiff>> = HashMap::new();
    for part in path_parts(wanted.paths) {
        let mut args = vec!["diff-tree", "--stdin", "--always", "--root"];
        args.extend(PATCH);
        args.push("--");
        args.extend(part);
        let out = run(&args, Some(input.as_bytes()), MAX_LOG_BYTES)?;
        let out = String::from_utf8_lossy(&out);
        for (sha, diff) in split_tree(&out, &shas)? {
            diffs.entry(sha).or_default().extend(parse_diff(diff));
        }
    }
    let mut commits: Vec<Commit> = listed
        .into_iter()
        .map(|(sha, at, parents)| Commit {
            message: messages.get(&sha).cloned().unwrap_or_default(),
            files: diffs.remove(&sha).unwrap_or_default(),
            sha,
            at,
            parents,
            removed_total: None,
            moves: Vec::new(),
        })
        .collect();

    let candidates: HashSet<String> = commits
        .iter()
        .filter(|c| {
            watched(c.at)
                && c.files
                    .iter()
                    .any(|(path, diff)| diff.removed.keys().any(|hash| held(path.as_str(), *hash)))
        })
        .map(|c| c.sha.clone())
        .collect();
    // Rather than count what was moved as changed.
    if candidates.len() > MOST_SHOWN && !alone {
        return Err(Stop::TooLarge);
    }
    let mut whole: HashMap<String, HashMap<String, FileDiff>> = HashMap::new();
    if !candidates.is_empty() {
        let asked: Vec<&str> = commits
            .iter()
            .map(|c| c.sha.as_str())
            .filter(|sha| candidates.contains(*sha))
            .take(MOST_SHOWN)
            .collect();
        let input: String = asked.iter().map(|sha| format!("{sha}\n")).collect();
        let out = run(
            &[
                "diff-tree",
                "--stdin",
                "--always",
                "--root",
                "--numstat",
                "--no-renames",
            ],
            Some(input.as_bytes()),
            MAX_LOG_BYTES,
        )?;
        let out = String::from_utf8_lossy(&out);
        let sizes = split_tree(&out, &asked)?;
        let small: Vec<&str> = asked
            .iter()
            .copied()
            .filter(|sha| {
                let lines: u64 = sizes.get(*sha).map_or(0, |numstat| {
                    numstat
                        .lines()
                        .flat_map(|line| line.split('\t').take(2))
                        .filter_map(|n| n.parse::<u64>().ok())
                        .sum()
                });
                lines <= MOST_LINES_SHOWN
            })
            .collect();
        let mut batches: std::collections::VecDeque<&[&str]> =
            small.chunks(SHOWN_AT_ONCE).collect();
        while let Some(some) = batches.pop_front() {
            in_time(deadline)?;
            let input: String = some.iter().map(|sha| format!("{sha}\n")).collect();
            let mut args = vec!["diff-tree", "--stdin", "--always", "--root"];
            args.extend(PATCH);
            let out = match run(&args, Some(input.as_bytes()), MAX_SHOWN_BYTES) {
                Ok(out) => out,
                // More than is read at once: in halves, and a commit that is
                // more alone is not read whole.
                Err(Stop::TooLarge) if some.len() > 1 => {
                    let (first, rest) = some.split_at(some.len() / 2);
                    batches.push_front(rest);
                    batches.push_front(first);
                    continue;
                }
                Err(Stop::TooLarge) => continue,
                Err(stop) => return Err(stop),
            };
            let out = String::from_utf8_lossy(&out);
            for (sha, diff) in split_tree(&out, some)? {
                whole.insert(sha, parse_diff(diff));
            }
        }
    }
    for commit in commits.iter_mut() {
        if let Some(files) = whole.remove(&commit.sha) {
            in_time(deadline)?;
            let (files, removed, moves) = unmoved(files);
            commit.files = files;
            commit.removed_total = Some(removed);
            commit.moves = moves;
        } else if candidates.contains(&commit.sha) {
            // Too big to read whole: not counted.
            for diff in commit.files.values_mut() {
                diff.removed.clear();
            }
        }
    }
    Ok(commits)
}

/// Paths on one command line: no more than this many bytes of them, well
/// under what any system takes (Windows takes 32 KiB in all). Less in
/// tests, which read so many paths in parts.
#[cfg(not(test))]
const MOST_PATH_BYTES: usize = 24 * 1024;
#[cfg(test)]
const MOST_PATH_BYTES: usize = 2 * 1024;

/// `paths` in parts of no more than `MOST_PATH_BYTES` (a path longer than
/// that, alone), in order; at least one part.
fn path_parts(paths: &BTreeSet<String>) -> Vec<Vec<&str>> {
    let mut parts: Vec<Vec<&str>> = vec![Vec::new()];
    let mut bytes = 0;
    for path in paths {
        let last = parts.last_mut().expect("at least one part");
        if !last.is_empty() && bytes + path.len() + 1 > MOST_PATH_BYTES {
            parts.push(Vec::new());
            bytes = 0;
        }
        bytes += path.len() + 1;
        parts.last_mut().expect("at least one part").push(path);
    }
    parts
}

/// Git run in a repository: with these arguments and this input, printing
/// no more than so much.
type Git<'a> = dyn Fn(&[&str], Option<&[u8]>, usize) -> Result<Vec<u8>, Stop> + 'a;

/// A line moved by a commit: from one file to another, how many copies.
type Move = (String, String, u64, u64);

/// A whole commit's files, less the lines it moved: each line removed and
/// added again, in that file or another, is taken out of both. One removed
/// and added again in the same file stays there; only what is left of it
/// moves to another. With the tracked lines it removed, less those, and
/// where each line moved to another file went.
fn unmoved(mut files: HashMap<String, FileDiff>) -> (HashMap<String, FileDiff>, f64, Vec<Move>) {
    let mut paths: Vec<String> = files.keys().cloned().collect();
    paths.sort();
    // Which files each line was removed from and added to, by their place
    // in `paths`, in that order, and how many: found once, not file by file
    // for each line.
    let mut removed: HashMap<u64, Vec<(usize, u64)>> = HashMap::new();
    let mut added: HashMap<u64, Vec<(usize, u64)>> = HashMap::new();
    for (p, path) in paths.iter().enumerate() {
        let diff = &files[path];
        for (bag, at) in [(&diff.removed, &mut removed), (&diff.added, &mut added)] {
            for (hash, n) in bag {
                at.entry(*hash).or_default().push((p, *n));
            }
        }
    }
    let mut hashes: Vec<u64> = removed
        .keys()
        .filter(|hash| added.contains_key(*hash))
        .copied()
        .collect();
    hashes.sort();
    // Which file each moved line left, and which it went to, in order; and
    // how many copies of each line come out of each file, removed and added.
    let mut moves = Vec::new();
    let mut out: HashMap<(usize, u64), (u64, u64)> = HashMap::new();
    for hash in hashes {
        let (Some(mut from), Some(mut to)) = (removed.remove(&hash), added.remove(&hash)) else {
            continue;
        };
        // In the same file first: not moved. Both lists are in path order,
        // and most are one file long.
        let mut k = 0;
        for (p, n) in from.iter_mut() {
            while k < to.len() && to[k].0 < *p {
                k += 1;
            }
            if k == to.len() {
                break;
            }
            if to[k].0 != *p {
                continue;
            }
            let same = (*n).min(to[k].1);
            *n -= same;
            to[k].1 -= same;
            let cut = out.entry((*p, hash)).or_default();
            cut.0 += same;
            cut.1 += same;
        }
        // What is left of it, from one file to another, in order.
        let (mut f, mut t) = (0, 0);
        while f < from.len() && t < to.len() {
            let taken = from[f].1.min(to[t].1);
            if taken > 0 {
                moves.push((
                    paths[from[f].0].clone(),
                    paths[to[t].0].clone(),
                    hash,
                    taken,
                ));
                from[f].1 -= taken;
                to[t].1 -= taken;
                out.entry((from[f].0, hash)).or_default().0 += taken;
                out.entry((to[t].0, hash)).or_default().1 += taken;
            }
            if from[f].1 == 0 {
                f += 1;
            }
            if to[t].1 == 0 {
                t += 1;
            }
        }
    }
    for (p, path) in paths.iter().enumerate() {
        let Some(diff) = files.get_mut(path) else {
            continue;
        };
        for (bag, removing) in [(&mut diff.removed, true), (&mut diff.added, false)] {
            for (hash, n) in bag.iter_mut() {
                if let Some(&(gone, back)) = out.get(&(p, *hash)) {
                    *n -= if removing { gone } else { back };
                }
            }
            bag.retain(|_, n| *n > 0);
        }
    }
    let total = files.values().flat_map(|d| d.removed.values()).sum::<u64>() as f64;
    (files, total, moves)
}

/// Per session and file, copies of each line.
type Lines = Vec<HashMap<String, HashMap<u64, f64>>>;

/// What one history has of a session's lines: copies by file, by line in
/// all, and in all.
#[derive(Debug, Clone, Default)]
struct Held {
    files: HashMap<String, HashMap<u64, f64>>,
    lines: HashMap<u64, f64>,
    total: f64,
    /// Whether a commit in the history landed them. Before one does, what
    /// it adds of lines like them (a teammate's check on another branch) is
    /// noted, and is the session's once one does, but no change to it counts.
    landed: bool,
    /// Until then, the lines few sessions wrote that commits of its time
    /// (from when it began to `SLACK` after it ended) added: what says that
    /// a later one of its time lands them.
    early: HashSet<u64>,
}

impl Held {
    fn copies(&self, path: &str, hash: u64) -> f64 {
        self.files
            .get(path)
            .and_then(|f| f.get(&hash))
            .copied()
            .unwrap_or(0.0)
    }

    fn line(&self, hash: u64) -> f64 {
        self.lines.get(&hash).copied().unwrap_or(0.0)
    }

    /// `n` copies more of a line in `path` (fewer, when it is less than 0).
    fn add(&mut self, path: &str, hash: u64, n: f64) {
        let file = match self.files.get_mut(path) {
            Some(file) => file,
            None => self.files.entry(path.to_string()).or_default(),
        };
        *file.entry(hash).or_insert(0.0) += n;
        *self.lines.entry(hash).or_insert(0.0) += n;
        self.total += n;
    }

    /// Two branches merged, `a` and `b`: what the commit both descend from
    /// had (`base`; nothing, when none read is one), with what each changed
    /// since, a line taken out by one is out. No more of a line in a file
    /// than `room` (what the session wrote there, or moved there), nor in
    /// all than `most`: a line both moved, each to a file of its own, is
    /// shared among them.
    fn merge(
        a: &Held,
        b: &Held,
        base: Option<&Held>,
        room: &HashMap<String, HashMap<u64, f64>>,
        most: &HashMap<u64, f64>,
    ) -> Held {
        let none = Held::default();
        let base = base.unwrap_or(&none);
        let mut places: BTreeSet<(&str, u64)> = BTreeSet::new();
        for held in [a, b, base] {
            for (path, lines) in &held.files {
                places.extend(lines.keys().map(|hash| (path.as_str(), *hash)));
            }
        }
        let mut copies: Vec<(&str, u64, f64)> = Vec::new();
        let mut in_all: HashMap<u64, f64> = HashMap::new();
        for (path, hash) in places {
            let fits = room
                .get(path)
                .and_then(|r| r.get(&hash))
                .copied()
                .unwrap_or(0.0);
            let n =
                (a.copies(path, hash) + b.copies(path, hash) - base.copies(path, hash)).min(fits);
            if n > 0.0 {
                copies.push((path, hash, n));
                *in_all.entry(hash).or_insert(0.0) += n;
            }
        }
        let mut merged = Held {
            landed: a.landed || b.landed,
            early: a.early.union(&b.early).copied().collect(),
            ..Held::default()
        };
        for (path, hash, n) in copies {
            let all = in_all[&hash];
            let most = most.get(&hash).copied().unwrap_or(0.0);
            merged.add(path, hash, if all > most { n * most / all } else { n });
        }
        merged
    }
}

/// Per session, what a history has of its lines. A commit's is its
/// parent's, shared until the commit changes it.
type Has = Rc<BTreeMap<usize, Rc<Held>>>;

/// What the histories of a merge's parents (each with its place in the
/// walk) have: per session, the first one's, and what each other one
/// changed since the commit both descend from, whose history `base_of`
/// says. `room` and `written` are what each session wrote, by file and in
/// all.
fn merged(
    parents: Vec<(usize, Has)>,
    base_of: &dyn Fn(usize, usize) -> Option<Has>,
    room: &Lines,
    written: &[HashMap<u64, f64>],
) -> Has {
    let mut parents = parents.into_iter();
    let Some((first, mut has)) = parents.next() else {
        return Has::default();
    };
    for (other_at, other) in parents {
        let same = other
            .iter()
            .all(|(i, held)| has.get(i).is_some_and(|mine| Rc::ptr_eq(mine, held)));
        if same {
            continue;
        }
        let base = base_of(first, other_at);
        let map = Rc::make_mut(&mut has);
        for (i, held) in other.iter() {
            let before = base.as_ref().and_then(|base| base.get(i));
            // Not changed on that side since: what the other has.
            let kept = |h: &Rc<Held>| before.is_some_and(|b| Rc::ptr_eq(b, h));
            match map.entry(*i) {
                std::collections::btree_map::Entry::Vacant(e) => {
                    e.insert(Rc::clone(held));
                }
                std::collections::btree_map::Entry::Occupied(mut e) => {
                    if Rc::ptr_eq(e.get(), held) || kept(held) {
                        continue;
                    }
                    if kept(e.get()) {
                        e.insert(Rc::clone(held));
                        continue;
                    }
                    let both =
                        Held::merge(e.get(), held, before.map(|b| &**b), &room[*i], &written[*i]);
                    e.insert(Rc::new(both));
                }
            }
        }
    }
    has
}

/// The commits read, as git walked them (parents first): where each is in
/// the walk, and the places of its parents that were read.
struct Graph<'a> {
    commits: &'a [Commit],
    at: HashMap<&'a str, usize>,
    ups: Vec<Vec<usize>>,
}

impl<'a> Graph<'a> {
    fn of(commits: &'a [Commit]) -> Graph<'a> {
        let at: HashMap<&str, usize> = commits
            .iter()
            .enumerate()
            .map(|(k, c)| (c.sha.as_str(), k))
            .collect();
        let ups = commits
            .iter()
            .map(|c| {
                c.parents
                    .iter()
                    .filter_map(|p| at.get(p.as_str()).copied())
                    .collect()
            })
            .collect();
        Graph { commits, at, ups }
    }

    /// Whether the commit at `x` is the one at `y` or descends from it. A
    /// parent is walked before its children: none before `y` is.
    fn descends(&self, x: usize, y: usize) -> bool {
        let mut seen = HashSet::new();
        let mut next = vec![x];
        while let Some(k) = next.pop() {
            if k == y {
                return true;
            }
            if k > y && seen.insert(k) {
                next.extend(&self.ups[k]);
            }
        }
        false
    }

    /// The latest commit read that the ones at `a` and `b` both are or
    /// descend from (their merge base), if any: the first found from both,
    /// latest first.
    fn base(&self, a: usize, b: usize) -> Option<usize> {
        let mut from: HashMap<usize, u8> = HashMap::from([(a, 1), (b, 2)]);
        if a == b {
            return Some(a);
        }
        let mut next = std::collections::BinaryHeap::from([a, b]);
        while let Some(k) = next.pop() {
            let sides = from[&k];
            if sides == 3 {
                return Some(k);
            }
            for &up in &self.ups[k] {
                let known = from.entry(up).or_insert(0);
                if *known | sides != *known {
                    *known |= sides;
                    next.push(up);
                }
            }
        }
        None
    }
}

/// What `has` has of session `i`, to change: a copy of it, if it is shared.
fn held_mut(has: &mut Has, i: usize) -> &mut Held {
    Rc::make_mut(Rc::make_mut(has).entry(i).or_default())
}

/// Whether a commit puts lines back rather than lands them: a revert, or
/// the revert of a revert (`Reapply "…"`).
fn puts_back(commit: &Commit) -> bool {
    let subject = commit.message.lines().next().unwrap_or_default();
    !reverts(&commit.message).is_empty()
        || words(subject)
            .first()
            .is_some_and(|w| w == "revert" || w == "reapply")
}

/// How deep the commit `at` is in a chain of reverts: 0 for one that
/// reverts nothing, 1 for a revert of such a one, 2 for a revert of that
/// (`Reapply "…"`, or `Revert "Revert "…""`), and so on. One that names no
/// commit read before it is as deep as its subject says.
fn revert_depth(commits: &[Commit], at: usize, depths: &mut HashMap<usize, u32>) -> u32 {
    let mut chain = Vec::new();
    let mut k = at;
    let mut depth = loop {
        if let Some(depth) = depths.get(&k) {
            break *depth;
        }
        let named = reverts(&commits[k].message).iter().find_map(|sha| {
            commits[..k]
                .iter()
                .position(|c| c.sha.starts_with(sha.as_str()))
        });
        match named {
            Some(named) => {
                chain.push(k);
                k = named;
            }
            None => {
                let depth = subject_depth(&commits[k].message);
                depths.insert(k, depth);
                break depth;
            }
        }
    };
    for k in chain.into_iter().rev() {
        depth += 1;
        depths.insert(k, depth);
    }
    depth
}

/// How deep a commit's subject says it is in a chain of reverts, as git
/// titles them: one for each `Revert "` it begins with, two for each
/// `Reapply "`. A conventional `revert:` type is one, and a `Revert "` right
/// after it is that same revert. One at least when its message names a
/// commit it reverts. A subject that only begins with the word (`Revert to
/// polling`, `Revert revert-button styling`) says nothing of a chain.
fn subject_depth(message: &str) -> u32 {
    let subject = message.lines().next().unwrap_or_default().trim();
    let (mut depth, mut rest) = match conventional(subject) {
        Some((kind, rest)) if kind == "revert" => {
            let rest = rest.trim_start();
            (1, strip_title(rest, "revert \"").unwrap_or(rest))
        }
        Some((_, rest)) => (0, rest.trim_start()),
        None => (0, subject),
    };
    loop {
        if let Some(inner) = strip_title(rest, "revert \"") {
            depth += 1;
            rest = inner;
        } else if let Some(inner) = strip_title(rest, "reapply \"") {
            depth += 2;
            rest = inner;
        } else {
            break;
        }
    }
    if depth == 0 && !reverts(message).is_empty() {
        depth = 1;
    }
    depth
}

/// `text` less `title` at its start, in any case.
fn strip_title<'a>(text: &'a str, title: &str) -> Option<&'a str> {
    let head = text.get(..title.len())?;
    head.eq_ignore_ascii_case(title)
        .then(|| &text[title.len()..])
}

/// Walk the commits as git does, parents first, and say, for each session in
/// `scanned`, which ones touched it and how. A session's lines count from
/// when a commit lands them in the history, and in what descends from that
/// commit only: before it, or beside it (a branch from before it, the
/// remote's branch without it), a line like them that a commit removes was
/// someone else's. Each commit counts against what its own history has of
/// them, so a fix on one branch and rework on another both count, whichever
/// git walks first.
fn attribute(
    commits: &[Commit],
    sessions: &[InRepo],
    targets: &[OutcomeTarget],
    words_of: &Words,
    scanned: &HashSet<usize>,
    deadline: Instant,
) -> Result<Vec<OutcomeEvent>, Stop> {
    let graph = Graph::of(commits);
    // A commit of a session's time lands its lines with less only when no
    // commit read lands them as the first walk does: two of its lines in
    // one are a teammate's like them when its own commit is read elsewhere.
    let none = HashSet::new();
    let first = walk(
        &graph, sessions, targets, words_of, scanned, &none, deadline,
    )?;
    let less: HashSet<usize> = first.wanted.difference(&first.strict).copied().collect();
    let mut events = if less.is_empty() {
        first.events
    } else {
        walk(
            &graph, sessions, targets, words_of, scanned, &less, deadline,
        )?
        .events
    };
    // The same change made on two branches (a fix cherry-picked, or
    // backported whatever its subject says) counts once, as the first made,
    // whichever git walked first. Made again on one, after it was undone
    // there, it counts again.
    let mut order: Vec<usize> = (0..events.len()).collect();
    order.sort_by(|a, b| {
        let (a, b) = (&events[*a].2, &events[*b].2);
        (a.at, &a.sha).cmp(&(b.at, &b.sha))
    });
    // Those kept of a change are each on the history of the others: in the
    // walk's order, each descends from the one before. One that does from
    // the one before it there, and the one after from it, is on theirs.
    let mut made: HashMap<(usize, u64), BTreeSet<usize>> = HashMap::new();
    let mut keep = vec![true; events.len()];
    for e in order {
        let (i, change, event) = &events[e];
        let Some(&place) = graph.at.get(event.sha.as_str()) else {
            continue;
        };
        let before = made.entry((*i, *change)).or_default();
        let on_theirs = before
            .range(..place)
            .next_back()
            .is_none_or(|&k| graph.descends(place, k))
            && before
                .range(place + 1..)
                .next()
                .is_none_or(|&k| graph.descends(k, place));
        if on_theirs {
            before.insert(place);
        } else {
            keep[e] = false;
        }
    }
    let mut kept = keep.into_iter();
    events.retain(|_| kept.next().unwrap_or(true));
    // A revert that was reverted in turn (git names that one `Reapply "…"`),
    // in what descends from it.
    for (i, event) in events.iter_mut().map(|(i, _, e)| (*i, e)) {
        if event.kind != "revert" {
            continue;
        }
        let Some(&place) = graph.at.get(event.sha.as_str()) else {
            continue;
        };
        let ended = targets[sessions[i].target].ended_at.timestamp();
        event.relanded_at = commits
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                c.at >= event.at.timestamp() && c.at <= ended + LONGEST && c.sha != event.sha
            })
            .find(|(k, c)| {
                reverts(&c.message)
                    .iter()
                    .any(|sha| event.sha.starts_with(sha.as_str()))
                    && graph.descends(*k, place)
            })
            .and_then(|(_, c)| DateTime::from_timestamp(c.at, 0));
    }
    Ok(events.into_iter().map(|(_, _, e)| e).collect())
}

/// What a walk of the commits found: per session, the commits that touched
/// it, each with what it changed; and which sessions a commit landed as
/// `attribute` says, and which ones a commit of their time would land with
/// less, that a walk lands that way only when told to (`less`).
struct Walked {
    events: Vec<(usize, u64, OutcomeEvent)>,
    strict: HashSet<usize>,
    wanted: HashSet<usize>,
}

/// One walk of `attribute`'s: sessions in `less` are landed with less.
fn walk(
    graph: &Graph,
    sessions: &[InRepo],
    targets: &[OutcomeTarget],
    words_of: &Words,
    scanned: &HashSet<usize>,
    less: &HashSet<usize>,
    deadline: Instant,
) -> Result<Walked, Stop> {
    let commits = graph.commits;
    // A line is common when this many sessions or more wrote it in that file.
    let mut writers: HashMap<String, HashMap<u64, usize>> = HashMap::new();
    for session in sessions {
        for (path, hashes) in &session.files {
            let unique: HashSet<u64> = hashes.iter().copied().collect();
            let file = writers.entry(path.clone()).or_default();
            for hash in unique {
                *file.entry(hash).or_insert(0) += 1;
            }
        }
    }
    let writers_of = |writers: &HashMap<String, HashMap<u64, usize>>, path: &str, hash: u64| {
        writers
            .get(path)
            .and_then(|w| w.get(&hash))
            .copied()
            .unwrap_or(0)
    };

    // What each session wrote: how many of each line, in all (following them
    // to other files makes no more of them) and in each file. And the
    // sessions that wrote in each file: the only ones a change there can be of.
    let mut written: Vec<HashMap<u64, f64>> = vec![HashMap::new(); sessions.len()];
    let mut wrote: Lines = vec![HashMap::new(); sessions.len()];
    let mut in_file: HashMap<String, Vec<usize>> = HashMap::new();
    // And which of its lines few sessions wrote.
    let mut uncommon: Vec<HashSet<u64>> = vec![HashSet::new(); sessions.len()];
    for (i, session) in sessions.iter().enumerate() {
        let few = &mut uncommon[i];
        for (path, hashes) in &session.files {
            let counts = wrote[i].entry(path.clone()).or_default();
            for hash in hashes {
                *counts.entry(*hash).or_insert(0.0) += 1.0;
                *written[i].entry(*hash).or_insert(0.0) += 1.0;
                if writers_of(&writers, path, *hash) < COMMON_LINE {
                    few.insert(*hash);
                }
            }
            in_file.entry(path.clone()).or_default().push(i);
        }
    }
    // Each session's own commits: those after it began that add copies of
    // its lines the history did not have (moved ones are not added). Of
    // those, the ones that landed them, not put them back: a revert is not
    // the session's work, nor its agent's.
    let mut own: Vec<HashSet<&str>> = vec![HashSet::new(); sessions.len()];
    let mut landed: Vec<HashSet<&str>> = vec![HashSet::new(); sessions.len()];
    let mut landed_by: HashMap<&str, Vec<usize>> = HashMap::new();
    // Per commit, what its history has of each session's lines; kept until
    // every commit read that has it as a parent is walked, or to the end
    // for one more than one has (where branches merged later may begin).
    let mut has: HashMap<&str, Has> = HashMap::new();
    let mut children: HashMap<&str, usize> = HashMap::new();
    for commit in commits {
        for parent in &commit.parents {
            *children.entry(parent.as_str()).or_insert(0) += 1;
        }
    }
    let forks: HashSet<&str> = children
        .iter()
        .filter(|(_, n)| **n > 1)
        .map(|(sha, _)| *sha)
        .collect();
    let mut depths: HashMap<usize, u32> = HashMap::new();
    // Sessions a commit landed as `attribute` says, and ones a commit of
    // their time would land with less.
    let mut strict: HashSet<usize> = HashSet::new();
    let mut wanted: HashSet<usize> = HashSet::new();

    // Per session, the commits that touched it, each with what it changed.
    let mut events: Vec<(usize, u64, OutcomeEvent)> = Vec::new();
    for (at, commit) in commits.iter().enumerate() {
        in_time(deadline)?;
        let sha = commit.sha.as_str();
        let parents: Vec<(usize, Has)> = commit
            .parents
            .iter()
            .filter_map(|p| Some((*graph.at.get(p.as_str())?, has.get(p.as_str())?.clone())))
            .collect();
        let base_of = |a: usize, b: usize| {
            let base = graph.base(a, b)?;
            has.get(commits[base].sha.as_str()).cloned()
        };
        let mut theirs = merged(parents, &base_of, &wrote, &written);
        for parent in &commit.parents {
            if let Some(left) = children.get_mut(parent.as_str()) {
                *left -= 1;
                if *left == 0 && !forks.contains(parent.as_str()) {
                    has.remove(parent.as_str());
                }
            }
        }
        if commit.parents.len() > 1 {
            has.insert(sha, theirs);
            continue;
        }
        let active =
            |i: usize| commit.at >= targets[sessions[i].target].started_at.timestamp() - EARLY;
        // Lines it moved to another file are the session's there now.
        for (from, to, hash, n) in &commit.moves {
            let count = writers_of(&writers, from, *hash);
            if count > 0 {
                let there = writers
                    .entry(to.clone())
                    .or_default()
                    .entry(*hash)
                    .or_insert(0);
                *there = (*there).max(count);
            }
            let Some(here) = in_file.get(from).cloned() else {
                continue;
            };
            for i in here {
                let have = theirs.get(&i).map_or(0.0, |h| h.copies(from, *hash));
                let taken = have.min(*n as f64);
                if taken <= 0.0 {
                    continue;
                }
                let held = held_mut(&mut theirs, i);
                held.add(from, *hash, -taken);
                held.add(to, *hash, taken);
                // There as many as it moved, and never more than it wrote.
                let most = written[i].get(hash).copied().unwrap_or(0.0);
                let room = wrote[i]
                    .entry(to.clone())
                    .or_default()
                    .entry(*hash)
                    .or_insert(0.0);
                *room = (*room + taken).min(most);
                let there = in_file.entry(to.clone()).or_default();
                if !there.contains(&i) {
                    there.push(i);
                }
            }
        }
        // A session's own commit adds copies of its lines that the commit's
        // history does not have: a copy of lines already there (a person's, or
        // a block copied) is not. On a history it landed in, at least
        // `LANDING_LINES` of them, or `LANDING_SHARE` of what the commit adds
        // to the session's files; after its time, `LANDING_LINES` that few
        // sessions wrote, each counted once: a fix that puts back a check it
        // wrote (`if err != nil {`, `return err`) that a commit took out is
        // not its own. On one it did not (its own branch before its first
        // commit, or a branch a cherry-pick or a squash merge lands it on), a
        // commit that adds `LANDING_LINES` of its lines that few sessions
        // wrote, each counted once, or every one for a session of fewer and
        // `LANDING_SHARE` of what it adds: a teammate's `if err != nil {` and
        // `return err` there are not its lines. Commits of its time (from when
        // it began to `SLACK` after it ended) that add two of them or more
        // (any, for a session of fewer) count together. Where no commit read
        // lands it so, one of its time lands it with less: two of its lines,
        // at least half of them and `LANDING_SHARE` of what it adds; or every
        // one, for a session of fewer.
        let mut adds: BTreeMap<usize, (f64, f64, HashSet<u64>)> = BTreeMap::new();
        let late = |i: usize| commit.at > targets[sessions[i].target].ended_at.timestamp() + SLACK;
        for (path, diff) in &commit.files {
            if diff.added.is_empty() {
                continue;
            }
            let Some(here) = in_file.get(path) else {
                continue;
            };
            for &i in here {
                let Some(room) = wrote[i].get(path).filter(|_| active(i)) else {
                    continue;
                };
                let held = theirs.get(&i).filter(|h| h.landed);
                let entry = adds.entry(i).or_default();
                for (hash, n) in &diff.added {
                    entry.1 += *n as f64;
                    let Some(room) = room.get(hash) else {
                        continue;
                    };
                    let free = match held {
                        Some(held) => {
                            let most = written[i].get(hash).copied().unwrap_or(0.0);
                            let free =
                                (room - held.copies(path, *hash)).min(most - held.line(*hash));
                            if late(i) {
                                if free > 0.0 && uncommon[i].contains(hash) {
                                    entry.2.insert(*hash);
                                }
                                continue;
                            }
                            free
                        }
                        None => {
                            if uncommon[i].contains(hash) {
                                entry.2.insert(*hash);
                            }
                            *room
                        }
                    };
                    entry.0 += (*n as f64).min(free.max(0.0));
                }
            }
        }
        // Its own, on a history it landed in; and those it may land on one
        // it did not, once what it adds is there.
        let mut fresh: Vec<(usize, bool, HashSet<u64>)> = Vec::new();
        for (i, (mine, all, new)) in adds {
            let share = mine >= MIN_TOUCH_LINES && mine / all >= LANDING_SHARE;
            if !theirs.get(&i).is_some_and(|h| h.landed) {
                if !new.is_empty() {
                    fresh.push((i, share, new));
                }
            } else if mine >= LANDING_LINES || share || new.len() as f64 >= LANDING_LINES {
                own[i].insert(sha);
                if !puts_back(commit) {
                    landed[i].insert(sha);
                    landed_by.entry(sha).or_default().push(i);
                }
            }
        }
        // Sessions this commit is later than, within the longest age, and not one of their own.
        let open = |i: usize| {
            let ended = targets[sessions[i].target].ended_at.timestamp();
            commit.at > ended && commit.at <= ended + LONGEST && !own[i].contains(sha)
        };
        // Per open session: lines it lost (shared lines split), copies it held
        // of them, of which not common, and all it held before.
        let mut lost: BTreeMap<usize, (f64, f64, f64, f64)> = BTreeMap::new();
        for (path, diff) in &commit.files {
            if diff.removed.is_empty() {
                continue;
            }
            let Some(here) = in_file.get(path) else {
                continue;
            };
            for (hash, removed) in &diff.removed {
                // The sessions the history has copies of it of, and whether
                // it landed them.
                let had: Vec<(usize, f64, bool)> = here
                    .iter()
                    .copied()
                    .filter(|i| active(*i))
                    .filter_map(|i| {
                        let held = theirs.get(&i)?;
                        let have = held.copies(path, *hash);
                        (have > 0.0).then_some((i, have, held.landed))
                    })
                    .collect();
                let all: f64 = had.iter().filter(|h| h.2).map(|h| h.1).sum();
                let removed = *removed as f64;
                let common = writers_of(&writers, path, *hash) >= COMMON_LINE;
                for (i, have, landed) in had {
                    let copies = have.min(removed);
                    if landed && open(i) {
                        let before = theirs.get(&i).map_or(0.0, |h| h.total);
                        let entry = lost.entry(i).or_insert((0.0, 0.0, 0.0, before));
                        entry.0 += have.min(removed * have / all);
                        entry.1 += copies;
                        if !common {
                            entry.2 += copies;
                        }
                    }
                    // The copies went, for every session that had them: the
                    // share is only what each is counted for.
                    held_mut(&mut theirs, i).add(path, *hash, -copies);
                }
            }
        }
        // What it adds of a session's lines is in the history from now:
        // landed, or put back after a revert, or noted until it lands. No
        // more of a line than the session wrote, in that file or in all.
        for (path, diff) in &commit.files {
            if diff.added.is_empty() {
                continue;
            }
            let Some(here) = in_file.get(path) else {
                continue;
            };
            for &i in here {
                let Some(room) = wrote[i].get(path).filter(|_| active(i)) else {
                    continue;
                };
                for (hash, n) in &diff.added {
                    let Some(room) = room.get(hash) else {
                        continue;
                    };
                    let most = written[i].get(hash).copied().unwrap_or(0.0);
                    let (have, all) = theirs
                        .get(&i)
                        .map_or((0.0, 0.0), |h| (h.copies(path, *hash), h.line(*hash)));
                    let add = (*n as f64).min(room - have).min(most - all);
                    if add > 0.0 {
                        held_mut(&mut theirs, i).add(path, *hash, add);
                    }
                }
            }
        }
        for (i, share, new) in fresh {
            let Some(held) = theirs.get(&i) else {
                continue;
            };
            let few = &uncommon[i];
            let t = &targets[sessions[i].target];
            let of_its_time = commit.at >= t.started_at.timestamp() - EARLY
                && commit.at <= t.ended_at.timestamp() + SLACK;
            let small = (few.len() as f64) < LANDING_LINES;
            let joins = of_its_time && (new.len() as f64 >= MIN_TOUCH_LINES || small);
            // Of its lines few sessions wrote, those the history has that
            // this commit added, or (with it) the earlier ones of its time.
            let there = few
                .iter()
                .filter(|h| held.line(**h) > 0.0)
                .filter(|h| new.contains(*h) || (joins && held.early.contains(*h)))
                .count();
            let all = there >= few.len();
            // As every walk lands them, and with less, as one does where the
            // first found nothing that lands them so.
            let lands = there as f64 >= LANDING_LINES || (all && share);
            let with_less = of_its_time && ((small && all) || (share && 2 * there >= few.len()));
            if lands {
                strict.insert(i);
            } else if with_less {
                wanted.insert(i);
            }
            if lands || (with_less && less.contains(&i)) {
                let held = held_mut(&mut theirs, i);
                held.landed = true;
                held.early.clear();
                own[i].insert(sha);
                if !puts_back(commit) {
                    landed[i].insert(sha);
                    landed_by.entry(sha).or_default().push(i);
                }
            } else if joins {
                held_mut(&mut theirs, i).early.extend(new);
            }
        }
        has.insert(sha, theirs);
        if lost.is_empty() {
            continue;
        }
        let says = signals(&commit.message, words_of);
        let reverted = reverts(&commit.message);
        // A revert of a revert puts back what that one took out, whatever its
        // subject says (`Revert "Revert "…""`, as git before 2.43 and
        // GitHub's button name it), and a revert of that takes it out again:
        // one at an even depth is not a revert of the session.
        let depth = revert_depth(commits, at, &mut depths);
        let reapplies = depth >= 2 && depth.is_multiple_of(2);
        let change = change_of(commit);
        // The agent session that landed this commit: the latest to have
        // begun, if several.
        let made_by = |i: usize| {
            landed_by
                .get(sha)
                .into_iter()
                .flatten()
                .copied()
                .filter(|j| *j != i)
                .max_by_key(|j| (targets[sessions[*j].target].started_at, *j))
                .map(|j| &targets[sessions[j].target])
        };
        for (i, (lines, copies, not_common, before)) in lost {
            if not_common < MIN_TOUCH_LINES || !scanned.contains(&sessions[i].target) {
                continue;
            }
            let names_own = reverted
                .iter()
                .any(|named| landed[i].iter().any(|own| own.starts_with(named.as_str())));
            let bulk = says.contains(&"revert_subject")
                && !reapplies
                && before > 0.0
                && copies / before >= REVERT_SHARE;
            let mut signals: Vec<&str> = Vec::new();
            if names_own {
                signals.push("revert_sha");
            }
            if bulk {
                signals.push("revert_bulk");
            }
            signals.extend(says.iter().filter(|s| s.starts_with("fix_")));
            let kind = if names_own || bulk {
                "revert"
            } else if signals.iter().any(|s| s.starts_with("fix_")) {
                "fix"
            } else {
                "rework"
            };
            events.push((
                i,
                change,
                OutcomeEvent {
                    session_id: targets[sessions[i].target].session_id.clone(),
                    sha: commit.sha.clone(),
                    at: DateTime::from_timestamp(commit.at, 0).unwrap_or_default(),
                    kind: kind.to_string(),
                    signals: signals.iter().map(|s| s.to_string()).collect(),
                    lines,
                    copies,
                    // How much of what the commit removed was the session's.
                    strength: commit
                        .removed_total
                        .filter(|total| *total > 0.0)
                        .map_or(0.0, |total| (copies / total).min(1.0)),
                    relanded_at: None,
                    subject: commit
                        .message
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .to_string(),
                    by_session: made_by(i).map(|t| t.session_id.clone()),
                    by_source: made_by(i).map(|t| t.source.clone()),
                },
            ));
        }
    }
    Ok(Walked {
        events,
        strict,
        wanted,
    })
}

/// What a commit changes, as a number: the lines it removes and adds in
/// each file. A cherry-pick of it changes the same, whatever its subject.
fn change_of(commit: &Commit) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut paths: Vec<&String> = commit
        .files
        .iter()
        .filter(|(_, diff)| !diff.added.is_empty() || !diff.removed.is_empty())
        .map(|(path, _)| path)
        .collect();
    paths.sort();
    for path in paths {
        let diff = &commit.files[path];
        path.hash(&mut hasher);
        for bag in [&diff.removed, &diff.added] {
            let mut lines: Vec<(&u64, &u64)> = bag.iter().collect();
            lines.sort();
            lines.hash(&mut hasher);
        }
    }
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../action/test/outcome-signals.json")).unwrap()
    }

    #[test]
    fn the_word_lists_are_those_the_action_reads() {
        let fixture = fixture();
        let list = |key: &str| -> Vec<String> {
            fixture[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| w.as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(list("fix_words"), FIX_WORDS);
        assert_eq!(list("fix_types"), FIX_TYPES);
    }

    #[test]
    fn messages_are_read_as_the_action_reads_them() {
        let words_of = Words::default();
        for case in fixture()["cases"].as_array().unwrap() {
            let message = case["message"].as_str().unwrap();
            let expected: Vec<&str> = case["signals"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap())
                .collect();
            assert_eq!(signals(message, &words_of), expected, "{message}");
            if let Some(shas) = case["reverts"].as_array() {
                let expected: Vec<&str> = shas.iter().map(|s| s.as_str().unwrap()).collect();
                assert_eq!(reverts(message), expected, "{message}");
            }
            if let Some(depth) = case["depth"].as_u64() {
                assert_eq!(u64::from(subject_depth(message)), depth, "{message}");
            }
        }
    }

    #[test]
    fn fix_words_can_be_replaced() {
        let words_of = Words::new(Some(&["oops".to_string(), "Repair".to_string()]));
        assert_eq!(signals("Repair the parser", &words_of), ["fix_message"]);
        assert_eq!(signals("oops, forgot a file", &words_of), ["fix_message"]);
        assert!(signals("Fix the parser", &words_of).is_empty());
        // The conventional type stays.
        assert_eq!(signals("fix: the parser", &words_of), ["fix_conventional"]);
        // A word as it is read, or none: `follow-up` would make every "up" a fix.
        let unusable = Words::new(Some(&["---".to_string(), "follow-up".to_string()]));
        assert_eq!(signals("Fix the parser", &unusable), ["fix_message"]);
        assert!(signals("Bump up the limit", &unusable).is_empty());
    }

    #[test]
    fn reads_a_diff_with_its_headers_and_a_removed_line_that_looks_like_one() {
        let diff = "diff --git a/f.js b/f.js\nindex 1..2 100644\n--- a/f.js\n+++ b/f.js\n\
                    @@ -1 +1 @@\n---x minus\n+--x changed\n\
                    diff --git a/gone.js b/gone.js\ndeleted file mode 100644\n--- a/gone.js\n+++ /dev/null\n\
                    @@ -1,2 +0,0 @@\n-let a = 1;\n-}\n\
                    diff --git a/new.js b/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/new.js\n\
                    @@ -0,0 +1 @@\n+let b = 2;\n";
        let files = parse_diff(diff);
        assert_eq!(
            files["f.js"].removed,
            HashMap::from([(line_hash("--x minus").unwrap(), 1)])
        );
        assert_eq!(
            files["f.js"].added,
            HashMap::from([(line_hash("--x changed").unwrap(), 1)])
        );
        assert_eq!(files["gone.js"].removed.len(), 1, "`}}` is not tracked");
        assert_eq!(files["new.js"].added.len(), 1);
    }

    use crate::ledger::Fingerprint;
    use crate::rewrite::FileLines;
    use crate::session::{FileTouched, Repo, Session};

    const T0: i64 = 1_767_225_600; // 2026-01-01T00:00:00Z
    const HOUR: i64 = 3600;
    const DAY: i64 = 86_400;

    /// A repository with history, and a ledger of sessions that wrote in it.
    struct World {
        dir: tempfile::TempDir,
        ledger: Ledger,
    }

    impl World {
        fn new() -> World {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir(dir.path().join("repo")).unwrap();
            let ledger = Ledger::open(&dir.path().join("ledger.db")).unwrap();
            let world = World { dir, ledger };
            world.git(&["init", "--quiet", "--initial-branch", "main"], T0);
            world
        }

        fn root(&self) -> PathBuf {
            self.dir.path().join("repo")
        }

        fn git(&self, args: &[&str], at: i64) -> String {
            git_in(&self.root(), args, at)
        }

        /// Write `file` and commit everything with `message` at `at`; the new commit's SHA.
        fn commit(&self, file: &str, content: &str, message: &str, at: i64) -> String {
            commit_in(&self.root(), file, content, message, at)
        }
    }

    /// Git in `root` as a test makes history: commits at `at`, by nobody's
    /// config, whatever git's variables the test runs with.
    fn git_in(root: &Path, args: &[&str], at: i64) -> String {
        let date = format!("@{at} +0000");
        let out = crate::git::command(root)
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
            .args([
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
            ])
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Write `file` in `root` and commit everything with `message` at `at`; the new commit's SHA.
    fn commit_in(root: &Path, file: &str, content: &str, message: &str, at: i64) -> String {
        let path = root.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
        git_in(root, &["add", "-A"], at);
        git_in(root, &["commit", "--quiet", "-m", message], at);
        git_in(root, &["rev-parse", "HEAD"], at)
    }

    impl World {
        /// A session that began at `started`, ended at `ended`, and added `lines` to `file`.
        fn session(&mut self, id: &str, started: i64, ended: i64, files: &[(&str, &[&str])]) {
            self.session_of("claude-code", id, started, ended, files);
        }

        /// The same, of the agent `source`.
        fn session_of(
            &mut self,
            source: &str,
            id: &str,
            started: i64,
            ended: i64,
            files: &[(&str, &[&str])],
        ) {
            self.session_in(&self.root(), source, id, started, ended, files);
        }

        /// The same, in the repository at `root` (a file's path is relative to it).
        fn session_in(
            &mut self,
            root: &Path,
            source: &str,
            id: &str,
            started: i64,
            ended: i64,
            files: &[(&str, &[&str])],
        ) {
            let at = |t: i64| DateTime::from_timestamp(t, 0);
            let path = |file: &str| root.join(file).to_string_lossy().into_owned();
            let session = Session {
                session_id: id.into(),
                source: source.into(),
                started_at: at(started),
                ended_at: at(ended),
                repo: Some(Repo {
                    root: root.to_string_lossy().into_owned(),
                    ..Default::default()
                }),
                files: files
                    .iter()
                    .map(|(file, _)| FileTouched {
                        path: path(file),
                        writes: 1,
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            };
            let lines: Vec<FileLines> = files
                .iter()
                .map(|(file, lines)| FileLines {
                    path: path(file),
                    by_model: vec![(None, lines.iter().filter_map(|l| line_hash(l)).collect())],
                })
                .collect();
            let built_from = Fingerprint {
                built_with: "test".into(),
                raw_bytes: 1,
                transcript_path: None,
                transcript_bytes: 0,
            };
            self.ledger.upsert(&session, &built_from, &lines).unwrap();
        }

        fn measure(&mut self, now: i64) -> Report {
            self.measure_for(now, PATIENT)
        }

        fn measure_for(&mut self, now: i64, budget: Budget) -> Report {
            measure(
                &mut self.ledger,
                &Words::default(),
                DateTime::from_timestamp(now, 0).unwrap(),
                budget,
            )
            .unwrap()
        }

        fn target(&self, id: &str) -> OutcomeTarget {
            self.ledger
                .outcome_targets(false)
                .unwrap()
                .into_iter()
                .find(|t| t.session_id == id)
                .unwrap()
        }

        fn at(&self, id: &str, age: &str) -> Option<OutcomeCheckpoint> {
            self.ledger
                .outcome_checkpoints_of(id)
                .unwrap()
                .into_iter()
                .find(|c| c.checkpoint == age)
        }

        fn kinds(&self, id: &str) -> Vec<(String, String)> {
            self.ledger
                .outcome_events_of(id)
                .unwrap()
                .into_iter()
                .map(|e| (e.kind, e.subject))
                .collect()
        }
    }

    const AGENT: &[&str] = &[
        "let alpha = compute(1);",
        "let beta = compute(2);",
        "let gamma = compute(3);",
        "return alpha + beta + gamma;",
    ];

    /// The session wrote `f.js` (committed at T0+1h) and ended at T0+2h.
    fn written() -> (World, String) {
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        let landing = world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", AGENT)]);
        (world, landing)
    }

    #[test]
    fn a_later_commit_another_agent_session_made_is_by_it() {
        let (mut world, _) = written();
        // A Cursor session the next day fixes two of the lines, in its own commit.
        let cursor: &[&str] = &[
            "let alpha = checked(compute(1));",
            "let beta = checked(compute(2));",
            "let delta = compute(4);",
        ];
        world.commit(
            "f.js",
            &format!(
                "// base line one\n{}\n{}\n{}\n{}\n{}\n",
                cursor[0], cursor[1], cursor[2], AGENT[2], AGENT[3]
            ),
            "fix: check what compute returns",
            T0 + DAY,
        );
        world.session_of(
            "cursor",
            "s2",
            T0 + DAY - HOUR,
            T0 + DAY + HOUR,
            &[("f.js", cursor)],
        );
        // and a person the day after changes the other two.
        world.commit(
            "f.js",
            &format!(
                "// base line one\n{}\n{}\n{}\n",
                cursor[0], cursor[1], cursor[2]
            ),
            "Tidy up",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);

        let events = world.ledger.outcome_events_of("s1").unwrap();
        let by: Vec<_> = events
            .iter()
            .map(|e| {
                (
                    e.kind.as_str(),
                    e.by_source.as_deref(),
                    e.by_session.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            by,
            [("fix", Some("cursor"), Some("s2")), ("rework", None, None)]
        );
        let week = world.at("s1", "7d").unwrap();
        assert_eq!((week.fix_commits, week.rework_commits), (1, 1));
        assert_eq!(
            week.by_agent,
            [OutcomeBy {
                source: "cursor".into(),
                fix_commits: 1,
                likely_fix_commits: 1,
                lines_fixed: 2.0,
                ..Default::default()
            }]
        );
        // Its own commit is not a later commit of its own.
        assert!(world.ledger.outcome_events_of("s2").unwrap().is_empty());
    }

    #[test]
    fn a_fix_after_the_session_changed_its_lines() {
        let (mut world, _) = written();
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: wrong arguments",
            T0 + 3 * DAY,
        );
        let report = world.measure(T0 + 8 * DAY);
        assert_eq!(report.scanned, 1);
        assert_eq!(
            world.kinds("s1"),
            [("fix".into(), "fix: wrong arguments".into())]
        );
        let day = world.at("s1", "1d").unwrap();
        assert_eq!(
            (day.fix_commits, day.lines_tracked),
            (0, 4),
            "the fix came after day 1"
        );
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(
            (week.fix_commits, week.likely_fix_commits, week.lines_fixed),
            (1, 1, 2.0)
        );
        assert_eq!(week.scope, HEAD_ONLY);
        assert!(!week.late);
        assert!(world.at("s1", "30d").is_none(), "not 30 days old yet");
    }

    #[test]
    fn one_line_a_reindent_and_what_came_before_the_end_are_no_touch() {
        let mut world = World::new();
        world.commit("f.js", "// base\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base\n{}\n", AGENT.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        // Still in the session: the agent's own edit.
        let edited = AGENT.join("\n").replace("compute(3)", "compute(30)");
        world.commit(
            "f.js",
            &format!("// base\n{edited}\n"),
            "fix: tweak during the session",
            T0 + 90 * 60,
        );
        let lines: Vec<&str> = edited.lines().collect();
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", &lines)]);
        // After it: one line changed, then every line re-indented.
        let one = edited.replace("compute(1)", "compute(100)");
        world.commit(
            "f.js",
            &format!("// base\n{one}\n"),
            "fix: one line",
            T0 + DAY + HOUR,
        );
        let indented: String = one.lines().map(|l| format!("    {l}\n")).collect();
        world.commit(
            "f.js",
            &format!("// base\n{indented}"),
            "Indent",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.kinds("s1"), Vec::<(String, String)>::new());
        assert_eq!(world.at("s1", "7d").unwrap().fix_commits, 0);
    }

    #[test]
    fn rework_has_no_fix_word() {
        let (mut world, _) = written();
        let renamed = AGENT
            .join("\n")
            .replace("alpha", "first")
            .replace("beta", "second");
        world.commit(
            "f.js",
            &format!("// base line one\n{renamed}\n"),
            "Name the values",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(
            (week.fix_commits, week.rework_commits, week.lines_reworked),
            (0, 1, 3.0)
        );
    }

    #[test]
    fn a_revert_of_its_commit_and_the_revert_of_that() {
        let (mut world, landing) = written();
        world.git(&["revert", "--no-edit", &landing], T0 + 2 * DAY);
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(
            (week.revert_commits, week.lines_reverted, week.relanded),
            (1, 4.0, false)
        );

        // Relanded within the month: the 30-day count says so.
        let revert = world.git(&["rev-parse", "HEAD"], T0);
        world.git(&["revert", "--no-edit", &revert], T0 + 10 * DAY);
        world.measure(T0 + 31 * DAY);
        let month = world.at("s1", "30d").unwrap();
        assert_eq!((month.revert_commits, month.relanded), (1, true));
        assert!(!world.at("s1", "7d").unwrap().relanded, "kept as it was");
        let events = world.ledger.outcome_events_of("s1").unwrap();
        assert_eq!(events[0].signals, ["revert_sha", "revert_bulk"]);
    }

    #[test]
    fn a_fix_on_the_default_branch_is_found_from_a_feature_branch() {
        let (mut world, _) = written();
        world.git(&["update-ref", "refs/remotes/origin/main", "HEAD"], T0);
        world.git(
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
            T0,
        );
        world.git(&["checkout", "--quiet", "-b", "feature"], T0);
        world.commit("g.js", "unrelated work here\n", "Feature work", T0 + DAY);
        // The fix lands on main while the feature branch is checked out.
        world.git(&["checkout", "--quiet", "main"], T0);
        let fixed = AGENT.join("\n").replace("compute", "calculate");
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "Fix the call",
            T0 + 2 * DAY,
        );
        world.git(&["update-ref", "refs/remotes/origin/main", "HEAD"], T0);
        world.git(&["checkout", "--quiet", "feature"], T0);
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(
            (week.fix_commits, week.scope.as_str()),
            (1, HEAD_AND_DEFAULT)
        );
    }

    #[test]
    fn moved_lines_are_not_changed() {
        let (mut world, _) = written();
        // The file moves, and two of its lines move to the top of it.
        let mut lines: Vec<&str> = AGENT.to_vec();
        lines.rotate_left(2);
        std::fs::remove_file(world.root().join("f.js")).unwrap();
        world.commit(
            "moved.js",
            &format!("// base line one\n{}\n", lines.join("\n")),
            "Move it",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.kinds("s1"), Vec::<(String, String)>::new());
    }

    #[test]
    fn lines_two_sessions_wrote_are_shared() {
        let (mut world, _) = written();
        world.session("s2", T0, T0 + 2 * HOUR, &[("f.js", &AGENT[..2])]);
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: arguments",
            T0 + 3 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").unwrap().lines_fixed, 1.0);
        assert_eq!(world.at("s2", "7d").unwrap().lines_fixed, 1.0);
    }

    #[test]
    fn history_is_read_only_when_an_age_needs_it() {
        let (mut world, _) = written();
        assert_eq!(
            world.measure(T0 + 3 * HOUR),
            Report::default(),
            "no age reached"
        );
        assert_eq!(world.measure(T0 + 2 * DAY).scanned, 1, "day 1 is due");
        assert!(
            !world.at("s1", "1d").unwrap().late,
            "counted within a day of the age"
        );
        assert_eq!(world.measure(T0 + 2 * DAY + HOUR), Report::default());
        assert_eq!(world.measure(T0 + 9 * DAY).scanned, 1, "day 7 is due");
        assert!(world.at("s1", "7d").unwrap().late, "counted on day 9");
    }

    #[test]
    fn a_session_that_went_on_counts_again_from_its_new_end() {
        let (mut world, _) = written();
        world.measure(T0 + 8 * DAY);
        assert!(world.at("s1", "7d").is_some());
        world.session("s1", T0, T0 + 9 * DAY, &[("f.js", AGENT)]);
        assert!(world
            .ledger
            .outcome_checkpoints_of("s1")
            .unwrap()
            .is_empty());
        assert!(world.ledger.outcome_targets(false).unwrap()[0]
            .scanned_until
            .is_none());
    }

    #[test]
    fn files_outside_any_repository_are_left_out() {
        let (mut world, _) = written();
        let outside = world.dir.path().join("notes.md");
        std::fs::write(&outside, "a note\n").unwrap();
        world.session(
            "s1",
            T0,
            T0 + 2 * HOUR,
            &[
                ("f.js", AGENT),
                (outside.to_str().unwrap(), &["a note", "another note"]),
            ],
        );
        assert_eq!(world.measure(T0 + 8 * DAY).scanned, 1);
        assert_eq!(world.at("s1", "7d").unwrap().lines_tracked, 4);
    }

    #[test]
    fn conventional_subjects() {
        assert_eq!(conventional("fix(ui)!: x").map(|c| c.0), Some("fix".into()));
        assert_eq!(conventional("Fix: x").map(|c| c.0), Some("fix".into()));
        assert_eq!(
            conventional("Note: the fix").map(|c| c.0),
            Some("note".into())
        );
        assert_eq!(conventional("see http://x"), None);
        assert_eq!(conventional("a (b: c"), None);
    }

    #[test]
    fn a_message_cannot_pass_for_a_commit_or_an_option() {
        let (mut world, _) = written();
        let target = world.dir.path().join("pwned.txt");
        let changed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        let msg = format!(
            "Tidy\x1e--output={}\x1f{}\x1fx",
            target.display(),
            T0 + 3 * DAY
        );
        world.commit(
            "f.js",
            &format!("// base line one\n{changed}\n"),
            &msg,
            T0 + 3 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert!(!target.exists(), "git wrote {}", target.display());
        let events = world.ledger.outcome_events_of("s1").unwrap();
        assert!(events.iter().all(|e| is_sha(&e.sha)), "{events:?}");
        assert_eq!(events.len(), 1);
        assert!(events[0].subject.starts_with("Tidy"));
    }

    #[test]
    fn a_session_in_two_repositories_counts_both() {
        let (mut world, _) = written();
        let other = World::new();
        let lib: &[&str] = &[
            "let one = helper(1);",
            "let two = helper(2);",
            "let three = helper(3);",
        ];
        other.commit("g.js", "// lib base\n", "init", T0);
        other.commit(
            "g.js",
            &format!("// lib base\n{}\n", lib.join("\n")),
            "Add helper",
            T0 + HOUR,
        );
        let g = other.root().join("g.js");
        world.session(
            "s1",
            T0,
            T0 + 2 * HOUR,
            &[("f.js", AGENT), (g.to_str().unwrap(), lib)],
        );
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: wrong arguments",
            T0 + 3 * DAY,
        );
        let fixed_lib = lib
            .join("\n")
            .replace("helper(1)", "helper(10)")
            .replace("helper(2)", "helper(20)");
        other.commit(
            "g.js",
            &format!("// lib base\n{fixed_lib}\n"),
            "fix: helper arguments",
            T0 + 4 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").unwrap().fix_commits, 2);
    }

    #[test]
    fn file_names_with_a_space_or_a_quote() {
        for name in ["my file.js", "say \"hi\".js", "back\\slash.js"] {
            let mut world = World::new();
            world.commit(name, "// base line one\n", "init", T0);
            world.commit(
                name,
                &format!("// base line one\n{}\n", AGENT.join("\n")),
                "Add compute",
                T0 + HOUR,
            );
            world.session("s1", T0, T0 + 2 * HOUR, &[(name, AGENT)]);
            let fixed = AGENT
                .join("\n")
                .replace("compute(1)", "compute(10)")
                .replace("compute(2)", "compute(20)");
            world.commit(
                name,
                &format!("// base line one\n{fixed}\n"),
                "fix: wrong arguments",
                T0 + 3 * DAY,
            );
            world.measure(T0 + 8 * DAY);
            assert_eq!(world.at("s1", "7d").unwrap().fix_commits, 1, "{name}");
        }
    }

    const SIX: &[&str] = &[
        "let alpha = compute(1);",
        "let beta = compute(2);",
        "let gamma = compute(3);",
        "let delta = compute(4);",
        "let eps = compute(5);",
        "return alpha + beta + gamma + delta + eps;",
    ];

    #[test]
    fn a_fix_that_reindents_the_lines_is_not_their_own_commit() {
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", SIX.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", SIX)]);
        // A person's fix: two lines changed, the rest wrapped in a try block.
        let body: String = SIX
            .iter()
            .map(|l| {
                l.replace("compute(1)", "compute(10)")
                    .replace("compute(2)", "compute(20)")
            })
            .map(|l| format!("    {l}\n"))
            .collect();
        world.commit(
            "f.js",
            &format!("// base line one\ntry {{\n{body}}} catch (e) {{ report(e); }}\n"),
            "fix: handle compute errors",
            T0 + 3 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").unwrap().fix_commits, 1);
    }

    #[test]
    fn a_reindent_of_another_sessions_lines_is_not_by_it() {
        // s2 (cursor) wrote SIX; s1 wrote AGENT. A person's commit re-indents
        // s2's lines and fixes two of s1's.
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", AGENT)]);
        let other: Vec<String> = SIX.iter().map(|l| l.replace("compute", "other")).collect();
        let other_refs: Vec<&str> = other.iter().map(|s| s.as_str()).collect();
        world.commit(
            "f.js",
            &format!(
                "// base line one\n{}\n{}\n",
                AGENT.join("\n"),
                other.join("\n")
            ),
            "Add other",
            T0 + 3 * HOUR,
        );
        world.session_of(
            "cursor",
            "s2",
            T0 + 2 * HOUR + 60,
            T0 + 4 * HOUR,
            &[("f.js", &other_refs)],
        );
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        let indented: String = other.iter().map(|l| format!("  {l}\n")).collect();
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\nif (x) {{\n{indented}}}\n"),
            "fix: arguments",
            T0 + 3 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let events = world.ledger.outcome_events_of("s1").unwrap();
        assert_eq!(events[0].by_source, None, "a person's commit");
    }

    #[test]
    fn tables_of_an_older_build_are_brought_up_to_date() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ledger.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE outcome_events (
    session_id  TEXT NOT NULL, sha TEXT NOT NULL, at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('fix', 'revert', 'rework')),
    signals TEXT NOT NULL, lines REAL NOT NULL, copies REAL NOT NULL, strength REAL NOT NULL,
    relanded_at TEXT, subject TEXT NOT NULL, PRIMARY KEY (session_id, sha));
CREATE TABLE outcome_checkpoints (
    session_id TEXT NOT NULL, checkpoint TEXT NOT NULL CHECK (checkpoint IN ('1d', '7d', '30d')),
    lines_tracked INTEGER NOT NULL, fix_commits INTEGER NOT NULL, likely_fix_commits INTEGER NOT NULL,
    lines_fixed REAL NOT NULL, rework_commits INTEGER NOT NULL, lines_reworked REAL NOT NULL,
    revert_commits INTEGER NOT NULL, lines_reverted REAL NOT NULL, relanded INTEGER NOT NULL,
    computed_at TEXT NOT NULL, age_seconds INTEGER NOT NULL, ended_at TEXT NOT NULL,
    late INTEGER NOT NULL, scope TEXT NOT NULL, PRIMARY KEY (session_id, checkpoint));
INSERT INTO outcome_checkpoints VALUES ('old','7d',1,0,0,0,0,0,0,0,0,'2026-01-01T00:00:00+00:00',1,'2026-01-01T00:00:00+00:00',0,'head_only');",
            )
            .unwrap();
        }
        let mut world = World::new();
        world.ledger = Ledger::open(&path).unwrap();
        // re-run the agent-session flow on the migrated ledger
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", AGENT)]);
        world.session_of(
            "cursor",
            "s2",
            T0 + DAY - HOUR,
            T0 + DAY + HOUR,
            &[(
                "f.js",
                &[
                    "let alpha = checked(compute(1));",
                    "let beta = checked(compute(2));",
                    "let delta = compute(4);",
                ],
            )],
        );
        world.commit(
            "f.js",
            &format!(
                "// base line one\nlet alpha = checked(compute(1));\nlet beta = checked(compute(2));\nlet delta = compute(4);\n{}\n{}\n",
                AGENT[2], AGENT[3]
            ),
            "fix: check",
            T0 + DAY,
        );
        world.measure(T0 + 8 * DAY);
        let e = &world.ledger.outcome_events_of("s1").unwrap()[0];
        assert_eq!(
            (e.by_source.as_deref(), e.by_session.as_deref()),
            (Some("cursor"), Some("s2"))
        );
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(week.by_agent.len(), 1);
        assert_eq!(week.scope, HEAD_ONLY);
        let old = world.ledger.outcome_checkpoints_of("old").unwrap();
        assert_eq!(old[0].by_agent, vec![]);
    }

    #[test]
    fn a_cherry_picked_fix_of_shared_lines_counts_once() {
        for shared in [false, true] {
            let (mut world, _) = written();
            if shared {
                world.session("s2", T0, T0 + 2 * HOUR, &[("f.js", AGENT)]);
            }
            world.git(&["branch", "release"], T0);
            let fixed = AGENT
                .iter()
                .map(|l| format!("{l} // checked"))
                .collect::<Vec<_>>()
                .join("\n");
            let fix = world.commit(
                "f.js",
                &format!("// base line one\n{fixed}\n"),
                "fix: call calculate",
                T0 + 2 * DAY,
            );
            world.git(&["update-ref", "refs/remotes/origin/main", "HEAD"], T0);
            world.git(
                &[
                    "symbolic-ref",
                    "refs/remotes/origin/HEAD",
                    "refs/remotes/origin/main",
                ],
                T0,
            );
            world.git(&["checkout", "--quiet", "release"], T0);
            world.git(&["cherry-pick", &fix], T0 + 3 * DAY);
            world.measure(T0 + 8 * DAY);
            let week = world.at("s1", "7d").unwrap();
            assert_eq!(week.fix_commits, 1, "shared={shared}");
        }
    }

    #[test]
    fn commits_outside_any_age_read_now_are_not_read_whole() {
        let mut world = World::new();
        let changed = |k: &[usize], tag: &str| {
            let lines: Vec<String> = AGENT
                .iter()
                .enumerate()
                .map(|(i, l)| {
                    if k.contains(&i) {
                        format!("{l} // {tag}")
                    } else {
                        l.to_string()
                    }
                })
                .collect();
            format!("// base line one\n{}\n", lines.join("\n"))
        };
        // Lines like the session's are there before it, and changed just before it.
        world.commit("f.js", &changed(&[], ""), "init", T0 - 3 * HOUR);
        world.commit("f.js", &changed(&[0, 1], "a"), "before", T0 - 2 * HOUR);
        world.commit("f.js", &changed(&[], ""), "land", T0 + HOUR);
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", AGENT)]);
        world.commit("f.js", &changed(&[2, 3], "b"), "in its month", T0 + 3 * DAY);
        world.commit(
            "f.js",
            &changed(&[0, 1], "c"),
            "after its month",
            T0 + 30 * DAY + 12 * HOUR,
        );
        world.commit("f.js", &changed(&[2, 3], "d"), "long after", T0 + 40 * DAY);
        let root = world.root();
        let far = Instant::now() + Duration::from_secs(60);
        let run = |args: &[&str], input: Option<&[u8]>, most: usize| {
            let mut command = history(&root, false);
            command.args(args);
            match crate::git::bounded(command, input, most, far)? {
                (out, true) => Ok(out),
                (_, false) => Err(Stop::TooLarge),
            }
        };
        let refs = vec![world.git(&["rev-parse", "HEAD"], T0)];
        let paths = BTreeSet::from(["f.js".to_string()]);
        let mine: HashSet<u64> = AGENT.iter().filter_map(|l| line_hash(l)).collect();
        let (started, ended) = (T0, T0 + 2 * HOUR);
        let wanted = Wanted {
            refs: &refs,
            since: started - SLACK,
            until: ended + LONGEST + SLACK,
            paths: &paths,
        };
        let commits = read_commits(
            &run,
            &wanted,
            &|path, hash| path == "f.js" && mine.contains(&hash),
            &|at| at >= started - EARLY && at <= ended + LONGEST,
            true,
            far,
        )
        .unwrap();
        let whole: Vec<(&str, bool)> = commits
            .iter()
            .map(|c| (c.message.as_str(), c.removed_total.is_some()))
            .collect();
        // Nothing past the longest age and a day is listed at all.
        assert_eq!(
            whole,
            [
                ("init", false),
                ("before", false),
                ("land", false),
                ("in its month", true),
                ("after its month", false)
            ]
        );
    }

    #[test]
    fn a_fix_after_a_reland_counts() {
        let (mut world, landing) = written();
        world.git(&["revert", "--no-edit", &landing], T0 + 2 * DAY);
        let revert = world.git(&["rev-parse", "HEAD"], T0);
        world.git(&["revert", "--no-edit", &revert], T0 + 3 * DAY);
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: wrong arguments",
            T0 + 4 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!((week.revert_commits, week.relanded), (1, true));
        assert_eq!(week.fix_commits, 1);
    }

    #[test]
    fn history_that_cannot_be_read_is_tried_again_later_and_later() {
        let (mut world, _) = written();
        // The repository goes away.
        std::fs::rename(world.root().join(".git"), world.root().join("git-gone")).unwrap();
        assert_eq!(world.measure(T0 + 8 * DAY).scanned, 0);
        let failures = |w: &World| w.ledger.outcome_targets(false).unwrap()[0].failures;
        assert_eq!(failures(&world), 1);
        // Not again within the hour, then once, then not for two hours.
        world.measure(T0 + 8 * DAY + 1800);
        assert_eq!(failures(&world), 1);
        world.measure(T0 + 8 * DAY + 3600);
        assert_eq!(failures(&world), 2);
        world.measure(T0 + 8 * DAY + 3600 + 3600);
        assert_eq!(failures(&world), 2);
        std::fs::rename(world.root().join("git-gone"), world.root().join(".git")).unwrap();
        world.measure(T0 + 8 * DAY + 3 * 3600);
        assert_eq!(failures(&world), 0);
        assert!(world.at("s1", "7d").is_some());
    }

    #[test]
    fn quoted_header_paths() {
        assert_eq!(
            header_path("a/my file.js\t", "a/").as_deref(),
            Some("my file.js")
        );
        assert_eq!(
            header_path("\"b/say \\\"hi\\\".js\"", "b/").as_deref(),
            Some("say \"hi\".js")
        );
        assert_eq!(
            header_path("\"a/caf\\303\\251\"", "a/").as_deref(),
            Some("café")
        );
        assert_eq!(header_path("/dev/null", "a/"), None);
    }

    #[test]
    fn a_session_gone_from_the_ledger_takes_its_outcomes_with_it() {
        let (mut world, _) = written();
        world.session("s2", T0, T0 + 2 * HOUR, &[("f.js", AGENT)]);
        let fixed = AGENT.join("\n").replace("compute", "calculate");
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: calculate",
            T0 + DAY,
        );
        world.measure(T0 + 8 * DAY);
        let rows = |w: &World, id: &str| {
            (
                w.ledger.outcome_events_of(id).unwrap().len(),
                w.ledger.outcome_checkpoints_of(id).unwrap().len(),
            )
        };
        assert_eq!(rows(&world, "s1"), (1, 2));
        assert_eq!(rows(&world, "s2"), (1, 2));
        world.ledger.remove("s1", "s3").unwrap();
        assert_eq!(rows(&world, "s1"), (0, 0));
        world.ledger.retain(&[]).unwrap();
        assert_eq!(rows(&world, "s2"), (0, 0));
        assert!(world.ledger.outcome_targets(false).unwrap().is_empty());
    }

    #[test]
    fn a_repository_with_no_commit_yet_has_nothing_later() {
        let (mut world, _) = written();
        // A repository inside it, made and never committed to, where the session also wrote.
        let inner = world.root().join("inner");
        std::fs::create_dir(&inner).unwrap();
        world.git(&["-C", "inner", "init", "--quiet"], T0);
        std::fs::write(world.root().join(".git/info/exclude"), "inner/\n").unwrap();
        std::fs::write(inner.join("x.js"), AGENT.join("\n")).unwrap();
        world.session(
            "s1",
            T0,
            T0 + 2 * HOUR,
            &[("f.js", AGENT), ("inner/x.js", AGENT)],
        );
        let fixed = AGENT.join("\n").replace("compute", "calculate");
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: calculate",
            T0 + DAY,
        );
        assert_eq!(world.measure(T0 + 8 * DAY).skipped, 0);
        assert_eq!(world.at("s1", "7d").unwrap().fix_commits, 1);
    }
    #[test]
    fn a_session_said_to_begin_in_1970_hides_nothing() {
        let (mut world, _) = written();
        // A second session whose start came out as the epoch (a bad timestamp).
        world.session("bogus", 0, T0 + 2 * HOUR, &[("f.js", &AGENT[..1])]);
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: wrong arguments",
            T0 + 3 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d");
        assert_eq!(week.unwrap().fix_commits, 1, "the fix is hidden");
    }

    #[test]
    fn lines_like_its_own_removed_before_they_landed_are_not_its() {
        let mut world = World::new();
        // The file already has the two lines the agent will also write.
        world.commit(
            "f.go",
            "package x\nif err != nil {\nreturn err\n}\n// tail\n",
            "init",
            T0 - HOUR,
        );
        let agent: &[&str] = &[
            "if err != nil {",
            "return err",
            "x := compute(1)",
            "y := compute(2)",
        ];
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.go", agent)]);
        // A person removes the old check before the session's work is committed.
        world.commit(
            "f.go",
            "package x\n// tail\n",
            "Drop old check",
            T0 + 3 * HOUR,
        );
        // The session's work lands the next day.
        world.commit(
            "f.go",
            "package x\nif err != nil {\nreturn err\n}\nx := compute(1)\ny := compute(2)\n// tail\n",
            "Add compute",
            T0 + DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            world.at("s1", "7d").unwrap().rework_commits,
            0,
            "a commit before the landing touched it"
        );
    }

    #[test]
    fn a_session_with_too_many_commits_to_read_whole_is_counted_from_the_earliest() {
        let (mut world, _) = written();
        // 4010 commits in the month after it: every other one changes its lines back and forth.
        let mut stream = String::new();
        let base = format!("// base line one\n{}\n", AGENT.join("\n"));
        let changed = format!(
            "// base line one\n{}\n",
            AGENT
                .iter()
                .map(|l| format!("{l} // x"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        let head = world.git(&["rev-parse", "HEAD"], T0);
        for k in 0..4010i64 {
            let content = if k % 2 == 0 { &changed } else { &base };
            let at = T0 + DAY + k * 60;
            let msg = format!("c{k}");
            stream.push_str(&format!(
                "commit refs/heads/main\ncommitter T <t@example.com> {at} +0000\ndata {}\n{msg}\n",
                msg.len()
            ));
            if k == 0 {
                stream.push_str(&format!("from {head}\n"));
            }
            stream.push_str(&format!(
                "M 100644 inline f.js\ndata {}\n{content}\n",
                content.len()
            ));
        }
        let mut child = crate::git::command(&world.root())
            .args(["fast-import", "--quiet"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write as _;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stream.as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
        world.git(&["reset", "--hard", "--quiet", "main"], T0);
        world.measure(T0 + 8 * DAY);
        world.measure(T0 + 8 * DAY + 2 * HOUR);
        world.measure(T0 + 20 * DAY);
        let week = world.at("s1", "7d").expect("never counted");
        assert_eq!(world.ledger.outcome_targets(false).unwrap()[0].failures, 0);
        // Each even commit changes its lines and each odd one puts them back,
        // as its own: of the 2005 that change them, the earliest 2000 count.
        assert_eq!(week.rework_commits, MOST_SHOWN as u64);
        let events = world.ledger.outcome_events_of("s1").unwrap();
        assert_eq!(events.first().unwrap().subject, "c0");
        assert_eq!(events.last().unwrap().subject, "c3998");
    }

    #[test]
    fn a_persons_revert_is_not_by_the_agent_whose_lines_it_puts_back() {
        let (mut world, _) = written();
        // A Cursor session the next day replaces s1's lines with its own, in its own commit.
        let cursor: &[&str] = &[
            "let alpha = safe(1);",
            "let beta = safe(2);",
            "let gamma = safe(3);",
            "return alpha * beta * gamma;",
        ];
        let c2 = world.commit(
            "f.js",
            &format!("// base line one\n{}\n", cursor.join("\n")),
            "Use safe",
            T0 + DAY,
        );
        world.session_of(
            "cursor",
            "s2",
            T0 + DAY - HOUR,
            T0 + DAY + HOUR,
            &[("f.js", cursor)],
        );
        // A person reverts that two days later.
        world.git(&["revert", "--no-edit", &c2], T0 + 3 * DAY);
        world.measure(T0 + 10 * DAY);
        let e = world.ledger.outcome_events_of("s2").unwrap();
        assert_eq!(
            e[0].by_source, None,
            "a person's revert, said to be by claude-code"
        );
    }

    #[test]
    fn an_orphan_branch_checked_out_is_not_a_repository_without_history() {
        let (mut world, _) = written();
        let fixed = AGENT.join("\n").replace("compute", "calculate");
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: calculate",
            T0 + DAY,
        );
        // The person starts a gh-pages branch from nothing just as the sync runs.
        world.git(&["checkout", "--quiet", "--orphan", "gh-pages"], T0);
        world.measure(T0 + 8 * DAY);
        world.git(&["checkout", "--quiet", "-f", "main"], T0);
        world.measure(T0 + 9 * DAY);
        assert_eq!(
            world.at("s1", "7d").unwrap().fix_commits,
            1,
            "kept as nothing for good"
        );
    }

    #[test]
    fn one_fix_seen_from_two_worktrees_counts_once() {
        let (mut world, _) = written();
        let wt = world.dir.path().join("wt");
        world.git(
            &[
                "worktree",
                "add",
                "--quiet",
                wt.to_str().unwrap(),
                "-b",
                "side",
            ],
            T0,
        );
        // The session wrote the same lines in both checkouts.
        let other = wt.join("f.js");
        world.session(
            "s1",
            T0,
            T0 + 2 * HOUR,
            &[("f.js", AGENT), (other.to_str().unwrap(), AGENT)],
        );
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: wrong arguments",
            T0 + 3 * DAY,
        );
        world.git(&["update-ref", "refs/remotes/origin/main", "HEAD"], T0);
        world.git(
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
            T0,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(week.lines_fixed, 2.0, "one commit, two lines");
    }

    #[test]
    fn a_fix_applied_again_is_not_a_revert_of_the_session() {
        let (mut world, _) = written();
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        let fix = world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: wrong arguments",
            T0 + 2 * DAY,
        );
        world.git(&["revert", "--no-edit", &fix], T0 + 3 * DAY);
        let undo = world.git(&["rev-parse", "HEAD"], T0);
        world.git(&["revert", "--no-edit", &undo], T0 + 4 * DAY);
        world.measure(T0 + 31 * DAY);
        let month = world.at("s1", "30d").unwrap();
        assert_eq!(
            month.revert_commits, 0,
            "a fix applied again, said to revert the session"
        );
    }

    #[test]
    fn lines_moved_to_another_file_are_followed_there() {
        let (mut world, _) = written();
        world.git(&["mv", "f.js", "moved.js"], T0 + DAY);
        world.git(&["commit", "--quiet", "-m", "Move compute"], T0 + DAY);
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        world.commit(
            "moved.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: wrong arguments",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!((week.fix_commits, week.rework_commits), (1, 0));
        assert_eq!(week.lines_fixed, 2.0);
    }

    #[test]
    fn a_fix_on_a_merged_branch_is_read_though_the_branch_took_it_back() {
        let (mut world, _) = written();
        world.git(&["checkout", "--quiet", "-b", "topic"], T0);
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        let fix = world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: wrong arguments",
            T0 + DAY,
        );
        world.git(&["revert", "--no-edit", &fix], T0 + DAY + HOUR);
        world.git(&["checkout", "--quiet", "main"], T0);
        world.commit("other.txt", "x\n", "Other work", T0 + DAY + 2 * HOUR);
        world.git(
            &["merge", "--quiet", "--no-ff", "--no-edit", "topic"],
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").unwrap().fix_commits, 1);
    }

    #[test]
    fn a_sha_256_revert_names_its_commit() {
        let sha = "a".repeat(64);
        let message = format!("Revert \"x\"\n\nThis reverts commit {sha}.");
        assert_eq!(reverts(&message), [sha]);
    }

    #[test]
    fn a_message_in_latin_1_is_read_as_such() {
        let object = b"tree 0\nencoding ISO-8859-1\n\nfix: caf\xe9 crash\n";
        let sha = "b".repeat(40);
        let mut out = format!("{sha} commit {}\n", object.len()).into_bytes();
        out.extend_from_slice(object);
        out.push(b'\n');
        assert_eq!(parse_batch(&out)[&sha], "fix: café crash");
    }

    #[test]
    fn a_fix_word_is_one_as_written_whatever_lowercasing_does_to_it() {
        let words_of = Words::new(Some(&["İyileştir".to_string()]));
        assert_eq!(signals("İyileştir the parser", &words_of), ["fix_message"]);
    }

    /// A git that runs `script` first (bash, with git's arguments), then
    /// git, in this test's thread until it is dropped.
    #[cfg(unix)]
    struct FakeGit(#[allow(dead_code)] tempfile::TempDir);

    #[cfg(unix)]
    impl FakeGit {
        fn new(script: &str) -> FakeGit {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("git");
            let text = format!("#!/usr/bin/env bash\n{script}\nexec git \"$@\"\n");
            std::fs::write(&path, text).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            crate::git::run_instead(Some(path));
            FakeGit(dir)
        }

        /// One whose `rev-list` in the repository at `root` takes half a minute.
        fn slow_in(root: &Path) -> FakeGit {
            FakeGit::new(&format!(
                r#"case "$2" in "{}"*) for a in "$@"; do [ "$a" = rev-list ] && exec sleep 30; done;; esac"#,
                root.display()
            ))
        }
    }

    #[cfg(unix)]
    impl Drop for FakeGit {
        fn drop(&mut self) {
            crate::git::run_instead(None);
        }
    }

    /// Two of AGENT's lines changed, in a commit that says it fixes them.
    fn fix_two(world: &World, at: i64) -> String {
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: wrong arguments",
            at,
        )
    }

    #[test]
    fn a_copy_of_lines_already_there_does_not_make_a_commit_the_sessions_own() {
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", SIX.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", SIX)]);
        // A person fixes two of its lines and makes a second function of three others.
        let mut lines: Vec<String> = SIX.iter().map(|s| s.to_string()).collect();
        lines[3] = "let delta = compute(40);".into();
        lines[4] = "let eps = compute(50);".into();
        let copy = format!(
            "function again() {{\n{}\n{}\n{}\n}}",
            SIX[0], SIX[1], SIX[2]
        );
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n{copy}\n", lines.join("\n")),
            "fix: wrong delta and eps",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").unwrap().fix_commits, 1);
    }

    #[test]
    fn a_copy_of_one_sessions_lines_does_not_make_a_persons_fix_of_anothers_by_it() {
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", SIX.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", SIX)]);
        let cursor: &[&str] = &[
            "let one = helper(1);",
            "let two = helper(2);",
            "let three = helper(3);",
        ];
        world.commit(
            "f.js",
            &format!(
                "// base line one\n{}\n{}\n",
                SIX.join("\n"),
                cursor.join("\n")
            ),
            "Add helper",
            T0 + 3 * HOUR,
        );
        world.session_of(
            "cursor",
            "s2",
            T0 + 2 * HOUR + 60,
            T0 + 4 * HOUR,
            &[("f.js", cursor)],
        );
        // A person fixes two of Cursor's lines and copies three of Claude Code's.
        let copy = format!(
            "function again() {{\n{}\n{}\n{}\n}}",
            SIX[0], SIX[1], SIX[2]
        );
        world.commit(
            "f.js",
            &format!(
                "// base line one\n{}\nlet one = helper(10);\nlet two = helper(20);\n{}\n{copy}\n",
                SIX.join("\n"),
                cursor[2],
            ),
            "fix: helper arguments",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let events = world.ledger.outcome_events_of("s2").unwrap();
        assert_eq!(
            events[0].by_source, None,
            "a person's fix, said to be by claude-code"
        );
    }

    #[test]
    fn generic_lines_like_its_that_a_later_commit_adds_do_not_make_it_the_sessions() {
        let mut world = World::new();
        world.commit("f.go", "package x\n// tail\n", "init", T0 - HOUR);
        let agent: &[&str] = &[
            "func load() error {",
            "data, err := read()",
            "if err != nil {",
            "return err",
            "if err := parse(data); err != nil {",
            "return nil",
        ];
        world.commit(
            "f.go",
            "package x\nfunc load() error {\ndata, err := read()\nif err != nil {\nreturn err\n}\n\
             if err := parse(data); err != nil {\nreturn err\n}\nreturn nil\n}\n// tail\n",
            "Add load",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.go", agent)]);
        // A person fixes two of its lines, and adds a function with the usual checks.
        world.commit(
            "f.go",
            "package x\nfunc load() error {\ndata, err := readAll()\nif err != nil {\nreturn err\n}\n\
             if err := parseStrict(data); err != nil {\nreturn err\n}\nreturn nil\n}\n\
             func save() error {\nif err != nil {\nreturn err\n}\nreturn nil\n}\n// tail\n",
            "fix: read everything and parse strictly",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").unwrap().fix_commits, 1);
    }

    #[test]
    fn a_later_fix_that_puts_back_generic_lines_it_wrote_is_not_its_own() {
        let mut world = World::new();
        world.commit("f.go", "package x\n// tail\n", "init", T0 - HOUR);
        let agent: &[&str] = &[
            "func load() error {",
            "data, err := read()",
            "if err != nil {",
            "return err",
            "x := compute(1)",
            "y := compute(2)",
            "z := compute(3)",
            "return use(data, x, y, z)",
        ];
        let load = |check: &str, x: &str, y: &str| {
            format!(
                "package x\nfunc load() error {{\ndata, err := read()\n{check}x := compute({x})\n\
                 y := compute({y})\nz := compute(3)\nreturn use(data, x, y, z)\n}}\n// tail\n"
            )
        };
        let check = "if err != nil {\nreturn err\n}\n";
        world.commit("f.go", &load(check, "1", "2"), "Add load", T0 + HOUR);
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.go", agent)]);
        // A refactor drops the check; a person's fix puts it back, and
        // changes two of its lines.
        world.commit("f.go", &load("", "1", "2"), "Refactor load", T0 + DAY);
        world.commit(
            "f.go",
            &load(check, "10", "20"),
            "fix: check the read and the arguments",
            T0 + 3 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").expect("never counted");
        assert_eq!((week.fix_commits, week.rework_commits), (1, 1));
    }

    #[test]
    fn a_revert_of_a_cherry_pick_of_its_commit_is_a_revert() {
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        world.git(&["branch", "release"], T0);
        let landing = world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", AGENT)]);
        world.git(&["update-ref", "refs/remotes/origin/main", "main"], T0);
        world.git(
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
            T0,
        );
        world.git(&["checkout", "--quiet", "release"], T0);
        world.git(&["cherry-pick", &landing], T0 + DAY);
        let pick = world.git(&["rev-parse", "HEAD"], T0);
        world.git(&["revert", "--no-edit", &pick], T0 + 2 * DAY);
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").unwrap().revert_commits, 1);
        let events = world.ledger.outcome_events_of("s1").unwrap();
        assert!(events[0].signals.contains(&"revert_sha".to_string()));
    }

    #[test]
    fn a_revert_of_a_revert_of_a_fix_named_as_github_names_it_is_no_revert() {
        let (mut world, _) = written();
        let fix = fix_two(&world, T0 + 2 * DAY);
        let fixed = world.git(&["show", &format!("{fix}:f.js")], T0);
        world.git(&["revert", "--no-edit", &fix], T0 + 3 * DAY);
        let undo = world.git(&["rev-parse", "HEAD"], T0);
        world.commit(
            "f.js",
            &format!("{fixed}\n"),
            &format!("Revert \"Revert \"fix: wrong arguments\"\"\n\nThis reverts commit {undo}."),
            T0 + 4 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").unwrap().revert_commits, 0);
    }

    #[test]
    fn lines_moved_into_a_file_read_already_are_followed_on() {
        let mut world = World::new();
        let lib: &[&str] = &[
            "let one = helper(1);",
            "let two = helper(2);",
            "let three = helper(3);",
        ];
        std::fs::write(world.root().join("g.js"), "// lib base\n").unwrap();
        world.commit("f.js", "// base line one\n", "init", T0);
        std::fs::write(
            world.root().join("g.js"),
            format!("// lib base\n{}\n", lib.join("\n")),
        )
        .unwrap();
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", AGENT), ("g.js", lib)]);
        // Its lines move into g.js, which it also wrote, and on from there to h.js.
        std::fs::write(
            world.root().join("g.js"),
            format!("// lib base\n{}\n{}\n", lib.join("\n"), AGENT.join("\n")),
        )
        .unwrap();
        world.commit(
            "f.js",
            "// base line one\n",
            "Move compute into g",
            T0 + DAY,
        );
        std::fs::write(world.root().join("h.js"), format!("{}\n", AGENT.join("\n"))).unwrap();
        world.commit(
            "g.js",
            &format!("// lib base\n{}\n", lib.join("\n")),
            "Move compute into h",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.kinds("s1"), Vec::<(String, String)>::new());
    }

    #[test]
    fn a_fix_after_lines_moved_into_a_file_read_already_is_read_whole() {
        let mut world = World::new();
        let lib: &[&str] = &[
            "let one = helper(1);",
            "let two = helper(2);",
            "let three = helper(3);",
        ];
        std::fs::write(
            world.root().join("g.js"),
            format!("// lib base\n{}\n", lib.join("\n")),
        )
        .unwrap();
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", AGENT), ("g.js", lib)]);
        std::fs::write(
            world.root().join("g.js"),
            format!("// lib base\n{}\n{}\n", lib.join("\n"), AGENT.join("\n")),
        )
        .unwrap();
        world.commit(
            "f.js",
            "// base line one\n",
            "Move compute into g",
            T0 + DAY,
        );
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        world.commit(
            "g.js",
            &format!("// lib base\n{}\n{fixed}\n", lib.join("\n")),
            "fix: wrong arguments",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!((week.fix_commits, week.likely_fix_commits), (1, 1));
    }

    /// An `if err != nil { return err }` there before the session, which
    /// writes one of its own at the end of the file.
    fn a_check_before_and_one_of_its_own(world: &mut World) -> String {
        let filler: String = (0..12).map(|k| format!("// filler {k}\n")).collect();
        world.commit(
            "f.go",
            &format!("package x\nif err != nil {{\nreturn err\n}}\n{filler}// tail\n"),
            "init",
            T0 - HOUR,
        );
        filler
    }

    const GO: &[&str] = &[
        "if err != nil {",
        "return err",
        "x := compute(1)",
        "y := compute(2)",
    ];

    fn land_go(world: &mut World, filler: &str) {
        world.commit(
            "f.go",
            &format!(
                "package x\nif err != nil {{\nreturn err\n}}\n{filler}// tail\n\
                 if err != nil {{\nreturn err\n}}\nx := compute(1)\ny := compute(2)\n"
            ),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.go", GO)]);
    }

    #[test]
    fn a_branch_from_before_its_lines_landed_removes_only_lines_like_them() {
        let mut world = World::new();
        let filler = a_check_before_and_one_of_its_own(&mut world);
        world.git(&["branch", "topic"], T0);
        land_go(&mut world, &filler);
        // The old check goes on a branch from before, merged later.
        world.git(&["checkout", "--quiet", "topic"], T0);
        world.commit(
            "f.go",
            &format!("package x\n{filler}// tail\n"),
            "Drop old check",
            T0 + 2 * DAY,
        );
        world.git(&["checkout", "--quiet", "main"], T0);
        world.git(
            &["merge", "--quiet", "--no-ff", "--no-edit", "topic"],
            T0 + 3 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.kinds("s1"), Vec::<(String, String)>::new());
    }

    #[test]
    fn the_default_branch_without_its_work_removes_only_lines_like_its() {
        let mut world = World::new();
        let filler = a_check_before_and_one_of_its_own(&mut world);
        world.git(&["checkout", "--quiet", "-b", "feature"], T0);
        land_go(&mut world, &filler);
        // On the remote's default branch, which never had its work, the old check goes.
        world.git(&["checkout", "--quiet", "main"], T0);
        world.commit(
            "f.go",
            &format!("package x\n{filler}// tail\n"),
            "Drop old check",
            T0 + 2 * DAY,
        );
        world.git(&["update-ref", "refs/remotes/origin/main", "HEAD"], T0);
        world.git(
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
            T0,
        );
        world.git(&["checkout", "--quiet", "feature"], T0);
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(
            (week.rework_commits, week.scope.as_str()),
            (0, HEAD_AND_DEFAULT)
        );
    }

    #[test]
    fn lines_moved_before_the_session_ended_are_followed() {
        let (mut world, _) = written();
        // Still in the session: the file is renamed.
        world.git(&["mv", "f.js", "moved.js"], T0 + 90 * 60);
        world.git(&["commit", "--quiet", "-m", "Rename"], T0 + 90 * 60);
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        world.commit(
            "moved.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: wrong arguments",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!((week.fix_commits, week.lines_fixed), (1, 2.0));
    }

    #[test]
    fn lines_moved_away_and_copied_back_are_no_more_than_were_written() {
        let (mut world, _) = written();
        std::fs::write(world.root().join("g.js"), format!("{}\n", AGENT.join("\n"))).unwrap();
        world.commit("f.js", "// base line one\n", "Move compute", T0 + DAY);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Copy compute back",
            T0 + 2 * DAY,
        );
        // Each copy changed by a fix of its own: one of them is the session's.
        let fixed = AGENT
            .join("\n")
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        world.commit("g.js", &format!("{fixed}\n"), "fix: g", T0 + 3 * DAY);
        world.commit(
            "f.js",
            &format!("// base line one\n{fixed}\n"),
            "fix: f",
            T0 + 4 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(
            (week.fix_commits, week.lines_fixed),
            (1, 2.0),
            "{:?}",
            world.kinds("s1")
        );
    }

    #[test]
    fn commits_too_big_to_show_at_once_are_shown_in_halves() {
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", SIX.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", SIX)]);
        let mut lines: Vec<String> = SIX.iter().map(|s| s.to_string()).collect();
        for (k, at) in [(0, T0 + DAY), (2, T0 + 2 * DAY), (4, T0 + 3 * DAY)] {
            lines[k] = format!("{} // checked", lines[k]);
            lines[k + 1] = format!("{} // checked", lines[k + 1]);
            if k == 2 {
                // With a generated file more than is shown at once.
                let generated: String = (0..30_000)
                    .map(|n| format!("generated line number {n} with some padding text\n"))
                    .collect();
                assert!(generated.len() > MAX_SHOWN_BYTES);
                std::fs::write(world.root().join("generated.txt"), generated).unwrap();
            }
            world.commit(
                "f.js",
                &format!("// base line one\n{}\n", lines.join("\n")),
                &format!("fix: lines {k} and {}", k + 1),
                at,
            );
        }
        world.measure(T0 + 8 * DAY);
        let subjects: Vec<String> = world.kinds("s1").into_iter().map(|(_, s)| s).collect();
        assert_eq!(subjects, ["fix: lines 0 and 1", "fix: lines 4 and 5"]);
    }

    #[test]
    fn a_session_in_a_worktree_removed_since_is_read_from_its_repository() {
        // It ran in the worktree, or beside it and wrote in it.
        for in_it in [true, false] {
            let mut world = World::new();
            world.commit("f.js", "// base line one\n", "init", T0);
            let wt = world.dir.path().join("repo-task");
            world.git(
                &[
                    "worktree",
                    "add",
                    "--quiet",
                    "-b",
                    "task",
                    wt.to_str().unwrap(),
                ],
                T0,
            );
            commit_in(
                &wt,
                "f.js",
                &format!("// base line one\n{}\n", AGENT.join("\n")),
                "Add compute",
                T0 + HOUR,
            );
            let there = wt.join("f.js");
            let file = if in_it {
                "f.js"
            } else {
                there.to_str().unwrap()
            };
            let root = if in_it { wt.clone() } else { world.root() };
            world.session_in(
                &root,
                "claude-code",
                "s1",
                T0,
                T0 + 2 * HOUR,
                &[(file, AGENT)],
            );
            // A sync while it is there notes which repository it is of.
            world.measure(T0 + 2 * HOUR);
            world.git(&["merge", "--quiet", "--ff-only", "task"], T0 + 3 * HOUR);
            world.git(&["worktree", "remove", wt.to_str().unwrap()], T0 + 3 * HOUR);
            fix_two(&world, T0 + 3 * DAY);
            world.measure(T0 + 8 * DAY);
            let week = world.at("s1", "7d").expect("never counted");
            assert_eq!(
                (week.fix_commits, week.lines_fixed),
                (1, 2.0),
                "in it: {in_it}"
            );
        }
    }

    /// A worktree in the repository, at `<repo>/<at>`, ignored there, with
    /// the session's lines committed in it, merged and removed; noted on a
    /// sync while it was there when `seen`. The session ran in it, when
    /// `in_it`, or in the repository and wrote in it (a subagent's).
    fn a_worktree_inside(at: &str, seen: bool, in_it: bool) -> World {
        let mut world = World::new();
        let ignored = at.split('/').next().unwrap();
        world.commit(".gitignore", &format!("{ignored}/\n"), "ignore", T0);
        world.commit("f.js", "// base line one\n", "init", T0);
        let wt = world.root().join(at);
        world.git(
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "task",
                wt.to_str().unwrap(),
            ],
            T0,
        );
        commit_in(
            &wt,
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        let there = wt.join("f.js");
        let (root, file) = if in_it {
            (wt.clone(), "f.js")
        } else {
            (world.root(), there.to_str().unwrap())
        };
        world.session_in(
            &root,
            "claude-code",
            "s1",
            T0,
            T0 + 2 * HOUR,
            &[(file, AGENT)],
        );
        if seen {
            world.measure(T0 + 2 * HOUR);
        }
        world.git(&["merge", "--quiet", "--ff-only", "task"], T0 + 3 * HOUR);
        world.git(&["worktree", "remove", wt.to_str().unwrap()], T0 + 3 * HOUR);
        fix_two(&world, T0 + 3 * DAY);
        world.measure(T0 + 8 * DAY);
        world
    }

    #[test]
    fn a_worktree_claude_code_made_in_the_repository_is_read_there_once_removed() {
        // As Claude Code makes them: `<repo>/.claude/worktrees/<name>`.
        for (seen, in_it) in [(false, false), (false, true), (true, false), (true, true)] {
            let world = a_worktree_inside(".claude/worktrees/task", seen, in_it);
            let week = world
                .at("s1", "7d")
                .map(|w| (w.fix_commits, w.lines_tracked));
            assert_eq!(week, Some((1, 4)), "seen: {seen}, in it: {in_it}");
        }
    }

    #[test]
    fn a_worktree_in_the_repository_removed_unseen_is_not_read_as_the_repository() {
        // Its paths are no commit's there: read as they were, nothing would
        // ever have happened to its lines.
        let world = a_worktree_inside("work/task", false, false);
        assert_eq!(world.at("s1", "7d").map(|w| w.lines_tracked), None);
        let world = a_worktree_inside("work/task", true, false);
        let week = world
            .at("s1", "7d")
            .map(|w| (w.fix_commits, w.lines_tracked));
        assert_eq!(week, Some((1, 4)));
    }

    #[test]
    fn a_file_in_a_directory_that_is_gone_now_is_left_out() {
        // The repository removed `lib/` since: what is there now says nothing
        // of what was written in it.
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        let lib: &[&str] = &[
            "let one = helper(1);",
            "let two = helper(2);",
            "let three = helper(3);",
        ];
        world.commit(
            "lib/g.js",
            &format!("{}\n", lib.join("\n")),
            "Add helper",
            T0 + HOUR,
        );
        world.session(
            "s1",
            T0,
            T0 + 2 * HOUR,
            &[("f.js", AGENT), ("lib/g.js", lib)],
        );
        world.git(&["rm", "-r", "--quiet", "lib"], T0 + 2 * DAY);
        world.git(&["commit", "--quiet", "-m", "Drop lib"], T0 + 2 * DAY);
        fix_two(&world, T0 + 3 * DAY);
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").expect("never counted");
        assert_eq!(
            (week.lines_tracked, week.fix_commits, week.rework_commits),
            (4, 1, 0)
        );
    }

    #[test]
    fn a_repository_in_the_repository_that_is_a_plain_directory_now_is_read_as_one() {
        // `web/` had a repository of its own while a sync saw it; its `.git`
        // is removed since, and `web/` is a directory of the repository.
        let mut world = World::new();
        world.commit(".gitignore", "web/\n", "ignore", T0);
        world.commit("f.js", "// base line one\n", "init", T0);
        let web = world.root().join("web");
        std::fs::create_dir_all(&web).unwrap();
        git_in(&web, &["init", "--quiet"], T0);
        let lib: &[&str] = &[
            "let one = helper(1);",
            "let two = helper(2);",
            "let three = helper(3);",
        ];
        std::fs::write(web.join("g.js"), format!("{}\n", lib.join("\n"))).unwrap();
        world.session("s1", T0, T0 + 2 * HOUR, &[("web/g.js", lib)]);
        world.measure(T0 + 3 * HOUR);
        std::fs::remove_dir_all(web.join(".git")).unwrap();
        world.commit(".gitignore", "\n", "web is ours now", T0 + 3 * HOUR);
        let fixed = lib
            .join("\n")
            .replace("helper(1)", "helper(10)")
            .replace("helper(2)", "helper(20)");
        world.commit(
            "web/g.js",
            &format!("{fixed}\n"),
            "fix: helper arguments",
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").expect("never counted");
        assert_eq!((week.fix_commits, week.lines_tracked), (1, 3));
    }

    #[cfg(unix)]
    #[test]
    fn sessions_in_a_directory_that_is_gone_now_hold_up_no_command() {
        // A dozen sessions not due wrote in `lib/`, which the repository
        // removed since; and git is slow to say anything of it.
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        let lib: Vec<String> = (0..4)
            .map(|k| format!("let lib_{k} = make({k});"))
            .collect();
        let refs: Vec<&str> = lib.iter().map(String::as_str).collect();
        world.commit(
            "lib/g.js",
            &format!("{}\n", lib.join("\n")),
            "Add lib",
            T0 + 3 * HOUR,
        );
        for k in 0..12 {
            world.session(
                &format!("lib{k}"),
                T0 + 7 * DAY + k,
                T0 + 7 * DAY + k + 60,
                &[("lib/g.js", &refs)],
            );
        }
        world.git(&["rm", "-r", "--quiet", "lib"], T0 + 7 * DAY + HOUR);
        world.git(
            &["commit", "--quiet", "-m", "Drop lib"],
            T0 + 7 * DAY + HOUR,
        );
        let _git = FakeGit::new(r#"for a in "$@"; do [ "$a" = lib ] && sleep 1; done"#);
        world.measure_for(T0 + 8 * DAY, WAITED_FOR);
        assert_eq!(world.at("s1", "7d").expect("never counted").fix_commits, 1);
    }

    #[test]
    fn a_second_repository_away_does_not_hold_the_count_from_the_first() {
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        let other = World::new();
        let lib: &[&str] = &[
            "let one = helper(1);",
            "let two = helper(2);",
            "let three = helper(3);",
        ];
        other.commit("g.js", "// lib base\n", "init", T0);
        other.commit(
            "g.js",
            &format!("// lib base\n{}\n", lib.join("\n")),
            "Add helper",
            T0 + HOUR,
        );
        let g = other.root().join("g.js");
        world.session(
            "s1",
            T0,
            T0 + 2 * HOUR,
            &[("f.js", AGENT), (g.to_str().unwrap(), lib)],
        );
        // A sync while both are there notes them.
        world.measure(T0 + 3 * HOUR);
        let fixed = lib
            .join("\n")
            .replace("helper(1)", "helper(10)")
            .replace("helper(2)", "helper(20)");
        other.commit(
            "g.js",
            &format!("// lib base\n{fixed}\n"),
            "fix: helper arguments",
            T0 + 4 * DAY,
        );
        // The second repository is away (an unmounted disk, a moved folder,
        // a scratch clone deleted for good): counted from the first.
        std::fs::rename(other.root(), other.dir.path().join("away")).unwrap();
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").expect("never counted");
        assert_eq!((week.fix_commits, week.lines_tracked), (1, 4));
        assert_eq!(world.target("s1").failures, 0);
    }

    #[test]
    fn a_commit_dated_before_the_session_after_its_own_hides_nothing() {
        // A teammate's commit, rebased with its author's date days before the
        // session, lands between the session's commit and a fix.
        let (mut world, _) = written();
        world.commit("g.js", "// theirs\n", "Add theirs", T0 - 3 * DAY);
        fix_two(&world, T0 + 3 * DAY);
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").expect("never counted").fix_commits, 1);
    }

    #[cfg(unix)]
    #[test]
    fn git_before_2_41_reads_from_the_date_as_it_can() {
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        let _git = FakeGit::new(
            r#"[ "$1" = version ] && { echo "git version 2.40.1"; exit 0; }
               for a in "$@"; do case "$a" in --since-as-filter=*) exit 129;; esac; done"#,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").expect("never counted").fix_commits, 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_session_whose_reading_fails_fails_no_other_read_with_it() {
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        let lib: &[&str] = &[
            "let one = helper(1);",
            "let two = helper(2);",
            "let three = helper(3);",
        ];
        world.commit(
            "bad.js",
            &format!("{}\n", lib.join("\n")),
            "Add bad",
            T0 + HOUR,
        );
        world.session("s2", T0, T0 + 2 * HOUR, &[("bad.js", lib)]);
        // Git cannot read the history of one of its files (given it to read).
        let _git = FakeGit::new(
            r#"if [ "$*" != "${*#*rev-list}" ]; then
                 given=$(cat)
                 case "$given" in *bad.js*) exit 128;; esac
                 printf '%s\n' "$given" | exec git "$@"
               fi"#,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").expect("s1 failed").fix_commits, 1);
        assert_eq!(world.target("s2").failures, 1);
    }

    /// Sessions `s<n>` in one repository, each with a file of its own, `f<n>.js`.
    #[cfg(unix)]
    fn sessions_of_their_own(sessions: &[i64]) -> World {
        let mut world = World::new();
        world.commit("base.js", "// base\n", "init", T0);
        for &n in sessions {
            let lines: Vec<String> = (0..4)
                .map(|k| format!("let v{n}_{k} = compute({n}, {k});"))
                .collect();
            let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
            let file = format!("f{n}.js");
            world.commit(&file, &format!("{}\n", lines.join("\n")), "Add", T0 + HOUR);
            world.session(
                &format!("s{n}"),
                T0 + n,
                T0 + 2 * HOUR + n,
                &[(&file, &refs)],
            );
        }
        world
    }

    /// Each listing takes 0.4 s; a reading of both sessions' files fails after
    /// 1.2 s more (as one with a path git will not take does).
    #[cfg(unix)]
    const BOTH_FAIL_SLOWLY: &str = r#"both=0; for a in "$@"; do [ "$a" = rev-list ] && sleep 0.4; [ "$a" = f0.js ] && both=$((both+1)); [ "$a" = f1.js ] && both=$((both+1)); done; [ $both = 2 ] && { sleep 1.2; exit 128; }"#;

    #[cfg(unix)]
    #[test]
    fn a_half_a_slow_failure_left_no_time_is_not_taken_for_too_slow() {
        let budget = Budget {
            all: Duration::from_secs(10),
            repo: Duration::from_secs(2),
            waited: false,
        };
        // Alone, the newer session is read well within the repository's time.
        let mut alone = sessions_of_their_own(&[1]);
        {
            let _git = FakeGit::new(BOTH_FAIL_SLOWLY);
            alone.measure_for(T0 + 8 * DAY, budget);
        }
        assert!(alone.at("s1", "7d").is_some());
        // After a reading of both failed slowly, there is not time enough
        // left for it: it is read on the next sync, the older after.
        let mut world = sessions_of_their_own(&[0, 1]);
        let _git = FakeGit::new(BOTH_FAIL_SLOWLY);
        world.measure_for(T0 + 8 * DAY, budget);
        assert_eq!(world.target("s1").failures, 0, "taken for too slow");
        world.measure_for(T0 + 8 * DAY, budget);
        assert!(world.at("s1", "7d").is_some());
        world.measure_for(T0 + 8 * DAY + HOUR, budget);
        assert!(world.at("s0", "7d").is_some());
    }

    #[cfg(unix)]
    #[test]
    fn a_repository_whose_readings_fail_leaves_the_next_its_time() {
        let budget = Budget {
            all: Duration::from_secs(6),
            repo: Duration::from_secs(2),
            waited: false,
        };
        // Four sessions in one repository, never read, and one in another,
        // read once at a day.
        let mut world = sessions_of_their_own(&[0, 1, 2, 3]);
        let other = World::new();
        other.commit("g.js", "// lib base\n", "init", T0);
        let lib: &[&str] = &[
            "let one = helper(1);",
            "let two = helper(2);",
            "let three = helper(3);",
        ];
        other.commit(
            "g.js",
            &format!("// lib base\n{}\n", lib.join("\n")),
            "Add helper",
            T0 + HOUR,
        );
        let g = other.root().join("g.js");
        world.session_in(
            &other.root(),
            "claude-code",
            "b",
            T0 - DAY,
            T0 - DAY + 2 * HOUR,
            &[(g.to_str().unwrap(), lib)],
        );
        world.measure_for(T0 + 3 * HOUR, budget);
        assert!(world.at("b", "1d").is_some());
        // Now a reading of two of the four or more fails after 1.5 s, and the
        // other repository takes 1.6 s of its 2.
        let _git = FakeGit::new(&format!(
            r#"n=0; for a in "$@"; do case "$a" in f0.js|f1.js|f2.js|f3.js) n=$((n+1));; esac; done
               [ $n -ge 2 ] && {{ sleep 1.5; exit 128; }}
               case "$2" in "{}"*) for a in "$@"; do [ "$a" = rev-list ] && sleep 1.6; done;; esac"#,
            other.root().display()
        ));
        world.measure_for(T0 + 8 * DAY, budget);
        assert_eq!(world.target("b").failures, 0, "taken for too slow");
        assert!(world.at("b", "7d").is_some());
    }

    #[cfg(unix)]
    #[test]
    fn a_slow_failure_that_leaves_a_sync_no_time_is_not_tried_again_first() {
        // After the reading of both, no time is left for a half: on the next
        // sync, the other is read alone.
        let budget = Budget {
            all: Duration::from_secs(2),
            repo: Duration::from_secs(2),
            waited: false,
        };
        let mut world = sessions_of_their_own(&[0, 1]);
        let _git = FakeGit::new(BOTH_FAIL_SLOWLY);
        world.measure_for(T0 + 8 * DAY, budget);
        world.measure_for(T0 + 8 * DAY, budget);
        let read: Vec<bool> = (0..2)
            .map(|n| world.at(&format!("s{n}"), "7d").is_some())
            .collect();
        assert!(read.contains(&true), "neither read: {read:?}");
    }

    #[test]
    fn a_path_out_of_the_repository_fails_no_session_read_with_it() {
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        // Another session also wrote a note beside the repository, named from inside it.
        let lib: &[&str] = &[
            "let one = helper(1);",
            "let two = helper(2);",
            "let three = helper(3);",
        ];
        world.commit("g.js", &format!("{}\n", lib.join("\n")), "Add g", T0 + HOUR);
        world.session(
            "s2",
            T0,
            T0 + 2 * HOUR,
            &[("g.js", lib), ("../notes.md", &["Some long note line"])],
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").unwrap().fix_commits, 1);
        assert_eq!(world.at("s2", "7d").unwrap().lines_tracked, 3);
    }

    #[test]
    fn sessions_with_more_paths_than_a_command_line_is_given_are_read() {
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        // Each with paths before `f.js`, several times what one command
        // line is given of them.
        let many = |tag: &str| -> Vec<(String, String)> {
            let files: Vec<(String, String)> = (0..MOST_PATH_BYTES / 10)
                .map(|i| {
                    (
                        format!("aaa/{tag}/some/deeper/directory/file_{i:06}.js"),
                        format!("const v{i} = {i};"),
                    )
                })
                .collect();
            let bytes: usize = files.iter().map(|(path, _)| path.len()).sum();
            assert!(bytes > 4 * MOST_PATH_BYTES);
            files
        };
        for (id, tag) in [("s1", "aaaa"), ("s2", "bbbb")] {
            let files = many(tag);
            let mut all: Vec<(&str, Vec<&str>)> = files
                .iter()
                .map(|(path, line)| (path.as_str(), vec![line.as_str()]))
                .collect();
            all.push(("f.js", AGENT.to_vec()));
            let all: Vec<(&str, &[&str])> = all.iter().map(|(p, l)| (*p, l.as_slice())).collect();
            world.session(id, T0, T0 + 2 * HOUR, &all);
        }
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").unwrap().fix_commits, 1);
        assert_eq!(world.at("s2", "7d").unwrap().fix_commits, 1);
    }

    #[test]
    fn a_path_is_taken_as_written_without_dots() {
        assert_eq!(
            lexical(Path::new("/a/repo/../notes.md")),
            PathBuf::from("/a/notes.md")
        );
        assert_eq!(lexical(Path::new("/a/./b/c")), PathBuf::from("/a/b/c"));
        assert_eq!(lexical(Path::new("/../x")), PathBuf::from("/x"));
        assert_eq!(lexical(Path::new("a/../../x")), PathBuf::from("../x"));
    }

    #[test]
    fn a_partial_clone_fetches_what_it_needs_to_read_a_commit() {
        let (src, _) = written();
        fix_two(&src, T0 + 3 * DAY);
        src.git(&["config", "uploadpack.allowFilter", "true"], T0);
        let mut world = World::new();
        let clone = world.dir.path().join("clone");
        let url = format!("file://{}", src.root().display());
        git_in(
            world.dir.path(),
            &[
                "clone",
                "--quiet",
                "--filter=blob:none",
                &url,
                clone.to_str().unwrap(),
            ],
            T0,
        );
        // As git since 2.24 makes one: it says so of its remote.
        let config = git_in(&clone, &["config", "--get-regexp", "promisor"], T0);
        assert_eq!(config, "remote.origin.promisor true");
        world.session_in(
            &clone,
            "claude-code",
            "c1",
            T0,
            T0 + 2 * HOUR,
            &[("f.js", AGENT)],
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("c1", "7d").expect("never read").fix_commits, 1);
    }

    #[test]
    fn what_says_a_clone_is_partial() {
        assert!(partial("remote.origin.promisor true"));
        assert!(partial("remote.origin.promisor"));
        assert!(partial("extensions.partialclone origin"));
        assert!(!partial("remote.origin.promisor false"));
        assert!(!partial(""));
    }

    #[test]
    fn a_commit_git_leaves_out_of_what_it_shows_fails_them_all() {
        let (a, b, c) = ("a".repeat(40), "b".repeat(40), "c".repeat(40));
        let all = format!("{a}\n-x\n{b}\n{c}\n+y\n");
        let parts = split_tree(&all, &[&a, &b, &c]).unwrap();
        assert_eq!((parts[&a], parts[&b], parts[&c]), ("-x\n", "", "+y\n"));
        // `b` left out: what follows is not taken for its.
        let skipped = format!("{a}\n-x\n{c}\n+y\n");
        assert_eq!(split_tree(&skipped, &[&a, &b, &c]), Err(Stop::Failed));
        assert_eq!(
            split_tree(&format!("{a}\n{b}\n"), &[&a, &b, &c]),
            Err(Stop::Failed)
        );
    }

    #[test]
    fn a_line_removed_and_added_again_in_one_file_stays_there() {
        let of = |removed: &[u64], added: &[u64]| FileDiff {
            removed: removed.iter().map(|h| (*h, 1)).collect(),
            added: added.iter().map(|h| (*h, 1)).collect(),
        };
        // z.ts moves line 1 within itself; b.ts gets a copy of it, and line 2
        // moves from z.ts to b.ts.
        let files: HashMap<String, FileDiff> = [
            ("z.ts".to_string(), of(&[1, 2], &[1])),
            ("b.ts".to_string(), of(&[], &[1, 2])),
        ]
        .into_iter()
        .collect();
        let (files, removed, moves) = unmoved(files);
        assert_eq!(moves, [("z.ts".to_string(), "b.ts".to_string(), 2, 1)]);
        assert_eq!(removed, 0.0);
        assert!(files["z.ts"].added.is_empty());
        assert_eq!(files["b.ts"].added, HashMap::from([(1, 1)]));
    }

    #[test]
    fn a_directory_moved_whole_is_read_in_a_moment() {
        let mut files: HashMap<String, FileDiff> = HashMap::new();
        for f in 0..2_000u64 {
            let (mut old, mut new) = (FileDiff::default(), FileDiff::default());
            for k in 0..50 {
                old.removed.insert(f * 1000 + k, 1);
                new.added.insert(f * 1000 + k, 1);
            }
            files.insert(format!("src/module_{f}/file.js"), old);
            files.insert(format!("packages/app/src/module_{f}/file.js"), new);
        }
        let started = Instant::now();
        let (files, removed, moves) = unmoved(files);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert_eq!((moves.len(), removed), (100_000, 0.0));
        assert!(files
            .values()
            .all(|d| d.added.is_empty() && d.removed.is_empty()));
    }

    #[test]
    fn what_no_session_holds_costs_nothing_however_many_sessions_there_are() {
        let at = |t: i64| DateTime::from_timestamp(t, 0).unwrap();
        let n = 2_000;
        let targets: Vec<OutcomeTarget> = (0..n)
            .map(|i| OutcomeTarget {
                session_id: format!("s{i}"),
                source: "claude-code".into(),
                started_at: at(T0 - (n - i) as i64 * HOUR),
                ended_at: at(T0 - (n - i) as i64 * HOUR + 1800),
                base: None,
                repo: None,
                files: Vec::new(),
                scanned_until: None,
                tried_at: None,
                scope: None,
                failures: 0,
                tracked: None,
                kept: Vec::new(),
            })
            .collect();
        let sessions: Vec<InRepo> = (0..n)
            .map(|i| InRepo {
                target: i,
                files: vec![(
                    format!("src/s{i}.js"),
                    (0..50u64).map(|h| h + 1_000_000 * i as u64).collect(),
                )],
                roots: BTreeSet::new(),
            })
            .collect();
        // 200 commits read whole, each rewriting 1,000 lines of a file no session wrote.
        let commits: Vec<Commit> = (0..200u64)
            .map(|k| {
                let mut diff = FileDiff::default();
                for h in 0..1000u64 {
                    diff.removed.insert(u64::MAX - k * 10_000 - h, 1);
                    diff.added.insert(u64::MAX / 2 - k * 10_000 - h, 1);
                }
                Commit {
                    sha: format!("{k:040x}"),
                    at: T0 + DAY + k as i64,
                    parents: if k == 0 {
                        Vec::new()
                    } else {
                        vec![format!("{:040x}", k - 1)]
                    },
                    message: "refactor".into(),
                    files: HashMap::from([(format!("vendor/big{k}.js"), diff)]),
                    removed_total: Some(1000.0),
                    moves: Vec::new(),
                }
            })
            .collect();
        let scanned: HashSet<usize> = (0..n).collect();
        let started = Instant::now();
        let far = Instant::now() + Duration::from_secs(60);
        let events = attribute(
            &commits,
            &sessions,
            &targets,
            &Words::default(),
            &scanned,
            far,
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(events, Ok(Vec::new()));
    }

    #[cfg(unix)]
    #[test]
    fn repositories_are_told_apart_by_a_git_older_than_2_31() {
        // Git before 2.31 does not know `--path-format`: it prints it back,
        // then what it would say without it.
        let _git = FakeGit::new(
            r#"for a in "$@"; do if [ "$a" = --path-format=absolute ]; then
  args=(); for b in "$@"; do [ "$b" = --path-format=absolute ] || args+=("$b"); done
  out=$(git "${args[@]}") || exit $?
  printf -- '--path-format=absolute\n%s\n' "$out"; exit 0
fi; done"#,
        );
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        let other = World::new();
        other.commit("f.js", "// base line one\n", "init", T0);
        other.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        world.session_in(
            &other.root(),
            "claude-code",
            "s2",
            T0,
            T0 + 2 * HOUR,
            &[("f.js", AGENT)],
        );
        fix_two(&other, T0 + 4 * DAY);
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").expect("s1").fix_commits, 1);
        assert_eq!(world.at("s2", "7d").expect("s2").fix_commits, 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_slow_repository_waits_and_leaves_time_for_the_rest() {
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        let slow = World::new();
        slow.commit("base.js", "// base\n", "init", T0);
        for n in 0..4i64 {
            let lines: Vec<String> = (0..4)
                .map(|k| format!("let v{n}_{k} = compute({n}, {k});"))
                .collect();
            let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
            let file = format!("f{n}.js");
            slow.commit(&file, &format!("{}\n", lines.join("\n")), "Add", T0 + HOUR);
            world.session_in(
                &slow.root(),
                "claude-code",
                &format!("slow{n}"),
                T0 + n,
                T0 + 2 * HOUR + n,
                &[(&file, &refs)],
            );
        }
        let _git = FakeGit::slow_in(&slow.root());
        let budget = Budget {
            all: Duration::from_secs(6),
            repo: Duration::from_secs(2),
            waited: false,
        };
        let failures = |w: &World| -> Vec<u32> {
            (0..4)
                .map(|n| w.target(&format!("slow{n}")).failures)
                .collect()
        };
        let started = Instant::now();
        world.measure_for(T0 + 8 * DAY, budget);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(world.at("s1", "7d").expect("not read").fix_commits, 1);
        // The older half waits to be tried again; the newer is read on the next sync.
        assert_eq!(failures(&world), [1, 1, 0, 0]);
        world.measure_for(T0 + 8 * DAY + 60, budget);
        assert_eq!(failures(&world), [1, 1, 1, 0]);
        world.measure_for(T0 + 8 * DAY + 120, budget);
        assert_eq!(failures(&world), [1, 1, 1, 1]);
        // Then none is tried for an hour.
        let started = Instant::now();
        world.measure_for(T0 + 8 * DAY + 180, budget);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(failures(&world), [1, 1, 1, 1]);
    }

    #[cfg(unix)]
    #[test]
    fn the_repository_tried_longest_ago_is_read_first() {
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        // Before the other one, as repositories are kept in order; two
        // sessions in it, one newer.
        let slow = world.dir.path().join("a-slow");
        std::fs::create_dir(&slow).unwrap();
        git_in(&slow, &["init", "--quiet"], T0);
        for (n, file) in ["f.js", "g.js"].iter().enumerate() {
            let lines: Vec<String> = SIX.iter().map(|l| format!("{l} // {file}")).collect();
            let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
            commit_in(
                &slow,
                file,
                &format!("{}\n", lines.join("\n")),
                "Add",
                T0 + HOUR,
            );
            let ended = T0 + 2 * HOUR + n as i64;
            world.session_in(
                &slow,
                "claude-code",
                &format!("slow{n}"),
                T0,
                ended,
                &[(file, &lines)],
            );
        }
        let _git = FakeGit::slow_in(&slow);
        let budget = Budget {
            all: Duration::from_secs(2),
            repo: Duration::from_secs(2),
            waited: false,
        };
        // The slow one takes all the time there is: the older session waits,
        world.measure_for(T0 + 8 * DAY, budget);
        let failures = |w: &World| (w.target("slow0").failures, w.target("slow1").failures);
        assert_eq!(failures(&world), (1, 0));
        assert!(world.at("s1", "7d").is_none());
        // and the next sync reads the other one first.
        world.measure_for(T0 + 8 * DAY + 60, budget);
        assert!(world.at("s1", "7d").is_some());
        assert_eq!(failures(&world), (1, 1));
    }

    #[cfg(unix)]
    #[test]
    fn a_command_leaves_a_repository_too_slow_to_wait_for_to_a_sync_nobody_waits_for() {
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        let git = FakeGit::slow_in(&world.root());
        let waited = Budget {
            all: Duration::from_secs(2),
            repo: Duration::from_secs(2),
            waited: true,
        };
        world.measure_for(T0 + 8 * DAY, waited);
        assert_eq!(world.target("s1").failures, 1, "too slow");
        // An hour later a command does not wait for it again,
        let started = Instant::now();
        world.measure_for(T0 + 8 * DAY + RETRY_AFTER, waited);
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(world.target("s1").failures, 1);
        // and a sync nobody waits for reads it.
        drop(git);
        world.measure(T0 + 8 * DAY + RETRY_AFTER + 1);
        assert_eq!(world.at("s1", "7d").expect("not read").fix_commits, 1);
    }

    #[cfg(unix)]
    #[test]
    fn finding_which_repository_a_worktree_is_of_takes_the_syncs_time() {
        let (mut world, _) = written();
        let _git =
            FakeGit::new(r#"for a in "$@"; do [ "$a" = --git-common-dir ] && exec sleep 30; done"#);
        let budget = Budget {
            all: Duration::from_secs(1),
            repo: Duration::from_secs(1),
            waited: false,
        };
        let started = Instant::now();
        world.measure_for(T0 + 8 * DAY, budget);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
        // Neither read nor failed: read on another sync.
        let t = world.target("s1");
        assert_eq!((t.tried_at, t.failures), (None, 0));
    }

    #[cfg(unix)]
    #[test]
    fn a_branch_that_cannot_be_read_fails_the_reading() {
        for (in_worktree, name) in [(true, "HEAD"), (false, "refs/remotes/origin/HEAD")] {
            let (mut world, _) = written();
            let wt = world.dir.path().join("wt");
            world.git(
                &[
                    "worktree",
                    "add",
                    "--quiet",
                    wt.to_str().unwrap(),
                    "-b",
                    "side",
                ],
                T0,
            );
            let other = wt.join("f.js");
            world.session(
                "s1",
                T0,
                T0 + 2 * HOUR,
                &[("f.js", AGENT), (other.to_str().unwrap(), AGENT)],
            );
            fix_two(&world, T0 + 3 * DAY);
            // As git answers in a repository it will not read (not this
            // person's), or one it cannot.
            let at = if in_worktree {
                wt.clone()
            } else {
                world.root()
            };
            let _git = FakeGit::new(&format!(
                r#"if [ "$2" = "{}" ]; then for a in "$@"; do [ "$a" = "{name}" ] && exit 128; done; fi"#,
                at.display()
            ));
            world.measure(T0 + 8 * DAY);
            assert!(world.at("s1", "7d").is_none(), "{name}");
            assert_eq!(world.target("s1").failures, 1, "{name}");
        }
    }

    /// `main` is the remote's default branch.
    fn main_is_the_default(world: &World) {
        world.git(&["update-ref", "refs/remotes/origin/main", "main"], T0);
        world.git(
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
            T0,
        );
    }

    /// The session's work is on a feature branch; on main a teammate adds a
    /// check of their own while it runs (with `extra` lines). The check's SHA.
    fn a_teammates_check_on_main(world: &mut World, extra: &str) -> (String, String) {
        let filler: String = (0..12).map(|k| format!("// filler {k}\n")).collect();
        world.commit(
            "f.go",
            &format!("package x\n{filler}// tail\n"),
            "init",
            T0 - HOUR,
        );
        world.git(&["checkout", "--quiet", "-b", "feature"], T0);
        world.commit(
            "f.go",
            &format!(
                "package x\n{filler}// tail\nif err != nil {{\nreturn err\n}}\n\
                 x := compute(1)\ny := compute(2)\n"
            ),
            "Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.go", GO)]);
        world.git(&["checkout", "--quiet", "main"], T0);
        let check = world.commit(
            "f.go",
            &format!("package x\nif err != nil {{\nreturn err\n}}\n{extra}{filler}// tail\n"),
            "Check the error",
            T0 + 30 * 60,
        );
        (check, filler)
    }

    #[test]
    fn a_check_a_teammate_adds_on_main_while_it_runs_is_not_its_lines() {
        let mut world = World::new();
        let (_, filler) = a_teammates_check_on_main(&mut world, "");
        world.commit(
            "f.go",
            &format!("package x\n{filler}// tail\n"),
            "Drop the check",
            T0 + 2 * DAY,
        );
        main_is_the_default(&world);
        world.git(&["checkout", "--quiet", "feature"], T0);
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(week.rework_commits, 0, "{:?}", world.kinds("s1"));
    }

    #[test]
    fn a_revert_of_a_teammates_check_on_main_is_no_revert_of_it() {
        let mut world = World::new();
        let (check, _) = a_teammates_check_on_main(&mut world, "");
        world.git(&["revert", "--no-edit", &check], T0 + 2 * DAY);
        main_is_the_default(&world);
        world.git(&["checkout", "--quiet", "feature"], T0);
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(week.revert_commits, 0, "{:?}", world.kinds("s1"));
    }

    #[test]
    fn a_check_with_more_lines_on_main_is_not_its_lines_whichever_is_walked_first() {
        let extra = "let p = one();\nlet q = two();\nlet r = three();\nlet s = four();\n";
        // The feature branch with a newer commit, or not: which is walked first.
        for newer_on_feature in [false, true] {
            let mut world = World::new();
            let (_, filler) = a_teammates_check_on_main(&mut world, extra);
            world.commit(
                "f.go",
                &format!("package x\n{extra}{filler}// tail\n"),
                "Drop the check",
                T0 + 2 * DAY,
            );
            main_is_the_default(&world);
            world.git(&["checkout", "--quiet", "feature"], T0);
            if newer_on_feature {
                world.commit(
                    "f.go",
                    &format!(
                        "package x\n// a comment\n{filler}// tail\nif err != nil {{\nreturn err\n}}\n\
                         x := compute(1)\ny := compute(2)\n"
                    ),
                    "Comment",
                    T0 + 3 * DAY,
                );
            }
            world.measure(T0 + 8 * DAY);
            let week = world.at("s1", "7d").unwrap();
            assert_eq!(
                week.rework_commits,
                0,
                "newer on feature: {newer_on_feature} {:?}",
                world.kinds("s1")
            );
        }
    }

    #[test]
    fn a_check_with_more_lines_on_the_branch_checked_out_is_not_its_lines() {
        let extra = "let p = one();\nlet q = two();\nlet r = three();\nlet s = four();\n";
        let mut world = World::new();
        let (_, filler) = a_teammates_check_on_main(&mut world, extra);
        world.commit(
            "f.go",
            &format!("package x\n{extra}{filler}// tail\n"),
            "Drop the check",
            T0 + 2 * DAY,
        );
        // The remote's default branch has the work; main, checked out, the check.
        world.git(&["update-ref", "refs/remotes/origin/main", "feature"], T0);
        world.git(
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
            T0,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(week.rework_commits, 0, "{:?}", world.kinds("s1"));
    }

    #[test]
    fn lines_landed_a_little_at_a_time_count() {
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT[..2].join("\n")),
            "Add alpha and beta",
            T0 + HOUR,
        );
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Add gamma and the sum",
            T0 + HOUR + 60,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", AGENT)]);
        fix_two(&world, T0 + 3 * DAY);
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!((week.fix_commits, week.lines_fixed), (1, 2.0));
    }

    #[test]
    fn a_revert_of_a_reapply_is_a_revert() {
        let (mut world, landing) = written();
        world.git(&["revert", "--no-edit", &landing], T0 + 2 * DAY);
        let revert = world.git(&["rev-parse", "HEAD"], T0);
        world.git(&["revert", "--no-edit", &revert], T0 + 3 * DAY);
        let reapply = world.git(&["rev-parse", "HEAD"], T0);
        world.git(&["revert", "--no-edit", &reapply], T0 + 4 * DAY);
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        assert_eq!(
            (week.revert_commits, week.relanded),
            (2, false),
            "{:?}",
            world.kinds("s1")
        );
    }

    #[test]
    fn a_conventional_revert_of_its_commit_by_subject_is_a_revert() {
        // A revert written by hand, no "This reverts" line: git's title after
        // the type, or the word again.
        for subject in [
            "revert: Revert \"Add compute\"",
            "revert: revert compute, it double counts",
        ] {
            let (mut world, _) = written();
            world.commit("f.js", "// base line one\n", subject, T0 + 2 * DAY);
            world.measure(T0 + 8 * DAY);
            assert_eq!(
                week_of(&world, "s1"),
                Some((0, 0.0, 0, 1)),
                "{subject}: {:?}",
                world.kinds("s1")
            );
        }
    }

    #[test]
    fn a_git_revert_of_a_commit_titled_revert_to_is_a_revert() {
        // The session's own commit begins with the word ("Revert to polling"):
        // `git revert` of it takes all its lines out.
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        let landing = world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Revert to polling for compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", AGENT)]);
        world.git(&["revert", "--no-edit", &landing], T0 + 2 * DAY);
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            week_of(&world, "s1").map(|w| w.3),
            Some(1),
            "{:?}",
            world.kinds("s1")
        );
    }

    /// Main fixes two of its lines; a feature branch from after it landed
    /// reworks the same two. With `newer_on_main`, main has a newer commit,
    /// which changes only the order git walks them in.
    fn fixed_on_main_and_reworked_on_a_branch(newer_on_main: bool) -> (u64, u64) {
        let (mut world, _) = written();
        world.git(&["branch", "feature"], T0);
        fix_two(&world, T0 + 2 * DAY);
        if newer_on_main {
            let content = world.git(&["show", "HEAD:f.js"], T0);
            world.commit(
                "f.js",
                &format!("// a comment\n{content}\n"),
                "Comment",
                T0 + 4 * DAY,
            );
        }
        main_is_the_default(&world);
        world.git(&["checkout", "--quiet", "feature"], T0);
        let reworked = AGENT
            .join("\n")
            .replace("compute(1)", "compute(1, opts)")
            .replace("compute(2)", "compute(2, opts)");
        world.commit(
            "f.js",
            &format!("// base line one\n{reworked}\n"),
            "Pass the options",
            T0 + 3 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        let week = world.at("s1", "7d").unwrap();
        (week.fix_commits, week.rework_commits)
    }

    #[test]
    fn which_branch_is_walked_first_does_not_change_the_count() {
        assert_eq!(fixed_on_main_and_reworked_on_a_branch(false), (1, 1));
        assert_eq!(fixed_on_main_and_reworked_on_a_branch(true), (1, 1));
    }

    #[test]
    fn a_squash_merge_of_its_branch_lands_its_lines() {
        // Its branch's worktree still there, or removed.
        for keep_branch in [false, true] {
            let mut world = World::new();
            world.commit("f.js", "// base line one\n", "init", T0);
            let wt = world.dir.path().join("wt");
            world.git(
                &[
                    "worktree",
                    "add",
                    "--quiet",
                    "-b",
                    "feat",
                    wt.to_str().unwrap(),
                ],
                T0,
            );
            commit_in(
                &wt,
                "f.js",
                &format!("// base line one\n{}\n", AGENT.join("\n")),
                "Add compute",
                T0 + HOUR,
            );
            world.session_in(
                &wt,
                "claude-code",
                "s1",
                T0,
                T0 + 2 * HOUR,
                &[("f.js", AGENT)],
            );
            world.measure(T0 + 2 * HOUR);
            world.git(&["merge", "--squash", "feat"], T0 + 3 * HOUR);
            world.git(
                &["commit", "--quiet", "-m", "Add compute (#1)"],
                T0 + 3 * HOUR,
            );
            fix_two(&world, T0 + 3 * DAY);
            main_is_the_default(&world);
            if !keep_branch {
                world.git(
                    &["worktree", "remove", "--force", wt.to_str().unwrap()],
                    T0 + 4 * HOUR,
                );
            }
            world.measure(T0 + 8 * DAY);
            let week = world.at("s1", "7d").expect("never counted");
            assert_eq!(
                (week.fix_commits, week.lines_fixed),
                (1, 2.0),
                "branch kept: {keep_branch} {:?}",
                world.kinds("s1")
            );
        }
    }

    #[test]
    fn a_worktree_path_that_is_another_repository_now_fails_no_reading() {
        let (mut world, _) = written();
        let wt = world.dir.path().join("wt");
        world.git(
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "task",
                wt.to_str().unwrap(),
            ],
            T0,
        );
        let other: &[&str] = &[
            "let x1 = other(1);",
            "let x2 = other(2);",
            "let x3 = other(3);",
        ];
        commit_in(
            &wt,
            "g.js",
            &format!("{}\n", other.join("\n")),
            "Add other",
            T0 + HOUR,
        );
        world.session_in(
            &wt,
            "claude-code",
            "s2",
            T0,
            T0 + 2 * HOUR,
            &[("g.js", other)],
        );
        world.measure(T0 + 2 * HOUR);
        // The worktree goes, and a repository of its own takes its place.
        world.git(
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
            T0 + 3 * HOUR,
        );
        std::fs::create_dir(&wt).unwrap();
        git_in(&wt, &["init", "--quiet"], T0);
        let third: &[&str] = &[
            "let y1 = third(1);",
            "let y2 = third(2);",
            "let y3 = third(3);",
        ];
        commit_in(
            &wt,
            "k.js",
            &format!("{}\n", third.join("\n")),
            "Add third",
            T0 + 5 * HOUR,
        );
        world.session_in(
            &wt,
            "claude-code",
            "s3",
            T0 + 4 * HOUR,
            T0 + 6 * HOUR,
            &[("k.js", third)],
        );
        fix_two(&world, T0 + 3 * DAY);
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            world.at("s1", "7d").map(|w| w.fix_commits),
            Some(1),
            "s1 never counted"
        );
        assert_eq!(world.at("s3", "7d").map(|w| w.lines_tracked), Some(3));
        assert_eq!(world.target("s3").failures, 0);
    }

    #[test]
    fn an_old_worktree_broken_since_fails_no_reading_of_its_repository() {
        let (mut world, _) = written();
        let wt = world.dir.path().join("old-wt");
        world.git(
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "task",
                wt.to_str().unwrap(),
            ],
            T0,
        );
        // A session long ago in the worktree, all its ages counted.
        let other: &[&str] = &[
            "let x1 = other(1);",
            "let x2 = other(2);",
            "let x3 = other(3);",
        ];
        commit_in(
            &wt,
            "g.js",
            &format!("{}\n", other.join("\n")),
            "Add other",
            T0 - 60 * DAY,
        );
        world.session_in(
            &wt,
            "claude-code",
            "old",
            T0 - 61 * DAY,
            T0 - 60 * DAY,
            &[("g.js", other)],
        );
        world.measure(T0 + 2 * HOUR);
        assert!(world.at("old", "30d").is_some());
        // Its administrative directory goes (pruned while the worktree was
        // not mounted, or deleted); the directory stays.
        std::fs::remove_dir_all(world.root().join(".git/worktrees/old-wt")).unwrap();
        fix_two(&world, T0 + 3 * DAY);
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            world.at("s1", "7d").map(|w| w.fix_commits),
            Some(1),
            "s1 never counted"
        );
    }

    #[test]
    fn many_worktrees_removed_since_take_little_of_a_sync() {
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        // Another session in the repository, with many files and no age yet.
        let lines: Vec<(String, String)> = (0..10_000)
            .map(|i| {
                (
                    format!("gen/d{}/file_{i}.js", i % 50),
                    format!("const v{i} = {i};"),
                )
            })
            .collect();
        let lines: Vec<(&str, [&str; 1])> = lines
            .iter()
            .map(|(path, line)| (path.as_str(), [line.as_str()]))
            .collect();
        let files: Vec<(&str, &[&str])> = lines.iter().map(|(p, l)| (*p, &l[..])).collect();
        world.session("s2", T0 + 7 * DAY, T0 + 8 * DAY - HOUR, &files);
        // And many worktrees of it, noted while they were there, removed since.
        let common = world.root().join(".git").canonicalize().unwrap();
        let common = common.to_string_lossy().into_owned();
        let removed: Vec<(String, OutcomeRepo)> = (0..5_000)
            .map(|k| {
                let root = world.dir.path().join(format!("worktrees/task-{k:04}"));
                let root = root.to_string_lossy().into_owned();
                (root, OutcomeRepo::Found(common.clone()))
            })
            .collect();
        world.ledger.keep_outcome_repos(&removed).unwrap();
        let started = Instant::now();
        world.measure(T0 + 8 * DAY);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(world.at("s1", "7d").expect("never counted").fix_commits, 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_worktree_git_will_not_answer_for_is_not_asked_on_every_sync() {
        let (mut world, _) = written();
        let log = world.dir.path().join("calls.log");
        let _git = FakeGit::new(&format!(
            r#"for a in "$@"; do [ "$a" = --git-common-dir ] && echo x >> {} && exit 128; done"#,
            log.display()
        ));
        // Nothing due: the session ended two hours ago.
        for k in 0..3 {
            world.measure(T0 + 2 * HOUR + k);
        }
        let calls = std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .count();
        assert_eq!(calls, 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_worktree_git_hangs_in_takes_little_of_a_sync_with_nothing_due() {
        let (mut world, _) = written();
        let _git =
            FakeGit::new(r#"for a in "$@"; do [ "$a" = --git-common-dir ] && exec sleep 30; done"#);
        let budget = Budget {
            all: Duration::from_secs(2),
            repo: Duration::from_secs(2),
            waited: true,
        };
        let mut took = Vec::new();
        for k in 0..3 {
            let started = Instant::now();
            world.measure_for(T0 + 2 * HOUR + k, budget);
            took.push(started.elapsed());
        }
        assert!(took.iter().all(|t| *t < Duration::from_secs(1)), "{took:?}");
        assert!(
            took[1] + took[2] < Duration::from_millis(100),
            "asked again: {took:?}"
        );
    }

    /// Its counts at seven days: fixes, lines fixed, rework, reverts.
    fn week_of(world: &World, id: &str) -> Option<(u64, f64, u64, u64)> {
        world.at(id, "7d").map(|w| {
            (
                w.fix_commits,
                w.lines_fixed,
                w.rework_commits,
                w.revert_commits,
            )
        })
    }

    #[test]
    fn half_of_its_lines_committed_while_it_ran_land() {
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        // Two of its four lines committed; the others dropped before.
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT[..2].join("\n")),
            "Add alpha and beta",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", AGENT)]);
        fix_both(&world, "", T0 + 3 * DAY);
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            week_of(&world, "s1"),
            Some((1, 2.0, 0, 0)),
            "{:?}",
            world.kinds("s1")
        );
    }

    const TWO: &[&str] = &["let alpha = compute(1);", "let beta = compute(2);"];

    /// The first two of its lines changed, in a fix, and `rest` after them.
    fn fix_both(world: &World, rest: &str, at: i64) {
        world.commit(
            "f.js",
            &format!("// base line one\nlet alpha = compute(10);\nlet beta = compute(20);\n{rest}"),
            "fix: wrong arguments",
            at,
        );
    }

    #[test]
    fn a_session_of_two_lines_committed_a_line_at_a_time_lands() {
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", TWO[0]),
            "Add alpha",
            T0 + HOUR,
        );
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", TWO.join("\n")),
            "Add beta",
            T0 + HOUR + 60,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", TWO)]);
        fix_both(&world, "", T0 + 3 * DAY);
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            week_of(&world, "s1"),
            Some((1, 2.0, 0, 0)),
            "{:?}",
            world.kinds("s1")
        );
    }

    #[test]
    fn a_session_of_two_lines_committed_with_a_persons_lands() {
        let mut world = World::new();
        let persons = "let p = one();\nlet q = two();\nlet r = three();\n";
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n{persons}", TWO.join("\n")),
            "Add alpha and beta, and the rest",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", TWO)]);
        fix_both(&world, persons, T0 + 3 * DAY);
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            week_of(&world, "s1"),
            Some((1, 2.0, 0, 0)),
            "{:?}",
            world.kinds("s1")
        );
    }

    #[test]
    fn generic_lines_a_teammate_adds_over_several_commits_are_not_a_landing() {
        let lines: &[&str] = &[
            "if err != nil {",
            "return err",
            "return nil",
            "x := compute(1)",
            "y := compute(2)",
        ];
        let mut world = World::new();
        let filler: String = (0..12).map(|k| format!("// filler {k}\n")).collect();
        world.commit("f.go", &format!("package x\n{filler}"), "init", T0 - HOUR);
        // Its work is on a branch that is not read; on main a teammate adds
        // three generic lines like its, in two commits, and takes them out.
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.go", lines)]);
        world.commit(
            "f.go",
            &format!("package x\nif err != nil {{\nreturn err\n}}\n{filler}"),
            "Check the error",
            T0 + 30 * 60,
        );
        world.commit(
            "f.go",
            &format!("package x\nif err != nil {{\nreturn err\n}}\n{filler}return nil\n"),
            "Return nil",
            T0 + DAY,
        );
        world.commit(
            "f.go",
            &format!("package x\n{filler}"),
            "Drop the check",
            T0 + 2 * DAY,
        );
        main_is_the_default(&world);
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.kinds("s1"), Vec::<(String, String)>::new());
    }

    #[test]
    fn a_revert_after_a_merged_fix_of_some_of_its_lines_is_a_revert() {
        let eight: Vec<String> = (1..=8)
            .map(|k| format!("let a{k} = compute({k});"))
            .collect();
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", eight.join("\n")),
            "Add compute",
            T0 + HOUR,
        );
        let lines: Vec<&str> = eight.iter().map(String::as_str).collect();
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", &lines)]);
        // A branch fixes five of them, and is merged.
        world.git(&["checkout", "--quiet", "-b", "fixb"], T0);
        let fixed: Vec<String> = eight
            .iter()
            .enumerate()
            .map(|(k, l)| {
                if k < 5 {
                    l.replace(");", ", true);")
                } else {
                    l.clone()
                }
            })
            .collect();
        world.commit(
            "f.js",
            &format!("// base line one\n{}\n", fixed.join("\n")),
            "fix: pass the flag",
            T0 + DAY,
        );
        world.git(&["checkout", "--quiet", "main"], T0);
        world.git(
            &["merge", "--no-ff", "--quiet", "-m", "Merge fixb", "fixb"],
            T0 + DAY + HOUR,
        );
        // Then what is left of them is reverted.
        world.commit(
            "f.js",
            "// base line one\n",
            "Revert \"Add compute\"",
            T0 + 2 * DAY,
        );
        main_is_the_default(&world);
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            week_of(&world, "s1"),
            Some((1, 5.0, 0, 1)),
            "{:?}",
            world.kinds("s1")
        );
    }

    #[test]
    fn lines_two_merged_branches_moved_are_no_more_than_were_written() {
        let mut world = World::new();
        let body = AGENT.join("\n");
        let pad: String = (0..10).map(|k| format!("// pad {k}\n")).collect();
        world.commit("a.js", &pad, "init", T0);
        world.commit("a.js", &format!("{pad}{body}\n"), "Add compute", T0 + HOUR);
        world.session("s1", T0, T0 + 2 * HOUR, &[("a.js", AGENT)]);
        // Two branches each move its lines to a file of their own.
        for (branch, file, at) in [("x", "b.js", 3 * HOUR), ("y", "c.js", 4 * HOUR)] {
            world.git(&["checkout", "--quiet", "-b", branch, "main"], T0);
            std::fs::write(world.root().join("a.js"), &pad).unwrap();
            world.commit(
                file,
                &format!("{body}\n"),
                &format!("Move compute to {file}"),
                T0 + at,
            );
        }
        world.git(&["checkout", "--quiet", "main"], T0);
        world.git(
            &["merge", "--quiet", "--no-ff", "-m", "Merge x", "x"],
            T0 + 5 * HOUR,
        );
        world.git(
            &["merge", "--quiet", "--no-ff", "-m", "Merge y", "y"],
            T0 + 6 * HOUR,
        );
        // Both copies are there now, and a fix changes both.
        let fixed = body
            .replace("compute(1)", "compute(10)")
            .replace("compute(2)", "compute(20)");
        std::fs::write(world.root().join("b.js"), format!("{fixed}\n")).unwrap();
        world.commit(
            "c.js",
            &format!("{fixed}\n"),
            "fix: wrong arguments",
            T0 + 3 * DAY,
        );
        main_is_the_default(&world);
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            week_of(&world, "s1"),
            Some((1, 2.0, 0, 0)),
            "{:?}",
            world.kinds("s1")
        );
    }

    #[test]
    fn a_worktree_git_could_not_read_once_is_still_read_from_its_repository() {
        let (mut world, _) = written();
        let wt = world.dir.path().join("wt");
        world.git(
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "task",
                wt.to_str().unwrap(),
            ],
            T0,
        );
        let other: &[&str] = &[
            "let x1 = other(1);",
            "let x2 = other(2);",
            "let x3 = other(3);",
        ];
        commit_in(
            &wt,
            "g.js",
            &format!("{}\n", other.join("\n")),
            "Add other",
            T0 + HOUR,
        );
        world.session_in(
            &wt,
            "claude-code",
            "s2",
            T0,
            T0 + 2 * HOUR,
            &[("g.js", other)],
        );
        world.measure(T0 + 2 * HOUR);
        // Once while the repository was away (unmounted), git could not say.
        let away = world.dir.path().join("repo-away");
        std::fs::rename(world.root(), &away).unwrap();
        world.measure(T0 + 3 * HOUR);
        std::fs::rename(&away, world.root()).unwrap();
        // It came back; the worktree was merged and removed.
        world.git(&["merge", "--quiet", "task"], T0 + 4 * HOUR);
        world.git(
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
            T0 + 4 * HOUR,
        );
        commit_in(
            &world.root(),
            "g.js",
            "let x1 = other(10);\nlet x2 = other(20);\nlet x3 = other(3);\n",
            "fix: other arguments",
            T0 + 3 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            week_of(&world, "s2").map(|w| w.0),
            Some(1),
            "s2 never counted"
        );
    }

    #[test]
    fn a_fix_made_again_after_it_was_undone_counts_again() {
        let (mut world, _) = written();
        let fix = fix_two(&world, T0 + DAY);
        world.git(&["revert", "--no-edit", &fix], T0 + 2 * DAY);
        world.git(&["cherry-pick", &fix], T0 + 3 * DAY);
        main_is_the_default(&world);
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            week_of(&world, "s1"),
            Some((2, 4.0, 0, 0)),
            "{:?}",
            world.kinds("s1")
        );
    }

    #[test]
    fn a_backport_with_a_subject_of_its_own_counts_once() {
        let (mut world, _) = written();
        world.git(&["branch", "release"], T0);
        let fix = fix_two(&world, T0 + DAY);
        main_is_the_default(&world);
        world.git(&["checkout", "--quiet", "release"], T0);
        world.git(&["cherry-pick", "--no-commit", &fix], T0 + 2 * DAY);
        world.git(
            &[
                "commit",
                "--quiet",
                "-m",
                "[Backport release] fix: wrong arguments",
            ],
            T0 + 2 * DAY,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            week_of(&world, "s1"),
            Some((1, 2.0, 0, 0)),
            "{:?}",
            world.kinds("s1")
        );
    }

    #[test]
    fn a_squash_whose_message_lists_a_revert_is_no_revert_and_a_revert_of_it_is_one() {
        let mut world = World::new();
        world.commit("f.js", "// base line one\n", "init", T0);
        // GitHub's message for a squash merge lists the branch's commits.
        let squash = world.commit(
            "f.js",
            &format!("// base line one\n{}\n", AGENT.join("\n")),
            "Add compute (#12)\n\n* wip\n\n* Revert \"wip\"\n\n\
             This reverts commit 0123456789abcdef0123456789abcdef01234567.\n\n* Add compute",
            T0 + HOUR,
        );
        world.session("s1", T0, T0 + 2 * HOUR, &[("f.js", AGENT)]);
        world.git(&["revert", "--no-edit", &squash], T0 + 2 * DAY);
        world.measure(T0 + 8 * DAY);
        assert_eq!(
            week_of(&world, "s1"),
            Some((0, 0.0, 0, 1)),
            "{:?}",
            world.kinds("s1")
        );
        let events = world.ledger.outcome_events_of("s1").unwrap();
        assert!(events[0].signals.contains(&"revert_sha".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn a_worktree_whose_head_git_does_not_answer_for_fails_no_reading_of_the_others() {
        let (mut world, _) = written();
        let wt = world.dir.path().join("slowwt");
        world.git(
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "task",
                wt.to_str().unwrap(),
            ],
            T0,
        );
        let other: &[&str] = &[
            "let x1 = other(1);",
            "let x2 = other(2);",
            "let x3 = other(3);",
        ];
        commit_in(
            &wt,
            "g.js",
            &format!("{}\n", other.join("\n")),
            "Add other",
            T0 + 7 * DAY,
        );
        // Its session ended lately: still counted, with no age due.
        let ended = T0 + 8 * DAY - HOUR;
        world.session_in(
            &wt,
            "claude-code",
            "s2",
            T0 + 7 * DAY,
            ended,
            &[("g.js", other)],
        );
        fix_two(&world, T0 + 3 * DAY);
        world.measure(T0 + 2 * HOUR);
        let _git = FakeGit::new(&format!(
            r#"if [ "$2" = "{}" ]; then for a in "$@"; do [ "$a" = HEAD ] && exec sleep 30; done; fi"#,
            wt.display()
        ));
        let budget = Budget {
            all: Duration::from_secs(8),
            repo: Duration::from_secs(8),
            waited: false,
        };
        world.measure_for(T0 + 8 * DAY, budget);
        assert_eq!(
            week_of(&world, "s1").map(|w| w.0),
            Some(1),
            "s1 never counted"
        );
    }

    #[test]
    fn a_session_that_also_wrote_where_git_does_not_answer_still_made_its_commits() {
        let (mut world, _) = written();
        let wt = world.dir.path().join("wt");
        world.git(
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "task",
                wt.to_str().unwrap(),
            ],
            T0,
        );
        // A Cursor session, still going on, fixes two of its lines; it wrote
        // in a worktree too that git did not answer for lately.
        let cursor: &[&str] = &[
            "let alpha = checked(compute(1));",
            "let beta = checked(compute(2));",
            "let delta = compute(4);",
        ];
        world.commit(
            "f.js",
            &format!(
                "// base line one\n{}\n{}\n{}\n",
                cursor.join("\n"),
                AGENT[2],
                AGENT[3]
            ),
            "fix: check what compute returns",
            T0 + DAY,
        );
        let there = wt.join("g.js").to_string_lossy().into_owned();
        let elsewhere: &[&str] = &["let x1 = other(1);", "let x2 = other(2);"];
        world.session_of(
            "cursor",
            "s2",
            T0 + DAY - HOUR,
            T0 + 8 * DAY - HOUR,
            &[("f.js", cursor), (there.as_str(), elsewhere)],
        );
        let at = DateTime::from_timestamp(T0 + 8 * DAY - 60, 0).unwrap();
        let name = wt.to_string_lossy().into_owned();
        let timed_out = true;
        world
            .ledger
            .keep_outcome_repos(&[(name, OutcomeRepo::Failed { at, timed_out })])
            .unwrap();
        world.measure(T0 + 8 * DAY);
        let events = world.ledger.outcome_events_of("s1").unwrap();
        let by: Vec<_> = events
            .iter()
            .map(|e| (e.kind.as_str(), e.by_source.as_deref()))
            .collect();
        assert_eq!(by, [("fix", Some("cursor"))]);
    }

    #[cfg(unix)]
    #[test]
    fn a_named_pipe_for_git_or_commondir_is_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = |path: &Path| {
            let made = std::process::Command::new("mkfifo")
                .arg(path)
                .status()
                .unwrap();
            assert!(made.success());
        };
        let first = dir.path().join("w1");
        std::fs::create_dir(&first).unwrap();
        fifo(&first.join(".git"));
        let second = dir.path().join("w2");
        let gitdir = dir.path().join("gd");
        std::fs::create_dir(&second).unwrap();
        std::fs::create_dir(&gitdir).unwrap();
        std::fs::write(
            second.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        fifo(&gitdir.join("commondir"));
        for root in [first, second] {
            let (tx, rx) = std::sync::mpsc::channel();
            let r = root.clone();
            std::thread::spawn(move || {
                let _ = tx.send(crate::git::named_common_dir(&r));
            });
            let answered = rx.recv_timeout(Duration::from_secs(3));
            if answered.is_err() {
                // Let the thread go: a pipe nobody reads is not waited on.
                use std::os::unix::fs::OpenOptionsExt;
                for pipe in [root.join(".git"), gitdir.join("commondir")] {
                    let _ = std::fs::OpenOptions::new()
                        .write(true)
                        .custom_flags(libc::O_NONBLOCK)
                        .open(pipe);
                }
            }
            assert_eq!(answered, Ok(None), "{}", root.display());
        }
    }
}
