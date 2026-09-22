import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { PassThrough, Readable } from 'node:stream';
import { describe, it } from 'node:test';

const {
  _readBoundedResponseStream,
  parseProxyConfig,
  parseProxyConfigForAttempt,
  proxyConnectTunnel,
  proxyFetch,
  resolveProxyString,
  resolveProxyStringForAttempt,
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
  for (const stage of ['proxy_connection', 'proxy_connect', 'target_tls']) {
    it(`preserves the error and reports the observed ${stage} failure`, async (t) => {
      const failure = Object.assign(new Error('fixture connection reset'), { code: 'ECONNRESET' });
      const socket = Object.assign(new EventEmitter(), {
        destroy() {}, pause() {}, resume() {},
        write() {
          queueMicrotask(() => socket.emit('data', Buffer.from(
            stage === 'proxy_connect' ? 'HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'
              : 'HTTP/1.1 200 Connection established\r\n\r\n',
          )));
        },
      });
      t.mock.method(net, 'connect', (_options, onConnect) => {
        queueMicrotask(() => stage === 'proxy_connection' ? socket.emit('error', failure) : onConnect());
        return socket;
      });
      t.mock.method(tls, 'connect', () => {
        const target = new EventEmitter();
        queueMicrotask(() => target.emit('error', failure));
        return target;
      });
      await assert.rejects(proxyConnectTunnel('origin.test', {
        host: 'proxy.test', port: 8080, auth: 'user:secret', tls: false,
      }), error => {
        if (stage === 'proxy_connect') {
          assert.equal(error.proxyConnect, true);
          assert.equal(error.status, 407);
        } else {
          assert.equal(error, failure);
          assert.equal(error.code, 'ECONNRESET');
        }
        assert.deepEqual(error.proxyFailure, {
          stage, httpStatus: null,
          proxyConnectStatus: stage === 'proxy_connection' ? null : stage === 'proxy_connect' ? 407 : 200,
        });
        assert.equal(Object.keys(error).includes('proxyFailure'), false);
        return true;
      });
    });
  }

  for (const stage of ['response_headers', 'response_body']) {
    it(`retains status and rejection identity for a proxy ${stage} failure`, async () => {
      const failure = Object.assign(new Error('fixture response reset'), { code: 'ECONNRESET' });
      let destroyed = 0;
      await assert.rejects(proxyFetch('https://origin.test/report', { host: 'proxy.test', port: 8080 }, {
        connectTunnel: async () => ({ socket: {}, destroy() { destroyed += 1; } }),
        requestFn: (_options, onResponse) => {
          const req = new EventEmitter();
          req.end = () => {
            if (stage === 'response_headers') queueMicrotask(() => req.emit('error', failure));
            else {
              const response = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
              onResponse(response);
              response.destroy(failure);
            }
          };
          return req;
        },
      }), error => {
        assert.equal(error, failure);
        assert.equal(error.code, 'ECONNRESET');
        assert.deepEqual(error.proxyFailure, {
          stage, httpStatus: stage === 'response_body' ? 200 : null, proxyConnectStatus: null,
        });
        return true;
      });
      assert.equal(destroyed, 1);
    });
  }

  it('does not replace frozen or primitive abort reasons for diagnostics', async () => {
    for (const reason of [Object.freeze(new Error('frozen failure')), 'plain failure']) {
      const controller = new AbortController();
      await assert.rejects(proxyFetch('https://origin.test/report', { host: 'proxy.test', port: 8080 }, {
        signal: controller.signal,
        connectTunnel: async () => ({ socket: {}, destroy() {} }),
        requestFn: () => Object.assign(new EventEmitter(), { end() { controller.abort(reason); } }),
      }), error => {
        assert.equal(error, reason);
        return true;
      });
    }
  });

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

  it('rotates China sticky ports within their country range without changing the route', () => {
    for (const host of ['cn.decodo.com', 'CN.DECODO.COM', 'Cn.Decodo.Com', 'cn.decodo.com.']) {
      const raw = `${host}:30001:proxy-user:proxy-secret`;
      const initial = parseProxyConfig(raw);
      assert.deepEqual(parseProxyConfigForAttempt(raw, 0), initial);
      assert.deepEqual(parseProxyConfigForAttempt(raw, 1), { ...initial, port: 30002 });
      assert.equal(parseProxyConfigForAttempt(`${host}:39999:proxy-user:proxy-secret`, 1).port, 30001);
      for (const port of [7000, 10000, 29999, 30000, 40000, 49999]) {
        assert.equal(parseProxyConfigForAttempt(`${host}:${port}:proxy-user:proxy-secret`, 1).port, port);
      }
    }
    for (const protocol of ['http', 'https']) {
      const raw = `${protocol}://proxy-user:proxy-secret@cn.decodo.com:30001`;
      assert.deepEqual(parseProxyConfigForAttempt(raw, 1), { ...parseProxyConfig(raw), port: 30002 });
    }
    for (const host of ['cn.decodo.com.proxy.test', 'cn.proxy.test', 'jp.decodo.com']) {
      const raw = `${host}:30001:proxy-user:proxy-secret`;
      assert.deepEqual(parseProxyConfigForAttempt(raw, 1), parseProxyConfig(raw));
    }
    assert.equal(
      resolveProxyStringForAttempt(1, 'cn.decodo.com:30001:proxy-user:proxy-secret'),
      'proxy-user:proxy-secret@cn.decodo.com:30002',
    );
  });

  it('rotates the curl proxy string onto a distinct Decodo sticky exit per attempt', () => {
    const decodo = 'gate.decodo.com:10001:proxy-user:proxy-secret';

    // Attempt 0 must be byte-identical to the non-rotating resolver, so adopting
    // rotation cannot silently move the default route onto a different exit.
    assert.equal(resolveProxyStringForAttempt(0, decodo), resolveProxyString(decodo));
    assert.equal(
      resolveProxyStringForAttempt(0, decodo),
      'proxy-user:proxy-secret@us.decodo.com:10001',
    );
    assert.equal(
      resolveProxyStringForAttempt(1, decodo),
      'proxy-user:proxy-secret@us.decodo.com:10002',
    );
    assert.equal(
      resolveProxyStringForAttempt(3, decodo),
      'proxy-user:proxy-secret@us.decodo.com:10004',
    );
    // Sticky ports wrap rather than escaping the provider's assigned range.
    assert.equal(
      resolveProxyStringForAttempt(1, 'gate.decodo.com:49999:proxy-user:proxy-secret'),
      'proxy-user:proxy-secret@us.decodo.com:10001',
    );

    // Rotating (non-sticky) Decodo ports and every other provider keep their
    // configured route: advancing the port there would point at nothing.
    assert.equal(
      resolveProxyStringForAttempt(2, 'gate.decodo.com:10000:proxy-user:proxy-secret'),
      'proxy-user:proxy-secret@us.decodo.com:10000',
    );
    assert.equal(
      resolveProxyStringForAttempt(2, 'https://proxy-user:proxy-secret@proxy.test:443'),
      'proxy-user:proxy-secret@proxy.test:443',
    );
    assert.equal(resolveProxyStringForAttempt(2, ''), '');
  });

  it('reads the attempt as the first argument so a proxy string cannot land in it', () => {
    // resolveProxyString takes the raw config first; this one takes the attempt.
    // A swapped call must degrade to the configured exit, not to a port computed
    // from a string.
    //
    // `raw` is deliberately NON-empty here. With raw = '' the assertion proves
    // nothing: parseProxyConfig returns null on a falsy raw before `attempt` is
    // ever read, so the result is '' whether the coercion exists or not.
    assert.equal(
      resolveProxyStringForAttempt(
        'gate.decodo.com:10001:proxy-user:proxy-secret',
        'gate.decodo.com:10001:u:p',
      ),
      'u:p@us.decodo.com:10001',
      'a proxy string in the attempt slot degrades to attempt 0',
    );
    // Every other non-numeric attempt degrades the same way rather than
    // producing NaN, which would resolve to a port outside the sticky range.
    for (const badAttempt of [undefined, null, NaN, 'two', {}, [], Infinity]) {
      assert.equal(
        resolveProxyStringForAttempt(badAttempt, 'gate.decodo.com:10001:u:p'),
        'u:p@us.decodo.com:10001',
        `attempt=${String(badAttempt)}`,
      );
    }
    // A negative attempt clamps forward, never below the sticky floor.
    assert.equal(
      resolveProxyStringForAttempt(-5, 'gate.decodo.com:10001:u:p'),
      'u:p@us.decodo.com:10001',
    );
    // A fractional attempt truncates rather than producing a fractional port.
    assert.equal(
      resolveProxyStringForAttempt(2.9, 'gate.decodo.com:10001:u:p'),
      'u:p@us.decodo.com:10003',
    );
  });

  it('leaves a Decodo port above the sticky range unrotated', () => {
    // parseProxyConfigForAttempt excludes both sides of the sticky range in one
    // condition; only the below-minimum side had coverage.
    assert.equal(
      resolveProxyStringForAttempt(2, 'gate.decodo.com:50000:proxy-user:proxy-secret'),
      'proxy-user:proxy-secret@us.decodo.com:50000',
    );
  });

  it('sanitizes a hostile attempt index instead of leaving the sticky range', () => {
    // The clamp lives HERE rather than at each entry point because this is now
    // a second door into the same arithmetic: #7963 exposed it through
    // httpsProxyFetchRaw's `proxyAttempt` option, and that helper is injected
    // into seeders that run their own 1-based retry loops. Its sibling
    // resolveProxyStringForAttempt has always clamped (see 'reads the attempt
    // as the first argument' above), so before this the guarantee depended on
    // which door the caller came through.
    //
    // Unclamped, `+` concatenates before `%` coerces: attempt '2' on port 10005
    // computes 4 + '2' === '42' and lands on 10043, a live exit nobody asked
    // for. A negative index resolves BELOW the sticky floor (10000), which is
    // not a sticky exit at all.
    const sticky = 'gate.decodo.com:10005:proxy-user:proxy-secret';
    assert.equal(
      parseProxyConfigForAttempt(sticky, '2').port,
      10007,
      'a numeric string is an index, not a suffix',
    );
    for (const badAttempt of [undefined, null, NaN, 'two', {}, [], Infinity, -5]) {
      assert.equal(
        parseProxyConfigForAttempt(sticky, badAttempt).port,
        10005,
        `attempt=${String(badAttempt)} must degrade to the configured exit`,
      );
    }
    assert.equal(
      parseProxyConfigForAttempt(sticky, 2.9).port,
      10007,
      'a fractional attempt truncates rather than producing a fractional port',
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
      // The full header map rides along so callers can read headers this shape
      // does not promote to a named field — rate-limit headers on a 429 are the
      // motivating case, and dropping them silently downgrades an OpenSky quota
      // cooldown from the advertised window to a short fallback (#6241).
      headers: {
        location: 'https://trusted.example/signed.xml',
        'content-type': 'text/plain',
      },
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
