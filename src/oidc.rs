use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trust {
    pub server: String,
    pub group_id: String,
    pub group: String,
    pub issuer: String,
    pub audience: String,
    pub subject: String,
    pub required_claims: HashMap<String, String>,
    pub key_public: String,
}
pub fn audience(base: &str, group: &str, recipient: &str) -> String {
    format!("{base}:group:{group}:recipient:{recipient}")
}
pub fn verify(token: &str, recipient: &str, trust: &Trust) -> Result<Value> {
    ensure!(
        trust.issuer == "https://token.actions.githubusercontent.com"
            || (trust.issuer.starts_with("https://oidc.vercel.com/")
                && trust.issuer[24..]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')),
        "untrusted issuer"
    );
    let jwks: jsonwebtoken::jwk::JwkSet = ureq::get(format!("{}/.well-known/jwks", trust.issuer))
        .call()?
        .body_mut()
        .read_json()?;
    let header = jsonwebtoken::decode_header(token)?;
    ensure!(
        header.alg == jsonwebtoken::Algorithm::RS256,
        "unexpected signing algorithm"
    );
    let jwk = jwks
        .find(header.kid.as_deref().context("missing signing key ID")?)
        .context("unknown signing key")?;
    let key = jsonwebtoken::DecodingKey::from_jwk(jwk)?;
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_issuer(&[&trust.issuer]);
    validation.set_audience(&[audience(&trust.audience, &trust.group_id, recipient)]);
    validation.sub = Some(trust.subject.clone());
    validation.leeway = 0;
    let claims = jsonwebtoken::decode::<Value>(token, &key, &validation)?.claims;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    let issued = claims["iat"].as_u64().context("missing issued time")?;
    let expires = claims["exp"].as_u64().context("missing expiry")?;
    ensure!(
        issued <= now + 30 && expires >= now && expires.saturating_sub(issued) <= 7200,
        "invalid token lifetime"
    );
    ensure!(
        !trust.required_claims.is_empty(),
        "explicit workload restrictions required"
    );
    for (key, value) in &trust.required_claims {
        ensure!(
            claims[key].as_str() == Some(value),
            "workload claim mismatch"
        );
    }
    if trust.issuer == "https://token.actions.githubusercontent.com" {
        for claim in [
            "repository_id",
            "repository_owner_id",
            "ref",
            "workflow_ref",
            "environment",
            "runner_environment",
            "event_name",
        ] {
            ensure!(
                trust.required_claims.contains_key(claim),
                "missing pinned workload claim {claim}"
            );
        }
        ensure!(
            ["push", "workflow_dispatch", "schedule"]
                .contains(&claims["event_name"].as_str().unwrap_or("")),
            "untrusted trigger"
        );
    } else {
        for claim in ["project_id", "owner_id", "environment"] {
            ensure!(
                trust.required_claims.contains_key(claim),
                "missing pinned Vercel claim"
            );
        }
    }
    Ok(claims)
}
