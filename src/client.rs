use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use zeroize::Zeroizing;
pub fn server(url: &str) -> Result<()> {
    ensure!(
        url.starts_with("https://") && !url.contains(['\n', '\r', '@']),
        "control plane must use HTTPS"
    );
    Ok(())
}
fn token_entry(url: &str) -> Result<keyring::Entry> {
    server(url)?;
    let uri: ureq::http::Uri = url.parse()?;
    let authority = uri.authority().context("missing control plane host")?;
    let mut origin = format!("https://{}", authority.host().to_ascii_lowercase());
    if let Some(port) = authority.port_u16().filter(|port| *port != 443) {
        origin.push_str(&format!(":{port}"));
    }
    Ok(keyring::Entry::new(
        "bettergit",
        &format!("github-token:{origin}"),
    )?)
}
pub fn request(method: &str, url: &str, body: Option<Value>) -> Result<Value> {
    authenticated_request(method, url, body, url)
}
pub fn github_repo(server: &str, slug: &str) -> Result<Value> {
    let valid = |part: &str| {
        !matches!(part, "" | "." | "..")
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    };
    ensure!(
        slug.split_once('/')
            .is_some_and(|(owner, repo)| valid(owner) && valid(repo)),
        "invalid GitHub repo"
    );
    authenticated_request(
        "GET",
        &format!("https://api.github.com/repos/{slug}"),
        None,
        server,
    )
}
fn authenticated_request(
    method: &str,
    url: &str,
    body: Option<Value>,
    credential_origin: &str,
) -> Result<Value> {
    let token = Zeroizing::new(
        token_entry(credential_origin)?
            .get_password()
            .context("run bettergit login for this control-plane origin")?,
    );
    let r = ureq::http::Request::builder()
        .method(method)
        .uri(url)
        .header("Authorization", format!("Bearer {}", token.as_str()))
        .header("Content-Type", "application/json")
        .body(body.map(|v| v.to_string()).unwrap_or_default())?;
    // Disable redirects so bearer tokens never cross origins.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .build()
        .into();
    let mut response = agent.run(r)?;
    if response.status() == 204 {
        return Ok(Value::Null);
    }
    Ok(response.body_mut().read_json()?)
}
pub fn login(client_id: &str, server: &str) -> Result<()> {
    let entry = token_entry(server)?;
    let mut response = ureq::post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .send_json(json!({"client_id":client_id}))?;
    let device: Value = response.body_mut().read_json()?;
    println!(
        "Open {} and enter {}",
        device["verification_uri"]
            .as_str()
            .context("missing verification URL")?,
        device["user_code"]
            .as_str()
            .context("missing device code")?
    );
    let mut interval = device["interval"].as_u64().unwrap_or(5).max(5);
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(device["expires_in"].as_u64().unwrap_or(900));
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_secs(interval));
        let value:Value=ureq::post("https://github.com/login/oauth/access_token").header("Accept","application/json").send_json(json!({"client_id":client_id,"device_code":device["device_code"],"grant_type":"urn:ietf:params:oauth:grant-type:device_code"}))?.body_mut().read_json()?;
        if let Some(token) = value["access_token"].as_str() {
            entry.set_password(token)?;
            return Ok(());
        }
        match value["error"].as_str() {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += 5,
            _ => bail!("GitHub device authorization failed"),
        }
    }
    bail!("GitHub device authorization expired")
}
