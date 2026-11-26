<img src="site/icon.svg" width="64" height="64" alt="">

# Better Git

Git-native granular encryption for repositories hosted on GitHub. The open-source Rust CLI encrypts protected content before Git stores it. A TypeScript control plane distributes only wrapped group keys. Companion repositories support restricted branch collaboration.

**Development preview. Use synthetic secrets for evaluation.** See the [audit status](docs/audit-status.md) and [validation record](docs/validation.md) for the checks still required before production use.

## Install and use

Use the CLI by itself for local Git encryption. For GitHub team-based key distribution and merge checks, use [hosted Better Git](#hosted-better-git) or run your own [control plane with Docker Compose](deploy/README.md) and register your own GitHub App.

To install the CLI from source, install Git and stable Rust. On Debian or Ubuntu, install `build-essential`, `pkg-config`, and `libdbus-1-dev`, and use a desktop session with a running, unlocked Secret Service keyring such as GNOME Keyring. macOS uses Keychain and Windows uses Credential Manager.

```sh
git clone https://github.com/MegaPanchamZ/bettergit.git
cd bettergit
cargo install --locked --path .
bettergit --version
```

Follow [policy and local setup](#policy-and-local-setup) in a new test repository, using dummy files and values. After staging, `bettergit check-staged --json` verifies the encrypted index. For the browser viewer, see [build and verify](#build-and-verify) and [browser viewer setup](#browser-viewer).

## Build and verify

```sh
cargo build --release --locked
cargo test --locked
cargo clippy --all-targets -- -D warnings
# Linux: with dbus-run-session and gnome-keyring available
sh tests/keyring-e2e.sh
cd control-plane
npm ci
npm run check
npm test
cd ../extension
npm ci
npm run check
npm test
npm run build
```

The executable is `target/release/bettergit`. On Linux it requires a working Secret Service session; macOS uses Keychain and Windows uses Credential Manager. There is no plaintext private-key file fallback. Unit tests use synthetic in-memory identities. Database tests run when `TEST_DATABASE_URL` points to a disposable Postgres instance; each test creates and removes its own schema.

## Agents and automation

Install the CLI in the agent's environment. The [Better Git skill](.agents/skills/bettergit/SKILL.md) is discoverable in this checkout by Codex. Copy its `bettergit` directory into `.agents/skills/` in a protected project, or into `.claude/skills/` for Claude Code.

```sh
bettergit check-staged --json
```

The command verifies the Git index snapshot against the staged `.access.yml` and compares it with the local policy pin when one is present. It requires public signing keys for protected files in the snapshot and runs without decryption keys or GitHub login. It reports paths and issue codes without printing file contents. Server-side verification still uses the administrator-approved policy and checks commit history.

```json
{"version":1,"checked":2,"issues":[{"path":".env.production","code":"invalid_ciphertext"}]}
```

| Exit | Meaning |
| --- | --- |
| `0` | Protected index entries passed. |
| `1` | One or more paths need attention. Read `issues`. |
| `2` | The check could not complete. Read `error`, such as `missing_policy`, `policy_mismatch`, or `unmerged_index`. |

## Policy and local setup

In a new test repository, save the following as `.access.yml`. Create `.env.example` and `src/private.stub.ts` with public placeholder content. Create `.env.production` and `src/private.ts` with dummy values.

```yaml
version: 1
org: acme
rules:
  - path: .env.production
    mode: value
    allow: [github-team:infra]
    stub: .env.example
  - path: src/private.ts
    mode: file
    allow: [github-team:infra]
    stub: src/private.stub.ts
```

```sh
bettergit init
bettergit group-signing-key github-team:infra
# Add the printed value as signing_key to every rule for this group.
bettergit init
git add .access.yml .gitattributes .env.example src/private.stub.ts
git add .env.production src/private.ts
bettergit check-staged --json
git commit -m "Enable Better Git encryption"
```

Init writes the absolute binary path and a required synchronous process filter into local Git configuration. It manages `.gitattributes` and local `info/attributes` to disable text/EOL/encoding conversions on ciphertext. It creates group keys only for untracked protected content, and never invents a replacement key for existing indexed data. Back up encrypted envelopes using your organization's key recovery process; losing every authorized identity makes data unrecoverable.

A fresh clone initially contains ciphertext. Run `bettergit init`, then pin verified group public keys and sync/import keys and rerun init to refresh unchanged ciphertext, or explicitly check out protected paths. Init refreshes only worktree files that are byte-identical to valid indexed ciphertext, so a pre-init clone receives plaintext or safe stubs. Edited files remain untouched. Stubs must be public, tracked files; they are loaded from the index, independently of checkout order. Exact stubs clean back to the indexed ciphertext. Edited unauthorized stubs fail clean. Git filters cannot intercept deletion: enforce repository write permissions and review deletions.

Value mode supports dotenv, JSON, and YAML. Dotenv encrypts the entire assignment after `=`, including whitespace and inline `#` text. Put public comments on separate lines. JSON/YAML scalars retain their original source representation and types. Unchanged fields reuse existing ciphertext. Values use signed `ENC[v2:…]` tokens bound to their path and field. Whole-file mode signs the binary age blob and binds it to its path. Checkout verifies against the group's signing key derived from its private age identity. The GitHub guard verifies against `signing_key` from the administrator-approved policy. Set that field on each protected rule before enabling the guard. Signatures establish group membership at signing time, and any holder of the group identity can sign.

The V1 policy language supports one group per rule and Git-style literal paths, `*`, `**`, and `?`. Basename patterns match at every depth; slash patterns are relative to the repository root. Overlapping matching rules fail closed. Special attribute syntax, brace expansion, whitespace in rule paths, complex YAML keys, YAML aliases/tags, duplicate value keys, and multiline dotenv quotes are unsupported. Use file mode for unsupported documents. Public keys, comments, filenames, structure, value counts, and approximate lengths are observable.

## Migrating legacy ciphertext

The filter, guard, CI, and browser viewer require signed content. Migrate using an independently reviewed plaintext copy from a trusted backup. The CLI compares every byte before signing and writes ciphertext only. Unsigned v1 blobs and preview whole-file v2 blobs use this migration path. The current whole-file format uses a separate signing context from values. For example, with `.env.production` still checked into the old index:

```sh
(
  set -eu
  migration_dir=$(mktemp -d)
  trap 'rm -rf -- "$migration_dir"' EXIT
  git show :.env.production > "$migration_dir/legacy"
  bettergit migrate-legacy .env.production "$migration_dir/legacy" \
    --reviewed-plaintext /private/reviewed.env "$migration_dir/signed"
  signed_blob=$(git hash-object -w --no-filters "$migration_dir/signed")
  git update-index --cacheinfo "100644,$signed_blob,.env.production"
)
```

Use the existing index mode from `git ls-files -s` for each path. The migration writes ciphertext only and refuses to overwrite its output. After staging the signed blobs and reviewed signing-key pins, refresh the protected worktree paths and approve the migration commit as the new guard baseline. Rotate any values previously exposed in a dotenv assignment tail. Old Git revisions retain their original bytes.

If the filter refuses an invalid index blob, inspect the committed history and identify a trusted signed revision first. Restore only the index entry with `git restore --staged --source TRUSTED_COMMIT -- PATH`, then stage the reviewed working copy normally. This preserves working-copy edits. Rotate affected secrets if bad history was shared.

## Hosted Better Git

An organization owner can [install the Better Git App](https://github.com/apps/better-git-app/installations/new) on selected repositories. Start with a disposable organization repository and dummy secrets while Better Git is in development preview.

Install the CLI and follow [policy and local setup](#policy-and-local-setup). Commit the policy with its signing keys to the repository's default branch. A repository administrator can review the commit and enroll it in the [dashboard](https://bettergit.app/dashboard/) or use the CLI from the repository checkout.

```sh
bettergit login --client-id Iv23lig8vf1PwnacamJA --server https://bettergit.app
bettergit enroll --server https://bettergit.app OWNER REPO
```

The dashboard displays the approved path-to-team policy and links to GitHub access and branch rules. Agents can read the same inventory through [the JSON API](https://bettergit.app/agents.md#inspect-repository-policy-and-enrollment).

Use `https://bettergit.app` as the server for the remaining [managed directory commands](#managed-directory). Before requiring **Better Git merge encryption guard** in your branch rules, verify that the App reports the check on a pull request. The hosted App supports team-based key distribution and merge checks. Restricted companion branches require the self-hosted setup and its additional GitHub permissions.

## Managed directory

Deploy with [Docker Compose](deploy/README.md) or follow the [native control-plane setup](control-plane/README.md). Enable device flow on your GitHub App and use its client ID, with repository permissions configured on the App rather than requesting the broad OAuth `repo` scope.

```sh
bettergit login --client-id APP_CLIENT_ID --server https://keys.example.test
bettergit enroll --server https://keys.example.test acme repository
bettergit create-group --server https://keys.example.test --repo REPO_ID github-team:infra
bettergit public-key
bettergit upload-key --server https://keys.example.test --group-id GROUP_ID \
  --user-id USER_ID --recipient age1... --version 1 github-team:infra
# For a first-time download, obtain this fingerprint from an administrator.
bettergit pin-group github-team:infra age1...
bettergit sync --server https://keys.example.test --repo REPO_ID
```

Enroll requires the current `origin` to match the requested GitHub repository. Sync checks the local enrollment and origin, requires an independently pinned group fingerprint before first download, and refuses changes to an already cached key. A missing envelope skips that group with a warning so other groups can synchronize. Administrators must verify recipient public-key fingerprints through an independent trusted channel before uploading envelopes; directory confidentiality does not prove recipient identity. Public-key replacement is refused and requires a separately reviewed recovery procedure. The CLI can also `grant GROUP RECIPIENT OUTPUT` and `import GROUP ENVELOPE` for offline distribution. Offline transfers are outside managed-fetch audit coverage. Run login again after upgrading from versions that stored one shared credential. Tokens are now stored per HTTPS server origin.

The filter never contacts the control plane. Wrapped group identities are cached under the Git directory and unwrapped once per process. Revoking membership cannot erase local plaintext, cached keys, or historical Git objects. Offboarding conservatively recommends rotation for every potentially affected group, including exposure that managed fetch logs cannot prove. Re-encryption and secret rotation remain administrator actions, not deletion guarantees.

## Keyless CI and local broker

See [`docs/ci.md`](docs/ci.md). A CI job generates an ephemeral identity in memory and obtains an issuer-signed OIDC token whose audience binds that recipient and group. An administrator's broker independently verifies the JWT using provider JWKS and a **local, trusted policy** before wrapping a locally held key. The control plane cannot nominate an arbitrary recipient merely by inserting a database row. There is no server-held group key or automatic server rewrapping.

## Browser viewer

Build `extension/` and load its `dist/` directory as an unpacked Chromium extension. The Manifest V3 bundle uses `age-encryption` locally. On a GitHub PR Files changed page, select encrypted dotenv lines or complete JSON/YAML content; enter its repository-relative path, access group, verified group age recipient, and format. Paste your identity and the base64 wrapped group key into the popup. Output uses `textContent` in the extension popup, away from GitHub's DOM, and inputs clear after success or failure. It has no network or persistent-storage permission. JavaScript cannot guarantee wiping copies from browser memory.

The current viewer supports selected value-mode content, one group at a time. It does not yet retrieve and compare whole-file age blobs or integrate directly with OS Keychain. The CLI never exports its long-term identity; use a separately generated browser identity and an explicitly verified grant. Do not copy a production CLI identity out of Keychain to use the viewer. Firefox packaging and store submission are unverified.

## Private workspaces and restricted branches

A private workspace is one GitHub companion repository with one audience. Multiple restricted branches can share it. Every branch in a workspace is visible to its entire audience; use separate workspaces for different audiences. Repository administrators manage workspaces through the dashboard or CLI. Members currently receive push access; separate reader/writer and delegated owner roles are not implemented.

### Join from a workspace link

Install the Better Git CLI from the [pilot release](https://github.com/MegaPanchamZ/bettergit/releases/tag/v0.1.1-pilot.1). Configure a GitHub HTTPS credential manager, or run `gh auth login --git-protocol https` and `gh auth setup-git` if you already use GitHub CLI. Git credentials and the Better Git device login each need access as your GitHub account.

```sh
bettergit login
bettergit whoami
bettergit branch join 'https://bettergit.app/join/#<branch-id>'
```

Use the link your administrator shares from **Access and branches** after verifying access and pushing the branch. Run join from a clean parent checkout or from a directory where you want Better Git to clone the parent. A new clone uses HTTPS. An existing checkout keeps its GitHub transport. Run `bettergit doctor '<join-link>'` to confirm the local keyring identity and both Git reads without changing the checkout.

For onboarding problems, verify the member has accepted the GitHub organization invitation and can read the parent. The workspace setup form checks organization base permissions and the App's grants. After removing someone, check **Access history** for GitHub's confirmed companion removal and the member's parent permission. Earlier clones retain downloaded data.

The organization must have base repository permission `none`. Allowed users must belong to the organization and already read the parent repository because its history is copied into the companion. The self-hosted GitHub App needs access to newly created companions. Workspace groups reference existing enrolled directory groups, whose numeric GitHub team identities are independently pinned. Team memberships become individual repository grants, rather than giving the team direct repository access.

```sh
# Create once; share the returned workspace ID across branches.
bettergit workspace create legal --repo REPO_ID --allow @alice,@bob \
  --groups GROUP_ID --server https://keys.example.test
bettergit workspace list --repo REPO_ID --server https://keys.example.test
bettergit workspace show WORKSPACE_ID --server https://keys.example.test
# Replaces the complete desired audience. Include every group/user to retain.
bettergit workspace members WORKSPACE_ID --allow @alice,@bob \
  --groups GROUP_ID --server https://keys.example.test
bettergit workspace reconcile WORKSPACE_ID --server https://keys.example.test
bettergit branch create private-feature --workspace WORKSPACE_ID \
  --server https://keys.example.test --repo REPO_ID
git push bettergit-private-feature private-feature
bettergit branch join SHADOW_ID --server https://keys.example.test
# Fetch, merge, and push collaborators' work and the latest public main first.
bettergit branch publish private-feature --base main --server https://keys.example.test
```

The legacy `branch create NAME --allow @alice,@bob` command creates a new workspace for that branch and includes its creator. Creating branches and publishing still require parent administrator access and workspace membership. Branch names must be unique within the enrolled parent repository. Workspace membership does not grant encryption keys: the existing directory approval and envelope delivery flow remains separate.

The dashboard displays workspace state, the last successful verification, effective members and their access sources, offboarding exclusions, branches, and access history. Listed members on a blocked workspace reflect the last successful verification, not a claim about current GitHub access. Audience changes are saved before applying permissions. Failed checks remain blocked and retry after one minute; successful checks become due after five minutes. A worker leases batches of four across service replicas. Join and publication require a successful verification within ten minutes; large queues or provider outages can therefore block these operations. Existing Git clones communicate directly with GitHub: blocking Better Git operations does not itself stop Git fetch/push or recall already downloaded content.

Reconciliation removes unexpected direct collaborators, team grants, and pending invitations; applies intended push grants; and verifies the result before marking access ready. Privileged administrators are preserved. Unexpected organization base permissions, repository visibility/identity changes, unavailable team sources, provider errors, or unapplied grants block verification. This is eventual enforcement: exposure between a GitHub permission change and correction cannot be recalled. Offboarding exclusions persist so stale team data cannot automatically regrant access; reinstatement currently requires independently reviewed administrative recovery. Key rotation and secret rotation remain separate incident-response work.

Archive a workspace from the dashboard to remove managed collaborator access, verify removal, and archive its repository. History is retained; privileged administrators can still access it. Automatic deletion and configurable retention are not implemented.

Create installs a pre-push hook preserving an existing hook. The hook rejects private ancestry sent to other remotes, including explicit and bulk pushes. Hooks can be bypassed by users controlling their machine. Copying content, cherry-picking, or independent squash commits cannot be detected by ancestry checks. Publish authorizes before public transfer, requires the current public base to be an ancestor of the private tip, checks the shadow tip, then creates a new single-parent commit and opens a PR. The server verifies trees, exact SHAs, PR head, and current base. If public transfer succeeds but PR creation fails, `bettergit branch resume NAME --server URL` recovers PR creation; the content has already reached all parent readers.

Private companions remain visible to organization owners, enterprise administrators, authorized Apps, and other privileged GitHub roles. Set organization App and Copilot access policies explicitly. Workspaces are not an administrative secrecy boundary.

Apply `control-plane/workspaces.sql` after the preceding migrations before deploying this version. Existing companions become separate workspaces named `BRANCH-ID`; repository names, Git history, branch IDs, and local remotes remain unchanged. Existing active workspaces start pending verification. Failed legacy records remain inactive. Upgrade grants must include the new tables and sequences; see the control-plane deployment instructions.

## Releases

`dist-workspace.toml` and the release workflow use cargo-dist 0.34.0. The release plan includes Linux, macOS, and Windows binaries plus Shell, PowerShell, npm, and Homebrew installer artifacts. The tag workflow requires the checks to pass and attests the release assets before publication. Configure required reviewers and tag restrictions on the GitHub `release` environment before publishing. No release has been published. Homebrew tap publication and npm registry publication need maintainer-owned destinations and credentials. The checks workflow runs Rust checks on all three OS families and TypeScript checks with disposable Postgres on Linux.

## License

The CLI and included control-plane/extension source are available under MIT OR Apache-2.0. Dependencies retain their own licenses. No telemetry or hosted service is configured by default.
