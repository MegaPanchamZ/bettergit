import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {forgejoFixture} from './provider.js';

type Fixture = ReturnType<typeof forgejoFixture>;
type Account = {id: number; login: string};

export function realisticProvider(provider: Fixture, forgejoUrl: string) {
  const nativeFetch = globalThis.fetch;
  const installations = new Map<string, number>();
  const accounts = new Map<string, Account>();
  const unsupported: string[] = [];
  const traffic = new Map<number, {mixedCalls: number; quotaLimited: number; faultLimited: number; window: number; used: number}>();
  let mixed = false;
  let fault: {owner: string; repo: string; waitMs: number} | undefined;
  let quotaProbe: number | undefined;
  const operationMs: number[] = [];
  const budget = Number(process.env.BENCH_INSTALLATION_REQUESTS_PER_MINUTE ?? 600);
  assert.ok(Number.isSafeInteger(budget) && budget >= 1, 'set a positive per-minute installation budget');
  const clientId = 'fixture-client';
  const clientSecret = 'fixture-secret';
  const appPermissions = {administration: 'write', organization_administration: 'read', members: 'read', contents: 'read'};
  const installationId = (org: string) => {
    const id = installations.get(org);
    assert.ok(id, `no fixture installation for ${org}`);
    return id;
  };

  async function invoke(id: number, method: string, fn: (...args: any[]) => any, args: any[]) {
    if (!mixed) return fn(...args);
    const start = performance.now();
    const stats = traffic.get(id) ?? {mixedCalls: 0, quotaLimited: 0, faultLimited: 0, window: start, used: 0};
    traffic.set(id, stats);
    const admitted = ++stats.mixedCalls;
    const windowMs = quotaProbe === id ? 2_000 : 60_000;
    if (start - stats.window >= windowMs) {
      stats.used = 0;
      stats.window = start;
    }
    const exhausted = ++stats.used > (quotaProbe === id ? 6 : budget);
    // Deterministic jitter with a long-tail sample every 23rd logical call.
    await delay(admitted % 23 === 0 ? 220 : 12 + ((admitted * 29 + id) % 58));
    try {
      const injected = method === 'removeCollaborator' && fault?.owner === args[0]?.owner &&
        fault?.repo === args[0]?.repo ? fault : undefined;
      if (injected) await delay(injected.waitMs);
      if (exhausted || injected) {
        if (exhausted) stats.quotaLimited++;
        else stats.faultLimited++;
        throw Object.assign(new Error('fixture installation throttled'), {status: 429,
          response: {headers: {'retry-after': String(Math.max(1, Math.ceil((stats.window + windowMs - start) / 1000)))}}});
      }
      return await fn(...args);
    } finally {
      operationMs.push(performance.now() - start);
    }
  }

  function installationClient(id: number) {
    assert.ok([...installations.values()].includes(id));
    const rest = Object.fromEntries(Object.entries(provider.gh.rest).map(([name, group]) =>
      [name, Object.fromEntries(Object.entries(group).map(([method, fn]) =>
        [method, (...args: any[]) => invoke(id, method, fn, args)]))]));
    return {...provider.gh, rest,
      request: (...args: Parameters<Fixture['gh']['request']>) => invoke(id, 'request', provider.gh.request, args)};
  }

  // Fake the GitHub account/install side of OAuth at the HTTP boundary. All Git
  // traffic and permission changes go to the disposable Forgejo instance.
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    const url = new URL(request.url);
    if (url.origin === forgejoUrl || (url.hostname === '127.0.0.1' && url.origin === serverOrigin)) {
      return nativeFetch(input, options);
    }
    if (url.origin === 'https://api.github.com') {
      if (url.pathname === `/applications/${clientId}/token` && request.method === 'POST') {
        const {access_token} = await request.json() as {access_token: string};
        const account = accounts.get(access_token);
        return account ? Response.json({app: {client_id: clientId}, user: account}) : Response.json({}, {status: 404});
      }
      const repo = url.pathname.match(/^\/repos\/([a-z0-9-]+)\/([a-z0-9-]+)$/);
      const account = accounts.get(request.headers.get('authorization')?.split(' ')[1] ?? '');
      if (repo && account && request.method === 'GET') {
        const owner = repo[1]!;
        const name = repo[2]!;
        try {
          const result = {
            ...await provider.api(`/repos/${owner}/${name}`),
            permissions: await provider.permission({owner, repo: name}, account.login).then(role =>
              ({admin: role === 'admin', pull: role !== 'none'})),
          };
          if (!result.permissions.pull) return Response.json({}, {status: 404});
          return Response.json(result);
        } catch (error) {
          return Response.json({}, {status: (error as {status?: number}).status ?? 500});
        }
      }
    }
    unsupported.push(`${request.method} ${url.origin}${url.pathname}`);
    throw new Error('unexpected fixture network request');
  };
  let serverOrigin: string;
  return {clientId, clientSecret, unsupported, operationMs, traffic, budget, installationClient,
    install(org: string) {installations.set(org, installations.size + 1);},
    issueToken(account: Account) {
      const token = `ghu_fixture${account.id}`;
      accounts.set(token, account);
      return token;
    },
    installation(org: string) {return {data: {id: installationId(org), permissions: appPermissions}};},
    startTraffic() {mixed = true;},
    setServer(origin: string) {serverOrigin = origin;},
    throttleRemoval(owner: string, repo: string) {fault = {owner, repo, waitMs: 200};},
    restoreRemoval() {fault = undefined;},
    startQuotaProbe(org: string) {
      quotaProbe = installationId(org);
      traffic.delete(quotaProbe);
    },
    stopQuotaProbe() {quotaProbe = undefined;},
    close() {globalThis.fetch = nativeFetch;},
  };
}
