use crate::{auth, model::*};
use axum::{
    Json,
    extract::{Multipart, Path as AxumPath, State},
    http::{HeaderMap, header},
};
use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit,
    aead::{Aead, Payload},
};
use rand::{RngCore, rngs::OsRng};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::{Component, Path},
};

pub const LIMIT: usize = 256 * 1024 * 1024;
const MAGIC: &[u8] = b"TCBACKUP\x01";
fn derive(pass: &str, salt: &[u8]) -> anyhow::Result<[u8; 32]> {
    let mut key = [0; 32];
    argon2::Argon2::default()
        .hash_password_into(pass.as_bytes(), salt, &mut key)
        .map_err(|_| anyhow::anyhow!("Key derivation failed"))?;
    Ok(key)
}
pub fn encrypt(data: &[u8], pass: &str) -> anyhow::Result<Vec<u8>> {
    let mut salt = [0; 16];
    let mut nonce = [0; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let cipher = ChaCha20Poly1305::new((&derive(pass, &salt)?).into());
    let encrypted = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: data,
                aad: MAGIC,
            },
        )
        .map_err(|_| anyhow::anyhow!("Encryption failed"))?;
    Ok([MAGIC, &salt, &nonce, &encrypted].concat())
}
pub fn decrypt(data: &[u8], pass: &str) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(
        data.len() > MAGIC.len() + 44 && data.starts_with(MAGIC),
        "Unsupported backup format"
    );
    let p = MAGIC.len();
    let cipher = ChaCha20Poly1305::new((&derive(pass, &data[p..p + 16])?).into());
    cipher
        .decrypt(
            data[p + 16..p + 28].into(),
            Payload {
                msg: &data[p + 28..],
                aad: MAGIC,
            },
        )
        .map_err(|_| anyhow::anyhow!("Wrong passphrase or damaged backup"))
}
struct Bounded(Vec<u8>);
impl Write for Bounded {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(b.len()) > LIMIT {
            return Err(std::io::Error::other(
                "Backup exceeds the 256 MiB snapshot limit",
            ));
        }
        self.0.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn archive(state: &Store, receiver: &Path, pass: &str) -> anyhow::Result<Vec<u8>> {
    let mut tar = tar::Builder::new(Bounded(Vec::new()));
    tar.follow_symlinks(false);
    let bytes = serde_json::to_vec(state)?;
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_cksum();
    tar.append_data(&mut header, "state.json", bytes.as_slice())?;
    tar.append_dir_all("receiver", receiver)?;
    tar.append_dir_all("vault", receiver.parent().unwrap().join("vault"))?;
    let bytes = tar.into_inner()?.0;
    encrypt(&bytes, pass)
}
pub async fn create(app: &App, destination: &str) -> Result<Value> {
    let _serial = app.backup_lock.lock().await;
    if !matches!(destination, "local" | "mounted" | "drive") {
        return Err(bad("Unknown destination"));
    }
    if destination == "mounted" && app.mounted.is_none() {
        return Err(bad("No mounted destination configured"));
    }
    let _io = app.io.write().await;
    let state = app.store.read().await.clone().ok_or_else(denied)?;
    let path = app.data.join("receiver");
    let pass = app.backup_passphrase.clone();
    let bytes = tokio::task::spawn_blocking(move || archive(&state, &path, &pass))
        .await
        .map_err(anyhow::Error::from)??;
    drop(_io);
    let name = format!("companion-{}-{}.tcb", now(), &secret()[..8]);
    let target = app.data.join("backups").join(&name);
    {
        let mut tmp = tempfile::NamedTempFile::new_in(app.data.join("backups"))
            .map_err(anyhow::Error::from)?;
        tmp.write_all(&bytes).map_err(anyhow::Error::from)?;
        tmp.as_file().sync_all().map_err(anyhow::Error::from)?;
        tmp.persist(&target).map_err(anyhow::Error::from)?;
    }
    // Keep the durable local file even if the remote transfer fails.
    let transfer: std::result::Result<(), anyhow::Error> = match destination {
        "mounted" => {
            let dir = app.mounted.as_ref().unwrap();
            // Never create the mount root: a missing Unraid mount must fail, not silently write locally.
            (|| {
                anyhow::ensure!(dir.is_dir(), "Mounted destination is unavailable");
                let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
                tmp.write_all(&bytes)?;
                tmp.as_file().sync_all()?;
                tmp.persist(dir.join(&name))?;
                Ok(())
            })()
        }
        "drive" => crate::drive::upload(app, &name, bytes).await,
        _ => Ok(()),
    };
    let warning = transfer.err().map(|e| {
        tracing::error!(error=%e,"backup transfer failed");
        "Remote transfer failed. The local backup is available; check server logs."
    });
    Ok(json!({"name":name,"destination":destination,"warning":warning}))
}
#[derive(Deserialize)]
pub struct Create {
    pub destination: String,
}
pub async fn make(
    State(app): State<App>,
    headers: HeaderMap,
    Json(q): Json<Create>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    Ok(Json(create(&app, &q.destination).await?))
}
pub async fn list(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    auth::admin(&app, &headers).await?;
    let mut items = Vec::new();
    for entry in std::fs::read_dir(app.data.join("backups")).map_err(anyhow::Error::from)? {
        let entry = entry.map_err(anyhow::Error::from)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if valid_name(&name) {
            items.push(
                json!({"name":name,"bytes":entry.metadata().map_err(anyhow::Error::from)?.len()}),
            );
        }
    }
    items.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
    Ok(Json(json!(items)))
}
fn valid_name(name: &str) -> bool {
    name.starts_with("companion-")
        && name.ends_with(".tcb")
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
}
pub async fn download(
    State(app): State<App>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Result<([(header::HeaderName, String); 2], Vec<u8>)> {
    auth::admin(&app, &headers).await?;
    if !valid_name(&name) {
        return Err(bad("Invalid filename"));
    }
    let bytes = tokio::fs::read(app.data.join("backups").join(&name))
        .await
        .map_err(anyhow::Error::from)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".into()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
        ],
        bytes,
    ))
}
fn stage(bytes: &[u8], root: &Path) -> anyhow::Result<Store> {
    let mut archive = tar::Archive::new(bytes);
    let mut total = 0u64;
    let mut seen = std::collections::HashSet::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        anyhow::ensure!(
            path.components().all(|c| matches!(c, Component::Normal(_)))
                && (path == Path::new("state.json")
                    || path.starts_with("receiver")
                    || path.starts_with("vault")),
            "Unsafe archive path"
        );
        anyhow::ensure!(seen.insert(path.clone()), "Duplicate archive entry");
        let kind = entry.header().entry_type();
        anyhow::ensure!(
            kind.is_file() || kind.is_dir(),
            "Archive links and special files are forbidden"
        );
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| anyhow::anyhow!("Archive too large"))?;
        anyhow::ensure!(total <= LIMIT as u64, "Archive too large");
        let target = root.join(&path);
        if kind.is_dir() {
            std::fs::create_dir_all(target)?;
        } else {
            std::fs::create_dir_all(target.parent().unwrap())?;
            let mut options = std::fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut out = options.open(target)?;
            std::io::copy(&mut entry, &mut out)?;
        }
    }
    let mut buffer = Vec::new();
    std::fs::File::open(root.join("state.json"))?
        .take(1024 * 1024)
        .read_to_end(&mut buffer)?;
    let s: Store = serde_json::from_slice(&buffer)?;
    anyhow::ensure!(
        s.version == 1 && !s.users.is_empty() && s.users.iter().any(|u| u.admin),
        "Invalid or unsupported account state"
    );
    let mut ids = std::collections::HashSet::new();
    let mut emails = std::collections::HashSet::new();
    for u in &s.users {
        anyhow::ensure!(
            ids.insert(&u.id) && emails.insert(&u.email) && u.email.contains('@'),
            "Invalid or duplicate account"
        );
        argon2::password_hash::PasswordHash::new(&u.password_hash)
            .map_err(|_| anyhow::anyhow!("Invalid password hash"))?;
    }
    use rsa::pkcs8::DecodePrivateKey;
    let key = rsa::RsaPrivateKey::from_pkcs8_pem(&s.signing_key)?;
    key.validate()?;
    anyhow::ensure!(
        s.s3_access_key.len() >= 24 && s.s3_secret_key.len() >= 24 && s.client_secret.len() >= 24,
        "Invalid integration credentials"
    );
    std::fs::create_dir_all(root.join("receiver"))?;
    std::fs::create_dir_all(root.join("vault"))?;
    Ok(s)
}
pub async fn restore(
    State(app): State<App>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    auth::setup_auth(&app, &headers)?;
    if app.store.read().await.is_some() {
        return Err(bad("Restore is available only on a fresh instance"));
    }
    let mut file = None;
    let mut pass = None;
    let mut override_account = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| bad("Invalid upload"))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                let b = field
                    .bytes()
                    .await
                    .map_err(|_| bad("Upload is too large"))?;
                if b.len() > LIMIT + 128 {
                    return Err(bad("Backup is too large"));
                }
                file = Some(b.to_vec());
            }
            "passphrase" => pass = Some(field.text().await.map_err(|_| bad("Missing passphrase"))?),
            "account" => {
                override_account = Some(
                    serde_json::from_str::<auth::Account>(
                        &field.text().await.map_err(|_| bad("Invalid account"))?,
                    )
                    .map_err(|_| bad("Invalid account"))?,
                )
            }
            _ => return Err(bad("Unknown restore field")),
        }
    }
    let encrypted = file.ok_or_else(|| bad("Choose a backup file"))?;
    let pass = pass.ok_or_else(|| bad("Provide the original backup passphrase"))?;
    let data = app.data.clone();
    let (temp, mut s) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let bytes = decrypt(&encrypted, &pass)?;
        let temp = tempfile::tempdir_in(data)?;
        let s = stage(&bytes, temp.path())?;
        Ok((temp, s))
    })
    .await
    .map_err(anyhow::Error::from)?
    .map_err(|e| {
        tracing::warn!(error=%e,"restore rejected");
        bad("Backup could not be restored: wrong passphrase, damaged file, or invalid contents")
    })?;
    if let Some(mut input) = override_account {
        input.admin = true;
        let mut replacement = auth::make_user(input)?;
        let old = s.users.iter_mut().find(|u| u.admin).unwrap();
        replacement.id = old.id.clone();
        if s.users
            .iter()
            .any(|u| u.id != replacement.id && u.email == replacement.email)
        {
            return Err(bad("Override email belongs to another restored account"));
        }
        let old = s.users.iter_mut().find(|u| u.id == replacement.id).unwrap();
        *old = replacement;
    }
    let _io = app.io.write().await;
    let mut guard = app.store.write().await;
    if guard.is_some() {
        return Err(bad("Already initialized"));
    }
    // Swap staged data before the state commit; roll back all swaps on failure.
    let mut moved = Vec::new();
    let committed = (|| -> anyhow::Result<()> {
        for name in ["receiver", "vault"] {
            let live = app.data.join(name);
            let old = temp.path().join(format!("previous-{name}"));
            std::fs::rename(&live, &old)?;
            if let Err(e) = std::fs::rename(temp.path().join(name), &live) {
                std::fs::rename(old, live)?;
                return Err(e.into());
            }
            moved.push(name);
        }
        app.persist(&s)
    })();
    if let Err(e) = committed {
        for name in moved.into_iter().rev() {
            std::fs::rename(app.data.join(name), temp.path().join(name))
                .map_err(anyhow::Error::from)?;
            std::fs::rename(
                temp.path().join(format!("previous-{name}")),
                app.data.join(name),
            )
            .map_err(anyhow::Error::from)?;
        }
        return Err(e.into());
    }
    *guard = Some(s);
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_encryption_rejects_wrong_password_and_tampering() {
        let data = encrypt(
            b"account and cluster secrets",
            "a very long recovery passphrase",
        )
        .unwrap();
        assert_eq!(
            decrypt(&data, "a very long recovery passphrase").unwrap(),
            b"account and cluster secrets"
        );
        assert!(decrypt(&data, "wrong passphrase").is_err());
        let mut damaged = data;
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        assert!(decrypt(&damaged, "a very long recovery passphrase").is_err());
    }
    #[test]
    fn archive_rejects_symlinks() {
        let mut b = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_size(0);
        h.set_mode(0o777);
        h.set_link_name("/etc/passwd").unwrap();
        h.set_cksum();
        b.append_data(&mut h, "receiver/link", std::io::empty())
            .unwrap();
        let bytes = b.into_inner().unwrap();
        let temp = tempfile::tempdir().unwrap();
        assert!(stage(&bytes, temp.path()).is_err());
    }
}
