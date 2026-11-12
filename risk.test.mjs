import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLivePolicy, preflightEntry, ownershipCheck, checkIncrements, shanghaiDay, marketOf } from './risk.mjs';
const P = { liveEnabled:true, stopped:false, maxCapitalUsdt:8, maxOrderUsdt:5, maxRiskPerTradeUsdt:0.5, maxLeverage:3, maxDailyLossUsdt:1, maxDailyTrades:3, maxOpenPositions:2, allowedMarkets:['TEST-USDT','TEST-USDT-SWAP'] };
const SPOT = { instId:'TEST-USDT', state:'live', minSz:'0.0001', lotSz:'0.000001', tickSz:'0.01' };
const SWAP = { instId:'TEST-USDT-SWAP', state:'live', minSz:'0.01', lotSz:'0.01', tickSz:'0.01', ctVal:'0.1', ctValCcy:'TEST' };
const base = { policy:P, availUsdt:9, positions:[], journal:{orders:{},owned:{},daily:{}}, day:'2000-01-01', dayStartEq:9.14, currentEq:9.14, currentLeverage:null };
const spot = (o={}) => ({ instId:'TEST-USDT', side:'buy', ordType:'market', size:0.001, entryReference:2300, stopLoss:2200, takeProfit:2400, leverage:1, ...o });
const swap = (o={}) => ({ instId:'TEST-USDT-SWAP', side:'sell', posSide:'net', ordType:'market', size:0.01, entryReference:2300, stopLoss:2350, takeProfit:2250, leverage:2, ...o });

test('zero-valued stopped policy is rejected', () => {
  const r = validateLivePolicy({ liveEnabled:false, stopped:true, maxCapitalUsdt:0, maxRiskPerTradeUsdt:0, maxLeverage:0, maxOpenPositions:0, maxDailyLossUsdt:0, maxDailyTrades:0, allowedMarkets:[] });
  assert.ok(r.includes('liveEnabled is not true')); assert.ok(r.some(x=>x.startsWith('maxOrderUsdt'))); assert.ok(r.includes('allowedMarkets empty'));
});
test('missing limit is never unlimited', () => { const p={...P}; delete p.maxDailyLossUsdt; assert.ok(validateLivePolicy(p).some(x=>x.startsWith('maxDailyLossUsdt'))); });
test('valid policy passes', () => assert.deepEqual(validateLivePolicy(P), []));
test('ALL is a valid live market policy', () => assert.deepEqual(validateLivePolicy({...P,allowedMarkets:['ALL']}), []));
test('ALL permits a newly listed live USDT spot instrument without a static whitelist', () => {
  const instrument={instId:'BAR-USDT',state:'live',minSz:'1',lotSz:'1',tickSz:'0.001'};
  const order=spot({instId:'BAR-USDT',size:2,entryReference:1,stopLoss:0.9,takeProfit:1.1});
  const r=preflightEntry({...base,policy:{...P,allowedMarkets:['ALL']},order,instrument});
  assert.equal(r.ok,true,r.reasons.join(';'));
});
test('ALL permits a live USDT swap while keeping risk limits', () => {
  const instrument={instId:'BAZ-USDT-SWAP',state:'live',minSz:'0.01',lotSz:'0.01',tickSz:'0.01',ctVal:'1',ctValCcy:'BAZ'};
  const order=swap({instId:'BAZ-USDT-SWAP',size:1,entryReference:2,stopLoss:2.1,takeProfit:1.9});
  const policy={...P,allowedMarkets:['ALL']};
  assert.equal(preflightEntry({...base,policy,order,instrument}).ok,true);
  assert.ok(preflightEntry({...base,policy:{...policy,maxOrderUsdt:1},order,instrument}).reasons.some(x=>x.includes('maxOrderUsdt')));
  assert.ok(preflightEntry({...base,policy,order,instrument:{...instrument,state:'suspend'}}).reasons.includes('instrument not live on OKX'));
});
test('ALL does not bypass capital, loss, leverage, daily or position caps', () => {
  const policy={...P,allowedMarkets:['ALL']};
  const instrument={instId:'BAZ-USDT-SWAP',state:'live',minSz:'0.01',lotSz:'0.01',tickSz:'0.01',ctVal:'1',ctValCcy:'BAZ'};
  const order=swap({instId:'BAZ-USDT-SWAP',size:1,entryReference:2,stopLoss:2.1,takeProfit:1.9});
  const check=(changes,expected)=>assert.ok(preflightEntry({...base,policy,order,instrument,...changes}).reasons.some(x=>x.includes(expected)),expected);
  check({policy:{...policy,maxCapitalUsdt:0.5,maxOrderUsdt:0.5}},'maxCapitalUsdt');
  check({policy:{...policy,maxRiskPerTradeUsdt:0.05}},'maxRiskPerTradeUsdt');
  check({order:{...order,leverage:4}},'maxLeverage');
  check({currentEq:8.2},'maxDailyLossUsdt');
  check({journal:{...base.journal,daily:{'2000-01-01':{trades:3}}}},'maxDailyTrades');
  check({positions:[{instId:'FOO-USDT-SWAP',pos:'1'},{instId:'TEST-USDT-SWAP',pos:'-1'}]},'maxOpenPositions');
});
test('valid small spot buy passes', () => { const r=preflightEntry({...base, order:spot(), instrument:SPOT}); assert.equal(r.ok,true,r.reasons.join(';')); assert.ok(Math.abs(r.computed.notional-2.3)<1e-9); });
test('valid swap short with SL passes', () => { const r=preflightEntry({...base, order:swap(), instrument:SWAP}); assert.equal(r.ok,true,r.reasons.join(';')); });
test('USDT futures receive the same capital, stop loss and leverage checks as swaps', () => {
  const instId='TEST-USDT-251226';
  const instrument={...SWAP,instId};
  const order=swap({instId,posSide:'short'});
  const policy={...P,allowedMarkets:['ALL']};
  assert.equal(marketOf(instId),'futures');
  assert.equal(preflightEntry({...base,policy,order,instrument,currentLeverage:2}).ok,true);
  assert.ok(preflightEntry({...base,policy,order:{...order,stopLoss:0},instrument,currentLeverage:2}).reasons.includes('stop-loss required for leveraged orders'));
  assert.ok(preflightEntry({...base,policy,order:{...order,leverage:4},instrument,currentLeverage:4}).reasons.some(x=>x.includes('maxLeverage')));
  assert.ok(preflightEntry({...base,policy,order,instrument,currentLeverage:3}).reasons.some(x=>x.includes('will not change leverage')));
});
test('below minSz rejected, not raised', () => { const r=preflightEntry({...base, order:swap({size:0.001}), instrument:SWAP}); assert.equal(r.ok,false); assert.ok(r.reasons.some(x=>x.includes('minSz'))); });
test('order over maxOrderUsdt rejected', () => { const r=preflightEntry({...base, order:spot({size:0.003}), instrument:SPOT}); assert.ok(r.reasons.some(x=>x.includes('maxOrderUsdt'))); });
test('swap without SL rejected', () => { const r=preflightEntry({...base, order:swap({stopLoss:0}), instrument:SWAP}); assert.ok(r.reasons.includes('stop-loss required for leveraged orders')); });
test('leverage over max rejected', () => { const r=preflightEntry({...base, order:swap({leverage:5}), instrument:SWAP}); assert.ok(r.reasons.some(x=>x.includes('maxLeverage'))); });
test('risk per trade enforced', () => { const r=preflightEntry({...base, order:swap({size:0.02,stopLoss:2600}), instrument:SWAP}); assert.ok(r.reasons.some(x=>x.includes('maxRiskPerTradeUsdt'))); });
test('daily trades cap', () => { const r=preflightEntry({...base, journal:{...base.journal,daily:{'2000-01-01':{trades:3}}}, order:spot(), instrument:SPOT}); assert.ok(r.reasons.some(x=>x.includes('maxDailyTrades'))); });
test('daily loss cap', () => { const r=preflightEntry({...base, currentEq:8.1, order:spot(), instrument:SPOT}); assert.ok(r.reasons.some(x=>x.includes('maxDailyLossUsdt'))); });
test('max open positions counts existing ETH short', () => { const pos=[{instId:'TEST-USDT-SWAP',posSide:'net',pos:'-0.58'},{instId:'FOO-USDT-SWAP',posSide:'net',pos:'1'}]; const r=preflightEntry({...base, positions:pos, order:spot(), instrument:SPOT}); assert.ok(r.reasons.some(x=>x.includes('maxOpenPositions'))); });
test('will not add to existing swap position', () => { const r=preflightEntry({...base, positions:[{instId:'TEST-USDT-SWAP',posSide:'net',pos:'-0.58'}], order:swap(), instrument:SWAP}); assert.ok(r.reasons.some(x=>x.includes('already exists'))); });
test('leverage mismatch with account not auto-changed', () => { const r=preflightEntry({...base, currentLeverage:'20', order:swap(), instrument:SWAP}); assert.ok(r.reasons.some(x=>x.includes('will not change leverage'))); });
test('insufficient balance', () => { const r=preflightEntry({...base, availUsdt:1, order:spot(), instrument:SPOT}); assert.ok(r.reasons.some(x=>x.includes('insufficient'))); });
test('instrument not allowed', () => { const r=preflightEntry({...base, order:spot({instId:'FOO-USDT'}), instrument:{...SPOT,instId:'FOO-USDT'}}); assert.ok(r.reasons.some(x=>x.includes('allowedMarkets'))); });
test('wrong-side SL rejected', () => { const r=preflightEntry({...base, order:swap({stopLoss:2200}), instrument:SWAP}); assert.ok(r.reasons.includes('stop-loss on wrong side of entry')); });
test('stopped policy blocks', () => { const r=preflightEntry({...base, policy:{...P,stopped:true}, order:spot(), instrument:SPOT}); assert.equal(r.ok,false); });
test('ownership: existing position protected by default', () => {
  assert.equal(ownershipCheck({journal:{owned:{}}, key:'TEST-USDT-SWAP:net'}).ok, false);
  assert.equal(ownershipCheck({journal:{owned:{}}, key:'TEST-USDT-SWAP:net', allowExistingPosition:true}).ok, true);
  assert.equal(ownershipCheck({journal:{owned:{'TEST-USDT-SWAP:net':{}}}, key:'TEST-USDT-SWAP:net'}).ok, true);
});
test('increments', () => assert.ok(checkIncrements({size:0.015,price:2300.005,instrument:SWAP}).length===2));
test('shanghaiDay', () => assert.equal(shanghaiDay(new Date('2000-01-01T17:00:00Z')), '2000-01-02'));
