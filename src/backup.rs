use crate::{auth, backup_format, model::*, retention};
use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path as AxumPath, State},
    http::{HeaderMap, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Component, Path},
};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

const BUFFER: usize = 64 * 1024;

fn probe_directory(directory: &Path) -> anyhow::Result<()> {
    use std::io::{Seek, SeekFrom};
    anyhow::ensure!(directory.is_dir(), "Mounted destination is unavailable");
    let mut file = tempfile::Builder::new()
        .prefix(".companion-check-")
        .tempfile_in(directory)?;
    let contents = b"Talos Companion destination check\n";
    file.write_all(contents)?;
    file.as_file().sync_all()?;
    file.seek(SeekFrom::Start(0))?;
    let mut readback = Vec::new();
    file.read_to_end(&mut readback)?;
    anyhow::ensure!(readback == contents, "Destination read check failed");
    file.close()?;
    Ok(())
}

pub async fn check_mounted(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let directory = app.mounted.clone().ok_or_else(|| {
        bad("Mount your NFS / SMB share on the host, map it into the container, and set MOUNTED_BACKUP_DIR first. Then apply the container changes and retry.")
    })?;
    let path = directory.to_string_lossy().into_owned();
    let probe = tokio::task::spawn_blocking(move || probe_directory(&directory));
    tokio::time::timeout(std::time::Duration::from_secs(10), probe)
        .await
        .map_err(|_| bad("Share check timed out. Check the host mount and NAS connection, then retry."))?
        .map_err(anyhow::Error::from)?
        .map_err(|e| bad(&format!("Cannot write to the share: {e}. Check the host mount and container user permissions.")))?;
    Ok(Json(json!({"path":path})))
}

fn archive(
    state: &Store,
    receiver: &Path,
    pass: &str,
    directory: &Path,
    name: &str,
    settings: &crate::settings::Settings,
) -> anyhow::Result<()> {
    let mut tmp = tempfile::NamedTempFile::new_in(directory)?;
    {
        let output = BufWriter::with_capacity(BUFFER, tmp.as_file_mut());
        let encrypted = backup_format::encrypt(output, pass)?;
        let mut tar = tar::Builder::new(encrypted);
        tar.follow_symlinks(false);
        // Restore deliberately accepts regular files and directories only. On Unix,
        // tar otherwise emits GNU sparse entries for holes in etcd/database files.
        tar.sparse(false);
        let bytes = serde_json::to_vec(state)?;
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        tar.append_data(&mut header, "state.json", bytes.as_slice())?;
        let bytes = serde_json::to_vec(settings)?;
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        tar.append_data(&mut header, "config.json", bytes.as_slice())?;
        let omitted = retention::snapshot_paths(receiver, settings.retention.snapshot_keep_last)?
            .into_iter()
            .collect();
        append_receiver(&mut tar, receiver, &omitted)?;
        tar.append_dir_all("vault", receiver.parent().unwrap().join("vault"))?;
        let encrypted = tar.into_inner()?;
        let mut output = encrypted.finish()?;
        output.flush()?;
    }
    tmp.as_file().sync_all()?;
    tmp.persist(directory.join(name))?;
    Ok(())
}

fn append_receiver<W: Write>(
    tar: &mut tar::Builder<W>,
    root: &Path,
    omitted: &std::collections::HashSet<std::path::PathBuf>,
) -> anyhow::Result<()> {
    let mut directories = vec![(root.to_owned(), std::path::PathBuf::from("receiver"))];
    while let Some((directory, name)) = directories.pop() {
        tar.append_dir(&name, &directory)?;
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            let path = entry.path();
            if omitted.contains(&path) {
                continue;
            }
            let name = name.join(entry.file_name());
            let kind = entry.file_type()?;
            if kind.is_dir() {
                directories.push((path, name));
            } else {
                anyhow::ensure!(
                    kind.is_file(),
                    "Receiver links and special files cannot be archived"
                );
                tar.append_path_with_name(path, name)?;
            }
        }
    }
    Ok(())
}

pub async fn create(app: &App, destination: &str) -> Result<Value> {
    // Once started, finish the durable snapshot and cleanup even if the browser disconnects.
    let app = app.clone();
    let destination = destination.to_owned();
    tokio::spawn(async move { create_inner(&app, &destination).await })
        .await
        .map_err(anyhow::Error::from)?
}
async fn create_inner(app: &App, destination: &str) -> Result<Value> {
    let _serial = app.backup_lock.lock().await;
    let settings = app.settings.borrow().clone();
    if !matches!(destination, "local" | "mounted" | "drive" | "network") {
        return Err(bad("Unknown destination"));
    }
    if destination == "mounted" && app.mounted.is_none() {
        return Err(bad("No mounted destination configured"));
    }
    if destination == "network"
        && app
            .store
            .read()
            .await
            .as_ref()
            .is_none_or(|s| s.network.is_none())
    {
        return Err(bad("Connect a network share first"));
    }
    let io_guard = app.io.clone().write_owned().await;
    let state = app.store.read().await.clone().ok_or_else(denied)?;
    let name = format!("companion-{}-{}.tcb", now(), &secret()[..8]);
    let target = app.data.join("backups").join(&name);
    let data = app.data.clone();
    let pass = app.backup_passphrase.clone();
    let snapshot_name = name.clone();
    let keep_snapshots = settings.retention.snapshot_keep_last;
    let keep = settings.retention.recovery_keep_last;
    let retention_warning = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<String>> {
        // The lock lives in this worker too, so aborting an HTTP handler cannot expose a half-read source.
        let _io = io_guard;
        archive(&state, &data.join("receiver"), &pass, &data.join("backups"), &snapshot_name, &settings)?;
        // Expire received snapshots only AFTER a new complete, durable recovery file exists.
        Ok(retention::received_snapshots(&data.join("receiver"), keep_snapshots).err().map(|e| {
            tracing::error!(error=%e,"received snapshot retention failed");
            "Recovery file saved, but received-snapshot retention failed; check server logs.".to_owned()
        }))
    }).await.map_err(anyhow::Error::from)??;
    let mut warnings: Vec<String> = retention_warning.into_iter().collect();
    let transfer: anyhow::Result<()> = match destination {
        "mounted" => {
            let dir = app.mounted.clone().unwrap();
            let source = target.clone();
            let name = name.clone();
            tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
                anyhow::ensure!(dir.is_dir(), "Mounted destination is unavailable");
                let mut tmp = tempfile::NamedTempFile::new_in(&dir)?;
                io::copy(&mut std::fs::File::open(source)?, tmp.as_file_mut())?;
                tmp.as_file().sync_all()?;
                tmp.persist(dir.join(&name))?;
                retention::recovery_files(&dir, keep, &name)?;
                Ok(())
            })
            .await
            .map_err(anyhow::Error::from)?
        }
        "network" => crate::network_backup::upload(app, &name, &target, keep).await,
        "drive" => crate::drive::upload(app, &name, &target, keep).await,
        _ => Ok(()),
    };
    if let Err(e) = transfer {
        tracing::error!(error=%e,"backup transfer or destination retention failed");
        warnings.push("Remote transfer or destination retention failed. The local backup is available; check server logs.".into());
    }
    let directory = app.data.join("backups");
    let current = name.clone();
    if let Err(e) =
        tokio::task::spawn_blocking(move || retention::recovery_files(&directory, keep, &current))
            .await
            .map_err(anyhow::Error::from)?
    {
        tracing::error!(error=%e,"local recovery retention failed");
        warnings.push("Recovery file saved, but local retention failed; check server logs.".into());
    }
    Ok(
        json!({"name":name,"destination":destination,"warning":if warnings.is_empty(){None}else{Some(warnings.join(" "))}}),
    )
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
    let directory = app.data.join("backups");
    let items = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<Value>> {
        let mut items = Vec::new();
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if retention::recovery_name(&name) && entry.file_type()?.is_file() {
                items.push(json!({"name":name,"bytes":entry.metadata()?.len()}));
            }
        }
        items.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
        Ok(items)
    })
    .await
    .map_err(anyhow::Error::from)??;
    Ok(Json(json!(items)))
}
pub async fn download(
    State(app): State<App>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Result<Response> {
    auth::admin(&app, &headers).await?;
    if !retention::recovery_name(&name) {
        return Err(bad("Invalid filename"));
    }
    let file = tokio::fs::File::open(app.data.join("backups").join(&name))
        .await
        .map_err(anyhow::Error::from)?;
    let size = file.metadata().await.map_err(anyhow::Error::from)?.len();
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
            (header::CONTENT_LENGTH, size.to_string()),
        ],
        Body::from_stream(ReaderStream::with_capacity(file, BUFFER)),
    )
        .into_response())
}
fn stage(reader: impl Read, root: &Path) -> anyhow::Result<Store> {
    let mut archive = tar::Archive::new(reader);
    let mut seen = std::collections::HashSet::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        anyhow::ensure!(
            path.components().all(|c| matches!(c, Component::Normal(_)))
                && (path == Path::new("state.json")
                    || path == Path::new("config.json")
                    || path.starts_with("receiver")
                    || path.starts_with("vault")),
            "Unsafe archive path"
        );
        anyhow::ensure!(seen.len() < 1_000_000, "Too many archive entries");
        anyhow::ensure!(seen.insert(path.clone()), "Duplicate archive entry");
        let kind = entry.header().entry_type();
        if path == Path::new("state.json") || path == Path::new("config.json") {
            anyhow::ensure!(
                kind.is_file() && entry.size() <= 1024 * 1024,
                "Invalid metadata file"
            );
        }
        anyhow::ensure!(
            kind.is_file() || kind.is_dir(),
            "Archive links and special files are forbidden"
        );
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
    // tar stops at its end marker; consume the remaining encrypted stream to verify
    // its final authentication tag and detect truncation even after all files were read.
    io::copy(&mut archive.into_inner(), &mut io::sink())?;
    let settings: crate::settings::Settings =
        serde_json::from_slice(&std::fs::read(root.join("config.json"))?)?;
    settings.validate()?;
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
async fn text_field(mut field: axum::extract::multipart::Field<'_>) -> Result<String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|_| bad("Invalid restore field"))?
    {
        if bytes.len().saturating_add(chunk.len()) > 8192 {
            return Err(bad("Restore metadata is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| bad("Restore metadata must be UTF-8"))
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
    let serial = app
        .backup_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| bad("Another backup or restore is already running"))?;
    let mut file = None;
    let mut pass = None;
    let mut confirmation = None;
    let mut override_account = None;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|_| bad("Invalid upload"))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                if file.is_some() {
                    return Err(bad("Duplicate backup file"));
                }
                let tmp =
                    tempfile::NamedTempFile::new_in(&app.data).map_err(anyhow::Error::from)?;
                let mut output =
                    tokio::fs::File::from_std(tmp.reopen().map_err(anyhow::Error::from)?);
                while let Some(chunk) = field
                    .chunk()
                    .await
                    .map_err(|_| bad("Backup upload failed"))?
                {
                    output
                        .write_all(&chunk)
                        .await
                        .map_err(anyhow::Error::from)?;
                }
                output.flush().await.map_err(anyhow::Error::from)?;
                output.sync_all().await.map_err(anyhow::Error::from)?;
                drop(output);
                file = Some(tmp);
            }
            "backup_passphrase_confirmation" => {
                if confirmation.is_some() {
                    return Err(bad("Duplicate backup passphrase confirmation"));
                }
                confirmation = Some(text_field(field).await?);
            }
            "passphrase" => {
                if pass.is_some() {
                    return Err(bad("Duplicate passphrase"));
                }
                pass = Some(text_field(field).await?);
            }
            "account" => {
                if override_account.is_some() {
                    return Err(bad("Duplicate account override"));
                }
                override_account = Some(
                    serde_json::from_str::<auth::Account>(&text_field(field).await?)
                        .map_err(|_| bad("Invalid account"))?,
                );
            }
            _ => return Err(bad("Unknown restore field")),
        }
    }
    let upload = file.ok_or_else(|| bad("Choose a backup file"))?;
    crate::recovery::confirm(&app, confirmation.as_deref())?;
    let pass = pass.ok_or_else(|| bad("Provide the original backup passphrase"))?;
    let data = app.data.clone();
    let (temp, mut s, _serial) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let reader = BufReader::with_capacity(BUFFER, std::fs::File::open(upload.path())?);
        let reader = backup_format::decrypt(reader, &pass)?;
        let temp = tempfile::tempdir_in(data)?;
        let s = stage(reader, temp.path())?;
        Ok((temp, s, serial))
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
    let settings = crate::settings::Settings::load(temp.path())?;
    // Swap staged data and configuration before the state commit; roll back all swaps on failure.
    let mut moved = Vec::new();
    let committed = (|| -> anyhow::Result<()> {
        for name in ["receiver", "vault", "config.json"] {
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
    app.settings.send_replace(settings);
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn destination_probe_cleans_up_and_rejects_unavailable_directory() {
        let temp = tempfile::tempdir().unwrap();
        let existing = temp.path().join("existing.tcb");
        std::fs::write(&existing, b"existing recovery file").unwrap();
        probe_directory(temp.path()).unwrap();
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        assert_eq!(std::fs::read(existing).unwrap(), b"existing recovery file");
        let missing = temp.path().join("not-mounted");
        assert!(probe_directory(&missing).is_err());
        assert!(!missing.exists());
    }
    #[test]
    fn stage_verifies_reader_after_tar_end_marker() {
        struct AuthenticationFailure;
        impl Read for AuthenticationFailure {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("final authentication failed"))
            }
        }
        let bytes = tar::Builder::new(Vec::new()).into_inner().unwrap();
        let reader = io::Cursor::new(bytes).chain(AuthenticationFailure);
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(
            stage(reader, temp.path()).err().unwrap().to_string(),
            "final authentication failed"
        );
    }
    #[test]
    fn archive_rejects_symlinks() {
        let mut tar = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_size(0);
        h.set_mode(0o777);
        h.set_link_name("/etc/passwd").unwrap();
        h.set_cksum();
        tar.append_data(&mut h, "receiver/link", io::empty())
            .unwrap();
        let bytes = tar.into_inner().unwrap();
        let temp = tempfile::tempdir().unwrap();
        assert!(stage(bytes.as_slice(), temp.path()).is_err());
    }
}
