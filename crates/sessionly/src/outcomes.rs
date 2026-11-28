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
//!   session's own commits, or its subject begins with "revert" and it
//!   removes at least `REVERT_SHARE` of the session's lines still there;
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
//! - A session's lines count from when a commit adds them to the history,
//!   and only in what descends from that commit: before it, or beside it (a
//!   branch from before it, the remote's branch without it), a line like them
//!   that a commit removes was someone else's. Lines a commit moves to
//!   another file are followed there, from when the session began, and are
//!   never more than the session wrote.
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
use crate::ledger::{Ledger, OutcomeEvent, OutcomeScan, OutcomeTarget};
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

/// How long reading history may take: in all, and in one repository, so
/// that a slow one leaves time for the rest; and whether someone waits for
/// it.
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
/// the words apart by any white space, the SHA 7 to 64 hex digits (SHA-1 or SHA-256).
pub fn reverts(message: &str) -> Vec<String> {
    let tokens: Vec<&str> = message.split_whitespace().collect();
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

/// A session's files in one repository: paths relative to its top.
struct InRepo {
    target: usize,
    files: Vec<(String, Vec<u64>)>,
}

/// One repository: the worktrees of it on this machine that sessions wrote
/// in, which share its history, and those sessions.
struct Repo {
    roots: Vec<PathBuf>,
    sessions: Vec<InRepo>,
}

/// What reading a session's history in its repositories found: how many
/// were read, and while none failed, the events and which refs were read.
type Read = (usize, Option<(Vec<OutcomeEvent>, &'static str)>);

/// What a reading of one repository found.
type Found = Result<(Vec<OutcomeEvent>, &'static str), Stop>;

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
    let deadline = Instant::now() + budget.all;
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

    // The repository of each worktree a session ran or wrote in, noted while
    // it is there: one removed since is read from the repository's own
    // directory.
    let mut noted = ledger.outcome_repos()?;
    let mut root_of: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();
    let mut unnoted: BTreeSet<PathBuf> = targets
        .iter()
        .filter_map(|t| t.repo.as_ref().map(PathBuf::from))
        .collect();
    for (base, path) in ledger.outcome_paths()? {
        let path = lexical(&match base {
            Some(base) => Path::new(&base).join(path),
            None => PathBuf::from(path),
        });
        let Some(dir) = path.parent() else { continue };
        let root = root_of
            .entry(dir.to_path_buf())
            .or_insert_with(|| crate::git::repo_root(dir));
        unnoted.extend(root.clone());
    }
    unnoted
        .retain(|root| !noted.contains_key(&*root.to_string_lossy()) && root.join(".git").exists());
    let mut found_repos = Vec::new();
    for root in unnoted {
        match crate::git::common_dir(&root, deadline) {
            Ok(dir) => found_repos.push((
                root.to_string_lossy().into_owned(),
                dir.to_string_lossy().into_owned(),
            )),
            Err(Stop::TimedOut) => break,
            Err(_) => {}
        }
    }

    if !targets.iter().any(|t| needs_scan(t) || ready(t)) {
        ledger.keep_outcome_repos(&found_repos)?;
        return Ok(report);
    }
    noted.extend(found_repos.iter().cloned());
    ledger.outcome_files(&mut targets)?;

    // Each file in the repository it is in: an agent may write in a sibling
    // worktree, or outside any repository. Worktrees of one repository are
    // one history, read once.
    let mut repos: BTreeMap<PathBuf, Repo> = BTreeMap::new();
    // A worktree's repository; none when it could not be asked in time.
    let mut repo_of: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();
    // Sessions whose repository is not there now (unmounted, moved): read
    // later, rather than counted without it.
    let mut unavailable: HashSet<usize> = HashSet::new();
    // Sessions whose repositories were not all found in this sync's time:
    // read on another.
    let mut deferred: HashSet<usize> = HashSet::new();
    // Each session's lines in the repositories read.
    let mut tracked: HashMap<usize, u64> = HashMap::new();
    // Worktrees removed since (merged, done with) of a repository still
    // here: what was written in one is read from the repository's own
    // directory, which has what its main worktree has checked out, with the
    // paths as they were in that worktree.
    let removed: Vec<(PathBuf, PathBuf)> = noted
        .iter()
        .map(|(root, common)| (PathBuf::from(root), PathBuf::from(common)))
        .filter(|(root, common)| !root.join(".git").exists() && common.is_dir())
        .collect();
    for (index, target) in targets.iter().enumerate() {
        if target.repo.as_ref().is_some_and(|repo| {
            let repo = Path::new(repo);
            !repo.join(".git").exists() && !removed.iter().any(|(root, _)| root == repo)
        }) {
            unavailable.insert(index);
            continue;
        }
        // Per repository: the worktrees, and the lines by file.
        type Placed = (BTreeSet<PathBuf>, BTreeMap<String, Vec<u64>>);
        let mut by_repo: BTreeMap<PathBuf, Placed> = BTreeMap::new();
        for (path, hashes) in &target.files {
            let path = lexical(&match &target.base {
                Some(base) => Path::new(base).join(path),
                None => PathBuf::from(path),
            });
            // Where its path starts, where it is read, and which repository it is.
            let gone = removed
                .iter()
                .filter(|(root, _)| path.starts_with(root))
                .max_by_key(|(root, _)| root.components().count());
            let (top, root, repo) = match gone {
                Some((gone, common)) => (gone.clone(), common.clone(), common.clone()),
                None => {
                    let Some(dir) = path.parent() else { continue };
                    let root = root_of
                        .entry(dir.to_path_buf())
                        .or_insert_with(|| crate::git::repo_root(dir))
                        .clone();
                    let Some(root) = root else { continue };
                    let repo = match repo_of.get(&root) {
                        Some(repo) => repo.clone(),
                        None => {
                            let known = noted
                                .get(&*root.to_string_lossy())
                                .map(PathBuf::from)
                                .filter(|dir| dir.is_dir());
                            let repo = match known {
                                Some(dir) => Some(dir),
                                None => match crate::git::common_dir(&root, deadline) {
                                    Ok(dir) => {
                                        let name = root.to_string_lossy().into_owned();
                                        found_repos
                                            .push((name, dir.to_string_lossy().into_owned()));
                                        Some(dir)
                                    }
                                    Err(Stop::TimedOut) => None,
                                    Err(_) => Some(root.clone()),
                                },
                            };
                            repo_of.insert(root.clone(), repo.clone());
                            repo
                        }
                    };
                    let Some(repo) = repo else {
                        deferred.insert(index);
                        break;
                    };
                    (root.clone(), root, repo)
                }
            };
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
            *kept = most_of(kept, hashes);
        }
        if deferred.contains(&index) {
            continue;
        }
        let mut lines = 0;
        for (repo, (roots, files)) in by_repo {
            let entry = repos.entry(repo).or_insert_with(|| Repo {
                roots: Vec::new(),
                sessions: Vec::new(),
            });
            for root in roots {
                if !entry.roots.contains(&root) {
                    entry.roots.push(root);
                }
            }
            lines += files.values().map(|h| h.len() as u64).sum::<u64>();
            entry.sessions.push(InRepo {
                target: index,
                files: files.into_iter().collect(),
            });
        }
        tracked.insert(index, lines);
    }
    ledger.keep_outcome_repos(&found_repos)?;

    // A session's history is read once every repository it is in was: what
    // one of them said is kept only with what the others said.
    let mut in_repos: HashMap<usize, usize> = HashMap::new();
    for repo in repos.values_mut() {
        repo.roots.sort();
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
        while let Some(group) = groups.pop_front() {
            // Its time is up: the rest is read on a later sync.
            if Instant::now() >= until {
                break;
            }
            let scanning: Vec<&InRepo> = group.iter().map(|k| &repo.sessions[*k]).collect();
            let found = scan(
                &repo.roots,
                &repo.sessions,
                &scanning,
                &targets,
                words_of,
                until,
            );
            match &found {
                // Too big, or failing, for them all: one session's paths may
                // be past what git takes, or not paths it can read.
                Err(Stop::TooLarge | Stop::Failed) if group.len() > 1 => {
                    let (newer, older) = group.split_at(group.len() / 2);
                    groups.push_front(older.to_vec());
                    groups.push_front(newer.to_vec());
                    continue;
                }
                // Out of this sync's time, not of the repository's: read on another.
                Err(Stop::TimedOut) if given < enough => break 'repos,
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
/// each has checked out is read, with the remote's default branch.
fn scan(
    roots: &[PathBuf],
    sessions: &[InRepo],
    scanning: &[&InRepo],
    targets: &[OutcomeTarget],
    words_of: &Words,
    deadline: Instant,
) -> Result<(Vec<OutcomeEvent>, &'static str), Stop> {
    let root = roots.first().ok_or(Stop::Failed)?;
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
    for at in roots {
        if let Some(head) = look(at, &["rev-parse", "--verify", "--quiet", "HEAD"])?
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
    let max_age = format!("--max-age={}", wanted.since);
    let min_age = format!("--min-age={}", wanted.until);
    let mut args = vec![
        "rev-list",
        "--parents",
        "--full-history",
        "--topo-order",
        "--reverse",
        "--timestamp",
        max_age.as_str(),
        min_age.as_str(),
    ];
    args.extend(wanted.refs.iter().map(String::as_str));
    args.push("--");
    args.extend(wanted.paths.iter().map(String::as_str));
    let mut seen = HashSet::new();
    let listed: Vec<(String, i64, Vec<String>)> = parse_list(&run(&args, None, MAX_LOG_BYTES)?)
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
    let mut args = vec!["diff-tree", "--stdin", "--always", "--root"];
    args.extend(PATCH);
    args.push("--");
    args.extend(wanted.paths.iter().map(String::as_str));
    let out = run(&args, Some(input.as_bytes()), MAX_LOG_BYTES)?;
    let out = String::from_utf8_lossy(&out);
    let diffs = split_tree(&out, &shas)?;
    let mut commits: Vec<Commit> = listed
        .into_iter()
        .map(|(sha, at, parents)| Commit {
            message: messages.get(&sha).cloned().unwrap_or_default(),
            files: diffs.get(&sha).map(|d| parse_diff(d)).unwrap_or_default(),
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

/// Git run in a repository: with these arguments and this input, printing
/// no more than so much.
type Git<'a> = dyn Fn(&[&str], Option<&[u8]>, usize) -> Result<Vec<u8>, Stop> + 'a;

/// A line moved by a commit: from one file to another, how many copies.
type Move = (String, String, u64, u64);

/// A whole commit's files, less the lines it moved: each line removed and
/// added again, in that file or another, is taken out of both. With the
/// tracked lines it removed, less those, and where each line moved to
/// another file went.
fn unmoved(mut files: HashMap<String, FileDiff>) -> (HashMap<String, FileDiff>, f64, Vec<Move>) {
    let mut paths: Vec<String> = files.keys().cloned().collect();
    paths.sort();
    // Which files each line was removed from and added to, in that order,
    // and how many: found once, not file by file for each line.
    let mut removed: HashMap<u64, Vec<(&str, u64)>> = HashMap::new();
    let mut added: HashMap<u64, Vec<(&str, u64)>> = HashMap::new();
    for path in &paths {
        let diff = &files[path];
        for (bag, at) in [(&diff.removed, &mut removed), (&diff.added, &mut added)] {
            for (hash, n) in bag {
                at.entry(*hash).or_default().push((path.as_str(), *n));
            }
        }
    }
    let mut hashes: Vec<u64> = removed
        .keys()
        .filter(|hash| added.contains_key(*hash))
        .copied()
        .collect();
    hashes.sort();
    // Which file each moved line left, and which it went to, in order.
    let mut moves = Vec::new();
    let mut moved: HashMap<u64, u64> = HashMap::new();
    for hash in hashes {
        let (mut from, mut to) = (removed[&hash].clone(), added[&hash].clone());
        let n = from
            .iter()
            .map(|(_, k)| k)
            .sum::<u64>()
            .min(to.iter().map(|(_, k)| k).sum());
        moved.insert(hash, n);
        let (mut f, mut t, mut left) = (0, 0, n);
        while left > 0 && f < from.len() && t < to.len() {
            let taken = left.min(from[f].1).min(to[t].1);
            if from[f].0 != to[t].0 {
                moves.push((from[f].0.to_string(), to[t].0.to_string(), hash, taken));
            }
            from[f].1 -= taken;
            to[t].1 -= taken;
            left -= taken;
            if from[f].1 == 0 {
                f += 1;
            }
            if to[t].1 == 0 {
                t += 1;
            }
        }
    }
    let (mut from, mut to) = (moved.clone(), moved);
    for path in &paths {
        let Some(diff) = files.get_mut(path) else {
            continue;
        };
        for (bag, left) in [(&mut diff.removed, &mut from), (&mut diff.added, &mut to)] {
            for (hash, n) in bag.iter_mut() {
                if let Some(m) = left.get_mut(hash) {
                    let taken = (*n).min(*m);
                    *n -= taken;
                    *m -= taken;
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

/// Whether a commit puts lines back rather than lands them: a revert, or
/// the revert of a revert (`Reapply "…"`).
fn puts_back(commit: &Commit) -> bool {
    let subject = commit.message.lines().next().unwrap_or_default();
    !reverts(&commit.message).is_empty()
        || words(subject)
            .first()
            .is_some_and(|w| w == "revert" || w == "reapply")
}

/// Walk the commits as git does, parents first, and say, for each session in
/// `scanned`, which ones touched it and how. A session's lines count from
/// when a commit puts them in the history, and in what descends from that
/// commit only: before it, or beside it (a branch from before it, the
/// remote's branch without it), a line like them that a commit removes was
/// someone else's.
fn attribute(
    commits: &[Commit],
    sessions: &[InRepo],
    targets: &[OutcomeTarget],
    words_of: &Words,
    scanned: &HashSet<usize>,
    deadline: Instant,
) -> Result<Vec<OutcomeEvent>, Stop> {
    // A line is common when this many sessions or more wrote it in that file.
    let mut writers: HashMap<(String, u64), usize> = HashMap::new();
    for session in sessions {
        for (path, hashes) in &session.files {
            let unique: HashSet<u64> = hashes.iter().copied().collect();
            for hash in unique {
                *writers.entry((path.clone(), hash)).or_insert(0) += 1;
            }
        }
    }

    // What each session wrote: how many of each line, in all (following them
    // to other files makes no more of them) and in each file. And the
    // sessions that wrote in each file: the only ones a change there can be of.
    let mut written: Vec<HashMap<u64, f64>> = vec![HashMap::new(); sessions.len()];
    let mut wrote: Lines = vec![HashMap::new(); sessions.len()];
    let mut in_file: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, session) in sessions.iter().enumerate() {
        for (path, hashes) in &session.files {
            let counts = wrote[i].entry(path.clone()).or_default();
            for hash in hashes {
                *counts.entry(*hash).or_insert(0.0) += 1.0;
                *written[i].entry(*hash).or_insert(0.0) += 1.0;
            }
            in_file.entry(path.clone()).or_default().push(i);
        }
    }
    // Of it, what the history has now, by file, by line in all, and in all:
    // nothing until a commit adds it.
    let mut remaining: Lines = vec![HashMap::new(); sessions.len()];
    let mut held: Vec<HashMap<u64, f64>> = vec![HashMap::new(); sessions.len()];
    let mut total: Vec<f64> = vec![0.0; sessions.len()];
    // Each session's own commits: those after it began that add copies of
    // its lines the history did not have (moved ones are not added). Of
    // those, the ones that landed them, not put them back: a revert is not
    // the session's work, nor its agent's.
    let mut own: Vec<HashSet<&str>> = vec![HashSet::new(); sessions.len()];
    let mut landed: Vec<HashSet<&str>> = vec![HashSet::new(); sessions.len()];
    let mut landed_by: HashMap<&str, Vec<usize>> = HashMap::new();
    // Per commit, the sessions some of whose lines are in its history: it,
    // or a commit it descends from, put them there.
    let mut has: HashMap<&str, Rc<BTreeSet<usize>>> = HashMap::new();

    let mut events: Vec<(usize, OutcomeEvent)> = Vec::new();
    for commit in commits {
        in_time(deadline)?;
        let sha = commit.sha.as_str();
        let parents: Vec<&Rc<BTreeSet<usize>>> = commit
            .parents
            .iter()
            .filter_map(|p| has.get(p.as_str()))
            .collect();
        let mut theirs: Rc<BTreeSet<usize>> = match parents.as_slice() {
            [] => Rc::default(),
            [one] => Rc::clone(one),
            many => Rc::new(many.iter().flat_map(|s| s.iter().copied()).collect()),
        };
        if commit.parents.len() > 1 {
            has.insert(sha, theirs);
            continue;
        }
        let active =
            |i: usize| commit.at >= targets[sessions[i].target].started_at.timestamp() - EARLY;
        // Lines it moved to another file are the session's there now.
        for (from, to, hash, n) in &commit.moves {
            if let Some(count) = writers.get(&(from.clone(), *hash)).copied() {
                let there = writers.entry((to.clone(), *hash)).or_insert(0);
                *there = (*there).max(count);
            }
            let Some(here) = in_file.get(from).cloned() else {
                continue;
            };
            for i in here {
                if !theirs.contains(&i) {
                    continue;
                }
                let Some(have) = remaining[i].get_mut(from).and_then(|f| f.get_mut(hash)) else {
                    continue;
                };
                let taken = have.min(*n as f64);
                if taken <= 0.0 {
                    continue;
                }
                *have -= taken;
                *remaining[i]
                    .entry(to.clone())
                    .or_default()
                    .entry(*hash)
                    .or_insert(0.0) += taken;
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
        // A session's own commit adds at least `LANDING_LINES` copies of its
        // lines that the commit's history does not have, or `LANDING_SHARE`
        // of what it adds to the session's files: a copy of lines already
        // there (a person's, or a block copied) is not. A history without
        // any of them (a branch from before they landed, which a cherry-pick
        // lands them on) has none.
        let mut adds: BTreeMap<usize, (f64, f64)> = BTreeMap::new();
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
                let entry = adds.entry(i).or_default();
                for (hash, n) in &diff.added {
                    entry.1 += *n as f64;
                    let Some(room) = room.get(hash) else {
                        continue;
                    };
                    let free = if theirs.contains(&i) {
                        let have = remaining[i]
                            .get(path)
                            .and_then(|f| f.get(hash))
                            .copied()
                            .unwrap_or(0.0);
                        let all = held[i].get(hash).copied().unwrap_or(0.0);
                        let most = written[i].get(hash).copied().unwrap_or(0.0);
                        (room - have).min(most - all)
                    } else {
                        *room
                    };
                    entry.0 += (*n as f64).min(free.max(0.0));
                }
            }
        }
        // Sessions whose lines it puts in its history.
        let mut puts: BTreeSet<usize> = BTreeSet::new();
        for (i, (mine, all)) in adds {
            if mine >= LANDING_LINES || (mine >= MIN_TOUCH_LINES && mine / all >= LANDING_SHARE) {
                own[i].insert(sha);
                puts.insert(i);
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
                let holders: Vec<(usize, f64)> = here
                    .iter()
                    .copied()
                    .filter(|i| active(*i) && theirs.contains(i))
                    .filter_map(|i| {
                        let have = remaining[i].get(path)?.get(hash).copied().unwrap_or(0.0);
                        (have > 0.0).then_some((i, have))
                    })
                    .collect();
                let all: f64 = holders.iter().map(|(_, have)| have).sum();
                if all == 0.0 {
                    continue;
                }
                let removed = *removed as f64;
                let common =
                    writers.get(&(path.clone(), *hash)).copied().unwrap_or(0) >= COMMON_LINE;
                for (i, have) in holders {
                    let copies = have.min(removed);
                    if open(i) {
                        let entry = lost.entry(i).or_insert((0.0, 0.0, 0.0, total[i]));
                        entry.0 += have.min(removed * have / all);
                        entry.1 += copies;
                        if !common {
                            entry.2 += copies;
                        }
                    }
                    // The copies went, for every session that had them: the
                    // share is only what each is counted for.
                    if let Some(left) = remaining[i].get_mut(path).and_then(|f| f.get_mut(hash)) {
                        *left -= copies;
                    }
                    *held[i].entry(*hash).or_insert(0.0) -= copies;
                    total[i] -= copies;
                }
            }
        }
        // What it adds of a session's lines is in the history from now:
        // landed, or put back after a revert. No more of a line than the
        // session wrote, in that file or in all.
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
                let file = remaining[i].entry(path.clone()).or_default();
                for (hash, n) in &diff.added {
                    let Some(room) = room.get(hash) else {
                        continue;
                    };
                    let most = written[i].get(hash).copied().unwrap_or(0.0);
                    let have = file.entry(*hash).or_insert(0.0);
                    let all = held[i].entry(*hash).or_insert(0.0);
                    let add = (*n as f64).min(room - *have).min(most - *all);
                    if add > 0.0 {
                        *have += add;
                        *all += add;
                        total[i] += add;
                        puts.insert(i);
                    }
                }
            }
        }
        if !puts.is_empty() {
            Rc::make_mut(&mut theirs).extend(puts);
        }
        has.insert(sha, theirs);
        if lost.is_empty() {
            continue;
        }
        let says = signals(&commit.message, words_of);
        let reverted = reverts(&commit.message);
        // A revert of a revert puts back what that one took out, whatever its
        // subject says (`Revert "Revert "…""`, as git before 2.43 and
        // GitHub's button name it): not a revert of the session.
        let reapplies = reverted.iter().any(|named| {
            commits
                .iter()
                .any(|c| c.sha.starts_with(named.as_str()) && puts_back(c))
        });
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
    // A revert that was reverted in turn (git names that one `Reapply "…"`).
    for (i, event) in events.iter_mut().map(|(i, e)| (*i, e)) {
        if event.kind != "revert" {
            continue;
        }
        let ended = targets[sessions[i].target].ended_at.timestamp();
        event.relanded_at = commits
            .iter()
            .filter(|c| {
                c.at >= event.at.timestamp() && c.at <= ended + LONGEST && c.sha != event.sha
            })
            .find(|c| {
                reverts(&c.message)
                    .iter()
                    .any(|sha| event.sha.starts_with(sha.as_str()))
            })
            .and_then(|c| DateTime::from_timestamp(c.at, 0));
    }
    Ok(events.into_iter().map(|(_, e)| e).collect())
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
        // Git cannot read the history of one of its files.
        let _git = FakeGit::new(
            r#"for a in "$@"; do [ "$a" = bad.js ] && [ "$*" != "${*#*rev-list}" ] && exit 128; done"#,
        );
        world.measure(T0 + 8 * DAY);
        assert_eq!(world.at("s1", "7d").expect("s1 failed").fix_commits, 1);
        assert_eq!(world.target("s2").failures, 1);
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
    fn sessions_with_more_paths_than_a_command_line_takes_are_read_apart() {
        let (mut world, _) = written();
        fix_two(&world, T0 + 3 * DAY);
        let many = |tag: &str| -> Vec<(String, String)> {
            (0..22_000)
                .map(|i| {
                    (
                        format!("generated/{tag}/some/deeper/directory/file_{i:06}.js"),
                        format!("const v{i} = {i};"),
                    )
                })
                .collect()
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
}
