use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};
fn git(root: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().into()
}

#[test]
fn staged_preflight_reports_index_metadata_without_printing_contents() {
    use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
    use bettergit::{config::Mode, crypto, engine};
    use serde_json::{Value, json};

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    git(root, &["init", "-q"]);
    let subdir = root.join("config");
    std::fs::create_dir(&subdir).unwrap();
    let check = |code| {
        let output = Command::new(env!("CARGO_BIN_EXE_bettergit"))
            .current_dir(&subdir)
            .args(["check-staged", "--json"])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(code));
        assert!(output.stderr.is_empty());
        assert!(!output.stdout.windows(4).any(|part| part == b"DEMO"));
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    assert_eq!(check(2)["error"], "missing_policy");

    let path = "config/settings.env";
    let key = age::x25519::Identity::generate();
    let signer = STANDARD_NO_PAD.encode(crypto::signing_key(&key).verifying_key().as_bytes());
    let policy = format!(
        "version: 1\norg: example\nrules:\n- path: settings.env\n  allow: [team]\n  mode: value\n  signing_key: {signer}\n"
    );
    let signed = engine::clean_at(path, b"DEMO=fixture\n", None, Mode::Value, &key).unwrap();
    std::fs::write(root.join(".access.yml"), &policy).unwrap();
    std::fs::write(root.join(path), &*signed).unwrap();
    git(root, &["add", "--", ".access.yml", path]);

    // An edited worktree can differ from the immutable objects named by the index.
    std::fs::write(root.join(".access.yml"), "invalid unstaged policy").unwrap();
    std::fs::write(root.join(path), "DEMO=unstaged\n").unwrap();
    assert_eq!(check(0), json!({"version":1,"checked":1,"issues":[]}));

    git(root, &["add", "--", path]);
    assert_eq!(
        check(1),
        json!({"version":1,"checked":1,"issues":[{"path":path,"code":"invalid_ciphertext"}]})
    );

    let pin_dir = root.join(".git/bettergit");
    std::fs::create_dir(&pin_dir).unwrap();
    std::fs::write(
        pin_dir.join("policy.yml"),
        policy.replace("org: example", "org: pinned"),
    )
    .unwrap();
    assert_eq!(check(2)["error"], "policy_mismatch");
}

#[test]
fn explicit_and_bulk_pushes_cannot_send_private_history() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    git(root, &["init", "-q"]);
    git(root, &["config", "user.email", "test@example.test"]);
    git(root, &["config", "user.name", "Test"]);
    std::fs::write(root.join("base"), "base").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "base"]);
    let base = git(root, &["rev-parse", "HEAD"]);
    git(root, &["update-ref", "refs/remotes/origin/main", &base]);
    git(root, &["switch", "-qc", "secret"]);
    std::fs::write(root.join("private"), "private").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "private"]);
    let private = git(root, &["rev-parse", "HEAD"]);
    git(root, &["config", "bettergit.shadow.secret.id", "1"]);
    git(root, &["config", "bettergit.shadow.secret.base", &base]);
    git(
        root,
        &["config", "bettergit.shadow.secret.remote-url", "shadow-url"],
    );
    git(
        root,
        &["config", "branch.secret.remote", "bettergit-secret"],
    );
    // Preserve the original restricted tip even if its branch is renamed or reset.
    git(
        root,
        &[
            "update-ref",
            &format!("refs/bettergit/private/secret/{private}"),
            &private,
        ],
    );
    git(root, &["branch", "-m", "secret", "renamed"]);
    std::fs::write(root.join("after-rename"), "still private").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "private after rename"]);
    let private = git(root, &["rev-parse", "HEAD"]);
    let snapshot = Command::new(env!("CARGO_BIN_EXE_bettergit"))
        .current_dir(root)
        .arg("snapshot-private")
        .status()
        .unwrap();
    assert!(snapshot.success());
    assert_eq!(
        git(
            root,
            &[
                "rev-parse",
                &format!("refs/bettergit/private/secret/{private}")
            ]
        ),
        private
    );

    for (remote, url, expected) in [
        ("origin", "public-url", false),
        ("bettergit-secret", "shadow-url", true),
        ("bettergit-secret", "public-url", false),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_bettergit"))
            .current_dir(root)
            .args(["guard-push", remote, url])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                format!(
                    "refs/heads/secret {private} refs/heads/secret {}\n",
                    "0".repeat(40)
                )
                .as_bytes(),
            )
            .unwrap();
        assert_eq!(child.wait().unwrap().success(), expected);
    }
}

#[test]
fn public_ancestry_merged_into_private_work_remains_pushable() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "--bare", "-q"]);
    git(root, &["init", "-q"]);
    git(root, &["config", "user.email", "test@example.test"]);
    git(root, &["config", "user.name", "Test"]);
    std::fs::write(root.join("base"), "base").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "base"]);
    let base = git(root, &["rev-parse", "HEAD"]);
    git(root, &["switch", "-qc", "public-main"]);
    std::fs::write(root.join("upstream"), "public").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "public"]);
    let public = git(root, &["rev-parse", "HEAD"]);
    let url = remote.path().to_str().unwrap();
    git(root, &["push", "-q", url, "HEAD:refs/heads/main"]);
    git(root, &["switch", "-qc", "secret", &base]);
    std::fs::write(root.join("secret"), "private").unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "private"]);
    git(root, &["merge", "--no-edit", "public-main"]);
    git(root, &["config", "bettergit.shadow.secret.id", "1"]);
    git(root, &["config", "bettergit.shadow.secret.base", &base]);
    git(
        root,
        &["config", "bettergit.shadow.secret.remote-url", "shadow-url"],
    );
    git(
        root,
        &["config", "branch.secret.remote", "bettergit-secret"],
    );
    let private = git(root, &["rev-parse", "HEAD"]);
    for (sha, expected) in [(&public, true), (&private, false)] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_bettergit"))
            .current_dir(root)
            .args(["guard-push", "origin", url])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                format!(
                    "refs/heads/ordinary {sha} refs/heads/ordinary {}\n",
                    "0".repeat(40)
                )
                .as_bytes(),
            )
            .unwrap();
        assert_eq!(child.wait().unwrap().success(), expected);
    }
}
