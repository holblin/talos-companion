#![forbid(unsafe_code)]

mod auth;
mod backup;
mod backup_format;
mod cloudflare_dns;
mod companion_setup;
mod connection_agent;
mod connections;
mod drive;
mod endpoint_checks;
mod model;
mod network_backup;
mod oidc;
mod omni;
mod receiver;
mod recovery;
mod retention;
mod settings;
mod tailscale;
mod vault;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, header},
    middleware::{self, Next},
    response::Response,
    routing::{any, delete, get, post},
};
use model::*;
use serde_json::{Value, json};
use tower_http::services::{ServeDir, ServeFile};

// React Aria inserts two fixed styles for touch gestures and modal scrolling.
// Hashes allow only those blocks, without permitting arbitrary inline styles.
// web/tests/csp.test.tsx checks these against the pinned dependency source.
const CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'self'; style-src 'self' ",
    "'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=' ",
    "'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='; ",
    "font-src 'self' https://use.typekit.net; ",
    "img-src 'self' data: https://www.gravatar.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
);

async fn overview(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    auth::admin(&app, &headers).await?;
    let guard = app.store.read().await;
    let s = guard.as_ref().ok_or_else(denied)?;
    let settings = app.settings.borrow().clone();
    Ok(Json(
        json!({"issuer":app.issuer(),"client_id":s.client_id,"client_secret":s.client_secret,"redirect_uri":s.redirect_uri,"s3_endpoint":omni::defaults(&app,s).s3_endpoint,"s3_access_key":s.s3_access_key,"s3_secret_key":s.s3_secret_key,"bucket":"omni","mounted":app.mounted.as_ref().map(|p|p.to_string_lossy()),"drive":{"client_id":s.drive.client_id,"folder_id":s.drive.folder_id,"connected":!s.drive.refresh_token.is_empty()},"network":s.network.as_ref().map(|c|c.summary()),"streaming_backups":true,"retention":settings.retention,"settings":settings}),
    ))
}
async fn secure_headers(req: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert("no-store".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("x-frame-options", "DENY".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        CONTENT_SECURITY_POLICY.parse().unwrap(),
    );
    response
}
fn frontend_routes<S: Clone + Send + Sync + 'static>(static_dir: &str) -> Router<S> {
    let index = ServeFile::new(format!("{static_dir}/index.html"));
    let routes = [
        "/backups",
        "/identity",
        "/access",
        "/omni-configuration",
        "/accounts",
        "/settings",
        "/change-password",
    ]
    .into_iter()
    .fold(Router::new(), |routes, path| {
        routes.route_service(path, index.clone())
    });
    routes.fallback_service(ServeDir::new(static_dir).not_found_service(index))
}

fn router(app: App) -> Router {
    let static_dir = std::env::var("WEB_DIR").unwrap_or("web/dist".into());
    Router::new()
        .merge(frontend_routes(&static_dir))
        .route("/healthz", get(|| async { Json(json!({"ok":true})) }))
        .merge(
            Router::new()
                .route("/omni", any(companion_setup::backup_proxy))
                .route("/omni/{*key}", any(companion_setup::backup_proxy))
                .route(
                    "/.well-known/talos-companion",
                    get(companion_setup::backup_proxy),
                )
                .layer(DefaultBodyLimit::disable()),
        )
        .route("/api/status", get(auth::status))
        .route("/api/setup", post(auth::setup))
        .route("/api/setup/check", post(auth::setup_check))
        .route("/api/setup/recovery-key", post(recovery::download))
        .route("/api/setup/github-keys", post(recovery::github))
        .route(
            "/api/restore",
            post(backup::restore).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/login", post(auth::login))
        .route("/api/logout", post(auth::logout))
        .route("/api/me", get(auth::me))
        .route("/api/password", post(auth::password))
        .route("/api/password/recover", post(recovery::recover_password))
        .route(
            "/api/password/recovery-code",
            post(recovery::request_password_recovery),
        )
        .route("/api/users", get(auth::users).post(auth::add))
        .route("/api/users/{id}", delete(auth::remove).put(auth::update))
        .route("/api/overview", get(overview))
        .route("/api/settings", get(settings::get).post(settings::update))
        .route("/api/oidc", post(oidc::configure))
        .route(
            "/api/companion/access",
            get(companion_setup::accesses).post(companion_setup::save_access),
        )
        .route("/api/companion/local", post(companion_setup::prepare))
        .route("/api/companion/ca", get(companion_setup::ca))
        .route("/api/companion/check", post(companion_setup::check))
        .route("/api/companion/activate", post(companion_setup::activate))
        .route("/api/omni", get(omni::status))
        .route(
            "/api/omni/connection",
            get(connections::get)
                .post(connections::start)
                .delete(connections::cancel),
        )
        .route(
            "/api/omni/identity",
            get(endpoint_checks::companion_identity),
        )
        .route(
            "/api/omni/bootstrap",
            get(omni::bootstrap_status).post(omni::generate),
        )
        .route("/api/omni/bootstrap/config", get(omni::download_bootstrap))
        .route("/api/omni/bootstrap/check", post(omni::check_bootstrap))
        .route("/api/omni/existing/config", post(omni::download_existing))
        .route("/api/omni/plan", post(omni::preview))
        .route("/api/omni/discover", post(omni::discover))
        .route("/api/omni/location", post(connections::location))
        .route("/api/omni/connection/finish", post(connections::finish))
        .route("/api/omni/apply", post(omni::apply))
        .route("/api/omni/check", post(endpoint_checks::run))
        .route("/api/omni/ca", get(omni::ca))
        .route("/api/omni/talos-ca", get(omni::talos_ca))
        .route("/api/backups", get(backup::list).post(backup::make))
        .route("/api/backups/mounted/check", post(backup::check_mounted))
        .route("/api/backups/network", post(network_backup::configure))
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
        .layer(middleware::from_fn(secure_headers))
        .with_state(app)
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::args().any(|a| a == "--connection-agent-healthcheck") {
        anyhow::ensure!(
            connections::agent_info().is_some(),
            "Connector heartbeat is stale"
        );
        return Ok(());
    }
    if std::env::args().any(|a| a == "--connection-agent") {
        return connection_agent::run().await;
    }
    if std::env::args().any(|a| a == "--reset-admin-password") {
        anyhow::bail!(
            "Direct password reset was removed. Use --generate-password-reset-code, then choose a password on the sign-in page."
        );
    }
    if std::env::args().any(|a| a == "--generate-password-reset-code") {
        return recovery::generate_password_recovery();
    }
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
    let scheduled = settings::run(&app);
    let address = std::env::var("LISTEN_ADDR").unwrap_or("0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address,"Companion listening");
    tokio::select! {result=companion_setup::serve(listener,router(app.clone()))=>{result?;},result=receiver=>{result?;},_=scheduled=>{},_=connections::supervise()=>{},_=tokio::signal::ctrl_c()=>{}}
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
    async fn frontend_deep_links_return_success_and_unknown_paths_remain_not_found() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<title>Companion</title>").unwrap();
        let routes = frontend_routes::<()>(dir.path().to_str().unwrap());
        for path in [
            "/",
            "/backups",
            "/identity",
            "/accounts",
            "/settings",
            "/change-password",
        ] {
            let response = routes
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .uri(path)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::OK, "{path}");
            let body = axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap();
            assert_eq!(&body[..], b"<title>Companion</title>");
        }
        let response = routes
            .oneshot(
                axum::http::Request::builder()
                    .uri("/unknown-file.js")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    }
    #[tokio::test]
    async fn setup_token_and_csrf_required() {
        let dir = tempfile::tempdir().unwrap();
        let app = App {
            _process_lock: std::sync::Arc::new(tempfile::tempfile().unwrap()),
            store: std::sync::Arc::new(tokio::sync::RwLock::new(None)),
            memory: std::sync::Arc::new(tokio::sync::Mutex::new(Memory {
                sessions: Default::default(),
                codes: Default::default(),
                drive_states: Default::default(),
                attempts: vec![],
            })),
            io: Default::default(),
            backup_lock: Default::default(),
            settings: tokio::sync::watch::channel(settings::Settings::default()).0,
            data: dir.path().into(),
            public_url: "http://localhost:8080".into(),
            issuer: tokio::sync::watch::channel("http://localhost:8080".into()).0,
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
