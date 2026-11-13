import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdir, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const merge = require('deepmerge');
const semver = require('semver');

for (const file of ['package-lock.json', 'pro-test/package-lock.json', 'scripts/package-lock.json', 'integrations/zapier/package-lock.json']) {
  it(`${file} excludes the affected glob, minimatch, and uuid versions`, () => {
    const lock = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    for (const [path, entry] of Object.entries(lock.packages)) {
      const name = path.split('node_modules/').at(-1);
      const range = { glob: '>=9 <14.0.2', minimatch: '>=7 <11.0.1', uuid: '<11.1.1' }[name];
      if (range) assert.equal(semver.satisfies(entry.version, range), false, `${path}@${entry.version}`);
    }
  });
}

for (const parent of ['@sentry/bundler-plugins/vite', 'workbox-build']) {
  it(`${parent} retains glob APIs and stops filesystem traversal on abort`, async (t) => {
    const consumer = createRequire(require.resolve(parent));
    const { glob, globSync } = consumer('glob');
    const cwd = mkdtempSync(join(tmpdir(), 'wm-glob-regression-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    for (let i = 0; i < 4; i++) {
      mkdirSync(join(cwd, `${i}`, 'nested'), { recursive: true });
      writeFileSync(join(cwd, `${i}`, 'nested', 'file.js'), 'fixture');
    }
    assert.equal((await glob('**/*.js', { cwd })).length, 4);
    assert.equal(globSync('**/*.js', { cwd }).length, 4);
    const controller = new AbortController();
    let reads = 0;
    await assert.rejects(glob('**/*', { cwd, signal: controller.signal, fs: {
      readdir(...args) {
        if (++reads === 1) controller.abort(new Error('probe-abort'));
        readdir(...args);
      },
    } }), /probe-abort/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(reads, 1, 'aborted walk must not start child directory reads');
  });
}

for (const name of ['Pick', 'Ignore', 'Filter', 'Replace']) {
  const Filter = require(`stream-json/filters/${name}`);
  for (const filter of ['data', /^data$/]) {
    it(`${name} bounds unmatched nested input with a ${typeof filter} filter`, async () => {
      const input = '{"meta":'.repeat(1100) + '1' + '}'.repeat(1100);
      await assert.rejects(pipeline(
        Readable.from([input]), Filter.withParser({ filter }),
        async (source) => { for await (const _ of source) { /* drain */ } },
      ), { name: 'RangeError', message: /max depth/i });
    });
  }
}

it('path filters preserve normal extraction and enforce a lower caller depth limit', async () => {
  const Pick = require('stream-json/filters/Pick');
  const StreamValues = require('stream-json/streamers/StreamValues');
  const values = [];
  await pipeline(Readable.from(['{"meta":{},"data":{"value":42}}']), Pick.withParser({ filter: 'data' }),
    new StreamValues(), async (source) => { for await (const item of source) values.push(item.value); });
  assert.deepEqual(values, [{ value: 42 }]);
  await assert.rejects(pipeline(Readable.from(['[[[0]]]']), Pick.withParser({ filter: 'data', maxDepth: 2 }),
    async (source) => { for await (const _ of source) { /* drain */ } }), RangeError);
});

it('path filter depth ceiling cannot be raised or disabled', async () => {
  const Pick = require('stream-json/filters/Pick');
  for (const maxDepth of [Infinity, 100000]) {
    await assert.rejects(pipeline(Readable.from(['['.repeat(1100) + '0' + ']'.repeat(1100)]),
      Pick.withParser({ filter: 'data', maxDepth }),
      async (source) => { for await (const _ of source) { /* drain */ } }), RangeError);
  }
});

for (const target of [() => Object.create(null), () => JSON.parse('{"__proto__":{"isAdmin":true}}')]) {
  it('deepmerge preserves the result prototype for hostile source and target keys', () => {
    const result = merge(target(), JSON.parse('{"__proto__":{"isAdmin":true},"ok":1}'));
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(result.isAdmin, undefined);
    assert.equal(result.ok, 1);
    assert.equal({}.isAdmin, undefined);
  });
}

it('deepmerge preserves nested objects, arrays, symbols, and custom merge behavior', () => {
  const key = Symbol('key');
  const first = { nested: { a: 1 }, list: [1], [key]: { a: 1 } };
  const result = merge(first, { nested: { b: 2 }, list: [2], [key]: { b: 2 } });
  assert.deepEqual(result, { nested: { a: 1, b: 2 }, list: [1, 2], [key]: { a: 1, b: 2 } });
  assert.notEqual(result.nested, first.nested);
  assert.deepEqual(merge({ list: [1] }, { list: [2] }, { arrayMerge: (_a, b) => b }), { list: [2] });
  assert.deepEqual(merge.all([{ a: 1 }, { b: 2 }]), { a: 1, b: 2 });
  const nullTarget = merge({ session: null }, JSON.parse('{"session":{"__proto__":{"isAdmin":true}}}'));
  assert.equal(Object.getPrototypeOf(nullTarget.session), Object.prototype);
  assert.equal(nullTarget.session.isAdmin, undefined);
});

it('uuid consumers retain v4 generation and reject undersized v3/v5 output buffers', () => {
  for (const name of ['jayson', 'exceljs']) {
    const consumer = createRequire(require.resolve(name));
    const uuid = consumer('uuid');
    assert.ok(uuid.validate(uuid.v4()));
    for (const version of ['v3', 'v5']) {
      assert.throws(() => uuid[version]('test', uuid[version].DNS, new Uint8Array(8), 4), RangeError);
    }
  }
  assert.match(require('jayson').Utils.generateId(), /^[0-9a-f-]{36}$/);
});
