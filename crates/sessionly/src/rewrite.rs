//! Rewrite rate: how much of what the agent wrote in a session is still there.
//!
//! For every file a session changed we keep the lines the agent added, as
//! hashes. A line the agent later removed itself is not counted. Measuring is
//! then: read the file as it is now and count how many of those lines still
//! exist in it.
//!
//! Deliberate simplifications:
//! - Lines are matched by content anywhere in the file, not by position, so
//!   moved code counts as surviving.
//! - Blank lines and lines without a letter or digit (`}`, `);`) are ignored:
//!   they would match almost anything.
//! - Whitespace at the ends of a line is ignored, so re-indenting is not a rewrite.
//! - Only changes made through the agent's file tools are known, and in a
//!   cloud agent's sandbox what its shell commands changed (see `changes`).
//!   The current file is whatever is checked out when the measurement runs.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::ledger::{Ledger, RewriteRow};

/// A file counts as rewritten when less than this share of the agent's lines survive.
pub const REWRITTEN_BELOW: f64 = 0.5;

/// The ages after a session ended at which its measurement is kept for good,
/// with each in seconds: what was there after a day, a week and a month.
pub const CHECKPOINTS: [(&str, i64); 3] =
    [("1d", 86_400), ("7d", 7 * 86_400), ("30d", 30 * 86_400)];

/// Files larger than this are not read for measuring.
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

/// Hash of a line worth tracking, or `None` for a line that is blank or has
/// no letter or digit.
pub fn line_hash(line: &str) -> Option<u64> {
    let line = line.trim();
    if !line.chars().any(char::is_alphanumeric) {
        return None;
    }
    let digest = Sha256::digest(line.as_bytes());
    Some(u64::from_le_bytes(digest[..8].try_into().unwrap()))
}

/// The lines an agent added to one file, as hashes, grouped by the model
/// that wrote them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileLines {
    pub path: String,
    /// Models in name order, an unknown model first; each with its lines'
    /// hashes in order. A line added twice is there twice.
    pub by_model: Vec<(Option<String>, Vec<u64>)>,
}

impl FileLines {
    pub fn hashes(&self) -> impl Iterator<Item = u64> + '_ {
        self.by_model
            .iter()
            .flat_map(|(_, hashes)| hashes.iter().copied())
    }
}

/// The agent's added lines per file, from raw capture records. Each file's
/// list keeps duplicates (it is a multiset) and files are in order of first change.
#[cfg(test)]
pub fn added_lines(events: &[Value]) -> Vec<(String, Vec<u64>)> {
    added_lines_by_model(events, &HashMap::new())
        .into_iter()
        .map(|file| {
            let mut hashes: Vec<u64> = file.hashes().collect();
            hashes.sort_unstable();
            (file.path, hashes)
        })
        .collect()
}

/// The agent's added lines per file and model, from raw capture records.
/// `models` says which model made a tool call, by tool use id. Files are in
/// order of first change.
pub fn added_lines_by_model(events: &[Value], models: &HashMap<&str, &str>) -> Vec<FileLines> {
    let mut order: Vec<String> = Vec::new();
    // Per file and line: the model behind each time the line was added.
    let mut counts: HashMap<String, HashMap<u64, Vec<Option<&str>>>> = HashMap::new();
    for record in events {
        let hook = record["hook"].as_str().unwrap_or_default();
        if !matches!(hook, "PostToolUse" | "PostToolUseFailure") {
            continue;
        }
        let p = &record["payload"];
        let model = p["tool_use_id"]
            .as_str()
            .and_then(|id| models.get(id).copied());
        // One file's patch lines: what was added, what was taken out.
        let mut change = |path: &str, added: Vec<u64>, removed: Vec<u64>| {
            if !counts.contains_key(path) {
                order.push(path.to_string());
            }
            let file = counts.entry(path.to_string()).or_default();
            // A line the agent removes again was its own to remove: un-count it.
            for hash in removed {
                if let Some(writers) = file.get_mut(&hash) {
                    writers.pop();
                }
            }
            for hash in added {
                file.entry(hash).or_default().push(model);
            }
        };
        let hashes = |lines: &mut dyn Iterator<Item = &str>| {
            let (mut added, mut removed) = (Vec::new(), Vec::new());
            for line in lines {
                match line.as_bytes().first() {
                    Some(b'+') => added.extend(line_hash(&line[1..])),
                    Some(b'-') => removed.extend(line_hash(&line[1..])),
                    _ => {}
                }
            }
            (added, removed)
        };
        // What a shell command changed, where the capture could tell (see `changes`).
        for (path, _, mut lines) in crate::changes::of(record) {
            let (added, removed) = hashes(&mut lines);
            change(path, added, removed);
        }
        if hook != "PostToolUse" {
            continue;
        }
        let input = &p["tool_input"];
        let response = &p["tool_response"];
        let Some(path) = ["file_path", "notebook_path"]
            .iter()
            .find_map(|k| input[*k].as_str())
        else {
            continue;
        };
        let (added, removed) = match response["structuredPatch"]
            .as_array()
            .filter(|h| !h.is_empty())
        {
            Some(hunks) => hashes(
                &mut hunks
                    .iter()
                    .filter_map(|h| h["lines"].as_array())
                    .flatten()
                    .filter_map(Value::as_str),
            ),
            // A newly created file has no patch: every line is new.
            None if response["type"].as_str() == Some("create") => {
                let content = input["content"].as_str().unwrap_or_default();
                (content.lines().filter_map(line_hash).collect(), Vec::new())
            }
            None => continue,
        };
        change(path, added, removed);
    }
    order
        .into_iter()
        .filter_map(|path| {
            let mut by_model: std::collections::BTreeMap<Option<&str>, Vec<u64>> =
                Default::default();
            for (hash, writers) in &counts[&path] {
                for model in writers {
                    by_model.entry(*model).or_default().push(*hash);
                }
            }
            let by_model: Vec<(Option<String>, Vec<u64>)> = by_model
                .into_iter()
                .map(|(model, mut hashes)| {
                    hashes.sort_unstable();
                    (model.map(String::from), hashes)
                })
                .collect();
            (!by_model.is_empty()).then_some(FileLines { path, by_model })
        })
        .collect()
}

/// A line's hash as it is uploaded: the first 8 bytes of its SHA-256 in hex.
pub fn hash_hex(hash: u64) -> String {
    hash.to_le_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn count(hashes: impl Iterator<Item = u64>) -> HashMap<u64, u64> {
    let mut counts = HashMap::new();
    for hash in hashes {
        *counts.entry(hash).or_insert(0) += 1;
    }
    counts
}

/// How many of `added` are present in `current`, each current line matching
/// at most one added line.
pub fn surviving(added: &[u64], current: &HashMap<u64, u64>) -> u64 {
    count(added.iter().copied())
        .iter()
        .map(|(hash, n)| (*n).min(current.get(hash).copied().unwrap_or(0)))
        .sum()
}

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    /// Session files measured.
    pub measured: u64,
    /// Session files skipped because their directory no longer exists.
    pub unavailable: u64,
    /// Checkpoints kept: sessions that reached 1, 7 or 30 days since they
    /// ended and were measured now.
    pub checkpoints: u64,
}

struct GitState {
    branch: Option<String>,
    head: Option<String>,
}

fn git_state(dir: &Path) -> GitState {
    let run = |args: &[&str]| {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !text.is_empty()).then_some(text)
    };
    GitState {
        branch: run(&["rev-parse", "--abbrev-ref", "HEAD"]),
        head: run(&["rev-parse", "--short", "HEAD"]),
    }
}

/// Measure every changed file of every session against the files on disk and
/// store the result. A file that is gone counts as fully rewritten, unless the
/// whole directory the session ran in is gone: then nothing can be said and
/// the previous measurement, if any, is kept. What was measured is also kept
/// as the checkpoint of each age a session has reached (`CHECKPOINTS`).
pub fn measure(ledger: &mut Ledger, now: DateTime<Utc>) -> Result<Report> {
    let mut report = Report::default();
    let mut current: HashMap<String, Option<HashMap<u64, u64>>> = HashMap::new();
    let mut git: HashMap<String, GitState> = HashMap::new();
    let mut rows = Vec::new();

    for target in ledger.rewrite_targets()? {
        let path = match &target.base {
            Some(base) => Path::new(base).join(&target.path),
            None => Path::new(&target.path).to_path_buf(),
        };
        let key = path.to_string_lossy().into_owned();
        let lines = current.entry(key).or_insert_with(|| {
            let size = fs::metadata(&path).ok().filter(|m| m.is_file())?.len();
            if size > MAX_FILE_BYTES {
                return None;
            }
            let text = fs::read(&path).ok()?;
            Some(count(
                String::from_utf8_lossy(&text).lines().filter_map(line_hash),
            ))
        });
        let base_exists = target
            .base
            .as_deref()
            .is_some_and(|b| Path::new(b).is_dir());
        if lines.is_none() && !base_exists {
            report.unavailable += 1;
            continue;
        }
        let state = target.base.as_ref().map(|base| {
            git.entry(base.clone())
                .or_insert_with(|| git_state(Path::new(base)))
        });
        rows.push(RewriteRow {
            session_id: target.session_id,
            path: target.path,
            added: target.hashes.len() as u64,
            surviving: lines.as_ref().map_or(0, |l| surviving(&target.hashes, l)),
            file_exists: lines.is_some(),
            branch: state.as_ref().and_then(|s| s.branch.clone()),
            head: state.as_ref().and_then(|s| s.head.clone()),
        });
        report.measured += 1;
    }
    ledger.store_rewrite(&rows, now)?;
    // Only what was measured just now: a session whose directory is gone has
    // nothing that can be said of it today.
    let mut totals: Vec<(String, u64, u64)> = Vec::new();
    for row in &rows {
        match totals.last_mut() {
            Some((id, added, surviving)) if *id == row.session_id => {
                *added += row.added;
                *surviving += row.surviving;
            }
            _ => totals.push((row.session_id.clone(), row.added, row.surviving)),
        }
    }
    report.checkpoints = ledger.keep_checkpoints(&totals, now)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn post(path: &str, input: Value, response: Value) -> Value {
        let mut input = input;
        input["file_path"] = json!(path);
        json!({ "hook": "PostToolUse",
                "payload": { "tool_name": "Edit", "tool_input": input, "tool_response": response } })
    }

    fn patch(lines: &[&str]) -> Value {
        json!({ "structuredPatch": [{ "lines": lines }] })
    }

    fn hashes(lines: &[&str]) -> Vec<u64> {
        let mut h: Vec<u64> = lines.iter().filter_map(|l| line_hash(l)).collect();
        h.sort_unstable();
        h
    }

    #[test]
    fn ignores_blank_and_punctuation_lines_and_outer_whitespace() {
        assert_eq!(line_hash(""), None);
        assert_eq!(line_hash("   "), None);
        assert_eq!(line_hash("  });"), None);
        assert_eq!(line_hash("let x = 1;"), line_hash("\t  let x = 1;  "));
        assert_ne!(line_hash("let x = 1;"), line_hash("let x = 2;"));
    }

    /// The GitHub Action hashes pull request lines itself: both must agree.
    #[test]
    fn hashes_match_the_shared_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../action/test/line-hashes.json")).unwrap();
        let cases = cases["cases"].as_array().unwrap();
        assert!(cases.len() > 20);
        for case in cases {
            let line = case["line"].as_str().unwrap();
            assert_eq!(
                line_hash(line).map(hash_hex).as_deref(),
                case["hash"].as_str(),
                "{line:?}"
            );
        }
    }

    #[test]
    fn groups_added_lines_by_the_model_that_wrote_them() {
        let by = |id: &str, mut event: Value| {
            event["payload"]["tool_use_id"] = json!(id);
            event
        };
        let events = vec![
            by(
                "t1",
                post("/r/a.rs", json!({}), patch(&["+one();", "+two();", "+}"])),
            ),
            by(
                "t2",
                post("/r/a.rs", json!({}), patch(&["+three();", "+one();"])),
            ),
            // the latest writer of a line is the one whose line is removed
            by(
                "t3",
                post("/r/a.rs", json!({}), patch(&["-one();", "+four();"])),
            ),
            by("t9", post("/r/b.rs", json!({}), patch(&["+solo();"]))),
        ];
        let models = HashMap::from([("t1", "opus"), ("t2", "haiku"), ("t3", "opus")]);
        let lines = added_lines_by_model(&events, &models);
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0].by_model,
            [
                (Some("haiku".to_string()), hashes(&["three();"])),
                (
                    Some("opus".to_string()),
                    hashes(&["one();", "two();", "four();"])
                ),
            ]
        );
        // a call with no known model
        assert_eq!(lines[1].by_model, [(None, hashes(&["solo();"]))]);
        assert_eq!(lines[0].hashes().count(), 4);
        assert_eq!(
            hash_hex(u64::from_le_bytes([0, 1, 2, 3, 4, 5, 6, 0xff])),
            "00010203040506ff"
        );
    }

    #[test]
    fn collects_added_lines_per_file() {
        let events = vec![
            post(
                "/r/new.rs",
                json!({ "content": "fn a() {\n    one();\n}\n" }),
                json!({ "type": "create", "structuredPatch": [] }),
            ),
            post(
                "/r/old.rs",
                json!({}),
                patch(&[" keep();", "-gone();", "+fresh();", "+fresh();"]),
            ),
            // a read, a failed call and an edit with no patch add nothing
            json!({ "hook": "PostToolUse", "payload": { "tool_input": { "file_path": "/r/read.rs" }, "tool_response": { "type": "text" } } }),
            json!({ "hook": "PostToolUseFailure", "payload": { "tool_input": { "file_path": "/r/x.rs" } } }),
        ];
        let lines = added_lines(&events);
        assert_eq!(lines.len(), 2);
        assert_eq!(
            lines[0],
            ("/r/new.rs".to_string(), hashes(&["fn a() {", "one();"]))
        );
        assert_eq!(
            lines[1],
            ("/r/old.rs".to_string(), hashes(&["fresh();", "fresh();"]))
        );
    }

    #[test]
    fn lines_the_agent_removes_itself_are_not_counted() {
        let events = vec![
            post("/r/a.rs", json!({}), patch(&["+first();", "+second();"])),
            post(
                "/r/a.rs",
                json!({}),
                patch(&["-second();", "+better();", "-was_there_before();"]),
            ),
        ];
        assert_eq!(
            added_lines(&events)[0].1,
            hashes(&["first();", "better();"])
        );
        // a file where everything the agent added was removed again drops out
        let undone = vec![
            post("/r/b.rs", json!({}), patch(&["+temp();"])),
            post("/r/b.rs", json!({}), patch(&["-temp();"])),
        ];
        assert!(added_lines(&undone).is_empty());
    }

    /// A ledger with one session that ended at `ended` and added three lines
    /// to a file that is on disk, and the file.
    fn one_session(ended: DateTime<Utc>) -> (tempfile::TempDir, Ledger, std::path::PathBuf) {
        use crate::ledger::Fingerprint;
        use crate::session::{FileTouched, Repo, Session};
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.rs");
        fs::write(&file, "one();\ntwo();\nthree();\n").unwrap();
        let path = file.to_string_lossy().into_owned();
        let mut ledger = Ledger::open(&dir.path().join("ledger.db")).unwrap();
        let session = Session {
            session_id: "s1".into(),
            source: "claude-code".into(),
            ended_at: Some(ended),
            repo: Some(Repo {
                root: dir.path().to_string_lossy().into_owned(),
                ..Default::default()
            }),
            files: vec![FileTouched {
                path: path.clone(),
                writes: 1,
                ..Default::default()
            }],
            ..Default::default()
        };
        let lines = [FileLines {
            path,
            by_model: vec![(None, hashes(&["one();", "two();", "three();"]))],
        }];
        let built_from = Fingerprint {
            built_with: "test".into(),
            raw_bytes: 1,
            transcript_path: None,
            transcript_bytes: 0,
        };
        ledger.upsert(&session, &built_from, &lines).unwrap();
        (dir, ledger, file)
    }

    /// The checkpoints of the session as (age, surviving, days old when taken).
    fn kept(ledger: &Ledger) -> Vec<(String, u64, u64)> {
        ledger
            .checkpoints_of("s1")
            .unwrap()
            .into_iter()
            .map(|c| {
                assert_eq!(c.added, 3);
                (c.checkpoint, c.surviving, c.age_seconds / 86_400)
            })
            .collect()
    }

    #[test]
    fn keeps_what_was_there_at_one_seven_and_thirty_days() {
        let ended = Utc::now();
        let (_dir, mut ledger, file) = one_session(ended);
        let hours = chrono::Duration::hours;
        let days = chrono::Duration::days;
        let now = |ledger: &Ledger| ledger.rewrite_of("s1").unwrap().0[0].surviving;

        // Two hours old: measured, and no age reached yet.
        assert_eq!(
            measure(&mut ledger, ended + hours(2)).unwrap().checkpoints,
            0
        );
        assert_eq!((kept(&ledger), now(&ledger)), (vec![], 3));

        // Day 1 was missed. The measurement on day 3 stands for it, and says so.
        fs::write(&file, "one();\ntwo();\n").unwrap();
        assert_eq!(
            measure(&mut ledger, ended + days(3)).unwrap().checkpoints,
            1
        );
        assert_eq!(kept(&ledger), [("1d".to_string(), 2, 3)]);

        fs::write(&file, "one();\n").unwrap();
        measure(&mut ledger, ended + days(8)).unwrap();
        assert_eq!(
            kept(&ledger),
            [("1d".to_string(), 2, 3), ("7d".to_string(), 1, 8)]
        );

        measure(&mut ledger, ended + days(31)).unwrap();
        let all = [
            ("1d".to_string(), 2, 3),
            ("7d".to_string(), 1, 8),
            ("30d".to_string(), 1, 31),
        ];
        assert_eq!(kept(&ledger), all);
        let at = ledger.checkpoints_of("s1").unwrap()[2].measured_at;
        assert_eq!(at, Some(ended + days(31)));

        // Measuring again changes what is there now, and no checkpoint.
        fs::write(&file, "nothing of it\n").unwrap();
        assert_eq!(
            measure(&mut ledger, ended + days(40)).unwrap().checkpoints,
            0
        );
        assert_eq!((kept(&ledger), now(&ledger)), (all.to_vec(), 0));
    }

    #[test]
    fn an_age_reached_before_checkpoints_were_kept_is_not_made_up() {
        // The session was 20 days old when this ledger began keeping them.
        let began = Utc::now();
        let days = chrono::Duration::days;
        let (dir, mut ledger, file) = one_session(began - days(20));
        measure(&mut ledger, began + chrono::Duration::hours(1)).unwrap();
        assert_eq!(kept(&ledger), []);
        // Thirty days is still to come, and is kept when it does.
        measure(&mut ledger, began + days(11)).unwrap();
        assert_eq!(kept(&ledger), [("30d".to_string(), 3, 31)]);
        // Opening the ledger again does not begin again.
        drop(ledger);
        let mut ledger = Ledger::open(&dir.path().join("ledger.db")).unwrap();
        fs::remove_file(&file).unwrap();
        measure(&mut ledger, began + days(12)).unwrap();
        assert_eq!(kept(&ledger), [("30d".to_string(), 3, 31)]);
    }

    #[test]
    fn a_session_that_went_on_is_aged_from_its_new_end() {
        let ended = Utc::now();
        let days = chrono::Duration::days;
        let (dir, mut ledger, _file) = one_session(ended);
        measure(&mut ledger, ended + days(2)).unwrap();
        assert_eq!(kept(&ledger), [("1d".to_string(), 3, 2)]);

        // Storing it again as it is keeps the checkpoint.
        let built_from = ledger.fingerprint("s1").unwrap().unwrap();
        let lines = ledger.lines_of("s1").unwrap();
        let mut session = ledger.get("s1").unwrap().unwrap();
        ledger.upsert(&session, &built_from, &lines).unwrap();
        assert_eq!(kept(&ledger).len(), 1);

        // Resumed on day 5: what was measured on day 2 was not after its end.
        session.ended_at = Some(ended + days(5));
        ledger.upsert(&session, &built_from, &lines).unwrap();
        assert_eq!(kept(&ledger), []);
        measure(&mut ledger, ended + days(5) + chrono::Duration::hours(3)).unwrap();
        assert_eq!(kept(&ledger), []);
        measure(&mut ledger, ended + days(7)).unwrap();
        assert_eq!(kept(&ledger), [("1d".to_string(), 3, 2)]);

        // With the directory gone nothing can be said, and nothing is kept.
        let gone = dir.path().join("gone");
        session.repo.as_mut().unwrap().root = gone.to_string_lossy().into_owned();
        session.files[0].path = gone.join("a.rs").to_string_lossy().into_owned();
        let moved = [FileLines {
            path: session.files[0].path.clone(),
            by_model: vec![(None, hashes(&["one();", "two();", "three();"]))],
        }];
        ledger.upsert(&session, &built_from, &moved).unwrap();
        let report = measure(&mut ledger, ended + days(13)).unwrap();
        assert_eq!((report.unavailable, report.checkpoints), (1, 0));
        assert_eq!(kept(&ledger).len(), 1);
    }

    #[test]
    fn counts_surviving_lines_as_a_multiset() {
        let added = hashes(&["a1", "a1", "b2", "c3"]);
        let current = count("x9\n  a1\nb2\nb2\n".lines().filter_map(line_hash));
        // one of the two a1 lines, the b2 line, no c3
        assert_eq!(surviving(&added, &current), 2);
        assert_eq!(surviving(&added, &HashMap::new()), 0);
    }
}
