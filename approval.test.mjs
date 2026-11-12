import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyOperation, assertPublicOperationAllowed } from './approval.mjs';
test('only the explicit read-only exchange commands bypass an action approval',()=>{
 for (const a of [['account','balance'],['account','positions'],['account','config'],['swap','orders'],['swap','algo','orders'],['spot','get'],['market','ticker','TEST-USDT']]) assert.equal(isReadOnlyOperation(a),true,a.join(' '));
 for (const a of [['swap','place'],['swap','cancel'],['swap','algo','place'],['swap','algo','amend'],['swap','leverage'],['account','transfer'],['market','unknown'],['unknown']]) assert.equal(isReadOnlyOperation(a),false,a.join(' '));
});

test('public preview rejects real and simulated order writes regardless of approval',()=>{
 for(const a of [['swap','place'],['swap','cancel'],['swap','algo','place'],['swap','algo','amend'],['swap','leverage'],['account','transfer'],['unknown']]) assert.throws(()=>assertPublicOperationAllowed(a),/disabled in public preview/i);
 assert.doesNotThrow(()=>assertPublicOperationAllowed(['market','ticker','TEST-USDT']));
});
