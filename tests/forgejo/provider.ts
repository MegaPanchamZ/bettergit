import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

type Target = {owner: string; repo: string};
type User = {id: number; login: string};

class ProviderError extends Error {
  constructor(readonly status: number, method: string, path: string) {
    super(`Forgejo ${method} ${path} returned ${status}`);
  }
}

export function forgejoFixture(url: string, token: string) {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const identities = new Map<number, string>();
  const failures = new Map<string, number>();
  const stats = {calls: 0, active: 0, peak: 0, delayMs: 0, failOrg: "", failDelete: false, lastError: ''};
  const repoPath = ({owner, repo}: Target) => `/repos/${owner}/${repo}`;
  async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
    stats.calls++;
    stats.peak = Math.max(stats.peak, ++stats.active);
    try {
      if (stats.delayMs) await delay(stats.delayMs);
      if ((stats.failDelete || (stats.failOrg && path.startsWith(`/repos/${stats.failOrg}/`))) && method === 'DELETE' && path.includes('/collaborators/')) {
        throw new ProviderError(503, method, path);
      }
      const response = await fetch(`${url}/api/v1${path}`, {
        method, body: body === undefined ? undefined : JSON.stringify(body),
        headers: {Authorization: `token ${token}`, 'Content-Type': 'application/json'},
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new ProviderError(response.status, method, path);
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (error) {
      const key = error instanceof ProviderError ? String(error.status) : 'transport';
      failures.set(key, (failures.get(key) ?? 0) + 1);
      stats.lastError = String(error);
      throw error;
    } finally {
      stats.active--;
    }
  }
  async function list<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    for (let page = 1; ; page++) {
      const entries = await api<T[]>(`${path}?limit=50&page=${page}`);
      results.push(...entries);
      if (entries.length < 50) return results;
    }
  }
  async function permission(target: Target, username: string): Promise<string> {
    try {
      const result = await api<{permission: string}>(`${repoPath(target)}/collaborators/${username}/permission`);
      assert.ok(['none', 'read', 'write', 'admin', 'owner'].includes(result.permission));
      return result.permission === 'owner' ? 'admin' : result.permission;
    } catch (error) {
      if (!(error instanceof ProviderError && error.status === 404)) throw error;
      // Distinguish missing permission from a missing repository.
      await api(repoPath(target));
      assert.ok([...identities.values()].includes(username));
      return 'none';
    }
  }
  const data = <T>(value: T) => ({data: value});
  const listCollaborators = async (target: Target & {affiliation?: string}) => {
    const users = await list<User>(`${repoPath(target)}/collaborators`);
    return Promise.all(users.map(async user => {
      const role = await permission(target, user.login);
      return {...user, permissions: {push: role === 'write' || role === 'admin', admin: role === 'admin'}};
    }));
  };
  const listTeams = async (target: Target) => {
    const teams = await list<{name: string}>(`${repoPath(target)}/teams`);
    return teams.filter(team => team.name !== 'Owners').map(team => ({slug: team.name}));
  };

  const orgBasePermissions = new Map<string, string>();
  const forkSettings = new Map<string, boolean>();
  const invitations = new Map<string, {id: number; invitee: User}[]>();
  const orgIds = new Map<string, number>();
  async function orgInfo(org: string) {
    const info = await api<{id: number}>(`/orgs/${org}`);
    orgIds.set(org.toLowerCase(), info.id);
    return info;
  }
  async function userIdByLogin(username: string): Promise<number> {
    for (const [id, login] of identities) if (login === username) return id;
    const u = await api<User>(`/users/${username}`);
    identities.set(u.id, u.login);
    return u.id;
  }
  async function teamByName(org: string, slug: string) {
    const teams = await list<{id: number; name: string}>(`/orgs/${org}/teams`);
    const team = teams.find(team => team.name.toLowerCase() === slug.toLowerCase());
    assert.ok(team, 'fixture team missing');
    const orgId = orgIds.get(org.toLowerCase()) ?? (await orgInfo(org)).id;
    return {...team, organization: {id: orgId}};
  }
  // Translate the subset of Octokit used by this harness. Forgejo has no
  // equivalent for some GitHub account and repository settings.
  const gh = {
    request: async (_route: string, {account_id}: {account_id: number}) => {
      const login = identities.get(Number(account_id));
      assert.ok(login, 'fixture user ID missing');
      return data(await api<User>(`/users/${login}`));
    },
    paginate: async <Args, Result>(method: (args: Args) => Promise<Result>, args: Args) => method(args),
    rest: {
      orgs: {
        get: async ({org}: {org: string}) => {
          await api(`/orgs/${org}`);
          return data({default_repository_permission: orgBasePermissions.get(org) ?? 'none'});
        },
        checkMembershipForUser: ({org, username}: {org: string; username: string}) =>
          api(`/orgs/${org}/members/${username}`),
        getMembershipForUser: async ({org, username}: {org: string; username: string}) => {
          const owners = await list<User>(`/teams/${ownerTeams.get(org)}/members`);
          return data({role: owners.some(user => user.login === username) ? 'admin' : 'member', state: 'active'});
        },
      },
      users: {getByUsername: async ({username}: {username: string}) => data(await api<User>(`/users/${username}`))},
      repos: {
        get: async (target: Target) => data({...await api(repoPath(target)),
          allow_forking: forkSettings.get(repoPath(target)) ?? false}),
        getCommit: async (target: Target & {ref: string}) => {
          const path = repoPath(target);
          const ref = encodeURIComponent(target.ref);
          const sha = /^[a-f0-9]{40}$/.test(ref) ? ref :
            (await api<{commit: {id: string}}>(`${path}/branches/${ref}`)).commit.id;
          return data(await api(`${path}/git/commits/${sha}`));
        },
        getContent: async (target: Target & {path: string; ref: string}) =>
          data(await api(`${repoPath(target)}/contents/${target.path}?ref=${encodeURIComponent(target.ref)}`)),
        createInOrg: async ({org, ...properties}: {org: string; name: string}) =>
          data(await api(`/orgs/${org}/repos`, 'POST', {...properties, default_branch: 'main'})),
        getCollaboratorPermissionLevel: async ({username, ...target}: Target & {username: string}) =>
          data({permission: await permission(target, username), user: {id: await userIdByLogin(username)}}),
        listTeams, listCollaborators,
        listInvitations: async (target: Target) => invitations.get(repoPath(target)) ?? [],
        deleteInvitation: async (target: Target & {invitation_id: number}) => {
          const key = repoPath(target);
          invitations.set(key, (invitations.get(key) ?? []).filter(invite => invite.id !== target.invitation_id));
        },
        addCollaborator: async ({username, permission: role, ...target}: Target & {username: string; permission: string}) => {
          const path = repoPath(target);
          if (invitations.get(path)?.some(invite => invite.invitee.login === username)) return;
          return api(`${path}/collaborators/${username}`, 'PUT', {permission: role === 'push' ? 'write' : role});
        },
        removeCollaborator: ({username, ...target}: Target & {username: string}) =>
          api(`${repoPath(target)}/collaborators/${username}`, 'DELETE'),
        update: async (target: Target & {archived?: boolean; allow_forking?: boolean}) => {
          const key = repoPath(target);
          if (target.allow_forking !== undefined) forkSettings.set(key, target.allow_forking);
          const repo = await api(key, target.archived === undefined ? 'GET' : 'PATCH',
            target.archived === undefined ? undefined : {archived: target.archived});
          return data({...repo, allow_forking: forkSettings.get(key) ?? false});
        },
      },
      teams: {
        getByName: async ({org, team_slug}: {org: string; team_slug: string}) => data(await teamByName(org, team_slug)),
        listMembersInOrg: async ({org, team_slug}: {org: string; team_slug: string}) =>
          list<User>(`/teams/${(await teamByName(org, team_slug)).id}/members`),
        removeRepoInOrg: ({team_slug, ...target}: Target & {team_slug: string}) =>
          api(`${repoPath(target)}/teams/${team_slug}`, 'DELETE'),
      },
      git: {getRef: ({ref, ...target}: Target & {ref: string}) => api(`${repoPath(target)}/branches/${ref.replace(/^heads\//, '')}`)},
    },
  };
  const ownerTeams = new Map<string, number>();
  async function seedOrg(org: string, users: User[]) {
    await api('/orgs', 'POST', {username: org, visibility: 'private'});
    const teams = await list<{id: number; name: string}>(`/orgs/${org}/teams`);
    ownerTeams.set(org, teams.find(team => team.name === 'Owners')!.id);
    const roster = await api<{id: number}>(`/orgs/${org}/teams`, 'POST', {
      name: 'Roster', permission: 'read', includes_all_repositories: false, units_map: {'repo.code': 'read'},
    });
    for (const user of users) await api(`/teams/${roster.id}/members/${user.login}`, 'PUT');
  }
  async function seed(password: string, memberCount: number) {
    const admin = await api<User>('/user');
    identities.set(admin.id, admin.login);
    let users: User[] = [];
    for (let n = 0; n < memberCount; n++) {
      const username = `member-${n}`;
      const user = await api<User>('/admin/users', 'POST', {
        username, password, email: `${username}@example.test`, must_change_password: false,
      });
      identities.set(user.id, user.login);
      users.push(user);
    }
    await seedOrg('benchorg', users);
    return {admin, users};
  }
  return {api, gh, stats, failures, seed, seedOrg, permission, teamByName, orgBasePermissions, forkSettings, invitations};
}
