import {test} from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';
process.env.GITHUB_APP_ID='1';process.env.GITHUB_PRIVATE_KEY='test';process.env.GITHUB_WEBHOOK_SECRET='test';
const {verify,validateClaims}=await import('./oidc.js');
test('OIDC binds signature issuer audience subject repository ref workflow and lifetime',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256');const now=Math.floor(Date.now()/1000);
 const claims={event_name:'push',repository_id:'123',ref:'refs/heads/main',job_workflow_ref:'acme/r/.github/workflows/deploy.yml@refs/heads/main'};
 const policy={issuer:'https://token.actions.githubusercontent.com',audience:'bettergit',subject:'repo:acme/r:ref:refs/heads/main',required_claims:claims};
 const token=await new SignJWT(claims).setProtectedHeader({alg:'RS256'}).setIssuer(policy.issuer).setAudience(policy.audience).setSubject(policy.subject).setIssuedAt(now).setExpirationTime(now+300).setJti('test').sign(privateKey);
 assert.equal((await verify(token,policy,async()=>publicKey)).repository_id,'123');
 await assert.rejects(()=>verify(token,{...policy,audience:'wrong'},async()=>publicKey));
 await assert.rejects(()=>verify(token,{...policy,required_claims:{...claims,repository_id:'999'}},async()=>publicKey));
 assert.throws(()=>validateClaims({iat:now,exp:now+300,event_name:'pull_request'},claims));
 assert.throws(()=>validateClaims({iat:now,exp:now+10800},claims));
});
