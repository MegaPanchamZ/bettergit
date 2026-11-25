import type {PoolClient} from 'pg';
import {db} from './service.js';

const maxAttempts=10;
type Event='push'|'pull_request'|'merge_group'|'check_run'|'offboarding';

export async function persistDelivery(id:string,event:Event,payload:object) {
 await db.query('INSERT INTO guard_deliveries(id,event,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,event,payload]);
}

export async function retryJob(
 client: PoolClient,
 table:'guard_deliveries'|'shadow_revocation_jobs',
 job:{id:string,attempts:number},
) {
 const failed=job.attempts+1>=maxAttempts;
 await client.query(`UPDATE ${table} SET attempts=attempts+1,
   retry_after=now()+make_interval(secs=>least(3600,30*(2^least(attempts,7))::int)),
   failed_at=CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE id=$1`,[job.id,failed]);
 return failed;
}

export async function drainDelivery(
 offboarding:boolean,
 dispatch:(job:{id:string,event:Event,payload:any})=>Promise<void>,
) {
 const client=await db.connect();
 let failedId:string|undefined;
 try {
  await client.query('BEGIN');
  const {rows:[job]}=await client.query(`SELECT id,event,payload,attempts FROM guard_deliveries
    WHERE completed_at IS NULL AND failed_at IS NULL AND retry_after<=now()
      AND (event='offboarding')=$1
    ORDER BY retry_after,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[offboarding]);
  if(job) {
   try {
    await dispatch(job);
    await client.query('UPDATE guard_deliveries SET completed_at=now(),payload=NULL WHERE id=$1',[job.id]);
   }catch {
    if(await retryJob(client,'guard_deliveries',job)) failedId=job.id;
   }
  }
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 if(failedId) console.error(offboarding?'Offboarding delivery exhausted retries':'Guard delivery exhausted retries',failedId);
}
