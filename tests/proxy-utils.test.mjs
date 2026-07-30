import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

const {
  _readBoundedResponseStream,
  parseProxyConfig,
  parseProxyConfigForAttempt,
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

  it('uses a distinct Decodo sticky port per attempt and preserves other routes', () => {
    assert.equal(
      parseProxyConfigForAttempt(
        'gate.decodo.com:10001:proxy-user:proxy-secret',
        1,
      ).port,
      10002,
    );
    assert.equal(
      parseProxyConfigForAttempt(
        'gate.decodo.com:49999:proxy-user:proxy-secret',
        1,
      ).port,
      10001,
    );
    for (const rotatingPort of [7000, 10000]) {
      assert.equal(
        parseProxyConfigForAttempt(
          `gate.decodo.com:${rotatingPort}:proxy-user:proxy-secret`,
          1,
        ).port,
        rotatingPort,
      );
    }
    // The host:port:user:pass form preserves hostname casing (the URL form does
    // not), so provider detection must normalize rather than compare verbatim.
    for (const equivalentHost of ['GATE.DECODO.COM', 'Gate.Decodo.Com', 'gate.decodo.com.']) {
      assert.equal(
        parseProxyConfigForAttempt(
          `${equivalentHost}:10001:proxy-user:proxy-secret`,
          1,
        ).port,
        10002,
        equivalentHost,
      );
      assert.equal(
        parseProxyConfigForAttempt(
          `${equivalentHost}:10001:proxy-user:proxy-secret`,
          1,
        ).host,
        equivalentHost,
      );
    }
    assert.equal(
      parseProxyConfigForAttempt(
        'https://proxy-user:proxy-secret@proxy.test:443',
        1,
      ).port,
      443,
    );
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
