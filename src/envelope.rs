use age::secrecy::ExposeSecret;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;
#[derive(Serialize, Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    repo: String,
    group: String,
    key: String,
    public: String,
}
pub fn repo(origin: &str) -> String {
    origin
        .trim()
        .trim_end_matches(".git")
        .trim_start_matches("git@github.com:")
        .trim_start_matches("https://github.com/")
        .to_ascii_lowercase()
}
pub fn wrap(
    key: &age::x25519::Identity,
    recipient: &age::x25519::Recipient,
    origin: &str,
    group: &str,
) -> Result<Vec<u8>> {
    let envelope = Envelope {
        repo: repo(origin),
        group: group.into(),
        key: key.to_string().expose_secret().to_owned(),
        public: key.to_public().to_string(),
    };
    let bytes = Zeroizing::new(serde_json::to_vec(&envelope)?);
    crate::crypto::encrypt(&bytes, recipient)
}
pub fn unwrap(
    bytes: &[u8],
    identity: &age::x25519::Identity,
    origin: &str,
    group: &str,
) -> Result<age::x25519::Identity> {
    let plain = crate::crypto::decrypt(bytes, identity)?;
    let envelope: Envelope = serde_json::from_slice(&plain)?;
    ensure!(
        envelope.repo == repo(origin) && envelope.group == group,
        "envelope belongs to another repository or group"
    );
    let key: age::x25519::Identity = envelope
        .key
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid group identity"))?;
    ensure!(
        key.to_public().to_string() == envelope.public,
        "group key fingerprint mismatch"
    );
    Ok(key)
}
