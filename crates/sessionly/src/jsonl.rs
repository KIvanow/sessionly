//! Tolerant JSONL reading: one bad line never hides the rest of the file.
//! A file whose name ends in `.zst` is read through zstd.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

use anyhow::{Context, Result};
use serde_json::Value;

/// Call `row` for every line that parses as JSON. Returns how many non-empty
/// lines were skipped (invalid JSON, invalid UTF-8, or a partly written last line).
pub fn for_each(path: &Path, row: impl FnMut(Value)) -> Result<u64> {
    for_each_within(path, None, row)
}

/// `for_each` over the first `bytes` of the file only (`None`: all of it).
/// For a compressed file, the first `bytes` of what it holds.
pub fn for_each_within(path: &Path, bytes: Option<u64>, mut row: impl FnMut(Value)) -> Result<u64> {
    let file = open(path).with_context(|| format!("opening {}", path.display()))?;
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

/// What a file holds: as it is, or decompressed if its name ends in `.zst`.
pub fn open(path: &Path) -> io::Result<Box<dyn Read>> {
    let file = File::open(path)?;
    if path.extension().is_some_and(|x| x == "zst") {
        Ok(Box::new(Zstd(zstd::stream::read::Decoder::new(file)?)))
    } else {
        Ok(Box::new(file))
    }
}

/// A zstd stream of one frame or several, one after the other. Each block is
/// given out as soon as it is decoded, so a last frame still being written
/// gives what it has so far and then ends, as a partly written last line
/// does. Anything else the decoder cannot read is an error, not an end.
struct Zstd<R: BufRead>(zstd::stream::read::Decoder<'static, R>);

impl<R: BufRead> Read for Zstd<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.0.read(buf) {
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(0),
            read => read,
        }
    }
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

    fn zstd(text: &[u8]) -> Vec<u8> {
        zstd::encode_all(text, 1).unwrap()
    }

    /// A frame with `text` written and flushed into blocks, but not closed.
    fn unclosed(text: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut frame = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
        frame.write_all(text).unwrap();
        frame.flush().unwrap();
        frame.get_ref().clone()
    }

    fn read(bytes: &[u8]) -> Result<(Vec<u64>, u64)> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.jsonl.zst");
        std::fs::write(&path, bytes).unwrap();
        let mut seen = Vec::new();
        let skipped = for_each(&path, |v| seen.push(v["a"].as_u64().unwrap()))?;
        Ok((seen, skipped))
    }

    #[test]
    fn reads_a_compressed_file_of_several_frames() {
        let mut bytes = zstd(b"{\"a\":1}\n{\"a\":2}\n");
        bytes.extend(zstd(b"{\"a\":3}\n"));
        assert_eq!(read(&bytes).unwrap(), (vec![1, 2, 3], 0));
        // a frame still being written: what it has so far, though it is not closed
        let mut live = bytes.clone();
        live.extend(unclosed(b"{\"a\":4}\n{\"a\":5}\n"));
        assert_eq!(read(&live).unwrap(), (vec![1, 2, 3, 4, 5], 0));
        // one cut inside its header has nothing yet
        let mut started = bytes.clone();
        started.extend(&zstd(b"{\"a\":4}\n")[..3]);
        assert_eq!(read(&started).unwrap(), (vec![1, 2, 3], 0));
        // a skippable frame between them is skipped
        let mut skippable = zstd(b"{\"a\":1}\n");
        skippable.extend([0x50, 0x2a, 0x4d, 0x18, 2, 0, 0, 0, 7, 7]);
        skippable.extend(zstd(b"{\"a\":2}\n"));
        assert_eq!(read(&skippable).unwrap(), (vec![1, 2], 0));

        // `bytes` counts what the file holds, not what it takes on disk
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.jsonl.zst");
        std::fs::write(&path, &bytes).unwrap();
        let mut first = Vec::new();
        for_each_within(&path, Some(8), |v| first.push(v["a"].as_u64().unwrap())).unwrap();
        assert_eq!(first, [1]);
    }

    #[test]
    fn a_compressed_file_that_cannot_be_read_is_an_error() {
        let mut bytes = zstd(b"{\"a\":1}\n");
        let corrupt = zstd(&b"{\"a\":2}\n".repeat(50));
        let mut broken = corrupt.clone();
        let at = broken.len() / 2;
        broken[at..].iter_mut().for_each(|b| *b ^= 0x5a);
        bytes.extend(broken);
        assert!(read(&bytes).is_err());
        // nor is something that is not zstd at all read as nothing
        assert!(read(b"{\"a\":1}\n").is_err());
    }
}
