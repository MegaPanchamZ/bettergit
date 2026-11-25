use age::secrecy::ExposeSecret;
use anyhow::{Context, Result, bail, ensure};
use bettergit::{config::Policy, crypto, engine, protocol};
use clap::{Parser, Subcommand};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};
use zeroize::Zeroizing;

mod staged;

#[derive(Parser)]
#[command(name = "bettergit", version, about = "Git-native granular encryption")]
struct Cli {
    #[command(subcommand)]
    command: Action,
}
#[derive(Subcommand)]
enum Action {
    #[command(hide = true)]
    SnapshotPrivate,
    /// Pin an independently verified group public key before first managed sync.
    PinGroup {
        group: String,
        recipient: String,
    },
    GroupPublicKey {
        group: String,
    },
    /// Print the public verifier for an enrolled content-signing group.
    GroupSigningKey {
        group: String,
    },
    /// Convert a trusted historical blob to the signed format without emitting plaintext.
    MigrateLegacy {
        path: String,
        blob: PathBuf,
        #[arg(long)]
        reviewed_plaintext: PathBuf,
        output: PathBuf,
    },
    /// Match paths under the working policy. Read and write JSON path arrays.
    MatchPaths {
        #[arg(long)]
        require_signing_keys: bool,
    },
    Enroll {
        #[arg(long)]
        server: String,
        owner: String,
        repo: String,
    },
    CreateGroup {
        #[arg(long)]
        server: String,
        #[arg(long)]
        repo: String,
        #[arg(long)]
        team_id: Option<u64>,
        name: String,
    },
    UploadKey {
        #[arg(long)]
        server: String,
        #[arg(long)]
        group_id: String,
        #[arg(long)]
        user_id: String,
        #[arg(long)]
        recipient: String,
        #[arg(long, default_value_t = 1)]
        version: u32,
        group: String,
    },
    #[command(hide = true)]
    GuardPush {
        remote: String,
        url: String,
    },
    Branch {
        #[command(subcommand)]
        action: BranchAction,
    },
    /// Manage private collaboration workspaces and their shared audience.
    Workspace {
        #[command(subcommand)]
        action: WorkspaceAction,
    },
    /// Decrypt a whole-file CI blob using an OIDC-authenticated ephemeral key request.
    CiDecrypt {
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        path: Option<String>,
        #[arg(long, requires = "path")]
        whole_file: bool,
        #[arg(long)]
        trust: PathBuf,
        #[arg(long)]
        oidc_command: Option<PathBuf>,
        #[arg(long)]
        server: String,
        #[arg(long)]
        policy: String,
        blob: PathBuf,
    },
    /// Approve pending CI requests by wrapping keys locally for verified workloads.
    Broker {
        #[arg(long)]
        trust: PathBuf,
        #[arg(long)]
        server: String,
        #[arg(long)]
        group_id: String,
        group: String,
    },
    /// Set up the local filter and pin the reviewed repository policy.
    Init,
    Login {
        #[arg(long)]
        client_id: String,
        #[arg(long)]
        server: String,
    },
    Sync {
        #[arg(long)]
        server: String,
        #[arg(long)]
        repo: String,
    },
    #[command(hide = true)]
    Filter,
    /// Validate encrypted content without a decryption key (also used by server guards).
    Check {
        #[arg(long)]
        require_signing_key: bool,
        path: String,
        blob: PathBuf,
    },
    /// Verify protected files in the Git index without reading the working tree or keys.
    #[command(
        after_help = "Exit 0 for valid content, 1 for validation issues, or 2 if the check cannot run."
    )]
    CheckStaged {
        /// Write a single compact JSON result.
        #[arg(long)]
        json: bool,
    },
    /// Wrap a local group key for another user's age public key.
    Grant {
        group: String,
        recipient: String,
        output: PathBuf,
    },
    /// Import an age-wrapped group key into the local encrypted cache.
    Import {
        group: String,
        envelope: PathBuf,
    },
    PublicKey,
}
#[derive(Subcommand)]
enum WorkspaceAction {
    Create {
        name: String,
        #[arg(long)]
        repo: String,
        #[arg(long)]
        server: String,
        #[arg(long, value_delimiter = ',')]
        allow: Vec<String>,
        #[arg(long, value_delimiter = ',')]
        groups: Vec<String>,
    },
    List {
        #[arg(long)]
        repo: String,
        #[arg(long)]
        server: String,
    },
    Show {
        id: String,
        #[arg(long)]
        server: String,
    },
    Members {
        id: String,
        #[arg(long)]
        server: String,
        #[arg(long, value_delimiter = ',')]
        allow: Vec<String>,
        #[arg(long, value_delimiter = ',')]
        groups: Vec<String>,
    },
    Reconcile {
        id: String,
        #[arg(long)]
        server: String,
    },
}
#[derive(Subcommand)]
enum BranchAction {
    Resume {
        name: String,
        #[arg(long)]
        server: String,
    },
    Join {
        id: String,
        #[arg(long)]
        server: String,
    },
    Create {
        name: String,
        #[arg(
            long,
            required_unless_present = "workspace",
            conflicts_with = "workspace"
        )]
        allow: Option<String>,
        #[arg(long)]
        workspace: Option<String>,
        #[arg(long)]
        server: String,
        #[arg(long)]
        repo: String,
    },
    Publish {
        name: String,
        #[arg(long, default_value = "main")]
        base: String,
        #[arg(long)]
        server: String,
    },
}
fn git(args: &[&str]) -> Result<String> {
    let out = Command::new("git").args(args).output()?;
    ensure!(out.status.success(), "Git command failed");
    Ok(String::from_utf8(out.stdout)?.trim_end().into())
}
fn entry() -> Result<keyring::Entry> {
    Ok(keyring::Entry::new("bettergit", "identity")?)
}
fn identity(create: bool) -> Result<age::x25519::Identity> {
    match entry()?.get_password() {
        Ok(s) => {
            let s = Zeroizing::new(s);
            s.parse()
                .map_err(|_| anyhow::anyhow!("invalid keychain identity"))
        }
        Err(keyring::Error::NoEntry) if create => {
            let id = age::x25519::Identity::generate();
            entry()?.set_password(id.to_string().expose_secret())?;
            Ok(id)
        }
        Err(e) => Err(e.into()),
    }
}
fn cache() -> Result<PathBuf> {
    Ok(PathBuf::from(git(&["rev-parse", "--absolute-git-dir"])?).join("bettergit"))
}
fn group_path(base: &Path, group: &str) -> PathBuf {
    use base64::Engine;
    base.join(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(group))
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let result = (|| -> Result<()> {
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        std::fs::remove_file(&temp).ok();
    }
    result
}
fn verify_group_pin(base: &Path, group: &str, key: &age::x25519::Identity) -> Result<()> {
    let pin = group_path(base, &format!("pin:{group}"));
    if pin.exists() {
        ensure!(
            std::fs::read_to_string(pin)? == key.to_public().to_string(),
            "group fingerprint differs from pinned key"
        );
    }
    Ok(())
}
fn group_key(
    base: &Path,
    group: &str,
    id: &age::x25519::Identity,
) -> Result<age::x25519::Identity> {
    let bytes = crypto::decrypt(&std::fs::read(group_path(base, group))?, id)?;
    let key = std::str::from_utf8(&bytes)?
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid wrapped group key"))?;
    verify_group_pin(base, group, &key)?;
    Ok(key)
}

struct Index {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Index {
    fn new() -> Result<Self> {
        Self::start(Command::new("git"))
    }
    fn start(mut command: Command) -> Result<Self> {
        let mut child = command
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(Self {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
        })
    }
    fn blob(&mut self, path: &str) -> Result<Option<Vec<u8>>> {
        self.request_blob(format_args!(":{path}"))
    }
    fn request_blob(&mut self, revision: std::fmt::Arguments<'_>) -> Result<Option<Vec<u8>>> {
        writeln!(self.input, "{revision}")?;
        self.input.flush()?;
        let mut line = String::new();
        self.output.read_line(&mut line)?;
        if line.ends_with(" missing\n") {
            return Ok(None);
        }
        let fields: Vec<_> = line.split_whitespace().collect();
        ensure!(
            fields.len() == 3 && fields[1] == "blob",
            "invalid index response"
        );
        let size: usize = fields[2].parse()?;
        ensure!(size <= 64 * 1024 * 1024, "index blob too large");
        let mut data = vec![0; size];
        self.output.read_exact(&mut data)?;
        let mut end = [0];
        self.output.read_exact(&mut end)?;
        ensure!(end == *b"\n", "invalid index terminator");
        Ok(Some(data))
    }
}
impl Drop for Index {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
    }
}
fn init(root: &Path, policy: &Policy, base: &Path) -> Result<()> {
    let id = identity(true)?;
    std::fs::create_dir_all(base)?;
    let tracked = git(&["ls-files", "-z"])?;
    let mut existing_groups = std::collections::HashSet::new();
    for path in tracked.split('\0').filter(|p| !p.is_empty()) {
        if let Some(rule) = policy.rule(path)? {
            existing_groups.insert(rule.group());
        }
    }
    for rule in &policy.config.rules {
        if rule.signing_key.is_none() {
            eprintln!(
                "Unpinned rule {}: add signing_key from a verified group administrator to enable keyless validation.",
                rule.path
            );
        }
        engine::require_env(&rule.path, rule.mode_for(&rule.path))?;
        let path = group_path(base, rule.group());
        if !path.exists() {
            if existing_groups.contains(rule.group())
                || rule.signing_key.is_some()
                || group_path(base, &format!("pin:{}", rule.group())).exists()
            {
                continue;
            }
            let group = age::x25519::Identity::generate();
            std::fs::write(
                path,
                crypto::encrypt(
                    group.to_string().expose_secret().as_bytes(),
                    &id.to_public(),
                )?,
            )?;
        }
    }
    std::fs::write(
        base.join("policy.yml"),
        std::fs::read(root.join(".access.yml"))?,
    )?;
    let binary = std::env::current_exe()?.canonicalize()?;
    let binary = binary.to_str().context("non UTF-8 executable path")?;
    let quoted = format!("'{}' filter", binary.replace('\'', "'\\''"));
    git(&["config", "filter.privgit.process", &quoted])?;
    git(&["config", "filter.privgit.required", "true"])?;
    let attrs = root.join(".gitattributes");
    let existing = std::fs::read_to_string(&attrs).unwrap_or_default();
    let start = "# BEGIN BETTERGIT\n";
    let end = "# END BETTERGIT\n";
    let mut text = if let Some((before, rest)) = existing.split_once(start) {
        let (_, after) = rest
            .split_once(end)
            .context("invalid managed attributes block")?;
        format!("{before}{after}")
    } else {
        existing
    };
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(start);
    for rule in &policy.config.rules {
        text.push_str(&format!(
            "{} filter=privgit -diff -text -ident !eol !working-tree-encoding\n",
            rule.path
        ));
    }
    text.push_str(end);
    std::fs::write(attrs, &text)?;
    let info = PathBuf::from(git(&["rev-parse", "--git-path", "info/attributes"])?);
    if let Some(parent) = info.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let old = std::fs::read_to_string(&info).unwrap_or_default();
    let before = old.split_once(start).map(|(s, _)| s).unwrap_or(&old);
    let block = text
        .split_once(start)
        .context("missing generated attributes")?
        .1;
    std::fs::write(info, format!("{}\n{start}{block}", before.trim_end()))?;
    // Git may consider ciphertext from a pre-init clone up to date and skip smudge.
    // Refresh only exact indexed ciphertext, never an edited worktree file.
    let mut filter = FilterState::load()?;
    for path in tracked.split('\0').filter(|p| !p.is_empty()) {
        if policy.rule(path)?.is_none() {
            continue;
        }
        let Some(old) = filter.index.blob(path)? else {
            continue;
        };
        let file = root.join(path);
        let Ok(metadata) = std::fs::symlink_metadata(&file) else {
            continue;
        };
        if !metadata.file_type().is_file() || std::fs::read(&file)? != old {
            continue;
        }
        let rule = policy.rule(path)?.context("missing rule")?;
        let signer = rule
            .signing_key
            .as_deref()
            .map(crypto::parse_signer)
            .transpose()?;
        let signer = signer.or_else(|| {
            filter
                .keys
                .get(rule.group())
                .map(|key| crypto::signing_key(key).verifying_key())
        });
        if signer.is_none()
            || engine::validate_at(path, &old, rule.mode_for(path), signer.as_ref()).is_err()
        {
            continue;
        }
        let output = filter.transform("smudge", path, &old)?;
        atomic_write(&file, &output)?;
        std::fs::set_permissions(&file, metadata.permissions())?;
    }
    println!("Better Git initialized. Public key: {}", id.to_public());
    Ok(())
}
struct FilterState {
    policy: Policy,
    keys: HashMap<String, age::x25519::Identity>,
    index: Index,
    stubs: HashMap<String, Zeroizing<Vec<u8>>>,
}
impl FilterState {
    fn load() -> Result<Self> {
        let root = PathBuf::from(git(&["rev-parse", "--show-toplevel"])?).canonicalize()?;
        std::env::set_current_dir(root)?;
        let base = cache()?;
        let policy = Policy::parse(
            &std::fs::read_to_string(base.join("policy.yml"))
                .context("run bettergit init to pin filter policy")?,
        )?;
        let id = match identity(false) {
            Ok(id) => Some(id),
            Err(keyring_error) => {
                eprintln!("bettergit: identity unavailable ({keyring_error}); using safe stubs");
                None
            }
        };
        let mut keys = HashMap::new();
        if let Some(id) = id {
            for rule in &policy.config.rules {
                if let Ok(key) = group_key(&base, rule.group(), &id) {
                    keys.insert(rule.group().to_owned(), key);
                }
            }
        }
        let mut index = Index::new()?;
        let mut stubs = HashMap::new();
        for rule in &policy.config.rules {
            if let Some(stub) = &rule.stub {
                ensure!(
                    policy.rule(stub)?.is_none(),
                    "stubs must be public unfiltered files"
                );
                if let Some(blob) = index.blob(stub)? {
                    stubs.insert(stub.clone(), Zeroizing::new(blob));
                }
            }
        }
        Ok(Self {
            policy,
            keys,
            index,
            stubs,
        })
    }
    fn transform(&mut self, cmd: &str, path: &str, data: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        ensure!(cmd == "clean" || cmd == "smudge", "unsupported command");
        let rule=self.policy.rule(path)?.context("installed filter path is absent from pinned policy; run init after reviewed self.policy changes")?;
        engine::require_env(path, rule.mode_for(path))?;
        let signer = rule
            .signing_key
            .as_deref()
            .map(crypto::parse_signer)
            .transpose()?;
        let mode = rule.mode_for(path);
        let key = self.keys.get(rule.group());
        let local_signer = key.map(|key| crypto::signing_key(key).verifying_key());
        if let (Some(expected), Some(actual)) = (&signer, &local_signer) {
            ensure!(expected == actual, "group differs from policy signing key");
        }
        let signer = signer
            .or(local_signer)
            .context("protected rule requires a verified signing key in .access.yml")?;
        if cmd == "smudge" {
            if let Some(key) = key {
                return engine::smudge_at(path, data, mode, key);
            }
            engine::validate_at(path, data, mode, Some(&signer))?;
            return rule
                .stub
                .as_ref()
                .and_then(|p| self.stubs.get(p))
                .map(|s| Zeroizing::new(s.to_vec()))
                .context("safe stub must be tracked in the self.index");
        }
        let old = self.index.blob(path)?;
        if let Some(old) = &old
            && old.as_slice() == data
        {
            engine::validate_at(path, old, mode, Some(&signer))?;
            return Ok(Zeroizing::new(old.clone()));
        }
        if let Some(safe) = rule.stub.as_ref().and_then(|p| self.stubs.get(p))
            && safe.as_slice() == data
        {
            let old = old.context("cannot stage stub without encrypted self.index blob")?;
            engine::validate_at(path, &old, mode, Some(&signer))?;
            return Ok(Zeroizing::new(old));
        }
        let Some(key) = key else {
            bail!("no access to group; stub edits cannot be staged");
        };
        engine::clean_at(path, data, old.as_deref(), mode, key)
    }
}
fn run_filter() -> Result<()> {
    let mut state = None;
    protocol::run(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        |cmd, path, data| {
            if state.is_none() {
                state = Some(FilterState::load()?);
            }
            state
                .as_mut()
                .context("filter initialization failed")?
                .transform(cmd, path, data)
        },
    )
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if let Action::CheckStaged { json } = cli.command {
        let code = staged::run(json)?;
        if code != 0 {
            std::process::exit(code);
        }
        return Ok(());
    }
    if matches!(cli.command, Action::Filter) {
        return run_filter();
    }
    if matches!(cli.command, Action::SnapshotPrivate) {
        return bettergit::branch::snapshot_private();
    }
    if let Action::GuardPush { remote, url } = &cli.command {
        return bettergit::branch::guard_push(remote, url);
    }
    if matches!(cli.command, Action::PublicKey) {
        println!("{}", identity(false)?.to_public());
        return Ok(());
    }
    if let Action::Login { client_id, server } = &cli.command {
        bettergit::client::server(server)?;
        bettergit::client::login(client_id, server)?;
        let id = identity(true)?;
        bettergit::client::request(
            "PUT",
            &format!("{}/v1/identity", server.trim_end_matches('/')),
            Some(serde_json::json!({"publicKey":id.to_public().to_string()})),
        )?;
        return Ok(());
    }
    if let Action::CiDecrypt {
        server,
        policy,
        blob,
        trust,
        oidc_command,
        output,
        path,
        whole_file,
    } = &cli.command
    {
        let context = path.as_deref().map(|path| (path, *whole_file));
        return bettergit::ci::decrypt(
            server,
            policy,
            blob,
            trust,
            oidc_command.as_deref(),
            output,
            context,
        );
    }
    if let Action::Workspace { action } = &cli.command {
        use serde_json::json;
        return match action {
            WorkspaceAction::Create {
                name,
                repo,
                server,
                allow,
                groups,
            } => bettergit::branch::workspace_request(
                server,
                "POST",
                Some(repo),
                None,
                Some(
                    json!({"name":name,"allow":allow.iter().map(|s|s.trim_start_matches('@')).collect::<Vec<_>>(),"groups":groups}),
                ),
                false,
            ),
            WorkspaceAction::List { repo, server } => {
                bettergit::branch::workspace_request(server, "GET", Some(repo), None, None, false)
            }
            WorkspaceAction::Show { id, server } => {
                bettergit::branch::workspace_request(server, "GET", None, Some(id), None, false)
            }
            WorkspaceAction::Members {
                id,
                server,
                allow,
                groups,
            } => bettergit::branch::workspace_request(
                server,
                "PUT",
                None,
                Some(id),
                Some(
                    json!({"allow":allow.iter().map(|s|s.trim_start_matches('@')).collect::<Vec<_>>(),"groups":groups}),
                ),
                false,
            ),
            WorkspaceAction::Reconcile { id, server } => bettergit::branch::workspace_request(
                server,
                "POST",
                None,
                Some(id),
                Some(json!({})),
                true,
            ),
        };
    }
    if let Action::Branch { action } = &cli.command {
        return match action {
            BranchAction::Resume { name, server } => bettergit::branch::resume(server, name),
            BranchAction::Join { id, server } => bettergit::branch::join(server, id),
            BranchAction::Create {
                name,
                allow,
                workspace,
                server,
                repo,
            } => bettergit::branch::create(
                server,
                repo,
                name,
                allow.as_deref(),
                workspace.as_deref(),
            ),
            BranchAction::Publish { name, base, server } => {
                bettergit::branch::publish(server, name, base)
            }
        };
    }
    let root = PathBuf::from(git(&["rev-parse", "--show-toplevel"])?).canonicalize()?;
    std::env::set_current_dir(&root)?;
    let base = cache()?;
    let policy = if matches!(cli.command, Action::Filter) {
        Policy::parse(
            &std::fs::read_to_string(base.join("policy.yml"))
                .context("run bettergit init to pin filter policy")?,
        )?
    } else {
        Policy::load(&root)?
    };
    match cli.command {
        Action::PinGroup { group, recipient } => {
            let parsed: age::x25519::Recipient = recipient
                .parse()
                .map_err(|_| anyhow::anyhow!("invalid public key"))?;
            let path = group_path(&base, &format!("pin:{group}"));
            if path.exists() {
                ensure!(
                    std::fs::read_to_string(&path)? == parsed.to_string(),
                    "group fingerprint already pinned"
                );
            }
            std::fs::create_dir_all(&base)?;
            atomic_write(&path, parsed.to_string().as_bytes())
        }
        Action::Sync { server, repo } => {
            ensure!(
                repo.bytes().all(|c| c.is_ascii_digit()),
                "repo must be control-plane repository ID"
            );
            if !base.join("enrollment.json").exists() {
                let metadata = bettergit::client::request(
                    "GET",
                    &format!("{}/v1/repos/{repo}", server.trim_end_matches('/')),
                    None,
                )?;
                let owner = metadata["org_name"]
                    .as_str()
                    .context("invalid organization")?;
                let name = metadata["repo_name"]
                    .as_str()
                    .context("invalid repository")?;
                let origin = git(&["remote", "get-url", "origin"])?;
                ensure!(
                    bettergit::envelope::repo(&origin)
                        == format!("{owner}/{name}").to_ascii_lowercase(),
                    "directory repository does not match origin"
                );
                std::fs::create_dir_all(&base)?;
                std::fs::write(
                    base.join("enrollment.json"),
                    serde_json::to_vec(
                        &serde_json::json!({"server":server,"repo":repo,"origin":origin}),
                    )?,
                )?;
            }
            let enrollment: serde_json::Value =
                serde_json::from_slice(&std::fs::read(base.join("enrollment.json"))?)?;
            ensure!(
                enrollment["server"].as_str() == Some(&server)
                    && enrollment["repo"].as_str() == Some(&repo)
                    && enrollment["origin"].as_str()
                        == Some(&git(&["remote", "get-url", "origin"])?),
                "sync requires matching local enrollment"
            );
            let groups = bettergit::client::request(
                "GET",
                &format!("{}/v1/repos/{repo}/groups", server.trim_end_matches('/')),
                None,
            )?;
            std::fs::create_dir_all(&base)?;
            let id = identity(false)?;
            let mut succeeded = 0;
            for group in groups.as_array().context("invalid group list")? {
                let group_id = group["id"].as_str().context("invalid group ID")?;
                let name = group["name"].as_str().context("invalid group name")?;
                if !policy.config.rules.iter().any(|r| r.group() == name) {
                    continue;
                }
                let result = (|| -> Result<()> {
                    let value = bettergit::client::request(
                        "GET",
                        &format!(
                            "{}/v1/groups/{group_id}/envelopes",
                            server.trim_end_matches('/')
                        ),
                        None,
                    )?;
                    use base64::Engine;
                    let bytes = base64::engine::general_purpose::STANDARD.decode(
                        value["encrypted_dek_blob"]
                            .as_str()
                            .context("invalid envelope")?,
                    )?;
                    let key = bettergit::envelope::unwrap(
                        &bytes,
                        &id,
                        &git(&["remote", "get-url", "origin"])?,
                        name,
                    )?;
                    let cached = group_path(&base, name);
                    if cached.exists() {
                        let pinned = group_key(&base, name, &id)?;
                        ensure!(
                            pinned.to_public().to_string() == key.to_public().to_string(),
                            "group key changed; verify rotation with an administrator before importing a replacement"
                        );
                    }
                    let pin = group_path(&base, &format!("pin:{name}"));
                    if pin.exists() {
                        ensure!(
                            std::fs::read_to_string(&pin)? == key.to_public().to_string(),
                            "group differs from independently pinned fingerprint"
                        );
                    } else {
                        ensure!(
                            cached.exists(),
                            "run pin-group with an independently verified group public key before first sync"
                        );
                    }
                    let wrapped = crypto::encrypt(
                        key.to_string().expose_secret().as_bytes(),
                        &id.to_public(),
                    )?;
                    atomic_write(&group_path(&base, name), &wrapped)?;
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("bettergit: skipped group {name}: {error}");
                } else {
                    succeeded += 1;
                }
            }
            ensure!(
                policy.config.rules.is_empty() || succeeded > 0,
                "no requested groups synchronized"
            );
            Ok(())
        }
        Action::Login { .. } => unreachable!(),
        Action::CiDecrypt { .. } => unreachable!(),
        Action::Broker {
            server,
            group_id,
            group,
            trust,
        } => bettergit::ci::approve(
            &server,
            &group_id,
            &group_key(&base, &group, &identity(false)?)?,
            &serde_json::from_slice::<bettergit::oidc::Trust>(&std::fs::read(trust)?)?,
        ),
        Action::Branch { .. } | Action::GuardPush { .. } | Action::SnapshotPrivate => {
            unreachable!()
        }
        Action::Enroll {
            server,
            owner,
            repo,
        } => {
            let remote = git(&["remote", "get-url", "origin"])?;
            ensure!(
                remote == format!("git@github.com:{owner}/{repo}.git")
                    || remote.trim_end_matches(".git")
                        == format!("https://github.com/{owner}/{repo}"),
                "origin does not match enrollment"
            );
            let value = bettergit::client::request(
                "POST",
                &format!("{}/v1/repos", server.trim_end_matches('/')),
                Some(serde_json::json!({"owner":owner,"repo":repo})),
            )?;
            std::fs::create_dir_all(&base)?;
            std::fs::write(
                base.join("enrollment.json"),
                serde_json::to_vec(
                    &serde_json::json!({"server":server,"repo":value["id"],"origin":remote}),
                )?,
            )?;
            println!("Enrolled repository {}", value["id"]);
            Ok(())
        }
        Action::CreateGroup {
            server,
            repo,
            team_id,
            name,
        } => {
            ensure!(repo.bytes().all(|c| c.is_ascii_digit()), "invalid repo ID");
            let value = bettergit::client::request(
                "POST",
                &format!("{}/v1/repos/{repo}/groups", server.trim_end_matches('/')),
                Some(team_id.map_or_else(
                    || serde_json::json!({"name":name}),
                    |team_id| serde_json::json!({"name":name,"teamId":team_id}),
                )),
            )?;
            println!("Group {}", value["id"]);
            Ok(())
        }
        Action::UploadKey {
            server,
            group_id,
            user_id,
            recipient,
            version,
            group,
        } => {
            ensure!(
                group_id.bytes().all(|c| c.is_ascii_digit())
                    && user_id.bytes().all(|c| c.is_ascii_digit()),
                "invalid directory IDs"
            );
            let enrolled: serde_json::Value =
                serde_json::from_slice(&std::fs::read(base.join("enrollment.json"))?)?;
            ensure!(
                enrolled["server"].as_str() == Some(&server)
                    && enrolled["origin"].as_str() == Some(&git(&["remote", "get-url", "origin"])?),
                "upload requires matching enrollment"
            );
            let metadata = bettergit::client::request(
                "GET",
                &format!("{}/v1/groups/{group_id}", server.trim_end_matches('/')),
                None,
            )?;
            ensure!(
                metadata["name"].as_str() == Some(&group)
                    && metadata["repo_id"] == enrolled["repo"],
                "directory group differs from local group or repository"
            );
            let user = bettergit::client::request(
                "GET",
                &format!(
                    "{}/v1/groups/{group_id}/users/{user_id}",
                    server.trim_end_matches('/')
                ),
                None,
            )?;
            ensure!(
                user["age_public_key"].as_str() == Some(&recipient),
                "recipient differs from the independently verified directory identity"
            );
            let key = group_key(&base, &group, &identity(false)?)?;
            let recipient = recipient
                .parse()
                .map_err(|_| anyhow::anyhow!("invalid pinned recipient"))?;
            use base64::Engine;
            let envelope =
                base64::engine::general_purpose::STANDARD.encode(bettergit::envelope::wrap(
                    &key,
                    &recipient,
                    &git(&["remote", "get-url", "origin"])?,
                    &group,
                )?);
            bettergit::client::request(
                "PUT",
                &format!(
                    "{}/v1/groups/{group_id}/envelopes",
                    server.trim_end_matches('/')
                ),
                Some(serde_json::json!({"userId":user_id,"version":version,"envelope":envelope})),
            )?;
            Ok(())
        }
        Action::MatchPaths {
            require_signing_keys,
        } => {
            if require_signing_keys {
                ensure!(
                    policy
                        .config
                        .rules
                        .iter()
                        .all(|rule| rule.signing_key.is_some()),
                    "approved policy must pin every group signing key"
                );
            }
            let paths: Vec<String> = serde_json::from_reader(std::io::stdin().lock())?;
            let mut matches = Vec::new();
            for path in paths {
                if policy.rule(&path)?.is_some() {
                    matches.push(path);
                }
            }
            println!("{}", serde_json::to_string(&matches)?);
            Ok(())
        }
        Action::GroupPublicKey { group } => {
            println!(
                "{}",
                group_key(&base, &group, &identity(false)?)?.to_public()
            );
            Ok(())
        }
        Action::GroupSigningKey { group } => {
            use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
            let key = group_key(&base, &group, &identity(false)?)?;
            println!(
                "{}",
                STANDARD_NO_PAD.encode(crypto::signing_key(&key).verifying_key().as_bytes())
            );
            Ok(())
        }
        Action::MigrateLegacy {
            path,
            blob,
            reviewed_plaintext,
            output,
        } => {
            let rule = policy.rule(&path)?.context("path is not protected")?;
            let key = group_key(&base, rule.group(), &identity(false)?)?;
            if let Some(signer) = &rule.signing_key {
                ensure!(
                    crypto::signing_key(&key).verifying_key() == crypto::parse_signer(signer)?,
                    "group differs from policy signing key"
                );
            }
            let reviewed = Zeroizing::new(std::fs::read(reviewed_plaintext)?);
            let encoded = engine::migrate_legacy(
                &path,
                &std::fs::read(blob)?,
                &reviewed,
                rule.mode_for(&path),
                &key,
            )?;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(output)?
                .write_all(&encoded)?;
            Ok(())
        }
        Action::Init => init(&root, &policy, &base),
        Action::Check {
            path,
            blob,
            require_signing_key,
        } => {
            let rule = policy.rule(&path)?.context("path is not protected")?;
            engine::require_env(&path, rule.mode_for(&path))?;
            let signer = rule
                .signing_key
                .as_deref()
                .map(crypto::parse_signer)
                .transpose()?;
            ensure!(
                !require_signing_key || signer.is_some(),
                "approved policy must pin a group signing key"
            );
            let signer = match signer {
                Some(signer) => signer,
                None => crypto::signing_key(&group_key(&base, rule.group(), &identity(false)?)?)
                    .verifying_key(),
            };
            engine::validate_at(
                &path,
                &std::fs::read(blob)?,
                rule.mode_for(&path),
                Some(&signer),
            )
        }
        Action::Grant {
            group,
            recipient,
            output,
        } => {
            let key = group_key(&base, &group, &identity(false)?)?;
            let recipient = recipient
                .parse()
                .map_err(|_| anyhow::anyhow!("invalid recipient"))?;
            std::fs::write(
                output,
                bettergit::envelope::wrap(
                    &key,
                    &recipient,
                    &git(&["remote", "get-url", "origin"])?,
                    &group,
                )?,
            )?;
            Ok(())
        }
        Action::Import { group, envelope } => {
            let id = identity(false)?;
            let key = bettergit::envelope::unwrap(
                &std::fs::read(envelope)?,
                &id,
                &git(&["remote", "get-url", "origin"])?,
                &group,
            )?;
            verify_group_pin(&base, &group, &key)?;
            if group_path(&base, &group).exists() {
                let cached = group_key(&base, &group, &id)?;
                ensure!(
                    cached.to_public().to_string() == key.to_public().to_string(),
                    "import cannot silently replace an existing group key"
                );
            } else {
                ensure!(
                    group_path(&base, &format!("pin:{group}")).exists(),
                    "run pin-group with an independently verified group public key before first import"
                );
            }
            std::fs::create_dir_all(&base)?;
            let wrapped =
                crypto::encrypt(key.to_string().expose_secret().as_bytes(), &id.to_public())?;
            atomic_write(&group_path(&base, &group), &wrapped)?;
            Ok(())
        }
        Action::Filter => unreachable!(),
        Action::CheckStaged { .. } => unreachable!(),
        Action::Workspace { .. } | Action::PublicKey => unreachable!(),
    }
}
