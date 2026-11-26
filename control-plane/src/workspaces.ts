import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {db,app} from './service.js';
import {repoAdmin} from './shadow.js';

export class WorkspaceSetupError extends Error {}

const id=z.string().regex(/^\d+$/);
export const audienceInput=z.object({
 allow:z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/)).max(500).default([]),
 groups:z.array(id).max(100).default([]),
}).strict().refine(d=>d.allow.length+d.groups.length>0,'an audience is required');
const workspaceInput=z.object({name:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
 allow:z.array(z.string()).optional(),groups:z.array(id).optional()}).strict();

// All writes and reconciliation use the same cross-process lock. Provider failure
// leaves desired state durable and blocks join/publication until a retry succeeds.
async function locked<T>(workspaceId:string,fn:(client:import('pg').PoolClient)=>Promise<T>) {
 const client=await db.connect();
 try {
  await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['workspace:'+workspaceId]);
  return await fn(client);
 } finally {
  await client.query('ROLLBACK');
  await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['workspace:'+workspaceId]);
  client.release();
 }
}
async function row(workspaceId:string,client:Pick<typeof db,'query'>=db) {
 const {rows}=await client.query(`SELECT w.*,r.org_name,r.repo_name AS parent_name,r.installation_id
 FROM workspaces w JOIN repos r ON r.id=w.parent_repo_id WHERE w.id=$1`,[workspaceId]);
 if(!rows[0])throw new Error('workspace unavailable');return rows[0];
}
async function event(client:import('pg').PoolClient,workspaceId:string,actor:string|null,action:string,details:unknown={}) {
 await client.query('INSERT INTO workspace_events(workspace_id,actor_id,action,details) VALUES($1,$2,$3,$4)',[workspaceId,actor,action,JSON.stringify(details)]);
}
async function explicitMembers(repo:any,logins:string[]) {
 const gh=await app.getInstallationOctokit(Number(repo.installation_id));
 const ids:number[]=[];
 for(const login of logins) {
  try {
   const {data:u}=await gh.rest.users.getByUsername({username:login});
   await gh.rest.orgs.checkMembershipForUser({org:repo.org_name,username:u.login});
   const {data:p}=await gh.rest.repos.getCollaboratorPermissionLevel({owner:repo.org_name,repo:repo.repo_name,username:u.login});
   if(p.permission==='none')throw new WorkspaceSetupError(`Give @${login} read access to the parent repository first.`);
   ids.push(u.id);
  } catch(error) {
   if((error as {status?:number}).status===404)throw new WorkspaceSetupError(`Confirm @${login} has accepted GitHub organization membership and can read the parent repository.`);
   throw error;
  }
 }
 return [...new Set(ids)];
}
export async function createWorkspace(user:any,repoId:string,input:unknown) {
 const d=workspaceInput.parse(input);const audience=audienceInput.parse({allow:d.allow,groups:d.groups});
 const {repo,gh}=await repoAdmin(user,repoId);
 const pilotOrg=process.env.BETTERGIT_WORKSPACE_PILOT_ORG;
 if(pilotOrg && repo.org_name.toLowerCase()!==pilotOrg.toLowerCase())throw new WorkspaceSetupError('Workspace creation is limited to the pilot organization.');
 const {data:installation}=await app.octokit.rest.apps.getOrgInstallation({org:repo.org_name});
 const hasRead=(permission:string|undefined)=>permission==='read'||permission==='write';
 if(installation.id!==Number(repo.installation_id) || installation.suspended_at
    || installation.permissions.administration!=='write'
    || !hasRead(installation.permissions.organization_administration)
    || !hasRead(installation.permissions.members) || !hasRead(installation.permissions.contents)) {
  throw new WorkspaceSetupError('Approve the Better Git App permissions in GitHub organization settings. The pilot requires repository Administration write, Contents read, organization Administration read and Members read.');
 }
 const {data:org}=await gh.rest.orgs.get({org:repo.org_name});
 if(org.default_repository_permission!=='none')throw new WorkspaceSetupError('Set GitHub organization base permissions to None before creating a workspace.');
 for(const groupId of audience.groups) await workspaceTeam(repoId,groupId,repo.org_name,gh,db);
 const explicitIds=await explicitMembers(repo,audience.allow);
 // Resolve identities and parent access before creating any GitHub repository.
 const {rows:[w]}=await db.query(`INSERT INTO workspaces(parent_repo_id,name,repo_name,creator_id,allowed_users,group_ids,explicit_ids)
 VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[repoId,d.name,'bettergit-'+randomBytes(16).toString('hex'),user.id,JSON.stringify(audience.allow),JSON.stringify(audience.groups),JSON.stringify(explicitIds)]);
 await reconcileWorkspace(String(w.id));
 return workspaceInfo(user,String(w.id));
}
type InstallationClient=Awaited<ReturnType<typeof repoAdmin>>['gh'];
async function workspaceTeam(repoId:string,groupId:string,org:string,gh:InstallationClient,client:Pick<typeof db,'query'>) {
 const {rows:[group]}=await client.query('SELECT * FROM groups WHERE id=$1 AND repo_id=$2',[groupId,repoId]);
 if(!group?.github_team_id)throw new WorkspaceSetupError('workspace group unavailable');
 const {data:team}=await gh.rest.teams.getByName({org,team_slug:group.github_team_slug});
 if(team.id!==Number(group.github_team_id))throw new WorkspaceSetupError('workspace team identity changed');
 return group;
}
export async function branchJoinLink(user:any,branchId:string) {
 const {rows:[branch]}=await db.query("SELECT workspace_id,branch_name FROM shadow_repos WHERE id=$1 AND status='ready'",[branchId]);
 if(!branch)throw new WorkspaceSetupError('Branch unavailable.');
 const workspace=await row(branch.workspace_id);
 const {gh}=await repoAdmin(user,workspace.parent_repo_id);
 await requireWorkspace(branch.workspace_id);
 const target={owner:workspace.org_name,repo:workspace.repo_name};
 const {data:repo}=await gh.rest.repos.get(target);
 if(repo.id!==Number(workspace.github_repo_id) || !repo.private || repo.fork)throw new WorkspaceSetupError('Verify workspace privacy before sharing a link.');
 await requireBranchRef(gh,target,branch.branch_name);
 return {path:`/join/#${branchId}`};
}
export async function requireBranchRef(gh:InstallationClient,target:{owner:string;repo:string},branch:string) {
 try {
  await gh.rest.git.getRef({...target,ref:`heads/${branch}`});
 } catch(error) {
  if([404,409].includes((error as {status:number}).status))throw new WorkspaceSetupError('Push the restricted branch to its workspace before sharing or joining.');
  throw error;
 }
}
export async function workspaceInfo(user:any,workspaceId:string) {
 const w=await row(workspaceId);await repoAdmin(user,w.parent_repo_id);
 const {rows:branches}=await db.query('SELECT id,branch_name,status,publish_pr FROM shadow_repos WHERE workspace_id=$1 ORDER BY id',[workspaceId]);
 const {rows:events}=await db.query('SELECT actor_id,action,details,created_at FROM workspace_events WHERE workspace_id=$1 ORDER BY id DESC LIMIT 100',[workspaceId]);
 return {...w,branches,events,remote:`git@github.com:${w.org_name}/${w.repo_name}.git`,privilegedAccess:'Organization owners, enterprise administrators and authorized Apps may have access.'};
}
export async function listWorkspaces(user:any,repoId:string) {
 await repoAdmin(user,repoId);
 return (await db.query('SELECT id,name,status,checked_at,issue,allowed_users,allowed_ids,group_ids FROM workspaces WHERE parent_repo_id=$1 ORDER BY id',[repoId])).rows;
}
export async function updateWorkspace(user:any,workspaceId:string,input:unknown) {
 const d=audienceInput.parse(input);const w=await row(workspaceId);const {repo}=await repoAdmin(user,w.parent_repo_id);
 const explicitIds=await explicitMembers(repo,d.allow);
 await locked(workspaceId,async client=>{
  await client.query('BEGIN');
  const updated=await client.query(`UPDATE workspaces SET allowed_users=$2,group_ids=$3,explicit_ids=$4,status='pending',issue=NULL,retry_after=now() WHERE id=$1 AND status<>'archived' AND NOT archive_requested`,[workspaceId,JSON.stringify(d.allow),JSON.stringify(d.groups),JSON.stringify(explicitIds)]);
  if(!updated.rowCount)throw new Error('workspace is archived');
  await event(client,workspaceId,user.id,'AUDIENCE_UPDATED',d);
  await client.query('COMMIT');
 });
 await reconcileWorkspace(workspaceId);return workspaceInfo(user,workspaceId);
}
export async function requireWorkspace(workspaceId:string,client?:import('pg').PoolClient) {
 const w=await row(workspaceId,client);
 if(w.archive_requested || w.status!=='ready' || !w.checked_at || Date.now()-w.checked_at.getTime()>600_000)throw new Error('workspace access verification pending');
 return w;
}
export async function workspaceBranch(user:any,repoId:string,workspaceId:string,name:string) {
 await repoAdmin(user,repoId);
 return locked(workspaceId,async client=>{
  const w=await requireWorkspace(workspaceId,client);
  if(String(w.parent_repo_id)!==String(repoId))throw new Error('workspace belongs to another repository');
  if(!w.allowed_ids.includes(Number(user.github_id)))throw new Error('workspace membership required');
  const {rows:[branch]}=await client.query(`INSERT INTO shadow_repos(parent_repo_id,github_repo_id,repo_name,branch_name,creator_id,allowed_users,allowed_ids,status,workspace_id)
  VALUES($1,NULL,$2,$3,$4,$5,$6,'ready',$7) RETURNING id`,[repoId,w.repo_name,name,user.id,JSON.stringify(w.allowed_ids.map((accountId:number)=>w.member_sources[String(accountId)].login)),JSON.stringify(w.allowed_ids),workspaceId]);
  return {id:branch.id,workspace:workspaceId,remote:`git@github.com:${w.org_name}/${w.repo_name}.git`,branch:name};
 });
}

export async function reconcileWorkspace(workspaceId:string) {
 await locked(workspaceId,async client=>{
  const w=await row(workspaceId,client);if(w.status==='archived')return;
  await client.query("UPDATE workspaces SET status='pending' WHERE id=$1",[workspaceId]);
  try {
   const gh=await app.getInstallationOctokit(Number(w.installation_id));
   const {data:org}=await gh.rest.orgs.get({org:w.org_name});
   if(org.default_repository_permission!=='none')throw new Error('organization base permission drift');
   const users=new Map<number,string>();
   const sources:Record<string,string[]>={};
   for(const accountId of (w.archive_requested?[]:w.explicit_ids)) {
    const {data:u}=await gh.request('GET /user/{account_id}',{account_id:Number(accountId)});users.set(Number(u.id),u.login);sources[String(u.id)]=['Explicit membership'];
   }
   for(const groupId of (w.archive_requested?[]:w.group_ids)) {
    const g=await workspaceTeam(w.parent_repo_id,groupId,w.org_name,gh,client);
    for(const u of await gh.paginate(gh.rest.teams.listMembersInOrg,{org:w.org_name,team_slug:g.github_team_slug})){users.set(u.id,u.login);(sources[String(u.id)]??=[]).push(g.name);}
   }
   if(w.archive_requested)users.clear();
   for(const accountId of w.revoked_ids)users.delete(accountId);
   for(const [accountId,login] of users) {
    try {
     await gh.rest.orgs.checkMembershipForUser({org:w.org_name,username:login});
     const {data:p}=await gh.rest.repos.getCollaboratorPermissionLevel({owner:w.org_name,repo:w.parent_name,username:login});
     if(p.permission==='none')users.delete(accountId);
    }catch(error){if((error as {status?:number}).status===404)users.delete(accountId);else throw error;}
   }
   if(!w.github_repo_id) {
    // Recover a repository created before a crash only when its unique name and
    // workspace marker match; never adopt an unrelated repository.
    let info;
    try {info=(await gh.rest.repos.get({owner:w.org_name,repo:w.repo_name})).data;}
    catch(error){if((error as {status?:number}).status!==404)throw error;}
    const marker=`Better Git workspace ${workspaceId}`;
    if(info && info.description!==marker)throw new Error('workspace repository identity mismatch');
    info ??= (await gh.rest.repos.createInOrg({org:w.org_name,name:w.repo_name,private:true,auto_init:false,description:marker,has_issues:false,has_projects:false,has_wiki:false})).data;
    w.github_repo_id=info.id;
    await client.query('UPDATE workspaces SET github_repo_id=$2 WHERE id=$1',[workspaceId,info.id]);
   }
   const target={owner:w.org_name,repo:w.repo_name};
   const {data:info}=await gh.rest.repos.get(target);
   if(info.id!==Number(w.github_repo_id) || !info.private || info.fork)throw new Error('workspace repository privacy or identity drift');
   if(info.allow_forking!==false) {
    const {data:updated}=await gh.rest.repos.update({...target,allow_forking:false});
    if(updated.allow_forking!==false)throw new Error('workspace repository privacy or identity drift');
   }
   // Teams are audience sources, never direct repository grants: materializing
   // membership lets us enforce parent access and offboarding tombstones.
   for(const team of await gh.paginate(gh.rest.repos.listTeams,target))await gh.rest.teams.removeRepoInOrg({org:w.org_name,team_slug:team.slug,owner:w.org_name,repo:w.repo_name});
   const before=await gh.paginate(gh.rest.repos.listCollaborators,{...target,affiliation:'direct'});
   const owners=new Set<number>();
   for(const u of before) {
    if(users.has(u.id))continue;
    if(u.permissions?.admin) {
     try {
      const {data:membership}=await gh.rest.orgs.getMembershipForUser({org:w.org_name,username:u.login});
      if(membership.role==='admin' && membership.state==='active') {owners.add(u.id);continue;}
     } catch(error) {if((error as {status?:number}).status!==404)throw error;}
    }
    await gh.rest.repos.removeCollaborator({...target,username:u.login});
   }
   for(const invite of await gh.paginate(gh.rest.repos.listInvitations,target)) {
    if(!invite.invitee || !users.has(invite.invitee.id))await gh.rest.repos.deleteInvitation({...target,invitation_id:invite.id});
   }
   for(const [accountId,login] of users)if(!before.some(u=>u.id===accountId && u.permissions?.push))await gh.rest.repos.addCollaborator({...target,username:login,permission:'push'});
   const actual=await gh.paginate(gh.rest.repos.listCollaborators,{...target,affiliation:'direct'});
   const teams=await gh.paginate(gh.rest.repos.listTeams,target);
   const invites=await gh.paginate(gh.rest.repos.listInvitations,target);
   if(teams.length || invites.length || actual.some(u=>!users.has(u.id) && !owners.has(u.id)) || [...users.keys()].some(accountId=>!actual.some(u=>u.id===accountId && u.permissions?.push)))throw new Error('workspace permissions not yet applied');
   const removed=[];
   for(const accountId of w.allowed_ids) {
    if(users.has(accountId) || owners.has(accountId))continue;
    const {data:account}=await gh.request('GET /user/{account_id}',{account_id:accountId});
    const {data:companion}=await gh.rest.repos.getCollaboratorPermissionLevel({...target,username:account.login});
    if(companion.permission!=='none')throw new Error('removed member still has companion access');
    const {data:parent}=await gh.rest.repos.getCollaboratorPermissionLevel({owner:w.org_name,repo:w.parent_name,username:account.login});
    removed.push({login:account.login,parent:parent.permission,companion:companion.permission});
   }
   if(w.archive_requested)await gh.rest.repos.update({...target,archived:true});
   await client.query('BEGIN');
   await client.query(`UPDATE workspaces SET allowed_ids=$2,member_sources=$3,status=CASE WHEN archive_requested THEN 'archived' ELSE 'ready' END,checked_at=now(),retry_after=now()+interval '5 minutes',issue=NULL WHERE id=$1`,[workspaceId,JSON.stringify([...users.keys()]),JSON.stringify(Object.fromEntries([...users].map(([accountId,login])=>[accountId,{login,sources:sources[String(accountId)]}])))]);
   await client.query('UPDATE shadow_repos SET allowed_users=$2,allowed_ids=$3 WHERE workspace_id=$1',[workspaceId,JSON.stringify([...users.values()]),JSON.stringify([...users.keys()])]);
   await event(client,workspaceId,null,w.archive_requested?'ARCHIVED':'ACCESS_VERIFIED');
   if(removed.length)await event(client,workspaceId,null,'MEMBER_ACCESS_REMOVED',{members:removed});
   await client.query('COMMIT');
  }catch(error){
   await client.query('ROLLBACK');
   const known=['organization base permission drift','workspace group unavailable','workspace team identity changed','workspace repository identity mismatch','workspace repository privacy or identity drift','workspace permissions not yet applied','removed member still has companion access'];
   const issue=error instanceof Error && known.includes(error.message)?error.message:'GitHub access verification failed';
   await client.query("UPDATE workspaces SET status='blocked',issue=$2,retry_after=now()+interval '1 minute' WHERE id=$1",[workspaceId,issue]);
   await event(client,workspaceId,null,'ACCESS_BLOCKED');
  }
 });
}
export async function drainWorkspaceReconciliation() {
 // Lease a bounded batch across replicas; abandoned claims become due again.
 const {rows}=await db.query(`UPDATE workspaces SET retry_after=now()+interval '5 minutes'
 WHERE id IN (SELECT id FROM workspaces WHERE status<>'archived' AND retry_after<=now()
 ORDER BY retry_after,id LIMIT 4 FOR UPDATE SKIP LOCKED) RETURNING id`);
 const results=await Promise.allSettled(rows.map(w=>reconcileWorkspace(String(w.id))));
 const failures=results.filter((r):r is PromiseRejectedResult=>r.status==='rejected');
 if(failures.length)throw new AggregateError(failures.map(r=>r.reason),'workspace reconciliation failed');
}
export async function revokeWorkspaceAccess(githubId:number,org:string,repository?:number,requireParentAccessLoss=false) {
 const {rows}=await db.query(`SELECT w.id FROM workspaces w JOIN repos r ON r.id=w.parent_repo_id
 WHERE r.org_name=$1 AND w.status<>'archived' AND (w.allowed_ids @> $2::jsonb OR w.revoked_ids @> $2::jsonb) AND ($3::bigint IS NULL OR r.github_repo_id=$3)`,[org,JSON.stringify([githubId]),repository??null]);
 const failures:unknown[]=[];
 for(const {id:workspaceId} of rows) {
  try {
  const w=await row(workspaceId);
  if(requireParentAccessLoss){
   const gh=await app.getInstallationOctokit(Number(w.installation_id));
   const parent=await gh.paginate(gh.rest.repos.listCollaborators,{owner:org,repo:w.parent_name});
   if(parent.some(u=>u.id===githubId))continue;
  }
  await locked(String(workspaceId),async client=>{
   await client.query('BEGIN');
   await client.query("UPDATE workspaces SET revoked_ids=CASE WHEN revoked_ids @> $2::jsonb THEN revoked_ids ELSE revoked_ids || $2::jsonb END,status='pending',retry_after=now() WHERE id=$1",[workspaceId,JSON.stringify([githubId])]);
   await event(client,String(workspaceId),null,'MEMBER_REVOKED_ROTATION_REQUIRED',{githubId});
   await client.query('COMMIT');
  });
  await reconcileWorkspace(String(workspaceId));
  if((await row(workspaceId)).status!=='ready')throw new Error('workspace revocation pending');
  }catch(error){failures.push(error);}
 }
 if(failures.length)throw new AggregateError(failures,'some workspace revocations require retry');
}

export async function archiveWorkspace(user:any,workspaceId:string) {
 const w=await row(workspaceId);await repoAdmin(user,w.parent_repo_id);
 await locked(workspaceId,async client=>{
  await client.query('BEGIN');
  await client.query("UPDATE workspaces SET archive_requested=true,status='pending',retry_after=now() WHERE id=$1 AND status<>'archived'",[workspaceId]);
  await event(client,workspaceId,user.id,'ARCHIVE_REQUESTED');
  await client.query('COMMIT');
 });
 await reconcileWorkspace(workspaceId);return workspaceInfo(user,workspaceId);
}
