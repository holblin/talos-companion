use crate::model::App;
use s3s::{auth::SimpleAuth, service::S3ServiceBuilder};

pub async fn run(app: App) -> anyhow::Result<()> {
    // No receiver credentials or listener exist until setup/restore commits successfully.
    let s = loop {
        if let Some(s) = app.store.read().await.clone() {
            break s;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    };
    let root = app.data.join("receiver");
    std::fs::create_dir_all(root.join("omni"))?;
    let fs = s3s_fs::FileSystem::new(root)
        .map_err(|e| anyhow::anyhow!("S3 filesystem initialization failed: {e:?}"))?;
    let mut builder = S3ServiceBuilder::new(fs);
    builder.set_auth(SimpleAuth::from_single(s.s3_access_key, s.s3_secret_key));
    let service = builder.build();
    let address = std::env::var("S3_LISTEN_ADDR").unwrap_or("0.0.0.0:9000".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address,"S3 receiver listening");
    loop {
        let (stream, _) = listener.accept().await?;
        let service = service.clone();
        let io = app.io.clone();
        tokio::spawn(async move {
            let service =
                hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                    let service = service.clone();
                    let io = io.clone();
                    async move {
                        let _guard = io.read().await;
                        hyper::service::Service::call(&service, req).await
                    }
                });
            if let Err(e) =
                hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new())
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await
            {
                tracing::debug!(error=%e,"S3 connection closed");
            }
        });
    }
}
