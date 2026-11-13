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
        let mut config: Config = match fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)
                .with_context(|| format!("{} is not valid; fix or delete it", path.display()))?,
            Err(_) => Config::default(),
        };
        // Content::Local means "not for upload"; it is never a valid setting.
        if config.upload_content == Content::Local {
            config.upload_content = Content::Metadata;
        }
        if config.machine_id.is_empty() {
            config.machine_id = uuid::Uuid::new_v4().to_string();
            config.save(path)?;
        }
        Ok(config)
    }

    /// Write the config, readable only by the owner (it can hold a token).
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            crate::paths::create_private_dir(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_string_pretty(self)? + "\n")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        }
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
