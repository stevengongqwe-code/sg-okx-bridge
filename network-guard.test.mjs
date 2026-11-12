import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, copyFile, symlink, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const project=dirname(fileURLToPath(import.meta.url));
test('network opt-in without a local terminal still blocks account operations',async()=>{
 const tmp=await realpath(await mkdtemp(join(tmpdir(),'okx-guard-test-')));
 for(const f of ['server.mjs','risk.mjs','decimal.mjs','order-mode.mjs','approval.mjs'])await copyFile(join(project,f),join(tmp,f));
 await symlink(join(project,'node_modules'),join(tmp,'node_modules'),'dir');
 await writeFile(join(tmp,'policy.json'),JSON.stringify({liveEnabled:false,stopped:true}));
 const port=await new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 // Node permission model denies subprocess execution; the test cannot invoke system Keychain or an exchange CLI.
 const child=spawn(process.execPath,['--experimental-permission',`--allow-fs-read=${project}`,`--allow-fs-read=${tmp}`,`--allow-fs-write=${tmp}`,join(tmp,'server.mjs')],{env:{PATH:process.env.PATH,HOME:tmp,SG_OKX_PORT:String(port),SG_OKX_NETWORK:'enabled'},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',c=>{stderr+=c});const exited=new Promise(resolve=>child.once('exit',resolve));
 try {
  await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(Error('server start timed out')),12000);child.stdout.on('data',c=>{out+=c;if(out.includes('listening on')){clearTimeout(timer);resolve();}});child.on('exit',()=>{clearTimeout(timer);reject(Error('server exited early: '+stderr.slice(0,500)));});});
  const token=(await readFile(join(tmp,'auth-token'),'utf8')).trim();
  const r=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'account_overview',arguments:{demo:false}}})});
  const body=await r.text();assert.match(body,/interactive terminal/i);assert.match(body,/isError/);assert.doesNotMatch(body,/ERR_ACCESS_DENIED|Keychain/i);
 } finally { if(child.exitCode===null)child.kill('SIGTERM');await exited;await rm(tmp,{recursive:true,force:true}); }
});
