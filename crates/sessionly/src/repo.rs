//! `sessionly install --repo`: capture for sessions that run in the cloud.
//!
//! A cloud session (Claude Code's, or a Cursor cloud agent) runs in a sandbox
//! with a fresh clone of the repository. Nothing from anyone's home directory
//! is there, so the hooks `sessionly install` writes are not either. What the
//! sandbox does have is the repository, and both platforms run the hooks a
//! repository carries: `.claude/settings.json` and `.cursor/hooks.json`.
//!
//! So three files are committed:
//!
//! - `.sessionly/hook.sh`, a script that does nothing on a person's own
//!   machine and, in a sandbox, fetches the sessionly binary (once, checked
//!   against a checksum written into the script) and hands it the event;
//! - hook entries in `.claude/settings.json` and in `.cursor/hooks.json` that
//!   run it.
//!
//! Where a sandbox sends its sessions is not in the repository: it is given
//! to the sandbox as `SESSIONLY_URL` and `SESSIONLY_TOKEN`.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};

use crate::hooks::{self, Kind};

/// What Claude Code runs. It sets `CLAUDE_PROJECT_DIR` to the repository.
pub const CLAUDE_COMMAND: &str = r#""$CLAUDE_PROJECT_DIR"/.sessionly/hook.sh claude"#;
/// What Cursor runs, from the repository's root.
pub const CURSOR_COMMAND: &str = ".sessionly/hook.sh cursor";

/// The events asked of Cursor: a turn's prompt, its tool calls, what its
/// edits changed, and its end. Cursor's cloud has no session start, and a
/// session end is asked for in case it ever reports one.
pub const CURSOR_EVENTS: &[&str] = &[
    "beforeSubmitPrompt",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "afterFileEdit",
    "stop",
    "sessionEnd",
];

pub const DEFAULT_RELEASE_BASE: &str = "https://github.com/KIvanow/sessionly/releases/download";
const SCRIPT: &str = ".sessionly/hook.sh";
const X86_64: &str = "sessionly-x86_64-unknown-linux-musl.tar.gz";
const AARCH64: &str = "sessionly-aarch64-unknown-linux-musl.tar.gz";

/// The release a repository's script fetches.
#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub version: String,
    /// Where releases are downloaded from: `<base>/v<version>/<file>`.
    pub base: String,
    /// SHA-256 of each Linux archive. A sandbox of the other kind captures nothing.
    pub x86_64: Option<String>,
    pub aarch64: Option<String>,
}

impl Release {
    /// From a release's `SHA256SUMS` file: lines of `<sha256>  <file name>`.
    pub fn from_checksums(version: &str, base: &str, sums: &str) -> Result<Release> {
        let find = |file: &str| {
            sums.lines().find_map(|line| {
                let mut words = line.split_whitespace();
                let hash = words.next()?;
                let name = words.next()?.trim_start_matches('*');
                let hex = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit());
                (name == file && hex).then(|| hash.to_lowercase())
            })
        };
        let release = Release {
            version: version.to_string(),
            base: base.trim_end_matches('/').to_string(),
            x86_64: find(X86_64),
            aarch64: find(AARCH64),
        };
        if release.x86_64.is_none() && release.aarch64.is_none() {
            bail!("the checksums name neither {X86_64} nor {AARCH64}");
        }
        Ok(release)
    }
}

pub fn checksums_url(base: &str, version: &str) -> String {
    format!("{}/v{version}/SHA256SUMS", base.trim_end_matches('/'))
}

/// The script committed as `.sessionly/hook.sh`.
pub fn script(release: &Release) -> String {
    const TEMPLATE: &str = r#"#!/bin/sh
# Sessionly capture for cloud agent sessions. https://sessionly.dev
#
# Written by `sessionly install --repo` (sessionly @VERSION@). To update it,
# run that again with a newer sessionly rather than editing it.
#
# The hooks in .claude/settings.json and .cursor/hooks.json run this on every
# hook event, with the event on standard input.
#
# - On a person's own machine it does nothing. Sessions there are captured by
#   that person's own `sessionly install`, if they have one.
# - In a Claude Code cloud session or a Cursor cloud agent it fetches the
#   sessionly binary once per sandbox, checks it against the checksum below,
#   and hands it the event. Where sessions are sent is up to the sandbox's
#   environment (SESSIONLY_URL and SESSIONLY_TOKEN); without those nothing
#   leaves the sandbox.
#
# It prints nothing and always exits 0, so it cannot block or change a session.

VERSION=@VERSION@
BASE=@BASE@
SHA256_X86_64=@X86_64@
SHA256_AARCH64=@AARCH64@

case "${1:-}" in
  # Cursor's cloud also runs the hooks in .claude/settings.json. There the
  # entry in .cursor/hooks.json is the one that captures.
  claude) [ "${CLAUDE_CODE_REMOTE:-}" = true ] && [ -z "${CURSOR_VERSION:-}" ] || exit 0 ;;
  cursor) [ -S "${CURSOR_AGENT_SOCKET:-/run/cursor/api.sock}" ] || exit 0 ;;
  *) exit 0 ;;
esac

home="${SESSIONLY_HOME:-$HOME/.sessionly}"
bin="$home/bin/sessionly-$VERSION"

note() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1" >> "$home/bootstrap.log"
}

get() {
  if command -v curl > /dev/null; then
    curl -fsSL --retry 2 --max-time 60 -o "$2" "$1"
  else
    wget -q -T 60 -O "$2" "$1"
  fi
}

checksum() {
  if command -v sha256sum > /dev/null; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    shasum -a 256 "$1" | cut -d ' ' -f 1
  fi
}

download() {
  failed="$home/bin/failed-$VERSION"
  # A download that failed is not tried again for ten minutes.
  [ -n "$(find "$failed" -mmin -10 2> /dev/null)" ] && return 1
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) target=x86_64-unknown-linux-musl want=$SHA256_X86_64 ;;
    Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-musl want=$SHA256_AARCH64 ;;
    *) target= want= ;;
  esac
  tmp="$home/bin/download-$$"
  rm -rf "$tmp"
  if [ -z "$want" ]; then
    note "no sessionly $VERSION binary for $(uname -s) $(uname -m)"
  elif ! mkdir "$tmp" || ! get "$BASE/v$VERSION/sessionly-$target.tar.gz" "$tmp/sessionly.tar.gz"; then
    note "could not download $BASE/v$VERSION/sessionly-$target.tar.gz"
  elif [ "$(checksum "$tmp/sessionly.tar.gz")" != "$want" ]; then
    note "the download does not match its checksum; not using it"
  elif tar -xzf "$tmp/sessionly.tar.gz" -C "$tmp" sessionly && chmod 755 "$tmp/sessionly" &&
    mv "$tmp/sessionly" "$bin"; then
    rm -rf "$tmp" "$failed"
    note "installed sessionly $VERSION ($$)"
    return 0
  else
    note "could not unpack the download"
  fi
  rm -rf "$tmp"
  : > "$failed"
  return 1
}

# Hooks run in parallel: one downloads while the others wait for it.
#
# The lock is a file that this shell creates only if it is not there yet
# (set -C): one system call, made by the shell itself. It used to be a folder
# made with mkdir. Where several hooks asked at the same moment, each was
# told it had made the folder, and two of them downloaded: seen on Ubuntu
# 26.04, whose mkdir is not GNU's, and never where it is.
#
# Each step is noted with the process it was, in bootstrap.log, so that a
# sandbox where two hooks still download shows how. It is a few lines, once
# per sandbox.
fetch() {
  mkdir -p "$home/bin" && chmod 700 "$home" || return 1
  lock="$home/bin/fetching.lock"
  waited=0
  until (set -C && : > "$lock") 2> /dev/null; do
    if [ -x "$bin" ]; then
      note "$$ stopped waiting for the lock after $waited waits: the binary is there"
      return 0
    fi
    waited=$((waited + 1))
    if [ "$waited" -gt 300 ]; then
      # Half a minute: whoever is downloading was killed, or is too slow to
      # wait for. This event is not captured; the next hook may try.
      rm -f "$lock"
      note "$$ waited half a minute for the lock, removed it and gave up"
      return 1
    fi
    sleep 0.1
  done
  if [ -x "$bin" ]; then
    note "$$ took the lock after $waited waits: the binary is there"
  else
    note "$$ took the lock after $waited waits: no binary yet, downloading"
    download
    note "$$ finished downloading ($?)"
  fi
  if rm "$lock" 2> /dev/null; then
    note "$$ released the lock"
  else
    note "$$ found the lock gone when releasing it"
  fi
}

[ -x "$bin" ] || fetch > /dev/null 2>&1
[ -x "$bin" ] && "$bin" capture > /dev/null 2>&1
exit 0
"#;
    let sum = |sum: &Option<String>| sum.clone().unwrap_or_default();
    TEMPLATE
        .replace("@VERSION@", &release.version)
        .replace("@BASE@", &hooks::shell_quote(&release.base))
        .replace("@X86_64@", &sum(&release.x86_64))
        .replace("@AARCH64@", &sum(&release.aarch64))
}

/// One file of a repository install, and whether it had to be changed.
#[derive(Debug, PartialEq)]
pub struct Written {
    pub path: PathBuf,
    pub changed: bool,
}

fn cursor_path(dir: &Path) -> PathBuf {
    dir.join(".cursor").join("hooks.json")
}

fn script_path(dir: &Path) -> PathBuf {
    dir.join(SCRIPT)
}

/// Remove our entries from a Cursor hooks file, and the events and the
/// `hooks` object that this leaves empty.
fn strip_cursor(config: &mut Value) {
    let Some(hooks) = config.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    let mut emptied = Vec::new();
    for (event, entries) in hooks.iter_mut() {
        let Some(list) = entries.as_array_mut() else {
            continue;
        };
        let before = list.len();
        list.retain(|entry| !hooks::is_ours(entry, Kind::Repo));
        if list.is_empty() && before > 0 {
            emptied.push(event.clone());
        }
    }
    for event in &emptied {
        hooks.shift_remove(event);
    }
    if !emptied.is_empty() && hooks.is_empty() {
        config.as_object_mut().unwrap().shift_remove("hooks");
    }
}

fn add_cursor(config: &mut Value) -> Result<()> {
    let root = config
        .as_object_mut()
        .context("the Cursor hooks file is not a JSON object")?;
    root.entry("version").or_insert(json!(1));
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .context("\"hooks\" in the Cursor hooks file is not an object")?;
    for event in CURSOR_EVENTS {
        hooks
            .entry(*event)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .with_context(|| format!("\"hooks.{event}\" in the Cursor hooks file is not a list"))?
            .push(json!({ "command": CURSOR_COMMAND }));
    }
    Ok(())
}

fn write_script(path: &Path, text: &str) -> Result<bool> {
    let changed = fs::read_to_string(path).ok().as_deref() != Some(text);
    if changed {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(path, text).with_context(|| format!("writing {}", path.display()))?;
    }
    // Checked every time: a file that lost its executable bit captures nothing.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)?.permissions().mode();
        if mode & 0o111 != 0o111 {
            fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o755))?;
            return Ok(true);
        }
    }
    Ok(changed)
}

/// Write the script and both sets of hook entries into the repository at
/// `dir`. Running it again changes nothing; with a newer release it updates
/// the script.
pub fn install(dir: &Path, release: &Release) -> Result<Vec<Written>> {
    if !dir.join(".git").exists() {
        bail!(
            "{} is not the root of a git repository (it has no .git)",
            dir.display()
        );
    }
    let script_file = script_path(dir);
    let script_changed = write_script(&script_file, &script(release))?;

    let claude = hooks::settings_path(Some(dir))?;
    let claude_changed = hooks::install(&claude, CLAUDE_COMMAND)?;

    let cursor = cursor_path(dir);
    let before = hooks::load(&cursor)?;
    let mut config = before.clone();
    strip_cursor(&mut config);
    add_cursor(&mut config)?;
    let cursor_changed = config != before;
    if cursor_changed {
        hooks::save(&cursor, &config, false)?;
    }
    Ok(vec![
        Written {
            path: script_file,
            changed: script_changed,
        },
        Written {
            path: claude,
            changed: claude_changed,
        },
        Written {
            path: cursor,
            changed: cursor_changed,
        },
    ])
}

/// Take the script and our hook entries out of the repository at `dir`.
/// A file or folder that this leaves with nothing in it is removed. Returns
/// the files that were changed or removed.
pub fn uninstall(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut touched = Vec::new();
    let script_file = script_path(dir);
    if script_file.exists() {
        fs::remove_file(&script_file)?;
        touched.push(script_file.clone());
    }
    let claude = hooks::settings_path(Some(dir))?;
    if hooks::uninstall(&claude, Kind::Repo)? {
        touched.push(claude.clone());
    }
    let cursor = cursor_path(dir);
    if cursor.exists() {
        let before = hooks::load(&cursor)?;
        let mut config = before.clone();
        strip_cursor(&mut config);
        if config != before {
            hooks::save(&cursor, &config, false)?;
            touched.push(cursor.clone());
        }
    }
    // What we created and nobody else uses goes away again.
    let nothing_left = |path: &Path| {
        hooks::load(path).is_ok_and(|value| {
            value
                .as_object()
                .is_some_and(|keys| keys.keys().all(|key| key == "version"))
        })
    };
    for file in [&claude, &cursor] {
        if touched.contains(file) && nothing_left(file) {
            fs::remove_file(file)?;
        }
    }
    for folder in [script_file.parent(), claude.parent(), cursor.parent()] {
        // Fails, as it should, on a folder that still has something in it.
        let _ = folder.map(fs::remove_dir);
    }
    Ok(touched)
}

/// What is installed in the repository at `dir`.
#[derive(Debug, Default, PartialEq)]
pub struct Status {
    /// The release the script fetches, if the script is there.
    pub script_version: Option<String>,
    pub claude_events: usize,
    pub cursor_events: usize,
}

pub fn status(dir: &Path) -> Result<Status> {
    let script_version = fs::read_to_string(script_path(dir)).ok().and_then(|text| {
        text.lines()
            .find_map(|line| line.strip_prefix("VERSION=").map(String::from))
    });
    let claude = hooks::settings_path(Some(dir))?;
    let cursor = hooks::load(&cursor_path(dir))?;
    let cursor_events = cursor["hooks"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, entries)| {
            entries
                .as_array()
                .into_iter()
                .flatten()
                .any(|entry| hooks::is_ours(entry, Kind::Repo))
        })
        .count();
    Ok(Status {
        script_version,
        claude_events: hooks::installed_events(&claude, Kind::Repo)?.len(),
        cursor_events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUM_A: &str = "0f3a9c1d2b4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8";
    const SUM_B: &str = "aa3a9c1d2b4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7ff";

    fn release() -> Release {
        let sums = format!("{SUM_A}  {X86_64}\n{SUM_B} *{AARCH64}\nabc  notes.txt\n");
        Release::from_checksums("1.2.3", "https://example.com/dl/", &sums).unwrap()
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        dir
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn checksums_are_read_from_a_release() {
        let release = release();
        assert_eq!(release.base, "https://example.com/dl");
        assert_eq!(release.x86_64.as_deref(), Some(SUM_A));
        assert_eq!(release.aarch64.as_deref(), Some(SUM_B));
        assert_eq!(
            checksums_url("https://example.com/dl/", "1.2.3"),
            "https://example.com/dl/v1.2.3/SHA256SUMS"
        );
        // One architecture is enough; none, or something that is no checksum, is not.
        let only = Release::from_checksums("1", "b", &format!("{SUM_A}  {X86_64}")).unwrap();
        assert_eq!(only.aarch64, None);
        assert!(Release::from_checksums("1", "b", "<html>Not Found</html>").is_err());
        assert!(Release::from_checksums("1", "b", &format!("abc123  {X86_64}")).is_err());
    }

    #[test]
    fn the_script_pins_the_release_it_fetches() {
        let text = script(&release());
        assert!(text.starts_with("#!/bin/sh\n"));
        assert!(text.contains("\nVERSION=1.2.3\n"));
        assert!(text.contains("\nBASE=https://example.com/dl\n"));
        assert!(text.contains(&format!("\nSHA256_X86_64={SUM_A}\n")));
        assert!(text.contains(&format!("\nSHA256_AARCH64={SUM_B}\n")));
        assert!(!text.contains('@'), "a placeholder was left in");
        // An address the shell would read something into is quoted.
        let odd = Release {
            base: "https://example.com/a b$c".into(),
            ..release()
        };
        assert!(script(&odd).contains("\nBASE='https://example.com/a b$c'\n"));
    }

    #[test]
    fn install_writes_three_files_and_is_repeatable() {
        let dir = repo();
        let written = install(dir.path(), &release()).unwrap();
        assert_eq!(written.len(), 3);
        assert!(written.iter().all(|w| w.changed));

        let claude = read(&dir.path().join(".claude/settings.json"));
        assert_eq!(
            claude["hooks"]["Stop"][0]["hooks"][0]["command"],
            CLAUDE_COMMAND
        );
        assert_eq!(claude["hooks"]["PreToolUse"][0]["matcher"], "*");
        let cursor = read(&dir.path().join(".cursor/hooks.json"));
        assert_eq!(cursor["version"], 1);
        assert_eq!(
            cursor["hooks"]["afterFileEdit"][0]["command"],
            CURSOR_COMMAND
        );
        assert_eq!(
            cursor["hooks"].as_object().unwrap().len(),
            CURSOR_EVENTS.len()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(SCRIPT))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111, "the script is not executable");
        }
        // No copies of the originals are left in the repository.
        assert!(!dir
            .path()
            .join(".claude/settings.json.sessionly-bak")
            .exists());

        let again = install(dir.path(), &release()).unwrap();
        assert!(again.iter().all(|w| !w.changed), "{again:?}");
        assert_eq!(
            status(dir.path()).unwrap(),
            Status {
                script_version: Some("1.2.3".into()),
                claude_events: hooks::all_events().count(),
                cursor_events: CURSOR_EVENTS.len(),
            }
        );

        // A newer release changes the script and nothing else.
        let newer = Release {
            version: "1.3.0".into(),
            ..release()
        };
        let updated = install(dir.path(), &newer).unwrap();
        let changed: Vec<bool> = updated.iter().map(|w| w.changed).collect();
        assert_eq!(changed, [true, false, false]);
    }

    #[test]
    fn install_and_uninstall_leave_what_was_there() {
        let dir = repo();
        let machine = "/usr/local/bin/sessionly capture";
        let claude_before = json!({
            "permissions": { "allow": ["Bash(ls)"] },
            "hooks": { "Stop": [
                { "hooks": [{ "type": "command", "command": "./notify.sh" }] },
                { "hooks": [{ "type": "command", "command": machine }] },
            ] }
        });
        let cursor_before = json!({
            "version": 1,
            "hooks": { "stop": [{ "command": "./lint.sh" }], "beforeMCPExecution": [{ "command": "./audit.sh" }] }
        });
        fs::create_dir_all(dir.path().join(".claude")).unwrap();
        fs::create_dir_all(dir.path().join(".cursor")).unwrap();
        let claude = dir.path().join(".claude/settings.json");
        let cursor = dir.path().join(".cursor/hooks.json");
        fs::write(&claude, claude_before.to_string()).unwrap();
        fs::write(&cursor, cursor_before.to_string()).unwrap();

        install(dir.path(), &release()).unwrap();
        // A machine's own hook in the same file is a different thing and stays.
        assert_eq!(read(&claude)["hooks"]["Stop"].as_array().unwrap().len(), 3);
        assert_eq!(read(&cursor)["hooks"]["stop"].as_array().unwrap().len(), 2);
        assert_eq!(
            read(&cursor)["hooks"]["beforeMCPExecution"][0]["command"],
            "./audit.sh"
        );

        let touched = uninstall(dir.path()).unwrap();
        assert_eq!(touched.len(), 3);
        assert_eq!(read(&claude), claude_before);
        assert_eq!(read(&cursor), cursor_before);
        assert!(!dir.path().join(".sessionly").exists());
        assert!(uninstall(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn uninstall_removes_the_files_it_created() {
        let dir = repo();
        install(dir.path(), &release()).unwrap();
        uninstall(dir.path()).unwrap();
        let left: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left, [".git"]);
    }

    #[test]
    fn only_a_repository_root_is_installed_into() {
        let dir = tempfile::tempdir().unwrap();
        let err = install(dir.path(), &release()).unwrap_err();
        assert!(err.to_string().contains("not the root of a git repository"));
        assert!(fs::read_dir(dir.path()).unwrap().next().is_none());
    }
}
