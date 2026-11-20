//! Supervised provider clients bundled in Companion. No Docker socket or host control API.
use crate::{
    connections::*,
    model::{now, secret},
    omni::{Integration, Profile},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudflareAuthorization {
    #[serde(rename = "zoneID")]
    zone_id: String,
    #[serde(rename = "accountID", default)]
    account_id: String,
    api_token: String,
    #[serde(default)]
    endpoint: String,
}

const CLOUDFLARE_CLEANUP: &str = "cloudflare-cleanup.json";
const TAILSCALE_LOGGED_OUT: &str = "tailscale-logged-out.json";

#[derive(Deserialize, Serialize)]
struct CloudflareCleanup {
    tunnel: uuid::Uuid,
    account: String,
    credential: String,
    hosts: std::collections::BTreeSet<String>,
    remote_done: bool,
}

fn optional_json<T: serde::de::DeserializeOwned>(path: &Path) -> anyhow::Result<Option<T>> {
    match read_json(path) {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn remove_local_file(path: &Path) -> anyhow::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn cloudflare_credential_name(name: &str) -> bool {
    name.strip_prefix("tunnel-")
        .and_then(|name| name.strip_suffix(".json"))
        .is_some_and(|id| id.len() == 16 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn managed_cloudflare_host(rule: &Value) -> Option<String> {
    match rule["service"].as_str()? {
        "http://127.0.0.1:18081" | "http://127.0.0.1:18082" | "http://127.0.0.1:18083"
            if rule.get("path").is_none() => {}
        _ => return None,
    }
    let host = rule["hostname"].as_str()?.to_ascii_lowercase();
    domain(&host).then_some(host)
}

fn exact_tunnel_record(record: &Value, host: &str, target: &str) -> bool {
    let matches_dns_name = |value: &Value, name: &str| {
        value
            .as_str()
            .is_some_and(|value| value.trim_end_matches('.').eq_ignore_ascii_case(name))
    };
    record["type"] == "CNAME"
        && matches_dns_name(&record["name"], host)
        && matches_dns_name(&record["content"], target)
}

fn listed_tunnel(list: &Value, tunnel: uuid::Uuid) -> Option<&Value> {
    list.as_array()?.iter().find(|entry| {
        entry["id"]
            .as_str()
            .and_then(|id| uuid::Uuid::parse_str(id).ok())
            == Some(tunnel)
    })
}

fn tunnel_deleted(entry: &Value) -> bool {
    entry["deleted_at"]
        .as_str()
        .is_some_and(|date| !date.is_empty() && !date.starts_with("0001-01-01"))
}

async fn remove_cloudflare_dns(
    auth: &CloudflareAuthorization,
    plan: &CloudflareCleanup,
) -> anyhow::Result<()> {
    let host = match auth.endpoint.as_str() {
        "" => "api.cloudflare.com",
        "fed" => "api.fed.cloudflare.com",
        _ => anyhow::bail!("Unsupported Cloudflare authorization endpoint"),
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()?;
    let endpoint = format!(
        "https://{host}/client/v4/zones/{}/dns_records",
        auth.zone_id
    );
    remove_tunnel_dns(&client, &endpoint, &auth.api_token, plan).await
}

async fn remove_tunnel_dns(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    plan: &CloudflareCleanup,
) -> anyhow::Result<()> {
    let target = format!("{}.cfargotunnel.com", plan.tunnel);
    let mut records = std::collections::BTreeMap::new();
    let failed = || {
        anyhow::anyhow!(
            "Could not verify or remove managed Cloudflare DNS records. Local credentials were preserved; check DNS permissions and retry."
        )
    };
    for host in &plan.hosts {
        let response = client
            .get(endpoint)
            .query(&[
                ("type", "CNAME"),
                ("name.exact", host.as_str()),
                ("per_page", "25"),
            ])
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| failed())?;
        let value = crate::endpoint_checks::small_json(response)
            .await
            .map_err(|_| failed())?;
        anyhow::ensure!(
            value["success"] == true
                && value["result_info"]["total_pages"]
                    .as_u64()
                    .is_some_and(|pages| pages <= 1),
            failed()
        );
        for record in value["result"].as_array().ok_or_else(failed)? {
            if exact_tunnel_record(record, host, &target) {
                let id = record["id"]
                    .as_str()
                    .filter(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
                    .ok_or_else(failed)?;
                records.insert(id.to_owned(), host);
            }
        }
    }
    for (id, host) in records {
        let record_url = format!("{endpoint}/{id}");
        let response = client
            .get(&record_url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| failed())?;
        let value = crate::endpoint_checks::small_json(response)
            .await
            .map_err(|_| failed())?;
        anyhow::ensure!(
            value["success"] == true && value["result"]["id"] == id,
            failed()
        );
        if !exact_tunnel_record(&value["result"], host, &target) {
            continue;
        }
        let response = client
            .delete(&record_url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| failed())?;
        let value = crate::endpoint_checks::small_json(response)
            .await
            .map_err(|_| failed())?;
        anyhow::ensure!(
            value["success"] == true && value["result"]["id"] == id,
            failed()
        );
    }
    Ok(())
}

async fn stop_child(slot: &mut Option<Child>) -> anyhow::Result<()> {
    if let Some(child) = slot.as_mut()
        && child.try_wait()?.is_none()
    {
        child.kill().await?;
    }
    *slot = None;
    Ok(())
}

fn cloudflare_authorization(pem: &str) -> anyhow::Result<CloudflareAuthorization> {
    let invalid =
        || anyhow::anyhow!("Cloudflare authorization could not be read. Try signing in again.");
    anyhow::ensure!(pem.len() <= 65536, "Cloudflare authorization is too large");
    let marker = "-----BEGIN ARGO TUNNEL TOKEN-----";
    let mut blocks = pem.split(marker);
    blocks.next();
    let block = blocks.next().ok_or_else(invalid)?;
    anyhow::ensure!(
        blocks.next().is_none(),
        "Ambiguous Cloudflare authorization"
    );
    let encoded = block
        .split_once("-----END ARGO TUNNEL TOKEN-----")
        .ok_or_else(invalid)?
        .0;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.split_whitespace().collect::<String>())
        .map_err(|_| invalid())?;
    let auth: CloudflareAuthorization = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    anyhow::ensure!(
        auth.zone_id.len() == 32
            && auth.zone_id.bytes().all(|b| b.is_ascii_hexdigit())
            && !auth.api_token.is_empty()
            && auth.api_token.len() <= 8192,
        "Cloudflare authorization is incomplete. Try signing in again."
    );
    Ok(auth)
}

async fn cloudflare_domain(cert: &Path) -> anyhow::Result<String> {
    let fallback = "Couldn’t detect the domain approved in Cloudflare. Open Advanced settings, enter that domain and try again. No API token is needed.";
    anyhow::ensure!(
        std::fs::metadata(cert)?.len() <= 65536,
        "Cloudflare authorization is too large"
    );
    let auth = cloudflare_authorization(&std::fs::read_to_string(cert)?)?;
    let host = match auth.endpoint.as_str() {
        "" => "api.cloudflare.com",
        "fed" => "api.fed.cloudflare.com",
        _ => anyhow::bail!(fallback),
    };
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()?;
    let response = client
        .get(format!("https://{host}/client/v4/zones/{}", auth.zone_id))
        .bearer_auth(&auth.api_token)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!(fallback))?;
    let value = crate::endpoint_checks::small_json(response)
        .await
        .map_err(|_| anyhow::anyhow!(fallback))?;
    let name = value["result"]["name"]
        .as_str()
        .unwrap_or("")
        .to_ascii_lowercase();
    anyhow::ensure!(
        value["success"] == true && domain(&name) && name.len() <= 240,
        fallback
    );
    Ok(name)
}
fn cloudflare_alias(mut configuration: Value, host: &str) -> anyhow::Result<Value> {
    let ingress = configuration["ingress"]
        .as_array_mut()
        .ok_or_else(|| anyhow::anyhow!("Missing Cloudflare ingress configuration"))?;
    if let Some(rule) = ingress.iter().find(|rule| rule["hostname"] == host) {
        anyhow::ensure!(
            rule["service"] == "http://127.0.0.1:18081",
            "This hostname already routes to another service"
        );
    } else {
        ingress.insert(
            0,
            json!({"hostname":host,"service":"http://127.0.0.1:18081"}),
        );
    }
    Ok(configuration)
}
impl Agent {
    fn cloudflare_cleanup_plan(&self) -> anyhow::Result<Option<CloudflareCleanup>> {
        let mut plan: Option<CloudflareCleanup> = None;
        for name in ["cloudflare.json", "cloudflare-next.json"] {
            let Some(config) = optional_json::<Value>(&self.state.join(name))? else {
                continue;
            };
            let invalid =
                || anyhow::anyhow!("Could not verify the managed Cloudflare tunnel and ingress");
            let tunnel = config["tunnel"]
                .as_str()
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .ok_or_else(invalid)?;
            let path = config["credentials-file"]
                .as_str()
                .map(Path::new)
                .ok_or_else(invalid)?;
            let credential = path
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| cloudflare_credential_name(name) && self.state.join(name) == path)
                .ok_or_else(invalid)?;
            let saved: Value = read_json(&self.state.join(credential)).map_err(|_| invalid())?;
            let account = saved["AccountTag"]
                .as_str()
                .filter(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .ok_or_else(invalid)?;
            anyhow::ensure!(
                saved["TunnelID"]
                    .as_str()
                    .and_then(|id| uuid::Uuid::parse_str(id).ok())
                    == Some(tunnel),
                invalid()
            );
            let current = plan.get_or_insert_with(|| CloudflareCleanup {
                tunnel,
                account: account.to_owned(),
                credential: credential.to_owned(),
                hosts: Default::default(),
                remote_done: false,
            });
            anyhow::ensure!(
                current.tunnel == tunnel
                    && current.credential == credential
                    && current.account == account,
                invalid()
            );
            let hosts = config["ingress"].as_array().ok_or_else(invalid)?;
            current
                .hosts
                .extend(hosts.iter().filter_map(managed_cloudflare_host));
        }
        for entry in std::fs::read_dir(&self.state)? {
            let name = entry?.file_name();
            if let Some(name) = name
                .to_str()
                .filter(|name| cloudflare_credential_name(name))
            {
                anyhow::ensure!(
                    plan.as_ref().is_some_and(|plan| plan.credential == name),
                    "Cloudflare has credentials without matching managed ingress. Verify those tunnels in Cloudflare before retrying; no credentials were removed."
                );
            }
        }
        if let Some(plan) = &plan {
            anyhow::ensure!(
                !plan.hosts.is_empty(),
                "No managed Cloudflare ingress could be verified"
            );
        }
        Ok(plan)
    }

    async fn guard_cleanup(
        &self,
        profile: &Profile,
        hosts: &std::collections::BTreeSet<String>,
    ) -> anyhow::Result<()> {
        let unavailable = || {
            anyhow::anyhow!(
                "Could not verify Companion's active issuer. Start Companion and retry."
            )
        };
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .build()?;
        let response = client
            .get(format!(
                "{}/.well-known/openid-configuration",
                self.companion.trim_end_matches('/')
            ))
            .send()
            .await
            .map_err(|_| unavailable())?;
        anyhow::ensure!(response.status().is_success(), unavailable());
        let discovery = crate::endpoint_checks::small_json(response)
            .await
            .map_err(|_| unavailable())?;
        let issuer =
            crate::endpoint_checks::origin(discovery["issuer"].as_str().ok_or_else(unavailable)?)
                .map_err(|_| unavailable())?;
        let host = issuer
            .host_str()
            .ok_or_else(unavailable)?
            .trim_end_matches('.');
        let matches = |integration: &Integration| {
            integration.profile == *profile
                && url::Url::parse(&integration.companion_url).is_ok_and(|candidate| {
                    candidate
                        .host_str()
                        .is_some_and(|candidate| candidate.trim_end_matches('.') == host)
                })
        };
        let saved = optional_json::<Settings>(&settings_path())
            .map_err(|_| unavailable())?
            .unwrap_or_default();
        let provider =
            optional_json::<Integration>(&provider_path(profile)).map_err(|_| unavailable())?;
        anyhow::ensure!(
            !hosts.contains(host)
                && !(profile == &Profile::Tailscale && host.ends_with(".ts.net"))
                && !saved
                    .accesses
                    .iter()
                    .any(|access| matches(&access.integration))
                && !saved.integration.iter().any(matches)
                && !provider.iter().any(matches),
            "Switch Companion's active issuer before disconnecting this provider"
        );
        Ok(())
    }

    fn clear_provider_state(&self, profile: &Profile) -> anyhow::Result<()> {
        let active_path = self.state.join("active.json");
        if optional_json::<Integration>(&active_path)
            .map_err(|_| anyhow::anyhow!("Could not read the local provider state"))?
            .is_some_and(|active| active.profile == *profile)
        {
            remove_local_file(&active_path)?;
        }
        remove_local_file(&provider_path(profile))
    }

    async fn cleanup_tailscale(&self, daemon: &mut Option<Child>) -> anyhow::Result<&'static str> {
        self.guard_cleanup(&Profile::Tailscale, &Default::default())
            .await?;
        let identity = self.state.join("tailscaled.state");
        let logged_out = self.state.join(TAILSCALE_LOGGED_OUT);
        let confirmed = optional_json::<bool>(&logged_out)
            .map_err(|_| anyhow::anyhow!("Could not read the Tailscale logout journal"))?
            == Some(true);
        if !confirmed && (identity.try_exists()? || daemon.is_some()) {
            if daemon.is_none() {
                *daemon = Some(self.daemon_command().spawn()?);
            }
            let api = crate::tailscale::LocalApi::new(&self.state.join("tailscale.sock"))?;
            tokio::time::timeout(Duration::from_secs(15), async {
                while api.status().await.is_err() {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            })
            .await
            .map_err(|_| anyhow::anyhow!("Tailscale did not become ready for logout"))?;
            api.disconnect().await?;
            write_json(&logged_out, &true)?;
        } else if !confirmed {
            anyhow::ensure!(
                !provider_path(&Profile::Tailscale).try_exists()?,
                "The local Tailscale identity is missing. Check the device in the Tailscale admin console before retrying."
            );
            self.clear_provider_state(&Profile::Tailscale)?;
            return Ok(
                "No local Tailscale identity was found. Check the Tailscale admin console for any device records.",
            );
        }
        stop_child(daemon).await?;
        remove_local_file(&identity)?;
        self.clear_provider_state(&Profile::Tailscale)?;
        remove_local_file(&logged_out)?;
        Ok(
            "Disconnected Tailscale and removed the local identity. Logout expires the device's node key; the expired device may remain in the Tailscale admin console.",
        )
    }

    async fn cleanup_cloudflare(&self, tunnel: &mut Option<Child>) -> anyhow::Result<&'static str> {
        let journal = self.state.join(CLOUDFLARE_CLEANUP);
        let mut plan = match optional_json::<CloudflareCleanup>(&journal)
            .map_err(|_| anyhow::anyhow!("Could not read the Cloudflare cleanup journal"))?
        {
            Some(plan) => Some(plan),
            None => self.cloudflare_cleanup_plan()?,
        };
        self.guard_cleanup(
            &Profile::Cloudflare,
            &plan
                .as_ref()
                .map(|plan| plan.hosts.clone())
                .unwrap_or_default(),
        )
        .await?;
        let cert = self.state.join(".cloudflared/cert.pem");
        if let Some(plan) = plan.as_mut() {
            anyhow::ensure!(
                cloudflare_credential_name(&plan.credential),
                "Invalid managed Cloudflare credential path"
            );
            if !plan.remote_done {
                let zone = cloudflare_domain(&cert).await?;
                anyhow::ensure!(
                    plan.hosts
                        .iter()
                        .all(|host| domain(host) && host.ends_with(&format!(".{zone}"))),
                    "Managed Cloudflare ingress is outside the authorized zone; no DNS was changed"
                );
                let auth = cloudflare_authorization(&std::fs::read_to_string(&cert)?)?;
                anyhow::ensure!(
                    auth.account_id.eq_ignore_ascii_case(&plan.account),
                    "Cloudflare authorization does not match this installation's tunnel account"
                );
                write_json(&journal, plan)?;
                stop_child(tunnel).await?;
                remove_cloudflare_dns(&auth, plan).await?;
                let cert_arg = cert.to_string_lossy();
                let tunnel_id = plan.tunnel.to_string();
                let binary = "/usr/local/bin/cloudflared";
                if self
                    .output(
                        binary,
                        &["tunnel", "--origincert", &cert_arg, "delete", &tunnel_id],
                    )
                    .await
                    .is_err()
                {
                    let listed = self
                        .output(
                            binary,
                            &[
                                "tunnel",
                                "--origincert",
                                &cert_arg,
                                "list",
                                "--show-deleted",
                                "--id",
                                &tunnel_id,
                                "--output",
                                "json",
                            ],
                        )
                        .await
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                    let entry = listed
                        .as_ref()
                        .and_then(|value| listed_tunnel(value, plan.tunnel));
                    if !entry.is_some_and(tunnel_deleted) {
                        let has_connections = entry
                            .and_then(|entry| entry["connections"].as_array())
                            .is_some_and(|connections| !connections.is_empty());
                        anyhow::ensure!(
                            has_connections
                                && self
                                    .output(
                                        binary,
                                        &[
                                            "tunnel",
                                            "--origincert",
                                            &cert_arg,
                                            "cleanup",
                                            &tunnel_id
                                        ]
                                    )
                                    .await
                                    .is_ok()
                                && self
                                    .output(
                                        binary,
                                        &[
                                            "tunnel",
                                            "--origincert",
                                            &cert_arg,
                                            "delete",
                                            &tunnel_id
                                        ]
                                    )
                                    .await
                                    .is_ok(),
                            "Could not confirm Cloudflare tunnel deletion. Local credentials were preserved; check tunnel permissions and dependencies, then retry."
                        );
                    }
                }
                plan.remote_done = true;
                write_json(&journal, plan)?;
            }
            remove_local_file(&self.state.join("cloudflare.json"))?;
            remove_local_file(&self.state.join("cloudflare-next.json"))?;
            remove_local_file(&self.state.join(&plan.credential))?;
        } else {
            anyhow::ensure!(
                tunnel.is_none() && !cloudflare_configured(&self.state),
                "Could not identify the managed Cloudflare tunnel. Verify it in Cloudflare before retrying."
            );
            remove_local_file(&cert)?;
            self.clear_provider_state(&Profile::Cloudflare)?;
            return Ok(
                "No managed Cloudflare tunnel was found. Local Cloudflare authorization was cleared; account authorization was not revoked.",
            );
        }
        remove_local_file(&cert)?;
        self.clear_provider_state(&Profile::Cloudflare)?;
        remove_local_file(&journal)?;
        Ok(
            "Disconnected Cloudflare. Removed the managed tunnel and matching DNS records, and cleared local Cloudflare credentials. Account authorization was not revoked.",
        )
    }

    async fn rename_cloudflare(
        &self,
        request: &ConnectionRequest,
    ) -> anyhow::Result<(Integration, Child)> {
        let host = provider_hostname(&request.companion_url)?;
        let cert = self.state.join(".cloudflared/cert.pem");
        let zone = cloudflare_domain(&cert).await?;
        anyhow::ensure!(
            host.ends_with(&format!(".{zone}")),
            "Choose a subdomain of the domain approved in Cloudflare"
        );
        let mut integration: Integration = read_json(&provider_path(&Profile::Cloudflare))?;
        let config = self.state.join("cloudflare.json");
        let previous: Value = read_json(&config)?;
        let updated = cloudflare_alias(previous.clone(), &host)?;
        let staged = self.state.join("cloudflare-next.json");
        write_json(&staged, &updated)?;
        self.status(
            request,
            "configuring",
            "Updating Cloudflare DNS and tunnel routes. Existing hostnames remain available.",
            None,
            None,
        )?;
        self.output(
            "/usr/local/bin/cloudflared",
            &[
                "tunnel",
                "--config",
                &staged.to_string_lossy(),
                "ingress",
                "validate",
            ],
        )
        .await?;
        let id = updated["tunnel"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing tunnel ID"))?;
        self.output("/usr/local/bin/cloudflared", &["tunnel", "--origincert", &cert.to_string_lossy(), "route", "dns", id, &host])
            .await.map_err(|_| anyhow::anyhow!("Could not create Cloudflare DNS for {host}. Check provider permissions and conflicting DNS records, then retry."))?;
        write_json(&config, &updated)?;
        let child = match self.spawn_cloudflare(&config) {
            Ok(child) => child,
            Err(error) => {
                write_json(&config, &previous)?;
                return Err(error);
            }
        };
        if integration.s3_endpoint == integration.companion_url {
            integration.s3_endpoint = format!("https://{host}");
        }
        integration.companion_url = format!("https://{host}");
        Ok((integration, child))
    }
    async fn rename_tailscale(&self, request: &ConnectionRequest) -> anyhow::Result<Integration> {
        let host = provider_hostname(&request.companion_url)?;
        let previous: Integration = read_json(&provider_path(&Profile::Tailscale))?;
        let old = provider_hostname(&previous.companion_url)?;
        let name = tailscale_name(&old, &host)?;
        let api = crate::tailscale::LocalApi::new(&self.state.join("tailscale.sock"))?;
        let status = api.status().await?;
        anyhow::ensure!(
            status["BackendState"] == "Running"
                && status["Self"]["DNSName"]
                    .as_str()
                    .unwrap_or("")
                    .trim_end_matches('.')
                    == old,
            "Tailscale identity changed; reconnect the provider before renaming"
        );
        self.status(
            request,
            "configuring",
            "Renaming the Tailscale device and updating its HTTPS services…",
            None,
            None,
        )?;
        api.set_hostname(&name).await?;
        let result = async {
            let mut matched = false;
            for _ in 0..15 {
                let status = api.status().await?;
                if status["Self"]["DNSName"].as_str().unwrap_or("").trim_end_matches('.') == host { matched = true; break; }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            anyhow::ensure!(matched, "Tailscale did not assign the requested hostname. Check for a duplicate or an admin-console name override.");
            api.serve(&host).await?;
            Ok(Integration { profile: Profile::Tailscale, companion_url: format!("https://{host}"), omni_url: format!("https://{host}:8443"), s3_endpoint: format!("https://{host}") })
        }.await;
        if result.is_err() {
            let old_name = old.split('.').next().unwrap_or("talos-companion");
            api.set_hostname(old_name).await
                .map_err(|_| anyhow::anyhow!("Tailscale rename failed and the previous hostname could not be restored. Reconnect Tailscale to recover."))?;
            api.serve(&old).await?;
        }
        result
    }
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
    fn daemon_command(&self) -> Command {
        let mut command = self.command("/usr/local/bin/tailscaled");
        command
            .args([
                "--tun=userspace-networking",
                &format!("--state={}", self.state.join("tailscaled.state").display()),
                // A custom --state filename does not establish Tailscale's certificate
                // cache directory. Keep certificates writable inside existing appdata.
                &format!("--statedir={}", self.state.display()),
                &self.socket_arg(),
                "--socks5-server=127.0.0.1:1055",
            ])
            .stdout(Stdio::null());
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
        // cloudflared prints its authorization URL to stderr.
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
            "Finding the domain you approved in Cloudflare…",
            None,
            None,
        )?;
        let domain = if request.domain.is_empty() {
            cloudflare_domain(&cert).await?
        } else {
            anyhow::ensure!(domain(&request.domain), "Invalid Cloudflare domain");
            request.domain.clone()
        };
        self.status(
            request,
            "configuring",
            "Creating the tunnel and DNS records. Existing DNS records will not be overwritten.",
            None,
            None,
        )?;
        let cert = cert.to_string_lossy();
        let domain_id = hex::encode(Sha256::digest(domain.as_bytes()));
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
            format!("talos-companion.{domain}"),
            format!("omni.{domain}"),
        ];
        let config = self.state.join("cloudflare.json");
        let configuration = json!({"tunnel":id,"credentials-file":credential,"ingress":[
            {"hostname":hostnames[0],"service":"http://127.0.0.1:18081"},
            {"hostname":hostnames[1],"service":"http://127.0.0.1:18082"},
            {"service":"http_status:404"}
        ]});
        let staged = self.state.join("cloudflare-next.json");
        if !config.try_exists()? && !staged.try_exists()? {
            write_json(&staged, &configuration)?;
        }
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
            .await.map_err(|_| anyhow::anyhow!("Couldn’t create the DNS record for {hostname}. Check that the approved domain matches and that this hostname has no conflicting DNS record, then try again."))?;
        }
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
            s3_endpoint: format!("https://{}", hostnames[0]),
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
        let api = crate::tailscale::LocalApi::new(&self.state.join("tailscale.sock"))?;
        self.tailscale_connect(request, &api).await
    }
    async fn tailscale_connect(
        &self,
        request: &ConnectionRequest,
        api: &crate::tailscale::LocalApi,
    ) -> anyhow::Result<Integration> {
        // The agent can receive its first request before the daemon has opened its socket.
        tokio::time::timeout(Duration::from_secs(15), async {
            while api.status().await.is_err() {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("Tailscale daemon did not become ready"))?;
        let saved = read_json::<Integration>(&provider_path(&Profile::Tailscale)).ok();
        let name = saved
            .as_ref()
            .and_then(|i| provider_hostname(&i.companion_url).ok())
            .and_then(|h| h.split('.').next().map(str::to_owned))
            .unwrap_or_else(|| "talos-companion".into());
        api.start(&name).await?;
        let mut login_requested = false;
        let status = loop {
            let status = api.status().await?;
            if status["BackendState"] == "Running" {
                break status;
            }
            if status["BackendState"] == "NeedsLogin" && !login_requested {
                api.login().await?;
                login_requested = true;
            }
            let auth_url = status["AuthURL"].as_str().and_then(authorization_url);
            self.status(request, "authorizing",
                if status["BackendState"] == "NeedsMachineAuth" {
                    "Approve this Companion device in the Tailscale admin console, then return here."
                } else { "Sign in to Tailscale and approve this Companion device, then return here." },
                auth_url, None)?;
            tokio::time::sleep(Duration::from_secs(1)).await;
        };
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
        loop {
            let feature = api.enable_https().await?;
            if feature["Complete"] == true {
                break;
            }
            let auth_url = feature["URL"].as_str().and_then(authorization_url);
            anyhow::ensure!(
                feature["ShouldWait"] == true && auth_url.is_some(),
                "Enable HTTPS certificates in your Tailscale admin console, then retry"
            );
            self.status(
                request,
                "authorizing",
                "Approve HTTPS in Tailscale, then return here.",
                auth_url,
                None,
            )?;
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        api.serve(hostname).await?;
        Ok(Integration {
            profile: Profile::Tailscale,
            companion_url: format!("https://{hostname}"),
            omni_url: format!("https://{hostname}:8443"),
            s3_endpoint: format!("https://{hostname}"),
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
            &json!({"updated_at":now(),"providers":bundled_providers(),"s3_origin":agent.s3,"omni_origin":settings().omni_origin,"companion_origin":agent.companion}),
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

fn cleanup_status(path: &Path, id: &str, state: &str, message: &str) -> anyhow::Result<()> {
    write_json(
        path,
        &CleanupStatus {
            id: id.into(),
            state: state.into(),
            message: message.into(),
        },
    )
}

fn recover_cleanup(path: &Path) -> anyhow::Result<Option<CleanupStatus>> {
    let status: Option<CleanupStatus> = optional_json(path)
        .map_err(|_| anyhow::anyhow!("Could not read the provider cleanup journal"))?;
    if let Some(status) = &status
        && status.state == "running"
    {
        cleanup_status(
            path,
            &status.id,
            "failed",
            "Provider cleanup was interrupted. Check provider status and explicitly retry the disconnect.",
        )?;
    }
    Ok(status)
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
    let cleanup_path = control.join("cleanup-status.json");
    let mut last_cleanup = recover_cleanup(&cleanup_path)?.map(|status| status.id);
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
    let companion = source("COMPANION_ORIGIN", "http://127.0.0.1:8080")?;
    let s3 = source("S3_ORIGIN", &companion)?;
    let agent = std::sync::Arc::new(Agent {
        control: control.clone(),
        state,
        companion,
        omni: if settings().omni_origin.is_empty() {
            "https://127.0.0.1:19443".into()
        } else {
            settings().omni_origin
        },
        s3,
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
    let mut daemon = if provider_bundled(&Profile::Tailscale)
        && agent.state.join("tailscaled.state").try_exists()?
        && !agent.state.join(TAILSCALE_LOGGED_OUT).try_exists()?
    {
        Some(agent.daemon_command().spawn()?)
    } else {
        None
    };
    // Heartbeat runs during browser authorization as well as while idle.
    let mut heartbeat = tokio::spawn(heartbeat(agent.clone()));
    let mut tunnel: Option<Child> = None;
    if provider_bundled(&Profile::Cloudflare)
        && !agent.state.join(CLOUDFLARE_CLEANUP).try_exists()?
        && cloudflare_configured(&agent.state)
    {
        tunnel = Some(agent.spawn_cloudflare(&agent.state.join("cloudflare.json"))?);
    }
    let mut last = read_json::<ConnectionStatus>(&control.join("status.json"))
        .ok()
        .filter(|s| matches!(s.state.as_str(), "connected" | "failed"))
        .map(|s| s.id)
        .unwrap_or_default();
    loop {
        if let Ok(request) = read_json::<CleanupRequest>(&control.join("cleanup-request.json"))
            && last_cleanup.as_deref() != Some(request.id.as_str())
            && request.expires_at > now()
        {
            cleanup_status(
                &cleanup_path,
                &request.id,
                "running",
                "Disconnecting the managed provider…",
            )?;
            last_cleanup = Some(request.id.clone());
            let deadline = Duration::from_secs(
                request
                    .expires_at
                    .saturating_sub(now())
                    .saturating_sub(3)
                    .min(165),
            );
            let result = tokio::time::timeout(deadline, async {
                anyhow::ensure!(
                    !read_json::<ConnectionRequest>(&control.join("request.json")).is_ok_and(
                        |connection| { connection.id != last && connection.expires_at > now() }
                    ),
                    "Finish the pending provider authorization before disconnecting"
                );
                anyhow::ensure!(
                    provider_bundled(&request.profile),
                    "The provider connector is not available"
                );
                match request.profile {
                    Profile::Cloudflare => agent.cleanup_cloudflare(&mut tunnel).await,
                    Profile::Tailscale => agent.cleanup_tailscale(&mut daemon).await,
                    Profile::Lan => anyhow::bail!("LAN has no provider to disconnect"),
                }
            })
            .await;
            match result {
                Ok(Ok(message)) => {
                    cleanup_status(&cleanup_path, &request.id, "succeeded", message)?
                }
                Ok(Err(error)) => {
                    cleanup_status(&cleanup_path, &request.id, "failed", &error.to_string())?
                }
                Err(_) => cleanup_status(
                    &cleanup_path,
                    &request.id,
                    "failed",
                    "Provider cleanup timed out. Some remote changes may have completed; explicitly retry the disconnect.",
                )?,
            }
        }
        if let Some(child) = daemon.as_mut() {
            anyhow::ensure!(child.try_wait()?.is_none(), "Tailscale daemon stopped");
        }
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
                    anyhow::ensure!(
                        provider_bundled(&request.profile),
                        "This image does not include the requested connector"
                    );
                    match request.profile {
                        Profile::Cloudflare => {
                            anyhow::ensure!(
                                !agent.state.join(CLOUDFLARE_CLEANUP).try_exists()?,
                                "Finish the interrupted Cloudflare disconnect before reconnecting"
                            );
                            let (integration, child) = if request.companion_url.is_empty() {
                                agent.cloudflare(&request).await?
                            } else {
                                agent.rename_cloudflare(&request).await?
                            };
                            if let Some(mut old) = tunnel.take() {
                                let _ = old.kill().await;
                            }
                            tunnel = Some(child);
                            Ok(integration)
                        }
                        Profile::Tailscale => {
                            anyhow::ensure!(
                                !agent.state.join(TAILSCALE_LOGGED_OUT).try_exists()?,
                                "Finish the interrupted Tailscale disconnect before reconnecting"
                            );
                            if daemon.is_none() {
                                daemon = Some(agent.daemon_command().spawn()?);
                            }
                            if request.companion_url.is_empty() {
                                agent.tailscale(&request).await
                            } else {
                                agent.rename_tailscale(&request).await
                            }
                        }
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
    #[test]
    fn interrupted_cleanup_becomes_terminal_even_without_a_current_request() {
        let dir = tempfile::tempdir().unwrap();
        let status_path = dir.path().join("cleanup-status.json");
        cleanup_status(&status_path, "old", "running", "working").unwrap();
        assert_eq!(recover_cleanup(&status_path).unwrap().unwrap().id, "old");
        let recovered: CleanupStatus = read_json(&status_path).unwrap();
        assert_eq!(recovered.state, "failed");
        assert!(recovered.message.contains("explicitly retry"));
        assert_eq!(
            recover_cleanup(&status_path).unwrap().unwrap().state,
            "failed"
        );
    }

    #[tokio::test]
    async fn cloudflare_dns_retry_skips_deleted_records_and_preserves_other_targets() {
        use axum::{Json, Router, extract::Request};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };

        let tunnel = uuid::Uuid::new_v4();
        let target = format!("{tunnel}.cfargotunnel.com");
        let host = "companion.example.com";
        let good_id = "11111111111111111111111111111111";
        let changed_id = "22222222222222222222222222222222";
        let other_id = "33333333333333333333333333333333";
        let deletes = Arc::new(AtomicUsize::new(0));
        let calls = deletes.clone();
        let router = Router::new().fallback(move |request: Request| {
            let calls = calls.clone();
            let target = target.clone();
            async move {
                let record = |id, name, content: &str| json!({"id":id,"name":name,"content":content,"type":"CNAME"});
                let base = "/dns_records";
                let path = request.uri().path();
                let result = match (request.method().as_str(), path) {
                    ("GET", "/dns_records") => {
                        assert!(request.uri().query().unwrap().contains("name.exact=companion.example.com"));
                        let mut rows = vec![record(changed_id, host, &target), record(other_id, "other.example.com", &target), record(other_id, host, "other.cfargotunnel.com")];
                        if calls.load(Ordering::SeqCst) == 0 {
                            rows.push(record(good_id, host, &target));
                        }
                        return Json(json!({"success":true,"result_info":{"total_pages":1},"result":rows}));
                    }
                    ("GET", _) if path == format!("{base}/{good_id}") => record(good_id, host, &target),
                    ("GET", _) if path == format!("{base}/{changed_id}") => record(changed_id, host, "changed.example.com"),
                    ("DELETE", _) if path == format!("{base}/{good_id}") => {
                        calls.fetch_add(1, Ordering::SeqCst);
                        json!({"id":good_id})
                    }
                    _ => panic!("unexpected DNS request"),
                };
                Json(json!({"success":true,"result":result}))
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/dns_records", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let plan = CloudflareCleanup {
            tunnel,
            account: String::new(),
            credential: String::new(),
            hosts: [host.to_owned()].into(),
            remote_done: false,
        };
        for _ in 0..2 {
            remove_tunnel_dns(&client, &endpoint, "test-token", &plan)
                .await
                .unwrap();
        }
        assert_eq!(deletes.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn tailscale_browser_login_https_approval_and_existing_identity_use_localapi() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        for already_logged_in in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let agent = Agent {
                state: dir.path().to_owned(),
                control: dir.path().to_owned(),
                companion: String::new(),
                omni: String::new(),
                s3: String::new(),
            };
            let request = ConnectionRequest {
                id: "localapi-test".into(),
                profile: Profile::Tailscale,
                domain: String::new(),
                companion_url: String::new(),
                expires_at: now() + 60,
            };
            let login_calls = Arc::new(AtomicUsize::new(0));
            let feature_calls = Arc::new(AtomicUsize::new(0));
            let login = login_calls.clone();
            let feature = feature_calls.clone();
            let control = dir.path().to_owned();
            let router = axum::Router::new().fallback(move |req: axum::extract::Request| {
                let login = login.clone(); let feature = feature.clone(); let control = control.clone();
                async move {
                    let value = match req.uri().path() {
                        "/localapi/v0/status" if !already_logged_in && login.load(Ordering::SeqCst)==0 => json!({"BackendState":"NeedsLogin"}),
                        "/localapi/v0/login-interactive" => { login.fetch_add(1, Ordering::SeqCst); json!({}) },
                        "/localapi/v0/status" => json!({"BackendState":"Running","Self":{"DNSName":"companion.test.ts.net."}}),
                        "/localapi/v0/query-feature" if feature.fetch_add(1, Ordering::SeqCst)==0 => json!({"ShouldWait":true,"URL":"https://login.tailscale.com/f/serve"}),
                        "/localapi/v0/query-feature" => {
                            let status:ConnectionStatus=read_json(&control.join("status.json")).unwrap();
                            assert_eq!(status.auth_url.as_deref(), Some("https://login.tailscale.com/f/serve"));
                            json!({"Complete":true})
                        },
                        "/localapi/v0/serve-config" => Value::Null,
                        _ => json!({}),
                    };
                    axum::response::Response::builder().header("etag","\"test\"").body(axum::body::Body::from(value.to_string())).unwrap()
                }
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let api = crate::tailscale::LocalApi::for_test(format!(
                "http://{}",
                listener.local_addr().unwrap()
            ));
            let server = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            let integration = agent.tailscale_connect(&request, &api).await.unwrap();
            assert_eq!(integration.companion_url, "https://companion.test.ts.net");
            assert_eq!(integration.omni_url, "https://companion.test.ts.net:8443");
            assert_eq!(integration.s3_endpoint, "https://companion.test.ts.net");
            assert_eq!(
                login_calls.load(Ordering::SeqCst),
                usize::from(!already_logged_in)
            );
            server.abort();
        }
    }

    #[test]
    fn hostname_edits_preserve_existing_cloudflare_services_and_are_retryable() {
        let original = serde_json::json!({"tunnel":"test", "ingress":[
            {"hostname":"old.example.test","service":"http://127.0.0.1:18081"},
            {"hostname":"omni.example.test","service":"http://127.0.0.1:18082"},
            {"service":"http_status:404"}
        ]});
        let updated = super::cloudflare_alias(original.clone(), "new.example.test").unwrap();
        assert_eq!(
            &updated["ingress"].as_array().unwrap()[1..],
            original["ingress"].as_array().unwrap()
        );
        assert_eq!(updated["ingress"][0]["hostname"], "new.example.test");
        assert_eq!(
            super::cloudflare_alias(updated.clone(), "new.example.test").unwrap(),
            updated
        );
        assert!(super::cloudflare_alias(original, "omni.example.test").is_err());
    }
    #[test]
    fn cloudflare_selected_zone_is_decoded_without_exposing_credentials() {
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            br#"{"zoneID":"0123456789abcdef0123456789abcdef","accountID":"account","apiToken":"private-test-token"}"#,
        );
        let pem = format!(
            "-----BEGIN ARGO TUNNEL TOKEN-----\n{encoded}\n-----END ARGO TUNNEL TOKEN-----"
        );
        let auth = super::cloudflare_authorization(&pem).unwrap();
        assert_eq!(auth.zone_id.len(), 32);
        assert!(auth.zone_id.starts_with("01234567"));
        assert_eq!(auth.api_token.len(), 18);
        for invalid in [
            format!("{pem}\n{pem}"),
            pem.replace(&encoded, "private-test-token"),
            pem.replace(
                &encoded,
                &base64::engine::general_purpose::STANDARD
                    .encode(br#"{"zoneID":"../../attacker","apiToken":"private-test-token"}"#),
            ),
        ] {
            let error = super::cloudflare_authorization(&invalid)
                .err()
                .unwrap()
                .to_string();
            assert!(!error.contains("private-test-token"));
        }
    }
    use super::*;
    #[test]
    fn tailscale_keeps_certificates_and_existing_identity_in_writable_appdata() {
        let agent = Agent {
            state: PathBuf::from("/data/connections/private"),
            control: PathBuf::from("/data/connections/control"),
            companion: String::new(),
            omni: String::new(),
            s3: String::new(),
        };
        let command = agent.daemon_command();
        let args = command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(
            args.contains(&"--statedir=/data/connections/private".to_owned()),
            "Tailscale Serve needs an explicit writable certificate directory even when --state is set"
        );
        let state_file = args
            .iter()
            .find_map(|a| a.strip_prefix("--state="))
            .unwrap();
        assert_eq!(Path::new(state_file).parent(), Some(agent.state.as_path()));
        assert_eq!(
            Path::new(state_file).file_name().unwrap(),
            "tailscaled.state"
        );
        assert!(args.contains(&"--tun=userspace-networking".to_owned()));
    }
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
