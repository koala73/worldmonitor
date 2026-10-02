import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as adapter from '../scripts/lib/provincial-511.mjs';
import { __testing__ as limiter } from '../scripts/_511-rate-limit.mjs';

// Execute the seeder's real fetch/publish callbacks without its CLI side effects.
const source = readFileSync(new URL('../scripts/seed-provincial-511.mjs', import.meta.url), 'utf8')
  .replace(/^import \{[\s\S]*?\} from '[^']+';\n/gm, '')
  .replace('loadEnvFile(import.meta.url);', '')
  .replace('export function declareRecords', 'function declareRecords');

async function tick(key, rejected = false) {
  limiter.reset();
  const requests = [];
  const warnings = [];
  const writes = [];
  let fetchTick;
  let options;
  const context = {
    ...adapter,
    process: { env: { ONTARIO_511_KEY: key, ALBERTA_511_KEY: 'ab-fixture', MANITOBA_511_KEY: 'mb-fixture' } },
    console: { warn: (message) => warnings.push(message), error: assert.fail },
    Date,
    runSeed: async (_domain, _resource, _key, fetchFn, opts) => { fetchTick = fetchFn; options = opts; },
    fetchVendor511: (config, opts) => adapter.fetchVendor511(config, {
      ...opts,
      sleep: async () => {},
      fetchFn: async (url) => {
        const parsed = new URL(url);
        requests.push(parsed);
        const failed = parsed.hostname === '511on.ca' && (rejected || parsed.searchParams.get('key') !== 'on-fixture');
        return new Response(JSON.stringify(failed ? { Message: 'Invalid Key' } : []), { status: failed ? 400 : 200 });
      },
    }),
    writeExtraKey: async (name, data) => writes.push({ name, data }),
    writeSeedMeta: async () => {},
    extendExistingTtl: async () => {},
  };
  vm.runInNewContext(source, context);
  const data = await fetchTick();
  const canonical = options.publishTransform(data);
  const valid = options.validateFn(canonical);
  if (valid) {
    writes.push({ name: 'infra:ontario-511:v1', data: canonical });
    await options.afterPublish(data);
  } else {
    await options.afterValidationSkip(data);
  }
  return { requests, warnings, writes, valid };
}

test('the seeder passes the trimmed Ontario key to all three resources', async () => {
  const result = await tick('  on-fixture  ');
  const ontario = result.requests.filter((url) => url.hostname === '511on.ca');
  assert.equal(ontario.length, 3);
  for (const url of ontario) assert.equal(url.searchParams.get('key'), 'on-fixture');
  assert.equal(result.valid, true, 'a complete empty poll is publishable');
  assert.equal(result.writes.length, 3);
  assert.ok(!JSON.stringify(result.writes).includes('on-fixture'));
});

for (const key of [undefined, '', '   ']) {
  test(`missing Ontario key (${JSON.stringify(key)}) skips requests and keeps other provinces publishable`, async () => {
    const result = await tick(key);
    assert.equal(result.requests.filter((url) => url.hostname === '511on.ca').length, 0);
    assert.equal(result.valid, false, 'missing key must not publish a fresh empty Ontario payload');
    assert.deepEqual(result.writes.map((write) => write.name), ['infra:alberta-511:v1', 'infra:manitoba-511:v1']);
    assert.match(result.warnings.join('\n'), /ONTARIO_511_KEY missing/);
  });
}

test('a rejected Ontario key preserves Ontario while other provinces publish', async () => {
  const result = await tick('on-fixture', true);
  assert.equal(result.valid, false);
  assert.deepEqual(result.writes.map((write) => write.name), ['infra:alberta-511:v1', 'infra:manitoba-511:v1']);
  assert.match(result.warnings.join('\n'), /all endpoints failed/);
  assert.ok(!result.warnings.join('\n').includes('on-fixture'));
});
