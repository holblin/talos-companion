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
pub fn hash_password(password: &str) -> Result<String> {
    if password.len() < 12 || password.len() > 256 {
        return Err(bad("Passwords must contain 12–256 characters"));
    }
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|p| p.to_string())
        .map_err(|_| bad("Unable to hash password"))
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
}
pub struct Session {
    pub user_id: String,
    pub expires: u64,
}
pub struct Code {
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
    pub store: Arc<RwLock<Option<Store>>>,
    pub memory: Arc<Mutex<Memory>>,
    pub io: Arc<RwLock<()>>,
    pub backup_lock: Arc<Mutex<()>>,
    pub settings: tokio::sync::watch::Sender<crate::settings::Settings>,
    pub data: PathBuf,
    pub public_url: String,
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
        let store = match std::fs::read(data.join("state.json")) {
            Ok(b) => Some(serde_json::from_slice::<Store>(&b)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let public_url = std::env::var("PUBLIC_URL")
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
        let setup_token = std::env::var("SETUP_TOKEN").unwrap_or_default();
        anyhow::ensure!(
            setup_token.len() >= 24,
            "Set SETUP_TOKEN to a random value with at least 24 characters"
        );
        let backup_passphrase = std::env::var("BACKUP_PASSPHRASE").unwrap_or_default();
        anyhow::ensure!(
            backup_passphrase.len() >= 16,
            "Set BACKUP_PASSPHRASE to at least 16 characters; keep it separately for recovery"
        );
        Ok(Self {
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
            public_url,
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
