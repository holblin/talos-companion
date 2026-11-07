use crate::model::*;
use axum::{
    Json,
    extract::{Path, Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use rsa::pkcs8::EncodePrivateKey;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashMap, net::SocketAddr, sync::LazyLock};
use subtle::ConstantTimeEq;

// Fixed windows are not extended by rejected requests. Entries are bounded and
// expire, including for made-up accounts and rotating client addresses.
#[derive(Default)]
pub struct Throttle {
    windows: HashMap<String, (u64, usize)>,
}
impl Throttle {
    fn check(&mut self, key: String, limit: usize, seconds: u64, time: u64) -> Result<()> {
        self.windows.retain(|_, (until, _)| *until > time);
        if self.windows.len() >= 4096 && !self.windows.contains_key(&key) {
            return Err(limited());
        }
        let window = self.windows.entry(key).or_insert((time + seconds, 0));
        if window.1 >= limit {
            return Err(limited());
        }
        window.1 += 1;
        Ok(())
    }
}
fn limited() -> Error {
    Error(
        StatusCode::TOO_MANY_REQUESTS,
        "Too many authentication attempts; try again later".into(),
    )
}

/// API access is denied by default, before body parsing or handler side effects.
/// Only bootstrap, authentication and read-only protocol probes are exempt.
pub async fn guard(State(app): State<App>, req: Request, next: Next) -> Result<Response> {
    let path = req.uri().path();
    let credentials = matches!(
        path,
        "/api/login"
            | "/api/password"
            | "/api/password/recover"
            | "/api/password/recovery-code"
            | "/oauth/token"
            | "/api/setup"
            | "/api/setup/check"
            | "/api/setup/recovery-key"
            | "/api/setup/github-keys"
            | "/api/restore"
    );
    if credentials {
        // Use the socket peer only. Forwarded headers are client-controlled
        // unless a separately configured trusted proxy validates them.
        let peer = req
            .extensions()
            .get::<SocketAddr>()
            .map_or_else(|| "unknown".into(), |peer| peer.ip().to_string());
        let mut memory = app.memory.lock().await;
        memory.throttle.check("global".into(), 60, 60, now())?;
        memory
            .throttle
            .check(format!("peer:{peer}"), 30, 900, now())?;
    }
    if matches!(
        path,
        "/api/setup"
            | "/api/setup/check"
            | "/api/setup/recovery-key"
            | "/api/setup/github-keys"
            | "/api/restore"
    ) {
        setup_auth(&app, req.headers())?;
    } else if path.starts_with("/api/")
        && !matches!(
            path,
            "/api/status"
                | "/api/login"
                | "/api/password/recover"
                | "/api/password/recovery-code"
                | "/api/omni/identity"
        )
    {
        user(&app, req.headers()).await?;
        if !matches!(
            *req.method(),
            axum::http::Method::GET | axum::http::Method::HEAD
        ) {
            csrf(&app, req.headers())?;
        }
    }
    Ok(next.run(req).await)
}

// A single reusable dummy hash gives unknown accounts the same verification
// work as known accounts, without hashing a second password on every request.
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| {
    hash_password(&secret()).unwrap_or_else(|_| unreachable!("valid dummy password"))
});
static PASSWORD_WORK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

pub async fn user(app: &App, headers: &HeaderMap) -> Result<User> {
    let token = headers
        .get(header::COOKIE)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| {
            s.split(';')
                .map(str::trim)
                .find_map(|s| s.strip_prefix("tc_session="))
        })
        .ok_or_else(denied)?;
    let mut memory = app.memory.lock().await;
    memory.sessions.retain(|_, s| s.expires > now());
    let id = memory
        .sessions
        .get(token)
        .ok_or_else(denied)?
        .user_id
        .clone();
    drop(memory);
    app.store
        .read()
        .await
        .as_ref()
        .and_then(|s| s.users.iter().find(|u| u.id == id))
        .cloned()
        .ok_or_else(denied)
}
pub async fn admin(app: &App, headers: &HeaderMap) -> Result<User> {
    let u = user(app, headers).await?;
    if !u.admin {
        return Err(Error(
            StatusCode::FORBIDDEN,
            "Administrator access required".into(),
        ));
    }
    Ok(u)
}
pub fn csrf(app: &App, headers: &HeaderMap) -> Result<()> {
    if headers
        .get("x-requested-with")
        .and_then(|v| v.to_str().ok())
        != Some("talos-companion")
    {
        return Err(bad("Missing request header"));
    }
    if let Some(origin) = headers.get("origin")
        && origin.to_str().ok() != Some(app.issuer().as_str())
        && origin.to_str().ok() != Some(app.public_url.as_str())
        && !crate::connections::settings()
            .accesses
            .iter()
            .any(|access| {
                access.verified_at > 0
                    && origin.to_str().ok() == Some(access.integration.companion_url.as_str())
            })
        && !crate::connections::settings()
            .integration
            .is_some_and(|i| origin.to_str().ok() == Some(i.companion_url.as_str()))
    {
        return Err(bad("Origin does not match PUBLIC_URL"));
    }
    Ok(())
}
pub fn setup_auth(app: &App, headers: &HeaderMap) -> Result<()> {
    csrf(app, headers)?;
    let supplied = headers
        .get("x-setup-token")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !bool::from(supplied.as_bytes().ct_eq(app.setup_token.as_bytes())) {
        return Err(Error(StatusCode::FORBIDDEN, "Invalid setup token".into()));
    }
    Ok(())
}
pub fn public(u: &User) -> Value {
    json!({"id":u.id,"email":u.email,"name":u.name,"admin":u.admin})
}
#[derive(Deserialize)]
pub struct Account {
    pub email: String,
    pub name: String,
    pub password: String,
    #[serde(default)]
    pub admin: bool,
}
pub fn make_user(input: Account) -> Result<User> {
    let email = input.email.trim().to_lowercase();
    if !email.contains('@')
        || email.len() > 254
        || input.name.trim().is_empty()
        || input.name.len() > 100
    {
        return Err(bad(
            "Provide a valid email and a name of up to 100 characters",
        ));
    }
    Ok(User {
        id: uuid::Uuid::new_v4().to_string(),
        email,
        name: input.name.trim().into(),
        password_hash: hash_password(&input.password)?,
        admin: input.admin,
    })
}
pub async fn status(State(app): State<App>) -> Json<Value> {
    Json(json!({"initialized":app.store.read().await.is_some()}))
}
#[derive(Deserialize)]
pub struct Setup {
    #[serde(flatten)]
    pub account: Account,
    pub settings: Option<crate::settings::Settings>,
    pub backup_passphrase_confirmation: Option<String>,
}
pub async fn setup_check(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    setup_auth(&app, &headers)?;
    if app.store.read().await.is_some() {
        return Err(bad("Already initialized"));
    }
    Ok(Json(
        json!({"public_url":app.issuer(),"mounted":app.mounted.as_ref().map(|p|p.to_string_lossy()),"settings":app.settings.borrow().clone(),"backup_passphrase":app.backup_passphrase}),
    ))
}
pub async fn setup(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Setup>,
) -> Result<Json<Value>> {
    setup_auth(&app, &headers)?;
    let _serial = app.backup_lock.lock().await;
    let mut guard = app.store.write().await;
    if guard.is_some() {
        return Err(bad("Already initialized"));
    }
    crate::recovery::confirm(&app, input.backup_passphrase_confirmation.as_deref())?;
    let mut account = input.account;
    account.admin = true;
    let u = make_user(account)?;
    let previous = app.settings.borrow().clone();
    let settings = input.settings.unwrap_or_else(|| previous.clone());
    settings.validate().map_err(|e| bad(&e.to_string()))?;
    if settings.schedule.enabled
        && (settings.schedule.destination == "drive"
            || (settings.schedule.destination == "mounted" && app.mounted.is_none()))
    {
        return Err(bad(
            "Choose an available destination for the initial schedule",
        ));
    }
    let key = rsa::RsaPrivateKey::new(&mut rand::rngs::OsRng, 2048).map_err(anyhow::Error::from)?;
    let store = Store {
        version: 1,
        users: vec![u],
        signing_key: key
            .to_pkcs8_pem(Default::default())
            .map_err(anyhow::Error::from)?
            .to_string(),
        client_id: "omni".into(),
        client_secret: secret(),
        redirect_uri: String::new(),
        s3_access_key: secret(),
        s3_secret_key: secret(),
        drive: Drive::default(),
        integration: Default::default(),
    };
    settings.persist(&app.data)?;
    if let Err(e) = app.persist(&store) {
        previous.persist(&app.data)?;
        return Err(e.into());
    }
    *guard = Some(store);
    app.settings.send_replace(settings);
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct Login {
    pub email: String,
    pub password: String,
}
pub async fn login(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Login>,
) -> Result<Response> {
    csrf(&app, &headers)?;
    let email = input.email.trim().to_lowercase();
    if email.len() > 254 || input.password.len() > 256 {
        return Err(Error(
            StatusCode::UNAUTHORIZED,
            "Invalid email or password".into(),
        ));
    }
    {
        let mut m = app.memory.lock().await;
        m.throttle.check(format!("login:{email}"), 5, 900, now())?;
    }
    let permit = PASSWORD_WORK.try_acquire().map_err(|_| limited())?;
    let u = app
        .store
        .read()
        .await
        .as_ref()
        .and_then(|s| s.users.iter().find(|u| u.email == email))
        .cloned();
    // Always perform Argon2 work, including for unknown accounts.
    let candidate = u.as_ref().map(|u| u.password_hash.clone());
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let hash = candidate.as_deref().unwrap_or_else(|| DUMMY_HASH.as_str());
        verify_password(&input.password, hash)
    })
    .await
    .map_err(anyhow::Error::from)?;
    let u = u
        .filter(|_| valid)
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "Invalid email or password".into()))?;
    // A recovery/password change may complete while Argon2 is running. Hold the
    // current store through session creation so an old password cannot create a
    // fresh session after recovery has revoked existing sessions.
    let guard = app.store.read().await;
    if !guard.as_ref().is_some_and(|store| {
        store
            .users
            .iter()
            .any(|current| current.id == u.id && current.password_hash == u.password_hash)
    }) {
        return Err(Error(
            StatusCode::UNAUTHORIZED,
            "Invalid email or password".into(),
        ));
    }
    let token = secret();
    let mut m = app.memory.lock().await;
    m.sessions.retain(|_, s| s.expires > now());
    m.sessions.insert(
        token.clone(),
        Session {
            user_id: u.id.clone(),
            expires: now() + 28800,
        },
    );
    m.throttle.windows.remove(&format!("login:{email}"));
    drop(m);
    drop(guard);
    let secure = if app.issuer().starts_with("https:")
        || headers
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|origin| origin.starts_with("https://"))
    {
        "; Secure"
    } else {
        ""
    };
    Ok((
        [(
            header::SET_COOKIE,
            format!("tc_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800{secure}"),
        )],
        Json(public(&u)),
    )
        .into_response())
}
pub async fn logout(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    csrf(&app, &headers)?;
    let u = user(&app, &headers).await?;
    app.memory
        .lock()
        .await
        .sessions
        .retain(|_, s| s.user_id != u.id);
    Ok((
        [(
            header::SET_COOKIE,
            "tc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}
pub async fn me(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    Ok(Json(public(&user(&app, &headers).await?)))
}
pub async fn users(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    admin(&app, &headers).await?;
    Ok(Json(json!(
        app.store
            .read()
            .await
            .as_ref()
            .ok_or_else(denied)?
            .users
            .iter()
            .map(public)
            .collect::<Vec<_>>()
    )))
}
pub async fn add(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Account>,
) -> Result<Json<Value>> {
    csrf(&app, &headers)?;
    admin(&app, &headers).await?;
    let u = make_user(input)?;
    let mut guard = app.store.write().await;
    let mut s = guard.clone().ok_or_else(denied)?;
    if s.users.iter().any(|x| x.email == u.email) {
        return Err(bad("Email already exists"));
    }
    s.users.push(u.clone());
    app.persist(&s)?;
    *guard = Some(s);
    Ok(Json(public(&u)))
}
pub async fn remove(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    csrf(&app, &headers)?;
    let actor = admin(&app, &headers).await?;
    if actor.id == id {
        return Err(bad("You cannot remove your own account"));
    }
    let mut guard = app.store.write().await;
    let mut s = guard.clone().ok_or_else(denied)?;
    s.users.retain(|u| u.id != id);
    app.persist(&s)?;
    *guard = Some(s);
    let mut m = app.memory.lock().await;
    m.sessions.retain(|_, s| s.user_id != id);
    m.codes.retain(|_, s| s.user_id != id);
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct Password {
    pub current: String,
    pub password: String,
}
pub async fn password(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Password>,
) -> Result<Json<Value>> {
    csrf(&app, &headers)?;
    let actor = user(&app, &headers).await?;
    app.memory
        .lock()
        .await
        .throttle
        .check(format!("password:{}", actor.id), 5, 900, now())?;
    let permit = PASSWORD_WORK.try_acquire().map_err(|_| limited())?;
    let hash = actor.password_hash.clone();
    let current = input.current;
    let hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if current.len() > 256 || !verify_password(&current, &hash) {
            return Err(bad("Current password is incorrect"));
        }
        hash_password(&input.password)
    })
    .await
    .map_err(anyhow::Error::from)??;
    let mut guard = app.store.write().await;
    let mut s = guard.clone().ok_or_else(denied)?;
    let u = s
        .users
        .iter_mut()
        .find(|u| u.id == actor.id)
        .ok_or_else(denied)?;
    if u.password_hash != actor.password_hash {
        return Err(denied());
    }
    u.password_hash = hash;
    app.persist(&s)?;
    *guard = Some(s);
    let mut m = app.memory.lock().await;
    m.sessions.retain(|_, s| s.user_id != actor.id);
    m.codes.retain(|_, s| s.user_id != actor.id);
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockout_expires_without_being_extended_by_rejections() {
        let mut throttle = Throttle::default();
        for _ in 0..5 {
            assert!(throttle.check("account".into(), 5, 900, 100).is_ok());
        }
        assert_eq!(
            throttle
                .check("account".into(), 5, 900, 101)
                .err()
                .unwrap()
                .0,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert!(throttle.check("other-account".into(), 5, 900, 101).is_ok());
        assert!(throttle.check("account".into(), 5, 900, 999).is_err());
        assert!(throttle.check("account".into(), 5, 900, 1000).is_ok());
    }

    #[test]
    fn rotating_keys_cannot_grow_throttle_memory_without_bound() {
        let mut throttle = Throttle::default();
        for key in 0..4096 {
            assert!(throttle.check(key.to_string(), 5, 900, 0).is_ok());
        }
        assert!(throttle.check("extra".into(), 5, 900, 1).is_err());
        assert_eq!(throttle.windows.len(), 4096);
        assert!(throttle.check("extra".into(), 5, 900, 900).is_ok());
        assert_eq!(throttle.windows.len(), 1);
    }
}
