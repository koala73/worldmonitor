import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { jsonResponse } from '../api/_json-response.js';

async function roundTrip(value) {
  return jsonResponse(value, 200).json();
}

describe('jsonResponse', () => {
  it('preserves plain cause, stack, stackTrace, and __proto__ properties', async () => {
    const value = JSON.parse('{"cause":"domain-value","stack":"domain-stack","stackTrace":["domain-trace"],"__proto__":{"type":"string"}}');

    assert.deepEqual(await roundTrip(value), value);
  });

  it('preserves valid JSON objects beyond depth 20', async () => {
    let value = { leaf: { type: ['number', 'null'] } };
    for (let depth = 0; depth < 32; depth += 1) value = { nested: value };

    assert.deepEqual(await roundTrip(value), value);
  });

  it('serializes actual Error instances without stack or cause details', async () => {
    const error = new Error('safe message', { cause: new Error('secret cause') });
    Object.defineProperty(error, 'stackTrace', { enumerable: true, value: ['secret trace'] });
    error.toJSON = () => ({ message: 'unsafe custom value', stack: 'secret stack' });

    assert.deepEqual(await roundTrip({ error }), { error: { error: 'safe message' } });
    assert.deepEqual(await roundTrip(error), { error: 'safe message' });
  });

  it('fails explicitly for circular values instead of inventing a truncation sentinel', () => {
    const value = {};
    value.self = value;

    assert.throws(() => jsonResponse(value, 200), /circular|cyclic/i);
  });
});
