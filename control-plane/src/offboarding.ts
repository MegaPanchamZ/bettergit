import {parse} from 'yaml';
import {db} from './service.js';
import {drainDelivery,persistDelivery,retryJob} from './delivery-queue.js';
import {revokeShadows} from './shadow.js';

export async function offboard(
 githubId:number|null,
 org:string,
 team?:number,
 delivery?:string,
 repository?:number,
 installation?:number,
) {
 org=org.toLowerCase();
 const client=await db.connect();
 try {
  await client.query('BEGIN');
  const seen=delivery ? await client.query('INSERT INTO webhook_deliveries(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id',[delivery]) : null;
  // An organization login can be renamed and reused. Act only for the installation that enrolled it.
  const bound=installation===undefined ? null : await client.query('SELECT 1 FROM repos WHERE org_name=$1 AND installation_id=$2 LIMIT 1',[org,installation]);
  if((!seen || seen.rowCount) && (!bound || bound.rowCount)) {
   const {rows}=await client.query(`SELECT u.id AS user_id,u.github_id,r.github_repo_id,g.repo_id,g.id AS group_id,g.name,r.approved_policy
    FROM users u CROSS JOIN groups g JOIN repos r ON r.id=g.repo_id
    WHERE ($1::bigint IS NULL OR u.github_id=$1) AND r.org_name=$2
    AND ($3::bigint IS NULL OR g.github_team_id=$3)
    AND ($4::bigint IS NULL OR r.github_repo_id=$4)
    AND ($5::bigint IS NULL OR r.installation_id=$5)
    AND ($1::bigint IS NOT NULL OR EXISTS (
      SELECT 1 FROM wrapped_deks w WHERE w.user_id=u.id AND w.group_id=g.id
    ) OR EXISTS (
      SELECT 1 FROM audit_logs a WHERE a.user_id=u.id AND a.group_id=g.id AND a.action='DEK_FETCH'
    )) ORDER BY u.id,g.id`,[githubId,org,team??null,repository??null,installation??null]);
   const enqueue=async(id:number|string,repo:number|string,conditional:boolean)=>{
    await client.query(`INSERT INTO shadow_revocation_jobs(github_id,org_name,repository,require_parent_access_loss)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[id,org,repo,conditional]);
   };
   if(githubId!==null) await enqueue(githubId,repository??0,team!==undefined);
   for(const g of rows) {
    if(githubId===null) await enqueue(g.github_id,g.github_repo_id,true);
    await client.query('SELECT pg_advisory_xact_lock($1::int,$2::int)',[g.user_id,g.group_id]);
    const revoked=await client.query('INSERT INTO revocations(user_id,group_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING user_id',[g.user_id,g.group_id]);
    await client.query('DELETE FROM wrapped_deks WHERE user_id=$1 AND group_id=$2',[g.user_id,g.group_id]);
    if(!revoked.rowCount) continue;
    const {rows:exposures}=await client.query("SELECT min(timestamp) AS first_fetch,max(timestamp) AS last_fetch,count(*) AS fetches FROM audit_logs WHERE user_id=$1 AND group_id=$2 AND action='DEK_FETCH'",[g.user_id,g.group_id]);
    const policy=parse(g.approved_policy);
    const protectedPaths=(policy?.rules??[]).filter((r:any)=>Array.isArray(r.allow) && r.allow.includes(g.name)).map((r:any)=>r.path);
    const report={protectedPaths,group:g.name,exposure:exposures[0],rotationRequired:true,checklist:['Rotate every secret ever protected by this group during potential exposure.','Re-encrypt current protected files under a new group key.','Distribute new envelopes only to current members.','Previously fetched keys, Git history, and local plaintext remain accessible.'],groupId:g.group_id,scope:'Group-level potential exposure; key fetches do not prove individual file decryption.'};
    await client.query('INSERT INTO offboarding_reports(user_id,repo_id,report) VALUES($1,$2,$3)',[g.user_id,g.repo_id,report]);
    await client.query("INSERT INTO audit_logs(user_id,repo_id,group_id,action) VALUES($1,$2,$3,'ACCESS_REVOKED')",[g.user_id,g.repo_id,g.group_id]);
   }
  }
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}

}
// Claim across service replicas. A crashed worker leaves the job ready for retry.
export async function drainShadowRevocation() {
 const client=await db.connect();
 let failedId:string|undefined;
 try {
  await client.query('BEGIN');
  const {rows:[job]}=await client.query(`SELECT * FROM shadow_revocation_jobs
    WHERE failed_at IS NULL AND retry_after<=now() ORDER BY retry_after,id LIMIT 1 FOR UPDATE SKIP LOCKED`);
  if(job) {
   try {
    await revokeShadows(Number(job.github_id),job.org_name,Number(job.repository)||undefined,job.require_parent_access_loss);
    await client.query('DELETE FROM shadow_revocation_jobs WHERE id=$1',[job.id]);
   }catch {
    if(await retryJob(client,'shadow_revocation_jobs',job)) failedId=job.id;
   }
  }
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 if(failedId) console.error('Shadow revocation exhausted retries',failedId);
}

export async function enqueueOffboarding(id:string,event:string,p:any) {
 const org=p.organization?.login;
 const installation=p.installation?.id;
 if(typeof org!=='string' || !validId(installation)) return;
 const team=event==='team' || event==='membership' ? p.team?.id : undefined;
 const repository=event==='member' || p.action==='removed_from_repository' ? p.repository?.id : undefined;
 if((event==='team' || event==='membership') && !validId(team)) return;
 if((event==='member' || p.action==='removed_from_repository') && !validId(repository)) return;
 const member=event==='organization'?p.membership?.user?.id:p.member?.id;
 if(event!=='team' && !validId(member)) return;
 await persistDelivery(id,'offboarding',{githubId:event==='team'?null:member,org,team,repository,installation});
}
function validId(value:unknown) {
 return typeof value==='number' && Number.isSafeInteger(value) && value>0;
}

export function drainOffboardingDelivery() {
 return drainDelivery(true,job=>offboard(job.payload.githubId,job.payload.org,job.payload.team,job.id,job.payload.repository,job.payload.installation));
}
