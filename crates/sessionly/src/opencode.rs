//! The OpenCode plugin: a file OpenCode loads on its own, which notes that a
//! session happened. The database is the record. The file is not.
//!
//! OpenCode 1.19.6 scans `{plugin,plugins}/*.{js,ts}` under its config
//! directory and loads each as the plugin shape of that version. The config
//! file is left alone.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// What `sessionly install` writes. One line per session, and nothing the
/// person typed: the word for a typed message is kept out of the file so a
/// test can say so.
const PLUGIN: &str = r#"import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function directory() {
  if (process.env.SESSIONLY_HOME) return process.env.SESSIONLY_HOME;
  const home = homedir();
  return home ? join(home, ".sessionly") : "";
}

function note(id) {
  try {
    if (typeof id !== "string" || id === "") return;
    const safe = id.replace(/[^A-Za-z0-9_-]/g, "");
    if (safe === "") return;
    const root = directory();
    if (root === "") return;
    const dir = join(root, "raw", "opencode");
    const file = join(dir, safe + ".jsonl");
    if (existsSync(file)) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      v: 1,
      source: "opencode",
      origin: "hook",
      hook: "SessionStart",
      session_id: safe,
      payload: {
        session_id: safe,
        hook_event_name: "SessionStart",
        source: "startup",
      },
    });
    writeFileSync(file, line + "\n", { flag: "wx", mode: 0o600 });
  } catch {
    // A marker is a convenience. OpenCode should not hear about a failure.
  }
}

export default async () => ({
  event: async ({ event }) => {
    if (!event || typeof event !== "object") return;
    const props = event.properties || {};
    if (event.type === "session.created") {
      const info = props.info || {};
      note(info.id);
      note(info.parentID);
    } else if (event.type === "session.idle") {
      note(props.sessionID);
    }
  },
});
"#;

fn plugin_path(config: &Path) -> PathBuf {
    config.join("plugins").join("sessionly.js")
}

/// `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`.
fn config_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::paths::home_dir().map(|home| home.join(".config")))
        .map(|dir| dir.join("opencode"))
}

fn write_plugin(path: &Path) -> Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("writing {}", path.display()))?;
    file.write_all(PLUGIN.as_bytes())?;
    Ok(())
}

/// Write the plugin under `config` (`…/opencode`). True when the file was
/// written or replaced.
pub(crate) fn install_into(config: &Path) -> Result<bool> {
    let path = plugin_path(config);
    if fs::read(&path).ok().as_deref() == Some(PLUGIN.as_bytes()) {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    let tmp = path.with_extension(format!("js.{}.tmp", std::process::id()));
    write_plugin(&tmp)?;
    if let Err(err) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(err).with_context(|| format!("installing {}", path.display()));
    }
    Ok(true)
}

/// Remove only the plugin file. True when it was there.
pub(crate) fn uninstall_from(config: &Path) -> Result<bool> {
    let path = plugin_path(config);
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err).with_context(|| format!("removing {}", path.display())),
    }
}

/// Install when OpenCode's config directory exists. Prints nothing and
/// changes nothing when it does not.
pub fn install() -> Result<()> {
    let Some(dir) = config_dir().filter(|dir| dir.is_dir()) else {
        return Ok(());
    };
    let path = plugin_path(&dir);
    if install_into(&dir)? {
        println!("Installed the OpenCode plugin in {}", path.display());
    } else {
        println!("OpenCode plugin already installed in {}", path.display());
    }
    Ok(())
}

/// Remove the plugin file. Prints only when one was removed.
pub fn uninstall() -> Result<()> {
    let Some(dir) = config_dir() else {
        return Ok(());
    };
    if uninstall_from(&dir)? {
        println!(
            "Removed the OpenCode plugin from {}",
            plugin_path(&dir).display()
        );
    }
    Ok(())
}

/// What `sessionly status` prints after `OpenCode:`, when the config
/// directory exists.
pub fn status() -> Option<String> {
    let dir = config_dir().filter(|dir| dir.is_dir())?;
    let path = plugin_path(&dir);
    let line = if fs::read(&path).ok().as_deref() == Some(PLUGIN.as_bytes()) {
        format!("plugin in {}", path.display())
    } else {
        "plugin missing or out of date (run: sessionly install)".to_string()
    };
    Some(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plugin_is_installed_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("opencode");
        fs::create_dir(&root).unwrap();
        assert!(install_into(&root).unwrap());
        let path = root.join("plugins/sessionly.js");
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("export default"));
        assert!(text.contains("session.created"));
        assert!(!text.contains("\"prompt\""));
        assert!(!install_into(&root).unwrap());
        fs::write(root.join("plugins/other.js"), "keep").unwrap();
        assert!(uninstall_from(&root).unwrap());
        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(root.join("plugins/other.js")).unwrap(),
            "keep"
        );
        assert!(!uninstall_from(&root).unwrap());
    }
}
