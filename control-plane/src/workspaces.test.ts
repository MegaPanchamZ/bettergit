import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';

test('workspace migration, shared branches, reconciliation and durable revocation',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const schema='workspace_'+randomBytes(8).toString('hex');
 const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema}`);
 process.env.DATABASE_URL=url.toString();process.env.GITHUB_APP_ID='1';process.env.GITHUB_PRIVATE_KEY='test';process.env.GITHUB_WEBHOOK_SECRET='test';
 const {app,db}=await import('./service.js');
 const original=app.getInstallationOctokit;
 const originalInstallation=app.octokit.rest.apps.getOrgInstallation;
 try {
  for(const file of ['schema','phase2','phase3','guard-checkpoints','team-identity','team-identity-enforcement','guard-deliveries','delivery-reliability'])await db.query(await readFile(new URL(`../${file}.sql`,import.meta.url),'utf8'));
  await db.query("INSERT INTO users(github_id,github_username) VALUES(1,'owner')");
  await db.query("INSERT INTO repos(github_repo_id,org_name,repo_name,installation_id,approved_policy,baseline_sha) VALUES(1,'acme','parent',1,'policy','base')");
  await db.query("INSERT INTO shadow_repos(parent_repo_id,github_repo_id,repo_name,branch_name,creator_id,allowed_users,allowed_ids,status) VALUES(1,20,'legacy','secret',1,'[\"owner\"]','[1]','ready')");
  await db.query(await readFile(new URL('../workspaces.sql',import.meta.url),'utf8'));
  assert.equal((await db.query('SELECT workspace_id FROM shadow_repos')).rows[0].workspace_id,'1');
  const {createWorkspace,workspaceBranch,reconcileWorkspace,requireWorkspace,updateWorkspace,revokeWorkspaceAccess,drainWorkspaceReconciliation,workspaceInfo,archiveWorkspace,branchJoinLink,reinstateWorkspaceMember}=await import('./workspaces.js');
  const {offboard}=await import('./offboarding.js');
  await assert.rejects(()=>requireWorkspace('1'),/pending/);
  const accounts=[{id:1,login:'owner'},{id:2,login:'alice'},{id:3,login:'intruder'},{id:4,login:'departed'},{id:5,login:'other-admin'}];
  type Account={id:number;login:string;permissions:{push:boolean;admin?:boolean}};
  const collaborators=new Map<string,Account[]>();
  const repositories=new Map<string,{id:number;private:boolean;fork:boolean;description:string}>();
  const deletedAccountIds=new Set<number>();
  let creates=0,unavailable=false,removeFails=false,teamId=101,unexpectedTeam=false,unexpectedInvitation=false,basePermission='none',parentAlice=true;
  let teamMembers=[accounts[1]!];
  let seeded=false;
  let appAdministration='write';
  let retainCompanionAccess=false;
  let pauseRepositoryRead:(()=>Promise<void>)|undefined;
  let pauseBranchRead:(()=>Promise<void>)|undefined;
  let paginateCalls=0;
  app.octokit.rest.apps.getOrgInstallation=(async()=>({data:{id:1,permissions:{
   administration:appAdministration,organization_administration:'read',members:'read',contents:'read',
  }}})) as unknown as typeof originalInstallation;
  const listCollaborators=()=>{},listTeams=()=>{},listInvitations=()=>{},listMembersInOrg=()=>{};
  const gh={request:async(_route:string,{account_id}:{account_id:number})=>{
   if(deletedAccountIds.has(account_id))throw Object.assign(new Error('not found'),{status:404});
   const found=accounts.find(u=>u.id===account_id);
   if(!found)throw Object.assign(new Error('not found'),{status:404});
   return {data:found};
  },rest:{
   git:{getRef:async()=>{if(!seeded)throw Object.assign(new Error('missing'),{status:404});await pauseBranchRead?.();}},
   users:{getByUsername:async({username}:{username:string})=>{
    const found=accounts.find(u=>u.login===username && !deletedAccountIds.has(u.id));
    if(!found)throw Object.assign(new Error('not found'),{status:404});
    return {data:found};
   }},
   orgs:{get:async()=>({data:{default_repository_permission:basePermission}}),checkMembershipForUser:async()=>{},
    getMembershipForUser:async()=>({data:{role:'member',state:'active'}})},
   teams:{getByName:async()=>({data:{id:teamId,organization:{id:70}}}),listMembersInOrg,removeRepoInOrg:async()=>{unexpectedTeam=false;}},
   repos:{listCollaborators,listTeams,listInvitations,
    getCollaboratorPermissionLevel:async({repo,username}:{repo:string;username:string})=>{
     const found=accounts.find(u=>u.login===username && !deletedAccountIds.has(u.id));
     if(!found)throw Object.assign(new Error('not found'),{status:404});
     return {data:{permission:
      repo==='parent' ? (username===accounts[0]!.login||username==='other-admin')?'admin':username==='alice'&&!parentAlice?'none':'read'
        : collaborators.get(repo)?.some(u=>u.login===username)||retainCompanionAccess?'write':'none',
      user:{id:found.id}}};
    },
    createInOrg:async({name,description}:{name:string;description:string})=>{creates++;const info={id:100+creates,private:true,fork:false,description};repositories.set(name,info);return {data:info};},
   get:async({repo}:{repo:string})=>{
    if(repo==='parent')return {data:{id:1,owner:{id:70}}};
    await pauseRepositoryRead?.();const info=repositories.get(repo);if(!info)throw Object.assign(new Error('missing'),{status:404});return {data:{...info,allow_forking:false}};
   },
   update:async({allow_forking}:{allow_forking?:boolean})=>{assert.equal(allow_forking,undefined,'GitHub rejects toggling forks when the organization already disables them');},
    addCollaborator:async({repo,username}:{repo:string;username:string})=>{const u=accounts.find(u=>u.login===username)!;collaborators.set(repo,[...(collaborators.get(repo)??[]).filter(c=>c.id!==u.id),{...u,permissions:{push:true}}]);},
    removeCollaborator:async({repo,username}:{repo:string;username:string})=>{if(removeFails)throw new Error('permission removal failed');collaborators.set(repo,(collaborators.get(repo)??[]).filter(u=>u.login!==username));},
    deleteInvitation:async()=>{unexpectedInvitation=false;},
   }},
   paginate:async(method:unknown,{repo}:{repo:string})=>{
    paginateCalls++;
    if(method===listCollaborators)return repo==='parent'?accounts.filter(u=>u.id!==2||parentAlice):(collaborators.get(repo)??[]);
    if(method===listMembersInOrg)return teamMembers;
    if(method===listTeams)return unexpectedTeam?[{slug:'unexpected'}]:[];
    if(method===listInvitations)return unexpectedInvitation?[{id:1,invitee:accounts[2]}]:[];
    throw new Error('unexpected pagination');
   }};
  app.getInstallationOctokit=(async()=>{if(unavailable)throw new Error('provider down');return gh;}) as unknown as typeof app.getInstallationOctokit;
  const user={id:'1',github_id:1,github_username:'owner'};
  await assert.rejects(()=>createWorkspace({...user,github_id:2,github_username:'alice'},'1',{name:'forbidden',allow:['alice']}),/administrator/);
  appAdministration='read';
  await assert.rejects(()=>createWorkspace(user,'1',{name:'bad-app',allow:['owner']}),/Approve the Better Git App/);
  appAdministration='write';basePermission='read';
  await assert.rejects(()=>createWorkspace(user,'1',{name:'bad-default',allow:['owner']}),/base permissions to None/);
  basePermission='none';parentAlice=false;
  await assert.rejects(()=>createWorkspace(user,'1',{name:'bad-parent',allow:['alice']}),/Give @alice read access/);
  parentAlice=true;
  assert.equal((await db.query('SELECT count(*) FROM workspaces')).rows[0].count,'1');
  assert.equal(creates,0);
  const w=await createWorkspace(user,'1',{name:'legal',allow:['owner','alice']});
  assert.equal(w.status,'ready');assert.equal(creates,1);
  const first=await workspaceBranch(user,'1',w.id,'contract');
  const {joinShadow}=await import('./shadow.js');
  const alice={id:'2',github_id:2,github_username:'alice'};
  await assert.rejects(()=>branchJoinLink(user,first.id),/Push the restricted branch/);
  await assert.rejects(()=>joinShadow(alice,first.id),/Push the restricted branch/);
  seeded=true;
  assert.deepEqual(await branchJoinLink(user,first.id),{path:`/join/#${first.id}`});
  await assert.rejects(()=>branchJoinLink(alice,first.id),/administrator/);
  assert.equal((await joinShadow(alice,first.id)).parent,'acme/parent');
  let signalEntered!:()=>void, signalResume!:()=>void;
  const entered=new Promise<void>(resolve=>{signalEntered=resolve;});
  const resume=new Promise<void>(resolve=>{signalResume=resolve;});
  pauseRepositoryRead=async()=>{
   pauseRepositoryRead=undefined;
   signalEntered();
   await resume;
  };
  const routine=reconcileWorkspace(w.id);
  await Promise.race([entered,routine.then(()=>assert.fail('reconciliation did not reach the provider gate'))]);
  try {
   assert.equal((await joinShadow(alice,first.id)).parent,'acme/parent');
  } finally {
   signalResume();
   await routine;
  }
  const branchRead=new Promise<void>(resolve=>{signalEntered=resolve;});
  const finishBranchRead=new Promise<void>(resolve=>{signalResume=resolve;});
  pauseBranchRead=async()=>{signalEntered();await finishBranchRead;};
  const joining=joinShadow(alice,first.id);
  await Promise.race([branchRead,joining.then(()=>assert.fail('join did not reach the branch check'))]);
  try {
   await db.query("UPDATE workspaces SET status='pending' WHERE id=$1",[w.id]);
   signalResume();
   await assert.rejects(joining,/workspace access verification pending/);
  } finally {
   signalResume();
   pauseBranchRead=undefined;
  }
  await reconcileWorkspace(w.id);
  const second=await workspaceBranch(user,'1',w.id,'review');
  assert.equal(first.remote,second.remote);assert.notEqual(first.id,second.id);assert.equal(creates,1);
  const additional=await Promise.all(Array.from({length:298},(_,i)=>workspaceBranch(user,'1',w.id,`scale-${i+1}`)));
  assert.equal(new Set([first,second,...additional].map(branch=>branch.id)).size,300);
  assert(additional.every(branch=>branch.remote===first.remote));
  assert.equal(creates,1);
  await assert.rejects(()=>workspaceBranch(user,'2',w.id,'wrong'),/repository/);
  await assert.rejects(()=>workspaceBranch({...user,github_id:5,github_username:'other-admin'},'1',w.id,'wrong'),/membership/);
  unexpectedTeam=true;unexpectedInvitation=true;
  collaborators.get(w.repo_name)!.push({...accounts[2]!,permissions:{push:true,admin:true}});
  await reconcileWorkspace(w.id);
  assert(!collaborators.get(w.repo_name)!.some(u=>u.id===3));
  assert.equal(unexpectedTeam,false);assert.equal(unexpectedInvitation,false);
  removeFails=true;
  assert.equal((await updateWorkspace(user,w.id,{allow:['owner']})).status,'blocked');
  await assert.rejects(()=>requireWorkspace(w.id),/pending/);
  assert(collaborators.get(w.repo_name)!.some(u=>u.id===2));
  removeFails=false;retainCompanionAccess=true;await reconcileWorkspace(w.id);
  assert.equal((await workspaceInfo(user,w.id)).issue,'removed member still has companion access');
  retainCompanionAccess=false;await reconcileWorkspace(w.id);
  assert.deepEqual(collaborators.get(w.repo_name)!.map(u=>u.id),[1]);
  assert.deepEqual((await workspaceInfo(user,w.id)).events.find((e:{action:string})=>e.action==='MEMBER_ACCESS_REMOVED')?.details,
    {members:[{login:'alice',parent:'read',companion:'none'}]});
  await assert.rejects(()=>joinShadow(alice,first.id),/unavailable/);
  await db.query("INSERT INTO groups(repo_id,name,github_team_slug,github_team_id) VALUES(1,'github-team:legal','legal',101)");
  assert.equal((await updateWorkspace(user,w.id,{allow:['owner'],groups:['1']})).status,'ready');
  assert(collaborators.get(w.repo_name)!.some(u=>u.id===2));
  parentAlice=false;await reconcileWorkspace(w.id);
  assert(!collaborators.get(w.repo_name)!.some(u=>u.id===2));
  parentAlice=true;await reconcileWorkspace(w.id);
  assert(collaborators.get(w.repo_name)!.some(u=>u.id===2));
  teamId=202;await reconcileWorkspace(w.id);
  assert.equal((await workspaceInfo(user,w.id)).issue,'workspace team identity changed');
  await assert.rejects(()=>requireWorkspace(w.id),/pending/);
  teamId=101;await reconcileWorkspace(w.id);
  const other=await createWorkspace(user,'1',{name:'second-audience',allow:['owner','alice']});
  removeFails=true;
  await assert.rejects(()=>revokeWorkspaceAccess(2,'acme'),/require retry/);
  for(const entry of [w,other]){
   const details=await workspaceInfo(user,entry.id);
   assert.equal(details.status,'blocked');
   assert.deepEqual(details.revoked_ids,[2]);
   assert(collaborators.get(entry.repo_name)!.some(u=>u.id===2));
  }
  removeFails=false;
  await db.query("UPDATE workspaces SET retry_after='infinity'");
  await db.query('UPDATE workspaces SET retry_after=now() WHERE id=ANY($1::bigint[])',[[w.id,other.id]]);
  assert.equal(await drainWorkspaceReconciliation(),2);
  await revokeWorkspaceAccess(2,'acme');
  for(const entry of [w,other]){
   assert(!collaborators.get(entry.repo_name)!.some(u=>u.id===2));
   const details=await workspaceInfo(user,entry.id);
   assert.equal(details.events.filter((event:{action:string})=>event.action==='MEMBER_REVOKED_ROTATION_REQUIRED').length,1);
  }
  await reconcileWorkspace(w.id);assert(!collaborators.get(w.repo_name)!.some(u=>u.id===2));
  assert.deepEqual((await db.query('SELECT allowed_ids FROM shadow_repos WHERE workspace_id=$1',[w.id])).rows.map(r=>r.allowed_ids),Array.from({length:300},()=>[1]));
  accounts[0]!.login='renamed-owner';user.github_username='renamed-owner';
  await reconcileWorkspace(w.id);
  assert.equal((await workspaceInfo(user,w.id)).member_sources['1'].login,'renamed-owner');
  basePermission='read';await reconcileWorkspace(w.id);assert.equal((await workspaceInfo(user,w.id)).status,'blocked');
  basePermission='none';unavailable=true;await reconcileWorkspace(w.id);
  assert.equal((await db.query('SELECT status FROM workspaces WHERE id=$1',[w.id])).rows[0].status,'blocked');
  unavailable=false;await reconcileWorkspace(w.id);await requireWorkspace(w.id);
  await db.query("UPDATE workspaces SET checked_at=now()-interval '11 minutes' WHERE id=$1",[w.id]);
  await assert.rejects(()=>requireWorkspace(w.id),/pending/);
  // updateWorkspace validates groups before writing and blocks silently re-adding revoked members.
  await assert.rejects(()=>updateWorkspace(user,other.id,{allow:['renamed-owner'],groups:['999']}),/workspace group unavailable/);
  assert.equal((await workspaceInfo(user,other.id)).status,'ready');
  await assert.rejects(()=>updateWorkspace(user,other.id,{allow:['renamed-owner','alice']}),/Reinstate offboarded members/);
  // Explicit reinstatement verifies current GitHub membership, removes tombstone, and restores access.
  const reinstated=await reinstateWorkspaceMember(user,other.id,2);
  assert.deepEqual(reinstated.revoked_ids,[]);
  assert(reinstated.allowed_ids.includes(2));
  assert(reinstated.events.some((e:{action:string})=>e.action==='MEMBER_REINSTATED'));
  // Clean no-mutation reconciliation skips redundant second-pass list pagination (3 calls instead of 6).
  const callsBefore=paginateCalls;
  await reconcileWorkspace(other.id);
  assert.equal(paginateCalls-callsBefore,3);
  // Team-removal webhook marks team workspaces pending immediately even when the user retains parent read access.
  const teamWs=await createWorkspace(user,'1',{name:'team-only',allow:['renamed-owner'],groups:['1']});
  assert.equal(teamWs.status,'ready');
  assert(teamWs.allowed_ids.includes(2));
  teamMembers=[];
  await offboard(2,'acme',101,'team-remove-delivery',undefined,1);
  assert.equal((await db.query('SELECT status FROM workspaces WHERE id=$1',[teamWs.id])).rows[0].status,'pending');
  await reconcileWorkspace(teamWs.id);
  assert(!collaborators.get(teamWs.repo_name)!.some(u=>u.id===2));
  // Team-deletion webhook marks team workspaces pending even when no member ever fetched a DEK.
  await offboard(null,'acme',101,'team-delete-delivery',undefined,1);
  assert.equal((await db.query('SELECT status FROM workspaces WHERE id=$1',[teamWs.id])).rows[0].status,'pending');
  teamMembers=[accounts[1]!];
  await reconcileWorkspace(teamWs.id);
  // A deleted GitHub account (404) does not permanently brick reconciliation or archiving.
  const delWs=await createWorkspace(user,'1',{name:'deleted-member',allow:['renamed-owner','departed']});
  assert.equal(delWs.status,'ready');
  deletedAccountIds.add(4);
  collaborators.set(delWs.repo_name,collaborators.get(delWs.repo_name)!.filter(u=>u.id!==4));
  await reconcileWorkspace(delWs.id);
  const afterDelete=await workspaceInfo(user,delWs.id);
  assert.equal(afterDelete.status,'ready');
  assert(!afterDelete.allowed_ids.includes(4));
  assert.equal((await archiveWorkspace(user,delWs.id)).status,'archived');
  const archived=await archiveWorkspace(user,w.id);
  assert.equal(archived.status,'archived');
  assert.equal(collaborators.get(w.repo_name)!.length,0);
  await assert.rejects(()=>requireWorkspace(w.id),/pending/);
  await assert.rejects(()=>updateWorkspace(user,w.id,{allow:['renamed-owner']}),/archived/);
  await reconcileWorkspace(w.id);
  assert.equal(collaborators.get(w.repo_name)!.length,0);
 }finally{
  app.getInstallationOctokit=original;app.octokit.rest.apps.getOrgInstallation=originalInstallation;await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
 }
});
