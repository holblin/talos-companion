//! Read-only checks: no administrator cookies are sent to candidate endpoints.
use crate::{
    auth,
    model::*,
    omni::{Integration, Profile},
};
use axum::{
    Json,
    extract::{Query, State},
    http::HeaderMap,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;
use subtle::ConstantTimeEq;

pub fn mac(key: &[u8], message: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts every key size");
    mac.update(message);
    mac.finalize().into_bytes().to_vec()
}
pub fn proof(key: &str, service: &str, challenge: &str) -> String {
    hex::encode(mac(
        key.as_bytes(),
        format!("talos-companion:{service}:{challenge}").as_bytes(),
    ))
}
pub fn identity(key: &str, service: &str, challenge: &str) -> Option<Value> {
    (challenge.len() == 64 && challenge.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| json!({"service":service,"proof":proof(key,service,challenge)}))
}
#[derive(Deserialize)]
pub struct Challenge {
    challenge: String,
}
pub async fn companion_identity(
    State(app): State<App>,
    Query(input): Query<Challenge>,
) -> Result<Json<Value>> {
    let store = app.store.read().await;
    let store = store.as_ref().ok_or_else(denied)?;
    Ok(Json(
        identity(&store.s3_secret_key, "companion", &input.challenge)
            .ok_or_else(|| bad("Invalid challenge"))?,
    ))
}
pub fn origin(value: &str) -> anyhow::Result<url::Url> {
    let url = url::Url::parse(value)?;
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none(),
        "Enter an HTTP(S) origin without a path, query or credentials"
    );
    Ok(url)
}
async fn small_json(mut response: reqwest::Response) -> anyhow::Result<Value> {
    anyhow::ensure!(
        response.status().is_success(),
        "Endpoint rejected the identity check"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(
            bytes.len() + chunk.len() <= 16384,
            "Unexpected identity response"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}
pub fn verify_identity(
    key: &str,
    service: &str,
    challenge: &str,
    value: &Value,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        value["service"] == service
            && value["proof"].as_str().is_some_and(|value| bool::from(
                value
                    .as_bytes()
                    .ct_eq(proof(key, service, challenge).as_bytes())
            )),
        "This address does not identify this Companion installation"
    );
    Ok(())
}
async fn identify(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    service: &str,
) -> anyhow::Result<()> {
    let url = origin(base)?;
    let challenge = secret();
    let path = if service == "s3" {
        "/.well-known/talos-companion"
    } else {
        "/api/omni/identity"
    };
    let value = small_json(
        client
            .get(url.join(path)?)
            .query(&[("challenge", &challenge)])
            .send()
            .await?,
    )
    .await?;
    verify_identity(key, service, &challenge, &value)
}
async fn s3(client: &reqwest::Client, base: &str, access: &str, key: &str) -> anyhow::Result<()> {
    identify(client, base, key, "s3").await?;
    let url = origin(base)?.join("/omni")?;
    let host = url[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
    let t = time::OffsetDateTime::now_utc();
    let date = format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second()
    );
    let day = &date[..8];
    let scope = format!("{day}/us-east-1/s3/aws4_request");
    let empty = hex::encode(Sha256::digest([]));
    let signed = "host;x-amz-content-sha256;x-amz-date";
    let canonical = format!(
        "HEAD\n/omni\n\nhost:{host}\nx-amz-content-sha256:{empty}\nx-amz-date:{date}\n\n{signed}\n{empty}"
    );
    let signing = mac(
        &mac(
            &mac(
                &mac(format!("AWS4{key}").as_bytes(), day.as_bytes()),
                b"us-east-1",
            ),
            b"s3",
        ),
        b"aws4_request",
    );
    let string = format!(
        "AWS4-HMAC-SHA256\n{date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical.as_bytes()))
    );
    let signature = hex::encode(mac(&signing, string.as_bytes()));
    let response=client.head(url).header("x-amz-content-sha256",empty).header("x-amz-date",date).header("authorization",format!("AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={signed}, Signature={signature}")).send().await?;
    anyhow::ensure!(
        response.status().is_success(),
        "Receiver identity verified, but authenticated access to bucket omni failed"
    );
    Ok(())
}
#[derive(Serialize)]
struct Check {
    service: &'static str,
    endpoint: String,
    ok: bool,
    message: String,
    vantage: &'static str,
}
fn check(
    service: &'static str,
    endpoint: &str,
    result: anyhow::Result<()>,
    success: &str,
) -> Check {
    Check {
        service,
        endpoint: endpoint.into(),
        ok: result.is_ok(),
        message: match result {
            Ok(()) => success.into(),
            Err(error) => {
                if error.is::<reqwest::Error>() {
                    "Connection failed. Check DNS, certificate trust, routing and the destination service.".into()
                } else {
                    error.to_string()
                }
            }
        },
        vantage: "Companion",
    }
}
pub async fn run(
    State(app): State<App>,
    headers: HeaderMap,
    Json(integration): Json<Integration>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let (key, access) = {
        let store = app.store.read().await;
        let store = store.as_ref().ok_or_else(denied)?;
        (store.s3_secret_key.clone(), store.s3_access_key.clone())
    };
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none());
    if let Ok(bytes) = std::fs::read(crate::connections::private_dir().join("origin-ca.crt")) {
        builder = builder.add_root_certificate(
            reqwest::Certificate::from_pem(&bytes)
                .map_err(|_| bad("Invalid saved public trust certificate"))?,
        );
    }
    if integration.profile == Profile::Lan {
        let path = std::path::Path::new("/omni-managed/root-ca.crt");
        if path.is_file() {
            builder = builder.add_root_certificate(
                reqwest::Certificate::from_pem(&std::fs::read(path).map_err(anyhow::Error::from)?)
                    .map_err(|_| bad("Invalid mounted LAN public root"))?,
            );
        }
    }
    if integration.profile == Profile::Tailscale && crate::connections::agent_info().is_some() {
        builder = builder
            .proxy(reqwest::Proxy::all("socks5h://127.0.0.1:1055").map_err(anyhow::Error::from)?);
    }
    let client = builder.build().map_err(anyhow::Error::from)?;
    let omni = async {
        let response = client.get(origin(&integration.omni_url)?).send().await?;
        anyhow::ensure!(
            response.status().is_success() || response.status().is_redirection(),
            "Omni returned an unsuccessful HTTP response"
        );
        Ok(())
    };
    let (companion, omni, s3) = tokio::join!(
        identify(&client, &integration.companion_url, &key, "companion"),
        omni,
        s3(&client, &integration.s3_endpoint, &access, &key)
    );
    let checks = [
        check(
            "Companion",
            &integration.companion_url,
            companion,
            "Verified this Companion installation.",
        ),
        check(
            "Omni",
            &integration.omni_url,
            omni,
            "HTTP response verified. Omni sign-in and node connectivity still need verification.",
        ),
        check(
            "S3",
            &integration.s3_endpoint,
            s3,
            "Verified this Companion receiver and authenticated access to bucket omni.",
        ),
    ];
    Ok(Json(
        json!({"checked_at":now(),"checks":checks,"omni_to_s3_verified":false,"note":"Checks originate from Companion. A real backup from Omni is still required to verify the Omni-to-S3 path. Plain HTTP endpoints are not encrypted."}),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_proofs_are_bound_to_instance_service_and_challenge() {
        let challenge = "a".repeat(64);
        let value = identity("test-only-key", "s3", &challenge).unwrap();
        assert!(verify_identity("test-only-key", "s3", &challenge, &value).is_ok());
        assert!(verify_identity("different-key", "s3", &challenge, &value).is_err());
        assert!(verify_identity("test-only-key", "companion", &challenge, &value).is_err());
        assert!(verify_identity("test-only-key", "s3", &"b".repeat(64), &value).is_err());
        assert!(identity("test-only-key", "s3", "").is_none());
    }
}
