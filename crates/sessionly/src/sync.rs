//! `sessionly sync`: normalize captured sessions into the ledger.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::ledger::{Fingerprint, Ledger};
use crate::normalize;
use crate::session::SCHEMA_VERSION;

#[derive(Debug, Default, PartialEq)]
pub struct Report {
    pub synced: u64,
    pub unchanged: u64,
    /// Capture files with no usable events.
    pub empty: u64,
    pub failed: Vec<(PathBuf, String)>,
}

fn size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// Normalize every session in `raw_dir` whose capture or transcript changed
/// since it was last stored (or all of them with `force`).
pub fn run(raw_dir: &Path, ledger: &mut Ledger, force: bool) -> Result<Report> {
    let mut report = Report::default();
    let mut files: Vec<PathBuf> = match fs::read_dir(raw_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
            .collect(),
        Err(_) => return Ok(report),
    };
    files.sort();

    for raw in files {
        let stem = raw
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let raw_bytes = size(&raw);
        if !force {
            if let Some(stored) = ledger.fingerprint(&stem)? {
                let transcript_bytes = stored
                    .transcript_path
                    .as_deref()
                    .map_or(0, |p| size(Path::new(p)));
                if stored.schema_version == SCHEMA_VERSION
                    && stored.raw_bytes == raw_bytes
                    && stored.transcript_bytes == transcript_bytes
                {
                    report.unchanged += 1;
                    continue;
                }
            }
        }
        match normalize::build_from_raw(&raw) {
            Ok(Some(built)) => {
                let fingerprint = Fingerprint {
                    schema_version: SCHEMA_VERSION,
                    raw_bytes,
                    transcript_bytes: built.transcript_path.as_deref().map_or(0, size),
                    transcript_path: built
                        .transcript_path
                        .map(|p| p.to_string_lossy().into_owned()),
                };
                ledger.upsert(&built.session, &fingerprint)?;
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
    use std::io::Write;

    fn capture(dir: &Path, session: &str, prompts: usize) {
        let mut f = fs::File::create(dir.join(format!("{session}.jsonl"))).unwrap();
        for i in 0..prompts {
            let line = serde_json::json!({
                "hook": "UserPromptSubmit", "received_at": "2026-11-13T10:00:00Z",
                "payload": { "session_id": session, "prompt_id": format!("p{i}"), "prompt": "hi" }
            });
            writeln!(f, "{line}").unwrap();
        }
    }

    #[test]
    fn syncs_incrementally() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("raw");
        fs::create_dir_all(&raw).unwrap();
        capture(&raw, "s1", 1);
        capture(&raw, "s2", 1);
        fs::write(
            raw.join("_unknown.jsonl"),
            "{\"payload\":{\"_unparsed\":\"x\"}}\n",
        )
        .unwrap();
        let mut ledger = Ledger::open(&dir.path().join("l.db")).unwrap();

        let first = run(&raw, &mut ledger, false).unwrap();
        assert_eq!((first.synced, first.unchanged, first.empty), (2, 0, 1));
        let second = run(&raw, &mut ledger, false).unwrap();
        assert_eq!((second.synced, second.unchanged), (0, 2));

        capture(&raw, "s1", 2); // s1 grew
        let third = run(&raw, &mut ledger, false).unwrap();
        assert_eq!((third.synced, third.unchanged), (1, 1));
        assert_eq!(ledger.get("s1").unwrap().unwrap().counts.prompts, 2);

        let forced = run(&raw, &mut ledger, true).unwrap();
        assert_eq!(forced.synced, 2);
        assert!(forced.failed.is_empty());
    }

    #[test]
    fn missing_raw_dir_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        let mut ledger = Ledger::open(&dir.path().join("l.db")).unwrap();
        let report = run(&dir.path().join("nope"), &mut ledger, false).unwrap();
        assert_eq!(report, Report::default());
    }
}
