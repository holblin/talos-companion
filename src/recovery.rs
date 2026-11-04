//! An optional age-encrypted recovery copy of the backup passphrase.
//! Only public recipients reach this server; private keys stay with the owner.
use crate::{auth, model::*};
use axum::{Json, extract::State, http::HeaderMap};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::Write;
use subtle::ConstantTimeEq;

pub async fn reset_admin(app: &App) -> anyhow::Result<()> {
    let mut guard = app.store.write().await;
    let mut store = guard.clone().ok_or_else(|| {
        anyhow::anyhow!("Complete first-run setup before recovering an administrator")
    })?;
    let user = store
        .users
        .iter_mut()
        .find(|u| u.admin)
        .ok_or_else(|| anyhow::anyhow!("No administrator exists"))?;
    let password = secret();
    user.password_hash = hash_password(&password)
        .map_err(|_| anyhow::anyhow!("Could not hash recovery password"))?;
    let email = user.email.clone();
    app.persist(&store)
        .map_err(|_| anyhow::anyhow!("Could not persist recovered administrator"))?;
    *guard = Some(store);
    // Explicit owner-only offline command output. Never emitted by a normal server start.
    println!(
        "Administrator recovered: {email}\nNew temporary password: {password}\nSign in after starting Companion normally, then change this password. Keep this command's output private."
    );
    Ok(())
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
        app.public_url, app.backup_passphrase
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
