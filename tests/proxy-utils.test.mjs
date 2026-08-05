import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

const {
  _readBoundedResponseStream,
  parseProxyConfig,
  parseProxyConfigForAttempt,
  proxyFetch,
  resolveProxyString,
} = createRequire(import.meta.url)('../scripts/_proxy-utils.cjs');

function proxyFetchHarness(response, { maxResponseBytes = Infinity } = {}) {
  let destroyed = 0;
  return {
    options: {
      maxResponseBytes,
      connectTunnel: async () => ({ socket: {}, destroy: () => { destroyed += 1; } }),
      requestFn: (_options, onResponse) => {
        const req = new EventEmitter();
        req.end = () => queueMicrotask(() => onResponse(response));
        req.write = () => {};
        return req;
      },
    },
    destroyed: () => destroyed,
  };
}

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

  it('rewrites the Decodo CONNECT host to the curl endpoint regardless of case', () => {
    // The curl endpoint differs from the CONNECT endpoint, so this rewrite is
    // what routes a curl-based caller correctly. parseProxyConfig's
    // host:port:user:pass branch returns the host verbatim, so an operator's
    // casing reaches the compare un-normalized -- a case-sensitive prefix
    // match silently leaves the caller pointed at the CONNECT endpoint.
    for (const equivalentHost of [
      'gate.decodo.com',
      'GATE.DECODO.COM',
      'Gate.Decodo.Com',
      'gate.decodo.com.',
    ]) {
      assert.equal(
        resolveProxyString(`${equivalentHost}:10001:proxy-user:proxy-secret`),
        'proxy-user:proxy-secret@us.decodo.com:10001',
        equivalentHost,
      );
    }

    // Only the Decodo gateway is rewritten. A prefix match would send these to a
    // Decodo endpoint with their credentials attached, so each must pass through
    // untouched: a same-prefix foreign host, its uppercase spelling, and a host
    // that merely contains `gate.` away from the start.
    for (const foreignHost of [
      'gate.proxy.test',
      'GATE.PROXY.TEST',
      'proxy.gate.example.com',
    ]) {
      assert.equal(
        resolveProxyString(`${foreignHost}:10001:proxy-user:proxy-secret`),
        `proxy-user:proxy-secret@${foreignHost}:10001`,
        foreignHost,
      );
    }

    assert.equal(
      resolveProxyString('https://proxy-user:proxy-secret@proxy.test:443'),
      'proxy-user:proxy-secret@proxy.test:443',
    );
    assert.equal(resolveProxyString(''), '');
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

  it('preserves redirect Location through proxyFetch and still bounds its body', async () => {
    const redirectResponse = Readable.from([Buffer.from('redirect')]);
    redirectResponse.statusCode = 302;
    redirectResponse.headers = {
      location: 'https://trusted.example/signed.xml',
      'content-type': 'text/plain',
    };
    const redirectHarness = proxyFetchHarness(redirectResponse, { maxResponseBytes: 64 });

    const redirect = await proxyFetch('https://origin.example/sdn.xml', {
      host: 'proxy.example', port: 443, auth: 'user:pass', tls: true,
    }, redirectHarness.options);

    assert.deepEqual(redirect, {
      ok: false,
      status: 302,
      location: 'https://trusted.example/signed.xml',
      buffer: Buffer.from('redirect'),
      contentType: 'text/plain',
    });
    assert.equal(redirectHarness.destroyed(), 1);

    const oversizedResponse = Readable.from([Buffer.alloc(65)]);
    oversizedResponse.statusCode = 302;
    oversizedResponse.headers = { location: 'https://trusted.example/signed.xml' };
    const oversizedHarness = proxyFetchHarness(oversizedResponse, { maxResponseBytes: 64 });

    await assert.rejects(
      proxyFetch('https://origin.example/sdn.xml', {
        host: 'proxy.example', port: 443, auth: 'user:pass', tls: true,
      }, oversizedHarness.options),
      (error) => error.code === 'RESPONSE_TOO_LARGE',
    );
    assert.equal(oversizedHarness.destroyed(), 1);
  });
});
