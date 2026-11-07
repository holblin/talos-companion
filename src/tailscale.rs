//! LocalAPI client for the pinned tailscaled runtime. Never exposes its socket over TCP.
use anyhow::Context;
use reqwest::{Client, Method, Response};
use serde_json::{Value, json};
use std::path::Path;

pub(crate) struct LocalApi {
    client: Client,
    origin: String,
}

impl LocalApi {
    pub fn new(_socket: &Path) -> anyhow::Result<Self> {
        #[cfg(unix)]
        {
            Ok(Self {
                client: Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(std::time::Duration::from_secs(10))
                    .unix_socket(_socket)
                    .build()?,
                origin: "http://local-tailscaled.sock".into(),
            })
        }
        #[cfg(not(unix))]
        anyhow::bail!("Built-in Tailscale connections require the Linux image")
    }

    async fn request(
        &self,
        method: Method,
        endpoint: &str,
        body: Option<&Value>,
        etag: Option<&str>,
    ) -> anyhow::Result<Response> {
        let mut request = self
            .client
            .request(method, format!("{}/localapi/v0/{endpoint}", self.origin));
        if let Some(body) = body {
            request = request.json(body);
        }
        if let Some(etag) = etag {
            request = request.header(reqwest::header::IF_MATCH, etag);
        }
        let response = request
            .send()
            .await
            .context("Could not contact tailscaled")?;
        // Do not include daemon response bodies: they can contain identity or auth data.
        anyhow::ensure!(
            response.status().is_success(),
            "Tailscale {endpoint} request failed (HTTP {})",
            response.status().as_u16()
        );
        Ok(response)
    }

    #[cfg(test)]
    pub fn for_test(origin: String) -> Self {
        Self {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            origin,
        }
    }

    async fn json(mut response: Response) -> anyhow::Result<Value> {
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            anyhow::ensure!(
                bytes.len() + chunk.len() <= 1_048_576,
                "Tailscale response too large"
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub async fn status(&self) -> anyhow::Result<Value> {
        Self::json(
            self.request(Method::GET, "status?peers=false", None, None)
                .await?,
        )
        .await
    }

    pub async fn set_hostname(&self, name: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            crate::connections::domain(&format!("{name}.ts.net")) && !name.contains('.'),
            "Invalid Tailscale device name"
        );
        self.request(
            Method::PATCH,
            "prefs",
            Some(&json!({"Hostname":name,"HostnameSet":true})),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn start(&self, hostname: &str) -> anyhow::Result<()> {
        self.request(Method::POST, "start", Some(&json!({})), None)
            .await?;
        // Mask only the preferences this application owns; preserve the saved identity.
        self.request(
            Method::PATCH,
            "prefs",
            Some(&json!({
                "WantRunning": true, "WantRunningSet": true,
                "Hostname": hostname, "HostnameSet": true,
                "CorpDNS": false, "CorpDNSSet": true,
                "RouteAll": false, "RouteAllSet": true
            })),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn login(&self) -> anyhow::Result<()> {
        self.request(Method::POST, "login-interactive", None, None)
            .await?;
        Ok(())
    }

    pub async fn enable_https(&self) -> anyhow::Result<Value> {
        Self::json(
            self.request(Method::POST, "query-feature?feature=serve", None, None)
                .await?,
        )
        .await
    }

    pub async fn serve(&self, hostname: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            crate::connections::domain(hostname) && hostname.ends_with(".ts.net"),
            "Invalid Tailscale hostname"
        );
        let response = self
            .request(Method::GET, "serve-config", None, None)
            .await?;
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .context("Tailscale serve configuration has no ETag")?
            .to_str()?
            .to_owned();
        let mut config = Self::json(response).await?;
        if config.is_null() {
            config = json!({});
        }
        anyhow::ensure!(config.is_object(), "Invalid Tailscale serve configuration");
        for (port, origin) in [(443, 18081), (8443, 18082), (10000, 18083)] {
            config["TCP"][port.to_string()] = json!({"HTTPS": true});
            let host_port = format!("{hostname}:{port}");
            config["Web"][&host_port] =
                json!({"Handlers": {"/": {"Proxy": format!("http://127.0.0.1:{origin}")}}});
            if let Some(funnel) = config.get_mut("AllowFunnel").and_then(Value::as_object_mut) {
                funnel.remove(&host_port);
            }
        }
        self.request(Method::POST, "serve-config", Some(&config), Some(&etag))
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        extract::Request,
        response::Response,
    };
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn protocol_preserves_identity_and_unrelated_routes_and_uses_etag() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let captured = seen.clone();
        let router = Router::new().fallback(move |request: Request| {
            let captured = captured.clone();
            async move {
                let (parts, body) = request.into_parts();
                let body = to_bytes(body, 65536).await.unwrap();
                let value: Value = if body.is_empty() { Value::Null } else { serde_json::from_slice(&body).unwrap() };
                captured.lock().unwrap().push((parts.method.clone(), parts.uri.to_string(), parts.headers, value));
                let response = match (parts.method.as_str(), parts.uri.path()) {
                    ("GET", "/localapi/v0/status") => json!({"BackendState":"Running", "Self":{"DNSName":"companion.example.ts.net."}}),
                    ("GET", "/localapi/v0/serve-config") => json!({
                        "TCP":{"9443":{"HTTPS":true}},
                        "Web":{"other.example.ts.net:9443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9999"}}}},
                        "AllowFunnel":{"companion.example.ts.net:443":true,"other.example.ts.net:9443":true}
                    }),
                    ("POST", "/localapi/v0/query-feature") => json!({"Complete":true}),
                    _ => json!({}),
                };
                Response::builder().header("etag", "\"saved-config\"").body(Body::from(response.to_string())).unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = LocalApi::for_test(format!("http://{}", listener.local_addr().unwrap()));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        api.start("talos-companion").await.unwrap();
        api.login().await.unwrap();
        assert_eq!(api.status().await.unwrap()["BackendState"], "Running");
        assert_eq!(api.enable_https().await.unwrap()["Complete"], true);
        api.serve("companion.example.ts.net").await.unwrap();
        {
            let requests = seen.lock().unwrap();
            assert_eq!(requests[0].1, "/localapi/v0/start");
            assert_eq!(
                requests[0].3,
                json!({}),
                "starting must not reset saved identity"
            );
            assert_eq!(requests[1].0, Method::PATCH);
            assert_eq!(
                requests[1].3,
                json!({
                    "WantRunning":true,"WantRunningSet":true,"Hostname":"talos-companion","HostnameSet":true,
                    "CorpDNS":false,"CorpDNSSet":true,"RouteAll":false,"RouteAllSet":true
                })
            );
            assert_eq!(requests[2].1, "/localapi/v0/login-interactive");
            assert_eq!(requests[3].1, "/localapi/v0/status?peers=false");
            assert_eq!(requests[4].1, "/localapi/v0/query-feature?feature=serve");
            let (_, _, headers, config) = requests.last().unwrap();
            assert_eq!(headers["if-match"], "\"saved-config\"");
            for (port, origin) in [(443, 18081), (8443, 18082), (10000, 18083)] {
                assert_eq!(config["TCP"][port.to_string()], json!({"HTTPS":true}));
                assert_eq!(
                    config["Web"][format!("companion.example.ts.net:{port}")]["Handlers"]["/"]["Proxy"],
                    format!("http://127.0.0.1:{origin}")
                );
            }
            assert_eq!(config["TCP"]["9443"]["HTTPS"], true);
            assert_eq!(config["AllowFunnel"]["other.example.ts.net:9443"], true);
            assert!(
                config["AllowFunnel"]
                    .get("companion.example.ts.net:443")
                    .is_none()
            );
        }
        api.set_hostname("renamed-companion").await.unwrap();
        {
            let requests = seen.lock().unwrap();
            let (method, endpoint, _, body) = requests.last().unwrap();
            assert_eq!(method, Method::PATCH);
            assert_eq!(endpoint, "/localapi/v0/prefs");
            assert_eq!(
                body,
                &json!({"Hostname":"renamed-companion","HostnameSet":true})
            );
        }
        assert!(api.set_hostname("new.other.ts.net").await.is_err());
        server.abort();
    }

    #[tokio::test]
    async fn daemon_errors_do_not_expose_auth_data_and_responses_are_bounded() {
        let router = Router::new().fallback(|request: Request| async move {
            if request.uri().path().ends_with("status") {
                Response::builder()
                    .body(Body::from("x".repeat(1_048_577)))
                    .unwrap()
            } else {
                Response::builder()
                    .status(412)
                    .body(Body::from("private-auth-token"))
                    .unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = LocalApi::for_test(format!("http://{}", listener.local_addr().unwrap()));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        assert!(
            api.status()
                .await
                .unwrap_err()
                .to_string()
                .contains("too large")
        );
        let error = api.login().await.unwrap_err().to_string();
        assert!(error.contains("412"));
        assert!(!error.contains("private-auth-token"));
        assert!(api.serve("attacker.example/route").await.is_err());
        server.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn production_transport_uses_only_the_private_unix_socket() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("tailscale.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .fallback(|| async { axum::Json(json!({"BackendState":"NeedsLogin"})) }),
            )
            .await
            .unwrap();
        });
        let api = LocalApi::new(&socket).unwrap();
        assert_eq!(api.status().await.unwrap()["BackendState"], "NeedsLogin");
        server.abort();
    }
}
