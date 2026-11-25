import { createServer } from 'node:http';
import { app,db,user,access,envelopeSchema,fetchEnvelope } from './service.js';
import {drainGuardDelivery} from './guard.js';
import { enrollRepository } from './enrollment.js';
import { dashboardRequest } from './dashboard.js';
import {drainOffboardingDelivery,drainShadowRevocation} from './offboarding.js';
import {createShadow,publishShadow,authorizePublish,joinShadow} from './shadow.js';
import {requestKey,consumeKey,approveKey} from './oidc.js';
import {receiveGitHubWebhook} from './webhook.js';
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try {
    const url=new URL(req.url!,'http://localhost');
    const webhook=req.method==='POST' && url.pathname==='/webhooks/github';
    const limit=webhook ? 25*1024*1024 : 128*1024;
    const chunks:Buffer[]=[];
    let size=0;
    for await(const chunk of req) {
      size+=chunk.length;
      if(size>limit) throw new Error('body too large');
      chunks.push(chunk);
    }
    const raw=Buffer.concat(chunks,size);
    if(webhook) {
      await receiveGitHubWebhook(req.headers,raw,res);
      return;
    }
    const body=raw.toString('utf8');
    const ci=url.pathname.match(/^\/v1\/ci\/(\d+)\/requests$/);
    const ciFetch=url.pathname.match(/^\/v1\/ci\/requests\/([0-9a-f-]{36})$/);
    if(req.method==='POST' && ci) {
      const d=JSON.parse(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await requestKey(ci[1]!,req.headers.authorization?.replace(/^Bearer /,'')??'',d.publicKey)));return;
    }
    if(req.method==='GET' && ciFetch) {
      const result=await consumeKey(ciFetch[1]!,req.headers.authorization?.replace(/^Bearer /,'')??'',req.socket.remoteAddress??'127.0.0.1');
      res.setHeader('Content-Type','application/json');res.writeHead(result?200:202).end(JSON.stringify(result??{pending:true}));return;
    }
    if(await dashboardRequest(req,res,url.pathname,body)) return;
    const u=await user(req.headers.authorization?.replace(/^Bearer /,'')??'');
    const data=body?JSON.parse(body):{};
    if(req.method==='PUT' && url.pathname==='/v1/identity') {
      if(typeof data.publicKey!=='string' || !/^age1[a-z0-9]{58}$/.test(data.publicKey)) throw new Error('invalid public key');
      // Key replacement is explicit recovery work: prevent silent directory substitution.
      const r=await db.query('UPDATE users SET age_public_key=$1 WHERE id=$2 AND (age_public_key IS NULL OR age_public_key=$1)',[data.publicKey,u.id]);
      if(!r.rowCount) throw new Error('identity already registered');
      res.writeHead(204).end();return;
    }
    if(req.method==='POST' && url.pathname==='/v1/repos') {
      if(typeof data.owner!=='string' || typeof data.repo!=='string') throw new Error('invalid repository');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await enrollRepository(u,data.owner,data.repo)));return;
    }
    const repoInfo=url.pathname.match(/^\/v1\/repos\/(\d+)$/);
    if(req.method==='GET' && repoInfo) {
      const {rows}=await db.query('SELECT id,org_name,repo_name FROM repos WHERE id=$1',[repoInfo[1]]);const r=rows[0];if(!r)throw new Error('repository unavailable');
      const {data:repository}=await u.github.rest.repos.get({owner:r.org_name,repo:r.repo_name});
      if(!repository.permissions?.pull)throw new Error('repository access required');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(r));return;
    }
    const groupCreate=url.pathname.match(/^\/v1\/repos\/(\d+)\/groups$/);
    if(req.method==='POST' && groupCreate) {
      const {rows}=await db.query('SELECT * FROM repos WHERE id=$1',[groupCreate[1]]);const r=rows[0];if(!r) throw new Error('repo missing');
      const gh=await app.getInstallationOctokit(Number(r.installation_id));
      const {data:perm}=await gh.rest.repos.getCollaboratorPermissionLevel({owner:r.org_name,repo:r.repo_name,username:u.github_username});if(perm.permission!=='admin') throw new Error('administrator required');
      if(typeof data.name!=='string' || !/^github-team:[a-zA-Z0-9_-]+$/.test(data.name)) throw new Error('invalid group');
      const slug=data.name.slice('github-team:'.length);
      const {data:team}=await gh.rest.teams.getByName({org:r.org_name,team_slug:slug});
      if(data.teamId!==undefined && (!Number.isSafeInteger(data.teamId) || data.teamId!==team.id)) throw new Error('team does not match verified ID');
      const {rows:g}=await db.query('INSERT INTO groups(repo_id,name,github_team_slug,github_team_id) VALUES($1,$2,$3,$4) ON CONFLICT(repo_id,name) DO UPDATE SET github_team_id=$4 WHERE groups.github_team_id=$4 OR (groups.github_team_id IS NULL AND $5::boolean) RETURNING id',[r.id,data.name,slug,team.id,data.teamId!==undefined]);
      if(!g[0]) throw new Error('existing group is bound to a different team');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(g[0]));return;
    }
    const shadowCreate=url.pathname.match(/^\/v1\/repos\/(\d+)\/shadows$/);
    if(req.method==='POST' && shadowCreate) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await createShadow(u,shadowCreate[1]!,data)));return;}
    const shadowList=url.pathname.match(/^\/v1\/repos\/(\d+)\/shadows$/);
    if(req.method==='GET' && shadowList) {const {rows}=await db.query('SELECT id,branch_name,status,publish_pr FROM shadow_repos WHERE parent_repo_id=$1 AND creator_id=$2',[shadowList[1],u.id]);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rows));return;}
    const shadowJoin=url.pathname.match(/^\/v1\/shadows\/(\d+)$/);
    if(req.method==='GET' && shadowJoin){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await joinShadow(u,shadowJoin[1]!)));return;}
    const shadowAuth=url.pathname.match(/^\/v1\/shadows\/(\d+)\/authorize$/);
    if(req.method==='GET' && shadowAuth) {
      const {shadow,repo,gh}=await authorizePublish(u,shadowAuth[1]!);
      const base=url.searchParams.get('base')??'main';if(!/^[a-zA-Z0-9_./-]+$/.test(base))throw new Error('invalid base');
      const {data:tip}=await gh.rest.repos.getCommit({owner:repo.org_name,repo:shadow.repo_name,ref:shadow.branch_name});
      const {data:parent}=await gh.rest.repos.getCommit({owner:repo.org_name,repo:repo.repo_name,ref:base});
      const comparison=await gh.rest.repos.compareCommitsWithBasehead({owner:repo.org_name,repo:shadow.repo_name,basehead:`${parent.sha}...${tip.sha}`});if(!['ahead','identical'].includes(comparison.data.status))throw new Error('shadow lacks current public base');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({origin:`git@github.com:${repo.org_name}/${repo.repo_name}.git`,branch:shadow.branch_name,tip:tip.sha,tree:tip.commit.tree.sha,base:parent.sha}));return;
    }
    const shadowPublish=url.pathname.match(/^\/v1\/shadows\/(\d+)\/publish$/);
    if(req.method==='POST' && shadowPublish) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await publishShadow(u,shadowPublish[1]!,data.head,data.base,data.headSha,data.baseSha,data.tipSha)));return;}
    const approve=url.pathname.match(/^\/v1\/ci\/requests\/([0-9a-f-]{36})\/approve$/);
    if(req.method==='PUT' && approve) {await approveKey(u.id,approve[1]!,data.envelope);res.writeHead(204).end();return;}
    const pending=url.pathname.match(/^\/v1\/groups\/(\d+)\/ci-requests$/);
    if(req.method==='GET' && pending) {
      await access(u.id,pending[1]!,true);
      const {rows}=await db.query('SELECT c.id,c.public_key,c.oidc_token,p.group_id FROM ci_requests c JOIN ci_policies p ON p.id=c.policy_id WHERE p.group_id=$1 AND p.enabled=true AND c.expires_at>now() AND c.encrypted_dek_blob IS NULL',[pending[1]]);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rows));return;
    }
    const reports=url.pathname.match(/^\/v1\/groups\/(\d+)\/offboarding$/);
    if(req.method==='GET' && reports) {
      const g=await access(u.id,reports[1]!,true);const {rows}=await db.query('SELECT * FROM offboarding_reports WHERE repo_id=$1 AND report->>\'groupId\'=$2 ORDER BY removed_at DESC',[g.repo_id,reports[1]]);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rows));return;
    }
    const groupList=url.pathname.match(/^\/v1\/repos\/(\d+)\/groups$/);
    if(groupList && req.method==='GET') {
      const {rows}=await db.query('SELECT id,name FROM groups WHERE repo_id=$1',[groupList[1]]);
      const allowed=[];for(const g of rows) {try {await access(u.id,g.id);allowed.push(g);}catch{}}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(allowed));return;
    }
    const groupInfo=url.pathname.match(/^\/v1\/groups\/(\d+)$/);
    if(req.method==='GET' && groupInfo){const g=await access(u.id,groupInfo[1]!,true);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:g.id,name:g.name,repo_id:g.repo_id}));return;}
    const directory=url.pathname.match(/^\/v1\/groups\/(\d+)\/users\/(\d+)$/);
    if(directory && req.method==='GET') {
      await access(u.id,directory[1]!,true);await access(directory[2]!,directory[1]!);
      const {rows}=await db.query('SELECT id,github_username,age_public_key FROM users WHERE id=$1',[directory[2]]);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rows[0]));return;
    }
    const match=url.pathname.match(/^\/v1\/groups\/(\d+)\/envelopes$/);
    if(match && req.method==='GET') { res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await fetchEnvelope(u.id,match[1]!,req.socket.remoteAddress??'127.0.0.1')));return; }
    if(match && req.method==='PUT') {
      const d=envelopeSchema.parse(data);await access(u.id,match[1]!,true);await access(d.userId,match[1]!);
      const client=await db.connect();try {
        await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1::int,$2::int)',[d.userId,match[1]]);
        const revoked=await client.query('SELECT 1 FROM revocations WHERE user_id=$1 AND group_id=$2',[d.userId,match[1]]);if(revoked.rowCount) throw new Error('explicit re-enrollment required');
        await client.query('INSERT INTO wrapped_deks(group_id,user_id,encrypted_dek_blob,key_version) VALUES($1,$2,$3,$4)',[match[1],d.userId,d.envelope,d.version]);await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      res.writeHead(204).end();return;
    }
    res.writeHead(404).end();
  }catch {res.writeHead(403).end('{"error":"request rejected"}');}
});
function runWorker(name:string,processNext:()=>Promise<void>) {
  let running=false;
  const timer=setInterval(()=>{
    if(running) return;
    running=true;
    void processNext().catch(()=>console.error(name+' worker could not process its queue')).finally(()=>{running=false;});
  },2_000);
  timer.unref();
}
runWorker('Offboarding delivery',drainOffboardingDelivery);
runWorker('Shadow revocation',drainShadowRevocation);
runWorker('GitHub guard',drainGuardDelivery);
server.listen(Number(process.env.PORT??3000),process.env.HOST??'127.0.0.1');
