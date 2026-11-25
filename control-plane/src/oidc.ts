import { createRemoteJWKSet,jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { createHash,randomUUID } from 'node:crypto';
import { db,access } from './service.js';
const jwksCache=new Map<string,ReturnType<typeof createRemoteJWKSet>>();
const github='https://token.actions.githubusercontent.com';
export function validateClaims(payload:JWTPayload,required:Record<string,string>) {
  if(!payload.exp || !payload.iat || payload.exp-payload.iat>7200 || payload.iat>Date.now()/1000+30) throw new Error('invalid token lifetime');
  if(Object.keys(required).length===0) throw new Error('empty claim restrictions');
  for(const [name,value] of Object.entries(required)) if(payload[name]!==value) throw new Error('claim mismatch');
  if(payload.iss==='https://token.actions.githubusercontent.com' && !['push','workflow_dispatch','schedule'].includes(String(payload.event_name))) throw new Error('PR contexts cannot obtain group keys');
}
export async function verify(token:string,policy:any,key?:JWTVerifyGetKey, recipient?:string) {
  if(policy.issuer!==github && !/^https:\/\/oidc\.vercel\.com(?:\/[a-zA-Z0-9_-]+)?$/.test(policy.issuer)) throw new Error('unsupported issuer');
  const jwks=policy.issuer===github?`${github}/.well-known/jwks`:`${policy.issuer}/.well-known/jwks`;
  const {payload}=await jwtVerify(token,key??(()=>{let resolver=jwksCache.get(jwks);if(!resolver){resolver=createRemoteJWKSet(new URL(jwks));jwksCache.set(jwks,resolver);}return resolver;})(),{issuer:policy.issuer,audience:recipient?`${policy.audience}:group:${policy.group_id}:recipient:${recipient}`:policy.audience,subject:policy.subject,algorithms:['RS256'],requiredClaims:['exp','iat','sub'],maxTokenAge:'2h'});
  const required=policy.required_claims;
  if(policy.issuer===github && (!required.repository_id || !required.ref || !(required.workflow_ref || required.job_workflow_ref))) throw new Error('GitHub policy must bind immutable repository ID, ref and workflow');
  if(policy.issuer!==github && (!required.project_id || !required.owner_id || !required.environment)) throw new Error('Vercel policy must bind project, owner and environment');
  validateClaims(payload,required);return payload;
}
export async function requestKey(policyId:string,token:string,publicKey:string) {
  if(!/^age1[a-z0-9]{58}$/.test(publicKey)) throw new Error('invalid recipient');
  const {rows}=await db.query('SELECT * FROM ci_policies WHERE id=$1 AND enabled=true',[policyId]);const policy=rows[0];if(!policy) throw new Error('policy unavailable');
  const claims=await verify(token,policy,undefined,publicKey);const id=randomUUID();
  // A verified workload requests a fresh public key; an authorized local broker wraps the DEK.
  // The server cannot rewrap a DEK and never receives plaintext key material.
  await db.query("INSERT INTO ci_requests(id,policy_id,public_key,oidc_token,token_id,expires_at) VALUES($1,$2,$3,$4,$5,LEAST(to_timestamp($6),now()+interval '5 minutes'))",[id,policyId,publicKey,token,createHash('sha256').update(`${claims.iss}:${token}`).digest('hex'),claims.exp]);
  return {id,expiresIn:300};
}
export async function approveKey(userId:string,id:string,envelope:string) {
  const {rows}=await db.query('SELECT c.*,p.group_id FROM ci_requests c JOIN ci_policies p ON p.id=c.policy_id WHERE c.id=$1 AND c.expires_at>now() AND p.enabled=true',[id]);
  const req=rows[0];if(!req) throw new Error('request expired');await access(userId,req.group_id,true);
  const bytes=Buffer.from(envelope,'base64');if(bytes.toString('base64')!==envelope || !bytes.toString().startsWith('age-encryption.org/v1\n') || bytes.length>65536) throw new Error('invalid envelope');
  const updated=await db.query('UPDATE ci_requests SET encrypted_dek_blob=$1 WHERE id=$2 AND encrypted_dek_blob IS NULL AND expires_at>now() AND EXISTS(SELECT 1 FROM ci_policies p WHERE p.id=ci_requests.policy_id AND p.enabled=true)',[envelope,id]);if(!updated.rowCount) throw new Error('request cannot be approved');
}
export async function consumeKey(id:string,token:string,ip:string) {
  const {rows}=await db.query('SELECT c.*,p.issuer,p.audience,p.subject,p.required_claims,p.group_id,p.enabled FROM ci_requests c JOIN ci_policies p ON p.id=c.policy_id WHERE c.id=$1 AND p.enabled=true',[id]);const req=rows[0];if(!req) throw new Error('unknown request');
  const claims=await verify(token,req,undefined,req.public_key);const tokenId=createHash('sha256').update(`${claims.iss}:${token}`).digest('hex');
  const client=await db.connect();try {
    await client.query('BEGIN');
    const active=await client.query('SELECT id FROM ci_policies WHERE id=$1 AND enabled=true FOR SHARE',[req.policy_id]);if(!active.rowCount) throw new Error('policy revoked');
    const {rows:envelopes}=await client.query('UPDATE ci_requests SET consumed_at=now() WHERE id=$1 AND token_id=$2 AND consumed_at IS NULL AND expires_at>now() AND encrypted_dek_blob IS NOT NULL AND EXISTS (SELECT 1 FROM ci_policies p WHERE p.id=ci_requests.policy_id AND p.enabled=true) RETURNING encrypted_dek_blob',[id,tokenId]);
    if(!envelopes[0]) {await client.query('ROLLBACK');return null;}
    await client.query("INSERT INTO audit_logs(repo_id,group_id,action,ip_address,details) SELECT repo_id,id,'DEK_FETCH',$2,$3 FROM groups WHERE id=$1",[req.group_id,ip,JSON.stringify({requestId:id,policyId:req.policy_id,issuer:claims.iss,subject:claims.sub,workflow:claims.workflow_ref??claims.job_workflow_ref,runId:claims.run_id})]);
    await client.query('COMMIT');return envelopes[0];
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
