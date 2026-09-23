// Sprint 2 — Disease-outbreaks content-age pilot (2026-05-04 health-readiness plan).
//
// Tests are split by LAYER per the Codex round 4-5 contract:
//
//   - PRE-PUBLISH (in-memory parser/mapItem): items MUST carry the helpers
//     _publishedAtIsSynthetic and _originalPublishedMs so contentMeta can
//     compute newest-item-age while excluding synthetic timestamps.
//
//   - POST-STRIP (canonical-key payload): items MUST NOT carry the helpers.
//     publishTransform strips them before atomicPublish, so they never reach
//     /api/bootstrap responses, list-disease-outbreaks RPC, or the
//     DiseaseOutbreakItem proto type.
//
// Test against the SAME functions the seeder imports from
// `scripts/_disease-outbreaks-helpers.mjs` — no local replicas, no drift.
// `diseaseContentMeta`'s `nowMs` parameter is injected with a fixed value so
// skew-limit tests are deterministic (no timing flakiness around the 1h
// boundary on loaded CI runners).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISEASE_RSS_FEEDS, fetchRssItems, fetchWhoDonApi } from '../scripts/seed-disease-outbreaks.mjs';
import {
  whoNormalizeItem,
  rssNormalizeItem,
  tghNormalizeItem,
  mapItem,
  diseaseContentMeta,
  diseasePublishTransform,
  DISEASE_MAX_CONTENT_AGE_MIN,
  detectAlertLevel,
  DISEASE_ALERT_KEYWORDS,
  DISEASE_WARNING_KEYWORDS,
  DISEASE_ALERT_RE,
  DISEASE_WARNING_RE,
  ALERT_LEVEL_METHODOLOGY_VERSION,
  isRoundupHeadline,
  isReportableHeadline,
  HEADLINE_LOOKBACK_DAYS,
} from '../scripts/_disease-outbreaks-helpers.mjs';

const WHO_RESPONSE = {
  value: [{
    Title: 'Ebola disease - Country X',
    ItemDefaultUrl: '/emergencies/disease-outbreak-news/item/2026-DON001',
    PublicationDateAndTime: '2026-08-28T15:28:00Z',
  }],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('WHO adapter retries one transient timeout and returns the recovered record', async () => {
  let calls = 0;
  const outbreaks = await fetchWhoDonApi({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
      return jsonResponse(WHO_RESPONSE);
    },
    retryDelayMs: 0,
  });

  assert.equal(calls, 2);
  assert.equal(outbreaks.length, 1);
  assert.equal(outbreaks[0].title, WHO_RESPONSE.value[0].Title);
});

for (const status of [429, 503]) {
  test(`WHO adapter retries transient HTTP ${status} and returns the recovered record`, async () => {
    let calls = 0;
    const outbreaks = await fetchWhoDonApi({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({}, status);
        return jsonResponse(WHO_RESPONSE);
      },
      retryDelayMs: 0,
    });

    assert.equal(calls, 2);
    assert.equal(outbreaks.length, 1);
    assert.equal(outbreaks[0].title, WHO_RESPONSE.value[0].Title);
  });
}

test('WHO adapter does not retry a permanent HTTP 403', async () => {
  let calls = 0;
  const outbreaks = await fetchWhoDonApi({
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({}, 403);
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(outbreaks, []);
});

test('WHO adapter returns no records after both transient attempts fail', async () => {
  let calls = 0;
  const outbreaks = await fetchWhoDonApi({
    fetchImpl: async () => {
      calls += 1;
      throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
    },
    retryDelayMs: 0,
  });

  assert.equal(calls, 2);
  assert.deepEqual(outbreaks, []);
});

// ── RSS sources ──────────────────────────────────────────────────────────
//
// Outbreak News Today stopped publishing (newest item 2026-07-30) and earlier
// answered 403, so it was a silently empty source. ECDC epidemiological updates
// and CIDRAP disease feeds replace it (live-probed 2026-09-23).

test('RSS sources include ECDC and CIDRAP and no longer include Outbreak News Today', () => {
  const hosts = DISEASE_RSS_FEEDS.map(({ url }) => new URL(url).host);
  assert.deepEqual(hosts.filter((host) => host === 'outbreaknewstoday.com'), []);
  assert.ok(DISEASE_RSS_FEEDS.some(({ url, sourceName }) =>
    sourceName === 'ECDC' && url === 'https://www.ecdc.europa.eu/en/taxonomy/term/1310/feed'));
  const cidrap = DISEASE_RSS_FEEDS.filter(({ sourceName }) => sourceName === 'CIDRAP');
  assert.ok(cidrap.length >= 5);
  for (const { url } of cidrap) assert.match(url, /^https:\/\/www\.cidrap\.umn\.edu\/news\/\d+\/rss$/);
});

const CIDRAP_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>CIDRAP - Ebola News</title>
    <item>
  <title>  Ebola outbreak in DR Congo grows to 7,200 cases as officials see a peak</title>
  <link>https://www.cidrap.umn.edu/ebola/ebola-outbreak-dr-congo-grows</link>
  <description>&lt;p&gt;Cases keep rising.&lt;/p&gt;</description>
  <pubDate>Mon, 14 Sep 2026 15:25:00 -0500</pubDate>
    </item>
    <item>
  <title>Sprouts &amp; mangos recalled in multistate Salmonella outbreak</title>
  <link>https://www.cidrap.umn.edu/foodborne/sprouts-mangos</link>
  <description>&lt;p&gt;Recall.&lt;/p&gt;</description>
  <pubDate>Tue, 01 Sep 2026 14:16:00 -0500</pubDate>
    </item>
</channel></rss>`;

test('RSS adapter trims and entity-decodes titles and tags the source', async () => {
  const items = await fetchRssItems('https://www.cidrap.umn.edu/news/64/rss', 'CIDRAP', {
    fetchImpl: async () => new Response(CIDRAP_XML, { status: 200 }),
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Ebola outbreak in DR Congo grows to 7,200 cases as officials see a peak');
  assert.equal(items[0].desc, 'Cases keep rising.');
  assert.equal(items[0].sourceName, 'CIDRAP');
  assert.equal(items[0]._originalPublishedMs, Date.parse('2026-09-14T20:25:00Z'));
  assert.equal(items[1].title, 'Sprouts & mangos recalled in multistate Salmonella outbreak');
});

test('RSS adapter returns no records on an HTTP error', async () => {
  const items = await fetchRssItems('https://www.cidrap.umn.edu/news/64/rss', 'CIDRAP', {
    fetchImpl: async () => new Response('forbidden', { status: 403 }),
  });
  assert.deepEqual(items, []);
});

test('headline sources take the location from the detected country, not the headline tail', () => {
  const item = mapItem(rssNormalizeItem({
    title: 'Ebola outbreak in DR Congo grows to 7,200 cases as officials see a peak',
    link: 'https://www.cidrap.umn.edu/ebola/x',
    desc: '',
    pubDate: 'Mon, 14 Sep 2026 15:25:00 -0500',
    sourceName: 'CIDRAP',
  }));
  assert.equal(item.disease, 'Ebola');
  assert.equal(item.countryCode, 'CD');
  assert.equal(item.location, new Intl.DisplayNames(['en'], { type: 'region' }).of('CD'));

  const ecdc = mapItem(rssNormalizeItem({
    title: 'Ebola disease outbreak in the Democratic Republic of the Congo',
    link: 'https://www.ecdc.europa.eu/en/ebola',
    desc: 'An Ebola virus disease outbreak has been ongoing in the Democratic Republic of the Congo (DRC).',
    pubDate: 'Wed, 23 Sep 2026 17:36:21 +0200',
    sourceName: 'ECDC',
  }));
  assert.equal(ecdc.countryCode, 'CD');
  assert.equal(ecdc.location, item.location);
});

test('headline source without a detectable country leaves location empty', () => {
  const item = mapItem(rssNormalizeItem({
    title: 'MERS-CoV worldwide overview', link: 'https://www.ecdc.europa.eu/en/mers', desc: '',
    pubDate: 'Mon, 07 Sep 2026 14:20:22 +0200', sourceName: 'ECDC',
  }));
  assert.equal(item.location, '');
  assert.equal(item.countryCode, '');
});

test('WHO titles keep the title-derived location', () => {
  const item = mapItem(whoNormalizeItem({
    Title: 'Ebola disease caused by Bundibugyo virus - Democratic Republic of the Congo',
    ItemDefaultUrl: '/2026-DON617',
    PublicationDateAndTime: '2026-09-10T08:16:08Z',
  }));
  assert.equal(item.location, 'Democratic Republic of the Congo');
});

// CIDRAP "Quick takes" roundups bundle unrelated stories under one headline,
// so disease and country detection attach one story's disease to another's
// country ("DR Congo Ebola emergency, malaria deaths in Germany" -> Ebola, DE).
test('roundup headlines are recognised so the seeder can drop them', () => {
  assert.equal(isRoundupHeadline('Quick takes: DR Congo Ebola emergency, malaria deaths in Germany, 7 new polio cases'), true);
  assert.equal(isRoundupHeadline('quick takes: H5N1 in dairy cattle'), true);
  assert.equal(isRoundupHeadline('Ebola outbreak in DR Congo tops 6,600 cases'), false);
});

// CIDRAP disease feeds also carry research, policy and opinion stories, and
// every feed returns its last 20 items however old. A headline-source item is
// kept only when it names a known disease and a country and is recent; WHO/CDC
// items keep their existing path.
const NOW = Date.parse('2026-09-23T12:00:00Z');
const headline = (title, { sourceName = 'CIDRAP', pubDate = 'Mon, 14 Sep 2026 15:25:00 -0500' } = {}) => mapItem(rssNormalizeItem({
  title, link: 'https://www.cidrap.umn.edu/x', desc: '', pubDate, sourceName,
}));

test('headline-source items need a known disease and a country to count as an outbreak', () => {
  assert.equal(isReportableHeadline(headline('Ebola outbreak in DR Congo tops 6,600 cases'), NOW), true);
  assert.equal(isReportableHeadline(headline('Tpoxx doesn\u2019t improve on placebo in achieving key mpox outcomes'), NOW), false);
  assert.equal(isReportableHeadline(headline('Poll highlights Americans\u2019 uneven knowledge of STI prevention'), NOW), false);
  assert.equal(isReportableHeadline(headline('Early estimates of seasonal influenza vaccine effectiveness', { sourceName: 'ECDC' }), NOW), false);

  const who = mapItem(whoNormalizeItem({ Title: 'Unusual respiratory illness - Country X', ItemDefaultUrl: '/x', PublicationDateAndTime: '2025-01-10T08:16:08Z' }));
  assert.equal(isReportableHeadline(who, NOW), true);
});

test('headline-source items older than the lookback are dropped', () => {
  const inside = new Date(NOW - (HEADLINE_LOOKBACK_DAYS - 1) * 86_400_000).toUTCString();
  const outside = new Date(NOW - (HEADLINE_LOOKBACK_DAYS + 1) * 86_400_000).toUTCString();
  assert.equal(isReportableHeadline(headline('Cholera outbreak in DR Congo intensifying', { pubDate: inside }), NOW), true);
  assert.equal(isReportableHeadline(headline('Cholera outbreak in DR Congo intensifying', { pubDate: outside }), NOW), false);
});

// Avian flu coverage names turkey farms constantly; the bird must not geocode
// to Türkiye, while the country still does.
test('turkey the bird does not geocode to Türkiye in headline sources', () => {
  assert.notEqual(headline('Turkey farms in Dakotas, Minnesota hit by H5N1 avian flu').countryCode, 'TR');
  assert.notEqual(headline('H5N1 avian flu strikes more turkeys in Minnesota').countryCode, 'TR');
  assert.equal(headline('H5N1 avian flu hits turkey farm in Poland').countryCode, 'PL');
  assert.equal(headline('Avian flu outbreak confirmed on poultry farm in Turkey').countryCode, 'TR');
});

// ── Pre-publish (in-memory) layer ────────────────────────────────────────

test('WHO record without PublicationDateAndTime → in-memory item is tagged synthetic', () => {
  const NOW = 1700000000000;
  const inMemory = whoNormalizeItem({ Title: 'Mpox - Country X', ItemDefaultUrl: '/mpox-x' }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, true);
  assert.equal(inMemory._originalPublishedMs, null);
  assert.equal(inMemory.publishedMs, NOW, 'publishedMs falls back to now() so existing isFinite filters + UI consumer contract still hold');
});

test('WHO record with valid PublicationDateAndTime → in-memory item is non-synthetic', () => {
  const NOW = 1700000000000;
  const PUB_ISO = '2026-04-23T15:30:00Z';
  const PUB_MS = new Date(PUB_ISO).getTime();
  const inMemory = whoNormalizeItem({ Title: 'Mpox', ItemDefaultUrl: '/mpox', PublicationDateAndTime: PUB_ISO }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, false);
  assert.equal(inMemory._originalPublishedMs, PUB_MS);
  assert.equal(inMemory.publishedMs, PUB_MS);
});

test('RSS record without pubDate → in-memory item is tagged synthetic', () => {
  const NOW = 1700000000000;
  const inMemory = rssNormalizeItem({ title: 'Outbreak', link: 'http://x', desc: '', pubDate: '', sourceName: 'CDC' }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, true);
  assert.equal(inMemory._originalPublishedMs, null);
  assert.equal(inMemory.publishedMs, NOW);
});

test('RSS record with valid pubDate → in-memory item is non-synthetic', () => {
  const NOW = 1700000000000;
  const PUB = 'Wed, 23 Apr 2026 15:30:00 GMT';
  const PUB_MS = new Date(PUB).getTime();
  const inMemory = rssNormalizeItem({ title: 'Outbreak', link: 'http://x', desc: '', pubDate: PUB, sourceName: 'CDC' }, NOW);
  assert.equal(inMemory._publishedAtIsSynthetic, false);
  assert.equal(inMemory._originalPublishedMs, PUB_MS);
  assert.equal(inMemory.publishedMs, PUB_MS);
});

test('TGH record always non-synthetic (line-198 filter rejects undated items earlier in the seeder)', () => {
  const inMemory = tghNormalizeItem({
    Alert_ID: '1', lat: 12.3, lng: 45.6, disease: 'Cholera', country: 'X',
    date: '4/23/2026', sourceUrl: 'http://x', summary: 's', cases: '5',
  });
  assert.equal(inMemory._publishedAtIsSynthetic, false);
  assert.equal(typeof inMemory._originalPublishedMs, 'number');
  assert.ok(inMemory._originalPublishedMs > 0);
});

// ── contentMeta behavior ─────────────────────────────────────────────────
//
// All skew-limit tests inject `nowMs` so the assertion is deterministic
// regardless of loaded-CI scheduler timing — addresses the P2 reviewer
// finding about timing sensitivity around the 1h boundary.

const FIXED_NOW = 1700000000000;     // 2023-11-14T22:13:20.000Z — stable test "now"

test('contentMeta returns null when ALL items are synthetic', () => {
  const data = {
    outbreaks: [
      { id: 'a', publishedAt: FIXED_NOW, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
      { id: 'b', publishedAt: FIXED_NOW, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
    ],
  };
  assert.equal(diseaseContentMeta(data, FIXED_NOW), null, 'all-synthetic → null → STALE_CONTENT');
});

test('contentMeta excludes synthetic items when mixed (does not let synthetic newest win)', () => {
  const PAST = 1690000000000;     // older than FIXED_NOW
  const data = {
    outbreaks: [
      // synthetic with VERY recent publishedMs (Date.now() fallback)
      { id: 'a', publishedAt: FIXED_NOW, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
      // real item, older but valid
      { id: 'b', publishedAt: PAST, _publishedAtIsSynthetic: false, _originalPublishedMs: PAST },
    ],
  };
  const result = diseaseContentMeta(data, FIXED_NOW);
  assert.equal(result.newestItemAt, PAST, 'synthetic must NOT influence newest — real older item wins');
  assert.equal(result.oldestItemAt, PAST);
});

test('contentMeta picks newest and oldest from the non-synthetic set', () => {
  const NEWEST = 1700000000000;
  const OLDEST = 1690000000000;
  const data = {
    outbreaks: [
      { _publishedAtIsSynthetic: false, _originalPublishedMs: OLDEST },
      { _publishedAtIsSynthetic: false, _originalPublishedMs: NEWEST },
      { _publishedAtIsSynthetic: false, _originalPublishedMs: (NEWEST + OLDEST) / 2 },
    ],
  };
  const result = diseaseContentMeta(data, FIXED_NOW);
  assert.equal(result.newestItemAt, NEWEST);
  assert.equal(result.oldestItemAt, OLDEST);
});

test('contentMeta excludes future-dated items beyond 1h clock-skew tolerance', () => {
  const REAL_RECENT = FIXED_NOW - 2 * 24 * 60 * 60 * 1000;
  const FUTURE = FIXED_NOW + 2 * 60 * 60 * 1000;    // 2h in the future — beyond 1h tolerance
  const data = {
    outbreaks: [
      { _publishedAtIsSynthetic: false, _originalPublishedMs: FUTURE },
      { _publishedAtIsSynthetic: false, _originalPublishedMs: REAL_RECENT },
    ],
  };
  const result = diseaseContentMeta(data, FIXED_NOW);
  assert.equal(result.newestItemAt, REAL_RECENT, 'future-dated item beyond 1h tolerance excluded — real most-recent wins');
});

test('contentMeta accepts items within 1h clock-skew tolerance', () => {
  // 5min ahead of FIXED_NOW — well inside the 1h tolerance window, well clear
  // of the skewLimit boundary. nowMs is injected so the comparison is
  // deterministic (independent of wall-clock timing).
  const NEAR_FUTURE = FIXED_NOW + 5 * 60 * 1000;
  const data = {
    outbreaks: [
      { _publishedAtIsSynthetic: false, _originalPublishedMs: NEAR_FUTURE },
    ],
  };
  const result = diseaseContentMeta(data, FIXED_NOW);
  assert.equal(result.newestItemAt, NEAR_FUTURE, 'NEAR_FUTURE within 1h tolerance is accepted');
});

// ── publishTransform strip ───────────────────────────────────────────────

test('publishTransform strips both helper fields from every item', () => {
  const data = {
    fetchedAt: '2026-05-04T12:00:00Z',
    outbreaks: [
      { id: 'a', publishedAt: 1, _publishedAtIsSynthetic: false, _originalPublishedMs: 1, otherField: 'kept' },
      { id: 'b', publishedAt: 2, _publishedAtIsSynthetic: true, _originalPublishedMs: null, otherField: 'kept' },
    ],
  };
  const stripped = diseasePublishTransform(data);
  for (const item of stripped.outbreaks) {
    assert.ok(!('_publishedAtIsSynthetic' in item), '_publishedAtIsSynthetic must be stripped');
    assert.ok(!('_originalPublishedMs' in item), '_originalPublishedMs must be stripped');
    // Other fields preserved
    assert.equal(item.otherField, 'kept');
  }
  // Top-level fields preserved
  assert.equal(stripped.fetchedAt, '2026-05-04T12:00:00Z');
});

test('publishTransform preserves publishedAt as non-null (UI/RPC consumer contract)', () => {
  const data = {
    outbreaks: [
      { id: 'a', publishedAt: 12345, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
    ],
  };
  const stripped = diseasePublishTransform(data);
  assert.equal(stripped.outbreaks[0].publishedAt, 12345, 'publishedAt remains non-null on every published item');
});

test('publishTransform handles empty + missing outbreaks safely', () => {
  assert.deepEqual(diseasePublishTransform({ outbreaks: [] }).outbreaks, []);
  // Missing outbreaks key → defaults to []
  assert.deepEqual(diseasePublishTransform({}).outbreaks, []);
});

// ── End-to-end shape lock: contentMeta runs first, publishTransform strips ──

test('end-to-end: contentMeta runs on raw data WITH helpers, publishTransform strips, canonical is helper-free', () => {
  const NEWEST = 1700000000000;
  const OLDEST = 1690000000000;
  const rawData = {
    fetchedAt: '2026-05-04T12:00:00Z',
    outbreaks: [
      { id: 'who-1', publishedAt: NEWEST, _publishedAtIsSynthetic: false, _originalPublishedMs: NEWEST },
      { id: 'rss-1', publishedAt: FIXED_NOW, _publishedAtIsSynthetic: true, _originalPublishedMs: null },
      { id: 'tgh-1', publishedAt: OLDEST, _publishedAtIsSynthetic: false, _originalPublishedMs: OLDEST },
    ],
  };

  // Step 1: contentMeta on raw data (use injected nowMs so the future-clock-skew filter is deterministic)
  const contentResult = diseaseContentMeta(rawData, FIXED_NOW);
  assert.equal(contentResult.newestItemAt, NEWEST, 'contentMeta sees real (non-synthetic) newest');
  assert.equal(contentResult.oldestItemAt, OLDEST);

  // Step 2: publishTransform on raw data
  const published = diseasePublishTransform(rawData);
  for (const item of published.outbreaks) {
    assert.ok(!('_publishedAtIsSynthetic' in item), `${item.id}: _publishedAtIsSynthetic stripped`);
    assert.ok(!('_originalPublishedMs' in item), `${item.id}: _originalPublishedMs stripped`);
  }
  // Combined-regex assertion (Codex round 4 P2): published payload must NOT
  // contain EITHER helper name when serialized.
  const json = JSON.stringify(published);
  assert.equal((json.match(/_publishedAtIsSynthetic/g) || []).length, 0, 'no _publishedAtIsSynthetic in JSON');
  assert.equal((json.match(/_originalPublishedMs/g) || []).length, 0, 'no _originalPublishedMs in JSON');
});

test('DISEASE_MAX_CONTENT_AGE_MIN constant is 14 days', () => {
  assert.equal(DISEASE_MAX_CONTENT_AGE_MIN, 14 * 24 * 60, 'budget matches the observed weekly release cadence and 3 to 5 day event lag');
});

test('12-day-old disease content remains within the 14-day budget', () => {
  const TWELVE_DAYS_AGO = FIXED_NOW - 12 * 24 * 60 * 60 * 1000;
  const data = {
    outbreaks: [
      { _publishedAtIsSynthetic: false, _originalPublishedMs: TWELVE_DAYS_AGO },
    ],
  };
  const cm = diseaseContentMeta(data, FIXED_NOW);
  assert.ok(cm, 'contentMeta returns a result');
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(ageMin < DISEASE_MAX_CONTENT_AGE_MIN, '12-day-old content remains healthy');
});

test('15-day-old disease content exceeds the 14-day budget', () => {
  const FIFTEEN_DAYS_AGO = FIXED_NOW - 15 * 24 * 60 * 60 * 1000;
  const data = { outbreaks: [{ _publishedAtIsSynthetic: false, _originalPublishedMs: FIFTEEN_DAYS_AGO }] };
  const cm = diseaseContentMeta(data, FIXED_NOW);
  const ageMin = (FIXED_NOW - cm.newestItemAt) / 60000;
  assert.ok(ageMin > DISEASE_MAX_CONTENT_AGE_MIN, '15-day-old content triggers STALE_CONTENT');
});

// ── detectAlertLevel — keyword classifier (#3791) ─────────────────────────

test('detectAlertLevel: alert keywords as whole words map to alert', () => {
  for (const kw of DISEASE_ALERT_KEYWORDS) {
    assert.equal(
      detectAlertLevel(`Cholera ${kw} confirmed in country X`, ''),
      'alert',
      `keyword "${kw}" should trigger alert`,
    );
  }
});

test('detectAlertLevel: warning keywords as whole words map to warning', () => {
  for (const kw of DISEASE_WARNING_KEYWORDS) {
    assert.equal(
      detectAlertLevel(`Health ministry issues ${kw} after lab results`, ''),
      'warning',
      `keyword "${kw}" should trigger warning`,
    );
  }
});

test('detectAlertLevel: substring of an alert keyword does NOT promote (#3791 regression)', () => {
  // Prior substring matching let "epidemic" fire inside "antiepidemic" and
  // "outbreak" fire inside "outbreaking" (non-word). Word boundaries fix this.
  assert.equal(
    detectAlertLevel('New antiepidemic vaccination drive launched', ''),
    'watch',
    '"antiepidemic" must not match the bare "epidemic" keyword',
  );
  assert.equal(
    detectAlertLevel('Widespread vaccination program effective', ''),
    'watch',
    '"widespread" must not match the bare "spread" keyword',
  );
});

test('detectAlertLevel: case-insensitive matching', () => {
  assert.equal(detectAlertLevel('EBOLA OUTBREAK confirmed', ''), 'alert');
  assert.equal(detectAlertLevel('Cases Increasing in north', ''), 'warning');
});

test('detectAlertLevel: matches against title + desc concatenated', () => {
  assert.equal(detectAlertLevel('Cholera update', 'WHO declares emergency'), 'alert');
  assert.equal(detectAlertLevel('Status report', 'cases increasing across two regions'), 'warning');
});

test('detectAlertLevel: null/undefined inputs default to watch (no throw)', () => {
  assert.equal(detectAlertLevel(undefined, undefined), 'watch');
  assert.equal(detectAlertLevel(null, null), 'watch');
  assert.equal(detectAlertLevel('', ''), 'watch');
});

test('detectAlertLevel: alert wins over warning when both keyword classes match', () => {
  assert.equal(
    detectAlertLevel('Spread of outbreak confirmed', ''),
    'alert',
    'both "spread" (warning) and "outbreak" (alert) present — alert wins',
  );
});

test('DISEASE_ALERT_KEYWORDS and DISEASE_WARNING_KEYWORDS are frozen (#3791 change protocol)', () => {
  assert.ok(Object.isFrozen(DISEASE_ALERT_KEYWORDS), 'DISEASE_ALERT_KEYWORDS must be frozen to prevent runtime mutation');
  assert.ok(Object.isFrozen(DISEASE_WARNING_KEYWORDS), 'DISEASE_WARNING_KEYWORDS must be frozen to prevent runtime mutation');
});

test('ALERT_LEVEL_METHODOLOGY_VERSION is a non-empty version string', () => {
  assert.equal(typeof ALERT_LEVEL_METHODOLOGY_VERSION, 'string');
  assert.match(ALERT_LEVEL_METHODOLOGY_VERSION, /^v\d+/);
});

test('DISEASE_ALERT_RE and DISEASE_WARNING_RE are anchored on word boundaries (substring-bug guard)', () => {
  // Exported regexes give callers the right primitive directly — using them
  // instead of `text.includes(kw)` is the only safe way to check membership.
  assert.ok(DISEASE_ALERT_RE.test('Cholera outbreak confirmed'));
  assert.ok(!DISEASE_ALERT_RE.test('New antiepidemic vaccination drive'));
  assert.ok(DISEASE_WARNING_RE.test('Cases increasing in north'));
  assert.ok(!DISEASE_WARNING_RE.test('Widespread vaccination program'));
});

test('seed payload carries alertLevelMethodologyVersion post-publishTransform (version-field consumer)', () => {
  // Mirrors the shape produced by fetchDiseaseOutbreaks in
  // scripts/seed-disease-outbreaks.mjs. Asserts the version field survives
  // publishTransform so bumping ALERT_LEVEL_METHODOLOGY_VERSION observably
  // changes the wire payload (the methodology doc's change protocol step 1
  // now has a real consumer).
  const raw = {
    outbreaks: [
      { id: 'a', publishedAt: 1, _publishedAtIsSynthetic: false, _originalPublishedMs: 1 },
    ],
    fetchedAt: 1700000000000,
    alertLevelMethodologyVersion: ALERT_LEVEL_METHODOLOGY_VERSION,
  };
  const published = diseasePublishTransform(raw);
  assert.equal(
    published.alertLevelMethodologyVersion,
    ALERT_LEVEL_METHODOLOGY_VERSION,
    'wire payload must surface the methodology version so bumps propagate to clients',
  );
});

for (const [input, expected] of [
  [0, 0], [1, 1], [42, 42], ['5', 5], [' 12 ', 12],
  [undefined, 0], [null, 0], ['', 0], [true, 0], [[], 0], [{}, 0],
  [-1, 0], [1.5, 0], [Infinity, 0], [NaN, 0], [Number.MAX_SAFE_INTEGER + 1, 0],
  ['<img src=x onerror=alert(1)>', 0], ['12 cases', 0],
]) {
  test(`TGH cases ${JSON.stringify(input)} publishes numeric ${expected}`, () => {
    const normalized = tghNormalizeItem({ disease: 'Cholera', date: '2026-09-01', cases: input });
    const published = diseasePublishTransform({ outbreaks: [mapItem(normalized)] });
    assert.equal(normalized._cases, expected);
    assert.equal(published.outbreaks[0].cases, expected);
    assert.equal(typeof published.outbreaks[0].cases, 'number');
  });
}
