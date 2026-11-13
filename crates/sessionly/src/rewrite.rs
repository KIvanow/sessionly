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
//! - Only changes made through the agent's file tools are known. The current
//!   file is whatever is checked out when the measurement runs.

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

/// The agent's added lines per file, from raw capture records. Each file's
/// list keeps duplicates (it is a multiset) and files are in order of first change.
pub fn added_lines(events: &[Value]) -> Vec<(String, Vec<u64>)> {
    let mut order: Vec<String> = Vec::new();
    let mut counts: HashMap<String, HashMap<u64, i64>> = HashMap::new();
    for record in events {
        if record["hook"].as_str() != Some("PostToolUse") {
            continue;
        }
        let p = &record["payload"];
        let input = &p["tool_input"];
        let response = &p["tool_response"];
        let Some(path) = ["file_path", "notebook_path"]
            .iter()
            .find_map(|k| input[*k].as_str())
        else {
            continue;
        };
        let mut added: Vec<u64> = Vec::new();
        let mut removed: Vec<u64> = Vec::new();
        match response["structuredPatch"]
            .as_array()
            .filter(|h| !h.is_empty())
        {
            Some(hunks) => {
                let lines = hunks
                    .iter()
                    .filter_map(|h| h["lines"].as_array())
                    .flatten()
                    .filter_map(Value::as_str);
                for line in lines {
                    match line.as_bytes().first() {
                        Some(b'+') => added.extend(line_hash(&line[1..])),
                        Some(b'-') => removed.extend(line_hash(&line[1..])),
                        _ => {}
                    }
                }
            }
            // A newly created file has no patch: every line is new.
            None if response["type"].as_str() == Some("create") => {
                let content = input["content"].as_str().unwrap_or_default();
                added.extend(content.lines().filter_map(line_hash));
            }
            None => continue,
        }
        if !counts.contains_key(path) {
            order.push(path.to_string());
        }
        let file = counts.entry(path.to_string()).or_default();
        // A line the agent removes again was its own to remove: un-count it.
        for hash in removed {
            if let Some(n) = file.get_mut(&hash).filter(|n| **n > 0) {
                *n -= 1;
            }
        }
        for hash in added {
            *file.entry(hash).or_insert(0) += 1;
        }
    }
    order
        .into_iter()
        .filter_map(|path| {
            let mut hashes: Vec<u64> = counts[&path]
                .iter()
                .flat_map(|(hash, n)| std::iter::repeat_n(*hash, (*n).max(0) as usize))
                .collect();
            hashes.sort_unstable();
            (!hashes.is_empty()).then_some((path, hashes))
        })
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
/// the previous measurement, if any, is kept.
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

    #[test]
    fn counts_surviving_lines_as_a_multiset() {
        let added = hashes(&["a1", "a1", "b2", "c3"]);
        let current = count("x9\n  a1\nb2\nb2\n".lines().filter_map(line_hash));
        // one of the two a1 lines, the b2 line, no c3
        assert_eq!(surviving(&added, &current), 2);
        assert_eq!(surviving(&added, &HashMap::new()), 0);
    }
}
