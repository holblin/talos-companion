use crate::{auth, model::*};
use axum::{
    Form, Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use rsa::{pkcs8::DecodePrivateKey, traits::PublicKeyParts};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub async fn discovery(State(app): State<App>) -> Json<Value> {
    let p = app.public_url;
    Json(
        json!({"issuer":p,"authorization_endpoint":format!("{p}/oauth/authorize"),"token_endpoint":format!("{p}/oauth/token"),"userinfo_endpoint":format!("{p}/oauth/userinfo"),"jwks_uri":format!("{p}/oauth/jwks"),"response_types_supported":["code"],"grant_types_supported":["authorization_code"],"subject_types_supported":["public"],"id_token_signing_alg_values_supported":["RS256"],"scopes_supported":["openid","email","profile"],"token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post"],"code_challenge_methods_supported":["S256"],"claims_supported":["sub","iss","aud","exp","iat","nonce","email","email_verified","name"]}),
    )
}
pub async fn jwks(State(app): State<App>) -> Result<Json<Value>> {
    let guard = app.store.read().await;
    let s = guard.as_ref().ok_or_else(denied)?;
    let key = rsa::RsaPrivateKey::from_pkcs8_pem(&s.signing_key).map_err(anyhow::Error::from)?;
    Ok(Json(
        json!({"keys":[{"kty":"RSA","use":"sig","alg":"RS256","kid":"companion-v1","n":URL_SAFE_NO_PAD.encode(key.n().to_bytes_be()),"e":URL_SAFE_NO_PAD.encode(key.e().to_bytes_be())}]}),
    ))
}
#[derive(Deserialize)]
pub struct Authorize {
    pub client_id: String,
    pub redirect_uri: String,
    pub response_type: String,
    pub scope: String,
    pub state: Option<String>,
    pub nonce: Option<String>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
}
fn validate(s: &Store, q: &Authorize) -> Result<()> {
    if s.redirect_uri.is_empty() || q.client_id != s.client_id || q.redirect_uri != s.redirect_uri {
        return Err(bad("Unregistered client or redirect URI"));
    }
    if q.response_type != "code"
        || !q.scope.split_whitespace().any(|x| x == "openid")
        || q.scope
            .split_whitespace()
            .any(|x| !matches!(x, "openid" | "email" | "profile"))
    {
        return Err(bad(
            "Only authorization code with openid/email/profile scopes is supported",
        ));
    }
    if q.code_challenge.is_some() && q.code_challenge_method.as_deref() != Some("S256") {
        return Err(bad("PKCE requires S256"));
    }
    Ok(())
}
pub async fn authorize(
    State(app): State<App>,
    headers: HeaderMap,
    uri: axum::http::Uri,
    Query(q): Query<Authorize>,
) -> Result<Response> {
    {
        let guard = app.store.read().await;
        validate(guard.as_ref().ok_or_else(denied)?, &q)?;
    }
    let u = match auth::user(&app, &headers).await {
        Ok(u) => u,
        Err(_) => {
            let next: url::Url = format!("{}/", app.public_url).parse().unwrap();
            let mut login = next;
            login
                .query_pairs_mut()
                .append_pair("next", &uri.to_string());
            return Ok(Redirect::to(login.as_str()).into_response());
        }
    };
    let code = secret();
    let mut m = app.memory.lock().await;
    m.codes.retain(|_, c| c.expires > now());
    m.codes.insert(
        code.clone(),
        Code {
            user_id: u.id,
            redirect_uri: q.redirect_uri.clone(),
            nonce: q.nonce,
            challenge: q.code_challenge,
            expires: now() + 60,
        },
    );
    drop(m);
    let mut target = url::Url::parse(&q.redirect_uri).map_err(|_| bad("Invalid redirect URI"))?;
    target.query_pairs_mut().append_pair("code", &code);
    if let Some(state) = q.state {
        target.query_pairs_mut().append_pair("state", &state);
    }
    Ok(Redirect::to(target.as_str()).into_response())
}
#[derive(Deserialize)]
pub struct Token {
    pub grant_type: String,
    pub code: String,
    pub redirect_uri: String,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub code_verifier: Option<String>,
}
pub async fn token(
    State(app): State<App>,
    headers: HeaderMap,
    Form(q): Form<Token>,
) -> Result<Json<Value>> {
    let s = app.store.read().await.clone().ok_or_else(denied)?;
    let basic = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic "))
        .and_then(|v| STANDARD.decode(v).ok())
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|v| v.split_once(':').map(|(a, b)| (a.to_owned(), b.to_owned())));
    let (id, password) = basic.unwrap_or((
        q.client_id.unwrap_or_default(),
        q.client_secret.unwrap_or_default(),
    ));
    if id != s.client_id || !bool::from(password.as_bytes().ct_eq(s.client_secret.as_bytes())) {
        return Err(Error(
            StatusCode::UNAUTHORIZED,
            "Invalid client credentials".into(),
        ));
    }
    if q.grant_type != "authorization_code" {
        return Err(bad("Unsupported grant type"));
    }
    let code = app
        .memory
        .lock()
        .await
        .codes
        .remove(&q.code)
        .ok_or_else(|| bad("Invalid or consumed authorization code"))?;
    if code.expires <= now()
        || code.redirect_uri != q.redirect_uri
        || q.redirect_uri != s.redirect_uri
    {
        return Err(bad("Expired code or mismatched redirect URI"));
    }
    if let Some(challenge) = code.challenge {
        let verifier = q
            .code_verifier
            .ok_or_else(|| bad("Missing code verifier"))?;
        if verifier.len() < 43
            || verifier.len() > 128
            || URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())) != challenge
        {
            return Err(bad("Invalid code verifier"));
        }
    }
    let u = s
        .users
        .iter()
        .find(|u| u.id == code.user_id)
        .ok_or_else(denied)?;
    let mut claims = json!({"iss":app.public_url,"sub":u.id,"aud":s.client_id,"iat":now(),"exp":now()+300,"email":u.email,"email_verified":true,"name":u.name,"token_use":"id"});
    if let Some(nonce) = code.nonce {
        claims["nonce"] = json!(nonce);
    }
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
    header.kid = Some("companion-v1".into());
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(s.signing_key.as_bytes())
        .map_err(anyhow::Error::from)?;
    let id_token = jsonwebtoken::encode(&header, &claims, &key).map_err(anyhow::Error::from)?;
    claims["token_use"] = json!("access");
    claims.as_object_mut().unwrap().remove("nonce");
    let access = jsonwebtoken::encode(&header, &claims, &key).map_err(anyhow::Error::from)?;
    Ok(Json(
        json!({"access_token":access,"id_token":id_token,"token_type":"Bearer","expires_in":300,"scope":"openid email profile"}),
    ))
}
pub async fn userinfo(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>> {
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .ok_or_else(denied)?;
    let s = app.store.read().await.clone().ok_or_else(denied)?;
    let key = rsa::RsaPrivateKey::from_pkcs8_pem(&s.signing_key).map_err(anyhow::Error::from)?;
    let n = URL_SAFE_NO_PAD.encode(key.n().to_bytes_be());
    let e = URL_SAFE_NO_PAD.encode(key.e().to_bytes_be());
    let key =
        jsonwebtoken::DecodingKey::from_rsa_components(&n, &e).map_err(anyhow::Error::from)?;
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[s.client_id]);
    validation.set_issuer(&[app.public_url]);
    validation.leeway = 0;
    let claims = jsonwebtoken::decode::<Value>(token, &key, &validation)
        .map_err(|_| denied())?
        .claims;
    if claims["token_use"] != "access" {
        return Err(denied());
    }
    let u = s
        .users
        .iter()
        .find(|u| json!(u.id) == claims["sub"])
        .ok_or_else(denied)?;
    Ok(Json(
        json!({"sub":u.id,"email":u.email,"email_verified":true,"name":u.name}),
    ))
}
#[derive(Deserialize)]
pub struct Settings {
    pub redirect_uri: String,
}
pub async fn configure(
    State(app): State<App>,
    headers: HeaderMap,
    Json(q): Json<Settings>,
) -> Result<Json<Value>> {
    auth::csrf(&app, &headers)?;
    auth::admin(&app, &headers).await?;
    let url = url::Url::parse(&q.redirect_uri).map_err(|_| bad("Invalid callback URL"))?;
    if !matches!(url.scheme(), "https" | "http")
        || url.fragment().is_some()
        || !url.username().is_empty()
    {
        return Err(bad(
            "Callback must be an HTTP(S) URL without credentials or fragment",
        ));
    }
    let mut guard = app.store.write().await;
    let mut s = guard.clone().ok_or_else(denied)?;
    s.redirect_uri = q.redirect_uri;
    app.persist(&s)?;
    *guard = Some(s);
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redirect_and_pkce_are_strict() {
        let s = Store {
            version: 1,
            users: vec![],
            signing_key: String::new(),
            client_id: "omni".into(),
            client_secret: String::new(),
            redirect_uri: "https://omni.example/callback".into(),
            s3_access_key: String::new(),
            s3_secret_key: String::new(),
            drive: Drive::default(),
            integration: Default::default(),
        };
        let mut q = Authorize {
            client_id: "omni".into(),
            redirect_uri: s.redirect_uri.clone(),
            response_type: "code".into(),
            scope: "openid email profile".into(),
            state: None,
            nonce: None,
            code_challenge: None,
            code_challenge_method: None,
        };
        assert!(validate(&s, &q).is_ok());
        q.redirect_uri.push_str("/evil");
        assert!(validate(&s, &q).is_err());
        q.redirect_uri = s.redirect_uri.clone();
        q.code_challenge = Some("x".into());
        q.code_challenge_method = Some("plain".into());
        assert!(validate(&s, &q).is_err());
    }
}
