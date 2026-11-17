//! `sessionly sync`: normalize captured sessions into the ledger.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::import_codex::Roots;
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
    /// (only a full rebuild does this), or because they turned out to be a
    /// Codex subagent's thread.
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

/// Where one agent's sessions are kept under the data directory.
pub struct SourceDirs {
    pub source: String,
    /// Hook payloads as captured.
    pub raw: PathBuf,
    /// Sessions rebuilt by `sessionly import`.
    pub imported: PathBuf,
    /// Cost, usage and timing last read for each session.
    pub facts: PathBuf,
}

impl SourceDirs {
    pub fn in_data_dir(data_dir: &Path, source: &str) -> SourceDirs {
        SourceDirs {
            source: source.to_string(),
            raw: data_dir.join("raw").join(source),
            imported: data_dir.join("imported").join(source),
            facts: data_dir.join("transcript-facts").join(source),
        }
    }
}

/// Bring the ledger up to date with everything captured or imported on this
/// machine, then re-measure how much of each session's changes is still in
/// the files.
pub fn sync_all(
    ledger: &mut Ledger,
    config: &crate::config::Config,
    force: bool,
) -> Result<(Report, crate::rewrite::Report)> {
    let data_dir = crate::paths::data_dir()?;
    // Imported sessions follow the files they were imported from.
    crate::import::refresh(&crate::import::AgentHomes::detect(), &data_dir);
    let sources: Vec<SourceDirs> = crate::paths::SOURCES
        .iter()
        .map(|source| SourceDirs::in_data_dir(&data_dir, source))
        .collect();
    let report = run(&sources, ledger, &config.machine_id, force)?;
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

/// The thread a Codex session file began as, when that is another thread:
/// the file is of a subagent.
fn codex_root(file: &Path, stem: &str, roots: &mut Roots) -> Option<String> {
    let rollout = roots.rollout_of(file)?;
    roots
        .root_of(&rollout)
        .filter(|root| crate::capture::file_stem(Some(root)) != stem)
}

/// What `take_subagents` found: the captures of each session's subagents, and
/// each subagent's own stem with its session's.
#[derive(Default)]
struct Subagents {
    captures: BTreeMap<String, Vec<PathBuf>>,
    folded: Vec<(String, String)>,
}

/// Codex's hooks run in a subagent's thread too, so its capture is a file of
/// its own, and a subagent whose session was missing once may have been
/// imported alone. Neither is a session while the session that spawned it
/// is: take their stems out of `stems`. That is the importer's rule too: a
/// subagent belongs to a session that has an import, which is when the
/// session's rollout exists. Otherwise it stands alone.
fn take_subagents(
    raw: &BTreeMap<String, PathBuf>,
    imported: &BTreeMap<String, PathBuf>,
    stems: &mut BTreeSet<&String>,
    roots: &mut Roots,
) -> Subagents {
    let mut found = Subagents::default();
    let all: Vec<String> = stems.iter().map(|s| (*s).clone()).collect();
    for stem in all {
        let Some(file) = raw.get(&stem).or(imported.get(&stem)) else {
            continue;
        };
        let Some(root) = codex_root(file, &stem, roots) else {
            continue;
        };
        let root = crate::capture::file_stem(Some(&root));
        if imported.contains_key(&root) {
            stems.remove(&stem);
            if let Some(capture) = raw.get(&stem) {
                found
                    .captures
                    .entry(root.clone())
                    .or_default()
                    .push(capture.clone());
            }
            found.folded.push((stem, root));
        }
    }
    found
}

fn size(path: Option<&PathBuf>) -> u64 {
    path.and_then(|p| fs::metadata(p).ok())
        .map_or(0, |m| m.len())
}

/// How many times Codex asked for permission, from its hook captures: the
/// session's own and its subagents'. One that cannot be read counts for none.
fn permission_requests<'a>(captures: impl Iterator<Item = &'a PathBuf>) -> u64 {
    let mut asked = 0;
    for path in captures {
        let _ = crate::jsonl::for_each(path, |record| {
            asked += u64::from(record["hook"] == "PermissionRequest");
        });
    }
    asked
}

/// Build a session from its hook capture, its import, or both.
///
/// For Claude Code a capture that saw the session from its start is the
/// better source (it has permission prompts and exact timing); one that began
/// partway covers less than the transcript does, so an import wins over it.
/// For other agents the hooks only say that a session happened: their own
/// session files hold more, so an import always wins. Codex's files leave out
/// one thing its hooks do say: that it asked for permission. A subagent's
/// thread has a capture of its own, which counts toward the session that
/// spawned it (`subagent_raw`).
fn build(
    dirs: &SourceDirs,
    raw: Option<&PathBuf>,
    imported: Option<&PathBuf>,
    subagent_raw: &[PathBuf],
) -> Result<Option<normalize::Built>> {
    let from = |path: Option<&PathBuf>| match path {
        Some(path) => normalize::build_from_raw(path, &dirs.facts, &dirs.source),
        None => Ok(None),
    };
    if dirs.source != crate::paths::CLAUDE_CODE {
        let mut built = match from(imported)? {
            Some(built) => Some(built),
            None => from(raw)?,
        };
        if let (Some(built), true) = (&mut built, dirs.source == crate::paths::CODEX) {
            if raw.is_some() || !subagent_raw.is_empty() {
                built.session.counts.permission_requests =
                    permission_requests(raw.into_iter().chain(subagent_raw));
            }
        }
        return Ok(built);
    }
    let from_raw = from(raw)?;
    if from_raw
        .as_ref()
        .is_some_and(|b| b.session.captured_from_start)
    {
        return Ok(from_raw);
    }
    // Only the capture knows that a session ran in the cloud, and for whom.
    let runtime = from_raw.as_ref().and_then(|b| b.runtime.clone());
    let mut from_import = from(imported)?;
    if let (Some(built), Some(runtime)) = (&mut from_import, &runtime) {
        normalize::apply_runtime(&mut built.session, runtime);
        built.runtime = Some(runtime.clone());
    }
    Ok(from_import.or(from_raw))
}

/// What became of one session in a sync.
enum Outcome {
    /// Already in the ledger as it should be.
    Unchanged(String),
    /// The session's id, and the name of its files.
    Synced(String, String),
    /// Nothing usable in its files.
    Empty,
    Failed(PathBuf, String),
}

/// The sessions that are in the ledger once a sync is done: their ids, and
/// the names of their files.
#[derive(Default)]
struct Present {
    ids: Vec<String>,
    stems: HashSet<String>,
}

/// Count `outcome` in `report`, and note the sessions that are in the ledger.
fn record(outcome: Outcome, report: &mut Report, present: &mut Present) {
    match outcome {
        Outcome::Unchanged(stem) => {
            report.unchanged += 1;
            present.ids.push(stem.clone());
            present.stems.insert(stem);
        }
        Outcome::Synced(id, stem) => {
            report.synced += 1;
            present.ids.push(id);
            present.stems.insert(stem);
        }
        Outcome::Empty => report.empty += 1,
        Outcome::Failed(source, reason) => report.failed.push((source, reason)),
    }
}

/// What syncing the sessions of one agent has in common.
struct Pass<'a> {
    dirs: &'a SourceDirs,
    raw: &'a BTreeMap<String, PathBuf>,
    imported: &'a BTreeMap<String, PathBuf>,
    built_with: &'a str,
    machine_id: &'a str,
    force: bool,
}

impl Pass<'_> {
    /// Bring one session up to date. `subagent_raw` are the captures of
    /// subagents that are part of it.
    fn stem(&self, ledger: &mut Ledger, stem: &str, subagent_raw: &[PathBuf]) -> Result<Outcome> {
        let (raw, imported) = (self.raw.get(stem), self.imported.get(stem));
        let source_bytes =
            size(raw) + size(imported) + subagent_raw.iter().map(|p| size(Some(p))).sum::<u64>();
        if !self.force {
            if let Some(stored) = ledger.fingerprint(stem)? {
                let transcript_bytes = stored
                    .transcript_path
                    .as_deref()
                    .map_or(0, |p| transcript::tree_size(Path::new(p)));
                if stored.built_with == self.built_with
                    && stored.raw_bytes == source_bytes
                    && stored.transcript_bytes == transcript_bytes
                {
                    return Ok(Outcome::Unchanged(stem.to_string()));
                }
            }
        }
        let source = raw.or(imported).cloned().unwrap_or_default();
        Ok(match build(self.dirs, raw, imported, subagent_raw) {
            Ok(Some(mut built)) => {
                built.session.machine_id = self.machine_id.to_string();
                // Files are named after their session. Anything else (a copy,
                // a renamed file) must not overwrite the real session.
                let expected = crate::capture::file_stem(Some(&built.session.session_id));
                if expected != stem {
                    let reason = format!("file name does not match its session id ({expected})");
                    return Ok(Outcome::Failed(source, reason));
                }
                let fingerprint = Fingerprint {
                    built_with: self.built_with.to_string(),
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
                Outcome::Synced(built.session.session_id, stem.to_string())
            }
            Ok(None) => Outcome::Empty,
            Err(err) => Outcome::Failed(source, format!("{err:#}")),
        })
    }
}

/// Normalize every session whose capture, import or transcript changed since
/// it was last stored (or all of them with `force`).
pub fn run(
    sources: &[SourceDirs],
    ledger: &mut Ledger,
    machine_id: &str,
    force: bool,
) -> Result<Report> {
    let mut report = Report::default();
    let built_with = built_with(machine_id);
    let mut present = Present::default();

    for dirs in sources {
        let raw = jsonl_files(&dirs.raw);
        let imported = jsonl_files(&dirs.imported);
        let mut stems: BTreeSet<&String> = raw.keys().chain(imported.keys()).collect();
        let mut roots = Roots::load(&dirs.imported);
        let subagents = if dirs.source == crate::paths::CODEX {
            take_subagents(&raw, &imported, &mut stems, &mut roots)
        } else {
            Subagents::default()
        };
        roots.save();
        let pass = Pass {
            dirs,
            raw: &raw,
            imported: &imported,
            built_with: &built_with,
            machine_id,
            force,
        };
        for stem in stems {
            let extra = subagents.captures.get(stem).map_or(&[][..], Vec::as_slice);
            record(pass.stem(ledger, stem, extra)?, &mut report, &mut present);
        }
        // A thread that was left out of the sessions for its parent's sake
        // goes once the parent is in the ledger. Until then it keeps what it
        // has, which is all there is of the subagent's work: a parent that
        // came to nothing leaves it to stand alone.
        for (subagent, parent) in &subagents.folded {
            let parent_is_in = present.stems.contains(parent);
            if parent_is_in {
                if ledger.fingerprint(subagent)?.is_some() {
                    report.removed += u64::from(ledger.remove(subagent, parent)?);
                }
            } else {
                record(pass.stem(ledger, subagent, &[])?, &mut report, &mut present);
            }
        }
    }
    // A full rebuild makes the ledger match the captures and imports exactly.
    // A normal sync never removes anything.
    if force {
        report.removed += ledger.retain(&present.ids)?;
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
            let dirs = SourceDirs {
                source: "claude-code".into(),
                raw: self.raw.clone(),
                imported: self.raw.with_file_name("imported"),
                facts: self.facts.clone(),
            };
            run(&[dirs], &mut self.ledger, "machine-1", force).unwrap()
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
    fn a_codex_subagents_capture_is_part_of_its_session() {
        let mut env = env();
        let main = env
            .transcripts
            .join("rollout-2026-11-16T12-00-00-main.jsonl");
        let child = env
            .transcripts
            .join("rollout-2026-11-16T12-00-05-sub.jsonl");
        fs::create_dir_all(&env.transcripts).unwrap();
        fs::write(&main, "{\"payload\":{\"session_id\":\"main\"}}\n").unwrap();
        fs::write(&child, "{\"payload\":{\"session_id\":\"main\"}}\n").unwrap();
        let capture = |session: &str, rollout: &Path, hook: &str| {
            let line = json!({
                "hook": hook, "received_at": "2026-11-16T12:00:00Z",
                "payload": { "session_id": session, "prompt_id": "p", "prompt": "hi",
                             "transcript_path": rollout }
            });
            let mut f = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(env.raw.join(format!("{session}.jsonl")))
                .unwrap();
            writeln!(f, "{line}").unwrap();
        };
        let dirs = || SourceDirs {
            source: "codex".into(),
            raw: env.raw.clone(),
            imported: env.raw.with_file_name("imported"),
            facts: env.facts.clone(),
        };
        // until its parent is known, the subagent's thread is a session
        capture("sub", &child, "UserPromptSubmit");
        capture("sub", &child, "PermissionRequest");
        let alone = run(&[dirs()], &mut env.ledger, "machine-1", false).unwrap();
        assert_eq!(alone.synced, 1);
        assert!(env.ledger.get("sub").unwrap().is_some());
        // and may be uploaded as one
        let server = "https://sessionly.example.com";
        env.ledger.mark_uploaded("sub", server, "hash").unwrap();

        // the parent's own import is what makes it a session with subagents
        capture("main", &main, "UserPromptSubmit");
        let imports = env.raw.with_file_name("imported");
        fs::create_dir_all(&imports).unwrap();
        fs::copy(env.raw.join("main.jsonl"), imports.join("main.jsonl")).unwrap();
        let report = run(&[dirs()], &mut env.ledger, "machine-1", false).unwrap();
        assert_eq!((report.synced, report.removed), (1, 1));
        assert!(env.ledger.get("sub").unwrap().is_none());
        // the server still has it: that is noted, for the next upload
        // once it has the session the subagent is part of
        let noted = vec![crate::ledger::Withdrawal {
            session_id: "sub".into(),
            source: "codex".into(),
            part_of: "main".into(),
        }];
        assert_eq!(env.ledger.withdrawals(server).unwrap(), noted);
        // a rebuild reports it once, not twice
        let forced = run(&[dirs()], &mut env.ledger, "machine-1", true).unwrap();
        assert_eq!(forced.removed, 0);
        assert_eq!(env.ledger.withdrawals(server).unwrap(), noted);
        // should it be uploaded as a session again, the server keeps it
        env.ledger.mark_uploaded("sub", server, "hash").unwrap();
        assert!(env.ledger.withdrawals(server).unwrap().is_empty());
        let session = env.ledger.get("main").unwrap().unwrap();
        assert_eq!(session.counts.permission_requests, 1);
    }

    #[test]
    fn a_codex_subagent_stands_alone_while_its_parent_has_nothing() {
        let mut env = env();
        let main = env
            .transcripts
            .join("rollout-2026-11-16T12-00-00-main.jsonl");
        let child = env
            .transcripts
            .join("rollout-2026-11-16T12-00-05-sub.jsonl");
        fs::create_dir_all(&env.transcripts).unwrap();
        for path in [&main, &child] {
            fs::write(path, "{\"payload\":{\"session_id\":\"main\"}}\n").unwrap();
        }
        let line = json!({
            "hook": "UserPromptSubmit", "received_at": "2026-11-16T12:00:00Z",
            "payload": { "session_id": "sub", "prompt_id": "p", "prompt": "hi", "transcript_path": child }
        });
        fs::write(env.raw.join("sub.jsonl"), format!("{line}\n")).unwrap();
        // the parent has an import, but one with nothing to build a session from
        let imports = env.raw.with_file_name("imported");
        fs::create_dir_all(&imports).unwrap();
        fs::write(
            imports.join("main.jsonl"),
            "{\"payload\":{\"_unparsed\":\"x\"}}\n",
        )
        .unwrap();
        let dirs = SourceDirs {
            source: "codex".into(),
            raw: env.raw.clone(),
            imported: imports,
            facts: env.facts.clone(),
        };
        let report = run(&[dirs], &mut env.ledger, "machine-1", false).unwrap();
        assert_eq!((report.synced, report.empty), (1, 1));
        assert!(env.ledger.get("sub").unwrap().is_some());
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
        let start = event(
            "SessionStart",
            Some("transcript"),
            json!({ "session_id": "s2" }),
        );
        let asked = event(
            "UserPromptSubmit",
            Some("transcript"),
            json!({ "session_id": "s2", "prompt_id": "p1", "prompt": "x" }),
        );
        fs::write(imported.join("s2.jsonl"), start.clone() + &asked).unwrap();
        env.sync(false);
        assert_eq!(
            env.ledger.get("s2").unwrap().unwrap().captured_by,
            Transcript
        );

        // An agent opened and closed again, with nothing asked, is no session.
        fs::write(imported.join("s3.jsonl"), start.replace("s2", "s3")).unwrap();
        assert_eq!(env.sync(false).empty, 1);
        assert!(env.ledger.get("s3").unwrap().is_none());
    }

    #[test]
    fn other_agents_prefer_their_import_and_keep_their_name() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = SourceDirs::in_data_dir(dir.path(), "grok");
        fs::create_dir_all(&dirs.raw).unwrap();
        fs::create_dir_all(&dirs.imported).unwrap();
        let line = |origin: Option<&str>, prompt: u32| {
            let mut record = json!({ "hook": "UserPromptSubmit", "received_at": "2026-11-13T10:00:00Z",
                "payload": { "session_id": "g1", "prompt_id": format!("p{prompt}"), "prompt": "x" } });
            if let Some(origin) = origin {
                record["origin"] = json!(origin);
            }
            record.to_string() + "\n"
        };
        // The hooks saw the session start, but Grok's own files hold more.
        let start = json!({ "hook": "SessionStart", "payload": { "session_id": "g1", "source": "startup" } });
        fs::write(
            dirs.raw.join("g1.jsonl"),
            start.to_string() + "\n" + &line(None, 1),
        )
        .unwrap();
        let mut ledger = Ledger::open(&dir.path().join("l.db")).unwrap();
        run(std::slice::from_ref(&dirs), &mut ledger, "m", false).unwrap();
        let hooks_only = ledger.get("g1").unwrap().unwrap();
        assert_eq!(
            (hooks_only.source.as_str(), hooks_only.counts.prompts),
            ("grok", 1)
        );

        fs::write(
            dirs.imported.join("g1.jsonl"),
            line(Some("transcript"), 1) + &line(Some("transcript"), 2),
        )
        .unwrap();
        run(&[dirs], &mut ledger, "m", false).unwrap();
        let imported = ledger.get("g1").unwrap().unwrap();
        assert_eq!(imported.counts.prompts, 2);
        assert_eq!(imported.captured_by, crate::session::CapturedBy::Transcript);
        assert_eq!(imported.source, "grok");
    }

    #[test]
    fn a_codex_import_takes_its_permission_requests_from_the_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = SourceDirs::in_data_dir(dir.path(), "codex");
        fs::create_dir_all(&dirs.raw).unwrap();
        fs::create_dir_all(&dirs.imported).unwrap();
        let record = |hook: &str, origin: &str| {
            json!({ "hook": hook, "origin": origin, "received_at": "2026-11-16T10:00:00Z",
                    "payload": { "session_id": "x1", "prompt_id": "t1", "prompt": "x", "tool_name": "Bash" } })
            .to_string()
                + "\n"
        };
        fs::write(
            dirs.imported.join("x1.jsonl"),
            record("UserPromptSubmit", "transcript"),
        )
        .unwrap();
        let mut ledger = Ledger::open(&dir.path().join("l.db")).unwrap();
        run(std::slice::from_ref(&dirs), &mut ledger, "m", false).unwrap();
        let asked = |ledger: &Ledger| {
            let session = ledger.get("x1").unwrap().unwrap();
            (session.captured_by, session.counts.permission_requests)
        };
        use crate::session::CapturedBy::Transcript;
        assert_eq!(asked(&ledger), (Transcript, 0));

        fs::write(
            dirs.raw.join("x1.jsonl"),
            record("PermissionRequest", "hook")
                + &record("PreToolUse", "hook")
                + &record("PermissionRequest", "hook"),
        )
        .unwrap();
        run(&[dirs], &mut ledger, "m", false).unwrap();
        assert_eq!(asked(&ledger), (Transcript, 2));
    }

    #[test]
    fn missing_raw_dir_is_fine() {
        let mut env = env();
        env.raw = env.raw.join("nope");
        assert_eq!(env.sync(false), Report::default());
    }
}
