import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {Pool} from 'pg';import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
test('migrations, offboarding, replay deduplication, and immutable CI policies',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const schema=`test_${randomBytes(8).toString('hex')}`;const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);
 process.env.DATABASE_URL=url.toString();process.env.GITHUB_APP_ID='1';process.env.GITHUB_PRIVATE_KEY='test';process.env.GITHUB_WEBHOOK_SECRET='test';
 const {app,db,user}=await import('./service.js');
 try {
  for(const name of ['schema.sql','phase2.sql','phase3.sql','guard-checkpoints.sql','team-identity.sql','team-identity-enforcement.sql','guard-deliveries.sql','delivery-reliability.sql']) await db.query(await readFile(new URL(`../${name}`,import.meta.url),'utf8'));
  await db.query("INSERT INTO users(github_id,github_username) VALUES(42,'removed')");
  await db.query("INSERT INTO repos(github_repo_id,org_name,repo_name,installation_id,approved_policy,baseline_sha) VALUES(1,'acme','repo',1,'policy','base')");
  await db.query("INSERT INTO groups(repo_id,name,github_team_slug,github_team_id) VALUES(1,'github-team:engineering','engineering',101)");
  await db.query("INSERT INTO wrapped_deks(group_id,user_id,encrypted_dek_blob,key_version) VALUES(1,1,'wrapped',1)");
  const {drainOffboardingDelivery,drainShadowRevocation}=await import('./offboarding.js');
  const {receiveGitHubWebhook}=await import('./webhook.js');
  const receiver=createServer(async(req,res)=>{
   const chunks:Buffer[]=[];
   for await (const chunk of req) chunks.push(chunk);
   await receiveGitHubWebhook(req.headers,Buffer.concat(chunks),res);
  }).listen(0,'127.0.0.1');
  const delivery=randomUUID();
  try {
   await once(receiver,'listening');
   const address=receiver.address();
   assert(address && typeof address!=='string');
   const body=JSON.stringify({action:'removed',organization:{login:'acme'},team:{id:101},member:{id:42}});
   const signature='sha256='+createHmac('sha256','test').update(body).digest('hex');
   const send=(digest:string)=>fetch(`http://127.0.0.1:${address.port}/webhooks/github`,{method:'POST',body,headers:{
    'x-github-delivery':delivery,'x-github-event':'membership','x-hub-signature-256':digest,
   }});
   assert.equal((await send('sha256='+'0'.repeat(64))).status,403);
   assert.equal((await db.query('SELECT * FROM guard_deliveries')).rowCount,0);
   assert.equal((await send(signature)).status,204);
   assert.equal((await send(signature)).status,204);
   assert.equal((await db.query('SELECT * FROM guard_deliveries')).rowCount,1);
   assert.equal((await db.query('SELECT * FROM wrapped_deks')).rowCount,1);
   await db.query('ALTER TABLE offboarding_reports ADD CONSTRAINT test_unavailable CHECK (false) NOT VALID');
   await drainOffboardingDelivery();
   assert.equal((await db.query('SELECT attempts FROM guard_deliveries WHERE id=$1',[delivery])).rows[0].attempts,1);
   assert.equal((await db.query('SELECT * FROM wrapped_deks')).rowCount,1);
   await db.query('ALTER TABLE offboarding_reports DROP CONSTRAINT test_unavailable');
   await db.query('UPDATE guard_deliveries SET retry_after=now() WHERE id=$1',[delivery]);
   await drainOffboardingDelivery();
   const {rows:[processed]}=await db.query('SELECT payload,completed_at FROM guard_deliveries WHERE id=$1',[delivery]);
   assert(processed.completed_at instanceof Date);
   assert.equal(processed.payload,null);
  }finally{
   await new Promise<void>((resolve,reject)=>receiver.close(error=>error?reject(error):resolve()));
  }
  await assert.rejects(()=>db.query('UPDATE groups SET github_team_id=202 WHERE id=1'),/immutable GitHub team ID/);
  await assert.rejects(()=>db.query("INSERT INTO groups(repo_id,name,github_team_slug) VALUES(1,'unbound','unbound')"),/immutable GitHub team ID/);
  assert.equal((await db.query('SELECT * FROM shadow_revocation_jobs')).rowCount,1);
  await db.query(`INSERT INTO shadow_repos(parent_repo_id,github_repo_id,repo_name,branch_name,creator_id,allowed_users,allowed_ids,status)
    VALUES(1,2,'companion','restricted',1,'["removed","other"]','[42,43]','ready')`);
  await db.query(await readFile(new URL('../workspaces.sql',import.meta.url),'utf8'));
  let unavailable=true;
  const listCollaborators=()=>{};
  const listInvitations=()=>{};
  const listTeams=()=>{};
  const originalInstallation=app.getInstallationOctokit;
  app.getInstallationOctokit=(async ()=>{
   if(unavailable) throw new Error('synthetic provider interruption');
   return {
    request:async(_route:string,{account_id}:{account_id:number})=>({data:{id:account_id,login:account_id===42?'removed':'other'}}),
    rest:{orgs:{get:async()=>({data:{default_repository_permission:'none'}}),checkMembershipForUser:async()=>{}},
     repos:{listCollaborators,listInvitations,listTeams,get:async()=>({data:{id:2,private:true,fork:false,allow_forking:false}}),
      getCollaboratorPermissionLevel:async({repo,username}:{repo:string;username:string})=>({data:{permission:repo==='companion'&&username==='removed'?'none':'read'}}),update:async()=>{},addCollaborator:async()=>{}}},
    paginate:async(method:unknown)=>{
     assert([listCollaborators,listInvitations,listTeams].includes(method as typeof listCollaborators));
     return method===listCollaborators?[{id:43,login:'other',permissions:{push:true}}]:[];
    }};

  }) as unknown as typeof app.getInstallationOctokit;
  try {
   await drainShadowRevocation();
   const {rows:[pending]}=await db.query('SELECT attempts,retry_after FROM shadow_revocation_jobs');
   assert.equal(pending.attempts,1);
   assert(pending.retry_after.getTime()>Date.now());
   // A provider outage must preserve the retry job and desired membership.
   assert.deepEqual((await db.query('SELECT allowed_ids FROM workspaces')).rows[0].allowed_ids,[42,43]);
   unavailable=false;
   await db.query('UPDATE shadow_revocation_jobs SET retry_after=now()');
   await drainShadowRevocation();
   assert.deepEqual((await db.query('SELECT allowed_ids,allowed_users FROM shadow_repos')).rows[0],{allowed_ids:[43],allowed_users:['other']});
  } finally { app.getInstallationOctokit=originalInstallation; }
  assert.equal((await db.query('SELECT * FROM shadow_revocation_jobs')).rowCount,0);
  assert.equal((await db.query('SELECT * FROM wrapped_deks')).rowCount,0);
  const reports=await db.query('SELECT report FROM offboarding_reports');assert.equal(reports.rowCount,1);assert.equal(reports.rows[0].report.rotationRequired,true);
  assert.equal((await db.query('SELECT * FROM revocations')).rowCount,1);
  await db.query("INSERT INTO ci_policies(group_id,issuer,audience,subject,required_claims) VALUES(1,'issuer','audience','subject','{}')");
  await assert.rejects(()=>db.query("UPDATE ci_policies SET group_id=2 WHERE id=1"),/new policy revision/);
  await db.query('UPDATE ci_policies SET enabled=false WHERE id=1');
  process.env.GITHUB_CLIENT_ID='test-client';process.env.GITHUB_CLIENT_SECRET='test-secret';
  const originalFetch=globalThis.fetch;
  let appId='another-client';
  let tokenChecks=0;
  globalThis.fetch=async (request,options)=>{
    assert.equal(String(request),'https://api.github.com/applications/test-client/token');
    assert.equal(options?.method,'POST');
    assert.equal(new Headers(options?.headers).get('authorization'),'Basic '+Buffer.from('test-client:test-secret').toString('base64'));
    assert.deepEqual(JSON.parse(String(options?.body)),{access_token:'ghu_synthetic'});
    tokenChecks++;
    return Response.json({app:{client_id:appId},user:{id:99,login:'verified'}});
  };
  try {
    await assert.rejects(()=>user('ghp_synthetic'),/unauthorized/);
    assert.equal(tokenChecks,0);
    await assert.rejects(()=>user('ghu_synthetic'),/unauthorized/);
    assert.equal((await db.query('SELECT 1 FROM users WHERE github_id=99')).rowCount,0);
    appId='test-client';
    assert.equal((await user('ghu_synthetic')).github_username,'verified');
    assert.equal(tokenChecks,2);
  } finally { globalThis.fetch=originalFetch; }
 }finally{await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
