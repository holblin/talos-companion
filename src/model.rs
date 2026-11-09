use argon2::{
    Argon2, PasswordHasher, PasswordVerifier,
    password_hash::{PasswordHash, SaltString},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, RwLock};

pub type Result<T> = std::result::Result<T, Error>;
pub struct Error(pub StatusCode, pub String);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, "operation failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Operation failed; check server logs".into(),
        )
    }
}
pub fn bad(message: &str) -> Error {
    Error(StatusCode::BAD_REQUEST, message.into())
}
pub fn denied() -> Error {
    Error(StatusCode::UNAUTHORIZED, "Sign in required".into())
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
pub fn secret() -> String {
    let mut b = [0; 32];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}
fn stored_secret(
    data: &std::path::Path,
    filename: &str,
    initialized: bool,
) -> anyhow::Result<(String, bool)> {
    let path = data.join(filename);
    match std::fs::read_to_string(&path) {
        Ok(value) => Ok((value, false)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !initialized => {
            use std::io::Write;
            let value = secret();
            let mut tmp = tempfile::NamedTempFile::new_in(data)?;
            tmp.write_all(value.as_bytes())?;
            tmp.as_file().sync_all()?;
            match tmp.persist_noclobber(&path) {
                Ok(_) => Ok((value, true)),
                Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    Ok((std::fs::read_to_string(path)?, false))
                }
                Err(e) => Err(e.into()),
            }
        }
        Err(e) => Err(anyhow::anyhow!(
            "Cannot load {filename}: {e}. Supply the original startup secret or restore its private file; initialized instances never generate a replacement silently."
        )),
    }
}
pub fn hash_password(password: &str) -> Result<String> {
    if password.len() < 12 || password.len() > 256 {
        return Err(bad("Passwords must contain 12–256 characters"));
    }
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|p| p.to_string())
        .map_err(|_| bad("Unable to hash password"))
}
#[cfg(test)]
mod secret_tests {
    use super::*;
    #[test]
    fn generated_secrets_are_persistent_private_and_never_replaced_silently() {
        let dir = tempfile::tempdir().unwrap();
        let (original, generated) = stored_secret(dir.path(), "backup-passphrase", false).unwrap();
        assert!(generated);
        assert_eq!(original.len(), 64);
        let (reloaded, generated) = stored_secret(dir.path(), "backup-passphrase", true).unwrap();
        assert!(!generated);
        assert_eq!(original, reloaded);
        assert!(stored_secret(dir.path(), "missing", true).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(dir.path().join("backup-passphrase"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| {
        Argon2::default()
            .verify_password(password.as_bytes(), &h)
            .is_ok()
    })
}

#[derive(Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub email: String,
    pub name: String,
    pub password_hash: String,
    #[serde(default)]
    pub created_by: Option<String>,
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub last_login_at: Option<u64>,
    pub admin: bool,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Drive {
    pub client_id: String,
    pub client_secret: String,
    pub folder_id: String,
    pub refresh_token: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Store {
    pub version: u32,
    pub users: Vec<User>,
    pub signing_key: String,
    pub client_id: String,
    pub client_secret: String,
    pub redirect_uri: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub drive: Drive,
    #[serde(default)]
    pub network: Option<crate::network_backup::Config>,
    #[serde(default)]
    pub integration: crate::omni::Integration,
}
pub struct Session {
    pub user_id: String,
    pub expires: u64,
}
pub struct Code {
    pub issuer: String,
    pub user_id: String,
    pub redirect_uri: String,
    pub nonce: Option<String>,
    pub challenge: Option<String>,
    pub expires: u64,
}
pub struct Memory {
    pub sessions: HashMap<String, Session>,
    pub codes: HashMap<String, Code>,
    pub drive_states: HashMap<String, (String, u64)>,
    pub attempts: Vec<u64>,
}
#[derive(Clone)]
pub struct App {
    pub _process_lock: Arc<std::fs::File>,
    pub store: Arc<RwLock<Option<Store>>>,
    pub memory: Arc<Mutex<Memory>>,
    pub io: Arc<RwLock<()>>,
    pub backup_lock: Arc<Mutex<()>>,
    pub settings: tokio::sync::watch::Sender<crate::settings::Settings>,
    pub data: PathBuf,
    pub public_url: String,
    pub issuer: tokio::sync::watch::Sender<String>,
    pub setup_token: String,
    pub backup_passphrase: String,
    pub mounted: Option<PathBuf>,
    pub http: reqwest::Client,
}
impl App {
    pub async fn load() -> anyhow::Result<Self> {
        let data = PathBuf::from(std::env::var("DATA_DIR").unwrap_or("data".into()));
        std::fs::create_dir_all(data.join("receiver"))?;
        std::fs::create_dir_all(data.join("backups"))?;
        std::fs::create_dir_all(data.join("vault"))?;
        let process_lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(data.join(".instance.lock"))?;
        process_lock.try_lock().map_err(|_| anyhow::anyhow!("This data directory is already in use. Stop Companion before running offline recovery."))?;
        let store = match std::fs::read(data.join("state.json")) {
            Ok(b) => Some(serde_json::from_slice::<Store>(&b)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let public_url = store
            .as_ref()
            .map(|s| s.integration.companion_url.clone())
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("PUBLIC_URL").ok())
            .unwrap_or("http://localhost:8080".into())
            .trim_end_matches('/')
            .to_owned();
        let url = url::Url::parse(&public_url)?;
        anyhow::ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && url.username().is_empty(),
            "PUBLIC_URL must be an HTTP(S) origin"
        );
        let (setup_token, generated_setup) =
            match std::env::var("SETUP_TOKEN").ok().filter(|v| !v.is_empty()) {
                Some(value) => (value, false),
                None => stored_secret(&data, "setup-token", store.is_some())?,
            };
        anyhow::ensure!(
            setup_token.len() >= 24,
            "Set SETUP_TOKEN to a random value with at least 24 characters"
        );
        let (backup_passphrase, _) = match std::env::var("BACKUP_PASSPHRASE")
            .ok()
            .filter(|v| !v.is_empty())
        {
            Some(value) => (value, false),
            None => stored_secret(&data, "backup-passphrase", store.is_some())?,
        };
        anyhow::ensure!(
            backup_passphrase.len() >= 16,
            "Set BACKUP_PASSPHRASE to at least 16 characters; keep it separately for recovery"
        );
        if generated_setup {
            tracing::info!("First-launch setup token (keep private): {setup_token}");
            tracing::info!(
                "Backup passphrase generated and stored privately; save it from the setup wizard before creating backups"
            );
        }
        Ok(Self {
            _process_lock: Arc::new(process_lock),
            store: Arc::new(RwLock::new(store)),
            memory: Arc::new(Mutex::new(Memory {
                sessions: HashMap::new(),
                codes: HashMap::new(),
                drive_states: HashMap::new(),
                attempts: Vec::new(),
            })),
            io: Arc::new(RwLock::new(())),
            backup_lock: Arc::new(Mutex::new(())),
            settings: tokio::sync::watch::channel(crate::settings::Settings::load(&data)?).0,
            data,
            issuer: tokio::sync::watch::channel(public_url.clone()).0,
            public_url: std::env::var("PUBLIC_URL")
                .unwrap_or(public_url)
                .trim_end_matches('/')
                .to_owned(),
            setup_token,
            backup_passphrase,
            mounted: std::env::var("MOUNTED_BACKUP_DIR")
                .ok()
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }
    pub fn issuer(&self) -> String {
        self.issuer.borrow().clone()
    }
    pub fn persist(&self, store: &Store) -> anyhow::Result<()> {
        // Persist first, then publish the new state in memory. Tempfile gives atomic replacement on Windows and Unix.
        use std::io::Write;
        let mut tmp = tempfile::NamedTempFile::new_in(&self.data)?;
        tmp.write_all(&serde_json::to_vec_pretty(store)?)?;
        tmp.as_file().sync_all()?;
        tmp.persist(self.data.join("state.json"))?;
        Ok(())
    }
}
