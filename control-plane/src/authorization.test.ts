import assert from 'node:assert/strict';
import { test } from 'node:test';

// Authorization contracts against benign in-memory stand-ins for Postgres and GitHub.
Object.assign(process.env, { GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: 'test', GITHUB_WEBHOOK_SECRET: 'test' });
const { app, db, access, repositoryPermission } = await import('./service.js');
const { joinShadow, authorizePublish } = await import('./shadow.js');
const { enqueueOffboarding } = await import('./offboarding.js');

const legitimate = {
  installationAvailable: true,
  group: true,
  teamId: '101' as string | null,
  knownUser: true,
  repositoryId: 500,
  ownerId: 70,
  login: 'member',
  permission: 'read',
  permissionAccount: 42 as number | undefined,
  membership: 'active',
  shadowId: 600,
  shadowPrivate: true,
  shadowAllowed: [42],
  basePermission: 'none',
  teams: [] as object[],
  collaborators: [{ id: 42, permissions: { admin: false } }] as object[],
};
let world = { ...legitimate };
const written: string[] = [];
const repository = { id: '1', github_repo_id: '500', org_name: 'acme', repo_name: 'repo', installation_id: '10' };
const shadow = () => ({
  id: '3', parent_repo_id: '1', workspace_id: '1', github_repo_id: null, repo_name: 'companion', branch_name: 'restricted',
  allowed_ids: world.shadowAllowed, status: 'ready',
});
const workspace = () => ({
  id: '1', parent_repo_id: '1', github_repo_id: '600', repo_name: 'companion',
  org_name: 'acme', parent_name: 'repo', installation_id: '10', parent_github_repo_id: '500',
  allowed_ids: world.shadowAllowed, revoked_ids: [], status: 'ready', archive_requested: false,
  checked_at: new Date(),
});

db.query = (async (sql: string) => {
  if (!/^\s*SELECT/.test(sql)) { written.push(sql); return { rows: [], rowCount: 0 }; }
  if (sql.includes('FROM groups g JOIN repos')) {
    return { rows: world.group ? [{ ...repository, id: '7', repo_id: '1', name: 'github-team:infra', github_team_id: world.teamId }] : [] };
  }
  if (sql.includes('FROM users')) return { rows: world.knownUser ? [{ github_id: '42', github_username: 'stale-login' }] : [] };
  if (sql.includes('FROM workspaces w JOIN repos r')) return { rows: [workspace()] };
  if (sql.includes('FROM shadow_repos s JOIN repos')) {
    return { rows: [{ ...shadow(), org_name: 'acme', parent_name: 'repo', installation_id: '10', baseline_sha: 'a'.repeat(40), parent_github_repo_id: '500' }] };
  }
  if (sql.includes('FROM shadow_repos')) return { rows: [shadow()] };
  if (sql.includes('FROM repos')) return { rows: [repository] };
  assert.fail('Unexpected query ' + sql);
}) as unknown as typeof db.query;

const listTeams = () => {};
const listCollaborators = () => {};
app.getInstallationOctokit = (async (installation: number) => {
  assert.equal(installation, 10);
  if (!world.installationAvailable) throw Object.assign(new Error('installation unavailable'), { status: 404 });
  return {
    request: async (route: string, parameters: Record<string, unknown>) => {
      if (route === 'GET /user/{account_id}') {
        assert.equal(parameters.account_id, 42);
        return { data: { login: world.login } };
      }
      assert.equal(route, 'GET /organizations/{org_id}/team/{team_id}/memberships/{username}');
      assert.deepEqual(parameters, { org_id: 70, team_id: 101, username: 'member' });
      return { data: { state: world.membership } };
    },
    paginate: async (method: unknown) => method === listTeams ? world.teams : world.collaborators,
    rest: {
      git: {
        getRef: async () => ({ data: { ref: 'refs/heads/restricted' } }),
      },
      orgs: {
        get: async () => ({ data: { default_repository_permission: world.basePermission } }),
        checkMembershipForUser: async () => ({ status: 204 }),
      },
      repos: {
        listTeams,
        listCollaborators,
        get: async ({ owner, repo }: { owner: string; repo: string }) => {
          assert.equal(owner, 'acme');
          if (repo === 'repo') return { data: { id: world.repositoryId, owner: { id: world.ownerId } } };
          assert.equal(repo, 'companion');
          return { data: { id: world.shadowId, private: world.shadowPrivate, fork: false, allow_forking: false } };
        },
        getCollaboratorPermissionLevel: async ({ owner, repo, username }: Record<string, string>) => {
          assert.deepEqual({ owner, repo, username }, { owner: 'acme', repo: 'repo', username: 'member' });
          return { data: { permission: world.permission, user: world.permissionAccount === undefined ? null : { id: world.permissionAccount } } };
        },
      },
    },
  };
}) as unknown as typeof app.getInstallationOctokit;

const account = { id: '9', github_id: '42', github_username: 'member' };
const actions = {
  member: () => access('9', '7'),
  administrator: () => access('9', '7', true),
  permission: () => repositoryPermission(repository, 42, 'member'),
  join: () => joinShadow(account, '3'),
  publish: () => authorizePublish(account, '3'),
};
type Action = keyof typeof actions;
const all = Object.keys(actions) as Action[];

async function denied(change: Partial<typeof legitimate>, affected: Action[]) {
  for (const action of affected) {
    world = { ...legitimate, permission: action === 'member' || action === 'join' ? 'read' : 'admin', ...change };
    await assert.rejects(actions[action], action + ' must reject ' + JSON.stringify(change));
  }
}

test('legitimate members and administrators remain authorized', async () => {
  world = { ...legitimate };
  assert.equal((await actions.member()).id, '7');
  assert.equal((await actions.join()).branch, 'restricted');
  await assert.rejects(actions.administrator);
  await assert.rejects(actions.publish);
  world = { ...legitimate, permission: 'admin' };
  assert.equal((await actions.administrator()).id, '7');
  assert.equal((await actions.permission()).permission, 'admin');
  assert.equal((await actions.publish()).shadow.id, '3');
});

test('authorization fails closed when a binding or provider answer does not match', async () => {
  // The stored name now designates another repository, or another owner's installation answers.
  await denied({ repositoryId: 501 }, all);
  await denied({ ownerId: 0 }, all);
  await denied({ installationAvailable: false }, all);
  // The permission answer describes a different or unidentified account.
  await denied({ permissionAccount: 43 }, all);
  await denied({ permissionAccount: undefined }, all);
  // Insufficient or unrecognized repository roles.
  await denied({ permission: 'none' }, all.filter(action => action !== 'permission'));
  await denied({ permission: 'write' }, ['administrator', 'publish']);
  await denied({ permission: 'unrecognized' }, ['member', 'administrator', 'join', 'publish']);
  // Unknown subjects and objects.
  await denied({ group: false }, ['member', 'administrator']);
  await denied({ knownUser: false }, ['member', 'administrator']);
  await denied({ login: '' }, ['member', 'administrator']);
  // Team membership must be active on the group's immutable team.
  await denied({ membership: 'pending' }, ['member']);
  await denied({ teamId: null }, ['member']);
  // Companion repositories keep their immutable identity, allow-list and privacy.
  await denied({ shadowId: 601 }, ['join', 'publish']);
  await denied({ shadowPrivate: false }, ['join', 'publish']);
  await denied({ shadowAllowed: [43] }, ['join', 'publish']);
  await denied({ basePermission: 'read' }, ['join', 'publish']);
  await denied({ teams: [{ id: 1 }] }, ['publish']);
  await denied({ collaborators: [{ id: 44, permissions: { admin: false } }] }, ['publish']);
  assert.deepEqual(written, []);
});

test('repository administration does not confer group membership', async () => {
  world = { ...legitimate, permission: 'admin', membership: 'pending' };
  await assert.rejects(actions.member);
});

test('offboarding intake ignores deliveries without a bound installation', async () => {
  const event = { action: 'removed', organization: { login: 'acme' }, team: { id: 101 }, member: { id: 42 } };
  for (const installation of [undefined, {}, { id: 0 }, { id: '10' }]) {
    await enqueueOffboarding('delivery', 'membership', { ...event, installation });
  }
  assert.deepEqual(written, []);
  await enqueueOffboarding('delivery', 'membership', { ...event, installation: { id: 10 } });
  assert.equal(written.length, 1);
});
