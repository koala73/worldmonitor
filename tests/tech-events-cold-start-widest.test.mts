import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import {
  fetchWidestTechEvents,
  listTechEvents,
  TECH_EVENTS_UNAVAILABLE_ERROR,
} from '../server/worldmonitor/research/v1/list-tech-events.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';

// #5427: the cold-start fallback writes to the SHARED, request-independent
// `research:tech-events:v1` key (the same one the relay seeder fills with the
// full list). Whatever it caches is what every client sees for the 6h TTL, so
// it must cache the full set — narrowing belongs exclusively to filterEvents()
// on the read path.
//
// The suite that pinned the values of a WIDEST_TECH_EVENTS_REQUEST constant is
// gone with the constant: the fetch path no longer takes a request at all, so
// there is nothing to hold at the clamp maxima. `resolveTechEventsPaging` and
// its bounds stay covered by tests/tech-events-paging.test.mts.

// Greptile P2 on #5603: the assertions above validate the exported constant and
// the paging resolver, but nothing proved `listTechEvents` actually hands that
// request to the cache-miss fetcher — a wiring regression could restore
// caller-specific shared-cache population with this suite still green. That is
// the exact false-pass shape #5380 is about.
//
// Two things close it. Structurally, `fetchWidestTechEvents` takes NO
// parameters, so threading caller state back in is a type error rather than a
// silent behaviour change. Executably, the test below runs the very function
// the handler passes to `cachedFetchJson` and asserts the payload it produces
// is unnarrowed.
describe('fetchWidestTechEvents produces an unnarrowed payload (#5603 review)', () => {
  const ICS = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'SUMMARY:Regression Test Conference 2026',
    'LOCATION:Lisbon, Portugal',
    'DTSTART;VALUE=DATE:20260815',
    'DTEND;VALUE=DATE:20260816',
    'URL:https://example.invalid/conf',
    'UID:widest-test-conference',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Earnings: ExampleCorp Q3 2026',
    'DTSTART;VALUE=DATE:20260901',
    'DTEND;VALUE=DATE:20260901',
    'URL:https://example.invalid/earnings',
    'UID:widest-test-earnings',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n');

  const originalFetch = globalThis.fetch;

  before(() => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('techmeme.com')) return new Response(ICS, { status: 200 });
      // dev.events RSS (and any relay attempt) contributes nothing here.
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('keeps event types a caller-scoped fetch would have dropped', async () => {
    const result = await fetchWidestTechEvents();
    assert.ok(result, 'expected a payload from the cold-start fetcher');

    const types = new Set(result.events.map((e) => e.type));
    // A fallback that forwarded a `type: 'conference'` caller request would
    // have cached conferences only, so the earnings row is the discriminator.
    assert.ok(types.has('earnings'), `earnings event was filtered out: ${[...types].join(', ')}`);
    assert.ok(types.has('conference'), `conference event missing: ${[...types].join(', ')}`);
  });

  it('does not apply a caller limit — more than one event survives', async () => {
    const result = await fetchWidestTechEvents();
    assert.ok(result);
    // A forwarded `limit: 1` would leave exactly one event in the shared key.
    assert.ok(result.events.length > 1, `expected the unnarrowed set, got ${result.events.length}`);
  });

  it('takes no arguments, so caller state cannot be threaded back in', () => {
    assert.equal(fetchWidestTechEvents.length, 0);
  });
});

// The suite above tests `fetchWidestTechEvents` in isolation, which proves the
// extracted fetcher is unnarrowed but NOT that `listTechEvents` still uses it.
// Reintroducing #5427 does not require threading state into that function —
// it only requires ignoring it and inlining a `req`-scoped closure at the
// `cachedFetchJson` call site, which is neither a type error nor observable
// from any assertion above. Verified by execution: with the call site reverted
// that way, all six cases above stay green and `typecheck:api` stays clean.
//
// This suite closes that last gap by driving the handler end-to-end against a
// fake Upstash and asserting on the payload that actually reaches the shared
// `research:tech-events:v1` key — mirroring the captured-SET pattern in
// tests/aviation-cache-poison.test.mts.
describe('listTechEvents cold-start cache write', () => {
  const ENV_KEYS = [
    'LOCAL_API_MODE',
    'RELAY_SHARED_SECRET',
    'UPSTASH_REDIS_REST_TOKEN',
    'UPSTASH_REDIS_REST_URL',
    'VERCEL_ENV',
    'VERCEL_GIT_COMMIT_SHA',
    'WS_RELAY_URL',
  ] as const;

  const ICS_URL = 'https://www.techmeme.com/newsy_events.ics';
  const DEV_EVENTS_RSS = 'https://dev.events/rss.xml';
  const REDIS_CACHE_KEY = 'research:tech-events:v1';

  const savedEnv = new Map<string, string | undefined>();
  const realFetch = globalThis.fetch;

  type RedisSetCommand = ['SET', string, string, 'EX', string];

  /** `days` offset from today as an ICS `YYYYMMDD` stamp, so the fixture never time-bombs. */
  function icsDate(daysFromNow: number): string {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  function vevent(uid: string, summary: string, daysFromNow: number, location?: string): string {
    return [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `SUMMARY:${summary}`,
      ...(location ? [`LOCATION:${location}`] : []),
      `DTSTART;VALUE=DATE:${icsDate(daysFromNow)}`,
      `DTEND;VALUE=DATE:${icsDate(daysFromNow + 1)}`,
      `URL:https://example.invalid/${uid}`,
      'END:VEVENT',
    ].join('\n');
  }

  // Four events chosen so each narrowing axis the warming request carries
  // (type, days, limit) would drop a DIFFERENT one of them from the cache.
  const FIXTURE_ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//worldmonitor//tech-events-fixture//EN',
    vevent('wm-conf-day1', 'WM Fixture Conference Day One', 1, 'Paris, France'),
    vevent('wm-conf-day2', 'WM Fixture Conference Day Two', 2, 'Berlin, Germany'),
    vevent('wm-earnings-day3', 'Earnings: WM Fixture Corp', 3),
    vevent('wm-conf-day200', 'WM Fixture Conference Far Future', 200, 'Tokyo, Japan'),
    'END:VCALENDAR',
  ].join('\n');

  // Valid but item-free, and over the 100-char floor fetchTextWithRelay() uses
  // to reject a truncated body.
  const FIXTURE_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>WM fixture feed</title>
<link>https://dev.events</link>
<description>No items; the ICS leg carries this fixture.</description>
</channel></rss>`;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
    __resetKeyPrefixCacheForTests();
  });

  afterEach(() => {
    mock.restoreAll();
    globalThis.fetch = realFetch;
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    __resetKeyPrefixCacheForTests();
  });

  // A 200 that clears fetchTextWithRelay's 100-char floor but parses to zero
  // events — an empty calendar, an HTML error page, a challenge interstitial.
  // The fetch "succeeds", so a failure counter never sees it.
  const EVENTLESS_ICS_200 = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//worldmonitor//tech-events-fixture//EN',
    'X-WR-CALNAME:upstream returned a valid but empty calendar',
    'X-WR-CALDESC:padding so this body clears the 100-character floor',
    'END:VCALENDAR',
  ].join('\n');

  /**
   * Cold Redis (every GET misses) + the two upstream feeds. `icsFails` /
   * `rssFails` return 503 so `fetchTextWithRelay` falls through to its relay
   * leg, finds no WS_RELAY_URL, and yields null — the real total-outage path.
   * `icsEventless` instead returns a healthy-looking 200 that parses to
   * nothing. FIXTURE_RSS is already item-free, so it covers the RSS side.
   */
  function installFetchMock({ icsFails = false, rssFails = false, icsEventless = false, icsBody = '' } = {}) {
    const redisSets: RedisSetCommand[] = [];
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://redis.test/get/')) {
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }
      if (url === 'https://redis.test/') {
        redisSets.push(JSON.parse(String(init?.body ?? '[]')) as RedisSetCommand);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      if (url === ICS_URL) {
        if (icsFails) return new Response('', { status: 503 });
        if (icsEventless) return new Response(EVENTLESS_ICS_200, { status: 200 });
        return new Response(icsBody || FIXTURE_ICS, { status: 200 });
      }
      if (url === DEV_EVENTS_RSS) {
        return rssFails ? new Response('', { status: 503 }) : new Response(FIXTURE_RSS, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    return redisSets;
  }

  function writeFor(redisSets: RedisSetCommand[]): RedisSetCommand {
    const write = redisSets.find(([, key]) => key === REDIS_CACHE_KEY);
    assert.ok(write, `expected a Redis SET for ${REDIS_CACHE_KEY}, saw keys: ${JSON.stringify(redisSets.map(([, k]) => k))}`);
    return write;
  }

  function cachedPayload(redisSets: RedisSetCommand[]): { events: { id: string; type: string }[] } {
    return JSON.parse(writeFor(redisSets)[2]) as { events: { id: string; type: string }[] };
  }

  function ctxFor(path: string) {
    return { request: new Request(`https://worldmonitor.app${path}`), pathParams: {}, headers: {} } as never;
  }

  describe('is not narrowed by the warming request (#5427)', () => {
  // The warming caller narrows on all three axes at once.
  const NARROW_PATH = '/api/research/v1/list-tech-events?type=conference&limit=1&days=5';
  const NARROW_REQ = { type: 'conference', mappable: false, limit: 1, days: 5 };

  it('caches event types the warming request filtered out', async () => {
    const redisSets = installFetchMock();
    await listTechEvents(ctxFor(NARROW_PATH), NARROW_REQ);

    const ids = cachedPayload(redisSets).events.map(e => e.id);
    assert.ok(
      ids.includes('wm-earnings-day3'),
      `?type=conference must not narrow the shared cache, but the earnings event is absent: ${JSON.stringify(ids)}`,
    );
  });

  it('caches events beyond the warming request day window', async () => {
    const redisSets = installFetchMock();
    await listTechEvents(ctxFor(NARROW_PATH), NARROW_REQ);

    const ids = cachedPayload(redisSets).events.map(e => e.id);
    assert.ok(
      ids.includes('wm-conf-day200'),
      `?days=5 must not narrow the shared cache, but the far-future event is absent: ${JSON.stringify(ids)}`,
    );
  });

  it('caches more events than the warming request limit', async () => {
    const redisSets = installFetchMock();
    await listTechEvents(ctxFor(NARROW_PATH), NARROW_REQ);

    const events = cachedPayload(redisSets).events;
    assert.ok(
      events.length >= 4,
      `?limit=1 must not truncate the shared cache, but only ${events.length} event(s) were written`,
    );
  });

  // Both seeders (scripts/ais-relay.cjs seedTechEvents, scripts/seed-research.mjs)
  // write the full deduped list with no limit and no day horizon. The fetch path
  // used to cap at 200/365, so once the corpus grew past 200 a fallback-warmed
  // key held a different, shorter set than a seeder-warmed one — the same
  // divergence class as #5427, just further out. With no request in the fetch
  // path there is nothing left to cap with.
  it('caches the full corpus, matching what the seeders write', async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      vevent(`wm-bulk-${i}`, `WM Bulk Conference ${i}`, i + 1, 'Paris, France'));
    const redisSets = installFetchMock({
      icsBody: ['BEGIN:VCALENDAR', 'VERSION:2.0', ...many, 'END:VCALENDAR'].join('\n'),
    });

    await listTechEvents(ctxFor(NARROW_PATH), NARROW_REQ);

    const events = cachedPayload(redisSets).events;
    assert.ok(
      events.length >= 250,
      `the shared key must hold the full corpus, not a 200-event slice; got ${events.length}`,
    );
    // Day 250 is past the old 365-day cutoff's practical reach for this fixture
    // and far past the warming request's 5-day window.
    assert.ok(events.some(e => e.id === 'wm-bulk-249'), 'the tail of the corpus must survive');
  });

  it('still narrows the warming request own response via filterEvents', async () => {
    const redisSets = installFetchMock();
    const response = await listTechEvents(ctxFor(NARROW_PATH), NARROW_REQ);

    // Widening what gets CACHED must not widen what the caller SEES.
    assert.equal(response.count, 1);
    assert.equal(response.events.length, 1);
    assert.equal(response.events[0]?.id, 'wm-conf-day1');
    assert.equal(response.conferenceCount, 1);
    // ...and the cache still holds the unnarrowed set behind that response.
    assert.ok(cachedPayload(redisSets).events.length >= 4);
  });
  });

  // Review finding #2 on #5603. CURATED_EVENTS always clears the
  // `events.length > 0` bar, so once the fallback widened to days:365 the
  // far-future curated entries survived the cutoff and a TOTAL upstream outage
  // began pinning a curated-only rump under the seeder-owned key for the full
  // 6h TTL — served to every client as `success: true` with an empty `error`.
  // Before #5603 the caller's default 90-day window dropped those entries, the
  // payload came back empty, and the key self-healed via a 120s sentinel.
  describe('refuses to persist a payload with no upstream data (#5603 review)', () => {
    const PATH = '/api/research/v1/list-tech-events';
    const REQ = { type: '', mappable: false, limit: 0, days: 0 };

    it('writes a short-TTL negative sentinel when every feed is down', async () => {
      const redisSets = installFetchMock({ icsFails: true, rssFails: true });
      await listTechEvents(ctxFor(PATH), REQ);

      const write = writeFor(redisSets);
      assert.equal(
        JSON.parse(write[2]),
        '__WM_NEG__',
        `a curated-only outage payload must not be persisted under the shared key, got: ${write[2].slice(0, 200)}`,
      );
    });

    it('lets the key recover in seconds, not on the seeder cycle', async () => {
      const redisSets = installFetchMock({ icsFails: true, rssFails: true });
      await listTechEvents(ctxFor(PATH), REQ);

      const ttl = Number(writeFor(redisSets)[4]);
      assert.ok(ttl > 0 && ttl <= 300, `expected a short negative TTL, got ${ttl}s`);
      assert.notEqual(ttl, 21600, 'the outage write must not take the 6h REDIS_CACHE_TTL');
    });

    // The guard must key on "did upstream give us anything", not on a fetch
    // failure counter. A feed answering 200 with an error page or an empty
    // calendar never increments a failure count, so a counter-based guard
    // lets the same curated-only rump through at the full 6h TTL.
    it('writes a negative sentinel when feeds answer 200 with nothing parseable', async () => {
      const redisSets = installFetchMock({ icsEventless: true });
      await listTechEvents(ctxFor(PATH), REQ);

      const write = writeFor(redisSets);
      assert.equal(
        JSON.parse(write[2]),
        '__WM_NEG__',
        `a healthy-looking 200 that parses to nothing must not persist a curated-only payload, got: ${write[2].slice(0, 200)}`,
      );
    });

    // Without a no-store marker this route falls to its 'daily' tier
    // (s-maxage=14400), so the CDN would pin the empty body for 4h even though
    // Redis recovers in 120s.
    it('marks the unavailable response no-store so the CDN cannot pin it', async () => {
      installFetchMock({ icsFails: true, rssFails: true });
      const response = await listTechEvents(ctxFor(PATH), REQ);

      assert.equal(response.count, 0);
      assert.equal(
        response.error,
        TECH_EVENTS_UNAVAILABLE_ERROR,
        'an unavailable response must carry the error the gateway reads as a no-store reason',
      );
    });

    // Precision check: the marker must fire ONLY on data-unavailability, never
    // on a healthy response whose filters happened to match nothing — that is
    // a real answer and stays cacheable.
    it('leaves a healthy zero-match response cacheable', async () => {
      installFetchMock();
      const response = await listTechEvents(
        ctxFor('/api/research/v1/list-tech-events?type=ipo'),
        { type: 'ipo', mappable: false, limit: 0, days: 0 },
      );

      assert.equal(response.count, 0, 'fixture has no ipo events');
      assert.equal(response.error, '', 'a healthy empty result must stay cacheable');
    });

    it('still caches a partial fetch, so one dead feed does not blank the endpoint', async () => {
      // ICS alive, RSS down: ~4 real events. Materially complete, so refusing
      // it would drop every caller into the empty-response window for as long
      // as the other feed stayed down.
      const redisSets = installFetchMock({ rssFails: true });
      await listTechEvents(ctxFor(PATH), REQ);

      const ids = cachedPayload(redisSets).events.map(e => e.id);
      assert.ok(ids.includes('wm-conf-day1'), `partial fetches must still be cached, got: ${JSON.stringify(ids)}`);
    });
  });
});
