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

  it('serializes a value referenced twice without treating it as circular', async () => {
    const shared = { n: 1 };

    assert.deepEqual(await roundTrip({ a: shared, b: shared }), { a: { n: 1 }, b: { n: 1 } });
  });

  it('replaces an Error held inside an array', async () => {
    assert.deepEqual(await roundTrip({ list: [new Error('inside array')] }), { list: [{ error: 'inside array' }] });
  });

  it('sets Content-Length to the UTF-8 byte length of a multi-byte body', async () => {
    const res = jsonResponse({ text: 'héllo 世界 🌍' }, 200);
    const bytes = new Uint8Array(await res.clone().arrayBuffer());

    assert.equal(res.headers.get('Content-Length'), String(bytes.byteLength));
    assert.deepEqual(await res.json(), { text: 'héllo 世界 🌍' });
  });

  it('replaces an Error that a toJSON method returns, keeping only its message', async () => {
    const error = new Error('safe message');
    error.toJSON = () => ({ message: 'unsafe custom value', stack: 'secret stack' });

    assert.deepEqual(await roundTrip({ toJSON: () => ({ error }) }), { error: { error: 'safe message' } });
  });

  it('replaces a plain Error that a toJSON method returns', async () => {
    assert.deepEqual(await roundTrip({ toJSON: () => ({ failure: new Error('boom') }) }), { failure: { error: 'boom' } });
  });

  it('serializes the value a getter returns on its first read', async () => {
    let reads = 0;
    const body = { get value() { reads += 1; return reads; } };

    assert.deepEqual(await roundTrip(body), { value: 1 });
  });
});

