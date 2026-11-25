import { Decrypter,identityToRecipient } from 'age-encryption';
import {parseDocument,isMap,isSeq,isScalar} from 'yaml';
export function decode(s:string) {const value=s.trim();return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
// RFC 8410 PKCS#8 encoding for an Ed25519 seed. The private key is only
// imported to obtain its public coordinate from WebCrypto.
export async function groupVerifier(identity:string):Promise<Uint8Array<ArrayBuffer>> {
 const encoder=new TextEncoder();
 const material=await crypto.subtle.importKey('raw',encoder.encode(identity.trim().toUpperCase()),'HKDF',false,['deriveBits']);
 const seed=new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(32),info:encoder.encode('bettergit/content/signing-key/v2')},material,256));
 const encoded=new Uint8Array(48);
 encoded.set([0x30,0x2e,0x02,0x01,0,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
 encoded.set(seed,16);
 seed.fill(0);
 try {
  const privateKey=await crypto.subtle.importKey('pkcs8',encoded,'Ed25519',true,['sign']);
  const {x}=await crypto.subtle.exportKey('jwk',privateKey);
  if(!x) throw new Error('Missing group verifier');
  return decode(x.replaceAll('-','+').replaceAll('_','/'));
 } finally {
  encoded.fill(0);
 }
}
export async function decryptDiff(text:string,identity:string,envelope:string,path:string,format:'env'|'json'|'yaml',repo:string,groupName:string,groupRecipient:string) {
 if(!repo.trim() || !groupName.trim() || !path.trim()) throw new Error('Repository, group and path are required');
 if(text.length>2*1024*1024) throw new Error('Selection too large');
 const user=new Decrypter();user.addIdentity(identity.trim());
 const wrapped=JSON.parse(await user.decrypt(decode(envelope),'text'));
 if(typeof wrapped.key!=='string' || typeof wrapped.public!=='string' || wrapped.repo!==repo.toLowerCase() || wrapped.group!==groupName || wrapped.public!==groupRecipient.trim() || await identityToRecipient(wrapped.key)!==wrapped.public) throw new Error('Envelope context mismatch');
 const group=wrapped.key;
 const publicKey=await groupVerifier(group);
 const verifyingKey=await crypto.subtle.importKey('raw',publicKey,'Ed25519',false,['verify']);
 const decryptor=new Decrypter();decryptor.addIdentity(group.trim());
 let originalStructure:string|undefined;
 const spans:{start:number,end:number,field:string,token:string}[]=[];
 if(format==='env') {
  let cursor=0;
  for(const line of text.split(/(?<=\n)/)) {
   const match=line.match(/^[+\-]?[ \t]*(?:export )?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(ENC\[v2:[A-Za-z0-9+/=]+\])\r?\n?$/);
   if(!match && !/^[+ \-]?\s*(?:#.*)?\r?\n?$/.test(line)) throw new Error('Selection contains an unsigned line');
   if(match) {const offset=line.indexOf(match[2]);spans.push({start:cursor+offset,end:cursor+offset+match[2].length,field:match[1],token:match[2]});}
   cursor+=line.length;
  }
 }else {
  if(format==='json') JSON.parse(text);
  const doc=parseDocument(text);if(doc.errors.length) throw new Error('Select complete file content for structured formats');
  originalStructure=structure(doc.contents);
  const pointer=(key:string)=>key.replaceAll('~','~0').replaceAll('/','~1');
  function visit(node:unknown,field:string):void {
   if(isMap(node)) {for(const pair of node.items) {if(!isScalar(pair.key)) throw new Error('Complex key');visit(pair.value,`${field}/${pointer(String(pair.key.value))}`);}}
   else if(isSeq(node)) node.items.forEach((item,i)=>visit(item,`${field}/${i}`));
   else {
    if(!isScalar(node) || typeof node.value!=='string' || !/^ENC\[v2:[A-Za-z0-9+/=]+\]$/.test(node.value) || !node.range) throw new Error('Selection contains an unsigned value');
    spans.push({start:node.range[0],end:node.range[1],field,token:node.value});
   }
  }
  visit(doc.contents,'document:0');
 }
 if(spans.length===0) throw new Error('No encrypted values selected');
 let output='',cursor=0;
 for(const span of spans.sort((a,b)=>a.start-b.start)) {
  const signed=decode(span.token.slice(7,-1));
  if(signed.length<=96 || publicKey.length!==32 || !publicKey.every((byte,i)=>byte===signed[i])) throw new Error('Unexpected content signer');
  const context=`${path}\0${span.field}`;
  const ageBlob=signed.slice(96);
  const prefix=new TextEncoder().encode(`bettergit/content/v2\0${context}\0`);
  const message=new Uint8Array(prefix.length+ageBlob.length);
  message.set(prefix);
  message.set(ageBlob,prefix.length);
  if(!await crypto.subtle.verify('Ed25519',verifyingKey,signed.slice(32,96),message)) throw new Error('Invalid content signature');
  const raw=await decryptor.decrypt(ageBlob,'text');
  const payload:unknown=JSON.parse(raw);
  if(!Array.isArray(payload) || payload.length!==2 || payload[0]!==`${path}\0${span.field}` || typeof payload[1]!=='string') throw new Error('Ciphertext context mismatch');
  const value=payload[1];
  if(format==='env' && /[\r\n]/.test(value)) throw new Error('Scalar injection');
  if(format==='yaml') {const scalar=parseDocument(value);if(scalar.errors.length || !isScalar(scalar.contents) || scalar.contents.anchor || scalar.contents.tag) throw new Error('Scalar injection');}
  if(format==='json') {
   const scalar:unknown=JSON.parse(value);
   if(typeof scalar==='object' && scalar!==null) throw new Error('Scalar injection');
  }
  output+=text.slice(cursor,span.start)+value;cursor=span.end;
 }
 const result=output+text.slice(cursor);
 if(originalStructure!==undefined) {
  if(format==='json') JSON.parse(result);
  const doc=parseDocument(result);
  if(doc.errors.length || structure(doc.contents)!==originalStructure) throw new Error('Decrypted scalars changed document structure');
 }
 return result;
}

function structure(node:unknown):string {
 if(node===null) return 'null';
 if(isScalar(node) || isMap(node) || isSeq(node)) {
  if(node.anchor || node.tag) throw new Error('YAML properties are unsupported');
  if(isScalar(node)) return 'scalar';
  if(isSeq(node)) return JSON.stringify(node.items.map(structure));
  return JSON.stringify(node.items.map(pair=>{
   if(!isScalar(pair.key) || pair.key.anchor || pair.key.tag) throw new Error('Complex key');
   return [String(pair.key.value),structure(pair.value)];
  }));
 }
 throw new Error('Unsupported document structure');
}
