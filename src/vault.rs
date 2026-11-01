//! Administrator-supplied Omni configuration and encryption material for recovery.
use crate::{auth, model::*};
use axum::{
    Json,
    extract::{Multipart, Path, State},
    http::{HeaderMap, header},
};
use serde_json::{Value, json};
use std::io::Write;
fn valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}
pub async fn list(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    auth::admin(&app, &headers).await?;
    let mut names = Vec::new();
    for e in std::fs::read_dir(app.data.join("vault")).map_err(anyhow::Error::from)? {
        let e = e.map_err(anyhow::Error::from)?;
        let name = e.file_name().to_string_lossy().into_owned();
        if valid(&name) && e.file_type().map_err(anyhow::Error::from)?.is_file() {
            names.push(name);
        }
    }
    names.sort();
    Ok(Json(json!(names)))
}
pub async fn upload(
    State(app): State<App>,
    headers: HeaderMap,
    mut form: Multipart,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let field = form
        .next_field()
        .await
        .map_err(|_| bad("Invalid upload"))?
        .ok_or_else(|| bad("Choose a credential file"))?;
    let name = field
        .file_name()
        .ok_or_else(|| bad("Missing filename"))?
        .to_owned();
    if !valid(&name) {
        return Err(bad(
            "Use a filename with letters, numbers, dots, dashes, or underscores",
        ));
    }
    let bytes = field
        .bytes()
        .await
        .map_err(|_| bad("Credential file is too large"))?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(bad("Credential files may be at most 16 MiB"));
    }
    let _io = app.io.read().await;
    let dir = app.data.join("vault");
    let mut tmp = tempfile::NamedTempFile::new_in(&dir).map_err(anyhow::Error::from)?;
    tmp.write_all(&bytes).map_err(anyhow::Error::from)?;
    tmp.as_file().sync_all().map_err(anyhow::Error::from)?;
    tmp.persist(dir.join(&name)).map_err(anyhow::Error::from)?;
    Ok(Json(json!({"name":name})))
}
pub async fn download(
    State(app): State<App>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<([(header::HeaderName, String); 2], Vec<u8>)> {
    auth::admin(&app, &headers).await?;
    if !valid(&name) {
        return Err(bad("Invalid filename"));
    }
    let bytes = tokio::fs::read(app.data.join("vault").join(&name))
        .await
        .map_err(anyhow::Error::from)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".into()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
        ],
        bytes,
    ))
}
pub async fn remove(
    State(app): State<App>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    if !valid(&name) {
        return Err(bad("Invalid filename"));
    }
    let _io = app.io.read().await;
    tokio::fs::remove_file(app.data.join("vault").join(name))
        .await
        .map_err(anyhow::Error::from)?;
    Ok(Json(json!({"ok":true})))
}
