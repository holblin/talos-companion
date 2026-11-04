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
        && origin.to_str().ok() != Some(app.public_url.as_str())
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
        json!({"public_url":app.public_url,"mounted":app.mounted.as_ref().map(|p|p.to_string_lossy()),"settings":app.settings.borrow().clone(),"backup_passphrase":app.backup_passphrase}),
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
    let secure = if app.public_url.starts_with("https:") {
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
