import assert from 'node:assert/strict';
import {createHash, createHmac, randomUUID} from 'node:crypto';
import {fork, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {git, seedHistory} from './history.mjs';
import {forgejoFixture} from './provider.js';
import {realisticProvider} from './realistic-provider.mjs';

function integer(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `${name} must be in [${min}, ${max}]`);
  return value;
}

const orgCount = integer('BENCH_ORGS', 3, 2, 200);
const reposPerOrg = integer('BENCH_REPOS_PER_ORG', 2, 1, 50);
const branchesPerRepo = integer('BENCH_BRANCHES_PER_REPO', 8, 2, 330);
const mixedSeconds = integer('BENCH_MIXED_SECONDS', 45, 35, 900);
const intervalMs = integer('BENCH_ARRIVAL_MS', 200, 25, 1000);
const largeHistory = integer('BENCH_LARGE_HISTORY', 0, 0, 1) === 1;
const harnessVersion = createHash('sha256').update(await Promise.all([
  'realistic.mts', 'realistic-server.mts', 'realistic-provider.mts', 'history.mts', 'provider.ts', 'compose.yaml', 'run.sh',
  '../../control-plane/src/server.ts', '../../control-plane/src/workspaces.ts', '../../control-plane/src/shadow.ts',
].map(file => readFile(new URL(file, import.meta.url)))).then(parts => Buffer.concat(parts))).digest('hex').slice(0, 16);
const profile = {orgCount, reposPerOrg, branchesPerRepo, mixedSeconds, intervalMs, largeHistory};
const forgejoUrl = process.env.FORGEJO_TEST_URL!;
const database = new URL(process.env.DATABASE_URL!);
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.pathname, '/bettergit');
assert.equal(process.argv.length, 2, 'configure --realistic with BENCH_* environment variables');
const provider = forgejoFixture(forgejoUrl, process.env.FORGEJO_TEST_TOKEN!);
const simulation = realisticProvider(provider, forgejoUrl);
const password = 'Forgejo-local-disposable-member!';
const adminPassword = 'Forgejo-local-disposable-admin!';
const webhookSecret = 'fixture-webhook-secret';
delete process.env.BETTERGIT_WORKSPACE_PILOT_ORG;
Object.assign(process.env, {PORT: '0', HOST: '127.0.0.1', GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: 'test',
  GITHUB_WEBHOOK_SECRET: webhookSecret, GITHUB_CLIENT_ID: simulation.clientId, GITHUB_CLIENT_SECRET: simulation.clientSecret});
const {db} = await import('../../control-plane/src/service.js');
const root = await mkdtemp(join(tmpdir(), 'bettergit-realistic-'));
const samples = new Map<string, {durations: number[]; byOutcome: Map<string, number[]>}>();
let server: ChildProcess | undefined;
const serverEvents = new Map<string, (value: any) => void>();
const failures = new Map<string, {reason: string; providerStatus?: number}>();
function nextServerEvent<T>(name: string) {
  const {promise, resolve, reject} = Promise.withResolvers<T>();
  const child = server!;
  const onExit = (code: number | null) => {
    serverEvents.delete(name);
    reject(new Error(`control plane exited (${code}) waiting for ${name}`));
  };
  serverEvents.set(name, value => {
    child.off('exit', onExit);
    resolve(value);
  });
  child.once('exit', onExit);
  return promise;
}

async function handleServerMessage(message: {kind: string; id: number; method: string; args: any[]; port: number; data: any}) {
  if (message.kind === 'call') {
    const {id, method, args} = message;
    try {
      let result;
      if (method === 'installation') result = simulation.installation(args[0]);
      else if (method === 'fetch') {
        const [url, verb, headers, body] = args;
        const response = await fetch(url, {method: verb, headers, body});
        result = {status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers)};
      } else if (method === 'request') {
        result = await Reflect.apply(simulation.installationClient(args[0]).request, undefined, args[1]);
      } else {
        assert.equal(method, 'rest');
        const [installation, group, operation, params] = args;
        const client = simulation.installationClient(installation);
        result = await client.rest[group]![operation]!(...params);
      }
      if (server?.connected) server.send({kind: 'reply', id, result});
    } catch (error) {
      const value = error as {message?: string; status?: number; response?: unknown};
      if (server?.connected) server.send({kind: 'reply', id,
        error: {message: value.message ?? 'fixture call failed', status: value.status, response: value.response}});
    }
  } else if (message.kind === 'join-failure') {
    if (message.data.requestId?.startsWith('eligible-')) failures.set(message.data.requestId, message.data);
  } else {
    serverEvents.get(message.kind)?.(message.kind === 'listening' ? message.port : message.data);
    serverEvents.delete(message.kind);
  }
}
let origin: string;
let directories = 0;
let adminToken: string;
type Account = {id: number; login: string; token: string};
type Project = {
  org: string; repo: string; workspace: string; companion: string; member: Account; outsider: Account;
  branch: string; branchId: string; main: string; tip: string; privateTips: string[]; cohort: 'small' | 'medium' | 'large';
};
const projects: Project[] = [];
const inputs: object[] = [];
const remote = (org: string, repo: string) => `${forgejoUrl}/${org}/${repo}.git`;

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? Math.round(sorted[Math.ceil(p * sorted.length) - 1]!) : null;
  return {n: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: at(1)};
}

async function record(kind: string, action: () => Promise<string>, start = performance.now()) {
  const sample = samples.get(kind) ?? {durations: [], byOutcome: new Map<string, number[]>()};
  samples.set(kind, sample);
  let outcome = 'error';
  try {
    outcome = await action();
    return outcome;
  } finally {
    const elapsed = performance.now() - start;
    const outcomeDurations = sample.byOutcome.get(outcome) ?? [];
    outcomeDurations.push(elapsed);
    sample.byOutcome.set(outcome, outcomeDurations);
    sample.durations.push(elapsed);
  }
}

function request(path: string, token: string, method = 'GET', body?: unknown, requestId?: string) {
  return fetch(origin + path, {method, headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(requestId ? {'x-request-id': requestId} : {})},
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000)});
}
async function ok(path: string, method = 'GET', body?: unknown) {
  const response = await request(path, adminToken, method, body);
  assert.equal(response.status, 200,
    `${method} ${path}: ${await response.clone().text()} (last fixture error: ${provider.stats.lastError}; unexpected requests: ${simulation.unsupported.join(', ')})`);
  return response.json();
}
const joinPath = (project: Project) => `/v1/shadows/${project.branchId}`;
const workspacePath = (project: Project) => `/v1/workspaces/${project.workspace}`;

async function waitForBranch(org: string, repo: string, branch: string, tip: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      const {commit} = await provider.api<{commit: {id: string}}>(`/repos/${org}/${repo}/branches/${branch}`);
      assert.equal(commit.id, tip);
      return;
    } catch (error) {
      if ((error as {status?: number}).status !== 404 || attempt >= 30) throw error;
      await delay(100);
    }
  }
}

function authorizationDenied(error: unknown) {
  return /authentication failed|repository .*not found|requested URL returned error: (401|403|404)/i
    .test(String((error as {stderr?: string}).stderr));
}

async function clone(project: Project, account: Account, companion: boolean, expected: 0 | 1) {
  const target = join(root, `clone-${directories++}`);
  const repo = companion ? project.companion : project.repo;
  const branch = companion ? project.branch : 'main';
  try {
    try {
      await git(root, account.login, password, ['clone', '--quiet', '--branch', branch, remote(project.org, repo), target]);
    } catch (error) {
      const stderr = String((error as {stderr?: string}).stderr);
      if (expected === 0 && authorizationDenied(error)) {
        return 'denied';
      }
      assert.fail(`clone ${project.org}/${repo} for ${account.login} failed: ${stderr}`);
    }
    assert.equal(expected, 1, `unexpected repository access for ${account.login}`);
    if (companion) {
      const resolved = await git(target, account.login, password, ['rev-parse', `refs/remotes/origin/${branch}`]);
      assert.equal(resolved.stdout.trim(), project.tip);
      const refs = await git(target, account.login, password,
        ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin/feature-*']);
      assert.deepEqual(new Set(refs.stdout.trim().split('\n')), new Set(project.privateTips));
    } else {
      const resolved = await git(target, account.login, password, ['rev-parse', 'HEAD']);
      assert.equal(resolved.stdout.trim(), project.main);
      for (const tip of project.privateTips) {
        await assert.rejects(git(target, account.login, password, ['cat-file', '-e', tip]),
          (error: {code?: number}) => error.code === 1 || error.code === 128);
      }
    }
    return 'cloned';
  } finally {
    await rm(target, {recursive: true, force: true});
  }
}

async function signedRemoval(project: Project) {
  const payload = JSON.stringify({action: 'member_removed', organization: {login: project.org},
    installation: {id: simulation.installation(project.org).data.id},
    membership: {user: {id: project.member.id, login: project.member.login}}});
  const id = randomUUID();
  const headers = {'x-github-event': 'organization', 'x-github-delivery': id,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', webhookSecret).update(payload).digest('hex')};
  const unsigned = await fetch(origin + '/webhooks/github', {method: 'POST', body: payload,
    headers: {...headers, 'x-hub-signature-256': 'sha256=' + '0'.repeat(64)}, signal: AbortSignal.timeout(20_000)});
  assert.equal(unsigned.status, 403);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(origin + '/webhooks/github', {method: 'POST', body: payload, headers,
      signal: AbortSignal.timeout(20_000)});
    assert.equal(response.status, 204);
  }
  return id;
}

try {
  for (const f of ['schema', 'phase2', 'phase3', 'guard-checkpoints', 'team-identity', 'team-identity-enforcement',
    'guard-deliveries', 'delivery-reliability', 'workspaces']) {
    await db.query(await readFile(new URL(`../../control-plane/${f}.sql`, import.meta.url), 'utf8'));
  }
  const {admin, users} = await provider.seed(password, 2 * orgCount);
  adminToken = simulation.issueToken(admin);
  server = fork(fileURLToPath(new URL('./realistic-server.mts', import.meta.url)), [], {serialization: 'advanced'});
  server.on('message', handleServerMessage);
  origin = `http://127.0.0.1:${await nextServerEvent<number>('listening')}`;
  simulation.setServer(origin);
  assert.equal((await request('/v1/whoami', 'ghu_invalidfixture')).status, 403);
  assert.equal((await ok('/v1/whoami')).login, admin.login);
  console.log(JSON.stringify({scenario: 'realistic-profile', harnessVersion, ...profile, budgetPerInstallationPerMinute: simulation.budget}));
  for (let t = 0; t < orgCount; t++) {
    const org = `tenant-${t}`;
    const member = {...users[t * 2]!, token: simulation.issueToken(users[t * 2]!)};
    const outsider = {...users[t * 2 + 1]!, token: simulation.issueToken(users[t * 2 + 1]!)};
    await provider.seedOrg(org, [member, outsider]);
    simulation.install(org);
    const engineers = await provider.api<{id: number}>(`/orgs/${org}/teams`, 'POST', {
      name: 'Engineers', permission: 'read', includes_all_repositories: false, units_map: {'repo.code': 'read'},
    });
    await provider.api(`/teams/${engineers.id}/members/${member.login}`, 'PUT');
    for (let r = 0; r < reposPerOrg; r++) {
      const repo = `project-${r}`;
      const cohort = largeHistory && r === 0 && t === orgCount - 1 ? 'large' :
        r % 3 === 2 || (r === 0 && t === 0) ? 'medium' : 'small';
      const dir = join(root, `${org}-${repo}`);
      await mkdir(dir);
      const branchNames = Array.from({length: branchesPerRepo}, (_, n) => `feature-${n}`);
      const run = (args: string[]) => git(dir, admin.login, adminPassword, args);
      const history = await seedHistory(dir, org, cohort, branchNames, run);
      assert.equal(new Set(history.branches.values()).size, branchNames.length);
      await provider.api(`/orgs/${org}/repos`, 'POST', {name: repo, private: true, auto_init: false, default_branch: 'main'});
      for (const account of [member, outsider]) {
        await provider.api(`/repos/${org}/${repo}/collaborators/${account.login}`, 'PUT', {permission: 'read'});
      }
      await run(['push', '--quiet', remote(org, repo), 'main:refs/heads/main']);
      await waitForBranch(org, repo, 'main', history.main);
      const enrolled = await ok('/v1/repos', 'POST', {owner: org, repo});
      assert.ok(enrolled.id);
      const group = await ok(`/v1/repos/${enrolled.id}/groups`, 'POST', {name: 'github-team:engineers'});
      const workspace = await ok(`/v1/repos/${enrolled.id}/workspaces`, 'POST',
        {name: 'Engineering', allow: [admin.login], groups: [String(group.id)]});
      assert.equal(workspace.status, 'ready', workspace.issue);
      assert.ok(workspace.member_sources[String(member.id)].sources.includes('github-team:engineers'));
      await run(['push', '--quiet', remote(org, workspace.repo_name),
        ...branchNames.map(name => `${name}:refs/heads/${name}`)]);
      await waitForBranch(org, workspace.repo_name, branchNames[0]!, history.branches.get(branchNames[0]!)!);
      const registered = [];
      for (const name of branchNames) {
        registered.push(await ok(`/v1/repos/${enrolled.id}/shadows`, 'POST', {name, workspace: String(workspace.id)}));
      }
      const branch = branchNames[0]!;
      const project: Project = {org, repo, member, outsider, cohort, workspace: String(workspace.id), companion: workspace.repo_name as string,
        branch, branchId: String(registered[0]!.id), main: history.main, tip: history.branches.get(branch)!,
        privateTips: [...history.branches.values()]};
      projects.push(project);
      inputs.push({org, repo, cohort, files: history.files, publicCommits: history.publicCommits,
        uniquePrivateTips: history.branches.size, publicBinaryHistoryBytes: history.publicBinaryHistoryBytes,
        privateBinaryHistoryBytes: history.privateBinaryHistoryBytes});
      assert.equal((await request(joinPath(project), member.token)).status, 200);
      assert.equal((await request(joinPath(project), outsider.token)).status, 403);
    }
  }
  const edit = projects[0]!;
  const offboard = projects.find(project => project.org !== edit.org)!;
  const unchanged = projects.filter(project => project !== edit && project.org !== offboard.org);
  const stable = unchanged.find(project => project.cohort === 'large') ??
    unchanged.find(project => project.org !== edit.org) ?? unchanged[0];
  const verification = stable ?? edit;
  const companionKey = `/repos/${verification.org}/${verification.companion}`;
  provider.orgBasePermissions.set(verification.org, 'read');
  assert.equal((await request(joinPath(verification), verification.member.token)).status, 403);
  provider.orgBasePermissions.delete(verification.org);
  provider.forkSettings.set(companionKey, true);
  provider.invitations.set(companionKey, [{id: 1, invitee: verification.outsider}]);
  assert.equal((await ok(workspacePath(verification) + '/reconcile', 'POST')).status, 'ready');
  assert.equal(provider.forkSettings.get(companionKey), false);
  assert.deepEqual(provider.invitations.get(companionKey), []);

  await clone(edit, edit.member, false, 1);
  await clone(edit, edit.member, true, 1);
  await clone(edit, edit.outsider, true, 0);
  await clone(offboard, offboard.member, true, 1);
  const worktree = join(root, 'developer');
  const developer = stable ? verification.member : admin;
  const developerPassword = stable ? password : adminPassword;
  await git(root, developer.login, developerPassword, ['clone', '--quiet', '--branch', verification.branch,
    remote(verification.org, verification.companion), worktree]);
  await git(worktree, developer.login, developerPassword, ['switch', '--quiet', '-c', 'developer-change']);
  await writeFile(join(worktree, 'developer-change.txt'), 'A synthetic workspace-only feature update.\n');
  await git(worktree, developer.login, developerPassword, ['add', 'developer-change.txt']);
  await git(worktree, developer.login, developerPassword, ['commit', '--quiet', '-m', 'Developer change']);
  const revokedWorktree = join(root, 'former-developer');
  await git(root, offboard.member.login, password, ['clone', '--quiet', '--branch', offboard.branch,
    remote(offboard.org, offboard.companion), revokedWorktree]);

  const active = new Set<Promise<unknown>>();
  const loadErrors: unknown[] = [];
  const tasks: Promise<unknown>[] = [];
  let arrival = 0;
  const queued: {kind: string; action: () => Promise<string>; scheduled: number}[] = [];
  let nextWork = 0;
  let peakQueued = 0;
  const queueMs: number[] = [];
  let faultRetryAfter: Date | undefined;
  let faultRetriedAt: Date | undefined;
  let submittedDelivery: string | undefined;
  let webhookAcceptedAt: number | undefined;
  let completedDeliveryAt: Date | undefined;
  let directDeniedAt: number | undefined;
  let nextDirectProbe = 0;
  const started = nextServerEvent<void>('started');
  server.send({kind: 'start'});
  await started;
  const start = performance.now();
  const dueAt = Date.now();
  const startedAt = new Date(dueAt).toISOString();
  const initialForgejoCalls = provider.stats.calls;
  simulation.startTraffic();
  simulation.throttleRemoval(offboard.org, offboard.companion);
  function drain() {
    while (active.size < 16 && nextWork < queued.length) {
      const {kind, action, scheduled} = queued[nextWork++]!;
      queueMs.push(performance.now() - scheduled);
      const task = record(kind, action, scheduled).catch(error => {loadErrors.push(error);})
        .finally(() => {active.delete(task); drain();});
      active.add(task);
    }
  }
  const deadline = start + mixedSeconds * 1000;
  function offer(slot: number, scheduled: number) {
    const launch = (kind: string, action: () => Promise<string>) => queued.push({kind, action, scheduled});
    const project = projects[slot % projects.length]!;
    launch('outsider-join', async () => {
      const response = await request(joinPath(project), project.outsider.token);
      assert.equal(response.status, 403);
      return 'denied';
    });
    if (project !== edit && project.org !== offboard.org) {
      launch('unchanged-member-join', async () => {
        const requestId = `eligible-${slot}`;
        const response = await request(joinPath(project), project.member.token, 'GET', undefined, requestId);
        if (response.status !== 200) {
          const attributed = failures.get(requestId);
          const {rows: [state]} = await db.query('SELECT status,issue FROM workspaces WHERE id=$1', [project.workspace]);
          assert.fail(JSON.stringify({requestId, workspace: project.workspace, status: response.status, attributed, state}));
        }
        return 'joined';
      });
    }
    if (slot % 11 === 0) launch('parent-clone', () =>
      record(`parent-clone-${project.cohort}`, () => clone(project, project.outsider, false, 1)));
    if (slot % 13 === 0) launch('existing-companion-fetch', async () => {
      const result = await git(worktree, developer.login, developerPassword,
        ['fetch', '--quiet', 'origin', `refs/heads/${verification.branch}`]);
      assert.equal(result.stderr, '');
      return 'fetched';
    });
    if (stable && slot % 17 === 0) {
      const target = unchanged[Math.floor(slot / 17) % unchanged.length]!;
      launch('companion-clone', () =>
        record(`companion-clone-${target.cohort}`, () => clone(target, target.member, true, 1)));
    }
    peakQueued = Math.max(peakQueued, queued.length - nextWork);
    drain();
  }
  function offerDue() {
    const now = Math.min(performance.now(), deadline);
    while (start + (arrival + 1) * intervalMs <= now) {
      const slot = arrival++;
      offer(slot, start + arrival * intervalMs);
    }
  }
  const arrivals = setInterval(offerDue, Math.min(intervalMs, 100));

  try {
    // Age the initial Ready cohort into a single scheduled verification wave.
    // Once it is due, only production workers own future retry timestamps.
    await db.query('UPDATE workspaces SET retry_after=now() WHERE status=\'ready\'');
    tasks.push(delay(2500).then(async () => {
      await record('audience-edit', async () => {
        const result = await ok(workspacePath(edit), 'PUT', {allow: [admin.login], groups: []});
        assert.equal(result.status, 'ready', result.issue);
        return 'ready';
      });
      await delay(7000);
      await record('invitation-lifecycle', async () => {
        const path = `/repos/${edit.org}/${edit.companion}`;
        provider.invitations.set(path, [{id: 2, invitee: edit.member}]);
        const audience = {allow: [admin.login, edit.member.login], groups: []};
        const waiting = await ok(workspacePath(edit), 'PUT', audience);
        assert.equal(waiting.status, 'blocked');
        assert.equal(waiting.issue, 'workspace permissions not yet applied');
        assert.equal((await request(joinPath(edit), edit.member.token)).status, 403);
        await provider.api(`${path}/collaborators/${edit.member.login}`, 'PUT', {permission: 'write'});
        provider.invitations.delete(path);
        assert.equal((await ok(workspacePath(edit) + '/reconcile', 'POST')).status, 'ready');
        assert.equal((await request(joinPath(edit), edit.member.token)).status, 200);
        assert.equal((await ok(workspacePath(edit), 'PUT', {allow: [admin.login], groups: []})).status, 'ready');
        return 'accepted-and-removed';
      });
      await record('fork-drift', async () => {
        const path = `/repos/${edit.org}/${edit.companion}`;
        assert.equal((await request(joinPath(edit), adminToken)).status, 200);
        provider.forkSettings.set(path, true);
        assert.equal((await request(joinPath(edit), adminToken)).status, 403);
        assert.equal((await ok(workspacePath(edit) + '/reconcile', 'POST')).status, 'ready');
        assert.equal((await request(joinPath(edit), adminToken)).status, 200);
        return 'blocked-and-repaired';
      });
    }));
    tasks.push(delay(4000).then(() => record('git-push', async () => {
      await git(worktree, developer.login, developerPassword,
        ['push', '--quiet', 'origin', 'developer-change:refs/heads/developer-change']);
      return 'pushed';
    })));
    tasks.push(delay(5500).then(() => record('webhook-offboarding', async () => {
      for (const team of ['Roster', 'Engineers']) {
        const {id} = await provider.teamByName(offboard.org, team);
        await provider.api(`/teams/${id}/members/${offboard.member.login}`, 'DELETE');
      }
      for (const project of projects.filter(project => project.org === offboard.org)) {
        await provider.api(`/repos/${project.org}/${project.repo}/collaborators/${project.member.login}`, 'DELETE');
      }
      submittedDelivery = await signedRemoval(offboard);
      webhookAcceptedAt = Date.now();
      return 'accepted';
    })));
    for (const task of tasks) void task.catch(error => {loadErrors.push(error);});
    while (performance.now() < deadline || !faultRetriedAt || !directDeniedAt) {
      assert.ok(performance.now() < Math.max(deadline, start + 80_000) + 5000, 'revocation never retried successfully');
      const {rows: [job]} = await db.query(
        'SELECT attempts, retry_after FROM shadow_revocation_jobs WHERE org_name=$1 AND attempts>0', [offboard.org]);
      if (job && !faultRetryAfter) {
        faultRetryAfter = job.retry_after;
        assert.ok(faultRetryAfter && faultRetryAfter.getTime() > Date.now() + 15_000, 'expected real retry backoff');
        assert.equal((await request(joinPath(offboard), offboard.member.token)).status, 403);
        simulation.restoreRemoval();
      }
      if (webhookAcceptedAt && !directDeniedAt && performance.now() >= nextDirectProbe) {
        nextDirectProbe = performance.now() + 1000;
        const outcome = await record('revoking-member-git-read', async () => {
          try {
            await git(revokedWorktree, offboard.member.login, password,
              ['ls-remote', '--exit-code', 'origin', `refs/heads/${offboard.branch}`]);
            return 'still-readable';
          } catch (error) {
            if (!authorizationDenied(error)) throw error;
            return 'denied';
          }
        });
        if (outcome === 'denied') directDeniedAt = Date.now();
      }
      if (faultRetryAfter && !job && !faultRetriedAt) {
        faultRetriedAt = new Date();
        assert.ok(faultRetriedAt >= faultRetryAfter);
      }
      if (submittedDelivery && !completedDeliveryAt) {
        const {rows: [delivery]} = await db.query('SELECT completed_at FROM guard_deliveries WHERE id=$1', [submittedDelivery]);
        completedDeliveryAt = delivery?.completed_at ?? undefined;
      }
      if (loadErrors.length) throw loadErrors[0];
      await delay(200);
    }
  } finally {
    clearInterval(arrivals);
    offerDue();
    await Promise.allSettled(tasks);
    while (active.size) await Promise.allSettled([...active]);
  }

  assert.deepEqual(loadErrors, []);
  const mixedWallMs = Math.round(performance.now() - start);
  const finishedAt = new Date().toISOString();
  const forgejoRestCalls = provider.stats.calls - initialForgejoCalls;
  const providerTraffic = [...simulation.traffic].map(([id, stats]) =>
    [id, {calls: stats.mixedCalls, quotaLimited: stats.quotaLimited, faultLimited: stats.faultLimited}]);
  const providerTiming = distribution(simulation.operationMs);
  const metrics = nextServerEvent<object>('metrics');
  server.send({kind: 'sample'});
  const processMetrics = await metrics;
  assert.ok(completedDeliveryAt && faultRetryAfter && faultRetriedAt && webhookAcceptedAt && directDeniedAt);
  assert.equal(provider.forkSettings.get(companionKey), false);
  assert.deepEqual(provider.invitations.get(companionKey), []);
  assert.equal((await request(joinPath(edit), edit.member.token)).status, 403);
  await clone(edit, edit.member, false, 1);
  await clone(edit, edit.member, true, 0);
  for (const project of projects.filter(project => project.org === offboard.org)) {
    assert.equal((await request(joinPath(project), project.member.token)).status, 403);
    await clone(project, project.member, false, 0);
    await clone(project, project.member, true, 0);
  }
  await assert.rejects(git(revokedWorktree, offboard.member.login, password, ['fetch', 'origin']), authorizationDenied);
  if (stable) {
    assert.equal((await request(joinPath(stable), stable.member.token)).status, 200);
    await clone(stable, stable.member, true, 1);
    // Keep intentional quota saturation separate from the eligible-join gate.
    simulation.startQuotaProbe(stable.org);
    try {
      const attempts = await Promise.all(Array.from({length: 4}, (_, index) =>
        request(joinPath(stable), stable.member.token, 'GET', undefined, `eligible-quota-${index}`)));
      const throttled = attempts.filter((response, index) => response.status === 403 &&
        failures.get(`eligible-quota-${index}`)?.providerStatus === 429).length;
      assert.ok(throttled > 0, 'quota control must throttle real join requests');
      assert.equal(throttled, attempts.filter(response => response.status !== 200).length);
      await delay(2100);
      assert.equal((await request(joinPath(stable), stable.member.token)).status, 200);
      console.log(JSON.stringify({scenario: 'realistic-quota-probe', harnessVersion, attempts: attempts.length,
        throttled, recovered: true, budget: 6, windowMs: 2000}));
    } finally {
        simulation.stopQuotaProbe();
    }
  }
  assert.deepEqual(simulation.unsupported, []);
  assert.equal((await ok(workspacePath(edit) + '/archive', 'POST')).status, 'archived');
  assert.equal((await request(joinPath(edit), edit.member.token)).status, 403);
  const {rows: checks} = await db.query(`
    SELECT workspace_id, count(*)::integer AS verifications,
      extract(epoch FROM (min(created_at)-to_timestamp($1::double precision / 1000))) * 1000 AS delay_ms
    FROM workspace_events WHERE action='ACCESS_VERIFIED' AND created_at>=to_timestamp($1::double precision / 1000)
      AND created_at<=$2::timestamptz GROUP BY workspace_id`, [dueAt, finishedAt]);
  console.log(JSON.stringify({scenario: 'realistic-mixed', harnessVersion, profile, inputs, startedAt, finishedAt,
    mixedWallMs, offeredTicks: arrival, peakQueued, queueDelay: distribution(queueMs),
    elapsedToFirstVerification: distribution(checks.map(row => Number(row.delay_ms))), workspaces: projects.length,
    unchangedWorkspacesVerifiedTwice: checks.filter(row => row.verifications >= 2 &&
      unchanged.some(project => project.workspace === row.workspace_id)).length,
    operations: Object.fromEntries([...samples].map(([kind, sample]) => [kind, {
      ...distribution(sample.durations),
      outcomes: Object.fromEntries([...sample.byOutcome].map(([outcome, durations]) => [outcome, durations.length])),
      latencyByOutcome: Object.fromEntries([...sample.byOutcome].map(([outcome, durations]) => [outcome, distribution(durations)])),
    }])),
    provider: {operations: providerTiming, installations: Object.fromEntries(providerTraffic), forgejoRestCalls},
    offboarding: {completedDeliveryAt, faultRetryAfter, faultRetriedAt,
      gitAccessDeniedAfterMs: directDeniedAt - webhookAcceptedAt},
    process: processMetrics, assertions: 'passed'}));
} finally {
  if (server?.connected) {
    const finished = once(server, 'exit');
    server.send({kind: 'close'});
    const terminate = setTimeout(() => server?.kill(), 5000);
    try { await finished; } finally { clearTimeout(terminate); }
  }
  await db.end();
  simulation.close();
  await rm(root, {force: true, recursive: true});
}
