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

## Restricted branches

The organization must have base repository permission `none`. Every allowed user must already be able to read the parent repository because its history is copied into the companion repository. The GitHub App needs access to newly created companions.

```sh
bettergit branch create private-feature --allow @alice,@bob \
  --server https://keys.example.test --repo REPO_ID
git push bettergit-private-feature private-feature
# An allowed collaborator, in their enrolled clone:
bettergit branch join SHADOW_ID --server https://keys.example.test
# Fetch, merge, and push collaborators' work and the latest public main first.
bettergit branch publish private-feature --base main --server https://keys.example.test
```

Create configures a private shadow remote and installs a pre-push hook preserving an existing hook. The hook rejects private ancestry sent to other remotes, including explicit and bulk pushes. Hooks are a local accident-prevention mechanism and can be bypassed by users who control their machine. They track commit ancestry: copying content, cherry-picking, or making an independent squash commit does not preserve that ancestry and cannot be detected by this hook. Publish authorizes before any public push, requires the current public base to be an ancestor of the private tip, checks the pushed shadow tip, then creates a new single-parent commit and opens a PR. The server compares its tree to the shadow, verifies the exact commit SHAs and PR head, and checks the current base. If public transfer succeeds but the PR request fails, use `bettergit branch resume NAME --server URL` to recover PR creation; the content is already public after that transfer. Publishing intentionally reveals that content to all parent-repository readers.

Private companions remain visible to organization owners, enterprise administrators, authorized Apps, and other privileged GitHub roles. GitHub permissions cannot guarantee invisibility to administrators or exclusion from every AI integration. Set organization App and Copilot access policies explicitly. ACL checks occur during creation/publication; continuous privacy-drift reconciliation is not implemented. Do not interpret this feature as an administrative secrecy boundary.

## Releases

`dist-workspace.toml` and the release workflow use cargo-dist 0.34.0. The release plan includes Linux, macOS, and Windows binaries plus Shell, PowerShell, npm, and Homebrew installer artifacts. The tag workflow requires the checks to pass and attests the release assets before publication. Configure required reviewers and tag restrictions on the GitHub `release` environment before publishing. No release has been published. Homebrew tap publication and npm registry publication need maintainer-owned destinations and credentials. The checks workflow runs Rust checks on all three OS families and TypeScript checks with disposable Postgres on Linux.

## License

The CLI and included control-plane/extension source are available under MIT OR Apache-2.0. Dependencies retain their own licenses. No telemetry or hosted service is configured by default.
