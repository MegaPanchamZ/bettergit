# Better Git

- For work in a repository protected by Better Git, use the [Better Git skill](.agents/skills/bettergit/SKILL.md) and `bettergit check-staged --json`.
- The Rust filter is synchronous. Keep network operations and agent-facing output out of its packet-line loop.
- Verify CLI changes with `cargo test --locked`. The [README](README.md#build-and-verify) lists verification for the control plane, browser extension, and native keychain.
