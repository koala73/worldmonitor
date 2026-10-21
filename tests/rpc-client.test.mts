import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getRpcErrorStatusCode } from '../src/services/rpc-client';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('getRpcErrorStatusCode returns numeric statusCode from object errors', () => {
  assert.equal(getRpcErrorStatusCode({ statusCode: 404 }), 404);
  assert.equal(getRpcErrorStatusCode({ statusCode: 403, message: 'forbidden' }), 403);
});

test('getRpcErrorStatusCode returns undefined for non-object inputs', () => {
  assert.equal(getRpcErrorStatusCode(null), undefined);
  assert.equal(getRpcErrorStatusCode(undefined), undefined);
  assert.equal(getRpcErrorStatusCode('error'), undefined);
  assert.equal(getRpcErrorStatusCode(500), undefined);
});

test('getRpcErrorStatusCode returns undefined when statusCode is missing or non-numeric', () => {
  assert.equal(getRpcErrorStatusCode({}), undefined);
  assert.equal(getRpcErrorStatusCode({ statusCode: '404' }), undefined);
  assert.equal(getRpcErrorStatusCode({ statusCode: null }), undefined);
});

test('economic deploy-skew fallback branches on getRpcErrorStatusCode 404', () => {
  const source = readFileSync(resolve(root, 'src/services/economic/index.ts'), 'utf8');
  const catchBlock = source.slice(source.indexOf('async () => {'), source.indexOf('}, emptyFredBatchFallback'));

  assert.match(
    catchBlock,
    /getRpcErrorStatusCode\(err\) === 404/,
    'fetchFredData must use duck-typed 404 detection for deploy-skew fallback',
  );
});
