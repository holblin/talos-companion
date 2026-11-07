//! An optional age-encrypted recovery copy of the backup passphrase.
//! Only public recipients reach this server; private keys stay with the owner.
use crate::{auth, model::*};
use axum::{Json, extract::State, http::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
use subtle::ConstantTimeEq;

#[derive(Serialize, Deserialize)]
struct PasswordRecovery {
    user_id: String,
    credential_digest: String,
    code_digest: String,
    expires: u64,
    attempts: u8,
    #[serde(default)]
    logged: bool,
}
fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}
fn recovery_lock(data: &Path) -> anyhow::Result<std::fs::File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(data.join(".password-recovery.lock"))?;
    file.try_lock().map_err(|_| {
        anyhow::anyhow!("Another password recovery operation is in progress; retry shortly")
    })?;
    Ok(file)
}
fn save_recovery(data: &Path, recovery: &PasswordRecovery) -> anyhow::Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(data)?;
    file.write_all(&serde_json::to_vec(recovery)?)?;
    file.as_file().sync_all()?;
    file.persist(data.join("password-recovery.json"))?;
    Ok(())
}
fn issue_password_recovery(
    data: &Path,
    user: &User,
    logged: bool,
) -> anyhow::Result<(String, u64)> {
    let code = secret();
    let expires = now() + 900;
    save_recovery(
        data,
        &PasswordRecovery {
            user_id: user.id.clone(),
            credential_digest: digest(&user.password_hash),
            code_digest: digest(&code),
            expires,
            attempts: 0,
            logged,
        },
    )?;
    Ok((code, expires))
}

/// The browser can request delivery to owner-controlled logs, never to the response.
/// Repeated requests reuse the current window, including across server restarts.
pub async fn request_password_recovery(
    State(app): State<App>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    let guard = app.store.read().await;
    let user = guard
        .as_ref()
        .and_then(|store| store.users.iter().find(|u| u.admin))
        .ok_or_else(|| bad("Finish first-run setup before recovering an administrator"))?;
    let _lock = recovery_lock(&app.data)?;
    let previous = match std::fs::read(app.data.join("password-recovery.json")) {
        Ok(bytes) => {
            Some(serde_json::from_slice::<PasswordRecovery>(&bytes).map_err(anyhow::Error::from)?)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(anyhow::Error::from(error).into()),
    };
    if let Some(previous) = previous
        && previous.logged
        && previous.expires > now()
        && previous.user_id == user.id
        && previous.credential_digest == digest(&user.password_hash)
    {
        if previous.attempts >= 5 {
            return Err(crate::model::Error(axum::http::StatusCode::TOO_MANY_REQUESTS,
                "Recovery verification limit reached. Wait for the current 15-minute window to expire, then request a new code.".into()));
        }
        return Ok(Json(json!({"expires_at":previous.expires})));
    }
    let (code, expires) = issue_password_recovery(&app.data, user, true)?;
    // Intentional owner-requested delivery. Do not return the code over HTTP or
    // log it on startup, retries, validation failures or successful consumption.
    println!(
        "Password recovery code: {code} | expires_unix={expires} | single use; valid for 15 minutes from issue. Anyone with this code and the administrator email can reset the password. Keep this log private."
    );
    Ok(Json(json!({"expires_at":expires})))
}
/// Owner-only CLI: works while the server runs and never changes a password.
pub fn generate_password_recovery() -> anyhow::Result<()> {
    let data = std::path::PathBuf::from(std::env::var("DATA_DIR").unwrap_or("data".into()));
    let _lock = recovery_lock(&data)?;
    let store: Store = serde_json::from_slice(&std::fs::read(data.join("state.json"))?)?;
    let user = store
        .users
        .iter()
        .find(|u| u.admin)
        .ok_or_else(|| anyhow::anyhow!("No administrator exists"))?;
    let (code, _) = issue_password_recovery(&data, user, false)?;
    println!(
        "Password recovery code: {code}\nValid for 15 minutes and one successful reset. Open Forgot the administrator password? on the sign-in page and enter this code with your new password. Your current password is unchanged. Keep this output private. Generating another code invalidates this one."
    );
    Ok(())
}

#[derive(Deserialize)]
pub struct RecoverPassword {
    email: String,
    code: String,
    password: String,
    confirmation: String,
}
pub async fn recover_password(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<RecoverPassword>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    let invalid = || {
        crate::model::Error(
            axum::http::StatusCode::UNAUTHORIZED,
            "Invalid, expired or already used recovery code".into(),
        )
    };
    let mut guard = app.store.write().await;
    let mut store = guard.clone().ok_or_else(invalid)?;
    let _lock = recovery_lock(&app.data)?;
    let bytes = std::fs::read(app.data.join("password-recovery.json")).map_err(|_| invalid())?;
    let mut recovery: PasswordRecovery = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if recovery.expires <= now() || recovery.attempts >= 5 {
        return Err(invalid());
    }
    let user = store
        .users
        .iter_mut()
        .find(|u| u.id == recovery.user_id && u.admin)
        .ok_or_else(invalid)?;
    let valid = input.code.trim().len() == 64
        && bool::from(
            digest(input.code.trim())
                .as_bytes()
                .ct_eq(recovery.code_digest.as_bytes()),
        )
        && bool::from(
            digest(&user.password_hash)
                .as_bytes()
                .ct_eq(recovery.credential_digest.as_bytes()),
        )
        && user.email == input.email.trim().to_lowercase();
    if !valid {
        recovery.attempts += 1;
        save_recovery(&app.data, &recovery)?;
        return Err(invalid());
    }
    if input.password != input.confirmation {
        return Err(bad("New password confirmation does not match"));
    }
    user.password_hash = hash_password(&input.password)?;
    let id = user.id.clone();
    app.persist(&store)?;
    *guard = Some(store);
    // A changed password digest invalidates the code even if cleanup fails.
    if std::fs::remove_file(app.data.join("password-recovery.json")).is_err() {
        tracing::warn!("Could not remove invalidated password recovery record");
    }
    let mut memory = app.memory.lock().await;
    memory.sessions.retain(|_, session| session.user_id != id);
    memory.codes.retain(|_, code| code.user_id != id);
    Ok(Json(json!({"ok":true})))
}

pub fn confirm(app: &App, supplied: Option<&str>) -> Result<()> {
    if !supplied.is_some_and(|s| bool::from(s.as_bytes().ct_eq(app.backup_passphrase.as_bytes()))) {
        return Err(bad(
            "Backup passphrase confirmation does not match. Uncheck the saved-passphrase box to see it again.",
        ));
    }
    Ok(())
}
async fn authorize(app: &App, headers: &HeaderMap) -> Result<()> {
    auth::setup_auth(app, headers)?;
    if app.store.read().await.is_some() {
        return Err(bad(
            "Recovery setup is available only before initialization",
        ));
    }
    Ok(())
}
fn recipient(line: &str) -> anyhow::Result<Box<dyn age::Recipient>> {
    if line.starts_with("age1") {
        Ok(Box::new(
            line.parse::<age::x25519::Recipient>()
                .map_err(|_| anyhow::anyhow!("Invalid age public key"))?,
        ))
    } else if line.starts_with("ssh-ed25519 ") || line.starts_with("ssh-rsa ") {
        Ok(Box::new(line.parse::<age::ssh::Recipient>().map_err(
            |_| anyhow::anyhow!("Invalid or unsupported SSH public key"),
        )?))
    } else {
        anyhow::bail!(
            "Use age1, ssh-ed25519, or ssh-rsa public keys. Private keys and hardware-backed SSH keys are not accepted."
        )
    }
}
fn encrypt_copy(recipients: &str, plaintext: &[u8]) -> anyhow::Result<String> {
    anyhow::ensure!(
        recipients.len() <= 32 * 1024,
        "Public key list is too large"
    );
    let lines: Vec<_> = recipients
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    anyhow::ensure!(
        !lines.is_empty() && lines.len() <= 20,
        "Provide between one and twenty public keys"
    );
    let recipients: Vec<_> = lines
        .into_iter()
        .map(recipient)
        .collect::<anyhow::Result<_>>()?;
    let output =
        age::armor::ArmoredWriter::wrap_output(Vec::new(), age::armor::Format::AsciiArmor)?;
    let mut encrypted = age::Encryptor::with_recipients(recipients.iter().map(|r| r.as_ref()))?
        .wrap_output(output)?;
    encrypted.write_all(plaintext)?;
    Ok(String::from_utf8(encrypted.finish()?.finish()?)?)
}
#[derive(Deserialize)]
pub struct Recipients {
    pub recipients: String,
}
pub async fn download(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Recipients>,
) -> Result<Json<Value>> {
    authorize(&app, &headers).await?;
    let contents = format!(
        "Talos Companion backup recovery passphrase\n\nServer: {}\nBackup passphrase: {}\n\nUse this passphrase to restore .tcb recovery files created by this installation.\nKeep this file and the private key outside the server. It is not an account password or setup token.\n",
        app.issuer(),
        app.backup_passphrase
    );
    let encrypted =
        encrypt_copy(&input.recipients, contents.as_bytes()).map_err(|e| bad(&e.to_string()))?;
    Ok(Json(
        json!({"file_name":"talos-companion-recovery.txt.age","encrypted_file":encrypted}),
    ))
}
#[derive(Deserialize)]
pub struct Github {
    pub username: String,
}
pub async fn github(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Github>,
) -> Result<Json<Value>> {
    authorize(&app, &headers).await?;
    let username = input.username.trim();
    if username.is_empty()
        || username.len() > 39
        || !username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || username.starts_with('-')
        || username.ends_with('-')
    {
        return Err(bad("Enter a GitHub username, not a URL"));
    }
    let mut response = app
        .http
        .get(format!("https://github.com/{username}.keys"))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| bad("Could not load GitHub public keys"))?;
    if !response.status().is_success() {
        return Err(bad("GitHub public keys were not found"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| bad("Could not read GitHub public keys"))?
    {
        if bytes.len().saturating_add(chunk.len()) > 32 * 1024 {
            return Err(bad(
                "GitHub key list is too large; paste selected public keys instead",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(bytes).map_err(|_| bad("Invalid GitHub public key response"))?;
    let keys: Vec<_> = text
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let accepted: Vec<_> = keys
        .iter()
        .copied()
        .filter(|s| recipient(s).is_ok())
        .take(20)
        .collect();
    if accepted.is_empty() {
        return Err(bad(
            "This GitHub account has no supported encryption keys. Paste an age1, ssh-ed25519, or ssh-rsa public key instead.",
        ));
    }
    Ok(Json(
        json!({"recipients":accepted.join("\n"),"omitted":keys.len()-accepted.len()}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};
    #[test]
    fn recovery_copy_requires_the_corresponding_private_key() {
        let identity = age::x25519::Identity::generate();
        let encrypted =
            encrypt_copy(&identity.to_public().to_string(), b"a recovery passphrase").unwrap();
        assert!(!encrypted.contains("a recovery passphrase"));
        let reader = age::armor::ArmoredReader::new(Cursor::new(encrypted.clone()));
        let mut plaintext = String::new();
        age::Decryptor::new(reader)
            .unwrap()
            .decrypt(std::iter::once(&identity as &dyn age::Identity))
            .unwrap()
            .read_to_string(&mut plaintext)
            .unwrap();
        assert_eq!(plaintext, "a recovery passphrase");
        let wrong = age::x25519::Identity::generate();
        let reader = age::armor::ArmoredReader::new(Cursor::new(encrypted));
        assert!(
            age::Decryptor::new(reader)
                .unwrap()
                .decrypt(std::iter::once(&wrong as &dyn age::Identity))
                .is_err()
        );
        assert!(encrypt_copy("AGE-SECRET-KEY-private", b"secret").is_err());
        assert!(encrypt_copy("", b"secret").is_err());
    }
}
