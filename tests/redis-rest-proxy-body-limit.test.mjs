// Same constraint as redis-rest-proxy-url-masking.test.mjs: docker/redis-rest-proxy.mjs
// connects to Redis and calls server.listen() as a top-level side effect on
// import, so readBody can't be imported directly. Extract its real source
// (plus the PayloadTooLargeError class and MAX_BODY_BYTES it closes over)
// via regex and eval it standalone instead.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const proxySrc = readFileSync(resolve(here, '../docker/redis-rest-proxy.mjs'), 'utf8');

const maxBodyLine = proxySrc.match(/const MAX_BODY_BYTES = [^\n]+/)?.[0];
const errorClassSrc = proxySrc.match(/class PayloadTooLargeError[\s\S]*?\n\}/)?.[0];
const readBodySrc = proxySrc.match(/async function readBody\([\s\S]*?\n\}/)?.[0];

function buildReadBody(envOverride) {
  const prev = process.env.SRH_MAX_BODY_BYTES;
  if (envOverride === undefined) delete process.env.SRH_MAX_BODY_BYTES;
  else process.env.SRH_MAX_BODY_BYTES = String(envOverride);
  try {
    // eslint-disable-next-line no-new-func
    return new Function(
      `${maxBodyLine}\n${errorClassSrc}\n${readBodySrc}\nreturn { readBody, PayloadTooLargeError, MAX_BODY_BYTES };`,
    )();
  } finally {
    if (prev === undefined) delete process.env.SRH_MAX_BODY_BYTES;
    else process.env.SRH_MAX_BODY_BYTES = prev;
  }
}

function fakeReq(chunks, { onDestroy } = {}) {
  return {
    destroy: () => { onDestroy?.(); },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
  };
}

describe('redis-rest-proxy body size limit (#7099)', () => {
  it('all three extraction targets are defined in redis-rest-proxy.mjs', () => {
    assert.ok(maxBodyLine, 'MAX_BODY_BYTES not found');
    assert.ok(errorClassSrc, 'PayloadTooLargeError not found');
    assert.ok(readBodySrc, 'readBody not found');
  });

  it('defaults MAX_BODY_BYTES to 8 MB when SRH_MAX_BODY_BYTES is unset', () => {
    const { MAX_BODY_BYTES } = buildReadBody(undefined);
    assert.equal(MAX_BODY_BYTES, 8 * 1024 * 1024);
  });

  it('honors SRH_MAX_BODY_BYTES when set', () => {
    const { MAX_BODY_BYTES } = buildReadBody(2_000_000);
    assert.equal(MAX_BODY_BYTES, 2_000_000);
  });

  it('resolves normally for a body under the limit', async () => {
    const { readBody } = buildReadBody(1_000);
    const result = await readBody(fakeReq(['hello ', 'world']));
    assert.equal(result, 'hello world');
  });

  it('throws PayloadTooLargeError, not a generic Error, for an oversized body', async () => {
    const { readBody, PayloadTooLargeError } = buildReadBody(10);
    await assert.rejects(
      readBody(fakeReq(['this is way more than ten bytes'])),
      PayloadTooLargeError,
    );
  });

  it('never calls req.destroy() on an oversized body (regression guard for #7099)', async () => {
    const { readBody } = buildReadBody(10);
    let destroyed = false;
    await assert.rejects(
      readBody(fakeReq(['this is way more than ten bytes'], { onDestroy: () => { destroyed = true; } })),
    );
    assert.equal(destroyed, false, 'readBody must not kill the socket before a response can be written');
  });

  it('the request handler replies 413 for PayloadTooLargeError instead of falling through to 500 (regression guard)', () => {
    assert.match(
      proxySrc,
      /if \(err instanceof PayloadTooLargeError\)\s*\{\s*res\.writeHead\(413\)/,
    );
  });
});
