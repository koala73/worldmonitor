// RUN WITH: `npm run test:data` OR `node --import=tsx --test tests/mcp-bounded-body.test.mjs`.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  readBoundedRequestBody,
  readBoundedResponseBody,
  RequestBodyTooLargeError,
  ResponseBodyTooLargeError,
} from '../api/mcp/bounded-body.ts';
import {
  MAX_JSON_RPC_BODY_BYTES,
  MAX_MCP_PROXY_RESPONSE_BYTES,
} from '../api/mcp/body-limits.ts';

describe('readBoundedRequestBody', () => {
  it('exports the shared 256 KiB MCP JSON-RPC body cap', () => {
    assert.equal(MAX_JSON_RPC_BODY_BYTES, 256 * 1024);
  });

  it('returns the full body when under the cap', async () => {
    const payload = new TextEncoder().encode('{"ok":true}');
    const body = await readBoundedRequestBody(
      new Request('https://example.test', { method: 'POST', body: payload }),
      64,
    );
    assert.deepEqual(body, payload);
  });

  it('rejects an advertised Content-Length over the cap without reading', async () => {
    let pullCount = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    await assert.rejects(
      () => readBoundedRequestBody(
        new Request('https://example.test', {
          method: 'POST',
          headers: { 'Content-Length': '100' },
          // @ts-expect-error — undici duplex for streaming bodies
          duplex: 'half',
          body: stream,
        }),
        16,
      ),
      (err) => {
        assert.ok(err instanceof RequestBodyTooLargeError);
        assert.equal(err.maxBytes, 16);
        assert.match(err.message, /16/);
        return true;
      },
    );
    assert.equal(pullCount, 0, 'must not pull after Content-Length reject');
  });

  it('cancels a streamed body that crosses the cap mid-read', async () => {
    let cancelled = false;
    // Enqueue from pull() and close after a bounded number of pulls, rather than
    // enqueueing everything in start(). The cap still throws on the second chunk
    // (so `cancel` is observed on a live stream — closing in start() would make
    // reader.cancel() a spec no-op and never fire it), but a regression that
    // REMOVES the cap now drains and closes instead of hanging `node --test`,
    // which has no default timeout.
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 5) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });

    await assert.rejects(
      () => readBoundedRequestBody(
        new Request('https://example.test', {
          method: 'POST',
          // @ts-expect-error — undici duplex for streaming bodies
          duplex: 'half',
          body: stream,
        }),
        12,
      ),
      RequestBodyTooLargeError,
    );
    assert.equal(cancelled, true, 'oversized streams must be cancelled');
  });

  it('still caps when Content-Length understates the streamed body', async () => {
    let cancelled = false;
    // Self-terminating for the same reason as the fixture above.
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 5) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });

    await assert.rejects(
      () => readBoundedRequestBody(
        new Request('https://example.test', {
          method: 'POST',
          headers: { 'Content-Length': '8' },
          // @ts-expect-error — undici duplex for streaming bodies
          duplex: 'half',
          body: stream,
        }),
        10,
      ),
      RequestBodyTooLargeError,
    );
    assert.equal(cancelled, true, 'understated Content-Length must still cancel on overflow');
  });

  it('accepts a body whose size equals the cap', async () => {
    const payload = new Uint8Array(32).fill(7);
    const body = await readBoundedRequestBody(
      new Request('https://example.test', { method: 'POST', body: payload }),
      32,
    );
    assert.equal(body.byteLength, 32);
  });

  // `new Request({ body })` does not set Content-Length, so without an explicit
  // header the tests above only ever exercise the streaming path. In production
  // every non-chunked MCP POST advertises Content-Length, so the ACCEPT side of
  // that branch is the one real traffic takes — and the only case that fails a
  // `>=` off-by-one.
  it('accepts through the Content-Length branch at exactly the cap', async () => {
    const payload = new Uint8Array(32).fill(7);
    const body = await readBoundedRequestBody(
      new Request('https://example.test', {
        method: 'POST',
        headers: { 'Content-Length': '32' },
        body: payload,
      }),
      32,
    );
    assert.deepEqual(body, payload, 'the Content-Length path must return the body intact');
  });

  it('rejects one byte over the cap via Content-Length', async () => {
    const payload = new Uint8Array(33).fill(7);
    await assert.rejects(
      () => readBoundedRequestBody(
        new Request('https://example.test', {
          method: 'POST',
          headers: { 'Content-Length': '33' },
          body: payload,
        }),
        32,
      ),
      RequestBodyTooLargeError,
    );
  });

  // Every malformed Content-Length must fall through to the streaming cap rather
  // than admitting an unbounded body. Number('abc')/Number('100, 100') are NaN and
  // Number('1e999') is Infinity, so none of them satisfy the early-reject guard.
  for (const [label, header] of [
    ['non-numeric', 'abc'],
    ['negative', '-1'],
    ['empty', ''],
    ['duplicate-joined', '100, 100'],
    ['infinite', '1e999'],
  ]) {
    it(`falls through to the streaming cap on a ${label} Content-Length`, async () => {
      await assert.rejects(
        () => readBoundedRequestBody(
          new Request('https://example.test', {
            method: 'POST',
            headers: { 'Content-Length': header },
            body: new Uint8Array(64),
          }),
          32,
        ),
        RequestBodyTooLargeError,
      );
    });
  }

  it('returns an empty body for a POST with no body at all', async () => {
    const body = await readBoundedRequestBody(
      new Request('https://example.test', { method: 'POST' }),
      32,
    );
    assert.equal(body.byteLength, 0);
  });

  it('rejects a maxBytes that is not a non-negative finite number', async () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => readBoundedRequestBody(
          new Request('https://example.test', { method: 'POST', body: new Uint8Array(1) }),
          bad,
        ),
        TypeError,
        `maxBytes=${String(bad)} must be a TypeError`,
      );
    }
  });
});

describe('readBoundedResponseBody', () => {
  it('exports the 1 MiB MCP proxy response cap', () => {
    assert.equal(MAX_MCP_PROXY_RESPONSE_BYTES, 1024 * 1024);
  });

  it('accepts a response whose size equals the cap', async () => {
    const payload = new Uint8Array(32).fill(7);
    const body = await readBoundedResponseBody(new Response(payload), 32);

    assert.deepEqual(body, payload);
  });

  it('assembles a response split into one-byte fragments', async () => {
    const expected = new Uint8Array(4096);
    for (let index = 0; index < expected.length; index += 1) expected[index] = index % 251;
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset === expected.length) {
          controller.close();
          return;
        }
        controller.enqueue(expected.subarray(offset, offset + 1));
        offset += 1;
      },
    });

    const body = await readBoundedResponseBody(new Response(stream), expected.length);

    assert.deepEqual(body, expected);
  });

  it('rejects an advertised Content-Length over the cap without reading', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = {
      body,
      headers: new Headers({ 'Content-Length': '33' }),
    };

    await assert.rejects(
      () => readBoundedResponseBody(response, 32),
      ResponseBodyTooLargeError,
    );
    assert.equal(pulls, 0);
    assert.equal(cancelled, true);
  });

  it('cancels a chunked response as soon as it exceeds the cap', async () => {
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 3) return controller.close();
        controller.enqueue(new Uint8Array(12));
      },
      cancel() {
        cancelled = true;
      },
    });

    await assert.rejects(
      () => readBoundedResponseBody(new Response(stream), 20),
      ResponseBodyTooLargeError,
    );
    assert.equal(cancelled, true);
  });
});
