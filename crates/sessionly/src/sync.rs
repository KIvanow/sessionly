//! `sessionly sync`: normalize captured sessions into the ledger.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::ledger::{Fingerprint, Ledger};
use crate::normalize;
use crate::transcript;

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub synced: u64,
    pub unchanged: u64,
    /// Capture files with no usable events.
    pub empty: u64,
    pub failed: Vec<(PathBuf, String)>,
}

/// Identifies the code and price table a record was built with: a record
/// built by anything else is rebuilt.
pub fn built_with() -> String {
    format!(
        "{}+schema{}+prices{}",
        env!("CARGO_PKG_VERSION"),
        crate::session::SCHEMA_VERSION,
        crate::pricing::PRICING_VERSION
    )
}

/// Normalize every session in `raw_dir` whose capture or transcript changed
/// since it was last stored (or all of them with `force`).
pub fn run(raw_dir: &Path, facts_dir: &Path, ledger: &mut Ledger, force: bool) -> Result<Report> {
    let mut report = Report::default();
    let mut files: Vec<PathBuf> = match fs::read_dir(raw_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
            .collect(),
        Err(_) => return Ok(report),
    };
    files.sort();
    let built_with = built_with();

    for raw in files {
        let stem = raw
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let raw_bytes = fs::metadata(&raw).map(|m| m.len()).unwrap_or(0);
        if !force {
            if let Some(stored) = ledger.fingerprint(&stem)? {
                let transcript_bytes = stored
                    .transcript_path
                    .as_deref()
                    .map_or(0, |p| transcript::tree_size(Path::new(p)));
                if stored.built_with == built_with
                    && stored.raw_bytes == raw_bytes
                    && stored.transcript_bytes == transcript_bytes
                {
                    report.unchanged += 1;
                    continue;
                }
            }
        }
        match normalize::build_from_raw(&raw, facts_dir) {
            Ok(Some(built)) => {
                // `capture` names each file after its session. Anything else
                // (a copy, a renamed file) must not overwrite the real session.
                let expected = crate::capture::file_stem(Some(&built.session.session_id));
                if expected != stem {
                    let reason = format!("file name does not match its session id ({expected})");
                    report.failed.push((raw, reason));
                    continue;
                }
                let fingerprint = Fingerprint {
                    built_with: built_with.clone(),
                    raw_bytes,
                    transcript_bytes: built
                        .transcript_path
                        .as_deref()
                        .map_or(0, transcript::tree_size),
                    transcript_path: built
                        .transcript_path
                        .map(|p| p.to_string_lossy().into_owned()),
                };
                ledger.upsert(&built.session, &fingerprint, &built.added_lines)?;
                report.synced += 1;
            }
            Ok(None) => report.empty += 1,
            Err(err) => report.failed.push((raw, format!("{err:#}"))),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    struct Env {
        _dir: tempfile::TempDir,
        raw: PathBuf,
        facts: PathBuf,
        transcripts: PathBuf,
        ledger: Ledger,
    }

    fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("raw");
        fs::create_dir_all(&raw).unwrap();
        Env {
            raw,
            facts: dir.path().join("facts"),
            transcripts: dir.path().join("transcripts"),
            ledger: Ledger::open(&dir.path().join("l.db")).unwrap(),
            _dir: dir,
        }
    }

    impl Env {
        fn sync(&mut self, force: bool) -> Report {
            run(&self.raw, &self.facts, &mut self.ledger, force).unwrap()
        }

        fn capture(&self, session: &str, prompts: usize) {
            let mut f = fs::File::create(self.raw.join(format!("{session}.jsonl"))).unwrap();
            for i in 0..prompts {
                let line = json!({
                    "hook": "UserPromptSubmit", "received_at": "2026-11-13T10:00:00Z",
                    "payload": { "session_id": session, "prompt_id": format!("p{i}"), "prompt": "hi",
                                 "transcript_path": self.transcripts.join(format!("{session}.jsonl")) }
                });
                writeln!(f, "{line}").unwrap();
            }
        }

        /// Append a response worth $20 (1M opus 5.5 output tokens) to a transcript file.
        fn spend(&self, relative: &str, id: &str) {
            let path = self.transcripts.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let row = json!({ "type": "assistant", "timestamp": "2026-11-13T10:00:00Z",
                "message": { "id": id, "model": "claude-opus-5-5", "usage": { "output_tokens": 1_000_000 } } });
            let mut f = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .unwrap();
            writeln!(f, "{row}").unwrap();
        }

        fn cost(&self, session: &str) -> Option<f64> {
            let record = self.ledger.get(session).unwrap().unwrap();
            record.cost.map(|c| c.total_usd)
        }
    }

    #[test]
    fn syncs_incrementally() {
        let mut env = env();
        env.capture("s1", 1);
        env.capture("s2", 1);
        fs::write(
            env.raw.join("_unknown.jsonl"),
            "{\"payload\":{\"_unparsed\":\"x\"}}\n",
        )
        .unwrap();

        let first = env.sync(false);
        assert_eq!((first.synced, first.unchanged, first.empty), (2, 0, 1));
        let second = env.sync(false);
        assert_eq!((second.synced, second.unchanged), (0, 2));

        env.capture("s1", 2); // s1 grew
        let third = env.sync(false);
        assert_eq!((third.synced, third.unchanged), (1, 1));
        assert_eq!(env.ledger.get("s1").unwrap().unwrap().counts.prompts, 2);

        let forced = env.sync(true);
        assert_eq!(forced.synced, 2);
        assert!(forced.failed.is_empty());
    }

    #[test]
    fn transcript_and_subagent_growth_trigger_a_resync() {
        let mut env = env();
        env.capture("s1", 1);
        env.spend("s1.jsonl", "m1");
        env.sync(false);
        assert_eq!(env.cost("s1"), Some(20.0));

        env.spend("s1/subagents/agent-a.jsonl", "m2");
        assert_eq!(env.sync(false).synced, 1);
        assert_eq!(env.cost("s1"), Some(40.0));
        assert_eq!(env.sync(false).unchanged, 1);
    }

    #[test]
    fn cost_is_kept_when_the_transcript_is_deleted_and_the_ledger_rebuilt() {
        let mut env = env();
        env.capture("s1", 1);
        env.spend("s1.jsonl", "m1");
        env.sync(false);
        fs::remove_dir_all(&env.transcripts).unwrap();

        assert_eq!(env.sync(false).synced, 1); // the change is noticed
        assert_eq!(env.cost("s1"), Some(20.0));
        assert_eq!(env.sync(false).unchanged, 1); // and it settles

        assert_eq!(env.sync(true).synced, 1); // a full rebuild keeps it too
        assert_eq!(env.cost("s1"), Some(20.0));

        env.spend("s1.jsonl", "m1"); // the transcript comes back, larger
        env.spend("s1.jsonl", "m2");
        assert_eq!(env.sync(false).synced, 1);
        assert_eq!(env.cost("s1"), Some(40.0));
    }

    #[test]
    fn a_copied_capture_file_does_not_replace_the_session() {
        let mut env = env();
        env.capture("s1", 2);
        fs::copy(env.raw.join("s1.jsonl"), env.raw.join("s1 copy.jsonl")).unwrap();
        let report = env.sync(false);
        assert_eq!(report.synced, 1);
        assert_eq!(report.failed.len(), 1);
        assert!(report.failed[0].1.contains("does not match"));
    }

    #[test]
    fn missing_raw_dir_is_fine() {
        let mut env = env();
        env.raw = env.raw.join("nope");
        assert_eq!(env.sync(false), Report::default());
    }
}
