// RUN WITH: `npm run test:data` OR `node --import=tsx --test tests/mcp-bounded-body.test.mjs`.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
} from '../api/mcp/bounded-body.ts';
import { MAX_JSON_RPC_BODY_BYTES } from '../api/mcp/body-limits.ts';

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
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(10));
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
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
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
});
