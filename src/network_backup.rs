use crate::{auth, model::*, retention};
use axum::{Json, extract::State, http::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{io::Read, path::Path, time::Duration};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub protocol: String,
    pub host: String,
    pub share: String,
    pub directory: String,
    pub username: String,
    pub password: String,
    pub uid: u32,
    pub gid: u32,
}
impl Config {
    fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            matches!(self.protocol.as_str(), "nfs" | "smb"),
            "Choose NFS or SMB"
        );
        anyhow::ensure!(
            !self.host.is_empty()
                && self.host.len() <= 253
                && !self
                    .host
                    .chars()
                    .any(|c| c.is_whitespace() || matches!(c, '/' | '\\' | '\0')),
            "Enter a server hostname or IP address"
        );
        anyhow::ensure!(
            !self.share.is_empty()
                && self.share.len() <= 1024
                && !self.share.contains(['\0', '\\']),
            "Enter an export path or share name"
        );
        if self.protocol == "nfs" {
            anyhow::ensure!(self.share.starts_with('/'), "NFS export must start with /");
        } else {
            anyhow::ensure!(
                !self.share.contains('/'),
                "SMB share must be a share name, without a path"
            );
        }
        anyhow::ensure!(
            self.directory.len() <= 1024
                && !self.directory.contains(['\0', '\\'])
                && self.directory.split('/').all(|s| s != ".." && s != "."),
            "Use a directory within the share without . or .. components"
        );
        anyhow::ensure!(
            self.username.len() <= 256 && self.password.len() <= 4096,
            "Credentials are too long"
        );
        Ok(())
    }
    pub fn summary(&self) -> Value {
        json!({"protocol":self.protocol,"host":self.host,"share":self.share,"directory":self.directory,"username":self.username,"uid":self.uid,"gid":self.gid})
    }
    fn path(&self, name: &str) -> String {
        format!("/{}/{}", self.directory.trim_matches('/'), name).replace("//", "/")
    }
}

enum Remote {
    Nfs(Box<nfs::v3::tokio::Client>),
    Smb(Box<smb2::SmbClient>, smb2::client::Tree),
}
impl Remote {
    async fn connect(config: &Config) -> anyhow::Result<Self> {
        config.validate()?;
        Ok(if config.protocol == "nfs" {
            Self::Nfs(Box::new(
                nfs::v3::tokio::ClientBuilder::new(&config.host, &config.share)
                    .auth_sys(nfs::AuthSys::new(
                        "talos-companion",
                        config.uid,
                        config.gid,
                        vec![],
                    ))
                    .timeout(Some(Duration::from_secs(30)))
                    .connect()
                    .await?,
            ))
        } else {
            let address = if config.host.contains(':') {
                format!("[{}]:445", config.host)
            } else {
                format!("{}:445", config.host)
            };
            let mut client = smb2::connect(&address, &config.username, &config.password).await?;
            let tree = client.connect_share(&config.share).await?;
            Self::Smb(Box::new(client), tree)
        })
    }
    async fn write(&mut self, path: &str, source: &Path) -> anyhow::Result<()> {
        match self {
            Self::Nfs(client) => {
                let mut file = tokio::fs::File::open(source).await?;
                client.write_atomic_from_reader(path, &mut file).await?;
            }
            Self::Smb(client, tree) => {
                let mut file = std::fs::File::open(source)?;
                let mut next = || {
                    let mut buffer = vec![0; 256 * 1024];
                    match file.read(&mut buffer) {
                        Ok(0) => None,
                        Ok(n) => {
                            buffer.truncate(n);
                            Some(Ok(buffer))
                        }
                        Err(e) => Some(Err(e)),
                    }
                };
                client
                    .write_file_streamed(tree, path.trim_start_matches('/'), &mut next)
                    .await?;
            }
        }
        Ok(())
    }
    async fn read(&mut self, path: &str) -> anyhow::Result<Vec<u8>> {
        Ok(match self {
            Self::Nfs(client) => client.read(path).await?,
            Self::Smb(client, tree) => client.read_file(tree, path.trim_start_matches('/')).await?,
        })
    }
    async fn remove(&mut self, path: &str) -> anyhow::Result<()> {
        match self {
            Self::Nfs(client) => client.remove(path).await?,
            Self::Smb(client, tree) => {
                client
                    .delete_file(tree, path.trim_start_matches('/'))
                    .await?
            }
        }
        Ok(())
    }
    async fn rename(&mut self, from: &str, to: &str) -> anyhow::Result<()> {
        match self {
            Self::Nfs(client) => client.rename(from, to).await?,
            Self::Smb(client, tree) => {
                client
                    .rename(
                        tree,
                        from.trim_start_matches('/'),
                        to.trim_start_matches('/'),
                    )
                    .await?
            }
        }
        Ok(())
    }
    async fn files(&mut self, path: &str) -> anyhow::Result<Vec<String>> {
        Ok(match self {
            Self::Nfs(client) => client
                .read_dir(path)
                .await?
                .into_iter()
                .filter(|e| e.attributes.as_ref().is_some_and(|a| a.is_file()))
                .map(|e| e.name)
                .collect(),
            Self::Smb(client, tree) => client
                .list_directory(tree, path.trim_start_matches('/'))
                .await?
                .into_iter()
                .filter(|e| !e.is_directory)
                .map(|e| e.name)
                .collect(),
        })
    }
}

async fn probe(config: &Config) -> anyhow::Result<()> {
    use std::io::Write;
    let mut remote = Remote::connect(config).await?;
    let name = config.path(&format!(".companion-check-{}", secret()));
    let mut file = tempfile::NamedTempFile::new()?;
    let contents = b"Talos Companion destination check\n";
    file.write_all(contents)?;
    let result = async {
        remote.write(&name, file.path()).await?;
        anyhow::ensure!(
            remote.read(&name).await? == contents,
            "Share read check failed"
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    let cleanup = remote.remove(&name).await;
    result?;
    cleanup?;
    Ok(())
}

pub async fn configure(
    State(app): State<App>,
    headers: HeaderMap,
    Json(mut config): Json<Config>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let _serial = app.backup_lock.lock().await;
    if config.password.is_empty()
        && let Some(old) = app
            .store
            .read()
            .await
            .as_ref()
            .and_then(|s| s.network.as_ref())
        && old.protocol == config.protocol
        && old.host == config.host
        && old.share == config.share
        && old.username == config.username
    {
        config.password.clone_from(&old.password);
    }
    config.validate().map_err(|e| bad(&e.to_string()))?;
    tokio::time::timeout(Duration::from_secs(60), probe(&config)).await
        .map_err(|_| bad("Share check timed out. Check the server address and firewall, then retry."))?
        .map_err(|e| { tracing::warn!(error=%e, "network share check failed"); bad("Cannot create, read, and remove a file on the share. Check the server, share path, and credentials or NFS export permissions.") })?;
    let mut guard = app.store.write().await;
    let mut store = guard.clone().ok_or_else(denied)?;
    store.network = Some(config);
    app.persist(&store)?;
    *guard = Some(store);
    Ok(Json(json!({"ok":true})))
}

pub async fn upload(app: &App, name: &str, source: &Path, keep: usize) -> anyhow::Result<()> {
    let config = app
        .store
        .read()
        .await
        .as_ref()
        .and_then(|s| s.network.clone())
        .ok_or_else(|| anyhow::anyhow!("Configure a network share first"))?;
    let mut remote = Remote::connect(&config).await?;
    let pending = config.path(&format!(".upload-{}", secret()));
    let result = async {
        remote.write(&pending, source).await?;
        remote.rename(&pending, &config.path(name)).await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        let _ = remote.remove(&pending).await;
        return Err(error);
    }
    if keep > 0 {
        let mut files = remote.files(&config.path("")).await?;
        files.retain(|n| retention::recovery_name(n));
        files.sort_by(|a, b| (b == name).cmp(&(a == name)).then_with(|| b.cmp(a)));
        for file in files.into_iter().skip(keep) {
            remote.remove(&config.path(&file)).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        Config {
            protocol: "smb".into(),
            host: "nas.example.test".into(),
            share: "Backups".into(),
            directory: "companion".into(),
            username: "backup".into(),
            password: "private-share-password".into(),
            uid: 99,
            gid: 100,
        }
    }

    #[test]
    fn validates_protocol_paths_and_redacts_password_from_overview() {
        let mut c = config();
        c.validate().unwrap();
        assert_eq!(c.path("backup.tcb"), "/companion/backup.tcb");
        assert!(c.summary().get("password").is_none());
        let restored: Config = serde_json::from_slice(&serde_json::to_vec(&c).unwrap()).unwrap();
        assert_eq!(restored.password, c.password);
        for path in [
            "../elsewhere",
            "nested/../elsewhere",
            "C:\\backups",
            "bad\0path",
        ] {
            c.directory = path.into();
            assert!(c.validate().is_err(), "{path}");
        }
        c.directory = String::new();
        assert_eq!(c.path("backup.tcb"), "/backup.tcb");
        c.protocol = "nfs".into();
        assert!(c.validate().is_err());
        c.share = "/exports/backups".into();
        c.validate().unwrap();
        c.protocol = "ftp".into();
        assert!(c.validate().is_err());
    }
}
