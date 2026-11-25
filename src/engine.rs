use crate::{config::Mode, crypto};
use anyhow::{Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{SigningKey, VerifyingKey};
use zeroize::Zeroizing;

const TOKEN: &str = "ENC[v2:";
const FILE: &[u8] = b"bettergit-file/v3\n";

fn map(
    input: &[u8],
    mode: Mode,
    mut f: impl FnMut(&str, &str) -> Result<String>,
) -> Result<Zeroizing<Vec<u8>>> {
    if matches!(mode, Mode::Json | Mode::Yaml) {
        if mode == Mode::Json {
            let _: serde_json::Value = serde_json::from_slice(input)?;
        }
        crate::structured::map(input, |context, raw| {
            let parsed: Result<String, _> = serde_json::from_str(raw);
            let value = parsed.as_deref().unwrap_or(raw);
            let out = f(
                context,
                if value.starts_with("ENC[") {
                    value
                } else {
                    raw
                },
            )?;
            if out == value {
                return Ok(raw.to_owned());
            }
            if out.starts_with("ENC[") {
                Ok(serde_json::to_string(&out)?)
            } else {
                Ok(out)
            }
        })
    } else {
        env_map(input, false, f)
    }
}
fn token(value: &str) -> Result<Vec<u8>> {
    let inner = value
        .strip_prefix(TOKEN)
        .and_then(|s| s.strip_suffix(']'))
        .ok_or_else(|| anyhow::anyhow!("invalid encrypted value"))?;
    Ok(STANDARD.decode(inner)?)
}
// Deliberately strict dotenv grammar: preserve every byte outside the RHS. Unsupported
// shell syntax fails closed; quoted values are encrypted including their quotes.
fn env_map(
    input: &[u8],
    legacy: bool,
    mut map: impl FnMut(&str, &str) -> Result<String>,
) -> Result<Zeroizing<Vec<u8>>> {
    let text = std::str::from_utf8(input)?;
    let mut out = Zeroizing::new(String::new());
    for line in text.split_inclusive('\n') {
        let body = line
            .strip_suffix('\n')
            .map_or(line, |line| line.strip_suffix('\r').unwrap_or(line));
        ensure!(!body.contains('\r'), "unsupported dotenv line ending");
        let suffix = &line[body.len()..];
        let trimmed = body.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push_str(line);
            continue;
        }
        let (lhs, rhs) = body
            .split_once('=')
            .ok_or_else(|| anyhow::anyhow!("unsupported dotenv syntax"))?;
        let key = lhs.trim().strip_prefix("export ").unwrap_or(lhs.trim());
        ensure!(
            !key.is_empty()
                && key.bytes().enumerate().all(|(i, c)| c == b'_'
                    || c.is_ascii_alphabetic()
                    || (i > 0 && c.is_ascii_digit())),
            "invalid dotenv key"
        );
        out.push_str(lhs);
        out.push('=');
        let mut quote = None;
        let mut escape = false;
        let mut comment = rhs.len();
        for (i, ch) in rhs.char_indices() {
            if escape {
                escape = false;
                continue;
            }
            if ch == '\\' && quote != Some('\'') {
                escape = true;
                continue;
            }
            if let Some(q) = quote {
                if ch == q {
                    quote = None;
                }
            } else if ch == '\'' || ch == '"' {
                quote = Some(ch);
            } else if legacy && ch == '#' && (i == 0 || rhs.as_bytes()[i - 1].is_ascii_whitespace())
            {
                comment = i;
                break;
            }
        }
        ensure!(quote.is_none(), "multiline dotenv quotes are unsupported");
        let value = if legacy {
            rhs[..comment].trim_end()
        } else {
            rhs
        };
        out.push_str(&map(key, value)?);
        out.push_str(&rhs[value.len()..]);
        out.push_str(suffix);
    }
    Ok(Zeroizing::new(out.as_bytes().to_vec()))
}
pub fn validate(data: &[u8], mode: Mode) -> Result<()> {
    validate_at("", data, mode, None)
}

fn file_context(path: &str) -> String {
    format!("whole-file\0{path}\0")
}

pub fn validate_at(
    path: &str,
    data: &[u8],
    mode: Mode,
    signer: Option<&VerifyingKey>,
) -> Result<()> {
    match mode {
        Mode::File => {
            let signed = data
                .strip_prefix(FILE)
                .ok_or_else(|| anyhow::anyhow!("expected signed Better Git file"))?;
            crypto::verify_content(signed, &file_context(path), signer)?;
        }
        _ => {
            let mut seen = std::collections::HashSet::new();
            map(data, mode, |field, value| {
                ensure!(
                    seen.insert(field.to_owned()),
                    "duplicate fields unsupported"
                );
                crypto::verify_content(&token(value)?, &format!("{path}\0{field}"), signer)?;
                Ok(value.to_owned())
            })?;
        }
    }
    Ok(())
}

fn wrap_value(
    value: &str,
    context: &str,
    key: &age::x25519::Identity,
    signer: &SigningKey,
) -> Result<String> {
    let payload = Zeroizing::new(serde_json::to_vec(&(context, value))?);
    let ciphertext = crypto::encrypt(&payload, &key.to_public())?;
    Ok(format!(
        "{TOKEN}{}]",
        STANDARD.encode(crypto::sign_content(&ciphertext, context, signer))
    ))
}

fn unwrap_value(
    value: &str,
    context: &str,
    key: &age::x25519::Identity,
    signer: &VerifyingKey,
) -> Result<Zeroizing<String>> {
    let signed = token(value)?;
    let ciphertext = crypto::verify_content(&signed, context, Some(signer))?;
    unwrap_payload(ciphertext, context, key)
}

fn unwrap_payload(
    ciphertext: &[u8],
    context: &str,
    key: &age::x25519::Identity,
) -> Result<Zeroizing<String>> {
    let plain = crypto::decrypt(ciphertext, key)?;
    let (bound, value): (String, String) = serde_json::from_slice(&plain)?;
    let value = Zeroizing::new(value);
    ensure!(bound == context, "encrypted value context mismatch");
    Ok(value)
}
pub fn smudge(data: &[u8], mode: Mode, key: &age::x25519::Identity) -> Result<Zeroizing<Vec<u8>>> {
    smudge_at("", data, mode, key)
}
pub fn smudge_at(
    path: &str,
    data: &[u8],
    mode: Mode,
    key: &age::x25519::Identity,
) -> Result<Zeroizing<Vec<u8>>> {
    let signer = crypto::signing_key(key).verifying_key();
    if mode == Mode::File {
        let signed = data
            .strip_prefix(FILE)
            .ok_or_else(|| anyhow::anyhow!("expected signed Better Git file"))?;
        return crypto::decrypt(
            crypto::verify_content(signed, &file_context(path), Some(&signer))?,
            key,
        );
    }
    restore_scalars(data, mode, |field, value| {
        unwrap_value(value, &format!("{path}\0{field}"), key, &signer)
    })
}

fn restore_scalars(
    data: &[u8],
    mode: Mode,
    mut decrypt: impl FnMut(&str, &str) -> Result<Zeroizing<String>>,
) -> Result<Zeroizing<Vec<u8>>> {
    let mut seen = std::collections::HashSet::new();
    let plaintext = map(data, mode, |field, encoded| {
        ensure!(
            seen.insert(field.to_owned()),
            "duplicate fields unsupported"
        );
        let value = decrypt(field, encoded)?;
        match mode {
            Mode::Value => ensure!(!value.contains(['\r', '\n']), "dotenv scalar injection"),
            Mode::Json => {
                let parsed: serde_json::Value = serde_json::from_str(&value)?;
                ensure!(
                    !parsed.is_array() && !parsed.is_object(),
                    "JSON scalar injection"
                );
            }
            Mode::Yaml => {
                ensure!(
                    !value.trim_start().starts_with(['&', '!', '*']),
                    "YAML properties and aliases are unsupported"
                );
                let tree = yaml_edit::YamlFile::parse(&value);
                ensure!(!tree.has_errors(), "invalid decrypted YAML");
                let docs: Vec<_> = tree.tree().documents().collect();
                ensure!(
                    docs.len() == 1 && docs[0].as_scalar().is_some(),
                    "YAML scalar injection"
                );
            }
            Mode::File => unreachable!(),
        }
        Ok(value.to_string())
    })?;
    if matches!(mode, Mode::Json | Mode::Yaml) {
        let skeleton = |input: &[u8]| map(input, mode, |_, _| Ok("\"scalar\"".to_owned()));
        ensure!(
            *skeleton(data)? == *skeleton(&plaintext)?,
            "decrypted scalars changed document structure"
        );
    }
    Ok(plaintext)
}

pub fn clean(
    data: &[u8],
    old: Option<&[u8]>,
    mode: Mode,
    key: &age::x25519::Identity,
) -> Result<Zeroizing<Vec<u8>>> {
    clean_at("", data, old, mode, key)
}
pub fn clean_at(
    path: &str,
    data: &[u8],
    old: Option<&[u8]>,
    mode: Mode,
    key: &age::x25519::Identity,
) -> Result<Zeroizing<Vec<u8>>> {
    let signer = crypto::signing_key(key);
    let public = signer.verifying_key();
    let mut prior = std::collections::HashMap::new();
    if let Some(old) = old {
        // Never overwrite an index blob that cannot authenticate with the current key.
        let plain = smudge_at(path, old, mode, key)?;
        if plain.as_slice() == data {
            return Ok(Zeroizing::new(old.to_vec()));
        }
        if mode != Mode::File {
            map(old, mode, |field, v| {
                let context = format!("{path}\0{field}");
                let value = unwrap_value(v, &context, key, &public)?;
                ensure!(
                    prior
                        .insert(field.to_owned(), (v.to_owned(), value))
                        .is_none(),
                    "duplicate fields unsupported"
                );
                Ok(v.to_owned())
            })?;
        }
    }
    let mut seen = std::collections::HashSet::new();
    let out = match mode {
        Mode::File => {
            ensure!(
                !data.starts_with(b"age-encryption.org/v1\n")
                    && !data.starts_with(b"bettergit-file/"),
                "refusing to encrypt ciphertext again; decrypt the working copy first"
            );
            let ciphertext = crypto::encrypt(data, &key.to_public())?;
            let mut out = FILE.to_vec();
            out.extend(crypto::sign_content(
                &ciphertext,
                &file_context(path),
                &signer,
            ));
            Zeroizing::new(out)
        }
        _ => map(data, mode, |field, v| {
            ensure!(
                seen.insert(field.to_owned()),
                "duplicate fields unsupported"
            );
            let context = format!("{path}\0{field}");
            if v.starts_with("ENC[") {
                unwrap_value(v, &context, key, &public)?;
                return Ok(v.to_owned());
            }
            if let Some((cipher, plain)) = prior.get(field)
                && plain.as_str() == v
            {
                return Ok(cipher.clone());
            }
            wrap_value(v, &context, key, &signer)
        })?,
    };
    ensure!(
        smudge_at(path, &out, mode, key)?.as_slice() == data,
        "encryption must round trip exactly"
    );
    Ok(out)
}
pub fn migrate_legacy(
    path: &str,
    data: &[u8],
    reviewed_plaintext: &[u8],
    mode: Mode,
    key: &age::x25519::Identity,
) -> Result<Zeroizing<Vec<u8>>> {
    let decrypt = |field: &str, value: &str| {
        let payload = value
            .strip_prefix("ENC[v1:")
            .and_then(|value| value.strip_suffix(']'))
            .ok_or_else(|| anyhow::anyhow!("expected a legacy encrypted value"))?;
        unwrap_payload(&STANDARD.decode(payload)?, &format!("{path}\0{field}"), key)
    };
    let plaintext = match mode {
        Mode::File => {
            let ciphertext = if let Some(signed) = data.strip_prefix(b"bettergit-file/v2\n") {
                crypto::verify_content(
                    signed,
                    &format!("{path}\0file"),
                    Some(&crypto::signing_key(key).verifying_key()),
                )?
            } else {
                data
            };
            crypto::decrypt(ciphertext, key)?
        }
        Mode::Value => env_map(data, true, |field, value| {
            let plaintext = decrypt(field, value)?;
            ensure!(!plaintext.contains(['\r', '\n']), "dotenv scalar injection");
            Ok(plaintext.to_string())
        })?,
        Mode::Json | Mode::Yaml => restore_scalars(data, mode, decrypt)?,
    };
    ensure!(
        plaintext.as_slice() == reviewed_plaintext,
        "legacy plaintext differs from the reviewed copy"
    );
    clean_at(path, &plaintext, None, mode, key)
}

pub fn require_env(path: &str, mode: Mode) -> Result<()> {
    if mode == Mode::Value
        && !(path.rsplit('/').next().unwrap_or(path).starts_with(".env") || path.ends_with(".env"))
    {
        bail!("unsupported value-mode extension");
    }
    Ok(())
}
