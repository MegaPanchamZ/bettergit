use age::secrecy::ExposeSecret;
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::io::Write;
use zeroize::Zeroizing;
fn request(method: &str, url: &str, token: &str, body: Value) -> Result<Value> {
    crate::client::server(url)?;
    let request = ureq::http::Request::builder()
        .method(method)
        .uri(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .body(if body.is_null() {
            String::new()
        } else {
            body.to_string()
        })?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .build()
        .into();
    Ok(agent.run(request)?.body_mut().read_json()?)
}
pub fn decrypt(
    server: &str,
    policy: &str,
    blob: &std::path::Path,
    trust_path: &std::path::Path,
    oidc_command: Option<&std::path::Path>,
    output: &std::path::Path,
    context: Option<(&str, bool)>,
) -> Result<()> {
    ensure!(
        policy.bytes().all(|c| c.is_ascii_digit()),
        "invalid policy ID"
    );
    let (path, whole_file) = context.context("--path is required for signed content")?;
    let ephemeral = age::x25519::Identity::generate();
    let trust: crate::oidc::Trust = serde_json::from_slice(&std::fs::read(trust_path)?)?;
    ensure!(
        trust.server == server,
        "server differs from pinned CI trust"
    );
    let audience = crate::oidc::audience(
        &trust.audience,
        &trust.group_id,
        &ephemeral.to_public().to_string(),
    );
    let token = if let Some(command) = oidc_command {
        let output = std::process::Command::new(command)
            .arg(&audience)
            .output()?;
        ensure!(output.status.success(), "OIDC token helper failed");
        Zeroizing::new(String::from_utf8(output.stdout)?)
    } else {
        let endpoint = std::env::var("ACTIONS_ID_TOKEN_REQUEST_URL")?;
        let uri: ureq::http::Uri = endpoint.parse()?;
        ensure!(
            uri.scheme_str() == Some("https")
                && uri
                    .host()
                    .is_some_and(|h| h.ends_with(".actions.githubusercontent.com")),
            "untrusted GitHub token endpoint"
        );
        let auth = Zeroizing::new(std::env::var("ACTIONS_ID_TOKEN_REQUEST_TOKEN")?);
        let encoded: String = audience.bytes().map(|b| format!("%{b:02X}")).collect();
        let value: Value = ureq::get(format!("{endpoint}&audience={encoded}"))
            .header("Authorization", format!("Bearer {}", auth.as_str()))
            .call()?
            .body_mut()
            .read_json()?;
        Zeroizing::new(
            value["value"]
                .as_str()
                .context("missing OIDC token")?
                .to_owned(),
        )
    };
    let token = token.trim();
    crate::oidc::verify(token, &ephemeral.to_public().to_string(), &trust)?;
    let value = request(
        "POST",
        &format!("{}/v1/ci/{policy}/requests", server.trim_end_matches('/')),
        token,
        json!({"publicKey":ephemeral.to_public().to_string()}),
    )?;
    let id = value["id"].as_str().context("invalid CI request")?;
    eprintln!("Better Git CI request {id}: awaiting authorized broker");
    for _ in 0..60 {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let value = request(
            "GET",
            &format!("{}/v1/ci/requests/{id}", server.trim_end_matches('/')),
            token,
            Value::Null,
        )?;
        if let Some(wrapped) = value["encrypted_dek_blob"].as_str() {
            let bytes = crate::crypto::decrypt(&STANDARD.decode(wrapped)?, &ephemeral)?;
            let group: age::x25519::Identity = std::str::from_utf8(&bytes)?
                .parse()
                .map_err(|_| anyhow::anyhow!("invalid group key"))?;
            ensure!(
                group.to_public().to_string() == trust.key_public,
                "unexpected group key"
            );
            let ciphertext = std::fs::read(blob)?;
            let mode = if whole_file {
                crate::config::Mode::File
            } else if path.ends_with(".json") {
                crate::config::Mode::Json
            } else if path.ends_with(".yaml") || path.ends_with(".yml") {
                crate::config::Mode::Yaml
            } else {
                crate::config::Mode::Value
            };
            let plain = crate::engine::smudge_at(path, &ciphertext, mode, &group)?;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(output)?.write_all(&plain)?;
            return Ok(());
        }
    }
    bail!("CI request expired")
}
pub fn approve(
    server: &str,
    group_id: &str,
    group: &age::x25519::Identity,
    trust: &crate::oidc::Trust,
) -> Result<()> {
    ensure!(
        group_id.bytes().all(|c| c.is_ascii_digit()),
        "invalid group ID"
    );
    ensure!(
        trust.server == server
            && trust.group_id == group_id
            && trust.key_public == group.to_public().to_string(),
        "broker trust/group/key mismatch"
    );
    let requests = crate::client::request(
        "GET",
        &format!(
            "{}/v1/groups/{group_id}/ci-requests",
            server.trim_end_matches('/')
        ),
        None,
    )?;
    for req in requests.as_array().context("invalid pending list")? {
        let result = (|| -> Result<()> {
            let id = req["id"].as_str().context("missing request ID")?;
            ensure!(
                id.len() == 36 && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'),
                "invalid request ID"
            );
            ensure!(
                req["group_id"].as_str() == Some(group_id),
                "pending group mismatch"
            );
            let recipient = req["public_key"]
                .as_str()
                .context("missing recipient")?
                .parse()
                .map_err(|_| anyhow::anyhow!("invalid CI recipient"))?;
            crate::oidc::verify(
                req["oidc_token"]
                    .as_str()
                    .context("missing signed workload proof")?,
                req["public_key"].as_str().context("missing recipient")?,
                trust,
            )?;
            let envelope =
                crate::crypto::encrypt(group.to_string().expose_secret().as_bytes(), &recipient)?;
            crate::client::request(
                "PUT",
                &format!(
                    "{}/v1/ci/requests/{id}/approve",
                    server.trim_end_matches('/')
                ),
                Some(json!({"envelope":STANDARD.encode(envelope)})),
            )?;
            Ok(())
        })();
        if result.is_err() {
            eprintln!("bettergit: rejected an unverifiable CI request");
        }
    }
    Ok(())
}
