import {randomBytes} from 'node:crypto';
import {db,app,repositoryPermission} from './service.js';
import {z} from 'zod';
export const shadowInput=z.object({name:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),allow:z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/)).min(1).max(50)}).strict();
async function repoAdmin(user:any,repoId:string) {
 const {rows}=await db.query('SELECT * FROM repos WHERE id=$1',[repoId]);const repo=rows[0];if(!repo) throw new Error('repository unavailable');
 const {gh,permission}=await repositoryPermission(repo,user.github_id,user.github_username);
 if(permission!=='admin') throw new Error('administrator required');return {repo,gh};
}
export async function createShadow(user:any,repoId:string,input:unknown) {
 const d=shadowInput.parse(input);const {repo,gh}=await repoAdmin(user,repoId);
 const {data:org}=await gh.rest.orgs.get({org:repo.org_name});
 if(org.default_repository_permission!=='none') throw new Error('shadow repos require organization base permission none');
 const allowed=[...new Set([...d.allow,user.github_username])];
 const allowedIds:number[]=[];
 for(const username of allowed) {
   const {data:identity}=await gh.rest.users.getByUsername({username});allowedIds.push(identity.id);
   await gh.rest.orgs.checkMembershipForUser({org:repo.org_name,username});
   const {data:permission}=await gh.rest.repos.getCollaboratorPermissionLevel({owner:repo.org_name,repo:repo.repo_name,username});
   if(permission.permission==='none') throw new Error('shadow users must already read the parent repository');
 }
 const name=`bettergit-${randomBytes(16).toString('hex')}`;
 const {rows}=await db.query('INSERT INTO shadow_repos(parent_repo_id,github_repo_id,repo_name,branch_name,creator_id,allowed_users,allowed_ids) VALUES($1,NULL,$2,$3,$4,$5,$6) RETURNING id',[repoId,name,d.name,user.id,JSON.stringify(allowed),JSON.stringify(allowedIds)]);
 const id=rows[0].id;
 try {
  const {data:shadow}=await gh.rest.repos.createInOrg({org:repo.org_name,name,private:true,auto_init:false,description:'Better Git restricted collaboration',has_issues:false,has_projects:false,has_wiki:false});
  await db.query('UPDATE shadow_repos SET github_repo_id=$1 WHERE id=$2',[shadow.id,id]);
  await gh.rest.repos.update({owner:repo.org_name,repo:name,allow_forking:false});
  for(const username of allowed) await gh.rest.repos.addCollaborator({owner:repo.org_name,repo:name,username,permission:'push'});
  await db.query("UPDATE shadow_repos SET status='ready' WHERE id=$1",[id]);
  return {id,remote:`git@github.com:${repo.org_name}/${name}.git`,branch:d.name};
 }catch(e){try {await gh.rest.repos.delete({owner:repo.org_name,repo:name});}catch{};await db.query("UPDATE shadow_repos SET status='failed' WHERE id=$1",[id]);throw e;}
}
export async function publishShadow(user:any,shadowId:string,head:string,base:string,headSha:string,baseSha:string,tipSha:string) {
 if([headSha,baseSha,tipSha].some(s=>typeof s!=='string' || !/^[0-9a-f]{40}$/.test(s)))throw new Error('exact publication SHAs required');
 if(typeof head!=='string' || typeof base!=='string') throw new Error('invalid publication');
 if(!/^bettergit\/publish\/[a-zA-Z0-9_-]+$/.test(head) || !/^[a-zA-Z0-9_./-]+$/.test(base)) throw new Error('invalid publication branch');
 const {rows}=await db.query("SELECT * FROM shadow_repos WHERE id=$1 AND status IN ('ready','published')",[shadowId]);const shadow=rows[0];if(!shadow) throw new Error('shadow unavailable');
 const {repo,gh}=await repoAdmin(user,shadow.parent_repo_id);
 if(!shadow.allowed_ids.includes(Number(user.github_id))) throw new Error('not allowed');
 if(shadow.status==='published') {
   const number=Number(shadow.publish_pr?.split('/').at(-1));if(!Number.isSafeInteger(number))throw new Error('invalid recorded PR');
   const {data:pr}=await gh.rest.pulls.get({owner:repo.org_name,repo:repo.repo_name,pull_number:number});
   if(pr.head.sha!==headSha || pr.head.ref!==head)throw new Error('publication differs from recorded PR');
   return {url:pr.html_url};
 }
 await authorizePublish(user,shadowId);
 const {data:tip}=await gh.rest.repos.getCommit({owner:repo.org_name,repo:shadow.repo_name,ref:shadow.branch_name});
 const {data:commit}=await gh.rest.repos.getCommit({owner:repo.org_name,repo:repo.repo_name,ref:head});
 const {data:baseCommit}=await gh.rest.repos.getCommit({owner:repo.org_name,repo:repo.repo_name,ref:base});
 const comparison=await gh.rest.repos.compareCommitsWithBasehead({owner:repo.org_name,repo:shadow.repo_name,basehead:`${baseCommit.sha}...${tip.sha}`});
 if(!['ahead','identical'].includes(comparison.data.status)) throw new Error('shadow must contain current public base');
 if(tip.sha!==tipSha || commit.sha!==headSha || baseCommit.sha!==baseSha)throw new Error('publication refs changed');
 if(tip.commit.tree.sha!==commit.commit.tree.sha) throw new Error('publication differs from shadow tip');
 if(commit.parents.length!==1 || commit.parents[0]?.sha!==baseCommit.sha) throw new Error('publication must be a single squash commit atop the current base');
 const existing=await gh.rest.pulls.list({owner:repo.org_name,repo:repo.repo_name,head:`${repo.org_name}:${head}`,base,state:'open'});
 const prior=existing.data.find(pr=>pr.head.sha===headSha);
 const pr=prior ?? (await gh.rest.pulls.create({owner:repo.org_name,repo:repo.repo_name,head,base,title:`Publish ${shadow.branch_name}`,body:'Squashed publication of restricted work. Private history remains in its companion repository.'})).data;
 if(pr.head.sha!==headSha || pr.base.sha!==baseSha)throw new Error('PR does not match approved publication; inspect public ref before retrying');
 await db.query("UPDATE shadow_repos SET status='published',publish_pr=$1 WHERE id=$2",[pr.html_url,shadowId]);return {url:pr.html_url};
}

export async function authorizePublish(user:any,shadowId:string) {
 const {rows}=await db.query("SELECT * FROM shadow_repos WHERE id=$1 AND status='ready'",[shadowId]);const shadow=rows[0];if(!shadow) throw new Error('shadow unavailable');
 const {repo,gh}=await repoAdmin(user,shadow.parent_repo_id);
 if(!shadow.allowed_ids.includes(Number(user.github_id))) throw new Error('not allowed');
 const {data:org}=await gh.rest.orgs.get({org:repo.org_name});if(org.default_repository_permission!=='none') throw new Error('privacy drift');
 const {data:info}=await gh.rest.repos.get({owner:repo.org_name,repo:shadow.repo_name});if(info.id!==Number(shadow.github_repo_id) || !info.private || info.fork) throw new Error('shadow privacy changed');
 const teams=await gh.paginate(gh.rest.repos.listTeams,{owner:repo.org_name,repo:shadow.repo_name});if(teams.length) throw new Error('unexpected team access');
 const collaborators=await gh.paginate(gh.rest.repos.listCollaborators,{owner:repo.org_name,repo:shadow.repo_name,affiliation:'direct'});
 if(collaborators.some(c=>!shadow.allowed_ids.includes(c.id) && !c.permissions?.admin)) throw new Error('unexpected collaborator');
 return {shadow,repo,gh};
}

export async function revokeShadows(githubId:number,org:string,repository?:number,requireParentAccessLoss=false) {
 const {rows}=await db.query("SELECT s.*,r.org_name,r.repo_name AS parent_name,r.installation_id FROM shadow_repos s JOIN repos r ON r.id=s.parent_repo_id WHERE r.org_name=$1 AND s.status IN ('ready','published') AND s.allowed_ids @> $2::jsonb AND ($3::bigint IS NULL OR r.github_repo_id=$3) ORDER BY s.id",[org,JSON.stringify([githubId]),repository??null]);
 const failures:unknown[]=[];
 for(const shadow of rows) {
  try {
  const gh=await app.getInstallationOctokit(Number(shadow.installation_id));
  if(requireParentAccessLoss) {
   const parent=await gh.paginate(gh.rest.repos.listCollaborators,{owner:org,repo:shadow.parent_name});
   if(parent.some(c=>c.id===githubId)) continue;
  }
  const collaborators=await gh.paginate(gh.rest.repos.listCollaborators,{owner:org,repo:shadow.repo_name,affiliation:'direct'});
  const login=collaborators.find(c=>c.id===githubId)?.login;
  if(login) {
   try {await gh.rest.repos.removeCollaborator({owner:org,repo:shadow.repo_name,username:login});}
   catch(e) {if((e as {status?:number}).status!==404) throw e;}
  }
  const invites=await gh.paginate(gh.rest.repos.listInvitations,{owner:org,repo:shadow.repo_name});
  for(const invitation of invites) if(invitation.invitee?.id===githubId) {
   try {await gh.rest.repos.deleteInvitation({owner:org,repo:shadow.repo_name,invitation_id:invitation.id});}
   catch(e) {if((e as {status?:number}).status!==404) throw e;}
  }
  await db.query(`WITH removed AS (
    UPDATE shadow_repos SET
      allowed_ids=(SELECT coalesce(jsonb_agg(entry ORDER BY ord),'[]'::jsonb)
        FROM jsonb_array_elements(allowed_ids) WITH ORDINALITY AS x(entry,ord) WHERE entry<>to_jsonb($1::bigint)),
      allowed_users=(SELECT coalesce(jsonb_agg(allowed_users->((ord-1)::int) ORDER BY ord),'[]'::jsonb)
        FROM jsonb_array_elements(allowed_ids) WITH ORDINALITY AS x(entry,ord) WHERE entry<>to_jsonb($1::bigint))
    WHERE id=$2 AND allowed_ids @> $3::jsonb RETURNING parent_repo_id
  ) INSERT INTO audit_logs(user_id,repo_id,action,details)
    SELECT u.id,r.parent_repo_id,'ACCESS_REVOKED',$4 FROM removed r JOIN users u ON u.github_id=$1::bigint`,
    [githubId,shadow.id,JSON.stringify([githubId]),JSON.stringify({shadowId:shadow.id,kind:'shadow access revoked',rotationRequired:true})]);
  } catch(e) {failures.push(e);}
 }
 if(failures.length) throw new AggregateError(failures,'some shadow revocations require retry');
}

// Joining requires current membership and immutable allow-list identity, not admin access.
export async function joinShadow(user:any,shadowId:string) {
 const {rows}=await db.query("SELECT s.*,r.org_name,r.repo_name AS parent_name,r.installation_id,r.baseline_sha,r.github_repo_id AS parent_github_repo_id FROM shadow_repos s JOIN repos r ON r.id=s.parent_repo_id WHERE s.id=$1 AND s.status='ready'",[shadowId]);
 const shadow=rows[0];if(!shadow || !shadow.allowed_ids.includes(Number(user.github_id)))throw new Error('shadow unavailable');
 const {gh,permission}=await repositoryPermission({github_repo_id:shadow.parent_github_repo_id,org_name:shadow.org_name,repo_name:shadow.parent_name,installation_id:shadow.installation_id},user.github_id,user.github_username);
 await gh.rest.orgs.checkMembershipForUser({org:shadow.org_name,username:user.github_username});
 if(!['read','triage','write','maintain','admin'].includes(permission))throw new Error('parent read access required');
 const {data:org}=await gh.rest.orgs.get({org:shadow.org_name});if(org.default_repository_permission!=='none')throw new Error('privacy drift');
 const {data:info}=await gh.rest.repos.get({owner:shadow.org_name,repo:shadow.repo_name});if(info.id!==Number(shadow.github_repo_id) || !info.private || info.fork)throw new Error('privacy drift');
 return {id:shadow.id,baseline:shadow.baseline_sha,repo:String(shadow.parent_repo_id),remote:`git@github.com:${shadow.org_name}/${shadow.repo_name}.git`,branch:shadow.branch_name};
}
