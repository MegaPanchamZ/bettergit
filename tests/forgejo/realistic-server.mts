import assert from 'node:assert/strict';
import {channel} from 'node:diagnostics_channel';
import {once} from 'node:events';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';

type ErrorInfo = {message: string; status?: number; response?: unknown};
const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
let next = 0;
function call(method: string, ...args: unknown[]): Promise<any> {
  const id = next++;
  const {promise, resolve, reject} = Promise.withResolvers();
  pending.set(id, {resolve, reject});
  process.send!({kind: 'call', id, method, args});
  return promise;
}

const {app, db} = await import('../../control-plane/src/service.js');
const groups = ['orgs', 'users', 'repos', 'teams', 'git'];
app.getInstallationOctokit = (async (installation: number) => ({
  rest: Object.fromEntries(groups.map(group => [group, new Proxy({}, {
    get: (_target, method: string) => (...args: unknown[]) => call('rest', installation, group, method, args),
  })])),
  paginate: (fn: (params: unknown) => unknown, params: unknown) => fn(params),
  request: (...args: unknown[]) => call('request', installation, args),
})) as unknown as typeof app.getInstallationOctokit;
app.octokit.rest.apps.getOrgInstallation = (async ({org}: {org: string}) => call('installation', org)) as
  typeof app.octokit.rest.apps.getOrgInstallation;
app.octokit.rest.apps.getRepoInstallation = (async ({owner}: {owner: string}) => call('installation', owner)) as unknown as
  typeof app.octokit.rest.apps.getRepoInstallation;
globalThis.fetch = async (input, options) => {
  const request = new Request(input, options);
  assert.equal(new URL(request.url).origin, 'https://api.github.com');
  const {status, body, headers} = await call('fetch', request.url, request.method,
    Object.fromEntries(request.headers), request.body ? await request.text() : undefined);
  return new Response(body, {status, headers});
};

channel('bettergit.workspace.join.failure').subscribe(data => {
  process.send!({kind: 'join-failure', data});
});
const {server} = await import('../../control-plane/src/server.js');
if (!server.listening) await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const loop = monitorEventLoopDelay({resolution: 10});
let cpu = process.cpuUsage();
let utilization = performance.eventLoopUtilization();
let peakRss = 0;
let poolWaiting = 0;
let sampler: NodeJS.Timeout | undefined;
process.on('message', async (message: {kind: string; id: number; result?: unknown; error?: ErrorInfo}) => {
  if (message.kind === 'reply') {
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler?.reject(Object.assign(new Error(message.error.message), message.error));
    else handler?.resolve(message.result);
  }
  if (message.kind === 'start') {
    cpu = process.cpuUsage();
    utilization = performance.eventLoopUtilization();
    loop.enable();
    sampler = setInterval(() => {
      poolWaiting = Math.max(poolWaiting, db.waitingCount);
      peakRss = Math.max(peakRss, process.memoryUsage.rss());
    }, 50);
    process.send!({kind: 'started'});
  }
  if (message.kind === 'sample') {
    clearInterval(sampler);
    loop.disable();
    const used = process.cpuUsage(cpu);
    process.send!({kind: 'metrics', data: {peakRssMiB: Math.round(peakRss / 2 ** 20),
      cpuMs: Math.round((used.user + used.system) / 1000), poolWaiting,
      loopP95Ms: Math.round(loop.percentile(95) / 1e6),
      loopUtilization: performance.eventLoopUtilization(utilization).utilization}});
  }
  if (message.kind === 'close') {
    clearInterval(sampler);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.end();
    process.disconnect!();
  }
});
process.send!({kind: 'listening', port: address.port});
