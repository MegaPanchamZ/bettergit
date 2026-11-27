# Local benchmark on November 26, 2026

`tests/forgejo/run.sh --large --cadence` ran on a Ryzen 9 9950X host with 32 logical CPUs, Forgejo 17.0.2, PostgreSQL 17.11, Node 24.18.0, and Git 2.43.0. It used Better Git's workspace code from the local working tree based on `c366914`. All components shared one host and all Git history was synthetic. These timings describe this run.

## Access and recovery

- The ordinary member could push and clone the workspace before revocation. A second ordinary member with the same parent read access could clone the parent and was denied the workspace.
- After normal revocation the removed member could still clone the parent. The workspace clone and Better Git join were denied. Fresh parent clones did not contain the workspace's private commit.
- While collaborator deletion returned an injected 503, the workspace stayed blocked and Better Git denied joins. Direct Git clones continued to succeed because the provider grant still existed. After recovery the real reconciliation worker removed that grant and fresh clones were denied. The test advanced eligibility for retry to exclude the configured one-minute backoff.
- A single permission change revoked the shared workspace's 330 branches. The test checked fresh clones of two refs and evaluated all 330 Better Git joins.

## Performance

Latency is measured from the start of each benchmark operation. For workloads with one operation, including a bulk Git push or an entire offboarding run, use wall time. Batch counts and requests are documented in the scenario labels.

| Scenario | Ops | Concurrency | Wall | P50 | P95 | Max | Ops/s | Provider calls | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ordinary-member revocation | 1 | 1 | 476 ms | 476 ms | 476 ms | 476 ms | — | 21 | 0 |
| provider rejects revoke (503) | 1 | 1 | 365 ms | 365 ms | 365 ms | 365 ms | — | 15 | 0 |
| retry after provider recovers | 1 | 1 | 424 ms | 423 ms | 423 ms | 423 ms | — | 17 | 0 |
| register shared branches (30) | 30 | 12 | 114 ms | 39 ms | 64 ms | 69 ms | 263.4 | 30 | 0 |
| push 30 refs and wait for visibility | 1 | 1 | 2.020 s | 2.020 s | 2.020 s | 2.020 s | — | 13 | 0 |
| register shared branches (300) | 300 | 12 | 1.508 s | 49 ms | 137 ms | 247 ms | 199 | 300 | 0 |
| push 300 refs and wait for visibility | 1 | 1 | 11.890 s | 11.890 s | 11.890 s | 11.890 s | — | 1 | 0 |
| authorized join | 120 | 1 | 13.505 s | 61 ms | 266 ms | 337 ms | 8.9 | 600 | 0 |
| authorized join | 120 | 8 | 1.729 s | 99 ms | 243 ms | 307 ms | 69.4 | 600 | 0 |
| authorized join | 120 | 32 | 1.367 s | 334 ms | 580 ms | 654 ms | 87.8 | 600 | 0 |
| mixed real Git clones | 48 | 12 | 836 ms | 86 ms | 282 ms | 286 ms | 57.4 | 0 | 0 |
| authorized join with 40 ms per provider call | 120 | 16 | 2.270 s | 270 ms | 422 ms | 446 ms | 52.9 | 600 | 0 |
| wide audience (24 members, 40 ms per provider call) | 1 | 1 | 9.398 s | 9.398 s | 9.398 s | 9.398 s | — | 211 | 0 |
| revoke one shared workspace (330 branches) | 1 | 1 | 307 ms | 307 ms | 307 ms | 307 ms | — | 21 | 0 |
| evaluate all 330 joins after shared-workspace revocation | 330 | 32 | 16 ms | 1 ms | 4 ms | 10 ms | 20454.8 | 0 | 0 |
| provision distinct workspaces (12) | 12 | 8 | 1.050 s | 681 ms | 792 ms | 792 ms | 11.4 | 324 | 0 |
| provision distinct workspaces (48) | 48 | 8 | 4.201 s | 673 ms | 851 ms | 880 ms | 11.4 | 1296 | 0 |
| provision distinct workspaces (240) | 240 | 8 | 39.970 s | 1.430 s | 2.072 s | 2.604 s | 6 | 6480 | 0 |
| bounded reconciliation batch (4 workspaces) | 75 | 1 | 19.238 s | 209 ms | 466 ms | 489 ms | 3.9 | 4800 | 0 |
| reconciliation on two-second worker cadence (60 workspaces) | 1 | 1 | 30.199 s | 30.199 s | 30.199 s | 30.199 s | — | 960 | 0 |
| offboard member across 300 workspaces | 1 | 1 | 40.722 s | 40.722 s | 40.722 s | 40.722 s | — | 5100 | 0 |

## What limited performance

- The Forgejo push and visibility check took 11.9 seconds for 300 refs. Registering those same refs in Better Git took 1.5 seconds.
- Provisioning the final batch of 240 workspaces took 40.0 seconds at eight concurrent requests. Throughput fell from 11.4 to 6.0 workspaces per second between batches in this run. The benchmark does not isolate the cause.
- At the two-second cadence, one worker processed 60 due workspaces in 30.2 seconds. Running the same four-workspace batches back-to-back processed 300 in 19.2 seconds. The cadence caps a single worker at about two workspaces per second when every batch finishes before the next tick.
- Offboarding took 40.7 seconds across 300 distinct workspaces. The service verified removal against the provider for all 300. Fresh clone checks sampled three workspaces afterward, and the parent remained accessible.
- Provisioning one workspace with 24 ordinary members plus an admin took 9.4 seconds with 40 ms added to each provider API call. The adapter performs its own permission lookups, so API call counts describe this fixture.

The benchmark exercised the workspace functions, PostgreSQL state, and real Forgejo Git access. See [the harness guide](README.md) for the scope of GitHub and OAuth simulation. All five existing control-plane tests also passed against a separate disposable PostgreSQL instance.
