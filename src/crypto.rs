use anyhow::Result;
use std::io::{Read, Write};
use zeroize::Zeroizing;
pub fn encrypt(data: &[u8], recipient: &age::x25519::Recipient) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let enc = age::Encryptor::with_recipients(std::iter::once(recipient as &dyn age::Recipient))?;
    let mut stream = enc.wrap_output(&mut out)?;
    stream.write_all(data)?;
    stream.finish()?;
    Ok(out)
}
pub fn decrypt(data: &[u8], identity: &age::x25519::Identity) -> Result<Zeroizing<Vec<u8>>> {
    let mut out = Zeroizing::new(Vec::new());
    age::Decryptor::new(data)?
        .decrypt(std::iter::once(identity as &dyn age::Identity))?
        .read_to_end(&mut out)?;
    Ok(out)
}

pub fn validate(data: &[u8]) -> Result<()> {
    use anyhow::{Context, ensure};
    age::Decryptor::new(data)?;
    let mac = data
        .windows(5)
        .position(|s| s == b"\n--- ")
        .context("age header MAC missing")?
        + 5;
    let end = data[mac..]
        .iter()
        .position(|b| *b == b'\n')
        .context("truncated age header")?
        + mac
        + 1;
    ensure!(data.len() >= end + 32, "age payload is truncated");
    Ok(())
}

/// Group members derive a distinct signing key from their existing age identity.
pub fn signing_key(identity: &age::x25519::Identity) -> ed25519_dalek::SigningKey {
    use age::secrecy::ExposeSecret;
    let secret = identity.to_string();
    let mut seed = Zeroizing::new([0u8; 32]);
    hkdf::Hkdf::<sha2::Sha256>::new(None, secret.expose_secret().as_bytes())
        .expand(b"bettergit/content/signing-key/v2", seed.as_mut())
        .expect("valid Ed25519 seed length");
    ed25519_dalek::SigningKey::from_bytes(&seed)
}

pub fn parse_signer(encoded: &str) -> Result<ed25519_dalek::VerifyingKey> {
    use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
    let bytes = STANDARD_NO_PAD.decode(encoded)?;
    let key = ed25519_dalek::VerifyingKey::try_from(bytes.as_slice())?;
    anyhow::ensure!(!key.is_weak(), "weak group signing key");
    Ok(key)
}

fn signature_message(context: &str, ciphertext: &[u8]) -> Vec<u8> {
    let mut msg = b"bettergit/content/v2\0".to_vec();
    msg.extend_from_slice(context.as_bytes());
    msg.push(0);
    msg.extend_from_slice(ciphertext);
    msg
}

pub fn sign_content(ciphertext: &[u8], context: &str, key: &ed25519_dalek::SigningKey) -> Vec<u8> {
    use ed25519_dalek::Signer;
    let mut signed = Vec::with_capacity(96 + ciphertext.len());
    signed.extend_from_slice(key.verifying_key().as_bytes());
    signed.extend_from_slice(&key.sign(&signature_message(context, ciphertext)).to_bytes());
    signed.extend_from_slice(ciphertext);
    signed
}

pub fn verify_content<'a>(
    signed: &'a [u8],
    context: &str,
    expected: Option<&ed25519_dalek::VerifyingKey>,
) -> Result<&'a [u8]> {
    use anyhow::{Context, ensure};
    let (public, tail) = signed
        .split_at_checked(32)
        .context("missing content signing key")?;
    let (signature, ciphertext) = tail
        .split_at_checked(64)
        .context("missing content signature")?;
    let key = ed25519_dalek::VerifyingKey::try_from(public)?;
    ensure!(
        expected.is_none_or(|expected| *expected == key),
        "unexpected content signing key"
    );
    key.verify_strict(
        &signature_message(context, ciphertext),
        &ed25519_dalek::Signature::try_from(signature)?,
    )?;
    validate(ciphertext)?;
    Ok(ciphertext)
}
