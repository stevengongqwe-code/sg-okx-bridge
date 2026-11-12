import { createServer } from 'node:http';
import { readFile, writeFile, open, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertPublicOperationAllowed } from './approval.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';
import { validateLivePolicy, preflightEntry, ownershipCheck, checkIncrements, isJournaledOrder, shanghaiDay, marketOf, posKey } from './risk.mjs';
import { positiveDecimal, nonnegativeDecimal, decimalCliArg } from './decimal.mjs';
import { isContract, entryPosSide, selectPosition, instrumentExposure, leveragePlan, leverageArgs } from './order-mode.mjs';

const exec = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));
const cli = resolve(root, 'node_modules/.bin/okx');
const policyPath = resolve(root, 'policy.json');
const statePath = resolve(root, 'state.json');
const tokenPath = resolve(root, 'auth-token');
const port = Number(process.env.SG_OKX_PORT || 18789);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid SG_OKX_PORT');

await mkdir(root, { recursive: true, mode: 0o700 });
let token;
try { token = (await readFile(tokenPath, 'utf8')).trim(); }
catch { token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token + '\n', { mode: 0o600, flag: 'wx' }); }
if (!/^[0-9a-f]{64}$/.test(token)) throw Error('Invalid local authentication token');
const secureEq = (x,y) => { const a=Buffer.from(x||''), b=Buffer.from(y||''); return a.length===b.length && timingSafeEqual(a,b); };
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const policy = () => json(policyPath);
const writePolicy = (p) => writeFile(policyPath,JSON.stringify(p,null,2),{mode:0o600});
// Demo uses fixed sandbox limits; it never touches real funds.
const DEMO_POLICY = { liveEnabled:true, stopped:false, maxCapitalUsdt:1e6, maxOrderUsdt:1e5, maxRiskPerTradeUsdt:1e5, maxLeverage:20, maxDailyLossUsdt:1e6, maxDailyTrades:1000, maxOpenPositions:50, allowedMarkets:['ETH-USDT','ETH-USDT-SWAP','BTC-USDT','BTC-USDT-SWAP'] };
const state = async () => { try { return await json(statePath); } catch { return { orders: {}, daily: {} }; } };
const save = async (s) => { const temp = statePath + '.tmp'; await writeFile(temp, JSON.stringify(s, null, 2), { mode: 0o600 }); const { rename } = await import('node:fs/promises'); await rename(temp, statePath); };
const output = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (message) => ({ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });
const safeErrors = new Set(['Offline mode: exchange access disabled', 'Account access requires a local interactive terminal']);
const safe = (fn) => async (args) => { try { return output(await fn(args)); } catch (e) { return fail(safeErrors.has(e?.message) ? e.message : 'Request failed; details withheld'); } };
const disabledPreview = (_fn) => async () => fail('Exchange write operations are disabled in public preview');
async function okx(args, demo = false) {
  if (process.env.SG_OKX_NETWORK !== 'enabled') throw Error('Offline mode: exchange access disabled');
  if (args[0] !== 'market' && !(process.stdin.isTTY && process.stderr.isTTY)) throw Error('Account access requires a local interactive terminal');
  assertPublicOperationAllowed(args);
  const argv = ['--json', ...(demo ? ['--demo'] : ['--live']), ...args];
  let credentials={};
  if(args[0]!=='market') {
    const profile=demo?'demo':'live';
    const fields=[['OKX_API_KEY','api-key'],['OKX_SECRET_KEY','secret-key'],['OKX_PASSPHRASE','passphrase']];
    for(const [envName,item] of fields) {
      try { const r=await exec('/usr/bin/security',['find-generic-password','-s',`sg.okx.preview.${profile}.${item}`,'-w'],{timeout:5000,maxBuffer:4096}); credentials[envName]=r.stdout.trim(); }
      catch { throw Error(`Missing or inaccessible ${profile} OKX credential in macOS Keychain`); }
    }
  }
  let stdout;
  try { ({stdout} = await exec(cli, argv, { timeout: 20000, maxBuffer: 2_000_000, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME || root, TMPDIR: process.env.TMPDIR || '/tmp', LANG: process.env.LANG || 'C', ...credentials, NO_COLOR: '1' } })); }
  catch { throw Error('Exchange request failed; details withheld to protect credentials'); }
  try { return JSON.parse(stdout); } catch { throw Error('Exchange response could not be parsed; details withheld'); }
}
const inst = z.string().regex(/^[A-Z0-9]{1,20}(?:-[A-Z0-9]{1,20}){1,6}$/);
const positive = z.number().positive().finite();
function getServer() {
  const mcp = new McpServer({ name: 'sg-okx-bridge', version: '0.1.0' });
  mcp.registerTool('demo_preflight', { description: 'Offline simulation with synthetic inputs. Does not submit orders or contact an exchange.', inputSchema: {} }, safe(async () => {
    const policy={liveEnabled:true,stopped:false,maxCapitalUsdt:100,maxOrderUsdt:50,maxRiskPerTradeUsdt:10,maxLeverage:2,maxDailyLossUsdt:10,maxDailyTrades:3,maxOpenPositions:1,allowedMarkets:['TEST-USDT']};
    const order={instId:'TEST-USDT',side:'buy',ordType:'market',size:1,entryReference:10,stopLoss:9,takeProfit:11,leverage:1};
    const instrument={instId:'TEST-USDT',state:'live',minSz:'0.01',lotSz:'0.01',tickSz:'0.01'};
    const result=preflightEntry({policy,order,instrument,availUsdt:100,positions:[],journal:{orders:{},owned:{},daily:{}},day:'2000-01-01',dayStartEq:100,currentEq:100,currentLeverage:null});
    return {simulation:true,externalRequests:0,submitted:false,result};
  }));
  mcp.registerTool('instrument_catalog', { description: 'Dynamically list currently tradeable OKX CEX instruments and their size/price increments. Public catalog does not establish account eligibility.', inputSchema: { instType:z.enum(['SPOT','MARGIN','SWAP','FUTURES','OPTION']), instId:inst.optional(), query:z.string().max(30).optional(), limit:z.number().int().min(1).max(100).default(50) } }, safe(async ({instType,instId,query,limit})=>{
    const rows=await okx(['market','instruments','--instType',instType,...(instId?['--instId',instId]:[])]);
    const matches=rows.filter(x=>x.state==='live' && (!query||x.instId.includes(query.toUpperCase())));
    return {source:'OKX public instruments API via official CLI',observedAt:new Date().toISOString(),instType,totalLive:matches.length,items:matches.slice(0,limit).map(x=>({instId:x.instId,state:x.state,minSz:x.minSz,lotSz:x.lotSz,tickSz:x.tickSz,ctVal:x.ctVal,ctValCcy:x.ctValCcy,listTime:x.listTime}))};
  }));
  mcp.registerTool('status', { description: 'Service and risk gate status. No secrets.', inputSchema: {} }, safe(async () => {
    return {service:'online',mode:process.env.SG_OKX_NETWORK === 'enabled' ? 'network-enabled' : 'offline',policy:await policy(),time:new Date().toISOString()};
  }));
  mcp.registerTool('market_snapshot', { description: 'Official OKX ticker, candles, order book and funding rate.', inputSchema: { instId: inst, bar: z.enum(['1m','5m','15m','1H','4H','1D']).default('1H') } }, safe(async ({ instId, bar }) => {
    const [ticker, candles, orderbook, funding] = await Promise.all([
      okx(['market','ticker',instId]), okx(['market','candles',instId,'--bar',bar,'--limit','60']), okx(['market','orderbook',instId,'--sz','5']),
      instId.endsWith('-SWAP') ? okx(['market','funding-rate',instId]) : Promise.resolve(null)
    ]);
    return { source:'OKX official API via official CLI', observedAt:new Date().toISOString(), ticker, candles, orderbook, funding };
  }));
  mcp.registerTool('research_snapshot', { description: 'Research evidence from OKX: price, candles, book spread, RSI, MACD, EMA, funding and open interest. No trading decision or order.', inputSchema: { instId: inst, bar: z.enum(['5m','15m','1H','4H','1Dutc']).default('1H') } }, safe(async ({instId,bar})=>{
    const requests={ticker:['market','ticker',instId],candles:['market','candles',instId,'--bar',bar,'--limit','60'],book:['market','orderbook',instId,'--sz','5'],rsi:['market','indicator','rsi',instId,'--bar',bar],macd:['market','indicator','macd',instId,'--bar',bar],ema:['market','indicator','ema',instId,'--bar',bar]};
    if(instId.endsWith('-SWAP')) { requests.funding=['market','funding-rate',instId]; requests.openInterest=['market','oi-history',instId,'--bar',bar,'--limit','3']; }
    const entries=await Promise.all(Object.entries(requests).map(async([key,args])=>{try{return [key,await okx(args)]}catch(e){return [key,{error:e.message}]}}));
    const data=Object.fromEntries(entries); const book=data.book?.[0];
    const ask=Number(book?.asks?.[0]?.[0]),bid=Number(book?.bids?.[0]?.[0]);
    return {source:'OKX official API via official CLI',observedAt:new Date().toISOString(),instId,bar,price:data.ticker?.[0],candles:data.candles,bookTop:{bid,ask,spreadBps:Number.isFinite(bid)&&Number.isFinite(ask)?((ask-bid)/((ask+bid)/2))*10000:null},indicators:{rsi:data.rsi,macd:data.macd,ema:data.ema},funding:data.funding||null,openInterest:data.openInterest||null,news:'Not available without credentials; verify independently before a trade',accountRisk:'Not available without credentials; no autonomous trade may proceed without it'};
  }));
  // ---- account reads (live or demo; credentials only from Keychain) ----
  const accountPosMode = async (demo) => {
    const r=await okx(['account','config'],demo); const mode=(Array.isArray(r)?r[0]:r)?.posMode;
    if (!['long_short_mode','net_mode'].includes(mode)) throw Error('Cannot verify account posMode');
    return mode;
  };
  const overview = async (demo, instId) => {
    const [balance, positions, swapOrders, spotOrders, futuresOrders, swapAlgos, spotAlgos, futuresAlgos] = await Promise.all([
      okx(['account','balance'],demo), okx(['account','positions'],demo),
      okx(['swap','orders',...(instId?['--instId',instId]:[])],demo), okx(['spot','orders',...(instId?['--instId',instId]:[])],demo),
      okx(['futures','orders',...(instId?['--instId',instId]:[])],demo),
      okx(['swap','algo','orders',...(instId?['--instId',instId]:[])],demo), okx(['spot','algo','orders',...(instId?['--instId',instId]:[])],demo),
      okx(['futures','algo','orders',...(instId?['--instId',instId]:[])],demo)
    ]);
    const b=Array.isArray(balance)?balance[0]:balance;
    return { source:'OKX official API via official CLI', mode:demo?'demo':'live', observedAt:new Date().toISOString(),
      totalEqUsd:b?.totalEq??null, balances:(b?.details||[]).map(d=>({ccy:d.ccy,eq:d.eq,availBal:d.availBal,frozenBal:d.frozenBal,eqUsd:d.eqUsd})),
      positions, pendingOrders:{swap:swapOrders,spot:spotOrders,futures:futuresOrders}, pendingAlgoOrders:{swap:swapAlgos,spot:spotAlgos,futures:futuresAlgos} };
  };
  mcp.registerTool('account_overview', { description:'Read-only: balances, equity, positions, pending orders and pending algo (TP/SL) orders. demo=false reads the LIVE account.', inputSchema:{ demo:z.boolean(), instId:inst.optional() } }, safe(async ({demo,instId})=>overview(demo,instId)));
  mcp.registerTool('api_permissions', { description:'Read-only: OKX API key permission, bound IP, label, account level and position mode (no secrets).', inputSchema:{ demo:z.boolean().default(false) } }, safe(async ({demo})=>{ const r=await okx(['account','config'],demo); const c=Array.isArray(r)?r[0]:r; return { mode:demo?'demo':'live', observedAt:new Date().toISOString(), perm:c?.perm??null, ip:c?.ip??null, label:c?.label??null, acctLv:c?.acctLv??null, posMode:c?.posMode??null, mainUid:c?.mainUid&&c?.uid?(c.mainUid===c.uid?'main account':'sub-account'):null }; }));
  mcp.registerTool('account_status', { description:'Alias of account_overview (read-only).', inputSchema:{ demo:z.boolean().default(false), instId:inst.optional() } }, safe(async ({demo,instId})=>overview(demo,instId)));
  mcp.registerTool('stop_new_entries', { description: 'STOP: persistently reject new entries. Does not close positions or cancel OKX orders.', inputSchema: {} }, safe(async () => { const p=await policy(); p.stopped=true; await writePolicy(p); return {stopped:true}; }));
  mcp.registerTool('kill_switch', { description: 'KILL SWITCH: stop new entries and disable live mode. Does not touch existing OKX orders/positions.', inputSchema: {} }, safe(async () => { const p=await policy(); p.stopped=true; p.liveEnabled=false; await writePolicy(p); const s=await state(); s.pendingJobs=[]; await save(s); return {stopped:true,liveEnabled:false}; }));

  // ---- order status with fills ----
  const receiptFor = async (market, instId, clOrdId, demo) => {
    const got=await okx([market,'get','--instId',instId,'--clOrdId',clOrdId],demo); const o=Array.isArray(got)?got[0]:got;
    let fills=[]; if(o?.ordId && Number(o.accFillSz)>0) { try { fills=await okx([market,'fills','--instId',instId,'--ordId',o.ordId],demo); } catch(e) { fills=[{error:e.message}]; } }
    return { ordId:o?.ordId??null, clOrdId, state:o?.state??null, side:o?.side, posSide:o?.posSide, sz:o?.sz, avgPx:o?.avgPx, accFillSz:o?.accFillSz, fee:o?.fee, feeCcy:o?.feeCcy, attachAlgoOrds:o?.attachAlgoOrds, cTime:o?.cTime, uTime:o?.uTime, fills:(fills||[]).map(f=>f.error?f:({tradeId:f.tradeId,fillPx:f.fillPx,fillSz:f.fillSz,fee:f.fee,feeCcy:f.feeCcy,ts:f.ts})) };
  };
  mcp.registerTool('order_status', { description:'Query an order by clOrdId with fill details (avgPx, accFillSz, fee, fills). Never resubmits.', inputSchema:{ market:z.enum(['spot','swap','futures']),instId:inst,clOrdId:z.string().min(1),demo:z.boolean() } }, safe(async ({market,instId,clOrdId,demo})=>receiptFor(market,instId,clOrdId,demo)));

  // ---- live gate shared by all mutating tools ----
  const liveGate = async () => { const p=await policy(); const r=validateLivePolicy(p); if(r.length) throw Error('Live gate closed: '+r.join('; ')); return p; };
  const journalOrder = async (s, clOrdId, rec) => { s.orders[clOrdId]={...(s.orders[clOrdId]||{}),...rec}; await save(s); };
  const submitGuarded = async (s, clOrdId, args, demo, market, instId, meta) => {
    if (s.orders[clOrdId]) throw Error('Duplicate clientOrderId; query order_status instead');
    await journalOrder(s, clOrdId, { status:'prepared', demo, at:new Date().toISOString(), meta });
    let placed; try { placed=await okx(args,demo); } catch(e) { await journalOrder(s,clOrdId,{status:'uncertain',error:e.message}); throw Error(`Submission uncertain; do not retry. Query order_status with ${clOrdId}: ${e.message}`); }
    await journalOrder(s, clOrdId, { status:'submitted', placed });
    await new Promise(r=>setTimeout(r,1500));
    let receipt; try { receipt=await receiptFor(market,instId,clOrdId,demo); } catch(e) { receipt={error:'post-trade query failed: '+e.message}; }
    await journalOrder(s, clOrdId, { receipt });
    return { mode:demo?'demo':'live', clientOrderId:clOrdId, placed, receipt };
  };
  const readLeverage = async (market, instId, mgnMode, posSide, demo) => {
    const rows=await okx([market,'get-leverage','--instId',instId,'--mgnMode',mgnMode],demo);
    const row=(rows||[]).find(x=>posSide ? x.posSide===posSide : (!x.posSide || x.posSide==='net'));
    const value=Number(row?.lever);
    if (!Number.isFinite(value) || value < 1) throw Error('Cannot verify account leverage for this position side');
    return value;
  };
  const freshExposure = async (market, instId, demo) => {
    const [positions,orders,algos]=await Promise.all([
      okx(['account','positions','--instId',instId],demo),
      okx([market,'orders','--instId',instId],demo),
      okx([market,'algo','orders','--instId',instId],demo)
    ]);
    return instrumentExposure({instId,positions,pendingOrders:{[market]:orders},pendingAlgoOrders:{[market]:algos}});
  };

  mcp.registerTool('submit_order', { description:'DISABLED IN PUBLIC PREVIEW. Open a new entry: spot buy, or swap/futures open long/short, with attached TP/SL. Live requires activated policy and full preflight (real balance/positions, all limits). Never auto-retries or raises size/leverage beyond policy or OKX limits.', inputSchema:{
    demo:z.boolean(), instId:inst, side:z.enum(['buy','sell']), posSide:z.enum(['long','short','net']).optional(), ordType:z.enum(['market','limit']), size:positiveDecimal, price:positiveDecimal.optional(),
    entryReference:positiveDecimal, stopLoss:nonnegativeDecimal.default(0), takeProfit:nonnegativeDecimal.default(0), leverage:positive.default(1), mgnMode:z.enum(['isolated','cross']).default('isolated'), strategy:z.string().min(1), clientOrderId:z.string().regex(/^[A-Za-z0-9]{8,32}$/)
  } }, disabledPreview(async (a)=>{
    const s=await state(); s.owned??={}; s.daily??={};
    if (s.orders[a.clientOrderId]) throw Error('Duplicate clientOrderId; query order_status instead');
    const market=marketOf(a.instId), day=shanghaiDay();
    const rows=await okx(['market','instruments','--instType',market==='spot'?'SPOT':market==='swap'?'SWAP':'FUTURES','--instId',a.instId]); const instrument=rows.find(x=>x.instId===a.instId);
    const p = a.demo ? null : await liveGate();
    const ov=await overview(a.demo); const usdt=ov.balances.find(b=>b.ccy==='USDT'); const eq=Number(ov.totalEqUsd);
    s.daily[day]??={trades:0}; if(!Number.isFinite(s.daily[day].startEq) && Number.isFinite(eq) && !a.demo) { s.daily[day].startEq=eq; await save(s); }
    const mode=isContract(market) ? await accountPosMode(a.demo) : null;
    const resolvedSide=entryPosSide({posMode:mode,market,side:a.side,requested:a.posSide});
    const order={...a,posSide:resolvedSide||'net'};
    let plan=null;
    if (isContract(market)) {
      const current=await readLeverage(market,a.instId,a.mgnMode,resolvedSide,a.demo);
      const exposure=instrumentExposure({instId:a.instId,positions:ov.positions,pendingOrders:ov.pendingOrders,pendingAlgoOrders:ov.pendingAlgoOrders});
      plan=leveragePlan({requested:a.leverage,current,maxPolicy:Number((a.demo?DEMO_POLICY:p).maxLeverage),maxExchange:Number(instrument?.lever),mgnMode:a.mgnMode,exposure});
    }
    // A planned leverage change is permitted only after every existing risk check passes.
    const pre = preflightEntry({ policy: a.demo ? {...DEMO_POLICY} : p, order, instrument, availUsdt:Number(usdt?.availBal), positions:ov.positions, journal:s, day, dayStartEq:a.demo?eq:s.daily[day].startEq, currentEq:eq, currentLeverage:plan?.leverageForRisk??null });
    if (!pre.ok) return { rejected:true, mode:a.demo?'demo':'live', reasons:pre.reasons, computed:pre.computed };
    const verifyUnchangedPolicy=async()=>{ if(!a.demo && JSON.stringify(await policy())!==JSON.stringify(p)) throw Error('Policy changed during preflight; order blocked'); };
    await verifyUnchangedPolicy();
    if (plan?.needsSet) {
      const latest=await freshExposure(market,a.instId,a.demo);
      if (latest.position || latest.pending) throw Error('Instrument gained a position or pending order; leverage unchanged and order blocked');
      const now=await readLeverage(market,a.instId,a.mgnMode,resolvedSide,a.demo);
      const finalPlan=leveragePlan({requested:a.leverage,current:now,maxPolicy:Number((a.demo?DEMO_POLICY:p).maxLeverage),maxExchange:Number(instrument?.lever),mgnMode:a.mgnMode,exposure:latest});
      if (finalPlan.needsSet) {
        await okx(leverageArgs({market,instId:a.instId,leverage:a.leverage,posSide:resolvedSide}),a.demo);
        const verified=await readLeverage(market,a.instId,a.mgnMode,resolvedSide,a.demo);
        if (verified !== a.leverage) throw Error('Leverage setting could not be verified; order blocked');
      }
    }
    await verifyUnchangedPolicy();
    if (isContract(market) && await accountPosMode(a.demo)!==mode) throw Error('Account posMode changed during preflight; order blocked');
    const args=[market,'place','--instId',a.instId,'--side',a.side,'--ordType',a.ordType,...decimalCliArg('--sz',a.size),'--tdMode',market==='spot'?'cash':a.mgnMode,'--clOrdId',a.clientOrderId];
    if (market==='spot') args.push('--tgtCcy','base_ccy');
    if (resolvedSide) args.push('--posSide',resolvedSide);
    if (a.ordType==='limit') args.push(...decimalCliArg('--px',a.price));
    if (a.takeProfit>0) args.push(...decimalCliArg('--tpTriggerPx',a.takeProfit),'--tpOrdPx=-1','--tpTriggerPxType','last');
    if (a.stopLoss>0) args.push(...decimalCliArg('--slTriggerPx',a.stopLoss),'--slOrdPx=-1','--slTriggerPxType','last');
    s.daily[day].trades=(s.daily[day].trades||0)+1;
    const out=await submitGuarded(s,a.clientOrderId,args,a.demo,market,a.instId,{kind:'entry',strategy:a.strategy,preflight:pre.computed});
    const key = isContract(market) ? posKey(a.instId,resolvedSide||'net') : posKey(a.instId,'spot');
    s.owned[(a.demo?'demo|':'')+key]={clOrdId:a.clientOrderId,capitalUsdt:pre.computed.capital,at:new Date().toISOString(),filledBase:market==='spot'?Number(out.receipt?.accFillSz)||0:undefined}; await save(s);
    return {...out, preflight:pre.computed};
  }));

  const ownKey = (demo,key)=> (demo?'demo|':'')+key;
  const requireOwn = (s,demo,key,allow) => { const c=ownershipCheck({journal:{owned:Object.fromEntries(Object.entries(s.owned||{}).map(([k,v])=>[k,v]))},key:ownKey(demo,key),allowExistingPosition:allow}); if(!c.ok) throw Error(c.reason.replace('demo|','')); return c; };

  mcp.registerTool('close_position', { description:'DISABLED IN PUBLIC PREVIEW. Close or reduce a swap/futures position, or sell spot. Refuses positions the bridge did not open unless allowExistingPosition=true.', inputSchema:{ demo:z.boolean(), instId:inst, posSide:z.enum(['net','long','short']).default('net'), mgnMode:z.enum(['cross','isolated']).default('isolated'), size:positiveDecimal.optional(), allowExistingPosition:z.boolean().default(false), clientOrderId:z.string().regex(/^[A-Za-z0-9]{8,32}$/) } }, disabledPreview(async (a)=>{
    const s=await state(); s.owned??={}; const market=marketOf(a.instId);
    if (!a.demo) { const p=await policy(); if(p.liveEnabled!==true) throw Error('Live gate closed: liveEnabled is not true'); } // closing allowed under STOP
    if (market==='spot') {
      const key=posKey(a.instId,'spot'); requireOwn(s,a.demo,key,a.allowExistingPosition);
      if(!a.size) throw Error('spot close requires size');
      const owned=s.owned[ownKey(a.demo,key)]; if(owned && !a.allowExistingPosition && a.size>(owned.filledBase||0)+1e-12) throw Error(`size exceeds base amount bought by the bridge (${owned.filledBase})`);
      const rows=await okx(['market','instruments','--instType','SPOT','--instId',a.instId]); const r=checkIncrements({size:a.size,instrument:rows.find(x=>x.instId===a.instId)}); if(r.length) throw Error(r.join('; '));
      const out=await submitGuarded(s,a.clientOrderId,['spot','place','--instId',a.instId,'--side','sell','--ordType','market',...decimalCliArg('--sz',a.size),'--tdMode','cash','--tgtCcy','base_ccy','--clOrdId',a.clientOrderId],a.demo,'spot',a.instId,{kind:'spot_close'});
      if(owned){ owned.filledBase=Math.max(0,(owned.filledBase||0)-(Number(out.receipt?.accFillSz)||0)); if(owned.filledBase<=0) delete s.owned[ownKey(a.demo,key)]; await save(s); }
      return out;
    }
    const mode=await accountPosMode(a.demo);
    const positions=await okx(['account','positions','--instId',a.instId],a.demo);
    const {position:pos,posSide}=selectPosition({posMode:mode,instId:a.instId,mgnMode:a.mgnMode,requested:a.posSide,positions});
    const key=posKey(a.instId,posSide||'net'); requireOwn(s,a.demo,key,a.allowExistingPosition);
    if(a.size) {
      if(a.size>Math.abs(Number(pos.pos))) throw Error('reduce size exceeds position');
      const side = posSide==='long' || (!posSide && Number(pos.pos)>0) ? 'sell' : 'buy';
      const args=[market,'place','--instId',a.instId,'--side',side,'--ordType','market',...decimalCliArg('--sz',a.size),'--tdMode',a.mgnMode,'--clOrdId',a.clientOrderId];
      if(posSide) args.push('--posSide',posSide); else args.push('--reduceOnly');
      return await submitGuarded(s,a.clientOrderId,args,a.demo,market,a.instId,{kind:'reduce'});
    }
    if (s.orders[a.clientOrderId]) throw Error('Duplicate clientOrderId');
    await journalOrder(s,a.clientOrderId,{status:'prepared',demo:a.demo,meta:{kind:'close'},at:new Date().toISOString()});
    const closeArgs=[market,'close','--instId',a.instId,'--mgnMode',a.mgnMode,...(posSide?['--posSide',posSide]:[])];
    let receipt; try { receipt=await okx(closeArgs,a.demo); } catch(e) { await journalOrder(s,a.clientOrderId,{status:'uncertain',error:e.message}); throw Error('Close uncertain; do not retry. Check account_overview: '+e.message); }
    delete s.owned[ownKey(a.demo,key)]; await journalOrder(s,a.clientOrderId,{status:'submitted',receipt});
    let after=null; try { after=await okx(['account','positions','--instId',a.instId],a.demo); } catch {}
    return { mode:a.demo?'demo':'live', receipt, positionsAfter:after };
  }));

  mcp.registerTool('cancel_order', { description:'DISABLED IN PUBLIC PREVIEW. Cancel a pending order the bridge placed (by clOrdId). Orders not in the bridge journal need allowExistingPosition=true.', inputSchema:{ demo:z.boolean(), market:z.enum(['spot','swap','futures']), instId:inst, clOrdId:z.string().min(1), allowExistingPosition:z.boolean().default(false) } }, disabledPreview(async (a)=>{
    const s=await state(); if(!a.demo){ const p=await policy(); if(p.liveEnabled!==true) throw Error('Live gate closed: liveEnabled is not true'); }
    if(!isJournaledOrder(s,a.clOrdId) && !a.allowExistingPosition) throw Error('Order not placed by the bridge; pass allowExistingPosition=true only with explicit approval');
    const receipt=await okx([a.market,'cancel',a.instId,'--clOrdId',a.clOrdId],a.demo);
    let after=null; try { after=await receiptFor(a.market,a.instId,a.clOrdId,a.demo); } catch(e) { after={error:e.message}; }
    return { mode:a.demo?'demo':'live', receipt, after };
  }));

  mcp.registerTool('set_tpsl', { description:'DISABLED IN PUBLIC PREVIEW. Attach a separate reduce-only TP/SL algo (OCO if both) to an existing position. Refuses positions the bridge did not open unless allowExistingPosition=true.', inputSchema:{ demo:z.boolean(), instId:inst, posSide:z.enum(['net','long','short']).default('net'), mgnMode:z.enum(['cross','isolated']).default('isolated'), size:positiveDecimal, takeProfit:nonnegativeDecimal.default(0), stopLoss:nonnegativeDecimal.default(0), allowExistingPosition:z.boolean().default(false) } }, disabledPreview(async (a)=>{
    const s=await state(); const market=marketOf(a.instId);
    if(!a.demo){ const p=await policy(); if(p.liveEnabled!==true) throw Error('Live gate closed: liveEnabled is not true'); }
    if(!(a.takeProfit>0)&&!(a.stopLoss>0)) throw Error('takeProfit or stopLoss required');
    let side='sell',posSide;
    if(isContract(market)){
      const mode=await accountPosMode(a.demo); const positions=await okx(['account','positions','--instId',a.instId],a.demo);
      const selected=selectPosition({posMode:mode,instId:a.instId,mgnMode:a.mgnMode,requested:a.posSide,positions});
      const pos=selected.position; posSide=selected.posSide;
      requireOwn(s,a.demo,posKey(a.instId,posSide||'net'),a.allowExistingPosition);
      if(a.size>Math.abs(Number(pos.pos))) throw Error('size exceeds position');
      side=(posSide==='short'||(!posSide&&Number(pos.pos)<0))?'buy':'sell';
    } else requireOwn(s,a.demo,posKey(a.instId,'spot'),a.allowExistingPosition);
    const args=[market,'algo','place','--instId',a.instId,'--side',side,...decimalCliArg('--sz',a.size),'--ordType',(a.takeProfit>0&&a.stopLoss>0)?'oco':'conditional','--tdMode',market==='spot'?'cash':a.mgnMode];
    if(isContract(market)){ if(posSide) args.push('--posSide',posSide); else args.push('--reduceOnly'); }
    if(a.takeProfit>0) args.push(...decimalCliArg('--tpTriggerPx',a.takeProfit),'--tpOrdPx=-1','--tpTriggerPxType','last');
    if(a.stopLoss>0) args.push(...decimalCliArg('--slTriggerPx',a.stopLoss),'--slOrdPx=-1','--slTriggerPxType','last');
    const receipt=await okx(args,a.demo); const algoId=(Array.isArray(receipt)?receipt[0]:receipt)?.algoId;
    s.algos??={}; if(algoId){ s.algos[algoId]={instId:a.instId,demo:a.demo,at:new Date().toISOString()}; await save(s); }
    return { mode:a.demo?'demo':'live', receipt, algoId };
  }));

  mcp.registerTool('amend_tpsl', { description:'DISABLED IN PUBLIC PREVIEW. Amend TP/SL trigger prices of a pending algo order (attached or separate). Algo orders not created by the bridge need allowExistingPosition=true (e.g. an existing position).', inputSchema:{ demo:z.boolean(), instId:inst, algoId:z.string().min(1), newTakeProfit:positiveDecimal.optional(), newStopLoss:positiveDecimal.optional(), allowExistingPosition:z.boolean().default(false) } }, disabledPreview(async (a)=>{
    const s=await state(); const market=marketOf(a.instId);
    if(!a.demo){ const p=await policy(); if(p.liveEnabled!==true) throw Error('Live gate closed: liveEnabled is not true'); }
    if(!s.algos?.[a.algoId] && !a.allowExistingPosition) throw Error('Algo order not created by the bridge; pass allowExistingPosition=true only with explicit approval');
    if(!a.newTakeProfit && !a.newStopLoss) throw Error('nothing to amend');
    const args=[market,'algo','amend','--instId',a.instId,'--algoId',a.algoId]; if(a.newTakeProfit) args.push(...decimalCliArg('--newTpTriggerPx',a.newTakeProfit)); if(a.newStopLoss) args.push(...decimalCliArg('--newSlTriggerPx',a.newStopLoss));
    const receipt=await okx(args,a.demo); let after=null; try { after=await okx([market,'algo','orders','--instId',a.instId],a.demo); } catch {}
    return { mode:a.demo?'demo':'live', receipt, pendingAlgosAfter:after };
  }));
  return mcp;
}

const http=createServer(async(req,res)=>{
  const host=req.headers.host || '';
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host) || req.headers.origin !== undefined) {
    res.writeHead(403,{'cache-control':'no-store'}).end(); return;
  }
  const u=new URL(req.url,'http://localhost');
  if(['/authorize','/token','/register','/mcp','/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'].includes(u.pathname)) console.log(JSON.stringify({event:'request',method:req.method,path:u.pathname,at:new Date().toISOString()}));
  if(req.url==='/health') { res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,liveEnabled:(await policy()).liveEnabled})); return; }
  if(req.url!=='/mcp') { res.writeHead(404).end(); return; }
  const supplied=(req.headers.authorization||'').replace(/^Bearer /,'');
  if(!secureEq(supplied,token)) { res.writeHead(401,{'www-authenticate': 'Bearer','content-type':'application/json'}).end(JSON.stringify({error:'unauthorized'})); return; }
  if(req.method!=='POST') { res.writeHead(405).end(); return; }
  const length = req.headers['content-length'];
  if (req.headers['transfer-encoding'] || typeof length !== 'string' || !/^\d+$/.test(length)) { res.writeHead(411).end(); return; }
  const declared = Number(length);
  if (!Number.isSafeInteger(declared) || declared > 65536) { res.writeHead(413).end(); return; }
  const mcp=getServer(); const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  try { await mcp.connect(transport); await transport.handleRequest(req,res); }
  catch { if(!res.headersSent) res.writeHead(500).end(); }
  res.on('close',()=>{transport.close();mcp.close();});
});
http.listen(port,'127.0.0.1',()=>console.log(`SG-OKX-Bridge listening on 127.0.0.1:${port}`));
