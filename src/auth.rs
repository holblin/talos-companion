use crate::model::*;
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use rsa::pkcs8::EncodePrivateKey;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

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
    json!({"id":u.id,"email":u.email,"name":u.name,"admin":u.admin,
        "created_by":u.created_by,"created_at":u.created_at,"last_login_at":u.last_login_at,
        "avatar_url":format!("https://www.gravatar.com/avatar/{:x}?d=identicon&s=96", Sha256::digest(u.email.trim().to_lowercase().as_bytes()))})
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
        created_by: None,
        created_at: Some(now()),
        last_login_at: None,
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
        && (matches!(settings.schedule.destination.as_str(), "drive" | "network")
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
        network: None,
        integration: Default::default(),
        omni_bootstrap: None,
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
    {
        let mut m = app.memory.lock().await;
        m.attempts.retain(|t| *t + 60 > now());
        if m.attempts.len() >= 20 {
            return Err(Error(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many attempts; try again in a minute".into(),
            ));
        }
        m.attempts.push(now());
    }
    let u = app
        .store
        .read()
        .await
        .as_ref()
        .and_then(|s| {
            s.users
                .iter()
                .find(|u| u.email == input.email.trim().to_lowercase())
        })
        .cloned();
    // Always perform Argon2 work, including for unknown accounts.
    let hash = u
        .as_ref()
        .map(|u| u.password_hash.clone())
        .unwrap_or(hash_password("dummy-password-value")?);
    let valid = tokio::task::spawn_blocking(move || verify_password(&input.password, &hash))
        .await
        .map_err(anyhow::Error::from)?;
    let u = u
        .filter(|_| valid)
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "Invalid email or password".into()))?;
    // A recovery/password change may complete while Argon2 is running. Hold the
    // current store through session creation so an old password cannot create a
    // fresh session after recovery has revoked existing sessions.
    let mut guard = app.store.write().await;
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
    let mut updated = guard.clone().ok_or_else(denied)?;
    let current = updated
        .users
        .iter_mut()
        .find(|current| current.id == u.id)
        .ok_or_else(denied)?;
    current.last_login_at = Some(now());
    let u = current.clone();
    app.persist(&updated)?;
    *guard = Some(updated);
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
    let actor = admin(&app, &headers).await?;
    let mut u = make_user(input)?;
    u.created_by = Some(actor.name);
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
#[derive(Deserialize)]
pub struct AccountUpdate {
    pub email: String,
    pub name: String,
    pub admin: bool,
}
pub async fn update(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(input): Json<AccountUpdate>,
) -> Result<Json<Value>> {
    csrf(&app, &headers)?;
    let actor = admin(&app, &headers).await?;
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
    let mut guard = app.store.write().await;
    let mut s = guard.clone().ok_or_else(denied)?;
    // Recheck the actor under the write lock so a concurrent demotion cannot authorize this change.
    if !s.users.iter().any(|u| u.id == actor.id && u.admin) {
        return Err(denied());
    }
    let index = s
        .users
        .iter()
        .position(|u| u.id == id)
        .ok_or_else(|| bad("Account not found"))?;
    if s.users.iter().any(|u| u.id != id && u.email == email) {
        return Err(bad("Email already exists"));
    }
    if s.users[index].admin && !input.admin && s.users.iter().filter(|u| u.admin).count() == 1 {
        return Err(bad(
            "The last administrator cannot lose administrator access",
        ));
    }
    s.users[index].name = input.name.trim().into();
    s.users[index].email = email;
    s.users[index].admin = input.admin;
    let result = public(&s.users[index]);
    app.persist(&s)?;
    *guard = Some(s);
    Ok(Json(result))
}
pub async fn remove(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    csrf(&app, &headers)?;
    let actor = admin(&app, &headers).await?;
    let mut guard = app.store.write().await;
    let mut s = guard.clone().ok_or_else(denied)?;
    if !s.users.iter().any(|u| u.id == actor.id && u.admin) {
        return Err(denied());
    }
    let target = s
        .users
        .iter()
        .find(|u| u.id == id)
        .ok_or_else(|| bad("Account not found"))?;
    if target.admin && s.users.iter().filter(|u| u.admin).count() == 1 {
        return Err(bad("The last administrator cannot be deleted"));
    }
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
    if !verify_password(&input.current, &actor.password_hash) {
        return Err(bad("Current password is incorrect"));
    }
    let hash = hash_password(&input.password)?;
    let mut guard = app.store.write().await;
    let mut s = guard.clone().ok_or_else(denied)?;
    let u = s
        .users
        .iter_mut()
        .find(|u| u.id == actor.id)
        .ok_or_else(denied)?;
    u.password_hash = hash;
    app.persist(&s)?;
    *guard = Some(s);
    let mut m = app.memory.lock().await;
    m.sessions.retain(|_, s| s.user_id != actor.id);
    m.codes.retain(|_, s| s.user_id != actor.id);
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod account_metadata_tests {
    use super::*;

    #[test]
    fn legacy_accounts_keep_unknown_history_and_public_profiles_never_expose_passwords() {
        let account: User = serde_json::from_value(json!({
            "id": "legacy", "email": "Admin@Example.com", "name": "Admin",
            "password_hash": "private-hash", "admin": true
        }))
        .unwrap();
        assert_eq!(account.created_at, None);
        assert_eq!(account.last_login_at, None);
        let profile = public(&account);
        assert_eq!(profile["created_by"], Value::Null);
        assert!(profile.get("password_hash").is_none());
        assert_eq!(
            profile["avatar_url"],
            format!(
                "https://www.gravatar.com/avatar/{:x}?d=identicon&s=96",
                Sha256::digest(b"admin@example.com")
            )
        );
    }
}
