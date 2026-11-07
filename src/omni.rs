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
fn defaults(app: &App, store: &Store) -> Integration {
    if let Some(saved) = crate::connections::settings().integration {
        return saved;
    }
    if !store.integration.companion_url.is_empty() {
        return store.integration.clone();
    }
    let agent = crate::connections::agent_info();
    let omni = url::Url::parse(&store.redirect_uri)
        .ok()
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    Integration {
        profile: Profile::Lan,
        companion_url: app.public_url.clone(),
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
        json!({"integration":s.integration,"active_issuer":app.public_url,"mounted":Path::new(MANAGED).is_dir(),"restart_pending":!s.integration.companion_url.is_empty() && s.integration.companion_url!=app.public_url,"defaults":defaults(&app,s)}),
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
