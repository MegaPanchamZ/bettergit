import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
test('guard checks merge ancestry, candidate identity and complete pagination',{skip:!process.env.TEST_DATABASE_URL},async()=>{
const moduleUrl = (path: string) => new URL('../../' + path, import.meta.url);
const { default: pg } = await import(moduleUrl('control-plane/node_modules/pg/esm/index.mjs').href);
const connection = process.env.TEST_DATABASE_URL;
assert(connection, 'Set TEST_DATABASE_URL to a disposable PostgreSQL instance');
const schema = 'audit_' + randomBytes(8).toString('hex');
const admin = new pg.Pool({ connectionString: connection });
await admin.query('CREATE SCHEMA ' + schema);
const scoped = new URL(connection);
scoped.searchParams.set('options', '-c search_path=' + schema);
Object.assign(process.env, {
  DATABASE_URL: scoped.toString(),
  GITHUB_APP_ID: '1',
  GITHUB_PRIVATE_KEY: 'test',
  GITHUB_WEBHOOK_SECRET: 'test',
  BETTERGIT_BINARY: process.env.BETTERGIT_BINARY ?? fileURLToPath(moduleUrl('target/debug/bettergit')),
});
const { app, db } = await import(moduleUrl('control-plane/src/service.ts').href);
const signed=JSON.parse(await readFile(moduleUrl('tests/signed-browser-fixture.json'),'utf8'));
const policy = `version: 1\norg: acme\nrules:\n- path: .env\n  mode: value\n  allow: [team]\n  signing_key: ${signed.signer}\n`;
const sha = (n: number) => n.toString(16).padStart(40, '0');
const base = sha(1), dirty = sha(2), head = sha(3), merge = sha(4), after = sha(5), last = sha(6), paged = sha(7), wrongSigner = sha(8), cleanMerge = sha(9), groupHead = sha(10);
const calls: string[] = [];
const checkedShas: string[] = [];
const conclusions: string[] = [];
const staleChecks = new Map<string,string>();
const outputs: string[] = [];
let pullReads = 0;
let pullBase=dirty;
let pullCandidate=merge;
let currentParents=true;
let advanceBaseDuringVerification=false;
(app as any).getInstallationOctokit = async () => ({
  paginate: async () => [{number:2},{number:1}],
  rest: {
    checks: {
      create: async (args: any) => {
        if(args.external_id) {
          assert.equal(args.conclusion,'action_required');
          staleChecks.set(args.head_sha,args.external_id);
          return {data:{id:0}};
        }
        checkedShas.push(args.head_sha + ' ' + args.name);
        if(args.status==='completed') conclusions.push(args.conclusion);
        return { data: { id: checkedShas.length } };
      },
      update: async (args: any) => {
        conclusions.push(args.conclusion);
        if(args.output) outputs.push(args.output.title);
      },
      listForRef: async ({ref}: {ref:string}) => ({data:{check_runs:[{external_id:staleChecks.get(ref)}]}}),
    },
    repos: {
      compareCommitsWithBasehead: async ({ basehead, page }: any) => {
        calls.push(basehead + ' p' + page);
        if (basehead.endsWith('...' + merge)) return {data:{total_commits:3,commits:[{sha:dirty},{sha:head},{sha:merge}]}};
        if (basehead.endsWith('...' + groupHead)) return {data:{total_commits:1,commits:[{sha:groupHead}]}};
        if (basehead.endsWith('...' + cleanMerge)) return {data:{total_commits:2,commits:[{sha:head},{sha:cleanMerge}]}};
        if (basehead.endsWith('...' + head)) return { data: { total_commits: 1, commits: [{ sha: head }] } };
        if (basehead.endsWith('...' + after)) return { data: { total_commits: 1, commits: [{ sha: after }] } };
        if (basehead.endsWith('...' + wrongSigner)) return {data:{total_commits:1,commits:[{sha:wrongSigner}]}};
        if (basehead.endsWith('...' + last)) return { data: { total_commits: 101, commits: [{ sha: last }] } };
        if (basehead.endsWith('...' + paged)) return {
          data: {
            total_commits: 101,
            commits: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ sha: sha(100 + i) })) : [{ sha: paged }],
          },
        };
        throw Error('unexpected compare ' + basehead);
      },
      getCommit: async () => ({ data: { parents: [{ sha: currentParents ? pullBase : base }, { sha: head }] } }),
    },
    pulls: { list: ()=>{}, get: async ({pull_number}:{pull_number:number}) => ({
      data: { head: { sha: head }, base: { sha: pullBase, ref: 'main' }, merge_commit_sha: pullCandidate, mergeable: pull_number===2 || ++pullReads===1 ? null : true },
    }) },
    git: {
      getRef: async ({ref}: {ref:string}) => {
        assert.equal(ref,'heads/main');
        return {data:{object:{sha:pullBase}}};
      },
      getTree: async ({ tree_sha }: any) => ({
        data: {
          truncated: false,
          tree: [
            { path: '.access.yml', type: 'blob', mode: '100644', sha: 'policy' },
            tree_sha === dirty
              ? { path: '.env', type: 'blob', mode: '100644', sha: 'bad' }
              : tree_sha === head || tree_sha === wrongSigner
                ? { path: '.env', type: 'blob', mode: '100644', sha: tree_sha === head ? 'signed' : 'wrong' }
                : { path: '.env', type: 'tree', mode: '040000', sha: 'directory' },
          ],
        },
      }),
      getBlob: async ({ file_sha }: any) => {
        if(advanceBaseDuringVerification) pullBase=dirty;
        const contents = file_sha === 'policy' ? policy : file_sha === 'signed' ? signed.text : file_sha === 'wrong' ? signed.wrongSignerText : 'PASSWORD=synthetic-plaintext\n';
        return { data: { size: contents.length, encoding: 'base64', content: Buffer.from(contents).toString('base64') } };
      },
    },
  },
});
const common = { installation: { id: 1 }, repository: { id: 123, name: 'fixture', owner: { login: 'acme' } } };
const send = (id: string, name: string, payload: any) => (app.webhooks as any).receive({
  id, name, payload: { ...common, ...payload },
});
try {
  for (const migration of ['schema.sql', 'phase2.sql', 'phase3.sql', 'guard-checkpoints.sql','team-identity.sql','team-identity-enforcement.sql','guard-deliveries.sql','delivery-reliability.sql']) {
    await db.query(await readFile(moduleUrl('control-plane/' + migration), 'utf8'));
  }
  await db.query(
    'INSERT INTO repos(github_repo_id,org_name,repo_name,installation_id,approved_policy,baseline_sha) VALUES(123,$1,$2,1,$3,$4)',
    ['acme', 'fixture', policy, base],
  );
  const {enqueueGuardDelivery,drainGuardDelivery}=await import(moduleUrl('control-plane/src/guard.ts').href);

  // Upgrade recovery revives only unfinished parked guard deliveries.
  await db.query("INSERT INTO guard_deliveries(id,event,payload,failed_at) VALUES('parked','push',$1,now()),('parked-offboard','offboarding',$1,now())",[{...common,before:base,after:head}]);
  await db.query(await readFile(moduleUrl('control-plane/guard-retry-recovery.sql'),'utf8'));
  assert.equal((await db.query("SELECT failed_at FROM guard_deliveries WHERE id='parked'")).rows[0].failed_at,null);
  assert((await db.query("SELECT failed_at FROM guard_deliveries WHERE id='parked-offboard'")).rows[0].failed_at instanceof Date);
  await db.query("DELETE FROM guard_deliveries WHERE id IN ('parked','parked-offboard')");
  // A code-less pg disconnection must leave a retryable job, not complete it.
  const query=db.query.bind(db);
  let disconnect=true;
  db.query=((...args:any[])=>{
    if(disconnect && String(args[0]).startsWith('SELECT approved_policy')) {
      disconnect=false;return Promise.reject(new Error('Connection terminated unexpectedly'));
    }
    return (query as any)(...args);
  }) as typeof db.query;
  await enqueueGuardDelivery('db-disconnect','push',{...common,before:base,after:head});
  await drainGuardDelivery();
  db.query=query as typeof db.query;
  const disconnected=(await db.query("SELECT attempts,completed_at FROM guard_deliveries WHERE id='db-disconnect'")).rows[0];
  assert.equal(disconnected.attempts,1);
  assert.equal(disconnected.completed_at,null);
  await db.query("UPDATE guard_deliveries SET retry_after=now() WHERE id='db-disconnect'");
  await drainGuardDelivery();
  assert((await db.query("SELECT completed_at FROM guard_deliveries WHERE id='db-disconnect'")).rows[0].completed_at instanceof Date);

  checkedShas.length=0;conclusions.length=0;calls.length=0;
  await db.query('DELETE FROM guard_verified_commits');

  // Guard regressions use actual Postgres and the Rust matcher with mocked GitHub.
  await enqueueGuardDelivery('push-valid','push',{...common,before:base,after:head,commits:[{message:'discarded metadata'}]});
  await enqueueGuardDelivery('push-valid','push',{...common,before:base,after:head});
  const queued=await db.query('SELECT payload FROM guard_deliveries WHERE id=$1',['push-valid']);
  assert.equal(queued.rowCount,1);
  assert.equal(queued.rows[0].payload.commits,undefined);
  await drainGuardDelivery();
  assert.equal((await db.query('SELECT completed_at FROM guard_deliveries WHERE id=$1',['push-valid'])).rows[0].completed_at instanceof Date,true);
  await enqueueGuardDelivery('pr','pull_request',{...common,action:'opened',pull_request:{head:{sha:head},number:1}});
  await drainGuardDelivery();
  assert.equal(checkedShas.length,1);
  assert.equal((await db.query("SELECT attempts FROM guard_deliveries WHERE id='pr'")).rows[0].attempts,1);
  await db.query("UPDATE guard_deliveries SET retry_after=now() WHERE id='pr'");
  await drainGuardDelivery();
  assert.equal(pullReads, 3);
  assert.notEqual(checkedShas[0], checkedShas[1]);
  assert.equal(checkedShas[1],merge+' Better Git merge encryption guard');
  assert.equal(checkedShas[2],head+' Better Git merge encryption guard');
  assert.deepEqual(conclusions, ['success', 'failure', 'failure']);
  assert.equal((await db.query('SELECT 1 FROM guard_verified_commits WHERE commit_sha=$1', [merge])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM guard_verified_commits WHERE commit_sha=$1', [dirty])).rowCount, 0);
  await send('push-after-merge', 'push', { before: merge, after });
  assert.equal(calls.at(-1), base + '...' + after + ' p1');
  assert.equal(conclusions.at(-1), 'success');
  // Failed merge histories must never become trusted checkpoints.

  await send('wrong-signer','push',{before:base,after:wrongSigner});
  assert.equal(conclusions.at(-1),'failure');
  await send('incomplete', 'push', { before: sha(0), after: last });
  assert.equal(calls.at(-1),base+'...'+last+' p1');
  assert.equal(conclusions.at(-1), 'failure');
  // Partial pages fail closed.

  // This positive control should keep succeeding after the fixes.
  await send('paginated', 'push', { before: sha(0), after: paged });
  assert.equal(conclusions.at(-1), 'success');
  assert.equal((await db.query('SELECT 1 FROM guard_verified_commits WHERE commit_sha=$1', [sha(199)])).rowCount, 1);
  // Complete pagination persists verified candidates from both pages.
  pullBase=after;
  pullCandidate=cleanMerge;
  await send('base-update','push',{before:base,after,ref:'refs/heads/main'});
  await drainGuardDelivery();
  await drainGuardDelivery();
  const jobs=await db.query("SELECT id,attempts,completed_at FROM guard_deliveries WHERE id LIKE 'base:base-update:%' ORDER BY id");
  assert.equal(jobs.rows.length,2);
  assert(jobs.rows[0].completed_at instanceof Date);
  assert.equal(jobs.rows[1].completed_at,null);
  assert.equal(jobs.rows[1].attempts,1);
  await db.query("UPDATE guard_deliveries SET attempts=9,retry_after=now() WHERE id='base:base-update:2'");
  await drainGuardDelivery();
  const failed=await db.query("SELECT attempts,failed_at,payload FROM guard_deliveries WHERE id='base:base-update:2'");
  assert.equal(failed.rows[0].attempts,10);
  assert.equal(failed.rows[0].failed_at,null);
  assert.equal(failed.rows[0].payload.pull_request.number,2);
  assert.equal(checkedShas.at(-2),cleanMerge+' Better Git merge encryption guard');
  assert.equal(checkedShas.at(-1),head+' Better Git merge encryption guard');
  assert.equal(conclusions.at(-1),'success');
  assert.equal((await db.query('SELECT 1 FROM guard_verified_commits WHERE commit_sha=$1',[cleanMerge])).rowCount,1);

  // A stale candidate must replace earlier green checks on both SHAs, without
  // issuing an encryption verdict before the merge's parents are current.
  currentParents=false;
  const previousChecks=checkedShas.length;
  await enqueueGuardDelivery('stale-pr','pull_request',{...common,pull_request:{number:1,head:{sha:head}}});
  await drainGuardDelivery();
  assert.equal(checkedShas.length,previousChecks);
  assert.deepEqual([...staleChecks],[[head,`stale-pr:1:${after}`],[cleanMerge,`stale-pr:1:${after}`]]);
  assert.equal((await db.query("SELECT attempts FROM guard_deliveries WHERE id='stale-pr'")).rows[0].attempts,1);

  currentParents=true;
  advanceBaseDuringVerification=true;
  await enqueueGuardDelivery('base-changed-during-pr','pull_request',{...common,pull_request:{number:1,head:{sha:head}}});
  await drainGuardDelivery();
  assert.deepEqual(checkedShas.slice(previousChecks),[cleanMerge+' Better Git merge encryption guard']);
  assert.equal(conclusions.at(-1),'action_required');
  assert.equal((await db.query("SELECT attempts FROM guard_deliveries WHERE id='base-changed-during-pr'")).rows[0].attempts,1);
  advanceBaseDuringVerification=false;
  pullBase=after;
  await db.query("UPDATE guard_deliveries SET retry_after=now() WHERE id='base-changed-during-pr'");
  await drainGuardDelivery();
  assert.equal(conclusions.at(-1),'success');
  assert((await db.query("SELECT completed_at FROM guard_deliveries WHERE id='base-changed-during-pr'")).rows[0].completed_at instanceof Date);

  await send('merge-group','merge_group',{action:'checks_requested',merge_group:{base_sha:after,head_sha:groupHead}});
  assert.equal(checkedShas.at(-1),groupHead+' Better Git merge encryption guard');
  assert.equal(conclusions.at(-1),'success');
  await send('not-enrolled','push',{repository:{...common.repository,id:456},before:base,after:head});
  assert.equal(conclusions.at(-1),'action_required');
  assert.equal(outputs.at(-1),'Repository enrollment required');
} finally {
  await db.end();
  await admin.query('DROP SCHEMA ' + schema + ' CASCADE');
  await admin.end();
}

});
