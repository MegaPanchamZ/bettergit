use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};
fn git(args: &[&str]) -> Result<String> {
    let o = Command::new("git").args(args).output()?;
    ensure!(o.status.success(), "Git command failed");
    Ok(String::from_utf8(o.stdout)?.trim().into())
}
fn valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        && name.as_bytes()[0].is_ascii_alphanumeric()
}
fn enrollment(server: &str, repo: Option<&str>) -> Result<Value> {
    let cache = std::path::PathBuf::from(git(&["rev-parse", "--absolute-git-dir"])?)
        .join("bettergit/enrollment.json");
    let value: Value = serde_json::from_slice(&std::fs::read(cache)?)?;
    ensure!(
        value["server"].as_str() == Some(server)
            && value["origin"].as_str() == Some(&git(&["remote", "get-url", "origin"])?),
        "local enrollment or origin mismatch"
    );
    if let Some(repo) = repo {
        ensure!(
            value["repo"].as_str() == Some(repo),
            "repository enrollment mismatch"
        );
    }
    Ok(value)
}
pub fn create(
    server: &str,
    repo: &str,
    name: &str,
    allow: Option<&str>,
    workspace: Option<&str>,
) -> Result<()> {
    ensure!(
        valid(name) && repo.bytes().all(|c| c.is_ascii_digit()),
        "invalid branch or repo ID"
    );
    ensure!(
        git(&["status", "--porcelain"])?.is_empty(),
        "commit or stash changes first"
    );
    let enrolled = enrollment(server, Some(repo))?;
    let existing = Command::new("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ])
        .status()?;
    ensure!(!existing.success(), "branch already exists");
    ensure!(
        git(&["remote"])?
            .lines()
            .all(|r| r != format!("bettergit-{name}")),
        "shadow remote name already exists"
    );
    crate::client::server(server)?;
    install_hook()?;
    ensure!(
        allow.is_some() != workspace.is_some(),
        "choose allow or workspace"
    );
    let allow: Vec<_> = allow
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().trim_start_matches('@'))
        .collect();
    let value = crate::client::request(
        "POST",
        &format!("{}/v1/repos/{repo}/shadows", server.trim_end_matches('/')),
        Some(match workspace {
            Some(id) => json!({"name":name,"workspace":id}),
            None => json!({"name":name,"allow":allow}),
        }),
    )?;
    let remote = value["remote"].as_str().context("missing shadow remote")?;
    ensure!(
        remote.starts_with("git@github.com:")
            && remote.ends_with(".git")
            && !remote.contains(['\n', '\r', ' ']),
        "invalid remote"
    );
    let slug = remote
        .trim_start_matches("git@github.com:")
        .trim_end_matches(".git");
    let origin = enrolled["origin"].as_str().context("missing origin")?;
    let canonical = crate::envelope::repo(origin);
    let org = canonical.split('/').next().context("invalid origin")?;
    ensure!(
        slug.starts_with(&format!("{org}/bettergit-")),
        "shadow remote differs from enrolled organization"
    );
    let info = crate::client::github_repo(server, slug)?;
    ensure!(
        info["private"] == true && info["fork"] == false,
        "GitHub must confirm the shadow is private and not a fork"
    );
    let id = value["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value["id"].to_string());
    ensure!(id.bytes().all(|c| c.is_ascii_digit()), "invalid shadow ID");
    let remote_name = format!("bettergit-{name}");
    git(&["remote", "add", &remote_name, remote])?;
    git(&[
        "config",
        &format!("bettergit.shadow.{name}.remote-url"),
        remote,
    ])?;
    git(&["config", &format!("branch.{name}.remote"), &remote_name])?;
    git(&["config", &format!("branch.{name}.pushRemote"), &remote_name])?;
    git(&[
        "config",
        &format!("branch.{name}.merge"),
        &format!("refs/heads/{name}"),
    ])?;
    git(&["config", &format!("bettergit.shadow.{name}.id"), &id])?;
    git(&[
        "config",
        &format!("bettergit.shadow.{name}.base"),
        &git(&["rev-parse", "HEAD"])?,
    ])?;
    git(&["switch", "-c", name])?;
    snapshot_private()?;
    println!("Private branch {name} created. Push with: git push {remote_name} {name}");
    Ok(())
}
pub fn join(server: &str, id: &str) -> Result<()> {
    ensure!(
        !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()),
        "invalid shadow ID"
    );
    ensure!(
        git(&["status", "--porcelain"])?.is_empty(),
        "commit or stash changes first"
    );
    let enrolled = enrollment(server, None)?;
    let value = crate::client::request(
        "GET",
        &format!("{}/v1/shadows/{id}", server.trim_end_matches('/')),
        None,
    )?;
    ensure!(
        value["repo"] == enrolled["repo"],
        "shadow belongs to another repository"
    );
    let name = value["branch"].as_str().context("missing branch")?;
    let remote = value["remote"].as_str().context("missing remote")?;
    ensure!(valid(name), "invalid shadow branch");
    let origin = enrolled["origin"].as_str().context("missing origin")?;
    let canonical = crate::envelope::repo(origin);
    let org = canonical.split('/').next().context("invalid origin")?;
    ensure!(
        remote.starts_with(&format!("git@github.com:{org}/bettergit-"))
            && remote.ends_with(".git")
            && !remote.contains([' ', '\n', '\r']),
        "untrusted shadow remote"
    );
    let slug = remote
        .trim_start_matches("git@github.com:")
        .trim_end_matches(".git");
    let info = crate::client::github_repo(server, slug)?;
    ensure!(
        info["private"] == true && info["fork"] == false,
        "GitHub must confirm shadow privacy"
    );
    let exists = Command::new("git")
        .args([
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ])
        .status()?;
    ensure!(!exists.success(), "branch already exists");
    let remote_name = format!("bettergit-{name}");
    ensure!(
        !git(&["remote"])?.lines().any(|r| r == remote_name),
        "remote already exists"
    );
    let baseline = value["baseline"]
        .as_str()
        .context("missing approved public baseline")?;
    ensure!(
        matches!(baseline.len(), 40 | 64) && baseline.bytes().all(|c| c.is_ascii_hexdigit()),
        "invalid approved public baseline"
    );
    install_hook()?;
    git(&["remote", "add", &remote_name, remote])?;
    git(&[
        "fetch",
        "--no-tags",
        "--",
        &remote_name,
        &format!("refs/heads/{name}:refs/remotes/{remote_name}/{name}"),
    ])?;
    // Limit the exemption to the enrolled public history shared with the shadow.
    let tip = format!("refs/remotes/{remote_name}/{name}");
    let base = git(&["merge-base", "--", baseline, &tip])?;
    for (key, value) in [("id", id), ("base", base.as_str()), ("remote-url", remote)] {
        git(&["config", &format!("bettergit.shadow.{name}.{key}"), value])?;
    }
    git(&["config", &format!("branch.{name}.remote"), &remote_name])?;
    git(&["config", &format!("branch.{name}.pushRemote"), &remote_name])?;
    git(&[
        "config",
        &format!("branch.{name}.merge"),
        &format!("refs/heads/{name}"),
    ])?;
    git(&["switch", "-c", name, &tip])?;
    snapshot_private()?;
    println!("Joined {name}; private-history push protection installed.");
    Ok(())
}
pub fn publish(server: &str, name: &str, base: &str) -> Result<()> {
    let enrolled = enrollment(server, None)?;
    let destination = enrolled["origin"]
        .as_str()
        .context("missing pinned origin")?;
    ensure!(
        git(&["remote", "get-url", "--push", "--all", "origin"])? == destination,
        "origin push destination differs from enrollment"
    );
    ensure!(valid(name), "invalid private branch name");
    ensure!(
        !base.starts_with('-')
            && base
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_./-".contains(&c)),
        "invalid base branch"
    );
    ensure!(
        git(&["status", "--porcelain"])?.is_empty(),
        "commit or stash changes first"
    );
    let id = git(&["config", "--get", &format!("bettergit.shadow.{name}.id")])?;
    ensure!(
        !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()),
        "invalid shadow ID"
    );
    crate::client::server(server)?;
    let approved = crate::client::request(
        "GET",
        &format!(
            "{}/v1/shadows/{id}/authorize?base={base}",
            server.trim_end_matches('/')
        ),
        None,
    )?;
    let approved_origin = approved["origin"]
        .as_str()
        .context("missing approved destination")?;
    ensure!(
        crate::envelope::repo(destination) == crate::envelope::repo(approved_origin),
        "approved repository differs from pinned origin"
    );
    ensure!(
        approved["branch"].as_str() == Some(name),
        "approved private branch mismatch"
    );
    let shadow_remote = git(&["config", "--get", &format!("branch.{name}.remote")])?;
    git(&["fetch", "--", &shadow_remote, name])?;
    ensure!(
        git(&["rev-parse", "FETCH_HEAD"])? == git(&["rev-parse", &format!("refs/heads/{name}")])?,
        "fetch/merge and push all collaborator work to the shadow before publishing"
    );
    git(&["fetch", "--", "origin", base])?;
    let parent = git(&["rev-parse", "FETCH_HEAD^{commit}"])?;
    ensure!(
        approved["base"].as_str() == Some(&parent),
        "public base changed after authorization"
    );
    ensure!(
        Command::new("git")
            .args([
                "merge-base",
                "--is-ancestor",
                &parent,
                &format!("refs/heads/{name}")
            ])
            .status()?
            .success(),
        "merge current public base into the private branch and push the shadow before publishing"
    );
    let tree = git(&["rev-parse", &format!("refs/heads/{name}^{{tree}}")])?;
    ensure!(
        approved["tree"].as_str() == Some(&tree)
            && approved["tip"].as_str()
                == Some(&git(&["rev-parse", &format!("refs/heads/{name}")])?),
        "candidate differs from preauthorized shadow tip"
    );
    let mut child = Command::new("git")
        .args(["commit-tree", &tree, "-p", &parent])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .context("commit input unavailable")?
        .write_all(format!("Publish {name}\n").as_bytes())?;
    let out = child.wait_with_output()?;
    ensure!(out.status.success(), "squash commit failed");
    let sha = String::from_utf8(out.stdout)?;
    let sha = sha.trim();
    let head = format!("bettergit/publish/{name}-{}", &sha[..12]);
    let plans = std::path::PathBuf::from(git(&["rev-parse", "--absolute-git-dir"])?)
        .join("bettergit/publications");
    std::fs::create_dir_all(&plans)?;
    std::fs::write(
        plans.join(sha),
        serde_json::to_vec(&json!({"origin":destination,"base":parent,"tree":tree}))?,
    )?;
    let operation = json!({"server":server,"shadow":id,"head":head,"base":base,"headSha":sha,"baseSha":parent,"tipSha":approved["tip"]});
    std::fs::write(
        plans.join(format!("operation-{name}.json")),
        serde_json::to_vec(&operation)?,
    )?;
    git(&[
        "push",
        "--",
        destination,
        &format!("{sha}:refs/heads/{head}"),
    ])?;
    let value: Value = crate::client::request(
        "POST",
        &format!("{}/v1/shadows/{id}/publish", server.trim_end_matches('/')),
        Some(
            json!({"head":head,"base":base,"headSha":sha,"baseSha":parent,"tipSha":approved["tip"]}),
        ),
    )?;
    println!(
        "{}",
        value["url"].as_str().context("missing pull request URL")?
    );
    Ok(())
}
pub fn resume(server: &str, name: &str) -> Result<()> {
    ensure!(valid(name), "invalid branch");
    enrollment(server, None)?;
    let path = std::path::PathBuf::from(git(&["rev-parse", "--absolute-git-dir"])?)
        .join("bettergit/publications")
        .join(format!("operation-{name}.json"));
    let operation: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    ensure!(
        operation["server"].as_str() == Some(server),
        "publication server mismatch"
    );
    let id = operation["shadow"].as_str().context("missing shadow")?;
    ensure!(id.bytes().all(|c| c.is_ascii_digit()), "invalid shadow");
    let value = crate::client::request(
        "POST",
        &format!("{}/v1/shadows/{id}/publish", server.trim_end_matches('/')),
        Some(operation),
    )?;
    println!("{}", value["url"].as_str().context("missing PR URL")?);
    Ok(())
}
pub fn install_hook() -> Result<()> {
    let hooks = std::path::PathBuf::from(git(&["rev-parse", "--git-path", "hooks"])?);
    std::fs::create_dir_all(&hooks)?;
    let hook = hooks.join("pre-push");
    let original = hooks.join("pre-push.bettergit-original");
    if hook.exists() && !std::fs::read_to_string(&hook)?.contains("# BETTERGIT GUARD") {
        ensure!(
            !original.exists(),
            "existing hook backup requires manual resolution"
        );
        std::fs::rename(&hook, &original)?;
    }
    let binary = std::env::current_exe()?.canonicalize()?;
    let quote = |p: &std::path::Path| -> Result<String> {
        Ok(format!(
            "'{}'",
            p.to_str()
                .context("non UTF-8 hook path")?
                .replace('\'', "'\\''")
        ))
    };
    let text = format!(
        "#!/bin/sh\n# BETTERGIT GUARD\nset -eu\ninput=$(mktemp)\ntrap 'rm -f \"$input\"' EXIT HUP INT TERM\ncat > \"$input\"\nif [ -x {} ]; then {} \"$@\" < \"$input\"; fi\n{} guard-push \"$1\" \"$2\" < \"$input\"\n",
        quote(&original)?,
        quote(&original)?,
        quote(&binary)?
    );
    std::fs::write(&hook, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755))?;
    }
    let post = hooks.join("post-commit");
    let post_original = hooks.join("post-commit.bettergit-original");
    if post.exists() && !std::fs::read_to_string(&post)?.contains("# BETTERGIT SNAPSHOT") {
        ensure!(
            !post_original.exists(),
            "existing post-commit backup requires resolution"
        );
        std::fs::rename(&post, &post_original)?;
    }
    std::fs::write(
        &post,
        format!(
            "#!/bin/sh\n# BETTERGIT SNAPSHOT\n{} snapshot-private\nif [ -x {} ]; then {} \"$@\"; fi\n",
            quote(&binary)?,
            quote(&post_original)?,
            quote(&post_original)?
        ),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&post, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}
pub fn snapshot_private() -> Result<()> {
    let current = git(&["symbolic-ref", "--quiet", "--short", "HEAD"]);
    let Ok(name) = current else {
        return Ok(());
    };
    if !valid(&name) {
        return Ok(());
    }
    let remote = git(&["config", "--get", &format!("branch.{name}.remote")]);
    let stable = remote
        .as_deref()
        .ok()
        .and_then(|r| r.strip_prefix("bettergit-"))
        .unwrap_or(&name);
    if !valid(stable) {
        return Ok(());
    }
    let exists = Command::new("git")
        .args(["config", "--get", &format!("bettergit.shadow.{stable}.id")])
        .output()?;
    if !exists.status.success() {
        return Ok(());
    }
    let sha = git(&["rev-parse", "HEAD"])?;
    git(&[
        "update-ref",
        &format!("refs/bettergit/private/{stable}/{sha}"),
        &sha,
    ])?;
    Ok(())
}
pub fn guard_push(remote: &str, url: &str) -> Result<()> {
    use std::io::Read;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let config = Command::new("git")
        .args(["config", "--get-regexp", "^bettergit\\.shadow\\..*\\.id$"])
        .output()?;
    let config = String::from_utf8(config.stdout)?;
    let mut advertised: Option<Vec<String>> = None;
    for line in config.lines() {
        let key = line
            .split_whitespace()
            .next()
            .context("invalid shadow metadata")?;
        let name = key
            .strip_prefix("bettergit.shadow.")
            .and_then(|s| s.strip_suffix(".id"))
            .context("invalid shadow config")?;
        if remote == format!("bettergit-{name}")
            && git(&[
                "config",
                "--get",
                &format!("bettergit.shadow.{name}.remote-url"),
            ])? == url
        {
            continue;
        }
        for branch in git(&["for-each-ref", "--format=%(refname:short)", "refs/heads/"])?.lines() {
            if git(&["config", "--get", &format!("branch.{branch}.remote")])
                .ok()
                .as_deref()
                == Some(&format!("bettergit-{name}"))
            {
                let live = git(&["rev-parse", &format!("refs/heads/{branch}")])?;
                git(&[
                    "update-ref",
                    &format!("refs/bettergit/private/{name}/{live}"),
                    &live,
                ])?;
            }
        }
        let live = git(&["rev-parse", "--verify", &format!("refs/heads/{name}")]);
        if let Ok(live) = live {
            git(&[
                "update-ref",
                &format!("refs/bettergit/private/{name}/{live}"),
                &live,
            ])?;
        }
        let tips = git(&[
            "for-each-ref",
            "--format=%(objectname)",
            &format!("refs/bettergit/private/{name}/"),
        ])?;
        ensure!(
            !tips.is_empty(),
            "restricted branch {name} has no retained history; restore its snapshot before pushing"
        );
        let base = git(&["config", "--get", &format!("bettergit.shadow.{name}.base")])?;
        // Trust only refs actually advertised by this push destination, not mutable
        // origin tracking refs. Their existing ancestors cannot be newly disclosed.
        if advertised.is_none() {
            let refs = git(&["ls-remote", "--heads", "--", url])?;
            advertised = Some(
                refs.lines()
                    .filter_map(|line| line.split_whitespace().next())
                    .filter(|sha| {
                        (sha.len() == 40 || sha.len() == 64)
                            && sha.bytes().all(|c| c.is_ascii_hexdigit())
                    })
                    .map(|sha| format!("^{sha}"))
                    .collect(),
            );
        }
        let mut args = vec!["rev-list", "--ignore-missing"];
        args.extend(tips.lines());
        let exclude = format!("^{base}");
        args.push(&exclude);
        args.extend(
            advertised
                .as_ref()
                .context("missing destination refs")?
                .iter()
                .map(String::as_str),
        );
        let private = git(&args)?;
        let private: std::collections::HashSet<_> = private.lines().collect();
        for update in input.lines() {
            let fields: Vec<_> = update.split_whitespace().collect();
            ensure!(fields.len() == 4, "invalid pre-push input");
            if fields[1].len() == 40 || fields[1].len() == 64 {
                let plan = std::path::PathBuf::from(git(&["rev-parse", "--absolute-git-dir"])?)
                    .join("bettergit/publications")
                    .join(fields[1]);
                if plan.exists() {
                    let plan: Value = serde_json::from_slice(&std::fs::read(plan)?)?;
                    let parents = git(&["rev-list", "--parents", "-1", fields[1]])?;
                    let parents: Vec<_> = parents.split_whitespace().collect();
                    if plan["origin"].as_str() == Some(url)
                        && fields[2].starts_with("refs/heads/bettergit/publish/")
                        && parents.len() == 2
                        && plan["base"].as_str() == Some(parents[1])
                        && plan["tree"].as_str()
                            == Some(&git(&["rev-parse", &format!("{}^{{tree}}", fields[1])])?)
                    {
                        continue;
                    }
                }
            }
            if fields[1].bytes().all(|b| b == b'0') {
                continue;
            }
            ensure!(
                fields[1].bytes().all(|b| b.is_ascii_hexdigit()),
                "invalid push object"
            );
            let exclude = format!("^{}", fields[3]);
            let sent = if fields[3].bytes().all(|b| b == b'0') {
                git(&["rev-list", fields[1]])?
            } else {
                git(&["rev-list", fields[1], &exclude])?
            };
            ensure!(
                !sent.lines().any(|sha| private.contains(sha)),
                "push contains restricted branch history; use its shadow remote or bettergit branch publish"
            );
        }
    }
    Ok(())
}

/// Manage access metadata without fetching or publishing private Git content.
pub fn workspace_request(
    server: &str,
    method: &str,
    repo: Option<&str>,
    id: Option<&str>,
    body: Option<Value>,
    reconcile: bool,
) -> Result<()> {
    crate::client::server(server)?;
    let identifier = repo.or(id).context("workspace or repository ID required")?;
    ensure!(
        !identifier.is_empty() && identifier.bytes().all(|c| c.is_ascii_digit()),
        "invalid ID"
    );
    let path = match repo {
        Some(repo) => format!("/v1/repos/{repo}/workspaces"),
        None => format!(
            "/v1/workspaces/{identifier}{}",
            if reconcile { "/reconcile" } else { "" }
        ),
    };
    let value = crate::client::request(
        method,
        &format!("{}{path}", server.trim_end_matches('/')),
        body,
    )?;
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}
