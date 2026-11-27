# Multi-organization scale and lifecycle tests

The test used disposable Forgejo 17.0.2 and PostgreSQL 17.11 on the same 32-logical-CPU host as the [original benchmark](results.md). It exercised 200 organizations with 300 enrolled parent repositories and 300 private companions. One organization had 101 parents and 199 organizations had one parent each.

## Behavior

- Organization setup seeded accepted memberships and private parent access. A seeded ordinary user pushed and joined the sampled workspaces. An ordinary user with parent read access was denied those companions.
- A temporary workspace grant allowed the second user to join and clone. Removing that grant denied both again.
- The same member was offboarded from the large organization and from 198 smaller ones. One of those smaller organizations returned an injected deletion failure. Other organizations continued, including one control organization that kept its member grant.
- In the affected organization, Better Git blocked joins while the provider grant remained active. Reconciliation removed it after recovery. The test advanced retry eligibility, so recovery timing excludes the configured backoff.
- Fresh Git clones checked five organizations. Parent access and isolation from the companion's private commit were preserved.

## Scheduler and access changes

Offboarding stages durable exclusions and then reconciles with four bounded workers. Repeated offboarding reuses the exclusions and their audit events. All reconciliation paths share a six-operation process limit. The scheduler leases at most four workspaces at a time, processes up to four batches per tick, and gives pending and blocked changes priority over routine checks. Wide audience reads use batches of four. The dashboard explains when GitHub has yet to verify removal and existing direct access may still work.

## Measurement scope

The harness uses real Forgejo REST and Git traffic with a test-only adapter. It invokes the control-plane workspace functions in a Node process and uses the actual database schema and reconciliation entry point. App installation, browser OAuth, invitation acceptance, and the production HTTP stack are outside these runs. The failure and 40 ms provider latency are injected. The measured cloning uses tiny synthetic repositories.

## Fleet results

| Phase | Wall time | p95 per operation | Operations |
|---|---:|---:|---:|
| Seed organizations and accepted memberships | 4.89 s | 346 ms | 200 organizations |
| Enroll parents and provision companions | 59.82 s | 2.36 s | 300 repository pairs |
| Sample ordinary-user push, join, and clone flows | 5.34 s | 2.92 s | 5 organizations |
| Grant and remove temporary access | 669 ms | — | 1 complete grant-and-removal cycle |
| Verify workspaces at the normal cadence | 42.69 s | — | 300 workspaces in one sweep |
| Offboard the member from the large organization | 5.46 s | — | 101 repositories in one offboarding |
| Offboard under injected 40 ms provider latency | 26.65 s | 1.78 s | 198 organizations |
| Recover the affected organization when eligible to retry | 92 ms | — | 1 reconciliation |

The fleet run finished with zero unexpected errors and one expected provider 503 in the 198-organization offboarding. A separate single-workspace smoke test injected another 503. For phases with one timing observation, wall time is the useful measure. The first fleet run completed provisioning in 49.34 seconds with a 2.49-second p95 before the final audience-read change. The final run's 59.82 seconds and 2.36-second p95 show that endpoint latency and total provisioning throughput can move in different directions. These two runs cannot isolate the cause of the throughput difference.

## Observability and projections

During provisioning, 12 container samples put Forgejo CPU p95 at 284% and PostgreSQL CPU p95 at 142%, where 100% is one logical core. Those p95s are also the sample maxima. Across the fleet phases, Better Git's event-loop p95 was 10–11 ms, peak sampled Node RSS was 240 MiB, and no PostgreSQL pool wait was captured at 250 ms sampling. The delayed offboarding phase peaked at 57% Forgejo CPU and 37% PostgreSQL CPU in five samples. The observability points to provider latency and scheduling as useful variables to test. It does not establish a resource saturation threshold.

The 300-workspace fleet sweep averaged 7.0 verifications per second. A single worker at that rate would take about 2 minutes 22 seconds for 1,000 due workspaces, or 4 minutes 45 seconds for 2,000. This is a linear estimate for the same audience mix and local provider. At 2,000 due workspaces, it leaves little margin in the five-minute refresh interval for contention, rate limits, or retries. Production GitHub capacity requires a separate run.

## Replay of the original workload

| Scenario | Original | Updated |
|---|---:|---:|
| Offboard across 300 workspaces | 40.72 s | 16.26 s |
| Drain 60 workspaces at the two-second cadence | 30.20 s | 8.53 s |
| Provision 24 ordinary members with 40 ms added per provider call | 9.40 s | 4.07 s |
| Reconcile 300 workspaces with continuously submitted four-workspace batches | 19.24 s | 31.30 s |
| Provision the largest 240-workspace batch | 39.97 s | 30.88 s |

Both runs made 4,800 provider calls in the continuous reconciliation sweep. Investigate per-request provider timing before increasing concurrency further. In the updated join run, throughput only rose from 71 to 80 requests per second between 8 and 32 concurrent requests, while p95 rose from 241 to 717 ms.

The updated fleet and replay totalled 32 measured phases with zero unexpected errors. All five control-plane tests passed with a disposable PostgreSQL database. The harness guide documents how to reproduce the run and correlate operations with container metrics.

The replay emitted all 21 successful phase records and passed its final access assertions. Its shell wrapper then returned 127 because the telemetry sampling block was edited while Bash was reading the file. The disposable containers and volumes were removed. The updated wrapper was checked separately with the smoke profile.
