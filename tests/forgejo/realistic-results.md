# Mixed workload validation

The simulation ran against disposable loopback services with separate Forgejo and
control-plane databases. Each project had an enrolled private parent and a
populated companion. Initialized repositories, Git traffic, the control-plane
listener and scheduled workers were real. The GitHub account and installation
boundary was a fixture. [Running the simulation](README.md#mixed-developer-and-organization-workload)

## Retest after the Opus review

The three default repeats used harness fingerprint `623b8a919de31739` and
fresh services. The control plane ran in its own process. Each run offered
225 scheduled ticks and drained all 390 queued operations. Join latency
includes time spent waiting to start. The first repeat briefly shared the
host with the control-plane database test suite.

| Measurement | Default 1 | Default 2 | Default 3 |
|---|---:|---:|---:|
| Successful eligible joins | 112 | 112 | 112 |
| Ineligible attempts denied | 225 | 225 | 225 |
| Eligible join p95 | 795 ms | 715 ms | 741 ms |
| Workload queue wait p95 | 27 ms | 43 ms | 33 ms |
| Peak queued operations | 4 | 4 | 4 |
| Join requests throttled in the separate quota probe | 4 | 4 | 4 |

The invitation fixture exercised a pending grant, acceptance backed by a real
Forgejo collaborator update, a successful join and removal. Fork drift
blocked a join during traffic. An administrator reconciled the drift, then
the join succeeded. The lifecycle also archived the edited workspace after
the traffic phase. All three runs passed those checks.

The quota probe used a compressed two-second window with five permitted
operations. It exhausted an installation's allowance and confirmed that
joins succeeded again after the simulated window reset. A separate negative
run used a budget of 185 operations per minute. It failed the eligible-join
gate with provider 429 while the affected workspace was still Ready. This
checks that the gate distinguishes quota exhaustion from a pending workspace.
In the offboarding scenario, direct Git access persisted until the configured
revocation retry closed it. The observed interval reflects the injected
provider failure, worker backoff and probing cadence.

### Sustained load

One 330-second run used the same harness fingerprint with six organizations,
12 populated parent and companion pairs, and 240 distinct restricted branch
tips. The largest repository included 192 MiB of synthetic binary history.
All 3,300 scheduled ticks were retained, and 6,524 queued operations finished
352.5 seconds after traffic began. All 2,475 eligible joins succeeded and all
3,300 outsider join attempts were denied. Nine unchanged workspaces completed
two verification waves. Invitation acceptance and removal, drift repair,
archiving, and Git access revocation also passed.

Eligible join latency reached 23.49 s at p95 and 26.79 s at p99. The shared
workload queue reached 447 operations, with 21.79 s of wait at p95 across all
queued work. Parent and companion clone p95 were 23.48 s (300 samples) and
24.18 s (195 samples), including queue wait. The service and Git clients used
separate processes on one host. These measurements show saturation in the
combined workload and include waiting in the harness before a request reaches
the service. Only one sustained repeat was run. Live GitHub limits and CLI
join and publish remain unmeasured.

## Historical mixed traffic

The following three runs used different revisions of the harness. Their
latencies cover admitted work and the larger run discarded workload ticks.
Use these runs to reproduce the original access and contention findings.
The current harness records a version fingerprint, queues all scheduled work,
and fails a run on any denial from an unchanged, eligible account.

| Measurement | Default run | Larger run | Default repeat |
|---|---:|---:|---:|
| Tenants and populated parent/companion pairs | 3 tenants, 6 pairs | 6 tenants, 12 pairs | 3 tenants, 6 pairs |
| Distinct restricted branch tips | 48 | 240 | 48 |
| Offered tick interval | 200 ms | 100 ms | 200 ms |
| Ticks dropped at the in-flight cap | 0 of 225 | 207 of 601 | 0 of 225 |
| Eligible join HTTP p95 | 665 ms, n=112 | 7,468 ms, n=297 | 642 ms, n=112 |
| Eligible joins denied | 4 of 112 | 11 of 297 | 1 of 112 |
| Parent clone p95 | 1,066 ms, n=21 | 7,560 ms, n=37 | 835 ms, n=21 |
| Companion clone p95 | 705 ms, n=14 | 7,470 ms, n=23 | 726 ms, n=14 |
| Time to first verification p95 | 3,928 ms, n=6 | 8,553 ms, n=12 | 3,310 ms, n=6 |
| Sampled peak PostgreSQL pool wait depth | 0 | 9 | 0 |

The larger run increased the arrival rate and repository complexity together.
The largest parent had 1,202 files and 192 MiB of binary history across
96 public commits. The large-parent clone median was 6,175 ms over four
samples. The median for small parent clones in that run was 439 ms over 28
samples. The measurements combine the effects of shared-host contention,
repository history and traffic intensity.

The historical application-denied samples above cover users whose audience did not
change during the run. All 844 join attempts by ineligible users were denied
across the three runs. The default repeat added latency by outcome and recurring
Git authorization probes. Its successful join p95 was 642 ms over 111 joins.

## Revocation

In the default run, one HTTP 429 delayed removal of a real Forgejo collaborator.
The Better Git join API denied the former member while the existing Git remote
still responded to an authenticated read. The worker retry was observed after
its stored retry timestamp, about 34 seconds after webhook processing. Fresh
clones and a fetch from a pre-existing checkout failed after recovery. The
workspace-only audience edit preserved the former workspace member's parent
access.

In the default repeat, an authenticated probe first confirmed direct Git access
was denied 34.6 seconds after the signed webhook was accepted, following 30
successful probes. That value includes the probe interval and network time.

All clone checks used the expected identities. Sampled fresh parent clones
contained none of the restricted branch tips, and companion clones matched the
distinct expected tips. A Git copy already held by a user remains readable
locally after provider revocation.

The results describe a single host, one service process and a short burst. The
fixture models provider requests and a scoped throttle. Live GitHub quota
behavior, full enrollment in the browser, client join and publish, multiple
replicas and sustained production capacity remain unmeasured.
