---
name: bettergit
description: Work with Better Git protected repositories. Use when a repo has .access.yml and filter=privgit, or when checking staged ciphertext, editing protected paths, or diagnosing safe stubs.
---

# Better Git

1. Check `bettergit --version` and use `git status --porcelain=v1` to see what changed. Read `.access.yml` for policy and use its public stubs to learn file structure. Keep protected worktree contents, diffs, and credentials out of agent context and logs.
2. If needed, map repository-relative paths with `printf '%s\n' '["config/app.env"]' | bettergit match-paths`. A match identifies a protected path under the working policy.
3. For an authorized edit, check that `git check-attr filter -- PATH` returns `privgit` and that the local `filter.privgit.process` and `filter.privgit.required` settings are present. Stage specific paths with `git add -- PATH`. Keep unrelated staged changes intact.
4. Run `bettergit check-staged --json` before committing or pushing. Exit `0` means the protected entries passed, `1` lists failing paths and codes, and `2` reports an incomplete check. Use the path and code to diagnose failures without dumping blobs. A new file needs ordinary `git add` before the check can validate its contents.

A stub indicates access may be missing. Use the existing login and key distribution flow with the repository owner. Keep required filters enabled and get policy or signer changes reviewed through the repository's normal approval flow. Publishing or resuming publication of a restricted branch sends content to the parent repository and needs explicit authorization.
