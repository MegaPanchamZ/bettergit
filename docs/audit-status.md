# Audit record and remediation

The original reports are independent source snapshots and are retained unchanged. Every phase received both requested reviewers:

Independent reviewers assessed the CLI and encryption, CI and offboarding, browser viewer, and restricted branch collaboration. Reviews apply to the source snapshots tested. This page summarizes the remediation and known limits.

Major remediation areas include a shared Git-compatible path matcher, pinned filter/service policy, fail-closed unmatched paths, context-bound value encryption, JSON/YAML source preservation, index-loaded public stubs, repository/group-bound envelopes, independently verified fingerprints, local OIDC broker authorization, conservative offboarding with companion access removal, and explicit publication/tree/base checks.

Later changes do not turn an old audit into a clean verdict. The [validation record](validation.md) describes local checks, and the [security model](security-model.md) states the boundaries that code cannot eliminate. Treat this repository as a development implementation until the combined remediation and deployment behavior have been reviewed.

The GPT recheck includes a separately dated verification of the final remediation: real Git pushes after rename, Linux Secret Service fresh-clone/import behavior, Rust/browser interoperability, complete guard pagination and merge ancestry, merge-queue targets, and mocked exact-SHA publication recovery. This is a focused code verification, not a production deployment approval.

The Claude focused verification confirmed the targeted confidentiality fixes and identified public-ancestry over-protection in the local hook. The final change excludes only ancestry actually advertised by the destination remote. A separate GPT follow-up verified public pushes remain possible and forged local tracking refs cannot exempt private history. Sync now fails for a protected policy when zero groups synchronize, including an empty directory result.

Known release limits include live provider/host/browser validation, GitHub required-check triggering for fork PRs and base updates, first-file setup above 2 ms, and the documented administrative visibility and local-hook boundaries. There is no production-readiness claim.

A later Claude Mythos 5.2 audit led to App-scoped token validation, origin-scoped CLI credentials, mandatory fingerprint pinning before a first group import, retries for pending merge candidates, and raw-byte webhook verification. Shadow publication now checks immutable GitHub user IDs. The release workflow gates publication on checks and attests artifacts. The old YAML and packet-line advisories cleared after upgrading the dependencies.

Local remediation checks passed on Linux, including the Postgres-backed suites with mocked GitHub, the native keychain integration, and a signed webhook split across a UTF-8 character. The five-platform release plan and workflow syntax passed local validation. Live GitHub App token issuance, required checks, Windows and macOS keychains, and actual artifact publication still require validation.
