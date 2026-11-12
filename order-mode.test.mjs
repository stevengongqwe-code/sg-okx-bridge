import test from 'node:test';
import assert from 'node:assert/strict';
import { entryPosSide, selectPosition, instrumentExposure, leveragePlan, leverageArgs } from './order-mode.mjs';

test('hedge mode derives entry side for swap and futures; net mode omits it', () => {
  for (const market of ['swap','futures']) {
    assert.equal(entryPosSide({posMode:'long_short_mode',market,side:'buy'}),'long');
    assert.equal(entryPosSide({posMode:'long_short_mode',market,side:'sell'}),'short');
    assert.equal(entryPosSide({posMode:'net_mode',market,side:'buy',requested:'net'}),undefined);
    assert.throws(()=>entryPosSide({posMode:'long_short_mode',market,side:'buy',requested:'short'}));
    assert.throws(()=>entryPosSide({posMode:'net_mode',market,side:'sell',requested:'short'}));
  }
});

test('close and TP/SL select the actual long or short position', () => {
  const positions=[
    {instId:'TEST-USDT-SWAP',mgnMode:'isolated',posSide:'long',pos:'2'},
    {instId:'TEST-USDT-SWAP',mgnMode:'isolated',posSide:'short',pos:'3'},
    {instId:'FOO-USDT-SWAP',mgnMode:'isolated',posSide:'long',pos:'1'}
  ];
  assert.equal(selectPosition({posMode:'long_short_mode',instId:'TEST-USDT-SWAP',mgnMode:'isolated',requested:'short',positions}).posSide,'short');
  assert.throws(()=>selectPosition({posMode:'long_short_mode',instId:'TEST-USDT-SWAP',mgnMode:'isolated',requested:'net',positions}),/Multiple positions/);
  assert.equal(selectPosition({posMode:'long_short_mode',instId:'FOO-USDT-SWAP',mgnMode:'isolated',requested:'net',positions}).posSide,'long');
  assert.equal(selectPosition({posMode:'net_mode',instId:'TEST-USDT-SWAP',mgnMode:'isolated',requested:'net',positions:[{instId:'TEST-USDT-SWAP',mgnMode:'isolated',posSide:'net',pos:'-2'}]}).posSide,undefined);
});

test('only this instrument exposure prevents changing leverage', () => {
  const instId='TEST-USDT-SWAP';
  const other={positions:[{instId:'FOO-USDT-SWAP',pos:'1'}],pendingOrders:{swap:[{instId:'OTHER-USDT-SWAP'}]},pendingAlgoOrders:{swap:[]}};
  const clean=instrumentExposure({instId,...other});
  assert.deepEqual(clean,{position:false,pending:false});
  assert.deepEqual(leveragePlan({requested:15,current:3,maxPolicy:20,maxExchange:50,mgnMode:'isolated',exposure:clean}),{needsSet:true,leverageForRisk:15});
  const position=instrumentExposure({instId,...other,positions:[...other.positions,{instId,pos:'1'}]});
  const pending=instrumentExposure({instId,...other,pendingAlgoOrders:{swap:[{instId}]}});
  assert.throws(()=>leveragePlan({requested:15,current:3,maxPolicy:20,maxExchange:50,mgnMode:'isolated',exposure:position}),/position or pending/);
  assert.throws(()=>leveragePlan({requested:15,current:3,maxPolicy:20,maxExchange:50,mgnMode:'isolated',exposure:pending}),/position or pending/);
  assert.throws(()=>instrumentExposure({instId,positions:[],pendingOrders:{swap:{}},pendingAlgoOrders:{swap:[]}}),/Cannot verify/);
});

test('policy and exchange maxima remain binding; leverage CLI uses exact side', () => {
  const base={requested:15,current:3,maxPolicy:20,maxExchange:50,mgnMode:'isolated',exposure:{position:false,pending:false}};
  assert.throws(()=>leveragePlan({...base,maxPolicy:10}),/policy/);
  assert.throws(()=>leveragePlan({...base,maxExchange:10}),/exchange/);
  assert.throws(()=>leveragePlan({...base,mgnMode:'cross'}),/isolated/);
  assert.deepEqual(leveragePlan({...base,current:15}),{needsSet:false,leverageForRisk:15});
  assert.deepEqual(leverageArgs({market:'swap',instId:'TEST-USDT-SWAP',leverage:15,posSide:'short'}),['swap','leverage','--instId','TEST-USDT-SWAP','--lever','15','--mgnMode','isolated','--posSide','short']);
  assert.ok(!leverageArgs({market:'futures',instId:'FOO-USDT-251226',leverage:3}).includes('--posSide'));
});
