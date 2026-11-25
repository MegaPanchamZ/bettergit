import {createWorkspace,listWorkspaces,workspaceInfo,updateWorkspace,reconcileWorkspace,archiveWorkspace} from './workspaces.js';
import {repoAdmin} from './shadow.js';
import {db} from './service.js';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { enrollRepository } from './enrollment.js';
import { repositoryInventory } from './inventory.js';
import { user } from './service.js';

const cookieName = '__Host-bettergit-dashboard';
const sessions = new Map<string, {
  expires: number;
  login?: { deviceCode: string; userCode: string; interval: number; nextPoll: number; polling: boolean };
  token?: string;
}>();
const sessionLifetime = 60 * 60;
const maxSessions = 1_000;
let starting = 0;

function reply(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
  return true;
}

function setCookie(res: ServerResponse, id: string, maxAge: number) {
  res.setHeader('Set-Cookie', `${cookieName}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
}

async function githubLogin(path: string, params: Record<string, string>) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) throw new Error('device flow unavailable');
  const response = await fetch(`https://github.com/login/${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, ...params }),
    signal: AbortSignal.timeout(8_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('device flow unavailable');
  return await response.json();
}

function retry(res: ServerResponse, nextPoll: number) {
  return reply(res, 202, { retryAfter: Math.max(1, Math.ceil((nextPoll - Date.now()) / 1_000)) });
}

export async function dashboardRequest(
  req: IncomingMessage, res: ServerResponse, path: string, body: string,
): Promise<boolean> {
  const browserPath = path.startsWith('/v1/dashboard/');
  const inventory = path === '/v1/inventory' && req.method === 'GET';
  if (!browserPath && !inventory) return false;

  const cookie = req.headers.cookie?.match(/(?:^|;\s*)__Host-bettergit-dashboard=([0-9a-f]{64})(?:;|$)/)?.[1];
  const stored = cookie ? sessions.get(cookie) : undefined;
  const session = stored && stored.expires > Date.now() ? stored : undefined;

  try {
    if (browserPath) {
      if (req.method !== 'POST') return reply(res, 405, { error: 'method_not_allowed' });
      if (req.headers['x-bettergit-dashboard'] !== '1') return reply(res, 403, { error: 'request_rejected' });

      if (path === '/v1/dashboard/start') {
        if (session?.token) return reply(res, 200, { signedIn: true });
        if (session?.login) return reply(res, 200, { userCode: session.login.userCode });
        for (const [id, entry] of sessions) {
          if (entry.expires <= Date.now()) sessions.delete(id);
        }
        if (sessions.size + starting >= maxSessions) return reply(res, 503, { error: 'sign_in_busy' });
        starting++;
        try {
          const data = await githubLogin('device/code', {});
          if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string'
            || !Number.isSafeInteger(data.expires_in) || data.expires_in <= 0
            || !Number.isSafeInteger(data.interval) || data.interval <= 0) {
            throw new Error('invalid device response');
          }
          const expiresIn = Math.min(data.expires_in, 900);
          const interval = Math.max(data.interval, 5);
          const now = Date.now();
          const id = randomBytes(32).toString('hex');
          sessions.set(id, {
            expires: now + expiresIn * 1_000,
            login: { deviceCode: data.device_code, userCode: data.user_code, interval, nextPoll: now + interval * 1_000, polling: false },
          });
          setCookie(res, id, expiresIn);
          return reply(res, 200, { userCode: data.user_code });
        } finally {
          starting--;
        }
      }

      if (path === '/v1/dashboard/logout') {
        if (cookie) sessions.delete(cookie);
        setCookie(res, '', 0);
        return reply(res, 200, { signedIn: false });
      }

      if (path === '/v1/dashboard/poll') {
        if (session?.token) return reply(res, 200, { signedIn: true });
        if (!session?.login || !cookie) return reply(res, 401, { error: 'sign_in_expired' });
        const login = session.login;
        if (login.polling || login.nextPoll > Date.now()) return retry(res, login.nextPoll);
        login.polling = true;
        try {
          const data = await githubLogin('oauth/access_token', {
            device_code: login.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          });
          if (sessions.get(cookie) !== session) return reply(res, 401, { error: 'sign_in_expired' });
          if (data.error === 'slow_down') {
            login.interval = Math.max(login.interval + 5, Number.isSafeInteger(data.interval) ? data.interval : 0);
          }
          login.nextPoll = Date.now() + login.interval * 1_000;
          if (data.error === 'authorization_pending' || data.error === 'slow_down') return retry(res, login.nextPoll);
          sessions.delete(cookie);
          if (typeof data.access_token !== 'string' || !/^ghu_[a-zA-Z0-9]+$/.test(data.access_token)) {
            setCookie(res, '', 0);
            return reply(res, 401, { error: 'sign_in_ended' });
          }
          const id = randomBytes(32).toString('hex');
          const lifetime = Number.isSafeInteger(data.expires_in) && data.expires_in > 0
            ? Math.min(sessionLifetime, data.expires_in) : sessionLifetime;
          sessions.set(id, { expires: Date.now() + lifetime * 1_000, token: data.access_token });
          setCookie(res, id, lifetime);
          return reply(res, 200, { signedIn: true });
        } finally {
          login.polling = false;
          login.nextPoll = Math.max(login.nextPoll, Date.now() + login.interval * 1_000);
        }
      }

      if (path !== '/v1/dashboard/prepare' && path !== '/v1/dashboard/enroll' && path !== '/v1/dashboard/workspaces') {
        return reply(res, 404, { error: 'not_found' });
      }
    }

    const token = inventory && req.headers.authorization !== undefined
      ? req.headers.authorization.match(/^Bearer (ghu_[a-zA-Z0-9]+)$/)?.[1] : session?.token;
    if (!token) return reply(res, 401, { error: 'sign_in_required' });
    let account: Awaited<ReturnType<typeof user>>;
    try {
      account = await user(token);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== undefined && ![401, 404].includes(status)) throw error;
      if (status === undefined && (!(error instanceof Error) || error.message !== 'unauthorized')) throw error;
      if (cookie && token === session?.token) {
        sessions.delete(cookie);
        setCookie(res, '', 0);
      }
      return reply(res, 401, { error: 'sign_in_required' });
    }
    if (inventory) {
      return reply(res, 200, { account: account.github_username, repositories: await repositoryInventory(account.github) });
    }

    if(path==='/v1/dashboard/workspaces') {
      const d=JSON.parse(body);
      if(typeof d.id!=='string' || !/^\d+$/.test(d.id))return reply(res,400,{error:'invalid_id'});
      switch(d.operation) {
        case 'list': return reply(res,200,await listWorkspaces(account,d.id));
        case 'groups': {
          await repoAdmin(account,d.id);
          return reply(res,200,(await db.query('SELECT id,name FROM groups WHERE repo_id=$1 AND github_team_id IS NOT NULL',[d.id])).rows);
        }
        case 'create': return reply(res,200,await createWorkspace(account,d.id,d.audience));
        case 'show': return reply(res,200,await workspaceInfo(account,d.id));
        case 'members': return reply(res,200,await updateWorkspace(account,d.id,d.audience));
        case 'reconcile': await workspaceInfo(account,d.id);await reconcileWorkspace(d.id);return reply(res,200,await workspaceInfo(account,d.id));
        case 'archive': return reply(res,200,await archiveWorkspace(account,d.id));
        default: return reply(res,400,{error:'invalid_operation'});
      }
    }
    const { owner, repo, commit } = JSON.parse(body);
    if (typeof owner !== 'string' || !/^[a-zA-Z0-9-]{1,39}$/.test(owner)
      || typeof repo !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo) || repo === '.' || repo === '..') {
      return reply(res, 400, { error: 'invalid_repository' });
    }
    if (path === '/v1/dashboard/prepare') {
      const { data: repository } = await account.github.rest.repos.get({ owner, repo });
      if (!repository.permissions?.admin) return reply(res, 403, { error: 'administrator_required' });
      const { data: head } = await account.github.rest.repos.getCommit({ owner, repo, ref: repository.default_branch });
      const { data: policy } = await account.github.rest.repos.getContent({ owner, repo, path: '.access.yml', ref: head.sha });
      if (Array.isArray(policy) || !('content' in policy)) return reply(res, 409, { error: 'policy_missing' });
      return reply(res, 200, { commit: head.sha });
    }
    if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
      return reply(res, 400, { error: 'invalid_commit' });
    }
    return reply(res, 201, await enrollRepository(account, owner, repo, commit));
  } catch (error) {
    if(path==='/v1/dashboard/workspaces' && error instanceof Error && error.message==='administrator required')return reply(res,403,{error:'administrator_required'});
    if (path === '/v1/dashboard/prepare' && (error as { status?: number }).status === 404) {
      return reply(res, 409, { error: 'policy_unavailable' });
    }
    if (path === '/v1/dashboard/enroll' && error instanceof Error && [
      'administrator required', 'default branch changed', 'policy missing', 'invalid policy', 'repository already enrolled',
    ].includes(error.message)) {
      return reply(res, 409, { error: error.message.replaceAll(' ', '_') });
    }
    return reply(res, 502, { error: 'request_unavailable' });
  }
}
