import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const jayson = require('jayson');
const StreamValues = require('stream-json/streamers/StreamValues');
const katex = require('katex');
const { load } = require('js-yaml');
const semver = require('semver');

const inputs = [
  '{"__proto__":{"isAdmin":true},"name":"bob"}',
  '{"__proto__":null,"name":"bob"}',
  '{"user":{"__proto__":{"isAdmin":true},"name":"alice"}}',
  '{"__proto__":["admin"],"name":"bob"}',
  '{"__proto__":"value","name":"bob"}',
];

for (const input of inputs) {
  it(`jayson preserves JSON.parse semantics for ${input}`, async () => {
    const value = await new Promise((resolve, reject) => {
      jayson.Utils.parseStream(Readable.from([...input]), {}, (error, value) => {
        if (error) reject(error);
        else resolve(value);
      });
    });
    assert.deepEqual(value, JSON.parse(input));
    const object = value.user ?? value;
    assert.equal(Object.getPrototypeOf(object), Object.prototype);
    assert.equal(Object.hasOwn(object, '__proto__'), true);
    assert.equal(object.isAdmin, undefined);
  });

  it(`stream-json preserves own keys with a reviver for ${input}`, async () => {
    const values = [];
    await pipeline(
      Readable.from([input]),
      StreamValues.withParser({ reviver: (_key, value) => value }),
      async (source) => { for await (const item of source) values.push(item.value); },
    );
    assert.deepEqual(values, [JSON.parse(input)]);
  });
}

it('stream-json respects reviver deletion and parses consecutive values', async () => {
  const values = [];
  await pipeline(
    Readable.from(['{"__proto__":null,"keep":1} {"keep":2}']),
    StreamValues.withParser({ reviver: (key, value) => key === '__proto__' ? undefined : value }),
    async (source) => { for await (const item of source) values.push(item.value); },
  );
  assert.deepEqual(values, [{ keep: 1 }, { keep: 2 }]);
});

it('KaTeX ignores inherited trust while preserving explicit trusted rendering', () => {
  const expression = '\\href{javascript:alert(1)}{click}';
  assert.equal(katex.renderToString(expression, Object.create({ trust: true })).includes('href="javascript:alert(1)"'), false);
  assert.equal(katex.renderToString(expression, { trust: true }).includes('href="javascript:alert(1)"'), true);
  assert.match(katex.renderToString('x^2 + 1'), /katex/);
});

it('Umami selects only Hono versions with the JSX escaping fix', () => {
  const lock = load(readFileSync(new URL('../docker/umami/runtime/pnpm-lock.yaml', import.meta.url), 'utf8'));
  const versions = Object.keys(lock.packages).filter((key) => key.startsWith('hono@')).map((key) => key.slice(5));
  assert.ok(versions.length > 0);
  for (const version of versions) assert.ok(semver.gte(version, '4.13.7'));
});
