use bettergit::{
    config::{Mode, Policy},
    crypto, engine, protocol,
};
#[test]
fn envelope_and_files_authenticate() {
    let id = age::x25519::Identity::generate();
    let other = age::x25519::Identity::generate();
    let bytes = crypto::encrypt(b"secret\0bytes", &id.to_public()).unwrap();
    assert_eq!(
        crypto::decrypt(&bytes, &id).unwrap().as_slice(),
        b"secret\0bytes"
    );
    assert!(crypto::decrypt(&bytes, &other).is_err());
    let mut tampered = bytes.clone();
    *tampered.last_mut().unwrap() ^= 1;
    assert!(crypto::decrypt(&tampered, &id).is_err());
    let encrypted = engine::clean(b"source", None, Mode::File, &id).unwrap();
    assert_eq!(
        engine::clean(b"source", Some(&encrypted), Mode::File, &id)
            .unwrap()
            .as_slice(),
        encrypted.as_slice()
    );
}
#[test]
fn dotenv_preserves_comments_crlf_and_unchanged_values() {
    let id = age::x25519::Identity::generate();
    let plain =
        b"# public\r\nexport TOKEN='secret'\r\nURL=https://example.test/#fragment\nEMPTY=\n";
    let encrypted = engine::clean(plain, None, Mode::Value, &id).unwrap();
    assert!(
        std::str::from_utf8(&encrypted)
            .unwrap()
            .starts_with("# public\r\nexport TOKEN=ENC[v2:")
    );
    engine::validate(&encrypted, Mode::Value).unwrap();
    assert_eq!(
        engine::smudge(&encrypted, Mode::Value, &id)
            .unwrap()
            .as_slice(),
        plain
    );
    assert_eq!(
        engine::clean(plain, Some(&encrypted), Mode::Value, &id)
            .unwrap()
            .as_slice(),
        encrypted.as_slice()
    );
    let changed =
        b"# public\r\nexport TOKEN='changed'\r\nURL=https://example.test/#fragment\nEMPTY=\n";
    let update = engine::clean(changed, Some(&encrypted), Mode::Value, &id).unwrap();
    assert_eq!(
        std::str::from_utf8(&encrypted).unwrap().lines().nth(2),
        std::str::from_utf8(&update).unwrap().lines().nth(2)
    );
    assert!(engine::validate(b"TOKEN=plaintext\n", Mode::Value).is_err());
    assert!(engine::clean(b"TOKEN=ENC[v2:bad]\n", None, Mode::Value, &id).is_err());
}
#[test]
fn policy_rejects_ambiguity_and_traversal() {
    let policy=Policy::parse("version: 1\norg: acme\nrules:\n- path: '.env*'\n  mode: value\n  allow: [team]\n- path: '.env.prod'\n  mode: file\n  allow: [team]\n").unwrap();
    assert!(policy.rule(".env.prod").is_err());
    assert!(policy.rule("../secret").is_err());
}
fn pkt(s: &[u8], out: &mut Vec<u8>) {
    out.extend(format!("{:04x}", s.len() + 4).bytes());
    out.extend(s);
}
#[test]
fn filter_handles_many_requests_and_errors() {
    let mut input = Vec::new();
    for s in [b"git-filter-client\n".as_slice(), b"version=2\n"] {
        pkt(s, &mut input);
    }
    input.extend(b"0000");
    pkt(b"capability=clean\n", &mut input);
    pkt(b"capability=smudge\n", &mut input);
    input.extend(b"0000");
    for cmd in ["clean", "smudge", "bad", "clean"] {
        pkt(format!("command={cmd}\n").as_bytes(), &mut input);
        pkt(b"pathname=.env\n", &mut input);
        input.extend(b"0000");
        pkt(b"TOKEN=test\n", &mut input);
        input.extend(b"0000");
    }
    let mut output = Vec::new();
    let mut count = 0;
    protocol::run(input.as_slice(), &mut output, |cmd, _, data| {
        count += 1;
        anyhow::ensure!(cmd != "bad", "bad");
        Ok(zeroize::Zeroizing::new(data.to_vec()))
    })
    .unwrap();
    assert_eq!(count, 4);
    let out = String::from_utf8(output).unwrap();
    assert_eq!(out.matches("status=success").count(), 3);
    assert_eq!(out.matches("status=error").count(), 1);
}
#[test]
fn structured_values_round_trip_without_losing_types_or_comments() {
    let id = age::x25519::Identity::generate();
    for (mode, plain) in [
        (
            Mode::Json,
            "{\n  \"secret\": \"value\", \"n\": 42, \"nested\": [true, null]\n}\n",
        ),
        (
            Mode::Yaml,
            "# public\nsecret: 'value' # preserved\nn: 42\nnested:\n  - true\n",
        ),
    ] {
        let enc = engine::clean(plain.as_bytes(), None, mode, &id).unwrap();
        engine::validate(&enc, mode).unwrap();
        assert_eq!(
            engine::smudge(&enc, mode, &id).unwrap().as_slice(),
            plain.as_bytes()
        );
    }
}
#[test]
fn yaml_blocks_and_nulls_remain_valid() {
    let id = age::x25519::Identity::generate();
    for plain in [
        "secret: |\n  alpha\n  beta\nnext: two\n",
        "first:\nnext: value\n",
    ] {
        let enc = engine::clean(plain.as_bytes(), None, Mode::Yaml, &id).unwrap();
        engine::validate(&enc, Mode::Yaml).unwrap();
        assert_eq!(
            engine::smudge(&enc, Mode::Yaml, &id).unwrap().as_slice(),
            plain.as_bytes()
        );
    }
}
#[test]
fn ciphertext_is_bound_to_file_and_field_and_key() {
    let key = age::x25519::Identity::generate();
    let other = age::x25519::Identity::generate();
    let cipher = engine::clean_at(
        ".env.prod",
        b"SECRET=one\nPUBLIC=one\n",
        None,
        Mode::Value,
        &key,
    )
    .unwrap();
    let text = std::str::from_utf8(&cipher).unwrap();
    let lines: Vec<_> = text.lines().collect();
    assert_ne!(
        lines[0].split_once('=').unwrap().1,
        lines[1].split_once('=').unwrap().1
    );
    assert!(engine::smudge_at(".env.dev", &cipher, Mode::Value, &key).is_err());
    let swapped = format!("PUBLIC={}\n", lines[0].split_once('=').unwrap().1);
    assert!(engine::smudge_at(".env.prod", swapped.as_bytes(), Mode::Value, &key).is_err());
    assert!(
        engine::clean_at(
            ".env.prod",
            b"SECRET=new\n",
            Some(&cipher),
            Mode::Value,
            &other
        )
        .is_err()
    );
}
#[test]
fn dotenv_assignment_tails_are_private() {
    let key = age::x25519::Identity::generate();
    let plain = b"TOKEN='secret # value'  # visible\n";
    let enc = engine::clean(plain, None, Mode::Value, &key).unwrap();
    assert!(std::str::from_utf8(&enc).unwrap().ends_with("]\n"));
    assert_eq!(
        engine::smudge(&enc, Mode::Value, &key).unwrap().as_slice(),
        plain
    );
}
#[test]
fn policy_patterns_cover_git_basename_semantics() {
    let policy=Policy::parse("version: 1\norg: acme\nrules:\n- path: '.env'\n  mode: value\n  allow: [team]\n- path: 'config/*.json'\n  mode: value\n  allow: [team]\n").unwrap();
    assert!(policy.rule("app/.env").unwrap().is_some());
    assert!(policy.rule("config/a.json").unwrap().is_some());
    assert!(policy.rule("config/nested/a.json").unwrap().is_none());
    assert!(
        Policy::parse(
            "version: 1\norg: acme\nrules:\n- path: '#secret'\n  mode: file\n  allow: [team]\n"
        )
        .is_err()
    );
}

#[test]
fn group_envelopes_bind_repository_group_and_recipient() {
    let user = age::x25519::Identity::generate();
    let group = age::x25519::Identity::generate();
    let bytes = bettergit::envelope::wrap(
        &group,
        &user.to_public(),
        "git@github.com:Acme/Repo.git",
        "infra",
    )
    .unwrap();
    let recovered =
        bettergit::envelope::unwrap(&bytes, &user, "https://github.com/acme/repo.git", "infra")
            .unwrap();
    assert_eq!(
        recovered.to_public().to_string(),
        group.to_public().to_string()
    );
    assert!(
        bettergit::envelope::unwrap(&bytes, &user, "https://github.com/evil/repo", "infra")
            .is_err()
    );
    assert!(
        bettergit::envelope::unwrap(&bytes, &user, "https://github.com/acme/repo", "other")
            .is_err()
    );
    assert!(
        bettergit::envelope::unwrap(
            &bytes,
            &age::x25519::Identity::generate(),
            "https://github.com/acme/repo",
            "infra"
        )
        .is_err()
    );
}

#[test]
fn ciphertext_and_duplicate_keys_cannot_be_accidentally_encrypted() {
    let key = age::x25519::Identity::generate();
    let ciphertext = engine::clean(b"private", None, Mode::File, &key).unwrap();
    assert!(engine::clean(&ciphertext, None, Mode::File, &key).is_err());
    assert!(engine::clean(b"TOKEN=a\nTOKEN=b\n", None, Mode::Value, &key).is_err());
    assert!(engine::clean(br#"{"token":"a","token":"b"}"#, None, Mode::Json, &key).is_err());
}

#[test]
fn signed_formats_require_the_expected_policy_signer() {
    let group = age::x25519::Identity::generate();
    let other = age::x25519::Identity::generate();
    for (path, mode, plaintext) in [
        (
            ".env",
            Mode::Value,
            b"KEY=value # private tail\n".as_slice(),
        ),
        ("private.txt", Mode::File, b"private text".as_slice()),
    ] {
        let signer = crypto::signing_key(&group).verifying_key();
        let other_signer = crypto::signing_key(&other).verifying_key();
        let encrypted = engine::clean_at(path, plaintext, None, mode, &group).unwrap();
        engine::validate_at(path, &encrypted, mode, Some(&signer)).unwrap();
        assert!(engine::validate_at(path, &encrypted, mode, Some(&other_signer)).is_err());
        assert!(engine::validate_at("different", &encrypted, mode, Some(&signer)).is_err());
        assert_eq!(
            *engine::smudge_at(path, &encrypted, mode, &group).unwrap(),
            plaintext
        );
    }
}

#[test]
fn legacy_blobs_only_convert_via_explicit_migration() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let group = age::x25519::Identity::generate();
    let legacy = crypto::encrypt(
        &serde_json::to_vec(&(".env\0KEY", "private")).unwrap(),
        &group.to_public(),
    )
    .unwrap();
    let legacy = format!("KEY=ENC[v1:{}] # literal tail\n", STANDARD.encode(legacy));
    assert!(engine::smudge_at(".env", legacy.as_bytes(), Mode::Value, &group).is_err());
    let expected = b"KEY=private # literal tail\n";
    assert!(
        engine::migrate_legacy(
            ".env",
            legacy.as_bytes(),
            b"unreviewed",
            Mode::Value,
            &group
        )
        .is_err()
    );
    let migrated =
        engine::migrate_legacy(".env", legacy.as_bytes(), expected, Mode::Value, &group).unwrap();
    assert!(
        !std::str::from_utf8(&migrated)
            .unwrap()
            .contains("literal tail")
    );
    assert_eq!(
        *engine::smudge_at(".env", &migrated, Mode::Value, &group).unwrap(),
        b"KEY=private # literal tail\n"
    );
}

#[test]
fn protocol_rejects_partial_packets_but_allows_clean_session_eof() {
    let mut hello = Vec::new();
    pkt(b"git-filter-client\n", &mut hello);
    pkt(b"version=2\n", &mut hello);
    hello.extend(b"0000");
    pkt(b"capability=clean\n", &mut hello);
    hello.extend(b"0000");
    for tail in [b"0".as_slice(), b"000", b"0010command="] {
        let mut broken = hello.clone();
        broken.extend(tail);
        assert!(protocol::run(broken.as_slice(), Vec::new(), |_, _, _| unreachable!()).is_err());
    }
    assert!(protocol::run(hello.as_slice(), Vec::new(), |_, _, _| unreachable!()).is_ok());
}
