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
            &format!("{}/oauth/google/callback", app.issuer()),
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
                &format!("{}/oauth/google/callback", app.issuer()),
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

pub async fn upload(
    app: &App,
    name: &str,
    path: &std::path::Path,
    keep: usize,
) -> anyhow::Result<()> {
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
    let file = tokio::fs::File::open(path).await?;
    let size = file.metadata().await?.len();
    let mut tokens = Tokens::Google {
        app,
        drive: &d,
        value: String::new(),
        expires_at: 0,
    };
    let response = app.http.post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")
        .bearer_auth(tokens.bearer().await?).header("x-upload-content-type","application/octet-stream")
        .header("x-upload-content-length",size)
        .json(&json!({"name":name,"parents":[d.folder_id],"appProperties":{"talos_companion":"recovery-v2"}}))
        .send().await?.error_for_status()?;
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
    upload_chunks(&app.http, &session, &mut tokens, file, size).await?;
    prune(
        &app.http,
        "https://www.googleapis.com/drive/v3/files",
        tokens.bearer().await?,
        &d.folder_id,
        keep,
        name,
    )
    .await?;
    Ok(())
}

enum Tokens<'a> {
    Google {
        app: &'a App,
        drive: &'a Drive,
        value: String,
        expires_at: u64,
    },
    #[cfg(test)]
    Fixed(String),
}
impl Tokens<'_> {
    async fn bearer(&mut self) -> anyhow::Result<&str> {
        match self {
            Self::Google {
                app,
                drive,
                value,
                expires_at,
            } => {
                // Refresh between chunks so multi-hour uploads are not limited by token lifetime.
                if now().saturating_add(60) >= *expires_at {
                    let token: Value = app
                        .http
                        .post("https://oauth2.googleapis.com/token")
                        .form(&[
                            ("client_id", drive.client_id.as_str()),
                            ("client_secret", drive.client_secret.as_str()),
                            ("refresh_token", drive.refresh_token.as_str()),
                            ("grant_type", "refresh_token"),
                        ])
                        .send()
                        .await?
                        .error_for_status()?
                        .json()
                        .await?;
                    *value = token["access_token"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("Google returned no access token"))?
                        .to_owned();
                    *expires_at =
                        now().saturating_add(token["expires_in"].as_u64().unwrap_or(3600));
                }
                Ok(value)
            }
            #[cfg(test)]
            Self::Fixed(value) => Ok(value),
        }
    }
}

/// File content is read only in bounded 8 MiB chunks. Network errors leave the complete
/// local recovery file intact; the caller reports failure instead of silently dropping it.
async fn upload_chunks(
    client: &reqwest::Client,
    session: &url::Url,
    tokens: &mut Tokens<'_>,
    mut file: tokio::fs::File,
    size: u64,
) -> anyhow::Result<()> {
    use tokio::io::AsyncReadExt;
    const CHUNK: u64 = 8 * 1024 * 1024;
    let mut offset = 0u64;
    while offset < size {
        let length = (size - offset).min(CHUNK) as usize;
        let mut chunk = vec![0; length];
        file.read_exact(&mut chunk).await?;
        let end = offset + length as u64 - 1;
        let response = client
            .put(session.clone())
            .bearer_auth(tokens.bearer().await?)
            .header("content-type", "application/octet-stream")
            .header("content-range", format!("bytes {offset}-{end}/{size}"))
            .body(chunk)
            .send()
            .await?;
        if end + 1 == size {
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
        offset = end + 1;
    }
    Ok(())
}

/// Only recovery files created by this application in the configured folder qualify.
/// Google files go to Trash, rather than being permanently deleted.
async fn prune(
    client: &reqwest::Client,
    api: &str,
    bearer: &str,
    folder: &str,
    keep: usize,
    current: &str,
) -> anyhow::Result<()> {
    if keep == 0 {
        return Ok(());
    }
    let folder = folder.replace('\\', "\\\\").replace('\'', "\\'");
    let query = format!(
        "'{folder}' in parents and trashed = false and appProperties has {{ key='talos_companion' and value='recovery-v2' }}"
    );
    let mut page = String::new();
    let mut files = Vec::new();
    let mut pages = std::collections::HashSet::new();
    loop {
        let response: Value = client
            .get(api)
            .bearer_auth(bearer)
            .query(&[
                ("q", query.as_str()),
                ("orderBy", "createdTime desc"),
                ("pageSize", "1000"),
                ("fields", "nextPageToken,files(id,name,createdTime)"),
                ("pageToken", page.as_str()),
            ])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        for file in response["files"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Invalid Google file listing"))?
        {
            if let (Some(id), Some(name), Some(created)) = (
                file["id"].as_str(),
                file["name"].as_str(),
                file["createdTime"].as_str(),
            ) && crate::retention::recovery_name(name)
            {
                files.push((id.to_owned(), name.to_owned(), created.to_owned()));
            }
        }
        let Some(next) = response["nextPageToken"].as_str().filter(|s| !s.is_empty()) else {
            break;
        };
        anyhow::ensure!(
            pages.insert(next.to_owned()),
            "Google returned a repeated page token"
        );
        page = next.to_owned();
    }
    files.sort_by(|a, b| {
        (b.1 == current)
            .cmp(&(a.1 == current))
            .then_with(|| b.2.cmp(&a.2))
    });
    for (id, _, _) in files.into_iter().skip(keep) {
        let mut url = url::Url::parse(api)?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Invalid Drive API URL"))?
            .push(&id);
        client
            .patch(url)
            .bearer_auth(bearer)
            .json(&json!({"trashed":true}))
            .send()
            .await?
            .error_for_status()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Bytes,
        extract::{Path, Query, State},
        http::{HeaderMap, StatusCode},
        routing::{get, put},
    };
    use std::sync::Arc;
    use tokio::sync::Mutex;
    #[derive(Default)]
    struct Observed {
        chunks: Vec<(String, usize)>,
        trashed: Vec<String>,
        queries: Vec<String>,
    }

    async fn chunk(
        State(observed): State<Arc<Mutex<Observed>>>,
        headers: HeaderMap,
        bytes: Bytes,
    ) -> (StatusCode, HeaderMap) {
        let range = headers["content-range"].to_str().unwrap().to_owned();
        let end = range
            .split_once('-')
            .unwrap()
            .1
            .split_once('/')
            .unwrap()
            .0
            .parse::<u64>()
            .unwrap();
        observed
            .lock()
            .await
            .chunks
            .push((range.clone(), bytes.len()));
        let mut headers = HeaderMap::new();
        headers.insert("range", format!("bytes=0-{end}").parse().unwrap());
        (
            if range.ends_with("/8388731") && end == 8388730 {
                StatusCode::OK
            } else {
                StatusCode::PERMANENT_REDIRECT
            },
            headers,
        )
    }
    async fn files(
        State(observed): State<Arc<Mutex<Observed>>>,
        Query(q): Query<std::collections::HashMap<String, String>>,
    ) -> Json<Value> {
        observed.lock().await.queries.push(q["q"].clone());
        if q["pageToken"].is_empty() {
            Json(
                json!({"files":[{"id":"new","name":"companion-3-c.tcb","createdTime":"2026-11-03"},{"id":"other","name":"unrelated.txt","createdTime":"2026-11-02"}],"nextPageToken":"page-2"}),
            )
        } else {
            Json(
                json!({"files":[{"id":"middle","name":"companion-2-b.tcb","createdTime":"2026-11-02"},{"id":"old","name":"companion-1-a.tcb","createdTime":"2026-11-01"}]}),
            )
        }
    }
    async fn trash(
        State(observed): State<Arc<Mutex<Observed>>>,
        Path(id): Path<String>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        assert_eq!(body, json!({"trashed":true}));
        observed.lock().await.trashed.push(id);
        Json(json!({}))
    }

    #[tokio::test]
    async fn drive_reads_file_in_chunks_and_trashes_only_expired_recovery_files() {
        let observed = Arc::new(Mutex::new(Observed::default()));
        let router = Router::new()
            .route(
                "/upload",
                put(chunk).layer(axum::extract::DefaultBodyLimit::max(9 * 1024 * 1024)),
            )
            .route("/files", get(files))
            .route("/files/{id}", axum::routing::patch(trash))
            .with_state(observed.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.as_file().set_len(8 * 1024 * 1024 + 123).unwrap();
        let file = tokio::fs::File::open(tmp.path()).await.unwrap();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        upload_chunks(
            &client,
            &url::Url::parse(&format!("{base}/upload")).unwrap(),
            &mut Tokens::Fixed("test-token".into()),
            file,
            8 * 1024 * 1024 + 123,
        )
        .await
        .unwrap();
        prune(
            &client,
            &format!("{base}/files"),
            "test-token",
            "test-folder",
            2,
            "companion-3-c.tcb",
        )
        .await
        .unwrap();
        let seen = observed.lock().await;
        assert_eq!(
            seen.chunks,
            vec![
                ("bytes 0-8388607/8388731".into(), 8388608),
                ("bytes 8388608-8388730/8388731".into(), 123)
            ]
        );
        assert_eq!(seen.trashed, vec!["old"]);
        assert_eq!(seen.queries.len(), 2);
        assert!(
            seen.queries
                .iter()
                .all(|q| q.contains("'test-folder' in parents") && q.contains("recovery-v2"))
        );
        server.abort();
    }
}
