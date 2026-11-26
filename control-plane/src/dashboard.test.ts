import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { Pool } from 'pg';

test('dashboard and agent inventory share current GitHub access', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = 'test_' + randomBytes(8).toString('hex');
  const database = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('options', '-c search_path=' + schema);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    BETTERGIT_BINARY: process.env.BETTERGIT_BINARY ?? fileURLToPath(new URL('../../target/debug/bettergit', import.meta.url)),
    GITHUB_APP_ID: '1',
    GITHUB_PRIVATE_KEY: 'test',
    GITHUB_WEBHOOK_SECRET: 'test',
    GITHUB_CLIENT_ID: 'test-client',
    GITHUB_CLIENT_SECRET: 'test-secret',
  });
  const { app, db } = await import('./service.js');
  const { dashboardRequest } = await import('./dashboard.js');
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (!await dashboardRequest(req, res, path, Buffer.concat(chunks).toString())) res.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    await db.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    const { signer } = JSON.parse(await readFile(new URL('../../tests/signed-browser-fixture.json', import.meta.url), 'utf8'));
    const policy = `version: 1\norg: acme\nrules:\n  - path: config.env\n    mode: value\n    allow: [github-team:infra]\n    signing_key: ${signer}\n`;
    let head = 'b'.repeat(40);
    let installedId = 5;
    const content = { content: Buffer.from(policy).toString('base64') };
    app.octokit.rest.apps.getRepoInstallation = (async () => ({ data: { id: 10 } })) as unknown as typeof app.octokit.rest.apps.getRepoInstallation;
    app.getInstallationOctokit = (async () => ({
      rest: { repos: {
        get: async () => ({ data: { id: installedId } }),
        getCommit: async () => ({ data: { sha: head } }),
        getContent: async () => ({ data: content }),
      } },
    })) as unknown as typeof app.getInstallationOctokit;
    for (const [id, installation] of [[1, 10], [2, 10], [3, 11], [4, 12]]) {
      await db.query(
        'INSERT INTO repos(github_repo_id,org_name,repo_name,installation_id,approved_policy,baseline_sha) VALUES($1,$2,$3,$4,$5,$6)',
        [id, 'acme', 'stored-' + id, installation, policy, 'a'.repeat(40)],
      );
    }
    const repo = (id: number, pull = true) => ({
      id, owner: { login: 'acme' }, name: 'repo-' + id, default_branch: 'main', permissions: { pull, admin: id === 1 || id === 5 },
    });
    let visible = true;
    globalThis.fetch = async (input, init) => {
      const endpoint = new URL(String(input));
      if (endpoint.hostname === '127.0.0.1') return originalFetch(input, init);
      const json = (value: unknown, options?: ResponseInit) => {
        const response = Response.json(value, options);
        Object.defineProperty(response, 'url', { value: endpoint.href });
        return response;
      };
      switch (endpoint.pathname) {
        case '/login/device/code':
          return json({ device_code: 'synthetic', user_code: 'TEST-CODE', interval: 5, expires_in: 900 });
        case '/login/oauth/access_token':
          return json({ access_token: 'ghu_synthetic', expires_in: 3600 });
        case '/repos/acme/repo-5':
          return json(repo(5));
        case '/repos/acme/repo-5/commits/main':
          return json({ sha: head });
        case '/repos/acme/repo-5/contents/.access.yml':
          return json(content);
        case '/applications/test-client/token':
          assert.equal(JSON.parse(String(init?.body)).access_token, 'ghu_synthetic');
          return json({ app: { client_id: 'test-client' }, user: { id: 99, login: 'verified' } });
        case '/user/installations':
          return json({ total_count: 2, installations: [{ id: 10 }, { id: 11, suspended_at: '2026-01-01' }] });
        case '/user/installations/10/repositories':
          if (endpoint.searchParams.get('page') === '2') {
            return json({ total_count: 5, repositories: [repo(4), repo(5)] });
          }
          return json({ total_count: 5, repositories: [repo(1, visible), repo(2, false)] }, {
            headers: { Link: '<https://api.github.com/user/installations/10/repositories?page=2>; rel="next"' },
          });
        default:
          assert.fail('Unexpected GitHub endpoint ' + endpoint.pathname);
      }
    };
    const request = (path: string, options?: RequestInit) => fetch(`http://127.0.0.1:${address.port}/v1/${path}`, options);
    assert.equal((await request('inventory')).status, 401);
    assert.equal((await request('dashboard/start', { method: 'POST' })).status, 403);
    const start = await request('dashboard/start', { method: 'POST', headers: { 'X-BetterGit-Dashboard': '1' } });
    assert.deepEqual(await start.json(), { userCode: 'TEST-CODE' });
    const cookie = start.headers.get('set-cookie')!;
    assert.match(cookie, /^__Host-bettergit-dashboard=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict;/);
    const pending = await request('dashboard/poll', { method: 'POST', headers: {
      'X-BetterGit-Dashboard': '1', Cookie: cookie.split(';')[0]!,
    } });
    assert.equal(pending.status, 202);
    assert.equal((await request('inventory', { headers: { Cookie: cookie.split(';')[0]! } })).status, 401);

    Date.now = () => originalNow() + 6_000;
    const signedIn = await request('dashboard/poll', { method: 'POST', headers: {
      'X-BetterGit-Dashboard': '1', Cookie: cookie.split(';')[0]!,
    } });
    assert.deepEqual(await signedIn.json(), { signedIn: true });
    const activeCookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
    assert.notEqual(activeCookie, cookie.split(';')[0]);
    assert.equal((await request('inventory', { headers: { Cookie: activeCookie } })).status, 200);
    const action = (name: string, body: object) => request('dashboard/' + name, {
      method: 'POST',
      headers: { 'X-BetterGit-Dashboard': '1', Cookie: activeCookie },
      body: JSON.stringify(body),
    });

    const authorization = { Authorization: 'Bearer ghu_synthetic' };
    const result = await request('inventory', { headers: authorization });
    assert.equal(result.status, 200);
    const { account, repositories } = await result.json();
    assert.equal(account, 'verified');
    assert.deepEqual(repositories.map((value: { name: string }) => value.name), ['repo-1', 'repo-4', 'repo-5']);
    assert.equal(repositories[0].administrator, true);
    assert.deepEqual(repositories[0].enrollment.rules, [{ path: 'config.env', mode: 'value', groups: ['github-team:infra'], stub: null }]);
    assert.equal(repositories[1].enrollment, null);
    assert.equal(repositories[1].needsRelink, true);
    assert.equal(repositories[2].needsRelink, false);
    const target = { owner: 'acme', repo: 'repo-5' };
    assert.deepEqual(await (await action('prepare', target)).json(), { commit: head });
    const reviewedHead = head;
    head = 'c'.repeat(40);
    const moved = await action('enroll', { ...target, commit: reviewedHead });
    assert.equal(moved.status, 409);
    assert.deepEqual(await moved.json(), { error: 'default_branch_changed' });
    // The installation resolves the name to a different repository than the administrator approved.
    installedId = 6;
    assert.equal((await action('enroll', { ...target, commit: head })).status, 502);
    assert.equal((await db.query('SELECT 1 FROM repos WHERE github_repo_id IN (5,6)')).rowCount, 0);
    installedId = 5;
    assert.equal((await action('enroll', { ...target, commit: head })).status, 201);
    const enrolledAgain = await action('enroll', { ...target, commit: head });
    assert.equal(enrolledAgain.status, 409);
    assert.deepEqual(await enrolledAgain.json(), { error: 'repository_already_enrolled' });
    visible = false;
    const refreshed = await (await request('inventory', { headers: authorization })).json();
    assert.deepEqual(refreshed.repositories.map((value: { name: string }) => value.name), ['repo-4', 'repo-5']);
    assert.equal(refreshed.repositories[1].enrollment.baseline, head);
    assert.equal((await action('logout', {})).status, 200);
    assert.equal((await request('inventory', { headers: { Cookie: activeCookie } })).status, 401);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.end();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});
