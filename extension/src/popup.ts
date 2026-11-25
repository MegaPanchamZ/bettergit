import { decryptDiff } from './decrypt.js';
const input=document.querySelector<HTMLInputElement>('#identity')!;
const envelope=document.querySelector<HTMLTextAreaElement>('#envelope')!;
const result=document.querySelector<HTMLElement>('#result')!;
const status=document.querySelector<HTMLElement>('#status')!;
function clear(){input.value='';envelope.value='';result.textContent='';status.textContent='';}
document.querySelector('#clear')!.addEventListener('click',clear);
document.querySelector('#decrypt')!.addEventListener('click',async()=>{
 try {
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const url=new URL(tab.url??'');
  if(url.origin!=='https://github.com' || !/^\/[^/]+\/[^/]+\/pull\/\d+\/files/.test(url.pathname)) throw new Error('Open a GitHub pull request Files changed page');
  const selection=await chrome.scripting.executeScript({target:{tabId:tab.id!},func:()=>window.getSelection()?.toString()??''});
  result.textContent=await decryptDiff(selection[0]?.result??'',input.value,envelope.value,document.querySelector<HTMLInputElement>('#path')!.value,document.querySelector<HTMLSelectElement>('#format')!.value as 'env'|'json'|'yaml',url.pathname.split('/').slice(1,3).join('/'),document.querySelector<HTMLInputElement>('#group')!.value,document.querySelector<HTMLInputElement>('#recipient')!.value);
  input.value='';envelope.value='';status.textContent='Decrypted locally. Closing this popup clears the viewer.';
 }catch{input.value='';envelope.value='';result.textContent='';status.textContent='Unable to decrypt. Check the selected ciphertext, identity, and wrapped group key.';}
});
window.addEventListener('pagehide',clear);
