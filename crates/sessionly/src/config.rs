//! Local settings in `~/.sessionly/config.json`: this installation's id, the
//! server to upload to (if any), and what uploads may contain.

use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::session::Content;

/// A token sent over plain http can be read by anyone on the network, so
/// http is accepted only for a server on this machine.
pub fn check_server_url(url: &str) -> Result<()> {
    let local = ["http://localhost", "http://127.0.0.1", "http://[::1]"]
        .iter()
        .any(|prefix| {
            url.strip_prefix(prefix)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with([':', '/']))
        });
    if url.starts_with("https://") || local {
        Ok(())
    } else {
        bail!(
            "the server address must start with https:// (http:// is accepted only for localhost)"
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Random id for this installation, created on first use. It tells a
    /// server which machine a session came from; it is not derived from
    /// anything about the machine. In a cloud session's sandbox it is the
    /// word "cloud": a sandbox is new each time, and a session that moves
    /// to another one must stay the same session.
    pub machine_id: String,
    /// Where to upload sessions. Nothing is uploaded while this is unset.
    pub server: Option<Server>,
    /// How much content uploaded records carry.
    pub upload_content: Content,
    /// Bring the ledger up to date (and upload, if a server is set) in the
    /// background when a session ends.
    pub auto_sync: bool,
    /// Upload hashes of the lines agents added, so the server can tell which
    /// lines of a pull request an agent wrote. Off unless switched on.
    pub upload_line_hashes: bool,
    /// Count what an agent's shell commands change in the working tree, on
    /// this machine too (see `changes`). Off unless switched on: whatever
    /// else changes a file while a command runs is put down to the agent.
    pub shell_edits: bool,
    /// Repositories this machine does not upload. The server's list decides;
    /// this is the copy last set here, used when the server cannot be asked.
    #[serde(default)]
    pub excluded_repos: Vec<String>,
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
            upload_line_hashes: false,
            shell_edits: false,
            excluded_repos: Vec::new(),
        }
    }
}

/// Whether `shell_edits` is switched on in the config at `path`. For the
/// capture hook, which runs for every event: it reads the one setting and
/// never creates the file.
pub fn shell_edits(path: &Path) -> bool {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .is_some_and(|config| config["shell_edits"] == true)
}

impl Config {
    /// Read the config, creating it with a new machine id on first use.
    pub fn load(path: &Path) -> Result<Config> {
        Self::load_with(path, || {
            if crate::runtime::in_cloud() {
                crate::runtime::CLOUD_MACHINE_ID.to_string()
            } else {
                uuid::Uuid::new_v4().to_string()
            }
        })
    }

    /// Settings given through the environment, for a sandbox where nobody
    /// can run `sessionly connect`:
    ///
    /// - `SESSIONLY_URL` and `SESSIONLY_TOKEN` name the server, unless one is
    ///   already saved;
    /// - `SESSIONLY_CONTENT` (`metadata` or `previews`) and
    ///   `SESSIONLY_LINE_HASHES` (`on` or `off`) override what is saved.
    ///
    /// The result is for use, not for saving: a token from the environment
    /// is never written to disk.
    pub fn with_environment(self) -> Config {
        self.with_env(&|name| std::env::var(name).ok())
    }

    fn with_env(mut self, env: &dyn Fn(&str) -> Option<String>) -> Config {
        let var = |name: &str| {
            env(name)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        if self.server.is_none() {
            if let (Some(url), Some(token)) = (var("SESSIONLY_URL"), var("SESSIONLY_TOKEN")) {
                let url = url.trim_end_matches('/').to_string();
                if check_server_url(&url).is_ok() {
                    self.server = Some(Server { url, token });
                }
            }
        }
        match var("SESSIONLY_CONTENT").as_deref() {
            Some("previews") => self.upload_content = Content::Previews,
            Some("metadata") => self.upload_content = Content::Metadata,
            _ => {}
        }
        match var("SESSIONLY_LINE_HASHES").as_deref() {
            Some("on" | "true" | "1") => self.upload_line_hashes = true,
            Some("off" | "false" | "0") => self.upload_line_hashes = false,
            _ => {}
        }
        self
    }

    fn load_with(path: &Path, new_machine_id: impl Fn() -> String) -> Result<Config> {
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
            config.machine_id = new_machine_id();
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

    fn random_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    #[test]
    fn every_sandbox_shares_one_machine_id() {
        let dir = tempfile::tempdir().unwrap();
        let cloud = || crate::runtime::CLOUD_MACHINE_ID.to_string();
        let first = Config::load_with(&dir.path().join("a/config.json"), cloud).unwrap();
        let second = Config::load_with(&dir.path().join("b/config.json"), cloud).unwrap();
        assert_eq!(first.machine_id, "cloud");
        assert_eq!(second.machine_id, first.machine_id);
    }

    #[test]
    fn the_environment_names_a_server_and_what_to_send() {
        let given = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.to_string())
            }
        };
        let base = Config::default();
        assert_eq!(base.clone().with_env(&given(&[])), base);

        let set = base.clone().with_env(&given(&[
            ("SESSIONLY_URL", " https://sessionly.example.com/ "),
            ("SESSIONLY_TOKEN", "sly_abc\n"),
            ("SESSIONLY_CONTENT", "previews"),
            ("SESSIONLY_LINE_HASHES", "on"),
        ]));
        let server = Server {
            url: "https://sessionly.example.com".into(),
            token: "sly_abc".into(),
        };
        assert_eq!(set.server, Some(server.clone()));
        assert_eq!(set.upload_content, Content::Previews);
        assert!(set.upload_line_hashes);

        // Half an address is none, and a token is not sent over plain http.
        let url_only = given(&[("SESSIONLY_URL", "https://sessionly.example.com")]);
        assert_eq!(base.clone().with_env(&url_only).server, None);
        let plain = given(&[
            ("SESSIONLY_URL", "http://sessionly.example.com"),
            ("SESSIONLY_TOKEN", "sly_abc"),
        ]);
        assert_eq!(base.clone().with_env(&plain).server, None);

        // A saved server stays; the other two settings can be switched back.
        let saved = Config {
            server: Some(Server {
                url: "https://saved.example.com".into(),
                token: "sly_saved".into(),
            }),
            upload_content: Content::Previews,
            upload_line_hashes: true,
            ..Config::default()
        };
        let changed = saved.clone().with_env(&given(&[
            ("SESSIONLY_URL", "https://sessionly.example.com"),
            ("SESSIONLY_TOKEN", "sly_abc"),
            ("SESSIONLY_CONTENT", "metadata"),
            ("SESSIONLY_LINE_HASHES", "off"),
        ]));
        assert_eq!(changed.server, saved.server);
        assert_eq!(changed.upload_content, Content::Metadata);
        assert!(!changed.upload_line_hashes);
        let nonsense = given(&[
            ("SESSIONLY_CONTENT", "everything"),
            ("SESSIONLY_LINE_HASHES", "maybe"),
        ]);
        assert_eq!(saved.clone().with_env(&nonsense), saved);
    }

    #[test]
    fn creates_a_stable_machine_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data/config.json");
        let first = Config::load_with(&path, random_id).unwrap();
        assert_eq!(first.machine_id.len(), 36);
        assert_eq!(first.upload_content, Content::Metadata);
        assert!(first.auto_sync);
        assert!(first.server.is_none());
        assert_eq!(Config::load_with(&path, random_id).unwrap(), first);
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
