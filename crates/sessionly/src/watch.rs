//! `sessionly watch`: pretty-print raw hook events as they are captured.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

use anyhow::Result;
use serde_json::Value;

/// Watch every agent's folder under `raw_root`.
pub fn run(raw_root: &Path) -> Result<()> {
    for source in crate::paths::SOURCES {
        crate::paths::create_private_dir(&raw_root.join(source))?;
    }
    let raw_dir = raw_root;
    // Only show events that arrive from now on.
    let mut offsets: HashMap<PathBuf, u64> = session_files(raw_dir)?
        .into_iter()
        .map(|p| {
            let len = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            (p, len)
        })
        .collect();
    println!("Watching {} (Ctrl+C to stop)", raw_dir.display());
    loop {
        for path in session_files(raw_dir)? {
            let offset = offsets.entry(path.clone()).or_insert(0);
            *offset += print_new_lines(&path, *offset)?;
        }
        sleep(Duration::from_millis(300));
    }
}

fn session_files(raw_root: &Path) -> Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = crate::paths::SOURCES
        .iter()
        .filter_map(|source| fs::read_dir(raw_root.join(source)).ok())
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect();
    files.sort();
    Ok(files)
}

/// Print complete lines after `offset`; returns how many bytes were consumed.
fn print_new_lines(path: &Path, offset: u64) -> Result<u64> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = String::new();
    file.read_to_string(&mut buf)?;
    let Some(end) = buf.rfind('\n') else {
        return Ok(0);
    };
    let label: String = path
        .file_stem()
        .map(|s| s.to_string_lossy().chars().take(8).collect())
        .unwrap_or_default();
    for line in buf[..end].lines() {
        match serde_json::from_str::<Value>(line) {
            Ok(record) => {
                println!(
                    "=== {}  {}  {} ===",
                    record["received_at"].as_str().unwrap_or("?"),
                    label,
                    record["hook"].as_str().unwrap_or("?")
                );
                println!("{}", serde_json::to_string_pretty(&record["payload"])?);
            }
            Err(_) => println!("=== {label}  (unreadable line) ===\n{line}"),
        }
    }
    Ok(end as u64 + 1)
}
