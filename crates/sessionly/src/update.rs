//! `sessionly update`: replace this binary with a newer release.
//!
//! The release is downloaded from where `install --repo` has its script
//! download one (`SESSIONLY_RELEASE_BASE`, GitHub's releases by default),
//! checked against the release's `SHA256SUMS`, unpacked beside the binary it
//! replaces, asked for its version, and only then moved over it, in one
//! step: a hook that runs meanwhile finds the old binary or the new one.
//!
//! The hooks name the binary by its path, which stays, so they are not
//! touched. A script that `install --repo` wrote into a repository names a
//! version of its own and is not touched either.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

/// Where the newest release is asked for. GitHub sends this address on to
/// the release's own page, whose address ends in its tag; that is all that
/// is read. (GitHub's API says the same in JSON, but answers a machine that
/// is not signed in only sixty times an hour, counted by its address.)
const LATEST: &str = "https://github.com/KIvanow/sessionly/releases/latest";

/// A release archive is a few megabytes. One far larger is not one.
const MAX_ARCHIVE_BYTES: u64 = 200 * 1024 * 1024;

/// The archive a release has for this kind of machine, if it has one.
pub fn archive() -> Option<String> {
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", arch @ ("x86_64" | "aarch64")) => format!("{arch}-unknown-linux-musl"),
        ("macos", arch @ ("x86_64" | "aarch64")) => format!("{arch}-apple-darwin"),
        _ => return None,
    };
    Some(format!("sessionly-{target}.tar.gz"))
}

/// A version's numbers, for telling which of two is newer. `None` for one
/// with anything but numbers and dots in it, such as a release candidate.
fn numbers(version: &str) -> Option<Vec<u64>> {
    version.split('.').map(|part| part.parse().ok()).collect()
}

/// Whether `found` is a later version than `this`. One that cannot be read
/// is not.
pub fn newer(found: &str, this: &str) -> bool {
    match (numbers(found), numbers(this)) {
        (Some(found), Some(this)) => found > this,
        _ => false,
    }
}

/// The checksum `sums` (a release's `SHA256SUMS`) gives for `file`.
fn checksum_of(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut words = line.split_whitespace();
        let hash = words.next()?;
        let name = words.next()?.trim_start_matches('*');
        let hex = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit());
        (name == file && hex).then(|| hash.to_lowercase())
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn setting(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// The version a release tag names, without a leading `v`. A tag that is
/// only `v`, or empty, names none: storing that would wipe a notice that
/// was still good.
fn version_of(tag: &str) -> Option<&str> {
    let version = tag.trim_start_matches('v');
    (!version.is_empty()).then_some(version)
}

/// The version a release's page is for: the end of its address, `…/tag/v<version>`.
fn version_in(address: &str) -> Option<String> {
    let (_, tag) = address.trim_end_matches('/').rsplit_once("/tag/")?;
    let version = tag.strip_prefix('v')?;
    (!version.is_empty() && !version.contains('/')).then(|| version.to_string())
}

/// The version the newest release's page names, without the `v`, and without
/// deciding whether it is newer than this binary. `sessionly update` keeps
/// its own answer for that.
///
/// `SESSIONLY_RELEASE_LATEST` names another place to ask, for those who keep
/// copies of the releases themselves: an address that answers with JSON
/// that has the tag in `tag_name`, as GitHub's API does.
pub(crate) fn latest() -> Result<String> {
    let Some(url) = setting("SESSIONLY_RELEASE_LATEST") else {
        let to = crate::upload::redirect_of(LATEST)
            .with_context(|| format!("asking {LATEST} for the newest release"))?;
        return to
            .as_deref()
            .and_then(version_in)
            .with_context(|| format!("{LATEST} did not lead to a release ({to:?})"));
    };
    let page = crate::upload::fetch_bytes(&url, 1024 * 1024)
        .with_context(|| format!("asking {url} for the newest release"))?;
    let page: serde_json::Value =
        serde_json::from_slice(&page).with_context(|| format!("{url} did not answer with JSON"))?;
    let tag = page["tag_name"]
        .as_str()
        .with_context(|| format!("{url} names no release (no \"tag_name\")"))?;
    version_of(tag)
        .map(str::to_string)
        .with_context(|| format!("{url} names no version"))
}

/// What `sessionly update` did, for its one line of output.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// This is the newest release already.
    Current,
    /// A newer one exists, and `--check` asked only for that.
    Available(String),
    /// The binary at the path is now this version.
    Updated(String, PathBuf),
}

/// Bring the binary at `exe`, which is version `this`, to `wanted`, or to
/// the newest release if none is named.
pub fn run(exe: &Path, this: &str, wanted: Option<&str>, check: bool) -> Result<Outcome> {
    let version = match wanted {
        Some(version) => version.trim_start_matches('v').to_string(),
        None => {
            let found = latest()?;
            if !newer(&found, this) {
                return Ok(Outcome::Current);
            }
            found
        }
    };
    if version.is_empty()
        || !version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c))
    {
        bail!("{version:?} is not a version");
    }
    if version == this {
        return Ok(Outcome::Current);
    }
    if check {
        return Ok(Outcome::Available(version));
    }
    let archive = archive().with_context(|| {
        format!(
            "there are no released binaries for {} on {}; build from source instead",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let base = setting("SESSIONLY_RELEASE_BASE")
        .unwrap_or_else(|| crate::repo::DEFAULT_RELEASE_BASE.to_string());
    let base = base.trim_end_matches('/');

    let sums_url = crate::repo::checksums_url(base, &version);
    let sums = crate::upload::fetch_bytes(&sums_url, 1024 * 1024).with_context(|| {
        format!("could not get the checksums of sessionly {version} from {sums_url}")
    })?;
    let want = checksum_of(&String::from_utf8_lossy(&sums), &archive)
        .with_context(|| format!("the checksums of sessionly {version} do not name {archive}"))?;
    let url = format!("{base}/v{version}/{archive}");
    let packed = crate::upload::fetch_bytes(&url, MAX_ARCHIVE_BYTES)
        .with_context(|| format!("could not download {url}"))?;
    if sha256_hex(&packed) != want {
        bail!("the download from {url} does not match its checksum; nothing was changed");
    }

    // Beside the binary, so that moving the new one over it is one step on
    // one file system.
    let dir = exe.parent().context("the binary has no directory")?;
    let work = dir.join(format!(".sessionly-update-{}", std::process::id()));
    let _ = fs::remove_dir_all(&work);
    // For this user alone from the moment it exists: what is unpacked in it
    // is run and then becomes the binary, so nobody else may put a file there.
    let mut private = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        private.mode(0o700);
    }
    private.create(&work).with_context(|| {
        format!(
            "cannot write to {}; run this as whoever installed sessionly there",
            dir.display()
        )
    })?;
    let done = replace(exe, &work, &packed, &version);
    let _ = fs::remove_dir_all(&work);
    done?;
    Ok(Outcome::Updated(version, exe.to_path_buf()))
}

/// Unpack `packed` in `work`, check that what came out is `version`, and
/// move it over `exe`.
fn replace(exe: &Path, work: &Path, packed: &[u8], version: &str) -> Result<()> {
    let file = work.join("sessionly.tar.gz");
    fs::write(&file, packed)?;
    let unpacked = Command::new("tar")
        .arg("-xzf")
        .arg(&file)
        .arg("-C")
        .arg(work)
        .arg("sessionly")
        .output()
        .context("running tar to unpack the download")?;
    if !unpacked.status.success() {
        bail!(
            "could not unpack the download: {}",
            String::from_utf8_lossy(&unpacked.stderr).trim()
        );
    }
    let new = work.join("sessionly");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // As the one it replaces was, for whoever could run that.
        let mode = fs::metadata(exe).map_or(0o755, |meta| meta.permissions().mode() | 0o500);
        fs::set_permissions(&new, fs::Permissions::from_mode(mode & 0o7777))?;
    }
    let says = Command::new(&new)
        .arg("--version")
        .output()
        .context("running the downloaded binary")?;
    if !says.status.success() {
        bail!(
            "the downloaded binary does not run ({}); nothing was changed",
            says.status
        );
    }
    let says = String::from_utf8_lossy(&says.stdout).trim().to_string();
    if says != format!("sessionly {version}") {
        bail!("the downloaded binary says it is {says:?}, not sessionly {version}; nothing was changed");
    }
    fs::rename(&new, exe).with_context(|| format!("replacing {}", exe.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_later_version_is_newer_and_one_that_cannot_be_read_is_not() {
        assert!(newer("0.4.1", "0.4.0"));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(newer("1.0", "0.9.9"));
        assert!(!newer("0.4.0", "0.4.0"));
        assert!(!newer("0.3.9", "0.4.0"));
        assert!(!newer("0.5.0-rc.1", "0.4.0"));
        assert!(!newer("", "0.4.0"));
    }

    #[test]
    fn a_tag_that_is_only_v_names_no_version() {
        assert_eq!(version_of("v0.4.0"), Some("0.4.0"));
        assert_eq!(version_of("0.4.0"), Some("0.4.0"));
        assert_eq!(version_of("v"), None);
        assert_eq!(version_of(""), None);
    }

    #[test]
    fn a_releases_page_names_its_version() {
        let page = "https://github.com/KIvanow/sessionly/releases/tag/v0.4.0";
        assert_eq!(version_in(page).as_deref(), Some("0.4.0"));
        // No release yet: GitHub sends on to the list of them.
        assert_eq!(
            version_in("https://github.com/KIvanow/sessionly/releases"),
            None
        );
        assert_eq!(version_in("https://example.com/tag/latest"), None);
    }

    #[test]
    fn a_checksum_is_found_by_the_archives_name() {
        let sum = "ab".repeat(32);
        let sums = format!(
            "{}  other.tar.gz\n{sum} *sessionly-x.tar.gz\n",
            "cd".repeat(32)
        );
        assert_eq!(checksum_of(&sums, "sessionly-x.tar.gz"), Some(sum));
        assert_eq!(checksum_of(&sums, "sessionly-y.tar.gz"), None);
        assert_eq!(
            checksum_of("abc  sessionly-x.tar.gz", "sessionly-x.tar.gz"),
            None
        );
    }
}
