import {createHmac,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {enqueueGuardDelivery} from './guard.js';
import {enqueueOffboarding} from './offboarding.js';

export async function receiveGitHubWebhook(headers:IncomingMessage['headers'],raw:Buffer,res:ServerResponse) {
 const secret=process.env.GITHUB_WEBHOOK_SECRET;
 const signature=headers['x-hub-signature-256'];
 const id=headers['x-github-delivery'];
 const event=headers['x-github-event'];
 if(!secret || typeof signature!=='string' || !/^sha256=[0-9a-f]{64}$/.test(signature) ||
    typeof id!=='string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ||
    typeof event!=='string') {
  res.writeHead(400).end();
  return;
 }
 const expected=createHmac('sha256',secret).update(raw).digest();
 if(!timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'))) {
  res.writeHead(403).end();
  return;
 }
 let payload;
 try {
  payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if(!payload || typeof payload!=='object' || Array.isArray(payload)) throw new Error('invalid payload');
 }catch {
  res.writeHead(400).end();
  return;
 }
 try {
  const action=payload.action;
  if(event==='push' || event==='pull_request' || event==='merge_group' || (event==='check_run' && action==='rerequested')) {
   await enqueueGuardDelivery(id,event,payload);
  }else if((event==='organization' && action==='member_removed') ||
    ((event==='member' || event==='membership') && action==='removed') ||
    (event==='team' && (action==='deleted' || action==='removed_from_repository'))) {
   await enqueueOffboarding(id,event,payload);
  }
 }catch {
  console.error('Unable to persist GitHub delivery',id);
  res.writeHead(503).end();
  return;
 }
 res.writeHead(204).end();
}
