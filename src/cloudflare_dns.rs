//! Supplemental public DNS resolution. TLS still authenticates the requested hostname.
use crate::endpoint_checks::small_json;
use serde_json::Value;
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

fn answers(value: &Value, host: &str, record_type: u64) -> anyhow::Result<Vec<SocketAddr>> {
    anyhow::ensure!(
        value["Status"] == 0 && value["TC"] != true,
        "Cloudflare DNS lookup failed"
    );
    let mut addresses = Vec::new();
    for answer in value["Answer"].as_array().into_iter().flatten() {
        if answer["type"] != record_type
            || !answer["name"]
                .as_str()
                .is_some_and(|name| name.trim_end_matches('.').eq_ignore_ascii_case(host))
        {
            continue;
        }
        let ip: IpAddr = answer["data"].as_str().unwrap_or("").parse()?;
        anyhow::ensure!(
            matches!((record_type, ip), (1, IpAddr::V4(_)) | (28, IpAddr::V6(_))),
            "Unexpected DNS address type"
        );
        addresses.push(SocketAddr::new(ip, 443));
    }
    Ok(addresses)
}

pub async fn resolve(host: &str) -> anyhow::Result<Vec<SocketAddr>> {
    anyhow::ensure!(
        crate::connections::domain(host),
        "Cloudflare DNS requires a public hostname"
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        // Bootstrap DoH independently of the possibly stale system resolver.
        .resolve("cloudflare-dns.com", "1.1.1.1:443".parse()?)
        .build()?;
    async fn query(
        client: &reqwest::Client,
        host: &str,
        kind: u64,
    ) -> anyhow::Result<Vec<SocketAddr>> {
        let response = client
            .get("https://cloudflare-dns.com/dns-query")
            .header("accept", "application/dns-json")
            .query(&[("name", host), ("type", &kind.to_string())])
            .send()
            .await?;
        answers(&small_json(response).await?, host, kind)
    }
    let (ipv4, ipv6) = tokio::join!(query(&client, host, 1), query(&client, host, 28));
    let addresses: Vec<_> = ipv4.into_iter().chain(ipv6).flatten().collect();
    anyhow::ensure!(
        !addresses.is_empty(),
        "Cloudflare DNS returned no usable addresses"
    );
    Ok(addresses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_only_requested_host_and_address_family() {
        let value = json!({"Status":0,"Answer":[
            {"name":"Companion.Example.com.","type":1,"data":"104.21.44.162"},
            {"name":"other.example.com.","type":1,"data":"192.0.2.1"},
            {"name":"companion.example.com.","type":28,"data":"2606:4700::1111"}
        ]});
        assert_eq!(
            answers(&value, "companion.example.com", 1).unwrap(),
            vec!["104.21.44.162:443".parse::<SocketAddr>().unwrap()]
        );
        assert_eq!(
            answers(&value, "companion.example.com", 28).unwrap().len(),
            1
        );
        assert!(answers(&json!({"Status":3}), "companion.example.com", 1).is_err());
        assert!(answers(&json!({"Status":0,"TC":true}), "companion.example.com", 1).is_err());
        assert!(
            answers(&json!({"Status":0}), "companion.example.com", 1)
                .unwrap()
                .is_empty()
        );
        assert!(answers(&json!({"Status":0,"Answer":[{"name":"companion.example.com","type":1,"data":"::1"}]}), "companion.example.com", 1).is_err());
    }
}
