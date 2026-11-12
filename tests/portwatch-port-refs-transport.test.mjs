import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import * as portwatchSeed from '../scripts/seed-portwatch-port-activity.mjs';
import { CHROME_UA } from '../scripts/_seed-utils.mjs';

// Sanitized from a real Railway deployment. Its _comment records that only
// the HTTP 200 envelope and message were confirmed upstream — other provider
// fields are unconfirmed rather than observed absent, so do not treat this
// fixture as proof of the full error shape.
const arcgisRateLimitFixture = JSON.parse(await readFile(
  new URL('./fixtures/portwatch-arcgis-too-many-requests.json', import.meta.url),
  'utf8',
));

function arcgisJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// The two reference pages every pagination case below walks: a first page
// that reports more to come, and a final page that closes the loop. Only the
// failure injected between them varies per test. arcgisJson serializes its
// argument, so sharing these objects cannot leak state across tests.
const FIRST_PAGE = {
  features: [{ attributes: { portid: 'us-lax', ISO3: 'USA', lat: 33.7, lon: -118.2 } }],
  exceededTransferLimit: true,
};
const FINAL_PAGE = {
  features: [{ attributes: { portid: 'cy-lca', ISO3: 'CYP', lat: 34.9, lon: 33.6 } }],
  exceededTransferLimit: false,
};

// Shared transport stub for the uniform pagination cases: the direct leg
// records each requested offset and init, serves FIRST_PAGE at offset 0,
// then serves `secondPage` — with `status`, or thrown when it is an Error —
// at offset 1; the proxy leg records its calls and closes pagination with
// FINAL_PAGE. Stateful, abort, and default-transport cases below keep
// hand-rolled stubs because their shape is the point of the test.
function paginationTransport(secondPage, { status = 200, proxyRetryFn } = {}) {
  const requestedOffsets = [];
  const requestedInits = [];
  const proxyCalls = [];
  const fetchFn = async (url, init) => {
    const offset = Number(new URL(url).searchParams.get('resultOffset'));
    requestedOffsets.push(offset);
    requestedInits.push(init);
    if (offset === 0) return arcgisJson(FIRST_PAGE);
    if (secondPage instanceof Error) throw secondPage;
    return arcgisJson(secondPage, status);
  };
  return {
    fetchFn,
    requestedOffsets,
    requestedInits,
    proxyCalls,
    proxyRetryFn: proxyRetryFn ?? (async (...args) => {
      proxyCalls.push(args);
      return FINAL_PAGE;
    }),
  };
}

// Drive one reference page whose second offset always returns `body`, and
// return the message fetchWithTimeout's parser threw for it.
async function rejectedRefsError(body) {
  const { fetchFn } = paginationTransport(body);
  const err = await portwatchSeed
    .fetchAllPortRefs({ fetchFn, sleepFn: async () => {} })
    .then(() => null, (e) => e);
  assert.ok(err, 'expected fetchAllPortRefs to reject');
  return err.message;
}

describe('PortWatch reference pagination recovery', () => {
  it('records the failed page query and ArcGIS details without another request', async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (line) => warnings.push(line));
    const envelope = { error: { code: 400, message: 'Cannot perform query.', details: ['Invalid query parameters.'] } };
    const transport = paginationTransport(envelope);

    await assert.rejects(portwatchSeed.fetchAllPortRefs(transport), { message: 'ArcGIS error: Cannot perform query.' });

    const records = warnings.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.event, 'portwatch_request_failure');
    assert.equal(record.route, 'direct');
    assert.equal(record.phase, 'arcgis');
    assert.match(record.endpoint, /PortWatch_ports_database\/FeatureServer\/0\/query$/);
    assert.equal(record.query.resultOffset, '1');
    assert.equal(record.query.where, '1=1');
    assert.equal(record.query.outFields, 'portid,ISO3,lat,lon');
    assert.equal(record.status, 200);
    assert.deepEqual(record.arcgisError, envelope.error);
    assert.ok(Date.parse(record.finishedAt) >= Date.parse(record.startedAt));
    assert.deepEqual(transport.requestedOffsets, [0, 1]);
    assert.equal(transport.proxyCalls.length, 0);
  });

  it('records a direct transport cause even when the existing proxy fallback recovers', async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (line) => warnings.push(line));
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }) });
    const transport = paginationTransport(error);

    const refs = await portwatchSeed.fetchAllPortRefs(transport);

    const record = warnings.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))[0];
    assert.ok(record, 'the recovered direct failure must remain diagnosable');
    assert.equal(record.phase, 'fetch');
    assert.equal(record.query.resultOffset, '1');
    assert.equal(record.causes[1].code, 'ETIMEDOUT');
    assert.deepEqual([...refs.get('CYP').keys()], ['cy-lca']);
    assert.deepEqual(transport.requestedOffsets, [0, 1]);
    assert.equal(transport.proxyCalls.length, 1);
  });

  for (const status of [200, 503]) {
    it(`records a real proxy HTTP ${status} rejection without another request`, async (t) => {
      const warnings = [];
      t.mock.method(console, 'warn', (line) => warnings.push(line));
      const previousProxy = process.env.PROXY_URL;
      process.env.PROXY_URL = 'https://fixture-user:fixture-password@proxy.invalid:443';
      t.after(() => {
        if (previousProxy === undefined) delete process.env.PROXY_URL;
        else process.env.PROXY_URL = previousProxy;
      });
      const proxyUtils = createRequire(import.meta.url)('../scripts/_proxy-utils.cjs');
      // Not `Invalid query parameters`: that class now earns page retries, and
      // this case pins the single proxy record of a non-retryable rejection.
      const envelope = { error: { code: 400, message: 'Cannot perform query.', details: ['Invalid paging.'] } };
      const proxy = t.mock.method(proxyUtils, 'proxyFetch', async () => ({
        ok: status === 200, status, buffer: Buffer.from(JSON.stringify(envelope)),
        contentType: 'application/json', headers: { 'retry-after': '60', 'set-cookie': 'private-cookie' },
      }));
      const transport = paginationTransport(new TypeError('fetch failed'));

      await assert.rejects(portwatchSeed.fetchAllPortRefs({ fetchFn: transport.fetchFn }), status === 200
        ? /ArcGIS error \(via proxy after direct TypeError\): Cannot perform query\./ : /HTTP 503/);

      const records = warnings.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
      assert.deepEqual(records.map((record) => record.route), ['direct', 'proxy']);
      assert.equal(records[1].phase, status === 200 ? 'arcgis' : 'http');
      assert.equal(records[1].query.resultOffset, '1');
      assert.deepEqual(records[1].arcgisError, envelope.error);
      if (status === 200) {
        assert.equal(records[1].status, null, 'the shared proxy helper does not expose successful response status');
      } else {
        assert.equal(records[1].status, 503);
        assert.deepEqual(records[1].headers, { 'retry-after': '60' });
      }
      assert.equal(proxy.mock.callCount(), 1);
      assert.deepEqual(transport.requestedOffsets, [0, 1]);
      assert.doesNotMatch(warnings.join('\n'), /fixture-user|fixture-password|private-cookie/);
    });
  }

  // proxyFetch applies its timeoutMs to the CONNECT tunnel and again to the
  // response, so a proxy leg given only `timeoutMs: 50s` could take 100s. The
  // reference retry guard and the 90s per-country wrap both size the proxy leg
  // at PROXY_FETCH_TIMEOUT, so the leg needs one deadline across both phases.
  it('bounds the whole proxy leg, tunnel plus response, to one 50s deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const previousProxy = process.env.PROXY_URL;
    process.env.PROXY_URL = 'https://fixture-user:fixture-password@proxy.invalid:443';
    t.after(() => {
      if (previousProxy === undefined) delete process.env.PROXY_URL;
      else process.env.PROXY_URL = previousProxy;
    });
    t.mock.method(console, 'warn', () => {});
    const proxyUtils = createRequire(import.meta.url)('../scripts/_proxy-utils.cjs');
    // A tunnel that is slow to establish and a response that is slow to land:
    // each phase alone stays under its own 50s timer, so only an overall
    // deadline on the signal can end the leg at 50s.
    t.mock.method(proxyUtils, 'proxyFetch', (_url, _config, { signal }) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    }));
    const transport = paginationTransport(new TypeError('fetch failed'));

    let settled = null;
    const run = portwatchSeed.fetchAllPortRefs({ fetchFn: transport.fetchFn })
      .then(() => { settled = 'resolved'; }, (error) => { settled = error; });
    for (let i = 0; i < 10 && transport.requestedOffsets.length < 2; i += 1) await new Promise(setImmediate);
    assert.deepEqual(transport.requestedOffsets, [0, 1]);

    t.mock.timers.tick(49_999);
    for (let i = 0; i < 10; i += 1) await new Promise(setImmediate);
    assert.equal(settled, null, 'the proxy leg keeps its full 50s');

    t.mock.timers.tick(1);
    for (let i = 0; i < 10 && settled === null; i += 1) await new Promise(setImmediate);
    assert.ok(settled instanceof Error, 'the proxy leg must end at 50s');
    assert.match(String(settled.message), /timeout|abort/i);
    await run;
  });

  it('parses and retries a rate-limited HTTP 200 page without restarting pagination', async () => {
    assert.equal(typeof arcgisRateLimitFixture.error, 'object');
    assert.equal(
      arcgisRateLimitFixture.error.message,
      'Unable to perform query. Too many requests.',
    );

    const transport = paginationTransport(arcgisRateLimitFixture);
    const refsByIso3 = await portwatchSeed.fetchAllPortRefs({
      fetchFn: transport.fetchFn,
      proxyRetryFn: transport.proxyRetryFn,
    });

    assert.deepEqual(transport.requestedOffsets, [0, 1]);
    assert.deepEqual([...refsByIso3.get('USA').keys()], ['us-lax']);
    assert.deepEqual([...refsByIso3.get('CYP').keys()], ['cy-lca']);
    assert.equal(transport.proxyCalls.length, 1);
    assert.equal(new URL(transport.proxyCalls[0][0]).searchParams.get('resultOffset'), '1');
    assert.equal(transport.proxyCalls[0][1], 'HTTP 200 rate-limited');
    assert.ok(transport.proxyCalls[0][2].signal instanceof AbortSignal);

    // The seam is only faithful if it hands the transport what production
    // hands it. fetchWithTimeout builds these headers and the combined abort
    // signal itself, so without this assertion the required User-Agent or the
    // abort wiring could be dropped and every test here would stay green.
    assert.equal(transport.requestedInits.length, 2);
    for (const init of transport.requestedInits) {
      assert.equal(init.headers['User-Agent'], CHROME_UA);
      assert.equal(init.headers.Accept, 'application/json');
      assert.ok(init.signal instanceof AbortSignal);
    }
  });

  it('bounds repeated HTTP 200 rate-limit errors to one same-page retry', async () => {
    const sleepCalls = [];
    const transport = paginationTransport(arcgisRateLimitFixture);

    await assert.rejects(
      portwatchSeed.fetchAllPortRefs({
        fetchFn: transport.fetchFn,
        proxyRetryFn: async (...args) => {
          transport.proxyCalls.push(args);
          throw portwatchSeed.createArcgisProxyError(args[1], 'Too many requests');
        },
        sleepFn: async (...args) => {
          sleepCalls.push(args);
        },
      }),
      /ArcGIS error \(via proxy after HTTP 200 rate-limited\): Too many requests/,
    );

    assert.deepEqual(transport.requestedOffsets, [0, 1, 1]);
    assert.equal(transport.proxyCalls.length, 2);
    assert.equal(sleepCalls.length, 1);
    // #8501 raised the cooldown from 2s: one token retry never outlasted an
    // ArcGIS rate-limit window, and the reference pages share that window.
    assert.equal(sleepCalls[0][0], 8_000);
  });

  it('retries a code-only rate-limit envelope that carries no message', async () => {
    // ArcGIS also emits `{"error":{"code":N}}` with no message field (the
    // shape documented on the proxy parser). The direct parser must surface
    // the code so the retry classifier still sees a rate limit, rather than
    // throwing "ArcGIS error: undefined" and abandoning the page.
    const transport = paginationTransport({ error: { code: 429 } });
    const refsByIso3 = await portwatchSeed.fetchAllPortRefs({
      fetchFn: transport.fetchFn,
      proxyRetryFn: transport.proxyRetryFn,
    });

    assert.deepEqual(transport.requestedOffsets, [0, 1]);
    assert.deepEqual([...refsByIso3.get('CYP').keys()], ['cy-lca']);
    assert.equal(transport.proxyCalls.length, 1);
    assert.equal(transport.proxyCalls[0][1], 'HTTP 200 rate-limited');
  });

  // 2026-11-01: the identical reference query alternated between
  // `Invalid query parameters` and a full page within seconds, and one such
  // page on page 2 failed the whole tick (exit 1). The error is intermittent
  // upstream degradation, not a malformed query, so a page gets bounded retries.
  it('retries an intermittent invalid_query page and completes pagination', async () => {
    let secondPageCalls = 0;
    const requestedOffsets = [];
    const sleepCalls = [];
    const fetchFn = async (url) => {
      const offset = Number(new URL(url).searchParams.get('resultOffset'));
      requestedOffsets.push(offset);
      if (offset === 0) return arcgisJson(FIRST_PAGE);
      secondPageCalls += 1;
      return secondPageCalls < 3
        ? arcgisJson({ error: { code: 400, message: 'Cannot perform query. Invalid query parameters.' } })
        : arcgisJson(FINAL_PAGE);
    };

    const refs = await portwatchSeed.fetchAllPortRefs({
      fetchFn,
      proxyRetryFn: async () => assert.fail('invalid_query retries stay on the direct leg'),
      sleepFn: async (ms) => { sleepCalls.push(ms); },
    });

    assert.deepEqual([...refs.keys()].sort(), ['CYP', 'USA']);
    assert.deepEqual(requestedOffsets, [0, 1, 1, 1]);
    assert.deepEqual(sleepCalls, [5_000, 5_000]);
  });

  it('bounds invalid_query retries so a real schema regression still fails the page', async () => {
    const transport = paginationTransport({ error: { message: 'Invalid query parameters.' } });
    const sleepCalls = [];
    await assert.rejects(portwatchSeed.fetchAllPortRefs({
      ...transport, sleepFn: async (ms) => { sleepCalls.push(ms); },
    }), /Invalid query parameters/);
    assert.deepEqual(transport.requestedOffsets, [0, 1, 1, 1, 1]);
    assert.deepEqual(sleepCalls, [5_000, 5_000, 5_000]);
    assert.equal(transport.proxyCalls.length, 0);
  });

  it('declines an invalid_query retry that cannot finish inside the reference budget', async (t) => {
    const transport = paginationTransport({ error: { message: 'Invalid query parameters.' } });
    // Each failed attempt plus its cooldown costs 30s of mocked wall clock.
    // A reference retry may fall back to the proxy, so it must reserve the
    // full direct + proxy budget (30s + 50s) plus its 5s cooldown = 85s, the
    // same allowance the per-page check gives a fresh page. Page 2 starts with
    // 130s left: retries are admitted at 130s and 100s, then declined at 70s.
    // Reserving only the 30s direct leg would admit a third retry at 70s that
    // can run up to 15s past the reference slice.
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const sleepCalls = [];
    await assert.rejects(portwatchSeed.fetchAllPortRefs({
      ...transport,
      deadlineAt: now + 130_000,
      sleepFn: async (ms) => { sleepCalls.push(ms); now += 30_000; },
    }), /Invalid query parameters/);
    assert.deepEqual(transport.requestedOffsets, [0, 1, 1, 1]);
    assert.deepEqual(sleepCalls, [5_000, 5_000]);
  });

  for (const page of [{}, { features: [], exceededTransferLimit: true }, { features: [], exceededTransferLimit: false }, { features: {}, exceededTransferLimit: false }, { features: [], exceededTransferLimit: 'false' }, FIRST_PAGE]) {
    it('rejects malformed, non-progressing, or repeated reference pages: ' + JSON.stringify(page), async () => {
      const transport = paginationTransport(page);
      await assert.rejects(portwatchSeed.fetchAllPortRefs({
        ...transport, sleepFn: async () => assert.fail('invalid pages must not retry'),
      }), /incomplete page/);
      assert.deepEqual(transport.requestedOffsets, [0, 1]);
      assert.equal(transport.proxyCalls.length, 0);
    });
  }

  // The three rungs of the error ladder, pinned separately. The retry
  // classifier reads the thrown message, and `{"code":429}` stringifies to
  // something that still matches /\b429\b/ -- so a test that only proves a
  // retry fired cannot tell `?? code` from `?? JSON.stringify`. These assert
  // the message itself, on codes that do NOT trip a retry.
  it('prefers message over code, and code over the stringified envelope', async () => {
    const messageAndCode = await rejectedRefsError({
      error: { code: 400, message: 'Cannot perform query. Bad field.' },
    });
    assert.equal(messageAndCode, 'ArcGIS error: Cannot perform query. Bad field.');

    const codeOnly = await rejectedRefsError({ error: { code: 400 } });
    assert.equal(codeOnly, 'ArcGIS error: 400');

    const neither = await rejectedRefsError({ error: { details: ['nope'] } });
    assert.equal(neither, 'ArcGIS error: {"details":["nope"]}');
  });

  // The status-429 branch, not the HTTP-200 rate-limit envelope the earlier
  // tests drive: no test above hands the transport a non-200 status, so
  // deleting `if (resp.status === 429)` leaves the whole suite green
  // (verified by mutation on #7539's head).
  it('routes an HTTP 429 status through the proxy transport at the same offset', async () => {
    const transport = paginationTransport(arcgisRateLimitFixture, { status: 429 });
    const refsByIso3 = await portwatchSeed.fetchAllPortRefs({
      fetchFn: transport.fetchFn,
      proxyRetryFn: transport.proxyRetryFn,
    });

    assert.deepEqual(transport.requestedOffsets, [0, 1]);
    assert.deepEqual([...refsByIso3.get('CYP').keys()], ['cy-lca']);
    assert.equal(transport.proxyCalls.length, 1);
    assert.equal(new URL(transport.proxyCalls[0][0]).searchParams.get('resultOffset'), '1');
    assert.equal(transport.proxyCalls[0][1], 'HTTP 429 rate-limited');
    assert.ok(transport.proxyCalls[0][2].signal instanceof AbortSignal);
  });

  it('rejects on a non-429 HTTP error status without retrying or proxying', async () => {
    const transport = paginationTransport(
      { error: { message: 'Service unavailable.' } },
      { status: 503 },
    );

    await assert.rejects(
      portwatchSeed.fetchAllPortRefs({
        fetchFn: transport.fetchFn,
        proxyRetryFn: transport.proxyRetryFn,
      }),
      /ArcGIS HTTP 503 for /,
    );

    // retryRateLimited only retries the rate-limit class, and the invalid-
    // params circuit breaker only matches its own message — a bare HTTP
    // error status must surface as-is after one attempt per offset.
    assert.deepEqual(transport.requestedOffsets, [0, 1]);
    assert.equal(transport.proxyCalls.length, 0);
  });

  it('falls back to the proxy transport when the direct transport throws a timeout-like error', async () => {
    // The WM 2026-05-13 silent-stall mode: ArcGIS never answers, the
    // transport throws instead of returning a response. The thrown message
    // must match an isTimeoutLike class for the proxy fallback to open.
    const transport = paginationTransport(new TypeError('fetch failed'));
    const refsByIso3 = await portwatchSeed.fetchAllPortRefs({
      fetchFn: transport.fetchFn,
      proxyRetryFn: transport.proxyRetryFn,
    });

    assert.deepEqual(transport.requestedOffsets, [0, 1]);
    assert.deepEqual([...refsByIso3.get('CYP').keys()], ['cy-lca']);
    assert.equal(transport.proxyCalls.length, 1);
    assert.equal(transport.proxyCalls[0][1], 'direct TypeError');
  });

  it('rejects a non-timeout-like transport error without proxy fallback', async () => {
    // The other half of the transport-throw ladder: a permanent transport
    // error (TLS, DNS, bad URL) matches no isTimeoutLike class, so it must
    // surface as-is instead of spending a paid proxy request on it.
    const failure = new Error('self-signed certificate in certificate chain');
    const transport = paginationTransport(failure);

    await assert.rejects(
      portwatchSeed.fetchAllPortRefs({
        fetchFn: transport.fetchFn,
        proxyRetryFn: transport.proxyRetryFn,
      }),
      (err) => err === failure,
    );
    assert.deepEqual(transport.requestedOffsets, [0, 1]);
    assert.equal(transport.proxyCalls.length, 0);
  });

  it('propagates a caller abort from the transport catch without proxy fallback', async () => {
    // A real cancellation (SIGTERM / per-country timeout) must rethrow the
    // caller's own reason: routing it to the proxy retry would spend a
    // paid request on work the run already gave up on. The transport throws
    // the realistic aborted-fetch class — the only class the
    // `if (signal?.aborted) throw err` guard intercepts before the
    // isTimeoutLike ladder would route it to the proxy.
    const controller = new AbortController();
    const abortReason = new DOMException('This operation was aborted', 'AbortError');
    const fetchFn = async () => {
      controller.abort(abortReason);
      throw controller.signal.reason;
    };

    await assert.rejects(
      portwatchSeed.fetchAllPortRefs({
        signal: controller.signal,
        fetchFn,
        proxyRetryFn: async (...args) => {
          throw new Error(`proxy must not be called: ${args[1]}`);
        },
      }),
      (err) => err === abortReason,
    );
  });

  it('rejects before dialling out when the run signal is already aborted', async () => {
    const directCalls = [];
    const controller = new AbortController();
    const abortReason = new Error('run cancelled');
    controller.abort(abortReason);

    await assert.rejects(
      portwatchSeed.fetchAllPortRefs({
        signal: controller.signal,
        fetchFn: async (...args) => {
          directCalls.push(args);
          return arcgisJson(FIRST_PAGE);
        },
      }),
      (err) => err === abortReason,
    );
    assert.equal(directCalls.length, 0);
  });

  it('wires the default direct transport to globalThis.fetch', async (t) => {
    // defaultFetch must read globalThis.fetch at call time rather than
    // binding the original once, so swapping the global is observable here.
    const originalFetch = globalThis.fetch;
    const directCalls = [];
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    globalThis.fetch = async (url, init) => {
      directCalls.push({ url: String(url), init });
      return arcgisJson(FINAL_PAGE);
    };

    const refsByIso3 = await portwatchSeed.fetchAllPortRefs({});

    assert.equal(directCalls.length, 1);
    assert.equal(directCalls[0].init.headers['User-Agent'], CHROME_UA);
    assert.equal(directCalls[0].init.headers.Accept, 'application/json');
    assert.ok(directCalls[0].init.signal instanceof AbortSignal);
    assert.deepEqual([...refsByIso3.get('CYP').keys()], ['cy-lca']);
  });
});
