import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod';
import { positiveDecimal, nonnegativeDecimal, toPlainDecimal, decimalCliArg } from './decimal.mjs';

test('MCP input schema advertises both number and string', () => {
  for (const field of ['price', 'size']) {
    const schema = z.toJSONSchema(z.object({ [field]: positiveDecimal }), { io: 'input' });
    assert.deepEqual(schema.properties[field].anyOf.map(x => x.type), ['number', 'string']);
  }
});

test('PEPE price string and JSON number produce the same plain CLI argument', () => {
  for (const input of ['0.0000044276', 4.4276e-06]) {
    const price = positiveDecimal.parse(input);
    assert.equal(price, 4.4276e-06);
    for (const flag of ['--px', '--tpTriggerPx', '--slTriggerPx', '--newTpTriggerPx', '--newSlTriggerPx']) {
      assert.deepEqual(decimalCliArg(flag, price), [flag, '0.0000044276']);
    }
  }
});

test('size accepts number and string, and CLI output has no exponent', () => {
  for (const input of ['1000000000000000000000', 1e21, '0.00000001', 1e-8]) {
    const size = positiveDecimal.parse(input);
    const [, value] = decimalCliArg('--sz', size);
    assert.ok(!/[eE]/.test(value));
    assert.equal(Number(value), size);
  }
  assert.deepEqual(decimalCliArg('--sz', positiveDecimal.parse('1000000000000000000000')), ['--sz', '1000000000000000000000']);
  assert.deepEqual(decimalCliArg('--sz', positiveDecimal.parse(1e-8)), ['--sz', '0.00000001']);
});

test('trailing zeros are removed and invalid prices are rejected', () => {
  assert.equal(toPlainDecimal(4.427600e-6), '0.0000044276');
  assert.equal(toPlainDecimal(1.2300), '1.23');
  assert.equal(nonnegativeDecimal.parse('0'), 0);
  for (const value of ['', 'abc', '-0.1', 'Infinity', 0, Infinity, -1]) {
    assert.equal(positiveDecimal.safeParse(value).success, false);
  }
  for (const value of ['', 'abc', '-0.1', 'Infinity', Infinity, -1]) {
    assert.equal(nonnegativeDecimal.safeParse(value).success, false);
  }
});
