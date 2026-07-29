import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

const {
  _readBoundedResponseStream,
  parseProxyConfig,
} = createRequire(import.meta.url)('../scripts/_proxy-utils.cjs');

describe('proxy utilities', () => {
  it('applies standard ports when URL parsing normalizes them away', () => {
    assert.deepEqual(
      parseProxyConfig('https://proxy-user:proxy-secret@proxy.test:443'),
      {
        host: 'proxy.test',
        port: 443,
        auth: 'proxy-user:proxy-secret',
        tls: true,
      },
    );
    assert.equal(parseProxyConfig('ftp://proxy.test/resource'), null);
  });

  it('rejects a response stream as soon as it exceeds the byte limit', async () => {
    await assert.rejects(
      _readBoundedResponseStream(
        Readable.from([Buffer.alloc(64), Buffer.alloc(65)]),
        128,
      ),
      (error) => error.code === 'RESPONSE_TOO_LARGE',
    );

    const exactLimit = await _readBoundedResponseStream(
      Readable.from([Buffer.alloc(64), Buffer.alloc(64)]),
      128,
    );
    assert.equal(exactLimit.byteLength, 128);
  });
});
