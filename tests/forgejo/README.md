# Better Git on a disposable Forgejo instance

Run from the repository root with Docker Compose v2, Node 24, Git, and curl.

```sh
npm --prefix control-plane ci
tests/forgejo/run.sh --smoke
tests/forgejo/run.sh --large --cadence > /tmp/bettergit-forgejo.jsonl
```

The runner starts a fresh Forgejo 17.0.2 instance and separate PostgreSQL
containers for Forgejo and the control plane on random loopback ports. Each run
removes its containers, database volumes and temporary Git directories. All
accounts and credentials belong to the disposable fixtures.

## Access regression profiles

These profiles seed an organization, a private parent, a separate private commit
and disposable identities.

The default run covers a shared workspace with 330 branches and 60 separate workspaces. `--large` raises the separate-workspace count to 300. `--cadence` adds a 60-workspace queue test at the service's two-second timer cadence. `--smoke` runs only the access and recovery checks. Each JSON line reports operation count, concurrency, elapsed time, throughput, p50, p95, max, provider calls, peak concurrent calls, and unexpected errors.

The test runs Better Git's workspace, branch join, and reconciliation functions with its real schema. The fixture translates their provider calls into Forgejo REST requests. Git pushes and fresh clones use real Forgejo HTTP authorization. GitHub App installation and invitation behavior are simulated. Browser login, the CLI's GitHub join transport, and GitHub rate limits are outside this run. The test-only adapter does not enable Forgejo as a production provider.

Clone tests verify the expected commit and check that a fresh parent clone has no private workspace commit. The failure test injects provider HTTP 503 semantics on collaborator deletion and verifies that the Better Git join closes while direct Forgejo access persists. It makes the record eligible for retry immediately, so the recovery duration excludes the configured one-minute backoff. Access checks use fresh clones. Existing local copies remain with their holders after revocation.

Provisioning and cloning use tiny synthetic repositories. The 40 ms profile adds that delay before each provider API call. The provider call count includes the local translation, which can issue several Forgejo requests for one control-plane operation.

## Organization lifecycle and observability

```sh
mkdir -p /tmp/bettergit-fleet
BENCH_TELEMETRY_FILE=/tmp/bettergit-fleet/containers.jsonl tests/forgejo/run.sh --fleet \
  > /tmp/bettergit-fleet/load.jsonl
```

The fleet run seeds 200 organizations, 300 parent repositories, and 300 private companions. One organization has 101 enrolled parents. The others have one each. The simulated lifecycle includes organization onboarding, accepted membership, workspace provisioning, ordinary-member pushes and joins, a temporary workspace grant, org-scoped offboarding, and post-recovery access checks. The same seeded users participate across tenants so the run can verify that removing access in one organization preserves access in another. Membership acceptance and parent enrollment are fixture setup. Real Git checks sample five organizations and verify both the companion's authorization and the parent commit. The provider failure and the additional 40 ms latency are injected in the adapter.

Operation records include UTC phase boundaries, p50/p95/max, provider status counts, peak Node RSS, event-loop p95 and utilization, and sampled PostgreSQL pool wait depth. Set `BENCH_TELEMETRY_FILE` to collect timestamped Forgejo and PostgreSQL container CPU, memory, network and disk I/O. Match those timestamps to the operation boundaries in the load log. Docker CPU percentages are relative to one logical core. The load runner calls the Better Git control-plane functions in a Node process and samples that process. Production HTTP, OAuth, and live GitHub infrastructure are outside the run.

Use the timestamped logs to summarize container CPU alongside each load phase.

```sh
node tests/forgejo/summarize.mjs /tmp/bettergit-fleet/load.jsonl /tmp/bettergit-fleet/containers.jsonl
```

Short phases may have no matching container samples. Treat sampled CPU p95 as an approximation and inspect the sample count.

## Mixed developer and organization workload

```sh
cargo build --locked
mkdir -p /tmp/bettergit-realistic
BENCH_TELEMETRY_FILE=/tmp/bettergit-realistic/containers.jsonl \
  tests/forgejo/run.sh --realistic > /tmp/bettergit-realistic/load.jsonl
node tests/forgejo/summarize.mjs /tmp/bettergit-realistic/load.jsonl \
  /tmp/bettergit-realistic/containers.jsonl
```

The larger run in the results used the following configuration.

```sh
BENCH_ORGS=6 BENCH_REPOS_PER_ORG=2 BENCH_BRANCHES_PER_REPO=20 \
  BENCH_MIXED_SECONDS=330 BENCH_ARRIVAL_MS=100 BENCH_LARGE_HISTORY=1 \
  tests/forgejo/run.sh --realistic
```

This profile creates a private parent and a populated companion for every project.
The default is three tenants, two projects per tenant and eight restricted
branches per companion. Each tenant has a distinct developer and an ordinary
member with parent access only. The control plane runs its actual HTTP listener,
policy validator, PostgreSQL migrations and periodic workers. The harness enrolls
parents, binds a Forgejo team, creates workspaces and registers branches through
HTTP. Forgejo handles physical Git transfers and permissions.

Small parents have 82 files and 12 public commits, with 1.5 MiB of binary history.
Medium parents have 402 files and 48 public commits, with 24 MiB of binary
history. Restricted branches contain distinct binaries and canaries. They start
from the current or an older public commit, and some merge the current public
tip. Every sampled fresh parent clone is checked for all private branch tip
objects, and sampled companion clones are checked for all expected branch tips.
These byte counts describe fixture content before Git packing.

A verification wave overlaps parent and companion clones, developer fetches and
a push, join requests from eligible and ineligible users, a workspace audience
edit, a modeled invitation acceptance and fork drift, and a signed organization
removal webhook. The webhook test also exercises signature validation and
duplicate delivery. The provider fixture emulates
jitter, a per-installation request budget and a scoped HTTP 429 on collaborator
removal. After observing a queued retry, the fixture restores provider
availability. Direct Git access is probed independently to measure when it
closes. Only the initial routine verification is marked due by the harness.
Production workers own failure retry timing. A separate short-window quota
probe exhausts one installation's fixture budget through the join endpoint,
attributes the resulting failures to provider 429, and checks recovery.

The mixed record includes a harness fingerprint, operation sample counts,
p50/p95/p99 and outcomes, queue depth and wait, verification coverage, provider
requests grouped by installation, retry timestamps, PostgreSQL pool wait depth
and control-plane process metrics. Every scheduled arrival is queued and
drained. Latency includes the wait from the intended start time. Any denial
for an eligible user whose audience is unchanged fails the run with internal
request attribution. Container sampling reports separate Forgejo and control-plane database
processes. Logical provider calls and translated Forgejo REST requests are
counted separately. Low sample counts make tail percentiles unstable.

| Environment variable | Default | Purpose |
|---|---:|---|
| `BENCH_ORGS` | 3 | Tenant count, 2–200 |
| `BENCH_REPOS_PER_ORG` | 2 | Populated parent/companion pairs per tenant, 1–50 |
| `BENCH_BRANCHES_PER_REPO` | 8 | Distinct restricted branches per companion, 2–330 |
| `BENCH_LARGE_HISTORY` | 0 | Use 1 for a 1,202-file, 96-commit, 192 MiB parent in the last tenant and 2 MiB of binary history per restricted branch in its companion |
| `BENCH_MIXED_SECONDS` | 45 | Minimum traffic phase, 35–900 seconds. Use at least 330 seconds to see a second routine verification wave. |
| `BENCH_ARRIVAL_MS` | 200 | Offered traffic tick interval, 25–1,000 ms |
| `BENCH_INSTALLATION_REQUESTS_PER_MINUTE` | 600 | Synthetic logical REST budget per installation. Smaller budgets can cause lifecycle assertions to fail. |
| `BETTERGIT_BINARY` | `target/debug/bettergit` | CLI used by the control plane to validate policy during enrollment |

Repeat a configuration with fresh containers and separate output files before
comparing tails. Run one measured profile at a time to avoid host contention.
The control plane runs in a separate Node process from the workload and
provider fixture. Both processes and the containers share one host. GitHub's OAuth
exchange, App installations, base-permission drift, fork settings, invitation
cleanup, provider latency and throttling are emulated. Forgejo collaborator
changes are immediate. Browser onboarding, CLI join and publication, Git LFS
and live GitHub rate-limit behavior are outside the measured scope. Keep the
original `--fleet` run for the lightweight metadata-scale checks. See the
[mixed workload results](realistic-results.md) for measured runs.
