//! HTTPS bootstrap on the existing web port; HTTP remains available for local setup and provider relays.
use crate::{auth, connections, endpoint_checks, model::*, omni::Profile};
use axum::{Json, extract::State, http::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        self,
        pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
    },
};

#[derive(Deserialize, Serialize)]
struct LocalCertificate {
    host: String,
    #[serde(default)]
    expires_at: u64,
    ca: String,
    ca_key: String,
    cert: String,
    key: String,
}
fn path() -> std::path::PathBuf {
    connections::private_dir().join("local-https.json")
}
fn load() -> anyhow::Result<LocalCertificate> {
    connections::read_json(&path())
}
fn acceptor(cert: &LocalCertificate) -> anyhow::Result<TlsAcceptor> {
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from_pem_slice(cert.cert.as_bytes())?],
        PrivateKeyDer::from_pem_slice(cert.key.as_bytes())?,
    )?;
    Ok(TlsAcceptor::from(Arc::new(config)))
}
pub fn local_root() -> Option<String> {
    load().ok().map(|c| c.ca)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Endpoint {
    pub companion_url: String,
    pub profile: Profile,
}
pub async fn prepare(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Endpoint>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let url = https(&input.companion_url)?;
    let _serial = app.backup_lock.lock().await;
    connections::private_directory(&connections::private_dir())?;
    let host = url
        .host_str()
        .ok_or_else(|| bad("Enter a local hostname or IP address"))?
        .trim_matches(['[', ']'])
        .to_owned();
    let previous = if path().exists() { Some(load()?) } else { None };
    if previous
        .as_ref()
        .is_none_or(|c| c.host != host || c.expires_at < now() + 30 * 86400)
    {
        use rcgen::{
            BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose,
        };
        let (ca, ca_key) = if let Some(previous) = previous {
            (previous.ca, previous.ca_key)
        } else {
            let key = KeyPair::generate().map_err(anyhow::Error::from)?;
            let mut params = CertificateParams::default();
            params
                .distinguished_name
                .push(DnType::CommonName, "Talos Companion local CA");
            params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
            let cert = params.self_signed(&key).map_err(anyhow::Error::from)?;
            (cert.pem(), key.serialize_pem())
        };
        let issuer = Issuer::from_ca_cert_pem(
            &ca,
            KeyPair::from_pem(&ca_key).map_err(anyhow::Error::from)?,
        )
        .map_err(anyhow::Error::from)?;
        let key = KeyPair::generate().map_err(anyhow::Error::from)?;
        let mut params = CertificateParams::new(vec![host.clone()]).map_err(anyhow::Error::from)?;
        params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        params.not_before = time::OffsetDateTime::now_utc() - time::Duration::days(1);
        params.not_after = time::OffsetDateTime::now_utc() + time::Duration::days(365);
        let cert = params
            .signed_by(&key, &issuer)
            .map_err(anyhow::Error::from)?;
        connections::write_json(
            &path(),
            &LocalCertificate {
                host,
                expires_at: now() + 365 * 86400,
                ca,
                ca_key,
                cert: cert.pem(),
                key: key.serialize_pem(),
            },
        )?;
    }
    // Validate the persisted configuration before telling the user it is ready.
    acceptor(&load()?)?;
    Ok(Json(
        json!({"companion_url":url.origin().ascii_serialization(),"trust_required":true}),
    ))
}
pub async fn ca(State(app): State<App>, headers: HeaderMap) -> Result<(HeaderMap, String)> {
    auth::admin(&app, &headers).await?;
    let mut headers = HeaderMap::new();
    headers.insert("content-type", "application/x-pem-file".parse().unwrap());
    headers.insert(
        "content-disposition",
        "attachment; filename=companion-local-ca.crt"
            .parse()
            .unwrap(),
    );
    Ok((headers, load()?.ca))
}
fn https(value: &str) -> Result<url::Url> {
    let url = endpoint_checks::origin(value)
        .map_err(|_| bad("Enter an HTTPS origin without a path or credentials"))?;
    if url.scheme() != "https" {
        return Err(bad(
            "Companion needs HTTPS before it can be used as an Omni identity provider",
        ));
    }
    Ok(url)
}
async fn verify(app: &App, input: &Endpoint) -> Result<String> {
    let url = https(&input.companion_url)?;
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(ca) = local_root() {
        builder = builder.add_root_certificate(
            reqwest::Certificate::from_pem(ca.as_bytes()).map_err(anyhow::Error::from)?,
        );
    }
    if input.profile == Profile::Lan {
        for path in [
            std::path::PathBuf::from("/omni-managed/root-ca.crt"),
            connections::private_dir().join("origin-ca.crt"),
        ] {
            if let Ok(bytes) = std::fs::read(path) {
                builder = builder.add_root_certificate(
                    reqwest::Certificate::from_pem(&bytes).map_err(anyhow::Error::from)?,
                );
            }
        }
    }
    if input.profile == Profile::Tailscale && connections::provider_available(&Profile::Tailscale) {
        builder = builder
            .proxy(reqwest::Proxy::all("socks5h://127.0.0.1:1055").map_err(anyhow::Error::from)?);
    }
    let client = builder.build().map_err(anyhow::Error::from)?;
    verify_with_client(app, &url, &client).await
}
async fn verify_with_client(app: &App, url: &url::Url, client: &reqwest::Client) -> Result<String> {
    let key = app
        .store
        .read()
        .await
        .as_ref()
        .ok_or_else(denied)?
        .s3_secret_key
        .clone();
    endpoint_checks::identify(client, url.as_str(), &key, "companion")
        .await
        .map_err(|_| {
            bad("Could not verify this Companion over HTTPS. Check routing and certificate trust.")
        })?;
    let discovery = endpoint_checks::small_json(
        client
            .get(
                url.join("/.well-known/openid-configuration")
                    .map_err(anyhow::Error::from)?,
            )
            .send()
            .await
            .map_err(anyhow::Error::from)?,
    )
    .await?;
    if discovery["issuer"] != app.issuer() {
        return Err(bad("The endpoint advertises a different identity provider"));
    }
    let remote = endpoint_checks::small_json(
        client
            .get(url.join("/oauth/jwks").map_err(anyhow::Error::from)?)
            .send()
            .await
            .map_err(anyhow::Error::from)?,
    )
    .await?;
    if remote != crate::oidc::jwks(State(app.clone())).await?.0 {
        return Err(bad("The endpoint has a different signing key"));
    }
    Ok(url.origin().ascii_serialization())
}

async fn verification_with_fallback(
    normal: impl std::future::Future<Output = Result<String>>,
    cloudflare: impl std::future::Future<Output = Result<String>>,
    profile: &Profile,
) -> Result<(String, bool)> {
    match normal.await {
        Ok(origin) => Ok((origin, false)),
        Err(error) if *profile != Profile::Cloudflare => Err(error),
        Err(_) => Ok((cloudflare.await?, true)),
    }
}

async fn verify_access(app: &App, input: &Endpoint) -> Result<(String, bool)> {
    let cloudflare = async {
        let url = https(&input.companion_url)?;
        let host = url
            .host_str()
            .ok_or_else(|| bad("Missing Companion hostname"))?;
        let addresses = crate::cloudflare_dns::resolve(host).await
            .map_err(|_| bad("Could not verify Companion through normal DNS or Cloudflare DNS. Check routing and certificate trust, then retry."))?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(anyhow::Error::from)?;
        // Keep the original URL for Host, SNI, and certificate validation.
        verify_with_client(app, &url, &client).await
    };
    verification_with_fallback(verify(app, input), cloudflare, &input.profile).await
}

pub async fn check(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Endpoint>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let (origin, local_dns_pending) = verify_access(&app, &input).await?;
    Ok(Json(
        json!({"companion_url":origin,"ok":true,"local_dns_pending":local_dns_pending}),
    ))
}
pub async fn accesses(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    auth::admin(&app, &headers).await?;
    let saved = connections::settings();
    let mut accesses = saved.accesses;
    let mut candidates = vec![
        saved.integration,
        connections::read_json(&connections::private_dir().join("active.json")).ok(),
    ];
    for profile in [Profile::Cloudflare, Profile::Tailscale] {
        candidates.push(connections::read_json(&connections::provider_path(&profile)).ok());
    }
    candidates.push(
        app.store
            .read()
            .await
            .as_ref()
            .map(|s| s.integration.clone()),
    );
    // Legacy entries must be checked explicitly before Omni can select them.
    for integration in candidates.into_iter().flatten() {
        if !integration.companion_url.is_empty()
            && !accesses
                .iter()
                .any(|a| a.integration.profile == integration.profile)
        {
            accesses.push(connections::AccessMethod {
                integration,
                verified_at: 0,
                local_dns_pending: false,
            });
        }
    }
    Ok(Json(
        json!({"accesses":accesses,"local_ca_available":local_root().is_some(),"active_issuer":app.issuer(),"active_profile":app.store.read().await.as_ref().filter(|s| s.integration.companion_url == app.issuer()).map(|s| s.integration.profile.clone())}),
    ))
}
pub async fn save_access(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Endpoint>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let _serial = app.backup_lock.lock().await;
    let (origin, local_dns_pending) = match verify_access(&app, &input).await {
        Ok(verified) => verified,
        Err(error) => {
            let mut saved = connections::settings();
            if let Some(access) = saved.accesses.iter_mut().find(|a| {
                a.integration.profile == input.profile
                    && a.integration.companion_url == input.companion_url.trim_end_matches('/')
            }) {
                access.verified_at = 0;
                access.local_dns_pending = false;
                connections::write_json(&connections::settings_path(), &saved)?;
            }
            return Err(error);
        }
    };
    let mut saved = connections::settings();
    let provider = connections::read_json::<crate::omni::Integration>(&connections::provider_path(
        &input.profile,
    ))
    .ok()
    .or_else(|| connections::read_json(&connections::private_dir().join("active.json")).ok())
    .filter(|i| i.profile == input.profile && i.companion_url == origin);
    // Editing Companion access must not discard the provider's other service endpoints.
    let existing = saved
        .accesses
        .iter()
        .find(|a| a.integration.profile == input.profile)
        .map(|a| a.integration.clone());
    let legacy = saved
        .integration
        .clone()
        .filter(|i| i.profile == input.profile);
    let mut integration = provider
        .or(existing)
        .or(legacy)
        .unwrap_or(crate::omni::Integration {
            profile: input.profile.clone(),
            companion_url: origin.clone(),
            omni_url: String::new(),
            s3_endpoint: origin.clone(),
        });
    integration.companion_url = origin;
    if input.profile == Profile::Lan {
        integration.s3_endpoint = integration.companion_url.clone();
    }
    saved
        .accesses
        .retain(|a| a.integration.profile != input.profile);
    saved.accesses.push(connections::AccessMethod {
        integration: integration.clone(),
        verified_at: now(),
        local_dns_pending,
    });
    connections::private_directory(&connections::root())?;
    connections::write_json(&connections::settings_path(), &saved)?;
    Ok(Json(
        json!({"ok":true,"integration":integration,"active_issuer":app.issuer(),"local_dns_pending":local_dns_pending}),
    ))
}
pub async fn activate(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Endpoint>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let _serial = app.backup_lock.lock().await;
    let selected = connections::settings()
        .accesses
        .into_iter()
        .find(|a| {
            a.verified_at > 0
                && a.integration.profile == input.profile
                && a.integration.companion_url == input.companion_url.trim_end_matches('/')
        })
        .ok_or_else(|| {
            bad("Configure and verify this method in Companion access before selecting it for Omni")
        })?;
    let origin = verify(&app, &input).await?;
    let mut store = app.store.write().await;
    let mut next = store.as_ref().ok_or_else(denied)?.clone();
    next.integration = selected.integration;
    next.integration.companion_url = origin.clone();
    app.persist(&next)?;
    // Hold the authorization-code lock while publishing the issuer and dropping outstanding codes.
    let mut memory = app.memory.lock().await;
    if app.issuer() != origin {
        memory.codes.clear();
        app.issuer.send_replace(origin.clone());
    }
    *store = Some(next);
    Ok(Json(json!({"active_issuer":origin,"ok":true})))
}
async fn serve_io<T>(io: T, router: axum::Router)
where
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use tower::ServiceExt;
    let service =
        hyper::service::service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
            router.clone().oneshot(request.map(axum::body::Body::new))
        });
    let _ = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new())
        .serve_connection_with_upgrades(hyper_util::rt::TokioIo::new(io), service)
        .await;
}
pub async fn serve(listener: tokio::net::TcpListener, router: axum::Router) -> anyhow::Result<()> {
    loop {
        let (stream, _) = listener.accept().await?;
        let router = router.clone();
        tokio::spawn(async move {
            let mut first = [0; 1];
            let ready =
                tokio::time::timeout(std::time::Duration::from_secs(10), stream.peek(&mut first))
                    .await;
            if !matches!(ready, Ok(Ok(1))) {
                return;
            }
            if first[0] == 22 {
                if let Ok(acceptor) = load().and_then(|c| acceptor(&c))
                    && let Ok(Ok(tls)) = tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        acceptor.accept(stream),
                    )
                    .await
                {
                    serve_io(tls, router).await;
                }
            } else {
                serve_io(stream, router).await;
            }
        });
    }
}

pub async fn backup_proxy(
    request: axum::extract::Request,
) -> std::result::Result<axum::response::Response, hyper::StatusCode> {
    let address = std::env::var("S3_LISTEN_ADDR")
        .unwrap_or("0.0.0.0:9000".into())
        .replace("0.0.0.0:", "127.0.0.1:")
        .replace("[::]:", "[::1]:");
    let proxy = crate::connection_agent::Proxy {
        dynamic: false,
        origin: format!("http://{address}")
            .parse()
            .map_err(|_| hyper::StatusCode::BAD_GATEWAY)?,
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| hyper::StatusCode::BAD_GATEWAY)?,
    };
    crate::connection_agent::forward(State(proxy), request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rsa::pkcs8::EncodePrivateKey;

    #[tokio::test]
    async fn alternate_dns_verifies_tls_and_identity_without_masking_normal_access() {
        let dir = tempfile::tempdir().unwrap();
        let signing_key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048)
            .unwrap()
            .to_pkcs8_pem(Default::default())
            .unwrap()
            .to_string();
        let store = Store {
            version: 1,
            users: vec![],
            signing_key,
            client_id: "test".into(),
            client_secret: String::new(),
            redirect_uri: String::new(),
            s3_access_key: String::new(),
            s3_secret_key: "test-instance-secret".into(),
            drive: Default::default(),
            network: None,
            integration: Default::default(),
        };
        let app = App {
            _process_lock: Arc::new(tempfile::tempfile().unwrap()),
            store: Arc::new(tokio::sync::RwLock::new(Some(store))),
            memory: Arc::new(tokio::sync::Mutex::new(Memory {
                sessions: Default::default(),
                codes: Default::default(),
                drive_states: Default::default(),
                attempts: vec![],
            })),
            io: Default::default(),
            backup_lock: Default::default(),
            settings: tokio::sync::watch::channel(crate::settings::Settings::default()).0,
            data: dir.path().into(),
            public_url: "https://canonical.example.test".into(),
            issuer: tokio::sync::watch::channel("https://canonical.example.test".into()).0,
            setup_token: String::new(),
            backup_passphrase: String::new(),
            mounted: None,
            http: reqwest::Client::new(),
        };
        let cert =
            rcgen::generate_simple_self_signed(vec!["companion.example.test".into()]).unwrap();
        let certificate = LocalCertificate {
            host: "companion.example.test".into(),
            expires_at: 0,
            ca: cert.cert.pem(),
            ca_key: String::new(),
            cert: cert.cert.pem(),
            key: cert.signing_key.serialize_pem(),
        };
        let tls = acceptor(&certificate).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let url = url::Url::parse(&format!(
            "https://companion.example.test:{}",
            address.port()
        ))
        .unwrap();
        let routes = axum::Router::new()
            .route(
                "/api/omni/identity",
                axum::routing::get(endpoint_checks::companion_identity),
            )
            .route(
                "/.well-known/openid-configuration",
                axum::routing::get(crate::oidc::discovery),
            )
            .route("/oauth/jwks", axum::routing::get(crate::oidc::jwks))
            .with_state(app.clone());
        let server = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let tls = tls.clone();
                let routes = routes.clone();
                tokio::spawn(async move {
                    if let Ok(stream) = tls.accept(stream).await {
                        serve_io(stream, routes).await;
                    }
                });
            }
        });
        let client = |trusted: bool, ip: &str| {
            let mut builder = reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(2))
                .resolve(
                    "companion.example.test",
                    format!("{ip}:{}", address.port()).parse().unwrap(),
                );
            if trusted {
                builder = builder.add_root_certificate(
                    reqwest::Certificate::from_pem(certificate.ca.as_bytes()).unwrap(),
                );
            }
            builder.build().unwrap()
        };
        let normal = client(true, "127.0.0.2");
        let public = client(true, "127.0.0.1");
        let result = verification_with_fallback(
            verify_with_client(&app, &url, &normal),
            verify_with_client(&app, &url, &public),
            &Profile::Cloudflare,
        )
        .await
        .map_err(|e| e.1)
        .unwrap();
        assert_eq!(result, (url.origin().ascii_serialization(), true));
        assert!(
            verification_with_fallback(
                verify_with_client(&app, &url, &normal),
                verify_with_client(&app, &url, &public),
                &Profile::Lan
            )
            .await
            .is_err()
        );
        assert!(
            !verification_with_fallback(
                verify_with_client(&app, &url, &public),
                async { panic!("normal success must not depend on DoH") },
                &Profile::Cloudflare
            )
            .await
            .map_err(|e| e.1)
            .unwrap()
            .1
        );
        assert!(
            verify_with_client(&app, &url, &client(false, "127.0.0.1"))
                .await
                .is_err(),
            "TLS trust must never be disabled"
        );
        let mut wrong = app.clone();
        wrong.issuer = tokio::sync::watch::channel("https://other.example.test".into()).0;
        assert!(
            verify_with_client(&wrong, &url, &public).await.is_err(),
            "issuer must match"
        );
        let mut wrong_store = app.store.read().await.as_ref().unwrap().clone();
        wrong_store.s3_secret_key = "different-instance".into();
        wrong.store = Arc::new(tokio::sync::RwLock::new(Some(wrong_store)));
        assert!(
            verify_with_client(&wrong, &url, &public).await.is_err(),
            "installation proof must match"
        );
        wrong.issuer = app.issuer.clone();
        {
            let mut store = wrong.store.write().await;
            let store = store.as_mut().unwrap();
            store.s3_secret_key = "test-instance-secret".into();
            store.signing_key = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), 2048)
                .unwrap()
                .to_pkcs8_pem(Default::default())
                .unwrap()
                .to_string();
        }
        assert!(
            verify_with_client(&wrong, &url, &public).await.is_err(),
            "signing keys must match"
        );
        let wrong_host =
            url::Url::parse(&format!("https://other.example.test:{}", address.port())).unwrap();
        let wrong_host_client = reqwest::Client::builder()
            .no_proxy()
            .resolve("other.example.test", address)
            .add_root_certificate(
                reqwest::Certificate::from_pem(certificate.ca.as_bytes()).unwrap(),
            )
            .build()
            .unwrap();
        assert!(
            verify_with_client(&app, &wrong_host, &wrong_host_client)
                .await
                .is_err(),
            "certificate hostname must match"
        );
        server.abort();
    }
}
