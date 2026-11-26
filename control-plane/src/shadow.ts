import {createWorkspace,workspaceBranch,requireWorkspace,requireBranchRef,revokeWorkspaceAccess} from './workspaces.js';
import {db,app} from './service.js';
import {z} from 'zod';
export const shadowInput=z.object({name:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),allow:z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/)).min(1).max(50)}).strict();
export async function repoAdmin(user:any,repoId:string) {
 const {rows}=await db.query('SELECT * FROM repos WHERE id=$1',[repoId]);const repo=rows[0];if(!repo) throw new Error('repository unavailable');
 const gh=await app.getInstallationOctokit(Number(repo.installation_id));
 const {data:permission}=await gh.rest.repos.getCollaboratorPermissionLevel({owner:repo.org_name,repo:repo.repo_name,username:user.github_username});
 if(permission.permission!=='admin') throw new Error('administrator required');return {repo,gh};
}
export async function createShadow(user:any,repoId:string,input:unknown) {
 const d=z.object({name:shadowInput.shape.name,allow:shadowInput.shape.allow.optional(),workspace:z.string().regex(/^\d+$/).optional()}).strict().parse(input);
 if(Boolean(d.allow)===Boolean(d.workspace)) throw new Error('choose allow or workspace');
 const workspace=d.workspace ?? String((await createWorkspace(user,repoId,{name:d.name,allow:[...d.allow!,user.github_username]})).id);
 return workspaceBranch(user,repoId,workspace,d.name);
}

export async function publishShadow(user:any,shadowId:string,head:string,base:string,headSha:string,baseSha:string,tipSha:string) {
 if([headSha,baseSha,tipSha].some(s=>typeof s!=='string' || !/^[0-9a-f]{40}$/.test(s)))throw new Error('exact publication SHAs required');
 if(typeof head!=='string' || typeof base!=='string') throw new Error('invalid publication');
 if(!/^bettergit\/publish\/[a-zA-Z0-9_-]+$/.test(head) || !/^[a-zA-Z0-9_./-]+$/.test(base)) throw new Error('invalid publication branch');
 const {rows}=await db.query("SELECT * FROM shadow_repos WHERE id=$1 AND status IN ('ready','published')",[shadowId]);const shadow=rows[0];if(!shadow) throw new Error('shadow unavailable');
 const {repo,gh}=await repoAdmin(user,shadow.parent_repo_id);
 const workspace=await requireWorkspace(shadow.workspace_id);
 if(!workspace.allowed_ids.includes(Number(user.github_id))) throw new Error('not allowed');
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
 const workspace=await requireWorkspace(shadow.workspace_id);
 if(!workspace.allowed_ids.includes(Number(user.github_id))) throw new Error('not allowed');
 const {data:org}=await gh.rest.orgs.get({org:repo.org_name});if(org.default_repository_permission!=='none') throw new Error('privacy drift');
 const {data:info}=await gh.rest.repos.get({owner:repo.org_name,repo:shadow.repo_name});if(!info.private || info.fork) throw new Error('shadow privacy changed');
 const teams=await gh.paginate(gh.rest.repos.listTeams,{owner:repo.org_name,repo:shadow.repo_name});if(teams.length) throw new Error('unexpected team access');
 const collaborators=await gh.paginate(gh.rest.repos.listCollaborators,{owner:repo.org_name,repo:shadow.repo_name,affiliation:'direct'});
 if(collaborators.some(c=>!shadow.allowed_ids.includes(c.id) && !c.permissions?.admin)) throw new Error('unexpected collaborator');
 return {shadow,repo,gh};
}

export async function revokeShadows(githubId:number,org:string,repository?:number,requireParentAccessLoss=false) {
 await revokeWorkspaceAccess(githubId,org,repository,requireParentAccessLoss);
}

// Joining requires current membership and immutable allow-list identity, not admin access.
export async function joinShadow(user:any,shadowId:string) {
 const {rows}=await db.query("SELECT s.*,r.org_name,r.repo_name AS parent_name,r.installation_id,r.baseline_sha FROM shadow_repos s JOIN repos r ON r.id=s.parent_repo_id WHERE s.id=$1 AND s.status='ready'",[shadowId]);
 const shadow=rows[0];if(!shadow || !shadow.allowed_ids.includes(Number(user.github_id)))throw new Error('shadow unavailable');
 const workspace=await requireWorkspace(shadow.workspace_id);
 if(!workspace.allowed_ids.includes(Number(user.github_id)))throw new Error('workspace membership required');
 const gh=await app.getInstallationOctokit(Number(shadow.installation_id));
 await gh.rest.orgs.checkMembershipForUser({org:shadow.org_name,username:user.github_username});
 const {data:permission}=await gh.rest.repos.getCollaboratorPermissionLevel({owner:shadow.org_name,repo:shadow.parent_name,username:user.github_username});
 if(permission.permission==='none')throw new Error('parent read access required');
 const {data:org}=await gh.rest.orgs.get({org:shadow.org_name});if(org.default_repository_permission!=='none')throw new Error('privacy drift');
 const {data:info}=await gh.rest.repos.get({owner:shadow.org_name,repo:shadow.repo_name});if(!info.private || info.fork || info.id!==Number(workspace.github_repo_id))throw new Error('privacy drift');
 await requireBranchRef(gh,{owner:shadow.org_name,repo:shadow.repo_name},shadow.branch_name);
 return {parent:`${shadow.org_name}/${shadow.parent_name}`,id:shadow.id,baseline:shadow.baseline_sha,repo:String(shadow.parent_repo_id),remote:`git@github.com:${shadow.org_name}/${shadow.repo_name}.git`,branch:shadow.branch_name};
}
