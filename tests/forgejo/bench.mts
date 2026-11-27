import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {forgejoFixture} from './provider.js';

const exec = promisify(execFile);
const url = process.env.FORGEJO_TEST_URL!;
const provider = forgejoFixture(url, process.env.FORGEJO_TEST_TOKEN!);
assert.equal(new URL(process.env.DATABASE_URL!).hostname, '127.0.0.1');
assert.equal(new URL(process.env.DATABASE_URL!).pathname, '/bettergit');
delete process.env.BETTERGIT_WORKSPACE_PILOT_ORG;
process.env.GITHUB_APP_ID = '1';
process.env.GITHUB_PRIVATE_KEY = 'test';
process.env.GITHUB_WEBHOOK_SECRET = 'test';

const {app, db} = await import('../../control-plane/src/service.js');
const {createWorkspace, workspaceBranch, branchJoinLink, updateWorkspace, drainWorkspaceReconciliation,
  revokeWorkspaceAccess, workspaceInfo} = await import('../../control-plane/src/workspaces.js');
const {joinShadow} = await import('../../control-plane/src/shadow.js');
app.getInstallationOctokit = (async () => provider.gh) as unknown as typeof app.getInstallationOctokit;
app.octokit.rest.apps.getOrgInstallation = (async () => ({data: {id: 1, permissions: {
  administration: 'write', organization_administration: 'read', members: 'read', contents: 'read',
}}})) as unknown as typeof app.octokit.rest.apps.getOrgInstallation;

const org = 'benchorg';
const password = 'Forgejo-local-disposable-member!';
const adminPassword = 'Forgejo-local-disposable-admin!';
const fleet = process.argv.includes('--fleet');
const smoke = process.argv.includes('--smoke');
const large = process.argv.includes('--large');
const cadence = process.argv.includes('--cadence');
assert.ok(process.argv.slice(2).every(arg => ['--smoke', '--large', '--cadence', '--fleet'].includes(arg)),
  'supported flags are --smoke, --large, --cadence and --fleet');
assert.ok(!smoke || (!large && !cadence && !fleet), '--smoke runs independently');
const root = await mkdtemp(join(tmpdir(), 'bettergit-forgejo-'));
const source = join(root, 'source');
let directories = 0;
let publicSha: string;
let privateSha: string;
const remote = (repo: string, owner = org) => `${url}/${owner}/${repo}.git`;

async function git(args: string[], login: string, secret: string) {
  return exec('git', args, {
    cwd: root, timeout: 90_000,
    env: {PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${login}:${secret}`).toString('base64')}`},
  });
}

async function clone(repo: string, login: string, allowed: boolean, branch = 'main', owner = org) {
  const target = join(root, `clone-${directories++}`);
  try {
    await git(['clone', '--quiet', '--branch', branch, remote(repo, owner), target], login, password);
    assert.ok(allowed, `fresh clone unexpectedly succeeded for ${login} on ${repo}`);
    const head = (await git(['-C', target, 'rev-parse', 'HEAD'], login, password)).stdout.trim();
    const isParent = repo === 'parent' || /^parent-\d+$/.test(repo);
    assert.equal(head, isParent ? publicSha : privateSha);
    if (isParent) {
      await assert.rejects(() => git(['-C', target, 'cat-file', '-e', privateSha], login, password),
        /Command failed/);
    }
  } catch (error) {
    if (allowed || !/Authentication failed|repository .*not found|requested URL returned error: (401|403|404)/i.test(String((error as {stderr?: string}).stderr))) throw error;
  } finally {
    await rm(target, {force: true, recursive: true});
  }
}

async function measure(label: string, ops: number, concurrency: number, task: (index: number) => Promise<unknown>) {
  let next = 0;
  const times: number[] = [];
  const errors: string[] = [];
  const initialCalls = provider.stats.calls;
  const initialFailures = new Map(provider.failures);
  provider.stats.peak = 0;
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const cpu = process.cpuUsage();
  const loop = monitorEventLoopDelay({resolution: 10});
  const utilization = performance.eventLoopUtilization();
  let peakRss = process.memoryUsage.rss();
  let poolPeakWaiting = db.waitingCount;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    poolPeakWaiting = Math.max(poolPeakWaiting, db.waitingCount);
  }, 250);
  loop.enable();
  await Promise.all(Array.from({length: Math.min(ops, concurrency)}, async () => {
    while (next < ops) {
      const index = next++;
      const began = performance.now();
      try { await task(index); }
      catch (error) { errors.push(String(error)); }
      times.push(performance.now() - began);
    }
  }));
  clearInterval(sampler);
  loop.disable();
  const elapsed = performance.now() - start;
  const cpuUsed = process.cpuUsage(cpu);
  times.sort((a, b) => a - b);
  const percentile = (p: number) => Math.round(times[Math.ceil(times.length * p) - 1]!);
  const providerFailureStatuses = Object.fromEntries([...provider.failures]
    .map(([status, total]) => [status, total - (initialFailures.get(status) ?? 0)])
    .filter(([, count]) => count !== 0));
  console.log(JSON.stringify({scenario: label, startedAt, finishedAt: new Date().toISOString(),
    nodeCpuMs: Math.round((cpuUsed.user + cpuUsed.system) / 1000),
    nodePeakRssMiB: Math.round(Math.max(peakRss, process.memoryUsage.rss()) / 2 ** 20),
    loopP95Ms: loop.count ? Math.round(loop.percentile(95) / 1e6) : null,
    loopUtilization: Number(performance.eventLoopUtilization(utilization).utilization.toFixed(3)), ops, concurrency, wallMs: Math.round(elapsed),
    perSec: Number((ops * 1000 / elapsed).toPrecision(3)), p50Ms: percentile(0.5), p95Ms: percentile(0.95),
    maxMs: percentile(1), providerCalls: provider.stats.calls - initialCalls, providerPeak: provider.stats.peak,
    providerFailureStatuses, poolPeakWaiting, errors: errors.length, firstError: errors[0]}));
  assert.deepEqual(errors.slice(0, 5), []);
}

try {
  for (const f of ['schema', 'phase2', 'phase3', 'guard-checkpoints', 'team-identity',
    'team-identity-enforcement', 'guard-deliveries', 'delivery-reliability', 'workspaces']) {
    await db.query(await readFile(new URL(`../../control-plane/${f}.sql`, import.meta.url), 'utf8'));
  }
  const seeded = await provider.seed(password, smoke || fleet ? 3 : 25);
  const adminLogin = seeded.admin.login;
  const {rows: [adminRecord]} = await db.query(
    'INSERT INTO users(github_id,github_username) VALUES($1,$2) RETURNING id', [seeded.admin.id, adminLogin]);
  const admin = {id: adminRecord.id, github_id: seeded.admin.id, github_username: adminLogin};
  const [member, outsider, bulkMember] = seeded.users.map(u => ({github_id: u.id, github_username: u.login}));
  assert.ok(member && outsider && bulkMember, 'three distinct fixture identities are required');
  const parent = await provider.api<{id: number}>(`/orgs/${org}/repos`, 'POST',
    {name: 'parent', private: true, auto_init: false, default_branch: 'main'});
  for (const user of seeded.users) {
    await provider.api(`/repos/${org}/parent/collaborators/${user.login}`, 'PUT', {permission: 'read'});
  }
  await git(['init', '-b', 'main', source], adminLogin, adminPassword);
  const policy = 'version: 1\norg: benchorg\nrules: []\n';
  await writeFile(join(source, '.access.yml'), policy);
  await git(['-C', source, 'add', '.access.yml'], adminLogin, adminPassword);
  await git(['-C', source, '-c', 'user.name=Bench', '-c', 'user.email=bench@example.test',
    'commit', '-m', 'Seed disposable repository'], adminLogin, adminPassword);
  await git(['-C', source, 'push', '--quiet', remote('parent'), 'HEAD:refs/heads/main'], adminLogin, adminPassword);
  publicSha = (await git(['-C', source, 'rev-parse', 'HEAD'], adminLogin, adminPassword)).stdout.trim();
  const {rows: [parentRecord]} = await db.query(`INSERT INTO repos
    (github_repo_id,org_name,repo_name,installation_id,approved_policy,baseline_sha)
    VALUES($1,$2,'parent',1,$3,$4) RETURNING id`, [parent.id, org, policy, publicSha]);
  await writeFile(join(source, 'restricted.txt'), 'Synthetic content stored only in the workspace.\n');
  await git(['-C', source, 'add', 'restricted.txt'], adminLogin, adminPassword);
  await git(['-C', source, '-c', 'user.name=Bench', '-c', 'user.email=bench@example.test',
    'commit', '-m', 'Seed private workspace history'], adminLogin, adminPassword);
  privateSha = (await git(['-C', source, 'rev-parse', 'HEAD'], adminLogin, adminPassword)).stdout.trim();
  const repoId = String(parentRecord.id);
  async function create(name: string, members: string[]) {
    const w = await createWorkspace(admin, repoId, {name, allow: [adminLogin, ...members]});
    assert.equal(w.status, 'ready', `${w.issue} (${provider.stats.lastError})`);
    return {id: String(w.id), repo: String(w.repo_name)};
  }
  async function push(repo: string, branches: string[], login = adminLogin, owner = org) {
    await git(['-C', source, 'push', '--quiet', remote(repo, owner),
      ...['main', ...branches].map(name => `HEAD:refs/heads/${name}`)], login, login === adminLogin ? adminPassword : password);
    const name = branches.at(-1)!;
    const ready = performance.now() + 10_000;
    for (;;) {
      try {
        await provider.api(`/repos/${owner}/${repo}/branches/${name}`);
        return;
      } catch (error) {
        if ((error as {status?: number}).status !== 404 || performance.now() >= ready) {
          const refs = await git(['ls-remote', remote(repo, owner)], adminLogin, adminPassword);
          console.error(refs.stdout.slice(0, 500));
          throw error;
        }
        await delay(40);
      }
    }
  }
  const pilot = await create('pilot', [member.github_username]);
  const pilotBranch = await workspaceBranch(admin, repoId, pilot.id, 'restricted');
  await assert.rejects(() => branchJoinLink(admin, pilotBranch.id), /push the restricted branch/i);
  await push(pilot.repo, ['restricted'], member.github_username);
  assert.equal((await branchJoinLink(admin, pilotBranch.id)).path, `/join/#${pilotBranch.id}`);
  assert.equal((await joinShadow(member, pilotBranch.id)).branch, 'restricted');
  await assert.rejects(() => joinShadow(outsider, pilotBranch.id), /shadow unavailable/);
  await clone('parent', member.github_username, true);
  await clone('parent', outsider.github_username, true);
  await clone(pilot.repo, member.github_username, true, 'restricted');
  await clone(pilot.repo, outsider.github_username, false, 'restricted');
  await measure('ordinary-member revocation', 1, 1, async () => {
    const w = await updateWorkspace(admin, pilot.id, {allow: [adminLogin]});
    assert.equal(w.status, 'ready', w.issue);
    assert.ok(w.events.some((e: {action: string}) => e.action === 'MEMBER_ACCESS_REMOVED'));
    await assert.rejects(() => joinShadow(member, pilotBranch.id), /shadow unavailable/);
    await clone(pilot.repo, member.github_username, false, 'restricted');
    await clone('parent', member.github_username, true);
  });

  const fault = await create('provider-failure', [member.github_username]);
  const faultBranch = await workspaceBranch(admin, repoId, fault.id, 'outage-restricted');
  await push(fault.repo, [faultBranch.branch]);
  provider.stats.failDelete = true;
  try {
    await measure('provider rejects revoke (503)', 1, 1, async () => {
      const workspace = await updateWorkspace(admin, fault.id, {allow: [adminLogin]});
      assert.equal(workspace.status, 'blocked');
      await assert.rejects(() => joinShadow(member, faultBranch.id), /verification pending/);
      await clone(fault.repo, member.github_username, true, faultBranch.branch);
    });
  } finally {
    provider.stats.failDelete = false;
  }
  await db.query('UPDATE workspaces SET retry_after = now() WHERE id = $1', [fault.id]);
  await measure('retry after provider recovers', 1, 1, async () => {
    await drainWorkspaceReconciliation();
    assert.equal((await workspaceInfo(admin, fault.id)).status, 'ready');
    await assert.rejects(() => joinShadow(member, faultBranch.id), /shadow unavailable/);
    await clone(fault.repo, member.github_username, false, faultBranch.branch);
    await clone('parent', member.github_username, true);
  });
  if (fleet) {
    type Tenant = {owner: string; workspaces: {id: string; repo: string; parentRepo: string; parentId: string}[]};
    const tenants: Tenant[] = Array.from({length: 200}, (_, i) => ({owner: `tenant-${i}`, workspaces: []}));
    await measure('onboard 200 organizations and accept memberships', tenants.length, 8,
      i => provider.seedOrg(tenants[i]!.owner, seeded.users));
    const parents = tenants.flatMap((tenant, i) => Array.from({length: i === 0 ? 101 : 1}, (_, index) =>
      ({tenant, parentRepo: `parent-${index}`})));
    await measure('enroll 300 parents and provision 300 companion repositories', parents.length, 8, async i => {
      const {tenant, parentRepo} = parents[i]!;
      const {owner} = tenant;
      const gitParent = await provider.api<{id: number}>(`/orgs/${owner}/repos`, 'POST',
        {name: parentRepo, private: true, auto_init: false, default_branch: 'main'});
      for (const user of seeded.users.slice(0, 2)) {
        await provider.api(`/repos/${owner}/${parentRepo}/collaborators/${user.login}`, 'PUT', {permission: 'read'});
      }
      const {rows: [record]} = await db.query(`INSERT INTO repos
        (github_repo_id,org_name,repo_name,installation_id,approved_policy,baseline_sha)
        VALUES($1,$2,$3,1,$4,$5) RETURNING id`, [gitParent.id, owner, parentRepo, policy, publicSha]);
      const workspace = await createWorkspace(admin, record.id, {name: 'private', allow: [adminLogin, member.github_username]});
      assert.equal(workspace.status, 'ready', `${workspace.issue} (${provider.stats.lastError})`);
      tenant.workspaces.push({id: workspace.id, repo: workspace.repo_name, parentRepo, parentId: record.id});
    });
    const samples = tenants.filter((_, i) => [0, 1, 2, 100, 199].includes(i)).map(tenant => ({tenant, w: tenant.workspaces[0]!}));
    const joins: string[] = [];
    await measure('sample ordinary users joining, pushing, and cloning across tenants', samples.length, 4, async i => {
      const {tenant: {owner}, w} = samples[i]!;
      await git(['-C', source, 'push', '--quiet', remote(w.parentRepo, owner), `${publicSha}:refs/heads/main`], adminLogin, adminPassword);
      const branch = await workspaceBranch(admin, w.parentId, w.id, 'restricted');
      await push(w.repo, ['restricted'], member.github_username, owner);
      joins[i] = branch.id;
      assert.equal((await joinShadow(member, branch.id)).branch, 'restricted');
      await assert.rejects(() => joinShadow(outsider, branch.id), /shadow unavailable/);
      await clone(w.repo, member.github_username, true, 'restricted', owner);
      await clone(w.repo, outsider.github_username, false, 'restricted', owner);
      await clone(w.parentRepo, outsider.github_username, true, 'main', owner);
    });
    const {tenant: {owner}, w} = samples[4]!;
    await measure('temporary project role grant and removal in unaffected tenant', 1, 1, async () => {
      assert.equal((await updateWorkspace(admin, w.id, {allow: [adminLogin, member.github_username, outsider.github_username]})).status, 'ready');
      assert.equal((await joinShadow(outsider, joins[4]!)).branch, 'restricted');
      await clone(w.repo, outsider.github_username, true, 'restricted', owner);
      assert.equal((await updateWorkspace(admin, w.id, {allow: [adminLogin, member.github_username]})).status, 'ready');
      await assert.rejects(() => joinShadow(outsider, joins[4]!), /shadow unavailable/);
      await clone(w.repo, outsider.github_username, false, 'restricted', owner);
    });
    await db.query("UPDATE workspaces SET retry_after='infinity'");
    await db.query(`UPDATE workspaces SET retry_after=now() WHERE parent_repo_id IN
      (SELECT id FROM repos WHERE org_name LIKE 'tenant-%')`);
    let claimed = 0;
    await measure('scheduled multi-tenant verification for 300 workspaces', 1, 1, async () => {
      let tick = performance.now() + 2000;
      while (claimed < parents.length) {
        await delay(Math.max(0, tick - performance.now()));
        const count = await drainWorkspaceReconciliation();
        assert.ok(count > 0);
        claimed += count;
        do { tick += 2000; } while (tick < performance.now());
      }
      assert.equal(claimed, parents.length);
      const {rows: [result]} = await db.query(`SELECT count(*)::int AS total FROM workspaces w
        JOIN repos r ON r.id=w.parent_repo_id WHERE r.org_name LIKE 'tenant-%' AND w.status='ready'`);
      assert.equal(result.total, parents.length);
    });
    await measure('offboard in a single 101-repository organization', 1, 1,
      () => revokeWorkspaceAccess(member.github_id, tenants[0]!.owner));
    await assert.rejects(() => joinShadow(member, joins[0]!), /shadow unavailable/);
    assert.equal((await joinShadow(member, joins[1]!)).branch, 'restricted');
    await clone(samples[0]!.w.repo, member.github_username, false, 'restricted', tenants[0]!.owner);
    provider.stats.failOrg = tenants[1]!.owner;
    provider.stats.delayMs = 40;
    try {
      await measure('40 ms provider latency and isolated 503 across 198 organization offboardings', 198, 8, async i => {
        const tenant = tenants[i + 1]!;
        const revoke = () => revokeWorkspaceAccess(member.github_id, tenant.owner);
        if (i === 0) await assert.rejects(revoke, /require retry/);
        else await revoke();
      });
    } finally {
      provider.stats.failOrg = '';
      provider.stats.delayMs = 0;
    }
    assert.equal((await workspaceInfo(admin, samples[1]!.w.id)).status, 'blocked');
    await assert.rejects(() => joinShadow(member, joins[1]!), /verification pending/);
    await clone(samples[1]!.w.repo, member.github_username, true, 'restricted', tenants[1]!.owner);
    assert.equal((await joinShadow(member, joins[4]!)).branch, 'restricted');
    await db.query('UPDATE workspaces SET retry_after=now() WHERE id=$1', [samples[1]!.w.id]);
    await measure('recover isolated tenant with durable reconciliation', 1, 1, () => drainWorkspaceReconciliation());
    for (const [i, {tenant: {owner}, w}] of samples.entries()) {
      await clone(w.repo, member.github_username, i === 4, 'restricted', owner);
      await clone(w.parentRepo, member.github_username, true, 'main', owner);
    }
    const {rows: [access]} = await db.query(`SELECT count(*)::int AS total FROM workspaces w JOIN repos r
      ON r.id=w.parent_repo_id WHERE r.org_name LIKE 'tenant-%' AND w.allowed_ids @> $1::jsonb`, [JSON.stringify([member.github_id])]);
    assert.equal(access.total, 1);
  } else if (!smoke) {
    const shared = await create('shared', [member.github_username]);
    const branches: Awaited<ReturnType<typeof workspaceBranch>>[] = [];
    for (const count of [30, 300]) {
      const offset = branches.length;
      await measure(`register shared branches (${count})`, count, 12, async i => {
        branches[offset + i] = await workspaceBranch(admin, repoId, shared.id, `restricted-${offset + i}`);
      });
      await measure(`push ${count} refs and wait for visibility`, 1, 1,
        () => push(shared.repo, branches.slice(offset).map(b => b.branch)));
    }
    for (const concurrency of [1, 8, 32]) {
      await measure('authorized join', 120, concurrency, async i => {
        const branch = branches[i * 2]!;
        assert.equal((await joinShadow(member, branch.id)).branch, branch.branch);
      });
    }
    await measure('mixed real Git clones', 48, 12, i => clone(shared.repo,
      i % 2 ? member.github_username : outsider.github_username, Boolean(i % 2), branches[i * 2]!.branch));
    provider.stats.delayMs = 40;
    try {
      await measure('authorized join with 40 ms per provider call', 120, 16, async i => {
        const branch = branches[i * 2]!;
        assert.equal((await joinShadow(member, branch.id)).branch, branch.branch);
      });
      await measure('wide audience (24 members, 40 ms per provider call)', 1, 1,
        () => create('wide-audience', seeded.users.filter(u => u.id !== bulkMember.github_id).map(u => u.login)));
    } finally {
      provider.stats.delayMs = 0;
    }
    await measure('revoke one shared workspace (330 branches)', 1, 1, async () => {
      assert.equal((await updateWorkspace(admin, shared.id, {allow: [adminLogin]})).status, 'ready');
      await clone(shared.repo, member.github_username, false, branches[0]!.branch);
      await clone(shared.repo, member.github_username, false, branches.at(-1)!.branch);
    });
    await measure('evaluate all 330 joins after shared-workspace revocation', branches.length, 32,
      i => assert.rejects(() => joinShadow(member, branches[i]!.id), /shadow unavailable/));
    const population: Awaited<ReturnType<typeof create>>[] = [];
    for (const count of large ? [12, 48, 240] : [12, 48]) {
      const offset = population.length;
      await measure(`provision distinct workspaces (${count})`, count, 8, async i => {
        const index = offset + i;
        population[index] = await create(`isolated-${index}`, [bulkMember.github_username]);
      });
    }
    await db.query("UPDATE workspaces SET retry_after = 'infinity'");
    const ids = population.map(w => w.id);
    await db.query('UPDATE workspaces SET retry_after = now() WHERE id = ANY($1::bigint[])', [ids]);
    await measure('bounded reconciliation batch (4 workspaces)', Math.ceil(ids.length / 4), 1,
      () => drainWorkspaceReconciliation(1));
    const {rows: [queue]} = await db.query(
      "SELECT count(*)::int AS total FROM workspaces WHERE id=ANY($1::bigint[]) AND status='ready' AND retry_after > now()", [ids]);
    assert.equal(queue.total, ids.length);
    if (cadence) {
      const sample = ids.slice(0, 60);
      await db.query('UPDATE workspaces SET retry_after = now() WHERE id = ANY($1::bigint[])', [sample]);
      await measure('reconciliation on two-second worker cadence (60 workspaces)', 1, 1, async () => {
        for (let processed = 0, nextTick = performance.now() + 2000; processed < sample.length;) {
          await delay(Math.max(0, nextTick - performance.now()));
          const count = await drainWorkspaceReconciliation();
          assert.ok(count > 0);
          processed += count;
          nextTick += 2000;
          if (nextTick < performance.now()) nextTick += 2000;
        }
        const {rows: [due]} = await db.query(
          `SELECT count(*)::int AS total FROM workspaces
           WHERE id=ANY($1::bigint[]) AND (retry_after<=now() OR status<>'ready')`, [sample]);
        assert.equal(due.total, 0);
      });
    }
    const samples = [population[0]!, population[Math.floor(population.length / 2)]!, population.at(-1)!];
    for (const w of samples) {
      await push(w.repo, ['restricted']);
      await clone(w.repo, bulkMember.github_username, true, 'restricted');
    }
    await measure(`offboard member across ${ids.length} workspaces`, 1, 1,
      () => revokeWorkspaceAccess(bulkMember.github_id, org));
    const {rows: [remaining]} = await db.query(
      "SELECT count(*)::int AS total FROM workspaces WHERE id=ANY($1::bigint[]) AND status='ready' AND NOT (allowed_ids @> $2::jsonb)",
      [ids, JSON.stringify([bulkMember.github_id])]);
    assert.equal(remaining.total, ids.length);
    for (const w of samples) await clone(w.repo, bulkMember.github_username, false, 'restricted');
    await clone('parent', bulkMember.github_username, true);
  }
} finally {
  await db.end();
  await rm(root, {force: true, recursive: true});
}
