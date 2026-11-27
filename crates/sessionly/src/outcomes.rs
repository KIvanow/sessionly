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
//! and it is not one of the session's own commits: those that add its lines.
//! Then it is:
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
//! - The branch checked out and the remote's default branch are read, nothing else.
//! - Merge commits are not read: a reverted merge counts only when the revert
//!   takes out most of the session's lines.
//! - A fix that only adds lines (a missing check next to the agent's code)
//!   removes none of them and is not counted.
//! - A line a commit removes and adds again, in that file or another, was
//!   moved, not changed: as for the rewrite rate, moved code counts as there.
//!   So a commit that removes a session's lines counts only when it could be
//!   read whole: not one over `MAX_SHOW_BYTES` (a vendored or moved tree), nor
//!   one past `MOST_SHOWN` in one reading.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono::{DateTime, Utc};

use crate::ledger::{Ledger, OutcomeEvent, OutcomeTarget};
use crate::rewrite::{line_hash, CHECKPOINTS};
use crate::session::OutcomeCheckpoint;

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
const MAX_SHOW_BYTES: usize = 8 * 1024 * 1024;

/// Commits read whole in one reading, to tell moved lines from changed ones.
const MOST_SHOWN: usize = 500;

/// How long reading one repository's history may take, and all of them.
const REPO_BUDGET: Duration = Duration::from_secs(20);
const ALL_BUDGET: Duration = Duration::from_secs(60);

/// A repository whose history could not be read is tried again after this long.
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
    /// The default fix words, or `fix_words` instead of them.
    pub fn new(fix_words: Option<&[String]>) -> Words {
        let fix_words = match fix_words {
            Some(list) => list.iter().flat_map(|w| words(w)).collect(),
            None => FIX_WORDS.iter().map(|w| w.to_string()).collect(),
        };
        Words {
            fix_words,
            fix_types: FIX_TYPES.iter().map(|w| w.to_string()).collect(),
        }
    }
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
/// the words apart by any white space, the SHA 7 to 40 hex digits.
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
        if (7..=40).contains(&sha.len()) && sha.chars().all(|c| c.is_ascii_hexdigit()) {
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
    message: String,
    /// The files of the sessions it changed; lines it moved are not in `removed`.
    files: HashMap<String, FileDiff>,
    /// Tracked lines it removed in all its files, less those it moved, when
    /// it was read whole.
    removed_total: Option<f64>,
}

/// `git log -p -U0` output with records as `FORMAT` writes them.
const FORMAT: &str = "--format=%x1e%H%x1f%ct%x1f%B%x1d";

fn parse_log(out: &[u8]) -> Vec<Commit> {
    let text = String::from_utf8_lossy(out);
    let mut commits = Vec::new();
    for record in text.split('\x1e').filter(|r| !r.is_empty()) {
        let Some((head, diff)) = record.split_once('\x1d') else {
            continue;
        };
        let mut parts = head.splitn(3, '\x1f');
        let (Some(sha), Some(at), Some(message)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(at) = at.trim().parse() else {
            continue;
        };
        commits.push(Commit {
            sha: sha.trim().to_string(),
            at,
            message: message.trim().to_string(),
            files: parse_diff(diff),
            removed_total: None,
        });
    }
    commits
}

/// A diff's files with their removed and added lines. The file headers
/// (`---`/`+++`) come before a file's first hunk; after it, a line `---x` is
/// a removed `--x`.
fn parse_diff(diff: &str) -> HashMap<String, FileDiff> {
    let mut files: HashMap<String, FileDiff> = HashMap::new();
    let mut current: Option<String> = None;
    let mut header = false;
    let mut old: Option<String> = None;
    let path_of = |line: &str, prefix: &str| -> Option<String> {
        let rest = line.get(4..)?;
        if rest == "/dev/null" {
            return None;
        }
        let rest = rest.trim_matches('"');
        Some(rest.strip_prefix(prefix).unwrap_or(rest).to_string())
    };
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

/// A session's files in one repository: paths relative to the root.
struct InRepo {
    target: usize,
    files: Vec<(String, Vec<u64>)>,
}

/// Count what later commits did to each session's lines, for every session
/// with an age (1, 7 or 30 days after it ended) reached and not yet counted.
/// History is read only when such an age needs it, so most syncs read none.
pub fn measure(ledger: &mut Ledger, words_of: &Words, now: DateTime<Utc>) -> Result<Report> {
    let mut report = Report::default();
    let targets = ledger.outcome_targets()?;
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
    // Which sessions need their history read: an age is due that their
    // last reading did not reach, and they were not tried just now.
    let needs_scan = |t: &OutcomeTarget| {
        let due = due(t);
        let reached = |end: i64| t.scanned_until.is_some_and(|u| u.timestamp() >= end);
        !due.is_empty()
            && due
                .iter()
                .any(|(_, seconds)| !reached(t.ended_at.timestamp() + seconds))
            && t.tried_at
                .is_none_or(|tried| now_s - tried.timestamp() >= RETRY_AFTER)
    };
    if !targets.iter().any(needs_scan) && !targets.iter().any(|t| !due(t).is_empty()) {
        return Ok(report);
    }

    // Each file in the repository it is in: an agent may write in a sibling
    // worktree, or outside any repository.
    let mut roots: HashMap<PathBuf, Vec<InRepo>> = HashMap::new();
    let mut root_of: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();
    for (index, target) in targets.iter().enumerate() {
        let mut by_root: HashMap<PathBuf, Vec<(String, Vec<u64>)>> = HashMap::new();
        for (path, hashes) in &target.files {
            let path = match &target.base {
                Some(base) => Path::new(base).join(path),
                None => PathBuf::from(path),
            };
            let Some(dir) = path.parent() else { continue };
            let root = root_of
                .entry(dir.to_path_buf())
                .or_insert_with(|| crate::git::repo_root(dir))
                .clone();
            let Some(root) = root else { continue };
            let Ok(relative) = path.strip_prefix(&root) else {
                continue;
            };
            by_root
                .entry(root)
                .or_default()
                .push((relative.to_string_lossy().into_owned(), hashes.clone()));
        }
        for (root, files) in by_root {
            roots.entry(root).or_default().push(InRepo {
                target: index,
                files,
            });
        }
    }

    let started = Instant::now();
    let mut roots: Vec<(PathBuf, Vec<InRepo>)> = roots.into_iter().collect();
    roots.sort_by(|a, b| a.0.cmp(&b.0));
    for (root, sessions) in &roots {
        let scanning: Vec<&InRepo> = sessions
            .iter()
            .filter(|s| needs_scan(&targets[s.target]))
            .collect();
        if scanning.is_empty() {
            continue;
        }
        if started.elapsed() >= ALL_BUDGET {
            break;
        }
        let ids: Vec<&str> = scanning
            .iter()
            .map(|s| targets[s.target].session_id.as_str())
            .collect();
        match scan(root, sessions, &scanning, &targets, words_of) {
            Ok((events, scope)) => {
                report.scanned += 1;
                ledger.store_outcome_scan(&ids, &events, Some(now), scope, now)?;
            }
            Err(_) => {
                report.skipped += 1;
                ledger.store_outcome_scan(&ids, &[], None, HEAD_ONLY, now)?;
            }
        }
    }

    // Count every age that is due and whose history has been read up to it.
    let targets = ledger.outcome_targets()?;
    let mut windows = Vec::new();
    for target in &targets {
        let due = due(target);
        if due.is_empty() {
            continue;
        }
        let events = ledger.outcome_events_of(&target.session_id)?;
        let tracked: u64 = target.files.iter().map(|(_, h)| h.len() as u64).sum();
        for (name, seconds) in due {
            let end = target.ended_at.timestamp() + seconds;
            if target.scanned_until.is_none_or(|u| u.timestamp() < end) {
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
    }
}

/// Read one repository's history and find what touched each session in
/// `scanning`. `sessions` is every session with lines there: a line several
/// of them wrote is shared among them.
fn scan(
    root: &Path,
    sessions: &[InRepo],
    scanning: &[&InRepo],
    targets: &[OutcomeTarget],
    words_of: &Words,
) -> Result<(Vec<OutcomeEvent>, &'static str), crate::git::Stop> {
    let deadline = Instant::now() + REPO_BUDGET;
    let text = |args: &[&str]| -> Option<String> {
        let mut command = crate::git::command(root);
        command.args(args);
        let (out, _) = crate::git::bounded(command, None, 4096, deadline).ok()?;
        let text = String::from_utf8_lossy(&out).trim().to_string();
        (!text.is_empty()).then_some(text)
    };
    let head = text(&["rev-parse", "--verify", "--quiet", "HEAD"]);
    let Some(head) = head else {
        return Err(crate::git::Stop::Failed);
    };
    let mut refs = vec![head.clone()];
    let default = text(&["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
        .and_then(|name| text(&["rev-parse", "--verify", "--quiet", &name]));
    let scope = match default {
        Some(default) if default != head => {
            refs.push(default);
            HEAD_AND_DEFAULT
        }
        Some(_) => HEAD_AND_DEFAULT,
        None => HEAD_ONLY,
    };

    let since = scanning
        .iter()
        .map(|s| targets[s.target].started_at.timestamp())
        .min()
        .unwrap_or_default()
        - SLACK;
    let mut paths: Vec<&str> = scanning
        .iter()
        .flat_map(|s| s.files.iter().map(|(p, _)| p.as_str()))
        .collect();
    paths.sort_unstable();
    paths.dedup();
    let since_arg = format!("--since={since}");
    let mut command = crate::git::command(root);
    command
        .args(["-c", "core.quotepath=off", "--literal-pathspecs", "log"])
        .args(&refs)
        .args([
            since_arg.as_str(),
            "--no-merges",
            "--no-renames",
            "-U0",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            FORMAT,
            "--",
        ])
        .args(&paths);
    let (out, fits) = crate::git::bounded(command, None, MAX_LOG_BYTES, deadline)?;
    if !fits {
        return Err(crate::git::Stop::TooLarge);
    }
    let mut commits = parse_log(&out);
    commits.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.sha.cmp(&b.sha)));

    // A commit that removes lines a session wrote is read whole: the log
    // above shows only the sessions' files, and a line it adds back
    // elsewhere (a file moved, a function moved) was not changed.
    let held: HashSet<(&str, u64)> = sessions
        .iter()
        .flat_map(|s| {
            s.files
                .iter()
                .flat_map(|(path, hashes)| hashes.iter().map(move |h| (path.as_str(), *h)))
        })
        .collect();
    let mut shown = 0;
    for commit in commits.iter_mut() {
        let removes_held = commit.files.iter().any(|(path, diff)| {
            diff.removed
                .keys()
                .any(|hash| held.contains(&(path.as_str(), *hash)))
        });
        if !removes_held {
            continue;
        }
        let unread = |commit: &mut Commit| {
            for diff in commit.files.values_mut() {
                diff.removed.clear();
            }
        };
        if shown >= MOST_SHOWN {
            unread(commit);
            continue;
        }
        shown += 1;
        let mut command = crate::git::command(root);
        command.args([
            "-c",
            "core.quotepath=off",
            "show",
            "--format=",
            "--no-renames",
            "-U0",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            &commit.sha,
        ]);
        let out = match crate::git::bounded(command, None, MAX_SHOW_BYTES, deadline) {
            Ok((out, true)) => out,
            // Out of time: the reading as a whole failed, and is tried again.
            Err(crate::git::Stop::TimedOut) => return Err(crate::git::Stop::TimedOut),
            _ => {
                unread(commit);
                continue;
            }
        };
        let whole = parse_diff(&String::from_utf8_lossy(&out));
        let mut added: HashMap<u64, u64> = HashMap::new();
        let mut removed: HashMap<u64, u64> = HashMap::new();
        for diff in whole.values() {
            for (hash, n) in &diff.added {
                *added.entry(*hash).or_insert(0) += n;
            }
            for (hash, n) in &diff.removed {
                *removed.entry(*hash).or_insert(0) += n;
            }
        }
        let moved: u64 = removed
            .iter()
            .map(|(hash, n)| (*n).min(added.get(hash).copied().unwrap_or(0)))
            .sum();
        commit.removed_total = Some((removed.values().sum::<u64>() - moved) as f64);
        for diff in commit.files.values_mut() {
            for (hash, n) in diff.removed.iter_mut() {
                let back = added.entry(*hash).or_insert(0);
                let taken = (*n).min(*back);
                *n -= taken;
                *back -= taken;
            }
            diff.removed.retain(|_, n| *n > 0);
        }
    }

    let scanned: HashSet<usize> = scanning.iter().map(|s| s.target).collect();
    Ok((
        attribute(&commits, sessions, targets, words_of, &scanned),
        scope,
    ))
}

/// Per session and file, the copies of each line it still has.
type Remaining = Vec<HashMap<String, HashMap<u64, f64>>>;

/// Walk the commits oldest first and say, for each session in `scanned`,
/// which ones touched it and how.
fn attribute(
    commits: &[Commit],
    sessions: &[InRepo],
    targets: &[OutcomeTarget],
    words_of: &Words,
    scanned: &HashSet<usize>,
) -> Vec<OutcomeEvent> {
    // A line is common when this many sessions or more wrote it in that file.
    let mut writers: HashMap<(&str, u64), usize> = HashMap::new();
    for session in sessions {
        for (path, hashes) in &session.files {
            let unique: HashSet<u64> = hashes.iter().copied().collect();
            for hash in unique {
                *writers.entry((path.as_str(), hash)).or_insert(0) += 1;
            }
        }
    }
    let common =
        |path: &str, hash: u64| writers.get(&(path, hash)).copied().unwrap_or(0) >= COMMON_LINE;

    // Each session's own commits: those after it began that add its lines.
    let own: Vec<HashSet<&str>> = sessions
        .iter()
        .map(|session| {
            let started = targets[session.target].started_at.timestamp();
            let lines: HashMap<&str, HashMap<u64, u64>> = session
                .files
                .iter()
                .map(|(path, hashes)| {
                    let mut counts = HashMap::new();
                    for hash in hashes {
                        *counts.entry(*hash).or_insert(0) += 1;
                    }
                    (path.as_str(), counts)
                })
                .collect();
            commits
                .iter()
                .filter(|c| c.at >= started - 60)
                .filter(|commit| {
                    let (mut mine, mut all) = (0.0, 0.0);
                    for (path, diff) in &commit.files {
                        let Some(counts) = lines.get(path.as_str()) else {
                            continue;
                        };
                        for (hash, n) in &diff.added {
                            all += *n as f64;
                            mine += (*n).min(counts.get(hash).copied().unwrap_or(0)) as f64;
                        }
                    }
                    mine >= LANDING_LINES || (all > 0.0 && mine / all >= LANDING_SHARE)
                })
                .map(|c| c.sha.as_str())
                .collect()
        })
        .collect();

    let mut remaining: Remaining = sessions
        .iter()
        .map(|session| {
            let mut files: HashMap<String, HashMap<u64, f64>> = HashMap::new();
            for (path, hashes) in &session.files {
                let counts = files.entry(path.clone()).or_default();
                for hash in hashes {
                    *counts.entry(*hash).or_insert(0.0) += 1.0;
                }
            }
            files
        })
        .collect();

    let mut events: Vec<(usize, OutcomeEvent)> = Vec::new();
    for commit in commits {
        // Sessions this commit is later than, within the longest age, and not one of their own.
        let open: Vec<usize> = (0..sessions.len())
            .filter(|i| {
                let ended = targets[sessions[*i].target].ended_at.timestamp();
                commit.at > ended
                    && commit.at <= ended + LONGEST
                    && !own[*i].contains(commit.sha.as_str())
            })
            .collect();
        if open.is_empty() {
            continue;
        }
        // Per session: lines it lost (shared lines split), copies it held of
        // them, of which not common, and what it had before.
        let mut lost: HashMap<usize, (f64, f64, f64)> = HashMap::new();
        let before: HashMap<usize, f64> = open
            .iter()
            .map(|i| (*i, remaining[*i].values().flat_map(|f| f.values()).sum()))
            .collect();
        for (path, diff) in &commit.files {
            for (hash, removed) in &diff.removed {
                let holders: Vec<(usize, f64)> = open
                    .iter()
                    .filter_map(|i| {
                        let have = remaining[*i].get(path)?.get(hash).copied().unwrap_or(0.0);
                        (have > 0.0).then_some((*i, have))
                    })
                    .collect();
                let total: f64 = holders.iter().map(|(_, have)| have).sum();
                if total == 0.0 {
                    continue;
                }
                let removed = *removed as f64;
                for (i, have) in holders {
                    let share = have.min(removed * have / total);
                    let copies = have.min(removed);
                    let entry = lost.entry(i).or_default();
                    entry.0 += share;
                    entry.1 += copies;
                    if !common(path, *hash) {
                        entry.2 += copies;
                    }
                    if let Some(left) = remaining[i].get_mut(path).and_then(|f| f.get_mut(hash)) {
                        *left -= share;
                    }
                }
            }
        }
        let says = signals(&commit.message, words_of);
        let reverted = reverts(&commit.message);
        for (i, (lines, copies, not_common)) in lost {
            if not_common < MIN_TOUCH_LINES || !scanned.contains(&sessions[i].target) {
                continue;
            }
            let names_own = reverted
                .iter()
                .any(|sha| own[i].iter().any(|own| own.starts_with(sha.as_str())));
            let bulk = says.contains(&"revert_subject")
                && before[&i] > 0.0
                && copies / before[&i] >= REVERT_SHARE;
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
    events.into_iter().map(|(_, e)| e).collect()
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
    use std::process::Command;

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
            let date = format!("@{at} +0000");
            let out = Command::new("git")
                .arg("-C")
                .arg(self.root())
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

        /// Write `file` and commit everything with `message` at `at`; the new commit's SHA.
        fn commit(&self, file: &str, content: &str, message: &str, at: i64) -> String {
            std::fs::write(self.root().join(file), content).unwrap();
            self.git(&["add", "-A"], at);
            self.git(&["commit", "--quiet", "-m", message], at);
            self.git(&["rev-parse", "HEAD"], at)
        }

        /// A session that began at `started`, ended at `ended`, and added `lines` to `file`.
        fn session(&mut self, id: &str, started: i64, ended: i64, files: &[(&str, &[&str])]) {
            let at = |t: i64| DateTime::from_timestamp(t, 0);
            let path = |file: &str| self.root().join(file).to_string_lossy().into_owned();
            let session = Session {
                session_id: id.into(),
                source: "claude-code".into(),
                started_at: at(started),
                ended_at: at(ended),
                repo: Some(Repo {
                    root: self.root().to_string_lossy().into_owned(),
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
            measure(
                &mut self.ledger,
                &Words::default(),
                DateTime::from_timestamp(now, 0).unwrap(),
            )
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
        assert!(world.ledger.outcome_targets().unwrap()[0]
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
        assert_eq!(world.at("s1", "7d").unwrap().lines_tracked, 6);
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
}
