use crate::{auth, model::*};
use axum::{
    Json,
    extract::{Query, State},
    http::HeaderMap,
    response::Redirect,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
pub struct Configure {
    pub client_id: String,
    pub client_secret: String,
    pub folder_id: String,
}
pub async fn configure(
    State(app): State<App>,
    headers: HeaderMap,
    Json(q): Json<Configure>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    if q.client_id.is_empty() || q.client_secret.is_empty() {
        return Err(bad("Provide a Google OAuth client ID and secret"));
    }
    let mut guard = app.store.write().await;
    let mut s = guard.clone().ok_or_else(denied)?;
    s.drive = Drive {
        client_id: q.client_id,
        client_secret: q.client_secret,
        folder_id: q.folder_id,
        refresh_token: String::new(),
    };
    app.persist(&s)?;
    *guard = Some(s);
    Ok(Json(json!({"ok":true})))
}
pub async fn connect(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    let u = auth::admin(&app, &headers).await?;
    let s = app.store.read().await.clone().ok_or_else(denied)?;
    if s.drive.client_id.is_empty() {
        return Err(bad("Configure Google Drive first"));
    }
    let state = secret();
    let mut m = app.memory.lock().await;
    m.drive_states.retain(|_, (_, exp)| *exp > now());
    m.drive_states.insert(state.clone(), (u.id, now() + 600));
    drop(m);
    let mut url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", s.drive.client_id.as_str()),
        (
            "redirect_uri",
            &format!("{}/oauth/google/callback", app.public_url),
        ),
        ("response_type", "code"),
        ("scope", "https://www.googleapis.com/auth/drive.file"),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("state", state.as_str()),
    ]);
    Ok(Json(json!({"url":url.as_str()})))
}
#[derive(Deserialize)]
pub struct Callback {
    pub code: Option<String>,
    pub state: String,
    pub error: Option<String>,
}
pub async fn callback(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> Result<Redirect> {
    let u = auth::admin(&app, &headers).await?;
    let (id, expires) = app
        .memory
        .lock()
        .await
        .drive_states
        .remove(&q.state)
        .ok_or_else(|| bad("Invalid Google authorization state"))?;
    if u.id != id || expires <= now() {
        return Err(bad("Expired authorization"));
    }
    if q.error.is_some() {
        return Err(bad("Google Drive authorization was declined"));
    }
    let s = app.store.read().await.clone().ok_or_else(denied)?;
    let token: Value = app
        .http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", s.drive.client_id.as_str()),
            ("client_secret", s.drive.client_secret.as_str()),
            (
                "code",
                q.code
                    .as_deref()
                    .ok_or_else(|| bad("Missing authorization code"))?,
            ),
            (
                "redirect_uri",
                &format!("{}/oauth/google/callback", app.public_url),
            ),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(anyhow::Error::from)?
        .error_for_status()
        .map_err(anyhow::Error::from)?
        .json()
        .await
        .map_err(anyhow::Error::from)?;
    let refresh = token["refresh_token"].as_str().ok_or_else(|| {
        bad("Google returned no refresh token; revoke the previous grant and reconnect")
    })?;
    let folder_id = if s.drive.folder_id.is_empty() {
        let access = token["access_token"]
            .as_str()
            .ok_or_else(|| bad("Google returned no access token"))?;
        let folder:Value = app.http.post("https://www.googleapis.com/drive/v3/files")
            .bearer_auth(access).json(&json!({"name":"Talos Companion backups","mimeType":"application/vnd.google-apps.folder"}))
            .send().await.map_err(anyhow::Error::from)?.error_for_status().map_err(anyhow::Error::from)?.json().await.map_err(anyhow::Error::from)?;
        folder["id"]
            .as_str()
            .ok_or_else(|| bad("Google returned no folder ID"))?
            .to_owned()
    } else {
        s.drive.folder_id.clone()
    };
    let mut guard = app.store.write().await;
    let mut updated = guard.clone().ok_or_else(denied)?;
    if updated.drive.client_id != s.drive.client_id
        || updated.drive.client_secret != s.drive.client_secret
    {
        return Err(bad(
            "Drive settings changed during authorization; reconnect",
        ));
    }
    updated.drive.refresh_token = refresh.into();
    updated.drive.folder_id = folder_id;
    app.persist(&updated)?;
    *guard = Some(updated);
    Ok(Redirect::to("/?drive=connected"))
}
pub async fn upload(app: &App, name: &str, bytes: Vec<u8>) -> anyhow::Result<()> {
    let s = app
        .store
        .read()
        .await
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Not initialized"))?;
    let d = s.drive;
    anyhow::ensure!(
        !d.refresh_token.is_empty(),
        "Connect Google Drive before uploading"
    );
    let token: Value = app
        .http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", d.client_id.as_str()),
            ("client_secret", d.client_secret.as_str()),
            ("refresh_token", d.refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let bearer = token["access_token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Google returned no access token"))?;
    // Resumable uploads support files over 5 MB. Use 8 MiB chunks (a multiple of 256 KiB).
    let response = app
        .http
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")
        .bearer_auth(bearer)
        .header("x-upload-content-type", "application/octet-stream")
        .header("x-upload-content-length", bytes.len())
        .json(&json!({"name":name,"parents":[d.folder_id]}))
        .send()
        .await?
        .error_for_status()?;
    let session = url::Url::parse(
        response
            .headers()
            .get("location")
            .ok_or_else(|| anyhow::anyhow!("Google returned no upload session"))?
            .to_str()?,
    )?;
    anyhow::ensure!(
        session.scheme() == "https"
            && session
                .host_str()
                .is_some_and(|h| h == "googleapis.com" || h.ends_with(".googleapis.com")),
        "Unexpected Google upload session origin"
    );
    const CHUNK: usize = 8 * 1024 * 1024;
    for (index, chunk) in bytes.chunks(CHUNK).enumerate() {
        let start = index * CHUNK;
        let end = start + chunk.len() - 1;
        let response = app
            .http
            .put(session.clone())
            .bearer_auth(bearer)
            .header("content-type", "application/octet-stream")
            .header(
                "content-range",
                format!("bytes {start}-{end}/{}", bytes.len()),
            )
            .body(chunk.to_vec())
            .send()
            .await?;
        if end + 1 == bytes.len() {
            anyhow::ensure!(
                response.status().is_success(),
                "Drive upload failed with status {}",
                response.status()
            );
        } else {
            anyhow::ensure!(
                response.status().as_u16() == 308
                    && response
                        .headers()
                        .get("range")
                        .and_then(|r| r.to_str().ok())
                        == Some(format!("bytes=0-{end}").as_str()),
                "Google did not acknowledge the uploaded chunk"
            );
        }
    }
    Ok(())
}
