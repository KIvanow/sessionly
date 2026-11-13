//! Local settings in `~/.sessionly/config.json`: this installation's id, the
//! server to upload to (if any), and what uploads may contain.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::session::Content;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Random id for this installation, created on first use. It tells a
    /// server which machine a session came from; it is not derived from
    /// anything about the machine.
    pub machine_id: String,
    /// Where to upload sessions. Nothing is uploaded while this is unset.
    pub server: Option<Server>,
    /// How much content uploaded records carry.
    pub upload_content: Content,
    /// Bring the ledger up to date (and upload, if a server is set) in the
    /// background when a session ends.
    pub auto_sync: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Server {
    pub url: String,
    pub token: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            machine_id: String::new(),
            server: None,
            upload_content: Content::Metadata,
            auto_sync: true,
        }
    }
}

impl Config {
    /// Read the config, creating it with a new machine id on first use.
    pub fn load(path: &Path) -> Result<Config> {
        // Two tries: if another process creates the file while we do, the
        // second read picks up its machine id instead of inventing our own.
        for _ in 0..2 {
            let existing = fs::read_to_string(path).ok();
            let mut config: Config = match &existing {
                Some(text) => serde_json::from_str(text).with_context(|| {
                    format!("{} is not valid; fix or delete it", path.display())
                })?,
                None => Config::default(),
            };
            // Content::Local means "not for upload"; it is never a valid setting.
            if config.upload_content == Content::Local {
                config.upload_content = Content::Metadata;
            }
            if !config.machine_id.is_empty() {
                return Ok(config);
            }
            config.machine_id = uuid::Uuid::new_v4().to_string();
            if existing.is_some() {
                config.save(path)?;
                return Ok(config);
            }
            if config.create(path)? {
                return Ok(config);
            }
        }
        anyhow::bail!("could not create {}", path.display())
    }

    /// Write to a file of our own next to `path`, readable only by the owner
    /// (the config can hold a token).
    fn write_private(&self, path: &Path) -> Result<std::path::PathBuf> {
        if let Some(dir) = path.parent() {
            crate::paths::create_private_dir(dir)?;
        }
        let unique = format!(
            "json.{}.{}.tmp",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        );
        let tmp = path.with_extension(unique);
        fs::write(&tmp, serde_json::to_string_pretty(self)? + "\n")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        }
        Ok(tmp)
    }

    /// Create the config file if it does not exist yet. Returns false if
    /// another process created it first.
    fn create(&self, path: &Path) -> Result<bool> {
        let tmp = self.write_private(path)?;
        // A hard link fails if the target exists, and the file appears complete.
        let linked = fs::hard_link(&tmp, path);
        let _ = fs::remove_file(&tmp);
        match linked {
            Ok(()) => Ok(true),
            Err(_) if path.exists() => Ok(false),
            Err(err) => Err(err).with_context(|| format!("creating {}", path.display())),
        }
    }

    /// Write the config, replacing the file in one step.
    pub fn save(&self, path: &Path) -> Result<()> {
        let tmp = self.write_private(path)?;
        fs::rename(&tmp, path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_a_stable_machine_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data/config.json");
        let first = Config::load(&path).unwrap();
        assert_eq!(first.machine_id.len(), 36);
        assert_eq!(first.upload_content, Content::Metadata);
        assert!(first.auto_sync);
        assert!(first.server.is_none());
        assert_eq!(Config::load(&path).unwrap(), first);
    }

    #[test]
    fn keeps_settings_and_fills_in_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            r#"{"machine_id":"m-1","upload_content":"previews","future_key":true}"#,
        )
        .unwrap();
        let config = Config::load(&path).unwrap();
        assert_eq!(config.machine_id, "m-1");
        assert_eq!(config.upload_content, Content::Previews);
        assert!(config.auto_sync);

        fs::write(&path, r#"{"machine_id":"m-1","upload_content":"local"}"#).unwrap();
        assert_eq!(
            Config::load(&path).unwrap().upload_content,
            Content::Metadata
        );
        fs::write(&path, "{ broken").unwrap();
        assert!(Config::load(&path).is_err());
    }

    #[test]
    fn concurrent_first_use_agrees_on_one_machine_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data/config.json");
        let ids: Vec<String> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..16)
                .map(|_| scope.spawn(|| Config::load(&path).unwrap().machine_id))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(ids.iter().all(|id| *id == ids[0]), "{ids:?}");
        // no temporary files are left behind
        assert_eq!(fs::read_dir(dir.path().join("data")).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn config_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        Config::load(&path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
