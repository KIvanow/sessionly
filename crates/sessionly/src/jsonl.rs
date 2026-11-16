//! Tolerant JSONL reading: one bad line never hides the rest of the file.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use anyhow::{Context, Result};
use serde_json::Value;

/// Call `row` for every line that parses as JSON. Returns how many non-empty
/// lines were skipped (invalid JSON, invalid UTF-8, or a partly written last line).
pub fn for_each(path: &Path, row: impl FnMut(Value)) -> Result<u64> {
    for_each_within(path, None, row)
}

/// `for_each` over the first `bytes` of the file only (`None`: all of it).
pub fn for_each_within(path: &Path, bytes: Option<u64>, mut row: impl FnMut(Value)) -> Result<u64> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let mut skipped = 0;
    for line in BufReader::new(file.take(bytes.unwrap_or(u64::MAX))).split(b'\n') {
        let line = line.with_context(|| format!("reading {}", path.display()))?;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice(&line) {
            Ok(value) => row(value),
            Err(_) => skipped += 1,
        }
    }
    Ok(skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_bad_lines_and_keeps_going() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.jsonl");
        std::fs::write(
            &path,
            b"{\"a\":1}\n\xff\xfe not utf8\n\n{broken\n{\"a\":2}\n{\"cut",
        )
        .unwrap();
        let mut seen = Vec::new();
        let skipped = for_each(&path, |v| seen.push(v["a"].as_u64().unwrap())).unwrap();
        assert_eq!(seen, [1, 2]);
        assert_eq!(skipped, 3);
    }
}
