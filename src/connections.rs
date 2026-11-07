//! Private control channel to bundled provider clients. No Docker/host socket.
use crate::{
    auth,
    model::*,
    omni::{Integration, Profile},
};
use axum::{Json, extract::State, http::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionRequest {
    pub id: String,
    pub profile: Profile,
    pub domain: String,
    #[serde(default)]
    pub companion_url: String,
    pub expires_at: u64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct ConnectionStatus {
    pub id: String,
    pub state: String,
    pub profile: Profile,
    pub auth_url: Option<String>,
    pub integration: Option<Integration>,
    pub message: String,
    pub expires_at: u64,
}

pub fn control_dir() -> Option<PathBuf> {
    Some(
        std::env::var_os("CONNECTION_CONTROL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| root().join("control")),
    )
}
pub fn root() -> PathBuf {
    PathBuf::from(std::env::var_os("DATA_DIR").unwrap_or_else(|| "data".into())).join("connections")
}
pub fn private_dir() -> PathBuf {
    root().join("private")
}
pub fn settings_path() -> PathBuf {
    root().join("settings.json")
}
#[derive(Default, Deserialize, Serialize)]
pub struct Settings {
    pub omni_origin: String,
    pub integration: Option<Integration>,
    #[serde(default)]
    pub accesses: Vec<AccessMethod>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct AccessMethod {
    pub integration: Integration,
    pub verified_at: u64,
    #[serde(default)]
    pub local_dns_pending: bool,
}
pub fn provider_path(profile: &Profile) -> PathBuf {
    private_dir().join(match profile {
        Profile::Lan => "lan-active.json",
        Profile::Cloudflare => "cloudflare-active.json",
        Profile::Tailscale => "tailscale-active.json",
    })
}
pub fn settings() -> Settings {
    read_json(&settings_path()).unwrap_or_default()
}
pub fn private_directory(path: &Path) -> anyhow::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
pub fn bundled() -> bool {
    !bundled_providers().is_empty()
}
pub fn provider_bundled(profile: &Profile) -> bool {
    cfg!(target_os = "linux")
        && match profile {
            Profile::Cloudflare => Path::new("/usr/local/bin/cloudflared").is_file(),
            Profile::Tailscale => Path::new("/usr/local/bin/tailscaled").is_file(),
            Profile::Lan => false,
        }
}
pub fn bundled_providers() -> Vec<Profile> {
    [Profile::Cloudflare, Profile::Tailscale]
        .into_iter()
        .filter(provider_bundled)
        .collect()
}
pub async fn supervise() {
    if !bundled() {
        std::future::pending::<()>().await;
        return;
    }
    loop {
        let result = async {
            private_directory(&root())?;
            private_directory(&private_dir())?;
            private_directory(
                &control_dir().ok_or_else(|| anyhow::anyhow!("Missing connection directory"))?,
            )?;
            let mut child = tokio::process::Command::new(std::env::current_exe()?)
                .arg("--connection-agent")
                .kill_on_drop(true)
                .stdout(std::process::Stdio::null())
                .spawn()?;
            child.wait().await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            tracing::warn!(%error,"Connection service restarting");
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}
pub fn write_json(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    let mut file = tempfile::NamedTempFile::new_in(
        path.parent()
            .ok_or_else(|| anyhow::anyhow!("Missing control directory"))?,
    )?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    Ok(())
}
pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    anyhow::ensure!(
        std::fs::symlink_metadata(path)?.is_file(),
        "Control record must be a regular file"
    );
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(65537)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(bytes.len() <= 65536, "Control record too large");
    Ok(serde_json::from_slice(&bytes)?)
}
pub fn agent_info() -> Option<Value> {
    let dir = control_dir()?;
    let value: Value = read_json(&dir.join("agent.json")).ok()?;
    (value["updated_at"].as_u64()?.saturating_add(15) > now()).then_some(value)
}
pub fn provider_available(profile: &Profile) -> bool {
    agent_info()
        .and_then(|agent| agent["providers"].as_array().cloned())
        .is_some_and(|providers| providers.contains(&json!(profile)))
}
fn pending(dir: &Path) -> Option<ConnectionStatus> {
    let request: ConnectionRequest = read_json(&dir.join("request.json")).ok()?;
    let mut status: ConnectionStatus = read_json(&dir.join("status.json")).unwrap_or_default();
    if status.id != request.id {
        status = ConnectionStatus {
            id: request.id,
            profile: request.profile,
            state: "starting".into(),
            message: "Starting provider authorization".into(),
            expires_at: request.expires_at,
            ..Default::default()
        };
    }
    status.expires_at = status.expires_at.min(request.expires_at);
    if status.expires_at <= now()
        && matches!(
            status.state.as_str(),
            "starting" | "authorizing" | "configuring"
        )
    {
        status.state = "expired".into();
        status.auth_url = None;
        status.message = "Authorization expired. Start the connection again.".into();
    }
    Some(status)
}
pub async fn get(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    auth::admin(&app, &headers).await?;
    let agent = agent_info();
    let status = control_dir().and_then(|dir| pending(&dir));
    let mut backend = settings().omni_origin;
    if backend.is_empty() {
        backend = app
            .store
            .read()
            .await
            .as_ref()
            .and_then(|store| url::Url::parse(&store.redirect_uri).ok())
            .filter(|url| matches!(url.scheme(), "http" | "https"))
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_default();
    }
    Ok(Json(
        json!({"available":agent.is_some(),"bundled":bundled(),"providers":agent.as_ref().and_then(|a|a.get("providers")).cloned().unwrap_or_else(||json!(bundled_providers())),"connection":status,"backend_origin":backend,"saved":settings().integration}),
    ))
}
pub async fn cancel(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let _serial = app.backup_lock.lock().await;
    if let Some(dir) = control_dir()
        && let Ok(mut request) = read_json::<ConnectionRequest>(&dir.join("request.json"))
    {
        request.expires_at = now();
        write_json(&dir.join("request.json"), &request)?;
    }
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    profile: Profile,
    #[serde(default)]
    domain: String,
    #[serde(default)]
    companion_url: String,
}
pub fn provider_hostname(value: &str) -> anyhow::Result<String> {
    let url = url::Url::parse(value.trim())?;
    let host = url.host_str().unwrap_or("");
    anyhow::ensure!(
        url.scheme() == "https"
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && domain(host),
        "Use an HTTPS hostname without a port, path, query or credentials"
    );
    Ok(host.to_owned())
}

pub fn tailscale_name(current: &str, requested: &str) -> anyhow::Result<String> {
    let (name, suffix) = requested.split_once('.').unwrap_or_default();
    let (_, current_suffix) = current.split_once('.').unwrap_or_default();
    anyhow::ensure!(
        domain(requested)
            && current.ends_with(".ts.net")
            && suffix == current_suffix
            && !name.is_empty(),
        "Change only the device name within the current Tailscale tailnet"
    );
    Ok(name.to_owned())
}
pub fn domain(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}
pub async fn start(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Start>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let _serial = app.backup_lock.lock().await;
    let agent = agent_info();
    if agent.is_none() {
        return Err(bad(
            "The built-in connection service is starting. Try again shortly. Cloudflare and Tailscale require the current Companion Docker image.",
        ));
    }
    if input.profile == Profile::Lan
        || input.domain.len() > 240
        || (input.profile == Profile::Cloudflare
            && !input.domain.is_empty()
            && !domain(&input.domain))
    {
        return Err(bad(
            "Choose Cloudflare or Tailscale. An optional domain override must be a domain such as example.com, without https:// or a path.",
        ));
    }
    if !agent
        .as_ref()
        .and_then(|a| a["providers"].as_array())
        .is_some_and(|providers| providers.contains(&json!(input.profile)))
    {
        return Err(bad(
            "This image does not include the selected connector. Use the default image or the variant that includes this provider.",
        ));
    }
    let dir = control_dir().ok_or_else(|| bad("Connector control directory is not configured"))?;
    if !input.companion_url.is_empty() {
        let host = provider_hostname(&input.companion_url).map_err(|e| bad(&e.to_string()))?;
        let current: Integration = read_json(&provider_path(&input.profile))
            .map_err(|_| bad("Connect this provider before updating its hostname"))?;
        if input.profile == Profile::Tailscale {
            let old = provider_hostname(&current.companion_url).map_err(|e| bad(&e.to_string()))?;
            tailscale_name(&old, &host).map_err(|e| bad(&e.to_string()))?;
            if old != host && app.issuer() == current.companion_url {
                return Err(bad(
                    "Select another verified Companion access method for Omni before renaming its active Tailscale device",
                ));
            }
            if old != host
                && headers
                    .get("origin")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|value| url::Url::parse(value).ok())
                    .is_some_and(|origin| origin.host_str() == Some(old.as_str()))
            {
                return Err(bad(
                    "Open Companion through Local HTTPS or Cloudflare before renaming Tailscale, so this page stays connected during the update",
                ));
            }
        }
    }
    if pending(&dir)
        .is_some_and(|s| matches!(s.state.as_str(), "starting" | "authorizing" | "configuring"))
    {
        return Err(bad(
            "A connection is already in progress. Finish authorization or wait for it to expire.",
        ));
    }
    let request = ConnectionRequest {
        id: uuid::Uuid::new_v4().to_string(),
        profile: input.profile,
        domain: input.domain.to_ascii_lowercase(),
        companion_url: input.companion_url.trim().to_owned(),
        expires_at: now() + 600,
    };
    write_json(&dir.join("request.json"), &request)?;
    Ok(Json(json!({"id":request.id})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Location {
    address: String,
    #[serde(default)]
    certificate: String,
}
pub fn normalize_address(value: &str) -> anyhow::Result<String> {
    let value = value.trim();
    let input = if value.contains("://") {
        value.into()
    } else {
        format!("https://{value}")
    };
    let url = url::Url::parse(&input)?;
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none(),
        "Enter the address you use to open Omni"
    );
    Ok(url.origin().ascii_serialization())
}
pub async fn location(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Location>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let _serial = app.backup_lock.lock().await;
    if control_dir()
        .and_then(|dir| pending(&dir))
        .is_some_and(|s| matches!(s.state.as_str(), "starting" | "authorizing" | "configuring"))
    {
        return Err(bad(
            "Finish the current authorization before changing Omni’s address",
        ));
    }
    let origin = normalize_address(&input.address)
        .map_err(|_| bad("Enter the address you use to open Omni, such as omni.example.com"))?;
    if input.certificate.contains("PRIVATE KEY") {
        return Err(bad(
            "Use the public trust certificate only. Private keys are not accepted.",
        ));
    }
    if input.certificate.len() > 32768 {
        return Err(bad("Trust certificate is too large"));
    }
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none());
    let saved_ca = std::fs::read(private_dir().join("origin-ca.crt")).unwrap_or_default();
    let certificate = if input.certificate.trim().is_empty() {
        saved_ca
    } else {
        input.certificate.as_bytes().to_vec()
    };
    if !certificate.is_empty() {
        builder = builder
            .add_root_certificate(reqwest::Certificate::from_pem(&certificate).map_err(|_| {
                bad("Upload a public PEM trust certificate, without a private key")
            })?);
    }
    let response=builder.build().map_err(anyhow::Error::from)?.get(&origin).send().await.map_err(|_|bad("Could not reach Omni. Check its address. If it uses a private certificate, add its public trust certificate in Advanced settings."))?;
    if !response.status().is_success() && !response.status().is_redirection() {
        return Err(bad(
            "Omni did not respond successfully. Check the address and try again.",
        ));
    }
    private_directory(&root())?;
    private_directory(&private_dir())?;
    if !input.certificate.trim().is_empty() {
        let mut file =
            tempfile::NamedTempFile::new_in(private_dir()).map_err(anyhow::Error::from)?;
        file.write_all(&certificate).map_err(anyhow::Error::from)?;
        file.persist(private_dir().join("origin-ca.crt"))
            .map_err(anyhow::Error::from)?;
    }
    let mut settings = settings();
    settings.omni_origin = origin.clone();
    write_json(&settings_path(), &settings)?;
    Ok(Json(json!({"origin":origin})))
}
pub async fn finish(
    State(app): State<App>,
    headers: HeaderMap,
    Json(mut integration): Json<Integration>,
) -> Result<Json<Value>> {
    for value in [
        &mut integration.companion_url,
        &mut integration.omni_url,
        &mut integration.s3_endpoint,
    ] {
        *value = crate::endpoint_checks::origin(value)
            .map_err(|_| bad("Use a service address without a path or credentials"))?
            .origin()
            .ascii_serialization();
    }
    let checks =
        crate::endpoint_checks::run(State(app.clone()), headers, Json(integration.clone()))
            .await?
            .0;
    if !checks["checks"]
        .as_array()
        .is_some_and(|rows| rows.len() == 3 && rows.iter().all(|row| row["ok"] == true))
    {
        return Err(bad(
            "Some services could not be verified. Check the results and try again.",
        ));
    }
    let _serial = app.backup_lock.lock().await;
    private_directory(&root())?;
    let mut saved = settings();
    saved.integration = Some(integration);
    write_json(&settings_path(), &saved)?;
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    #[test]
    fn provider_edits_accept_only_https_origins_and_same_tailnet_names() {
        assert_eq!(
            provider_hostname("https://new.example.test/").unwrap(),
            "new.example.test"
        );
        for url in [
            "http://new.example.test",
            "https://new.example.test:8443",
            "https://user@new.example.test",
            "https://new.example.test/path",
            "https://new.example.test?q=1",
            "https://new.example.test/#x",
        ] {
            assert!(provider_hostname(url).is_err(), "{url}");
        }
        assert_eq!(
            tailscale_name("old.tail.ts.net", "new.tail.ts.net").unwrap(),
            "new"
        );
        assert!(tailscale_name("old.tail.ts.net", "new.other.ts.net").is_err());
        assert!(tailscale_name("old.tail.ts.net", "new.tail.ts.net.attacker.test").is_err());
    }
    use super::*;
    #[test]
    fn wizard_accepts_an_ordinary_hostname_or_pasted_omni_page() {
        assert_eq!(
            normalize_address("omni.example.com").unwrap(),
            "https://omni.example.com"
        );
        assert_eq!(
            normalize_address("http://192.0.2.10:8080/login?next=overview").unwrap(),
            "http://192.0.2.10:8080"
        );
        assert!(normalize_address("https://user:secret@example.com").is_err());
        assert!(normalize_address("file:///etc/passwd").is_err());
    }
    #[test]
    fn domains_cannot_inject_routes_or_command_flags() {
        assert!(domain("lab.example.com"));
        for value in [
            "--overwrite-dns",
            "https://example.com",
            "example.com/path",
            "*.example.com",
            "a..com",
            "-a.example.com",
        ] {
            assert!(!domain(value));
        }
    }
    #[test]
    fn old_status_does_not_complete_a_new_request_and_expiry_is_explicit() {
        let dir = tempfile::tempdir().unwrap();
        write_json(
            &dir.path().join("request.json"),
            &ConnectionRequest {
                id: "new".into(),
                profile: Profile::Tailscale,
                domain: String::new(),
                companion_url: String::new(),
                expires_at: now() + 60,
            },
        )
        .unwrap();
        write_json(
            &dir.path().join("status.json"),
            &ConnectionStatus {
                id: "old".into(),
                state: "connected".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(pending(dir.path()).unwrap().state, "starting");
        let mut request: ConnectionRequest = read_json(&dir.path().join("request.json")).unwrap();
        request.expires_at = 0;
        write_json(&dir.path().join("request.json"), &request).unwrap();
        assert_eq!(pending(dir.path()).unwrap().state, "expired");
    }
}
