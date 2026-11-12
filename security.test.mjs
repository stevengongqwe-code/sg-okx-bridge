import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, copyFile, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const project=dirname(fileURLToPath(import.meta.url));
const tmp=await mkdtemp(join(tmpdir(),'okx-safety-test-'));
for (const file of ['server.mjs','risk.mjs','decimal.mjs','order-mode.mjs','approval.mjs']) await copyFile(join(project,file),join(tmp,file));
await symlink(join(project,'node_modules'),join(tmp,'node_modules'),'dir');
await writeFile(join(tmp,'policy.json'),JSON.stringify({liveEnabled:false,stopped:true}));
const requestedPort=await new Promise((resolve,reject)=>{const s=createTcpServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const child=spawn(process.execPath,[join(tmp,'server.mjs')],{env:{PATH:process.env.PATH,HOME:tmp,SG_OKX_PORT:String(requestedPort),SG_PUBLIC_ORIGIN:'https://invalid.example'},stdio:['ignore','pipe','pipe']});
let output='';
const port=await new Promise((resolve,reject)=>{
 const timeout=setTimeout(()=>reject(new Error('test server failed to start')),12000);
 child.stdout.on('data',chunk=>{output+=chunk;let m=output.match(/listening on 127\.0\.0\.1:(\d+)/); if(m){clearTimeout(timeout);resolve(Number(m[1]));}});
 child.on('exit',code=>{clearTimeout(timeout);reject(new Error('test server exited '+code));});
});
const token=(await readFile(join(tmp,'auth-token'),'utf8')).trim();
after(async()=>{child.kill('SIGTERM'); await new Promise(r=>child.once('exit',r)); await rm(tmp,{recursive:true,force:true});});
async function req(path,{headers={},...rest}={}){return fetch(`http://127.0.0.1:${port}${path}`,{...rest,headers:{...headers}})}
test('untrusted DNS rebind Host is rejected',async()=>{const status=await new Promise((resolve,reject)=>{const r=httpRequest({hostname:'127.0.0.1',port,path:'/health',headers:{host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode)});r.on('error',reject);r.end()});assert.equal(status,403)});
test('untrusted browser Origin is rejected',async()=>{const r=await req('/health',{headers:{origin:'https://attacker.invalid'}});assert.equal(r.status,403)});
test('public OAuth is unavailable even if public environment is set',async()=>{const r=await req('/.well-known/oauth-authorization-server');assert.equal(r.status,404)});
test('MCP requests require bearer authentication',async()=>{const r=await req('/mcp',{method:'POST'});assert.equal(r.status,401)});
test('offline demo tool can be invoked without external credentials',async()=>{
 const r=await req('/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'demo_preflight',arguments:{}}})});
 assert.equal(r.status,200); const body=await r.text();assert.match(body,/simulation/i);assert.doesNotMatch(body,/isError.*true/);
});

test('account access fails closed while offline by default',async()=>{
 const r=await req('/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'account_overview',arguments:{demo:false}}})});
 assert.equal(r.status,200);const body=await r.text();assert.match(body,/offline mode/i);assert.match(body,/isError/);
});
test('schema listing works after Zod upgrade',async()=>{
 const r=await req('/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/list'})});
 assert.equal(r.status,200);const body=await r.text();assert.match(body,/demo_preflight/);assert.match(body,/submit_order/);
});

test('status in offline mode does not inspect credentials',async()=>{
 const r=await req('/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'status',arguments:{}}})});
 const body=await r.text();assert.match(body,/offline/i);assert.doesNotMatch(body,/demoConfigured|liveConfigured/);
});

test('oversized local MCP requests are rejected before parsing',async()=>{
 const r=await req('/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','accept':'application/json, text/event-stream'},body:'x'.repeat(70_000)});assert.equal(r.status,413);
});

test('write tool is disabled before preflight or any network access',async()=>{
 const r=await req('/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'submit_order',arguments:{demo:false,instId:'TEST-USDT',side:'buy',ordType:'market',size:1,entryReference:10,strategy:'synthetic',clientOrderId:'TEST12345'}}})});
 const body=await r.text();assert.match(body,/disabled in public preview/i);assert.match(body,/isError/);
});

test('all exchange write tools fail closed in both real and demo modes',async()=>{
 const cases=[['submit_order',{instId:'TEST-USDT',side:'buy',ordType:'market',size:1,entryReference:10,strategy:'fictional',clientOrderId:'TEST12345'}],['close_position',{instId:'TEST-USDT',clientOrderId:'TEST12345'}],['cancel_order',{market:'spot',instId:'TEST-USDT',clOrdId:'TEST12345'}],['set_tpsl',{instId:'TEST-USDT',size:1,takeProfit:11}],['amend_tpsl',{instId:'TEST-USDT',algoId:'FAKE',newTakeProfit:11}]];
 for(const [name,args] of cases) for(const demo of [true,false]){
  const r=await req('/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:10,method:'tools/call',params:{name,arguments:{...args,demo}}})});
  const body=await r.text();assert.match(body,/disabled in public preview/i,name);assert.match(body,/isError/,name);
 }
});
test('malformed private configuration is not echoed in errors',async()=>{
 const file=join(tmp,'policy.json');await writeFile(file,'PRIVATE-CANARY-012345');
 try {
  const r=await req('/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:11,method:'tools/call',params:{name:'status',arguments:{}}})});
  const body=await r.text();assert.match(body,/isError/);assert.doesNotMatch(body,/PRIVATE-CA/);
 } finally {await writeFile(file,JSON.stringify({liveEnabled:false,stopped:true}));}
});
