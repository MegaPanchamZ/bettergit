# Local validation record

Environment: Linux x86_64, 2026-11-25. All identities and secret values used for verification were synthetic. No hosted repository, production database, or external account was changed.

The Rust suite exercises authenticated age decryption, tampering/wrong identities, context binding, unchanged-ciphertext reuse, dotenv comment preservation, JSON/YAML source/type round trips, YAML block values, Git-compatible path matching, unsupported/duplicate inputs, envelope repository/group/recipient binding, long-running protocol requests and partial EOF, and explicit/bulk push checks using disposable Git repositories.

The control-plane tests exercise signed synthetic OIDC JWTs, database migrations, signed HTTP intake, offboarding retries, guard queue persistence and deduplication, acceptance of a correctly signed blob, rejection of an unrelated signer, and independent PR retries and dead-lettering after a base push. The database tests use isolated Postgres 17 schemas and mocked GitHub responses. Both TypeScript packages type-check. The Manifest V3 extension tests consume a fixture created by the Rust CLI modules and reject wrong keys, changed signatures, and unsigned assignments. The unpacked extension loaded successfully in Chromium, where its popup decrypted the Rust fixture with WebCrypto and cleared its secret inputs. The selected-tab response in that smoke test was mocked.

A real Linux Secret Service run uses `dbus-run-session` with an isolated XDG data/config directory. It exercises init, real Git clean/smudge, nested basename rules, index stability, fresh-clone stub checkout and unauthorized edit refusal. This is distinct from in-memory crypto tests and does not use the developer's existing keychain.

A cargo-dist 0.34.0 plan generated 17 release artifacts, covering configured OS binaries and Shell, PowerShell, npm and Homebrew installers. Generated workflows parse as YAML. Remote CI and installer execution on the other OSes have not run locally.

## Measurements

The release profile uses `opt-level = "z"`, LTO and stripping. The Linux x86_64 distribution profile also aborts on panic and measured 4,625,624 bytes. It passed the real Git and Secret Service smoke test and the control-plane guard tests. After deferring policy/keychain/index initialization until the first content request, an earlier build measured median 0.778 ms and p95 1.520 ms for 100 warm protocol-only process launches.

A first smudge including policy loading, OS keychain access, local key unwrap, the Git index helper, and one value decryption measured median 8.551 ms and p95 9.524 ms over 30 processes. A session with 100 smudge requests measured median 29.871 ms over 10 processes. This distinguishes fast process startup from the remaining first-file setup cost; the original sub-2 ms full-setup target is not achieved. These are local measurements, not cross-platform performance guarantees.

## Production release gates

- Set up a staging GitHub App and organization using the [control-plane setup](../control-plane/README.md). Apply the migration sequence to a copy of the target schema and verify a backup restore before production migration. Bind existing access groups to independently verified numeric team IDs.
- In staging, verify that the installed App's required check gates an ordinary pull request, a pull request from a fork if allowed, a pull request after a base advance, and a merge-queue candidate if enabled. Verify both acceptance of correctly signed content and rejection of synthetic invalid content. Check that adding a later clean commit does not hide earlier rejected history.
- Exercise device login, installation permissions, GitHub Actions and Vercel-issued OIDC tokens, team removal, companion repository visibility and revocation, and interrupted publication recovery against the staging installation. Monitor the delivery and revocation queues during the run.
- Exercise the real browser action on a GitHub PR Files changed page and verify clean/smudge with the native macOS and Windows keychains. Run and verify the release workflow and installer attestations from a staging tag before publishing.
- Review Rust dependency advisories for the final lockfile. npm audit reported zero findings for the installed extension and control-plane dependencies. The Rust lockfile scan still flags seven packages, including build dependencies, inactive optional entries and crypto dependencies with operations the CLI does not use. Record their reachability and disposition before approving a production artifact.

A self-hosted GitHub webhook check can gate merges but receives pushes after upload. Historical signed values retain their validity under the same key and field. Keep repository and group identities distinct and rotate exposed secrets. Independent audit verdicts in `audits/` apply to their recorded snapshots. The production gates still require a staging installation, real provider credentials and the supported operating systems.
