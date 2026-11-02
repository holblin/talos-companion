mod auth;
mod backup;
mod backup_format;
mod drive;
mod model;
mod oidc;
mod receiver;
mod retention;
mod vault;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, header},
    middleware::{self, Next},
    response::Response,
    routing::{delete, get, post},
};
use model::*;
use serde_json::{Value, json};
use tower_http::services::{ServeDir, ServeFile};

async fn overview(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    auth::admin(&app, &headers).await?;
    let guard = app.store.read().await;
    let s = guard.as_ref().ok_or_else(denied)?;
    Ok(Json(
        json!({"issuer":app.public_url,"client_id":s.client_id,"client_secret":s.client_secret,"redirect_uri":s.redirect_uri,"s3_access_key":s.s3_access_key,"s3_secret_key":s.s3_secret_key,"bucket":"omni","mounted":app.mounted.as_ref().map(|p|p.to_string_lossy()),"drive":{"client_id":s.drive.client_id,"folder_id":s.drive.folder_id,"connected":!s.drive.refresh_token.is_empty()},"streaming_backups":true,"retention":app.retention}),
    ))
}
async fn secure_headers(req: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("x-frame-options", "DENY".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert("content-security-policy","default-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'".parse().unwrap());
    response
}
fn router(app: App) -> Router {
    let static_dir = std::env::var("WEB_DIR").unwrap_or("web/dist".into());
    Router::new()
        .route("/healthz", get(|| async { Json(json!({"ok":true})) }))
        .route("/api/status", get(auth::status))
        .route("/api/setup", post(auth::setup))
        .route(
            "/api/restore",
            post(backup::restore).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/login", post(auth::login))
        .route("/api/logout", post(auth::logout))
        .route("/api/me", get(auth::me))
        .route("/api/password", post(auth::password))
        .route("/api/users", get(auth::users).post(auth::add))
        .route("/api/users/{id}", delete(auth::remove))
        .route("/api/overview", get(overview))
        .route("/api/oidc", post(oidc::configure))
        .route("/api/backups", get(backup::list).post(backup::make))
        .route("/api/backups/{name}", get(backup::download))
        .route(
            "/api/vault",
            get(vault::list)
                .post(vault::upload)
                .layer(DefaultBodyLimit::max(16 * 1024 * 1024 + 1024)),
        )
        .route(
            "/api/vault/{name}",
            get(vault::download).delete(vault::remove),
        )
        .route("/api/drive", post(drive::configure))
        .route("/api/drive/connect", post(drive::connect))
        .route("/oauth/google/callback", get(drive::callback))
        .route("/.well-known/openid-configuration", get(oidc::discovery))
        .route("/oauth/jwks", get(oidc::jwks))
        .route("/oauth/authorize", get(oidc::authorize))
        .route("/oauth/token", post(oidc::token))
        .route("/oauth/userinfo", get(oidc::userinfo))
        .fallback_service(
            ServeDir::new(&static_dir)
                .not_found_service(ServeFile::new(format!("{static_dir}/index.html"))),
        )
        .layer(middleware::from_fn(secure_headers))
        .with_state(app)
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|a| a == "--healthcheck") {
        return healthcheck();
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "talos_companion=info,tower_http=info".into()),
        )
        .init();
    let app = App::load().await?;
    let receiver_app = app.clone();
    // A failed receiver stops the application so that Docker can restart it instead of reporting a healthy but incomplete service.
    let receiver = receiver::run(receiver_app);
    let scheduled = async {
        let seconds = std::env::var("BACKUP_INTERVAL_SECONDS")
            .ok()
            .and_then(|x| x.parse::<u64>().ok())
            .unwrap_or(86400)
            .max(60);
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
            if app.store.read().await.is_some() {
                let destination = std::env::var("SCHEDULE_DESTINATION").unwrap_or("local".into());
                if let Err(e) = backup::create(&app, &destination).await {
                    tracing::error!(message=%e.1,"scheduled backup failed");
                }
            }
        }
    };
    let address = std::env::var("LISTEN_ADDR").unwrap_or("0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address,"Companion listening");
    tokio::select! {result=axum::serve(listener,router(app.clone())).with_graceful_shutdown(async{let _=tokio::signal::ctrl_c().await;}).into_future()=>{result?;},result=receiver=>{result?;},_=scheduled=>{}}
    Ok(())
}
fn healthcheck() -> anyhow::Result<()> {
    use std::io::{Read, Write};
    let address = std::env::var("LISTEN_ADDR")
        .unwrap_or("0.0.0.0:8080".into())
        .replace("0.0.0.0:", "127.0.0.1:");
    let mut stream =
        std::net::TcpStream::connect_timeout(&address.parse()?, std::time::Duration::from_secs(2))?;
    stream.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
    stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut buf = [0; 32];
    let n = stream.read(&mut buf)?;
    anyhow::ensure!(
        String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200"),
        "Unhealthy response"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;
    #[tokio::test]
    async fn setup_token_and_csrf_required() {
        let dir = tempfile::tempdir().unwrap();
        let app = App {
            store: std::sync::Arc::new(tokio::sync::RwLock::new(None)),
            memory: std::sync::Arc::new(tokio::sync::Mutex::new(Memory {
                sessions: Default::default(),
                codes: Default::default(),
                drive_states: Default::default(),
                attempts: vec![],
            })),
            io: Default::default(),
            backup_lock: Default::default(),
            retention: crate::retention::Retention {
                recovery_keep_last: 7,
                snapshot_keep_last: 30,
            },
            data: dir.path().into(),
            public_url: "http://localhost:8080".into(),
            setup_token: "a secure and long setup token".into(),
            backup_passphrase: "a secure backup passphrase".into(),
            mounted: None,
            http: reqwest::Client::new(),
        };
        let req=axum::http::Request::builder().method("POST").uri("/api/setup").header("content-type","application/json").body(axum::body::Body::from(r#"{"name":"Admin","email":"admin@example.com","password":"correct-horse-battery"}"#)).unwrap();
        let result = router(app).oneshot(req).await.unwrap();
        assert_eq!(result.status(), axum::http::StatusCode::BAD_REQUEST);
    }
}
