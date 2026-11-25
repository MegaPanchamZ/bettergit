# Better Git agent instructions

Better Git encrypts selected files before Git stores them. The CLI handles local encryption. The hosted GitHub App provides team-based key distribution and merge checks.

## Working in a protected repository

1. Read the repository's `AGENTS.md` and `.access.yml`. Use the [Better Git skill](https://github.com/MegaPanchamZ/bettergit/blob/main/.agents/skills/bettergit/SKILL.md) for repository operations.
2. Run `bettergit --version` and `git status --short`. Install the CLI if needed. In a fresh clone, use `bettergit init` to configure the local filter and follow the repository's key setup. Verify public signing keys and group fingerprints with the repository administrator.
3. Edit the working copy normally, then stage explicit paths with `git add -- PATH`. Keep credentials, private keys, and decrypted values out of chat, logs, and command output. Keep any public stub free of secrets.
4. Run `bettergit check-staged --json` against the final staged changes before committing. Exit `0` means the check passed. Exit `1` reports path issues. Exit `2` means the check could not run. Resolve the reported problem before committing. If a protected file is unavailable, report the affected path and ask the repository administrator for access.

## Install the CLI

Use Git and stable Rust. On Debian or Ubuntu, install `build-essential`, `pkg-config`, and `libdbus-1-dev`. The CLI needs a working OS keychain for local identities and GitHub credentials.

```sh
git clone https://github.com/MegaPanchamZ/bettergit.git
cd bettergit
cargo install --locked --path .
bettergit --version
```

## Set up a repository

Better Git is in development preview. Start in a disposable repository with dummy values. Follow the [local setup](https://github.com/MegaPanchamZ/bettergit#policy-and-local-setup) to define the protected paths, add each group's signing key to the policy, stage the encrypted content, and verify the index.

For hosted setup, an organization owner can [install the Better Git App](https://github.com/apps/better-git-app/installations/new) on selected repositories. Commit the reviewed policy to the default branch. From the repository checkout, an administrator can then sign in and enroll it. Replace `OWNER` and `REPO` with the values from the checkout's GitHub `origin`.

```sh
bettergit login --client-id Iv23lig8vf1PwnacamJA --server https://bettergit.app
bettergit enroll --server https://bettergit.app OWNER REPO
```

Have the user complete GitHub device authorization. Continue with the [managed directory setup](https://github.com/MegaPanchamZ/bettergit#managed-directory), using `https://bettergit.app` as the server. Confirm the App reports **Better Git merge encryption guard** on a pull request before making it a required check.

## Read when needed

- [Self-hosting](https://github.com/MegaPanchamZ/bettergit/blob/main/deploy/README.md)
- [Security model](https://github.com/MegaPanchamZ/bettergit/blob/main/docs/security-model.md)
- [Validation and release gates](https://github.com/MegaPanchamZ/bettergit/blob/main/docs/validation.md)
