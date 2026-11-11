//! Scoped Omni configuration reconciliation. No Docker socket or host shell access.
use crate::{auth, model::*};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, header},
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path};

const MANAGED: &str = "/omni-managed";
const LIMIT: usize = 256 * 1024;
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Profile {
    #[default]
    Lan,
    Cloudflare,
    Tailscale,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Integration {
    pub profile: Profile,
    pub companion_url: String,
    pub omni_url: String,
    pub s3_endpoint: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub integration: Integration,
    #[serde(default)]
    pub primary_config: String,
    pub revision: Option<String>,
}
fn origin(value: &str) -> Result<String> {
    let u = url::Url::parse(value).map_err(|_| bad("Enter a complete HTTPS origin"))?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || u.path() != "/"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err(bad(
            "Use an HTTPS origin without a path, credentials, query or fragment",
        ));
    }
    Ok(u.as_str().trim_end_matches('/').to_string())
}
fn validate(i: &Integration) -> Result<()> {
    origin(&i.companion_url)?;
    origin(&i.omni_url)?;
    let u = url::Url::parse(&i.s3_endpoint).map_err(|_| bad("Invalid S3 endpoint"))?;
    if !matches!(u.scheme(), "http" | "https")
        || u.host_str().is_none()
        || u.path() != "/"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err(bad(
            "S3 endpoint must be an HTTP(S) origin without credentials or a path",
        ));
    }
    if i.profile == Profile::Tailscale
        && !url::Url::parse(&i.companion_url)
            .map_err(|_| bad("Invalid URL"))?
            .host_str()
            .is_some_and(|s| s.ends_with(".ts.net"))
    {
        return Err(bad("Tailscale HTTPS uses your device's .ts.net hostname"));
    }
    Ok(())
}
fn parse(text: &str) -> Result<Value> {
    if text.len() > LIMIT {
        return Err(bad("Omni configuration exceeds 256 KiB"));
    }
    let value: Value = if text.trim().is_empty() {
        json!({})
    } else {
        let yaml: serde_yaml_ng::Value = serde_yaml_ng::from_str(text).map_err(|_|bad("Invalid YAML/JSON. Use one mapping document with string keys; duplicate keys are rejected."))?;
        serde_json::to_value(yaml).map_err(|_| bad("Use plain YAML with string mapping keys"))?
    };
    if !value.is_object() {
        return Err(bad("Omni configuration must be a mapping"));
    }
    Ok(value)
}
fn merge(target: &mut Value, overlay: &Value) {
    if let (Some(a), Some(b)) = (target.as_object_mut(), overlay.as_object()) {
        for (k, v) in b {
            merge(a.entry(k).or_insert(Value::Null), v);
        }
    } else {
        *target = overlay.clone();
    }
}
fn overlay(store: &Store, i: &Integration) -> Value {
    json!({"auth":{"auth0":{"enabled":false},"saml":{"enabled":false},"webauthn":{"enabled":false},"oidc":{"enabled":true,"providerURL":i.companion_url.trim_end_matches('/'),"clientID":store.client_id,"clientSecret":store.client_secret,"scopes":["openid","email","profile"]}},"etcdBackup":{"s3Enabled":true,"localPath":null}})
}
fn differences(source: &Value, expected: &Value, prefix: &str, out: &mut Vec<String>) {
    if let Some(map) = expected.as_object() {
        for (k, v) in map {
            let path = if prefix.is_empty() {
                k.clone()
            } else {
                format!("{prefix}.{k}")
            };
            differences(&source[k], v, &path, out);
        }
    } else if source != expected {
        out.push(prefix.into());
    }
}
fn read_optional(path: &Path) -> Result<Vec<u8>> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if !m.file_type().is_file() || m.len() > LIMIT as u64 => Err(bad(
            "Managed config must be a regular file smaller than 256 KiB",
        )),
        Ok(_) => std::fs::read(path)
            .map_err(anyhow::Error::from)
            .map_err(Into::into),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(anyhow::Error::from(e).into()),
    }
}
fn plan(store: &Store, req: &Request, directory: &Path) -> Result<Value> {
    validate(&req.integration)?;
    let file = read_optional(&directory.join("companion.yaml"))?;
    let primary = if req.primary_config.trim().is_empty() {
        read_optional(&directory.join("imported-primary.yaml"))?
    } else {
        req.primary_config.as_bytes().to_vec()
    };
    let source_text = std::str::from_utf8(&primary).map_err(|_| bad("Config must be UTF-8"))?;
    let mut effective = parse(source_text)?;
    if !file.is_empty() {
        merge(
            &mut effective,
            &parse(std::str::from_utf8(&file).map_err(|_| bad("Config must be UTF-8"))?)?,
        );
    }
    let desired = overlay(store, &req.integration);
    let mut changes = vec![];
    differences(&effective, &desired, "", &mut changes);
    let mut hash = Sha256::new();
    hash.update(serde_json::to_vec(store).map_err(anyhow::Error::from)?);
    hash.update(&file);
    hash.update(&primary);
    hash.update(serde_json::to_vec(&req.integration).map_err(anyhow::Error::from)?);
    let s3 = json!({"metadata":{"namespace":"default","type":"EtcdBackupS3Configs.omni.sidero.dev","id":"etcd-backup-s3-conf"},"spec":{"bucket":"omni","region":"us-east-1","endpoint":req.integration.s3_endpoint,"accesskeyid":store.s3_access_key,"secretaccesskey":store.s3_secret_key,"sessiontoken":""}});
    Ok(
        json!({"revision":hex::encode(hash.finalize()),"changes":changes,"overlay":serde_yaml_ng::to_string(&desired).map_err(anyhow::Error::from)?,"s3_resource":serde_yaml_ng::to_string(&s3).map_err(anyhow::Error::from)?,"mounted":directory.is_dir(),"source_checked":!primary.is_empty(),"callback":format!("{}/oidc/consume",origin(&req.integration.omni_url)?),"note":"Static configuration check only. CLI flags and later config files may override this overlay. Restart Omni and apply the S3 resource with authenticated omnictl, then verify sign-in and a real backup."}),
    )
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| bad("Invalid managed path"))?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(anyhow::Error::from)?;
    tmp.write_all(bytes).map_err(anyhow::Error::from)?;
    tmp.as_file().sync_all().map_err(anyhow::Error::from)?;
    tmp.persist(path).map_err(anyhow::Error::from)?;
    Ok(())
}
pub(crate) fn defaults(app: &App, store: &Store) -> Integration {
    if let Some(saved) = crate::connections::settings().integration
        && (store.integration.companion_url.is_empty()
            || (saved.companion_url == app.issuer() && saved.profile == store.integration.profile))
    {
        return saved;
    }
    if !store.integration.companion_url.is_empty() {
        let mut integration = store.integration.clone();
        if integration.s3_endpoint.is_empty()
            && integration.profile == Profile::Lan
            && crate::companion_setup::local_root().is_some()
        {
            integration.s3_endpoint = app.issuer();
        }
        return integration;
    }
    let agent = crate::connections::agent_info();
    let omni = url::Url::parse(&store.redirect_uri)
        .ok()
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    Integration {
        profile: Profile::Lan,
        companion_url: app.issuer(),
        omni_url: if omni.is_empty() {
            agent
                .as_ref()
                .and_then(|v| v["omni_origin"].as_str())
                .unwrap_or("")
                .into()
        } else {
            omni
        },
        s3_endpoint: std::env::var("S3_PUBLIC_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| agent.and_then(|v| v["s3_origin"].as_str().map(str::to_owned)))
            .unwrap_or_default(),
    }
}
pub async fn status(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    auth::admin(&app, &headers).await?;
    let store = app.store.read().await;
    let s = store.as_ref().ok_or_else(denied)?;
    Ok(Json(
        json!({"integration":s.integration,"active_issuer":app.issuer(),"mounted":Path::new(MANAGED).is_dir(),"restart_pending":!s.integration.companion_url.is_empty() && s.integration.companion_url!=app.issuer(),"defaults":defaults(&app,s)}),
    ))
}
pub async fn preview(
    State(app): State<App>,
    headers: HeaderMap,
    Json(req): Json<Request>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let store = app.store.read().await;
    Ok(Json(plan(
        store.as_ref().ok_or_else(denied)?,
        &req,
        Path::new(MANAGED),
    )?))
}
#[derive(Deserialize)]
pub struct Discover {
    primary_config: String,
}
pub async fn discover(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Discover>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let value = parse(&input.primary_config)?;
    let url = value
        .pointer("/services/api/advertisedURL")
        .and_then(Value::as_str)
        .map(origin)
        .transpose()?;
    Ok(Json(json!({"omni_url":url})))
}
pub async fn apply(
    State(app): State<App>,
    headers: HeaderMap,
    Json(req): Json<Request>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let directory = Path::new(MANAGED);
    if !directory.is_dir() {
        return Err(bad(
            "Map the dedicated managed-overlay directory before applying; download the files instead",
        ));
    }
    let checks = crate::endpoint_checks::run(
        State(app.clone()),
        headers.clone(),
        Json(req.integration.clone()),
    )
    .await?
    .0;
    if !checks["checks"].as_array().is_some_and(|results| {
        results.len() == 3 && results.iter().all(|result| result["ok"] == true)
    }) {
        return Err(bad(
            "Live endpoint verification failed. Check Companion, Omni and S3 before applying the migration.",
        ));
    }
    let _serial = app.backup_lock.lock().await;
    let mut guard = app.store.write().await;
    let mut store = guard.clone().ok_or_else(denied)?;
    let planned = plan(&store, &req, directory)?;
    if req.revision.as_deref() != planned["revision"].as_str() {
        return Err(bad("Configuration changed. Preview again before applying"));
    }
    let path = directory.join("companion.yaml");
    let previous = read_optional(&path)?;
    if !previous.is_empty() {
        atomic(
            &app.data
                .join("vault")
                .join(format!("omni-overlay-before-{}.yaml", uuid::Uuid::new_v4())),
            &previous,
        )?;
    }
    let bytes = planned["overlay"]
        .as_str()
        .ok_or_else(|| bad("Invalid plan"))?
        .as_bytes();
    atomic(&path, bytes)?;
    store.integration = req.integration;
    store.integration.companion_url = origin(&store.integration.companion_url)?;
    store.integration.omni_url = origin(&store.integration.omni_url)?;
    store.redirect_uri = planned["callback"]
        .as_str()
        .ok_or_else(|| bad("Invalid callback"))?
        .into();
    if let Err(error) = app.persist(&store) {
        if previous.is_empty() {
            let _ = std::fs::remove_file(&path);
        } else {
            atomic(&path, &previous)?;
        }
        return Err(error.into());
    }
    *guard = Some(store);
    Ok(Json(
        json!({"ok":true,"restart_required":true,"note":"Overlay saved and callback registered. Activate the overlay in Omni, apply its S3 resource, and restart Companion after HTTPS is ready."}),
    ))
}
pub async fn ca() -> Result<impl IntoResponse> {
    let bytes = read_optional(&Path::new(MANAGED).join("root-ca.crt"))?;
    if bytes.is_empty() {
        return Err(bad("No LAN root certificate is installed"));
    }
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-pem-file"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=talos-companion-lan-ca.crt",
            ),
        ],
        bytes,
    ))
}

pub async fn talos_ca() -> Result<impl IntoResponse> {
    let bytes = read_optional(&Path::new(MANAGED).join("root-ca.crt"))?;
    if bytes.is_empty() {
        return Err(bad("No LAN root certificate is installed"));
    }
    let certificate = std::str::from_utf8(&bytes).map_err(|_| bad("Invalid public certificate"))?;
    let document = serde_yaml_ng::to_string(&json!({"apiVersion":"v1alpha1","kind":"TrustedRootsConfig","name":"talos-companion-home","certificates":certificate})).map_err(anyhow::Error::from)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/yaml"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=talos-trusted-roots.yaml",
            ),
        ],
        document,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repair_is_scoped_and_duplicate_keys_are_rejected() {
        let source = json!({"account":{"id":"keep"},"storage":{"default":{"etcd":{"privateKeySource":"keep"}}},"auth":{"initialUsers":["keep@example.test"]},"unknown":{"keep":42}});
        let mut merged = source.clone();
        let expected = json!({"auth":{"oidc":{"enabled":true}},"etcdBackup":{"s3Enabled":true,"localPath":null}});
        merge(&mut merged, &expected);
        assert_eq!(merged["account"], source["account"]);
        assert_eq!(merged["storage"], source["storage"]);
        assert_eq!(
            merged["auth"]["initialUsers"],
            source["auth"]["initialUsers"]
        );
        assert_eq!(merged["unknown"], source["unknown"]);
        let mut changes = vec![];
        differences(&merged, &expected, "", &mut changes);
        assert!(changes.is_empty());
        assert!(parse("auth: {}\nauth: {}\n").is_err());
        assert!(parse("- not-a-map").is_err());
        assert!(origin("https://user:secret@example.test").is_err());
        assert!(origin("http://example.test").is_err());
    }
}

/// Inputs describe a planned installation; no network access is needed to render them.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BootstrapConfig {
    pub omni_url: String,
    pub companion_url: String,
    pub account_name: String,
    pub admin_email: String,
    pub wireguard_ip: std::net::IpAddr,
    pub api_port: u16,
    pub kubernetes_port: u16,
    pub machine_port: u16,
    pub wireguard_port: u16,
    pub event_sink_port: u16,
    pub log_server_port: u16,
    pub metrics_port: u16,
    pub tls_cert: String,
    pub tls_key: String,
    pub private_key_file: String,
    pub etcd_path: String,
    pub sqlite_path: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Bootstrap {
    pub account_id: String,
    pub config: BootstrapConfig,
    pub generated_at: u64,
    pub connected_at: Option<u64>,
}
fn container_path(value: &str, root: &str) -> Result<()> {
    if !value.starts_with(&format!("{root}/"))
        || value
            .split('/')
            .skip(1)
            .any(|part| matches!(part, ".." | ".") || part.is_empty())
        || value.chars().any(|c| c.is_control() || c == '\\')
        || value.len() > 1024
    {
        return Err(bad(&format!(
            "Use an absolute container path below {root}, without dot segments"
        )));
    }
    Ok(())
}
impl BootstrapConfig {
    fn validate(&mut self, issuer: &str) -> Result<()> {
        self.omni_url = origin(&self.omni_url)?;
        self.companion_url = origin(&self.companion_url)?;
        if self.companion_url != origin(issuer)? {
            return Err(bad(
                "Companion issuer must match its active HTTPS issuer. Configure Companion access first; Omni does not need to be running.",
            ));
        }
        self.admin_email = self.admin_email.trim().to_lowercase();
        self.account_name = self.account_name.trim().into();
        if !self.admin_email.contains('@')
            || self.admin_email.len() > 254
            || self.account_name.is_empty()
            || self.account_name.len() > 100
        {
            return Err(bad(
                "Provide an initial administrator email and an account name of up to 100 characters",
            ));
        }
        if self.wireguard_ip.is_unspecified()
            || self.wireguard_ip.is_loopback()
            || self.wireguard_ip.is_multicast()
        {
            return Err(bad(
                "Use the literal host IP reachable by Talos nodes for WireGuard",
            ));
        }
        let tcp = [
            self.api_port,
            self.kubernetes_port,
            self.machine_port,
            self.event_sink_port,
            self.log_server_port,
            self.metrics_port,
        ];
        if tcp.contains(&0)
            || self.wireguard_port == 0
            || tcp.iter().collect::<std::collections::HashSet<_>>().len() != tcp.len()
        {
            return Err(bad(
                "Ports must be between 1 and 65535; TCP listeners must use distinct ports",
            ));
        }
        for path in [&self.tls_cert, &self.tls_key, &self.private_key_file] {
            container_path(path, "/config")?;
        }
        for path in [&self.etcd_path, &self.sqlite_path] {
            container_path(path, "/data")?;
        }
        if self.tls_cert == self.tls_key
            || self.tls_key == self.private_key_file
            || self.tls_cert == self.private_key_file
            || self.etcd_path == self.sqlite_path
            || self
                .sqlite_path
                .starts_with(&format!("{}/", self.etcd_path))
        {
            return Err(bad(
                "TLS, encryption key, etcd directory and SQLite file must use separate paths",
            ));
        }
        Ok(())
    }
}
fn bootstrap_document(store: &Store, bootstrap: &Bootstrap) -> Result<String> {
    let c = &bootstrap.config;
    // Reuse the pinned installation example so its storage/schema defaults stay in one place.
    let mut value = parse(include_str!("../deploy/unraid/omni-config.example.yaml"))?;
    value["account"] = json!({"id":bootstrap.account_id,"name":c.account_name});
    for (service, port) in [
        ("api", c.api_port),
        ("kubernetesProxy", c.kubernetes_port),
        ("machineAPI", c.machine_port),
    ] {
        let mut advertised =
            url::Url::parse(&c.omni_url).map_err(|_| bad("Invalid Omni origin"))?;
        if service != "api" {
            advertised
                .set_port(Some(port))
                .map_err(|_| bad("Invalid service port"))?;
        }
        value["services"][service] = json!({"endpoint":format!("0.0.0.0:{port}"),"advertisedURL":advertised.as_str(),"certFile":c.tls_cert,"keyFile":c.tls_key});
    }
    value["services"]["siderolink"]["wireGuard"] = json!({"endpoint":format!("0.0.0.0:{}",c.wireguard_port),"advertisedEndpoint":std::net::SocketAddr::new(c.wireguard_ip,c.wireguard_port).to_string()});
    value["services"]["siderolink"]["eventSinkPort"] = json!(c.event_sink_port);
    value["services"]["siderolink"]["logServerPort"] = json!(c.log_server_port);
    value["services"]["metrics"]["endpoint"] = json!(format!("127.0.0.1:{}", c.metrics_port));
    value["auth"]["initialUsers"] = json!([c.admin_email]);
    value["auth"]["oidc"]["providerURL"] = json!(c.companion_url);
    value["auth"]["oidc"]["clientID"] = json!(store.client_id);
    value["auth"]["oidc"]["clientSecret"] = json!(store.client_secret);
    value["storage"]["default"]["etcd"]["embeddedDBPath"] = json!(c.etcd_path);
    value["storage"]["default"]["etcd"]["privateKeySource"] =
        json!(format!("file://{}", c.private_key_file));
    value["storage"]["sqlite"]["path"] = json!(c.sqlite_path);
    let text = serde_yaml_ng::to_string(&value).map_err(anyhow::Error::from)?;
    Ok(format!(
        "# Omni v1.13.2 configuration generated by Talos Companion. Contains secrets: store privately.\n# Mount /config read-only and /data read-write. Preserve account.id permanently.\n# Review https://siderolabs.com/eula/ yourself before first startup.\n# If you accept, add eulaAccept.name and eulaAccept.email with your own details.\n# eulaAccept:\n#   name: YOUR_FULL_NAME\n#   email: YOUR_EMAIL\n# After startup, configure the S3 backup destination; enabling s3Enabled alone is insufficient.\n{text}"
    ))
}
fn bootstrap_summary(bootstrap: &Bootstrap) -> Value {
    json!({"account_id":bootstrap.account_id,"config":bootstrap.config,"generated_at":bootstrap.generated_at,"connected_at":bootstrap.connected_at,"callback":format!("{}/oidc/consume",bootstrap.config.omni_url),"image":"ghcr.io/siderolabs/omni:v1.13.2"})
}
fn yaml_download(text: String) -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "application/yaml; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=omni.yaml",
            ),
            (header::CACHE_CONTROL, "no-store, private, max-age=0"),
            (header::PRAGMA, "no-cache"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        text,
    )
}
pub async fn bootstrap_status(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    let actor = auth::admin(&app, &headers).await?;
    let guard = app.store.read().await;
    let store = guard.as_ref().ok_or_else(denied)?;
    Ok(Json(
        json!({"bootstrap":store.omni_bootstrap.as_ref().map(bootstrap_summary),"active_issuer":app.issuer(),"admin_email":actor.email}),
    ))
}
pub async fn generate(
    State(app): State<App>,
    headers: HeaderMap,
    Json(mut config): Json<BootstrapConfig>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    let actor = auth::admin(&app, &headers).await?;
    config.validate(&app.issuer())?;
    let mut guard = app.store.write().await;
    let mut store = guard.clone().ok_or_else(denied)?;
    if !store.users.iter().any(|u| u.id == actor.id && u.admin) {
        return Err(denied());
    }
    let previous = store.omni_bootstrap.as_ref();
    let bootstrap = Bootstrap {
        account_id: previous
            .map(|b| b.account_id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        connected_at: previous
            .filter(|b| b.config == config)
            .and_then(|b| b.connected_at),
        generated_at: now(),
        config,
    };
    // Render before committing; serialization errors must not leave partial registration.
    bootstrap_document(&store, &bootstrap)?;
    store.redirect_uri = format!("{}/oidc/consume", bootstrap.config.omni_url);
    let result = bootstrap_summary(&bootstrap);
    store.omni_bootstrap = Some(bootstrap);
    app.persist(&store)?;
    *guard = Some(store);
    Ok(Json(result))
}
pub async fn download_bootstrap(
    State(app): State<App>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    auth::admin(&app, &headers).await?;
    let guard = app.store.read().await;
    let store = guard.as_ref().ok_or_else(denied)?;
    let bootstrap = store
        .omni_bootstrap
        .as_ref()
        .ok_or_else(|| bad("Generate an Omni configuration first"))?;
    if store.redirect_uri != format!("{}/oidc/consume", bootstrap.config.omni_url)
        || bootstrap.config.companion_url != app.issuer()
    {
        return Err(bad(
            "Issuer or callback registration changed. Review and generate the configuration again before downloading.",
        ));
    }
    Ok(yaml_download(bootstrap_document(store, bootstrap)?))
}
pub async fn download_existing(
    State(app): State<App>,
    headers: HeaderMap,
    Json(req): Json<Request>,
) -> Result<impl IntoResponse> {
    auth::csrf(&app, &headers)?;
    let actor = auth::admin(&app, &headers).await?;
    if req.primary_config.trim().is_empty() {
        return Err(bad(
            "Import the existing primary configuration before downloading reviewed updates",
        ));
    }
    if origin(&req.integration.companion_url)? != origin(&app.issuer())? {
        return Err(bad("Use Companion's active HTTPS issuer"));
    }
    let mut guard = app.store.write().await;
    let mut store = guard.clone().ok_or_else(denied)?;
    if !store.users.iter().any(|u| u.id == actor.id && u.admin) {
        return Err(denied());
    }
    let planned = plan(&store, &req, Path::new(MANAGED))?;
    if req.revision.as_deref() != planned["revision"].as_str() {
        return Err(bad(
            "Configuration changed. Preview again before downloading",
        ));
    }
    let mut value = parse(&req.primary_config)?;
    merge(&mut value, &overlay(&store, &req.integration));
    let yaml = serde_yaml_ng::to_string(&value).map_err(anyhow::Error::from)?;
    store.redirect_uri = planned["callback"]
        .as_str()
        .ok_or_else(|| bad("Invalid callback"))?
        .into();
    app.persist(&store)?;
    *guard = Some(store);
    Ok(yaml_download(format!(
        "# Reviewed Companion OIDC/S3 updates. Contains secrets. Preserve the original and review before replacing it.\n{yaml}"
    )))
}
pub async fn check_bootstrap(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    let actor = auth::admin(&app, &headers).await?;
    let expected = {
        let guard = app.store.read().await;
        guard
            .as_ref()
            .and_then(|s| s.omni_bootstrap.clone())
            .ok_or_else(|| bad("Generate an Omni configuration first"))?
    };
    let profile = if url::Url::parse(&expected.config.omni_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.ends_with(".ts.net")))
        .unwrap_or(false)
    {
        Profile::Tailscale
    } else {
        Profile::Lan
    };
    let connected = crate::endpoint_checks::omni_reachable(&expected.config.omni_url, &profile)
        .await
        .is_ok();
    let mut guard = app.store.write().await;
    let mut store = guard.clone().ok_or_else(denied)?;
    if !store.users.iter().any(|u| u.id == actor.id && u.admin) {
        return Err(denied());
    }
    let bootstrap = store
        .omni_bootstrap
        .as_mut()
        .ok_or_else(|| bad("Configuration changed; validate again"))?;
    if bootstrap.generated_at != expected.generated_at || bootstrap.config != expected.config {
        return Err(bad("Configuration changed; validate again"));
    }
    bootstrap.connected_at = connected.then(now);
    let summary = bootstrap_summary(bootstrap);
    app.persist(&store)?;
    *guard = Some(store);
    Ok(Json(
        json!({"connected":connected,"bootstrap":summary,"note":"HTTPS reachability checked from Companion. Omni sign-in, node connectivity and a real backup still require testing."}),
    ))
}

#[cfg(test)]
mod bootstrap_tests {
    use super::*;
    fn config() -> BootstrapConfig {
        serde_json::from_value(json!({
            "omni_url":"https://omni.invalid:9443", "companion_url":"https://companion.example.test",
            "account_name":"my-omni", "admin_email":"admin@example.test", "wireguard_ip":"192.0.2.20",
            "api_port":8443,"kubernetes_port":8100,"machine_port":8090,"wireguard_port":50180,
            "event_sink_port":8091,"log_server_port":8092,"metrics_port":2122,
            "tls_cert":"/config/tls/fullchain.pem","tls_key":"/config/tls/privkey.pem",
            "private_key_file":"/config/omni.asc","etcd_path":"/data/etcd","sqlite_path":"/data/secondary-storage/sqlite.db"
        })).unwrap()
    }
    fn store() -> Store {
        Store {
            version: 1,
            users: vec![],
            signing_key: String::new(),
            client_id: "actual-client".into(),
            client_secret: "actual-secret: \"quoted\"\nvalue".into(),
            redirect_uri: String::new(),
            s3_access_key: String::new(),
            s3_secret_key: String::new(),
            drive: Drive::default(),
            network: None,
            integration: Default::default(),
            omni_bootstrap: None,
        }
    }
    // Upstream's generated schema describes the complete runtime object (including defaults
    // and EULA acceptance). Check every field we emit; omitted fields are filled by Omni,
    // and EULA acceptance must deliberately be supplied by the operator afterwards.
    fn check_fields(value: &Value, schema: &Value, root: &Value, path: &str) {
        if let Some(reference) = schema["$ref"].as_str() {
            check_fields(
                value,
                root.pointer(reference.strip_prefix('#').unwrap()).unwrap(),
                root,
                path,
            );
            return;
        }
        match schema["type"].as_str() {
            Some("object") => {
                for (key, child) in value.as_object().unwrap() {
                    let field = &schema["properties"][key];
                    assert!(!field.is_null(), "unknown Omni v1.13.2 field: {path}/{key}");
                    check_fields(child, field, root, &format!("{path}/{key}"));
                }
            }
            Some("array") => {
                for child in value.as_array().unwrap() {
                    check_fields(child, &schema["items"], root, path);
                }
            }
            Some("string") => assert!(value.is_string(), "{path}"),
            Some("boolean") => assert!(value.is_boolean(), "{path}"),
            Some("integer") => assert!(value.is_u64() || value.is_i64(), "{path}"),
            Some(kind) => panic!("Unhandled schema type {kind}: {path}"),
            None => panic!("Missing schema type: {path}"),
        }
        if let Some(values) = schema["enum"].as_array() {
            assert!(values.contains(value), "{path}");
        }
        if let Some(min) = schema["minimum"].as_f64() {
            assert!(value.as_f64().unwrap() >= min, "{path}");
        }
        if let Some(max) = schema["maximum"].as_f64() {
            assert!(value.as_f64().unwrap() <= max, "{path}");
        }
        if let Some(min) = schema["minLength"].as_u64() {
            assert!(value.as_str().unwrap().len() >= min as usize, "{path}");
        }
    }
    #[test]
    fn offline_yaml_uses_actual_credentials_and_pinned_schema() {
        let mut config = config();
        config
            .validate("https://companion.example.test")
            .map_err(|e| e.1)
            .unwrap();
        let bootstrap = Bootstrap {
            account_id: uuid::Uuid::new_v4().to_string(),
            config,
            generated_at: 1,
            connected_at: None,
        };
        let store = store();
        let yaml = bootstrap_document(&store, &bootstrap)
            .map_err(|e| e.1)
            .unwrap();
        let parsed = parse(&yaml).map_err(|e| e.1).unwrap();
        let schema: Value =
            serde_json::from_str(include_str!("../tests/fixtures/omni-v1.13.2-schema.json"))
                .unwrap();
        check_fields(&parsed, &schema, &schema, "");
        assert_eq!(parsed["account"]["id"], bootstrap.account_id);
        assert_eq!(parsed["auth"]["oidc"]["clientSecret"], store.client_secret);
        assert_eq!(parsed["auth"]["oidc"]["clientID"], store.client_id);
        assert_eq!(
            parsed["services"]["api"]["advertisedURL"],
            "https://omni.invalid:9443/"
        );
        assert_eq!(
            parsed["services"]["kubernetesProxy"]["advertisedURL"],
            "https://omni.invalid:8100/"
        );
        assert_eq!(
            parsed["storage"]["default"]["etcd"]["privateKeySource"],
            "file:///config/omni.asc"
        );
        assert_eq!(
            parsed["storage"]["default"]["etcd"]["embeddedDBPath"],
            "/data/etcd"
        );
        assert_eq!(
            parsed["storage"]["sqlite"]["path"],
            "/data/secondary-storage/sqlite.db"
        );
        assert!(parsed.get("eulaAccept").is_none());
        assert!(!yaml.contains("REPLACE_"));
        assert_eq!(
            bootstrap_document(&store, &bootstrap)
                .map_err(|e| e.1)
                .unwrap(),
            yaml
        );
        assert_eq!(
            parse(&serde_yaml_ng::to_string(&parsed).unwrap())
                .map_err(|e| e.1)
                .unwrap(),
            parsed
        );
        let summary = bootstrap_summary(&bootstrap).to_string();
        assert!(!summary.contains(&store.client_id));
        assert!(!summary.contains("actual-secret"));
        let mut ipv6 = bootstrap.clone();
        ipv6.config.wireguard_ip = "2001:db8::20".parse().unwrap();
        assert_eq!(
            parse(&bootstrap_document(&store, &ipv6).map_err(|e| e.1).unwrap())
                .map_err(|e| e.1)
                .unwrap()["services"]["siderolink"]["wireGuard"]["advertisedEndpoint"],
            "[2001:db8::20]:50180"
        );
    }
    #[test]
    fn bootstrap_rejects_invalid_issuer_paths_addresses_and_ports() {
        let base = config();
        assert!(base.clone().validate("https://other.example.test").is_err());
        for path in [
            "/config/database",
            "/data/../config/db",
            "/data//db",
            "/data/./db",
            "/data/db\\file",
        ] {
            let mut c = base.clone();
            c.etcd_path = path.into();
            assert!(c.validate(&base.companion_url).is_err());
        }
        let mut c = base.clone();
        c.sqlite_path = "/data/etcd/db".into();
        assert!(c.validate(&base.companion_url).is_err());
        let mut c = base.clone();
        c.api_port = 0;
        assert!(c.validate(&base.companion_url).is_err());
        let mut c = base.clone();
        c.api_port = c.machine_port;
        assert!(c.validate(&base.companion_url).is_err());
        for ip in ["0.0.0.0", "127.0.0.1", "224.0.0.1", "::", "::1"] {
            let mut c = base.clone();
            c.wireguard_ip = ip.parse().unwrap();
            assert!(c.validate(&base.companion_url).is_err());
        }
    }
}
