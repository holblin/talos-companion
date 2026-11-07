//! Supervised provider clients bundled in Companion. No Docker socket or host control API.
use crate::{
    connections::*,
    model::{now, secret},
    omni::{Integration, Profile},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, Command},
};

struct Agent {
    control: PathBuf,
    state: PathBuf,
    companion: String,
    omni: String,
    s3: String,
}
impl Agent {
    fn socket_arg(&self) -> String {
        format!("--socket={}", self.state.join("tailscale.sock").display())
    }
    fn command(&self, binary: &str) -> Command {
        let mut command = Command::new(binary);
        command
            .env("HOME", &self.state)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        command
    }
    async fn output(&self, binary: &str, args: &[&str]) -> anyhow::Result<Vec<u8>> {
        let mut child = self.command(binary).args(args).spawn()?;
        let mut output = Vec::new();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Missing connector output"))?;
        tokio::time::timeout(Duration::from_secs(30), async {
            stdout.take(65537).read_to_end(&mut output).await?;
            anyhow::ensure!(output.len() <= 65536, "Connector output exceeded limit");
            anyhow::ensure!(child.wait().await?.success(), "Connector command failed; verify provider permissions, DNS conflicts, origin trust and connector installation");
            Ok::<_,anyhow::Error>(())
        }).await??;
        Ok(output)
    }
    fn status(
        &self,
        request: &ConnectionRequest,
        state: &str,
        message: &str,
        auth_url: Option<String>,
        integration: Option<Integration>,
    ) -> anyhow::Result<()> {
        write_json(
            &self.control.join("status.json"),
            &ConnectionStatus {
                id: request.id.clone(),
                profile: request.profile.clone(),
                state: state.into(),
                message: message.into(),
                auth_url,
                integration,
                expires_at: request.expires_at,
            },
        )
    }
    async fn authorize(
        &self,
        request: &ConnectionRequest,
        binary: &str,
        args: &[&str],
    ) -> anyhow::Result<()> {
        let mut command = self.command(binary);
        // Both official clients print their authorization URL to stderr.
        command.args(args).stderr(Stdio::piped());
        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Missing stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("Missing stderr"))?;
        let mut out = BufReader::new(stdout.take(65536)).lines();
        let mut err = BufReader::new(stderr.take(65536)).lines();
        let wait = async {
            let mut out_done = false;
            let mut err_done = false;
            while !out_done || !err_done {
                let line = tokio::select! {
                    line=out.next_line(), if !out_done => {let line=line?; out_done=line.is_none(); line},
                    line=err.next_line(), if !err_done => {let line=line?; err_done=line.is_none(); line},
                };
                if let Some(url) = line.as_deref().and_then(authorization_url) {
                    self.status(
                        request,
                        "authorizing",
                        "Continue in the provider's authorization page, then return here.",
                        Some(url),
                        None,
                    )?;
                }
            }
            anyhow::ensure!(
                child.wait().await?.success(),
                "Authorization did not finish. Try again and approve the provider's request."
            );
            Ok::<_, anyhow::Error>(())
        };
        tokio::time::timeout(
            Duration::from_secs(request.expires_at.saturating_sub(now())),
            wait,
        )
        .await??;
        Ok(())
    }
    async fn cloudflare(
        &self,
        request: &ConnectionRequest,
    ) -> anyhow::Result<(Integration, Child)> {
        anyhow::ensure!(domain(&request.domain), "Invalid Cloudflare domain");
        let cert = self.state.join(".cloudflared/cert.pem");
        if !cert.is_file() {
            self.authorize(request, "/usr/local/bin/cloudflared", &["tunnel", "login"])
                .await?;
        }
        anyhow::ensure!(
            cert.is_file(),
            "Cloudflare did not deliver an authorization certificate; authorize again"
        );
        self.status(
            request,
            "configuring",
            "Creating the tunnel and DNS records. Existing DNS records will not be overwritten.",
            None,
            None,
        )?;
        let cert = cert.to_string_lossy();
        let domain_id = hex::encode(Sha256::digest(request.domain.as_bytes()));
        let credential = self.state.join(format!("tunnel-{}.json", &domain_id[..16]));
        let credential_text = credential.to_string_lossy();
        let name_path = self.state.join("instance.json");
        let instance = if name_path.is_file() {
            read_json::<String>(&name_path)?
        } else {
            let id = secret();
            write_json(&name_path, &id)?;
            id
        };
        anyhow::ensure!(
            instance.len() == 64 && instance.bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid connector instance ID"
        );
        let name = format!("companion-{}-{}", &instance[..12], &domain_id[..16]);
        if !credential.is_file() {
            self.output(
                "/usr/local/bin/cloudflared",
                &[
                    "tunnel",
                    "--origincert",
                    &cert,
                    "create",
                    "--credentials-file",
                    &credential_text,
                    &name,
                ],
            )
            .await?;
        }
        let credentials: Value = read_json(&credential)?;
        let id = credentials["TunnelID"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing tunnel ID"))?;
        let hostnames = [
            format!("companion.{}", request.domain),
            format!("omni.{}", request.domain),
            format!("s3.{}", request.domain),
        ];
        for hostname in &hostnames {
            self.output(
                "/usr/local/bin/cloudflared",
                &[
                    "tunnel",
                    "--origincert",
                    &cert,
                    "route",
                    "dns",
                    id,
                    hostname,
                ],
            )
            .await?;
        }
        let config = self.state.join("cloudflare.json");
        let configuration = json!({"tunnel":id,"credentials-file":credential,"ingress":[
            {"hostname":hostnames[0],"service":"http://127.0.0.1:18081"},
            {"hostname":hostnames[1],"service":"http://127.0.0.1:18082"},
            {"hostname":hostnames[2],"service":"http://127.0.0.1:18083"},
            {"service":"http_status:404"}
        ]});
        write_json(&config, &configuration)?;
        self.output(
            "/usr/local/bin/cloudflared",
            &[
                "tunnel",
                "--config",
                &config.to_string_lossy(),
                "ingress",
                "validate",
            ],
        )
        .await?;
        let child = self.spawn_cloudflare(&config)?;
        let integration = Integration {
            profile: Profile::Cloudflare,
            companion_url: format!("https://{}", hostnames[0]),
            omni_url: format!("https://{}", hostnames[1]),
            s3_endpoint: format!("https://{}", hostnames[2]),
        };
        Ok((integration, child))
    }
    fn spawn_cloudflare(&self, config: &Path) -> anyhow::Result<Child> {
        Ok(self
            .command("/usr/local/bin/cloudflared")
            .args([
                "tunnel",
                "--config",
                &config.to_string_lossy(),
                "--no-autoupdate",
                "run",
            ])
            .stdout(Stdio::null())
            .spawn()?)
    }
    async fn tailscale(&self, request: &ConnectionRequest) -> anyhow::Result<Integration> {
        self.authorize(
            request,
            "/usr/local/bin/tailscale",
            &[
                &self.socket_arg(),
                "up",
                "--hostname=talos-companion",
                "--accept-dns=false",
                "--accept-routes=false",
            ],
        )
        .await?;
        let status: Value = serde_json::from_slice(
            &self
                .output(
                    "/usr/local/bin/tailscale",
                    &[&self.socket_arg(), "status", "--json"],
                )
                .await?,
        )?;
        anyhow::ensure!(
            status["BackendState"] == "Running",
            "Tailscale authorization is not complete"
        );
        let hostname = status["Self"]["DNSName"]
            .as_str()
            .unwrap_or("")
            .trim_end_matches('.');
        anyhow::ensure!(
            domain(hostname) && hostname.ends_with(".ts.net"),
            "Enable MagicDNS in your tailnet, then retry"
        );
        self.status(
            request,
            "configuring",
            "Enabling private HTTPS endpoints. Approve HTTPS in your tailnet if requested.",
            None,
            None,
        )?;
        for (port, origin) in [
            ("--https=443", "http://127.0.0.1:18081"),
            ("--https=8443", "http://127.0.0.1:18082"),
            ("--https=10000", "http://127.0.0.1:18083"),
        ] {
            self.authorize(
                request,
                "/usr/local/bin/tailscale",
                &[&self.socket_arg(), "serve", "--bg", port, origin],
            )
            .await?;
        }
        Ok(Integration {
            profile: Profile::Tailscale,
            companion_url: format!("https://{hostname}"),
            omni_url: format!("https://{hostname}:8443"),
            s3_endpoint: format!("https://{hostname}:10000"),
        })
    }
}

pub fn authorization_url(line: &str) -> Option<String> {
    for word in
        line.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '<' || c == '>')
    {
        let Ok(url) = url::Url::parse(word) else {
            continue;
        };
        if url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && matches!(
                url.host_str(),
                Some("dash.cloudflare.com" | "login.tailscale.com")
            )
        {
            return Some(url.to_string());
        }
    }
    None
}

#[derive(Clone)]
pub(crate) struct Proxy {
    pub dynamic: bool,
    pub origin: url::Url,
    pub client: reqwest::Client,
}
fn hop_header(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}
fn strip_hop_headers(headers: &mut hyper::HeaderMap) {
    let nominated = headers
        .get_all("connection")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(','))
        .map(|s| s.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();
    let remove = headers
        .keys()
        .filter(|k| hop_header(k.as_str()) || nominated.iter().any(|v| v == k.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    for name in remove {
        headers.remove(name);
    }
}
pub(crate) async fn forward(
    axum::extract::State(proxy): axum::extract::State<Proxy>,
    request: axum::extract::Request,
) -> std::result::Result<axum::response::Response, hyper::StatusCode> {
    let (parts, body) = request.into_parts();
    // Copy only path/query onto the fixed, operator-configured origin. Never join
    // a request URL, which could turn //attacker into a different destination.
    let mut url = proxy.origin;
    let mut client = proxy.client;
    if proxy.dynamic {
        let saved = settings();
        if saved.omni_origin.is_empty() {
            return Err(hyper::StatusCode::SERVICE_UNAVAILABLE);
        }
        url = url::Url::parse(&saved.omni_origin).map_err(|_| hyper::StatusCode::BAD_GATEWAY)?;
        let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
        if let Ok(bytes) = std::fs::read(private_dir().join("origin-ca.crt")) {
            builder = builder.add_root_certificate(
                reqwest::Certificate::from_pem(&bytes)
                    .map_err(|_| hyper::StatusCode::BAD_GATEWAY)?,
            );
        }
        client = builder
            .build()
            .map_err(|_| hyper::StatusCode::BAD_GATEWAY)?;
    }
    url.set_path(parts.uri.path());
    url.set_query(parts.uri.query());
    let mut headers = parts.headers;
    // Preserve Host for AWS SigV4. The fixed URL, not Host, chooses the peer and TLS name.
    strip_hop_headers(&mut headers);
    let upstream = client
        .request(parts.method, url)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
        .map_err(|_| hyper::StatusCode::BAD_GATEWAY)?;
    let status = upstream.status();
    let mut headers = upstream.headers().clone();
    strip_hop_headers(&mut headers);
    let mut response =
        axum::response::Response::new(axum::body::Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}
async fn heartbeat(agent: std::sync::Arc<Agent>) -> anyhow::Result<()> {
    loop {
        write_json(
            &agent.control.join("agent.json"),
            &json!({"updated_at":now(),"s3_origin":agent.s3,"omni_origin":settings().omni_origin,"companion_origin":agent.companion}),
        )?;
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn cloudflare_configured(state: &Path) -> bool {
    ["cloudflare-active.json", "active.json"]
        .iter()
        .any(|name| {
            read_json::<Integration>(&state.join(name))
                .is_ok_and(|i| i.profile == Profile::Cloudflare)
        })
        || state.join("cloudflare.json").is_file()
}

pub async fn run() -> anyhow::Result<()> {
    anyhow::ensure!(
        cfg!(target_os = "linux"),
        "Run provider connections in the Linux connector image"
    );
    let control = control_dir().ok_or_else(|| anyhow::anyhow!("Set CONNECTION_CONTROL_DIR"))?;
    let state = private_dir();
    std::fs::create_dir_all(&control)?;
    std::fs::create_dir_all(&state)?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join(".lock"))?;
    lock.try_lock()?;
    let source = |key: &str, default: &str| -> anyhow::Result<String> {
        let value = std::env::var(key).unwrap_or_else(|_| default.into());
        let url = url::Url::parse(&value)?;
        anyhow::ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.path() == "/"
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none(),
            "Connector origins must be HTTP(S) origins"
        );
        Ok(value)
    };
    let agent = std::sync::Arc::new(Agent {
        control: control.clone(),
        state,
        companion: source("COMPANION_ORIGIN", "http://127.0.0.1:8080")?,
        omni: if settings().omni_origin.is_empty() {
            "https://127.0.0.1:19443".into()
        } else {
            settings().omni_origin
        },
        s3: source("S3_ORIGIN", "http://127.0.0.1:9000")?,
    });
    let mut client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    if let Ok(bytes) = std::fs::read(private_dir().join("origin-ca.crt")) {
        client = client.add_root_certificate(reqwest::Certificate::from_pem(&bytes)?);
    }
    let client = client.build()?;
    let mut relays = tokio::task::JoinSet::new();
    for (port, origin) in [
        (18081, &agent.companion),
        (18082, &agent.omni),
        (18083, &agent.s3),
    ] {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
        let router = axum::Router::new().fallback(forward).with_state(Proxy {
            dynamic: port == 18082,
            origin: url::Url::parse(origin)?,
            client: client.clone(),
        });
        relays.spawn(async move { axum::serve(listener, router).await });
    }
    let mut daemon = agent
        .command("/usr/local/bin/tailscaled")
        .args([
            "--tun=userspace-networking",
            &format!("--state={}", agent.state.join("tailscaled.state").display()),
            &agent.socket_arg(),
            "--socks5-server=127.0.0.1:1055",
        ])
        .stdout(Stdio::null())
        .spawn()?;
    // Heartbeat runs during browser authorization as well as while idle.
    let mut heartbeat = tokio::spawn(heartbeat(agent.clone()));
    let mut tunnel: Option<Child> = None;
    if cloudflare_configured(&agent.state) {
        tunnel = Some(agent.spawn_cloudflare(&agent.state.join("cloudflare.json"))?);
    }
    let mut last = read_json::<ConnectionStatus>(&control.join("status.json"))
        .ok()
        .filter(|s| matches!(s.state.as_str(), "connected" | "failed"))
        .map(|s| s.id)
        .unwrap_or_default();
    loop {
        anyhow::ensure!(daemon.try_wait()?.is_none(), "Tailscale daemon stopped");
        if let Some(child) = tunnel.as_mut()
            && child.try_wait()?.is_some()
        {
            tunnel = Some(agent.spawn_cloudflare(&agent.state.join("cloudflare.json"))?);
        }
        if let Ok(request) = read_json::<ConnectionRequest>(&control.join("request.json"))
            && request.id != last
            && request.expires_at > now()
        {
            last = request.id.clone();
            agent.status(
                &request,
                "starting",
                "Starting provider authorization",
                None,
                None,
            )?;
            let operation = tokio::time::timeout(
                Duration::from_secs(request.expires_at.saturating_sub(now())),
                async {
                    match request.profile {
                        Profile::Cloudflare => {
                            let (integration, child) = agent.cloudflare(&request).await?;
                            if let Some(mut old) = tunnel.take() {
                                let _ = old.kill().await;
                            }
                            tunnel = Some(child);
                            Ok(integration)
                        }
                        Profile::Tailscale => agent.tailscale(&request).await,
                        Profile::Lan => {
                            anyhow::bail!("LAN does not require provider authorization")
                        }
                    }
                },
            );
            let result = tokio::select! {
                result=operation=>result.unwrap_or_else(|_|Err(anyhow::anyhow!("Connection request expired. Start again; already-created provider resources are preserved."))),
                _=async {loop {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    if !read_json::<ConnectionRequest>(&control.join("request.json")).is_ok_and(|current|current.id==request.id && current.expires_at>now()) {break;}
                }}=>Err(anyhow::anyhow!("Connection canceled. Existing provider resources are preserved.")),
            };
            match result {
                Ok(integration) => {
                    write_json(&provider_path(&integration.profile), &integration)?;
                    write_json(&agent.state.join("active.json"), &integration)?;
                    agent.status(&request,"connected","Provider routes configured. Run live checks before applying Omni settings. Existing provider routes remain until removed in that provider.",None,Some(integration))?;
                }
                Err(error) => {
                    agent.status(&request, "failed", &error.to_string(), None, None)?;
                }
            }
        }
        tokio::select! {
            _=tokio::time::sleep(Duration::from_secs(1))=>{},
            result=&mut heartbeat=>{result??; anyhow::bail!("Connector heartbeat stopped");},
            _=relays.join_next()=>{anyhow::bail!("Connector relay stopped");},
            _=tokio::signal::ctrl_c()=>{heartbeat.abort();return Ok(());},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cloudflare_restart_is_independent_of_the_last_authorized_provider() {
        let state = tempfile::tempdir().unwrap();
        let tailscale = Integration {
            profile: Profile::Tailscale,
            ..Default::default()
        };
        write_json(&state.path().join("active.json"), &tailscale).unwrap();
        assert!(!cloudflare_configured(state.path()));
        // Older installations may have only the tunnel config plus the last Tailscale record.
        write_json(
            &state.path().join("cloudflare.json"),
            &json!({"tunnel":"existing"}),
        )
        .unwrap();
        assert!(cloudflare_configured(state.path()));
    }
    #[tokio::test]
    async fn relay_preserves_signed_host_and_streams_before_the_upstream_finishes() {
        use tokio::io::AsyncWriteExt;
        let (writer, reader) = tokio::io::duplex(1024);
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let producer = tokio::spawn(async move {
            let mut writer = writer;
            writer.write_all(b"first chunk").await.unwrap();
            finish_rx.await.unwrap();
            writer.write_all(b"last chunk").await.unwrap();
        });
        let body = std::sync::Arc::new(tokio::sync::Mutex::new(Some(reader)));
        let upstream = axum::Router::new().fallback(move |request: axum::extract::Request| {
            let body = body.clone();
            async move {
                assert_eq!(request.headers()["host"], "public.example.test:10000");
                assert!(request.headers().get("x-drop").is_none());
                assert_eq!(request.uri().path(), "//other.example.test/object");
                let reader = body.lock().await.take().unwrap();
                axum::response::Response::new(axum::body::Body::from_stream(
                    tokio_util::io::ReaderStream::new(reader),
                ))
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let origin = tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let proxy = axum::Router::new().fallback(forward).with_state(Proxy {
            dynamic: false,
            origin: url::Url::parse(&format!("http://{address}")).unwrap(),
            client: reqwest::Client::new(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let relay = tokio::spawn(async move {
            axum::serve(listener, proxy).await.unwrap();
        });
        let mut response = tokio::time::timeout(
            Duration::from_secs(3),
            reqwest::Client::new()
                .get(format!("http://{address}//other.example.test/object"))
                .header("host", "public.example.test:10000")
                .header("connection", "x-drop")
                .header("x-drop", "discard")
                .send(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), response.chunk())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .as_ref(),
            b"first chunk"
        );
        finish_tx.send(()).unwrap();
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"last chunk");
        producer.await.unwrap();
        relay.abort();
        origin.abort();
    }
    #[test]
    fn only_official_https_authorization_links_are_exposed() {
        assert!(authorization_url("Visit https://login.tailscale.com/a/test-only").is_some());
        assert!(
            authorization_url("https://dash.cloudflare.com/argotunnel?callback=test-only")
                .is_some()
        );
        for line in [
            "https://login.tailscale.com.attacker.test/a",
            "http://login.tailscale.com/a",
            "https://user@login.tailscale.com/a",
            "https://login.tailscale.com:444/a",
        ] {
            assert!(authorization_url(line).is_none());
        }
    }
}
