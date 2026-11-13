//! `sessionly sync`: normalize captured sessions into the ledger.

use std::collections::{BTreeMap, BTreeSet};
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
    /// Sessions dropped from the ledger because their capture is gone
    /// (only a full rebuild does this).
    pub removed: u64,
    pub failed: Vec<(PathBuf, String)>,
}

/// Identifies the code, price table and machine id a record was built with:
/// a record built with anything else is rebuilt.
pub fn built_with(machine_id: &str) -> String {
    format!(
        "{}+schema{}+prices{}+{machine_id}",
        env!("CARGO_PKG_VERSION"),
        crate::session::SCHEMA_VERSION,
        crate::pricing::PRICING_VERSION
    )
}

/// Bring the ledger up to date with everything captured on this machine, then
/// re-measure how much of each session's changes is still in the files.
pub fn sync_all(
    ledger: &mut Ledger,
    config: &crate::config::Config,
    force: bool,
) -> Result<(Report, crate::rewrite::Report)> {
    // Sessions imported from transcripts follow their transcript.
    let imported_dir = crate::paths::claude_imported_dir()?;
    crate::import::refresh(&imported_dir);
    let report = run(
        &crate::paths::claude_raw_dir()?,
        &imported_dir,
        &crate::paths::claude_facts_dir()?,
        ledger,
        &config.machine_id,
        force,
    )?;
    let rewrite = crate::rewrite::measure(ledger, chrono::Utc::now())?;
    Ok((report, rewrite))
}

fn jsonl_files(dir: &Path) -> BTreeMap<String, PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|p| Some((p.file_stem()?.to_string_lossy().into_owned(), p)))
        .collect()
}

fn size(path: Option<&PathBuf>) -> u64 {
    path.and_then(|p| fs::metadata(p).ok())
        .map_or(0, |m| m.len())
}

/// Build a session from its hook capture, its import, or both. A capture
/// that saw the session from its start is the better source. One that began
/// partway covers less than the transcript does, so an import wins over it.
fn build(
    raw: Option<&PathBuf>,
    imported: Option<&PathBuf>,
    facts_dir: &Path,
) -> Result<Option<normalize::Built>> {
    let from_raw = match raw {
        Some(path) => normalize::build_from_raw(path, facts_dir)?,
        None => None,
    };
    if from_raw
        .as_ref()
        .is_some_and(|b| b.session.captured_from_start)
    {
        return Ok(from_raw);
    }
    let from_import = match imported {
        Some(path) => normalize::build_from_raw(path, facts_dir)?,
        None => None,
    };
    Ok(from_import.or(from_raw))
}

/// Normalize every session whose capture, import or transcript changed since
/// it was last stored (or all of them with `force`).
pub fn run(
    raw_dir: &Path,
    imported_dir: &Path,
    facts_dir: &Path,
    ledger: &mut Ledger,
    machine_id: &str,
    force: bool,
) -> Result<Report> {
    let mut report = Report::default();
    let raw = jsonl_files(raw_dir);
    let imported = jsonl_files(imported_dir);
    let stems: BTreeSet<&String> = raw.keys().chain(imported.keys()).collect();
    let built_with = built_with(machine_id);
    let mut present: Vec<String> = Vec::new();

    for stem in stems {
        let (raw, imported) = (raw.get(stem), imported.get(stem));
        let source_bytes = size(raw) + size(imported);
        if !force {
            if let Some(stored) = ledger.fingerprint(stem)? {
                let transcript_bytes = stored
                    .transcript_path
                    .as_deref()
                    .map_or(0, |p| transcript::tree_size(Path::new(p)));
                if stored.built_with == built_with
                    && stored.raw_bytes == source_bytes
                    && stored.transcript_bytes == transcript_bytes
                {
                    report.unchanged += 1;
                    present.push(stem.clone());
                    continue;
                }
            }
        }
        let source = raw.or(imported).cloned().unwrap_or_default();
        match build(raw, imported, facts_dir) {
            Ok(Some(mut built)) => {
                built.session.machine_id = machine_id.to_string();
                // Files are named after their session. Anything else (a copy,
                // a renamed file) must not overwrite the real session.
                let expected = crate::capture::file_stem(Some(&built.session.session_id));
                if expected != *stem {
                    let reason = format!("file name does not match its session id ({expected})");
                    report.failed.push((source, reason));
                    continue;
                }
                let fingerprint = Fingerprint {
                    built_with: built_with.clone(),
                    raw_bytes: source_bytes,
                    transcript_bytes: built
                        .transcript_path
                        .as_deref()
                        .map_or(0, transcript::tree_size),
                    transcript_path: built
                        .transcript_path
                        .map(|p| p.to_string_lossy().into_owned()),
                };
                ledger.upsert(&built.session, &fingerprint, &built.added_lines)?;
                present.push(built.session.session_id);
                report.synced += 1;
            }
            Ok(None) => report.empty += 1,
            Err(err) => report.failed.push((source, format!("{err:#}"))),
        }
    }
    // A full rebuild makes the ledger match the capture exactly. A normal
    // sync never removes anything.
    if force {
        report.removed = ledger.retain(&present)?;
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
            let imported = self.raw.with_file_name("imported");
            run(
                &self.raw,
                &imported,
                &self.facts,
                &mut self.ledger,
                "machine-1",
                force,
            )
            .unwrap()
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
        let s1 = env.ledger.get("s1").unwrap().unwrap();
        assert_eq!(s1.counts.prompts, 2);
        assert_eq!(s1.machine_id, "machine-1");

        let forced = env.sync(true);
        assert_eq!(forced.synced, 2);
        assert!(forced.failed.is_empty());

        // A capture file that is deleted stays in the ledger until a full rebuild.
        fs::remove_file(env.raw.join("s2.jsonl")).unwrap();
        assert_eq!(env.sync(false).removed, 0);
        assert!(env.ledger.get("s2").unwrap().is_some());
        assert_eq!(env.sync(true).removed, 1);
        assert!(env.ledger.get("s2").unwrap().is_none());
        assert!(env.ledger.get("s1").unwrap().is_some());
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
    fn an_import_fills_in_for_a_capture_that_began_partway() {
        let mut env = env();
        let imported = env.raw.with_file_name("imported");
        fs::create_dir_all(&imported).unwrap();
        let event = |hook: &str, origin: Option<&str>, extra: serde_json::Value| {
            let mut payload = json!({ "session_id": "s1" });
            for (k, v) in extra.as_object().unwrap() {
                payload[k] = v.clone();
            }
            let mut record =
                json!({ "hook": hook, "received_at": "2026-11-13T10:00:00Z", "payload": payload });
            if let Some(origin) = origin {
                record["origin"] = json!(origin);
            }
            record.to_string() + "\n"
        };
        let prompt = |n: u32, origin| {
            event(
                "UserPromptSubmit",
                origin,
                json!({ "prompt_id": format!("p{n}"), "prompt": "x" }),
            )
        };
        let from = |env: &Env| env.ledger.get("s1").unwrap().unwrap();
        use crate::session::CapturedBy::{Hooks, Transcript};

        // Hooks installed mid-session: one prompt captured, no session start.
        fs::write(env.raw.join("s1.jsonl"), prompt(3, None)).unwrap();
        env.sync(false);
        assert_eq!(
            (from(&env).captured_by, from(&env).counts.prompts),
            (Hooks, 1)
        );

        // The import knows the whole session and takes over.
        let whole = event(
            "SessionStart",
            Some("transcript"),
            json!({ "source": "startup" }),
        ) + &prompt(1, Some("transcript"))
            + &prompt(2, Some("transcript"))
            + &prompt(3, Some("transcript"));
        fs::write(imported.join("s1.jsonl"), whole).unwrap();
        assert_eq!(env.sync(false).synced, 1);
        assert_eq!(
            (from(&env).captured_by, from(&env).counts.prompts),
            (Transcript, 3)
        );
        assert_eq!(env.sync(false).unchanged, 1);

        // A capture that saw the session start is preferred over an import.
        let complete =
            event("SessionStart", None, json!({ "source": "startup" })) + &prompt(1, None);
        fs::write(env.raw.join("s1.jsonl"), complete).unwrap();
        env.sync(false);
        assert_eq!(
            (from(&env).captured_by, from(&env).counts.prompts),
            (Hooks, 1)
        );

        // Import only.
        fs::write(
            imported.join("s2.jsonl"),
            event(
                "SessionStart",
                Some("transcript"),
                json!({ "session_id": "s2" }),
            ),
        )
        .unwrap();
        env.sync(false);
        assert_eq!(
            env.ledger.get("s2").unwrap().unwrap().captured_by,
            Transcript
        );
    }

    #[test]
    fn missing_raw_dir_is_fine() {
        let mut env = env();
        env.raw = env.raw.join("nope");
        assert_eq!(env.sync(false), Report::default());
    }
}
