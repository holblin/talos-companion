use crate::model::App;
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{any, get},
};
use s3s::{
    auth::SimpleAuth,
    service::{S3Service, S3ServiceBuilder},
};
use std::sync::Arc;
use tokio::sync::OnceCell;

pub fn routes() -> Router<App> {
    Router::new()
        .route("/omni", any(receive))
        .route("/omni/{*key}", any(receive))
        .route("/.well-known/talos-companion", get(identity))
        .layer(DefaultBodyLimit::disable())
        .layer(Extension(Arc::new(OnceCell::<S3Service>::new())))
}

async fn identity(State(app): State<App>, request: Request) -> Response {
    let store = app.store.read().await;
    let Some(store) = store.as_ref() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let challenge = url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
        .find(|(key, _)| key == "challenge")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    match crate::endpoint_checks::identity(&store.s3_secret_key, "s3", &challenge) {
        Some(value) => Json(value).into_response(),
        None => StatusCode::BAD_REQUEST.into_response(),
    }
}

async fn receive(
    State(app): State<App>,
    Extension(receiver): Extension<Arc<OnceCell<S3Service>>>,
    request: Request,
) -> Result<Response, StatusCode> {
    let (access_key, secret_key) = {
        let store = app.store.read().await;
        let store = store.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
        (store.s3_access_key.clone(), store.s3_secret_key.clone())
    };
    let _guard = app.io.read().await;
    let service = receiver
        .get_or_try_init(|| async {
            let root = app.data.join("receiver");
            std::fs::create_dir_all(root.join("omni"))?;
            let filesystem = s3s_fs::FileSystem::new(root).map_err(|error| {
                anyhow::anyhow!("S3 filesystem initialization failed: {error:?}")
            })?;
            let mut builder = S3ServiceBuilder::new(filesystem);
            builder.set_auth(SimpleAuth::from_single(access_key, secret_key));
            Ok::<_, anyhow::Error>(builder.build())
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, "S3 receiver initialization failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
    service
        .call(request.map(s3s::Body::http_body_unsync))
        .await
        .map(|response| response.map(axum::body::Body::new))
        .map_err(|error| {
            tracing::error!(%error, "S3 request failed");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}
