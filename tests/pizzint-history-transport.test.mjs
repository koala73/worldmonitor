import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const source = relay.slice(relay.indexOf('function upstashEval('), relay.indexOf('function upstashReleaseLockIfOwner('));

for (const event of ['error', 'aborted']) {
  test(`archive transport settles after response ${event}`, async () => {
    const response = new EventEmitter();
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => response.emit(event, new Error('fixture failure')));
    const context = vm.createContext({ URL, UPSTASH_ENABLED: true, UPSTASH_REDIS_REST_URL: 'https://fixture.invalid', UPSTASH_REDIS_REST_TOKEN: 'fixture', UPSTASH_HTTP_MODULE: { request(_url, _options, callback) { callback(response); return request; } } });
    vm.runInContext(source, context);
    assert.equal(await vm.runInContext('upstashEval("fixture", [], [])', context), null);
  });
}
