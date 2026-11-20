//! Tolerant JSONL reading: one bad line never hides the rest of the file.
//! A file whose name ends in `.zst` is read through zstd.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;

use anyhow::{Context, Result};
use ruzstd::decoding::{FrameDecoder, StreamingDecoder};
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
        Ok(Box::new(Zstd {
            frame: None,
            source: Some(BufReader::new(file)),
        }))
    } else {
        Ok(Box::new(file))
    }
}

/// A zstd stream of one frame or several, one after the other. A frame that
/// cannot be read (one still being written) ends it, as a partly written last
/// line does: what came before still stands.
struct Zstd<R: BufRead> {
    frame: Option<StreamingDecoder<R, FrameDecoder>>,
    /// The stream between frames.
    source: Option<R>,
}

impl<R: BufRead> Read for Zstd<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if let Some(frame) = &mut self.frame {
                match frame.read(buf) {
                    Ok(0) if !buf.is_empty() => {}
                    Ok(n) => return Ok(n),
                    Err(_) => {
                        self.frame = None;
                        return Ok(0);
                    }
                }
                self.source = self.frame.take().map(StreamingDecoder::into_inner);
            }
            let Some(mut source) = self.source.take() else {
                return Ok(0);
            };
            if source.fill_buf()?.is_empty() {
                return Ok(0);
            }
            match StreamingDecoder::new(source) {
                Ok(frame) => self.frame = Some(frame),
                Err(_) => return Ok(0),
            }
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
        ruzstd::encoding::compress_to_vec(text, ruzstd::encoding::CompressionLevel::Fastest)
    }

    #[test]
    fn reads_a_compressed_file_of_several_frames() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.jsonl.zst");
        let mut bytes = zstd(b"{\"a\":1}\n{\"a\":2}\n");
        bytes.extend(zstd(b"{\"a\":3}\n"));
        // a frame still being written
        bytes.extend(&zstd(b"{\"a\":4}\n")[..6]);
        std::fs::write(&path, &bytes).unwrap();
        let mut seen = Vec::new();
        let skipped = for_each(&path, |v| seen.push(v["a"].as_u64().unwrap())).unwrap();
        assert_eq!(seen, [1, 2, 3]);
        assert_eq!(skipped, 0);
        // `bytes` counts what the file holds, not what it takes on disk
        let mut first = Vec::new();
        for_each_within(&path, Some(8), |v| first.push(v["a"].as_u64().unwrap())).unwrap();
        assert_eq!(first, [1]);
    }
}
