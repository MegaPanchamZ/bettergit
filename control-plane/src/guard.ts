import {createHash} from 'node:crypto';
import { parse } from 'yaml';
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app,db } from './service.js';
import {drainDelivery,persistDelivery} from './delivery-queue.js';
// Validate blobs with the same parser as the local filter, without loading keys.
async function validate(policy:string,path:string,bytes:Buffer) {
  const dir=await mkdtemp(join(tmpdir(),'bettergit-guard-'));
  try {
    await writeFile(join(dir,'.access.yml'),policy); await writeFile(join(dir,'blob'),bytes);
    await new Promise<void>((resolve,reject)=>{ const p=spawn('git',['init','--quiet',dir],{stdio:'ignore',timeout:30_000,killSignal:'SIGKILL'}); p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(new Error('git init failed'))); });
    await new Promise<void>((resolve,reject)=>{ const p=spawn(process.env.BETTERGIT_BINARY ?? 'bettergit',['check','--require-signing-key','--',path,'blob'],{cwd:dir,stdio:'ignore',timeout:30_000,killSignal:'SIGKILL'});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(new Error('invalid protected blob'))); });
  } finally { await rm(dir,{recursive:true,force:true}); }
}
async function checkDelivery(p:any) {
  if(!p.installation || p.deleted || (p.pull_request && p.action==='closed') || (p.merge_group && p.action==='destroyed')) return;
  const gh=await app.getInstallationOctokit(p.installation.id);
  const owner=p.repository.owner.login ?? p.repository.owner.name, repo=p.repository.name;
  let target=p.merge_group?.head_sha ?? p.after;
  let base=p.merge_group?.base_sha ?? p.before;
  let pullHead:string|undefined;
  let pullBaseRef:string|undefined;
  if(p.pull_request) {
    const {data:pr}=await gh.rest.pulls.get({owner,repo,pull_number:p.pull_request.number});
    if(pr.state==='closed' || (p.pull_request.head && pr.head.sha!==p.pull_request.head.sha)) return;
    if(pr.mergeable===false) return;
    if(pr.mergeable!==true || !pr.merge_commit_sha) throw new Error('merge candidate is not ready');
    // GitHub can retain the old base SHA in the PR response after the target branch moves.
    pullBaseRef=`heads/${pr.base.ref}`;
    const {data:baseRef}=await gh.rest.git.getRef({owner,repo,ref:pullBaseRef});
    base=baseRef.object.sha;
    const {data:merge}=await gh.rest.repos.getCommit({owner,repo,ref:pr.merge_commit_sha});
    if(merge.parents.length!==2 || merge.parents[0]?.sha!==base || merge.parents[1]?.sha!==pr.head.sha) {
      throw new Error('merge candidate does not match current parents');
    }
    target=pr.merge_commit_sha;
    pullHead=pr.head.sha;
  }
  if(!target) return;
  const name=p.pull_request || p.merge_group?'Better Git merge encryption guard':'Better Git commit encryption guard';
  const check=await gh.rest.checks.create({owner,repo,name,head_sha:target,status:'in_progress'});
  let valid=false;
  try {
    const {rows}=await db.query('SELECT approved_policy,baseline_sha FROM repos WHERE github_repo_id=$1',[p.repository.id]);
    if(!rows[0]) throw new Error('repository not enrolled');
    const trusted=Buffer.from(rows[0].approved_policy);
    const policy=parse(trusted.toString());
    if(policy.version!==1 || !Array.isArray(policy.rules)) throw new Error('invalid policy');
    const digest=createHash('sha256').update(trusted).digest('hex');
    const verified=await db.query('SELECT 1 FROM guard_verified_commits WHERE github_repo_id=$1 AND commit_sha=$2 AND policy_digest=$3',[p.repository.id,base,digest]);
    const start=verified.rowCount ? base : rows[0].baseline_sha;
    // Comparing all the way to a merge covers both parents' ancestry.
    const covered=new Set<string>();let total:number|undefined;
    for(let page=1;;page++) {
      const comparison=await gh.rest.repos.compareCommitsWithBasehead({owner,repo,basehead:`${start}...${target}`,per_page:100,page});
      const advertised=comparison.data.total_commits;
      if(!Number.isSafeInteger(advertised) || advertised<0 || advertised>10000 || (total!==undefined && total!==advertised)) throw new Error('invalid or excessive comparison range');
      total=advertised;
      const expected=Math.min(100,Math.max(0,total-(page-1)*100));
      if(comparison.data.commits.length!==expected) throw new Error('incomplete commit range');
      for(const commit of comparison.data.commits) {
        if(covered.has(commit.sha)) throw new Error('duplicate comparison commit');
        covered.add(commit.sha);
      }
      if(covered.size===total) break;
    }
    const commits=[...new Set([target,...covered])];
    for(const commit of commits) {
      const tree=await gh.rest.git.getTree({owner,repo,tree_sha:commit,recursive:'1'});
      if(tree.data.truncated) throw new Error('tree too large to verify');
      const policyEntry=tree.data.tree.find(i=>i.path==='.access.yml');
      if(!policyEntry?.sha) throw new Error('policy missing');
      async function blob(sha:string) {const {data}=await gh.rest.git.getBlob({owner,repo,file_sha:sha});if(data.size===null || data.size>64*1024*1024 || data.encoding!=='base64') throw new Error('blob too large');const bytes=Buffer.from(data.content,'base64');if(bytes.length!==data.size) throw new Error('blob size mismatch');return bytes;}
      if(!trusted.equals(await blob(policyEntry.sha))) throw new Error('policy requires explicit administrator approval');
      const matched=new Set(await matching(trusted.toString(),tree.data.tree.filter(i=>i.type!=='tree').map(i=>i.path!).filter(Boolean)));
      for(const item of tree.data.tree) {
        if(item.type==='tree' || !item.path || !matched.has(item.path)) continue;
        if(item.type!=='blob' || item.mode==='120000' || !item.sha) throw new Error('protected paths must be regular files');
        await validate(trusted.toString(),item.path,await blob(item.sha));
      }
    }
    await db.query('INSERT INTO guard_verified_commits(github_repo_id,commit_sha,policy_digest) SELECT $1,unnest($2::text[]),$3 ON CONFLICT DO NOTHING',[p.repository.id,commits,digest]);
    valid=true;
  } catch(error) {
    // Retry rate limits, permission changes and provider server errors.
    const status=(error as {status?:number}).status;
    if(status===403 || status===429 || (status!==undefined && status>=500)) throw error;
  }
  const verdict={
    owner,repo,status:'completed' as const,conclusion:valid?'success' as const:'failure' as const,
    ...(!valid && {output:{title:'Protected content could not be verified',summary:'Encryption validation failed. Check policy, protected blobs, and guard configuration. Do not post secret contents in logs.'}}),
  };
  await gh.rest.checks.update({...verdict,check_run_id:check.data.id});
  if(pullHead && pullBaseRef) {
    // GitHub can require the check on the PR head as well as the test merge.
    const {data:current}=await gh.rest.pulls.get({owner,repo,pull_number:p.pull_request.number});
    if(current.state==='closed' || current.head.sha!==pullHead) return;
    const {data:currentBase}=await gh.rest.git.getRef({owner,repo,ref:pullBaseRef});
    if(current.mergeable!==true || `heads/${current.base.ref}`!==pullBaseRef ||
      currentBase.object.sha!==base || current.merge_commit_sha!==target) {
      throw new Error('merge candidate changed before reporting on PR head');
    }
    await gh.rest.checks.create({...verdict,name,head_sha:pullHead});
  }
}

app.webhooks.on(['push','pull_request','merge_group'],async ({id,payload})=>{
 const p=payload as any;
 await checkDelivery(p);
 if(!p.installation || p.deleted || typeof p.ref!=='string' || !p.ref.startsWith('refs/heads/')) return;
 const gh=await app.getInstallationOctokit(p.installation.id);
 const owner=p.repository.owner.login ?? p.repository.owner.name;
 const prs=await gh.paginate(gh.rest.pulls.list,{owner,repo:p.repository.name,base:p.ref.slice('refs/heads/'.length),state:'open'});
 for(const pr of prs) {
  await enqueueGuardDelivery(`base:${id}:${pr.number}`,'pull_request',{installation:p.installation,repository:p.repository,pull_request:{number:pr.number}});
 }
});

app.webhooks.on('check_run.rerequested',async ({id,payload:p})=>{
 if(!p.installation || p.check_run.name!=='Better Git merge encryption guard' || p.check_run.app?.id!==Number(process.env.GITHUB_APP_ID)) return;
 for(const pr of p.check_run.pull_requests) {
  await enqueueGuardDelivery(`rerequest:${id}:${pr.number}`,'pull_request',{installation:p.installation,repository:p.repository,pull_request:{number:pr.number}});
 }
});

export async function matching(policy:string,paths:string[]):Promise<string[]> {
 const dir=await mkdtemp(join(tmpdir(),'bettergit-match-'));try {
  await writeFile(join(dir,'.access.yml'),policy);
  await new Promise<void>((resolve,reject)=>{const p=spawn('git',['init','--quiet',dir],{stdio:'ignore',timeout:30_000,killSignal:'SIGKILL'});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(new Error('git init failed')));});
  return await new Promise<string[]>((resolve,reject)=>{const p=spawn(process.env.BETTERGIT_BINARY??'bettergit',['match-paths','--require-signing-keys'],{cwd:dir,stdio:['pipe','pipe','ignore'],timeout:30_000,killSignal:'SIGKILL'});let output='';p.stdout.on('data',c=>{output+=c;});p.on('error',reject);p.on('close',c=>{if(c!==0)return reject(new Error('invalid policy'));try{resolve(JSON.parse(output));}catch(e){reject(e);}});p.stdin.on('error',reject);p.stdin.end(JSON.stringify(paths));});
 }finally{await rm(dir,{recursive:true,force:true});}
}

// Keep only GitHub identifiers and refs needed by the worker. Acknowledge after
// storing the delivery so a slow scan does not consume GitHub's request deadline.
export async function enqueueGuardDelivery(id:string,event:'push'|'pull_request'|'merge_group'|'check_run',p:any) {
 const repository=p.repository && {id:p.repository.id,name:p.repository.name,owner:{login:p.repository.owner?.login,name:p.repository.owner?.name}};
 const payload={
  installation:p.installation && {id:p.installation.id},
  repository,action:p.action,ref:p.ref,deleted:p.deleted,before:p.before,after:p.after,
  pull_request:p.pull_request && {number:p.pull_request.number,head:p.pull_request.head && {sha:p.pull_request.head.sha}},
  merge_group:p.merge_group && {head_sha:p.merge_group.head_sha,base_sha:p.merge_group.base_sha},
  check_run:p.check_run && {name:p.check_run.name,app:{id:p.check_run.app?.id},
    pull_requests:p.check_run.pull_requests?.map((pr:{number:number})=>({number:pr.number}))??[]},
 };
 await persistDelivery(id,event,payload);
}

export function drainGuardDelivery() {
 return drainDelivery(false,async job=>{await app.webhooks.receive({id:job.id,name:job.event as Exclude<typeof job.event,'offboarding'>,payload:job.payload});});
}
