import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { TELEGRAM_CHANNEL_TRUST } from '../shared/telegram-channel-trust.ts';
import { GDELT_FIPS_TO_ISO2 } from '../scripts/_gdelt-country-codes.mjs';
import { geoToCountry } from '../server/worldmonitor/intelligence/v1/get-risk-scores.ts';

const require = createRequire(import.meta.url);
const gazetteer = require('../scripts/lib/middle-east-strikes-gazetteer.cjs');
const strikes = require('../scripts/lib/middle-east-strikes.cjs');

const NOW = Date.parse('2026-10-19T12:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const IRAN_CENTROID = [32.4279, 53.688];

let messageId = 1000;
function post(channel, text, ageMs = 10 * MIN, overrides = {}) {
  const id = ++messageId;
  return {
    id: `${channel.toLowerCase()}:${id}`,
    channel: channel.toLowerCase(),
    url: `https://t.me/${channel}/${id}`,
    ts: new Date(NOW - ageMs).toISOString(),
    text,
    ...overrides,
  };
}

function cls(overrides = {}) {
  return { isStrike: true, kind: 'strike', place: 'Jizan', countryIso2: 'SA', severity: 'high', ...overrides };
}

function candidate(channel, classification, ageMs = 10 * MIN, text = `${channel} reports ${classification.place} (${ageMs})`) {
  const c = strikes.buildTelegramCandidate(post(channel, text, ageMs), classification, NOW);
  assert.ok(c, `fixture candidate for ${channel} must build`);
  return c;
}

// 61-column GDELT 2.0 event row. Only the columns the mapper reads are filled.
function gdeltRow({ id = '1', baseCode = '195', geoType = '4', fips = 'SA', lat = 16.89, lon = 42.55,
  numSources = 2, added = '20261019113000', url = 'https://news.example/a', fullName = 'Jizan, Jizan, Saudi Arabia' } = {}) {
  const f = new Array(61).fill('');
  f[0] = id; f[25] = '1'; f[26] = baseCode; f[27] = baseCode; f[28] = baseCode.slice(0, 2); f[29] = '4';
  f[32] = String(numSources); f[51] = geoType; f[52] = fullName; f[53] = fips;
  f[56] = String(lat); f[57] = String(lon); f[59] = added; f[60] = url;
  return f.join('\t');
}

describe('keyword pre-filter', () => {
  it('passes English, Arabic and Persian strike reports anchored in the theater', () => {
    assert.equal(strikes.prefilterStrikeText('Ballistic missile strike hits Jizan, Saudi Arabia'), true);
    assert.equal(strikes.prefilterStrikeText('Houthi drone intercepted over the Red Sea'), true);
    assert.equal(strikes.prefilterStrikeText('الدفاع المدني: سقوط شظايا صاروخ تم اعتراضه في الرياض'), true);
    assert.equal(strikes.prefilterStrikeText('غارات جوية على صنعاء'), true);
    assert.equal(strikes.prefilterStrikeText('انفجار مهیب در تهران'), true);
    assert.equal(strikes.prefilterStrikeText('Air raid sirens and explosions reported in Erbil'), true);
    assert.equal(strikes.prefilterStrikeText('حمله موشکی به عربستان'), true);
    assert.equal(strikes.prefilterStrikeText('حمله پهپادی به یمن'), true);
    assert.equal(strikes.prefilterStrikeText('قصف في سورية'), true);
  });

  it('drops strike vocabulary outside the theater and theater news without strike vocabulary', () => {
    assert.equal(strikes.prefilterStrikeText('Massive drone attack on Kyiv overnight, explosions reported'), false);
    assert.equal(strikes.prefilterStrikeText('Saudi crown prince receives the Emir of Qatar in Riyadh'), false);
    assert.equal(strikes.prefilterStrikeText(''), false);
    assert.equal(strikes.prefilterStrikeText(null), false);
  });
});

describe('classifier response parsing', () => {
  it('normalizes well-formed entries and keeps index alignment', () => {
    const parsed = strikes.parseStrikeClassifications([
      { i: 1, isStrike: false },
      { i: 0, isStrike: true, kind: 'intercept', place: ' Riyadh ', countryIso2: 'sa', severity: 'elevated' },
    ], 2);
    assert.deepEqual(parsed[0], { isStrike: true, kind: 'intercept', place: 'Riyadh', countryIso2: 'SA', severity: 'elevated' });
    assert.deepEqual(parsed[1], { isStrike: false, kind: null, place: '', countryIso2: null, severity: null });
  });

  it('rejects out-of-range, duplicate, and malformed entries instead of guessing', () => {
    const parsed = strikes.parseStrikeClassifications([
      { i: 0, isStrike: true, kind: 'strike', place: 'Aden', countryIso2: 'YE', severity: 'high' },
      { i: 0, isStrike: true, kind: 'strike', place: 'Sanaa', countryIso2: 'YE', severity: 'high' },
      { i: 1, isStrike: true, kind: 'bombardment', place: 'Aden', countryIso2: 'YE', severity: 'high' },
      { i: 2, isStrike: true, kind: 'strike', place: 'Aden', countryIso2: 'YE', severity: 'apocalyptic' },
      { i: 3, isStrike: 'yes' },
      { i: 9, isStrike: false },
      { i: 1.5, isStrike: false },
      'garbage',
    ], 4);
    assert.deepEqual(parsed, [undefined, undefined, undefined, undefined]);
    assert.deepEqual(strikes.parseStrikeClassifications(null, 2), [undefined, undefined]);
    assert.deepEqual(strikes.parseStrikeClassifications({ i: 0 }, 1), [undefined]);
  });

  it('caps claims at elevated severity', () => {
    const [parsed] = strikes.parseStrikeClassifications([
      { i: 0, isStrike: true, kind: 'claim', place: 'Eilat', countryIso2: 'IL', severity: 'critical' },
    ], 1);
    assert.equal(parsed.severity, 'elevated');
  });
});

describe('gazetteer', () => {
  const REQUIRED = {
    Riyadh: 'SA', Jeddah: 'SA', Dammam: 'SA', Jizan: 'SA', Najran: 'SA', Abha: 'SA', Yanbu: 'SA',
    Sanaa: 'YE', Hodeidah: 'YE', Marib: 'YE', Aden: 'YE',
  };

  for (const [name, iso2] of Object.entries(REQUIRED)) {
    it(`${name} resolves to ${iso2}, never the Iran centroid`, () => {
      for (const reported of [iso2, null]) {
        const place = gazetteer.resolvePlace({ place: name, iso2: reported });
        assert.ok(place, `${name} (${reported}) must resolve`);
        assert.equal(place.iso2, iso2);
        assert.equal(place.countryLevel, undefined, `${name} must resolve to the city, not a centroid`);
        assert.notDeepEqual([place.lat, place.lon], IRAN_CENTROID);
        assert.equal(geoToCountry(place.lat, place.lon), iso2,
          `${name} (${place.lat},${place.lon}) must score to ${iso2}`);
      }
    });
  }

  it('resolves spelling variants and Arabic script', () => {
    assert.equal(gazetteer.resolvePlace({ place: 'Al Hudaydah port', iso2: 'YE' }).name, 'Al Hudaydah');
    assert.equal(gazetteer.resolvePlace({ place: "Ma'rib", iso2: 'YE' }).key, gazetteer.resolvePlace({ place: 'Marib', iso2: 'YE' }).key);
    assert.equal(gazetteer.resolvePlace({ place: 'Jazan', iso2: 'SA' }).key, gazetteer.resolvePlace({ place: 'Jizan', iso2: 'SA' }).key);
    assert.equal(gazetteer.findPlaceInText('سقوط مقذوف عسكري في جازان').iso2, 'SA');
    assert.equal(gazetteer.findPlaceInText('غارات على الحديدة').name, 'Al Hudaydah');
    assert.equal(gazetteer.findPlaceInText('اعتراض صاروخ بالرياض').name, 'Riyadh');
  });

  it('does not read Arabic common words as places', () => {
    assert.equal(gazetteer.findPlaceInText('عاجل: خبر عن عديد الضحايا'), null);
  });

  it('falls back to the reported country centroid, and drops reports with no focus country', () => {
    const fallback = gazetteer.resolvePlace({ place: 'an undisclosed desert site', iso2: 'SA' });
    assert.equal(fallback.iso2, 'SA');
    assert.equal(fallback.countryLevel, true);
    assert.deepEqual([fallback.lat, fallback.lon], gazetteer.COUNTRY_CENTROIDS.SA);
    assert.equal(gazetteer.resolvePlace({ place: 'Kyiv', iso2: 'UA' }), null);
    assert.equal(gazetteer.resolvePlace({ place: 'somewhere', iso2: null }), null);
  });

  it('prefers the gazetteer country when the classifier names the attacker instead', () => {
    assert.equal(gazetteer.resolvePlace({ place: 'Eilat', iso2: 'YE' }).iso2, 'IL');
    assert.equal(gazetteer.resolvePlace({ place: 'Eilat' }).iso2, 'IL', 'no country given');
  });

  it('keeps an impact the classifier placed outside the theater out of it', () => {
    assert.equal(gazetteer.resolvePlace({ place: 'Tripoli', iso2: 'LY' }), null);
    assert.equal(gazetteer.resolvePlace({ place: 'Tripoli', iso2: 'LB' }).iso2, 'LB');
  });

  it('plots maritime incidents at the strait, not the inland Iran centroid', () => {
    const place = gazetteer.resolvePlace({ place: 'Strait of Hormuz', iso2: 'IR' });
    assert.equal(place.name, 'Strait of Hormuz');
    assert.notDeepEqual([place.lat, place.lon], gazetteer.COUNTRY_CENTROIDS.IR);
    assert.equal(gazetteer.resolvePlace({ place: 'Sirik', iso2: 'IR' }).name, 'Sirik');
    assert.equal(gazetteer.resolvePlace({ place: 'Jardan district, Shabwa', iso2: 'YE' }).name, 'Shabwah');
  });

  it('scores every CII-tracked country centroid to its own country, and no other centroid', () => {
    for (const iso2 of ['SA', 'YE', 'IR', 'IQ', 'AE', 'IL', 'QA', 'LB', 'SY']) {
      const [lat, lon] = gazetteer.COUNTRY_CENTROIDS[iso2];
      assert.equal(geoToCountry(lat, lon), iso2, `${iso2} centroid`);
    }
    // Not CII-tracked: their events must not land on a neighbour's row.
    for (const iso2 of ['KW', 'BH', 'OM', 'JO']) {
      const [lat, lon] = gazetteer.COUNTRY_CENTROIDS[iso2];
      assert.equal(geoToCountry(lat, lon), null, `${iso2} centroid`);
    }
  });

  it('does not read English words in free text as places', () => {
    const place = gazetteer.resolvePlace({ iso2: 'SA', text: 'A hail of drones hit Saudi Arabia overnight' });
    assert.equal(place.countryLevel, true, `got ${place.name}`);
    assert.equal(gazetteer.resolvePlace({ iso2: 'JO', text: 'They will salt the earth, Jordan says' }).countryLevel, true);
  });

  it('names cities, not the province that shares their point', () => {
    assert.equal(gazetteer.resolvePlace({ place: 'Mosul', iso2: 'IQ' }).name, 'Mosul');
    assert.equal(gazetteer.resolvePlace({ place: 'Zahedan', iso2: 'IR' }).name, 'Zahedan');
    assert.equal(gazetteer.resolvePlace({ place: 'Ibb', iso2: 'YE' }).countryLevel, undefined);
  });

  it('never plots Palestinian places inside Israel', () => {
    assert.equal(gazetteer.resolvePlace({ place: 'Gaza City', iso2: 'IL' }), null);
    assert.equal(gazetteer.resolvePlace({ place: 'Jenin camp', iso2: 'IL' }), null);
    assert.equal(gazetteer.resolvePlace({ place: '', iso2: 'IL', text: 'Airstrikes on Khan Yunis in southern Gaza' }), null);
  });
});

describe('source trust', () => {
  it('mirrors shared/telegram-channel-trust.ts exactly', () => {
    const expected = Object.fromEntries(TELEGRAM_CHANNEL_TRUST.map((entry) => [
      entry.handle, [entry.tier, entry.risk, entry.stateAffiliated ?? null],
    ]));
    assert.deepEqual(strikes.TELEGRAM_STRIKE_TRUST, expected);
  });

  it('classifies official, independent, and propaganda-leaning channels', () => {
    assert.equal(strikes.channelTrust('saudidcd').cls, 'official');
    assert.equal(strikes.channelTrust('OSINTdefender').cls, 'independent');
    assert.equal(strikes.channelTrust('sepah').cls, 'propaganda');
    assert.equal(strikes.channelTrust('tasnimnewsen').cls, 'propaganda');
    assert.equal(strikes.channelTrust('IDFofficial').cls, 'propaganda');
    assert.equal(strikes.channelTrust('RezistanceTrench1').cls, 'propaganda', 'tier 4 needs corroboration');
    assert.equal(strikes.channelTrust('some_new_channel').cls, 'propaganda', 'unknown channels fail closed');
    assert.equal(strikes.channelTrust('sepah').group, strikes.channelTrust('tasnimnewsen').group, 'one state, one voice');
  });
});

describe('corroboration rule', () => {
  const events = (cands) => strikes.deriveStrikeEvents(cands, NOW);

  it('lets a tier-1 official source stand alone', () => {
    assert.equal(events([candidate('SaudiDCD', cls())]).length, 1);
  });

  it('lets an independent observed report stand alone, but not an independent relay of a claim', () => {
    assert.equal(events([candidate('OSINTdefender', cls())]).length, 1);
    assert.equal(events([candidate('OSINTdefender', cls({ kind: 'claim', severity: 'elevated' }))]).length, 0);
  });

  it('holds a propaganda-leaning report until an independent source agrees', () => {
    const sepah = candidate('sepah', cls({ place: 'Riyadh' }));
    assert.equal(events([sepah]).length, 0, 'sepah alone');
    assert.equal(events([sepah, candidate('TasnimNewsEN', cls({ place: 'Riyadh' }))]).length, 0, 'same-state echo is not corroboration');
    const confirmed = events([sepah, candidate('ClashReport', cls({ place: 'Riyadh', kind: 'claim', severity: 'elevated' }), 30 * MIN)]);
    assert.equal(confirmed.length, 1, 'independent agreement publishes');
    assert.equal(confirmed[0].locationName, 'Riyadh');
    assert.equal(events([sepah, candidate('ClashReport', cls({ place: 'Jeddah' }))]).filter((e) => e.locationName === 'Riyadh').length, 0,
      'agreement must be about the same place');
  });

  it('requires the agreeing report inside the corroboration window', () => {
    const sepah = candidate('sepah', cls({ place: 'Abha' }), 10 * MIN);
    const late = candidate('ClashReport', cls({ place: 'Abha', kind: 'claim', severity: 'elevated' }), 10 * MIN + 5 * HOUR);
    assert.equal(events([sepah, late]).length, 0);
  });

  it('two propaganda claims from opposing states still need an observed report', () => {
    const iranClaim = candidate('sepah', cls({ place: 'Haifa', countryIso2: 'IL', kind: 'claim', severity: 'elevated' }));
    const israelClaim = candidate('IDFofficial', cls({ place: 'Haifa', countryIso2: 'IL', kind: 'claim', severity: 'elevated' }));
    assert.equal(events([iranClaim, israelClaim]).length, 0);
    const israelReport = candidate('IDFofficial', cls({ place: 'Haifa', countryIso2: 'IL', kind: 'intercept', severity: 'elevated' }));
    assert.equal(events([iranClaim, israelReport]).length, 1);
  });
});

describe('dedupe and window', () => {
  it('merges reports of one place inside a 30-minute bucket into one stable event', () => {
    const a = candidate('SaudiDCD', cls(), 12 * MIN);
    const b = candidate('OSINTdefender', cls(), 11 * MIN);
    const out = strikes.deriveStrikeEvents([a, b], NOW);
    assert.equal(out.length, 1);
    assert.match(out[0].id, /^tg:SA:SA:jizan:\d+$/);
    assert.equal(out[0].sourceUrl, a.url, 'the official source represents the event');
    assert.deepEqual(strikes.deriveStrikeEvents([b, a], NOW).map((e) => e.id), out.map((e) => e.id));
  });

  it('keeps separate buckets and separate places apart', () => {
    const out = strikes.deriveStrikeEvents([
      candidate('SaudiDCD', cls(), 10 * MIN),
      candidate('SaudiDCD', cls(), 70 * MIN),
      candidate('SaudiDCD', cls({ place: 'Najran' }), 10 * MIN),
    ], NOW);
    assert.equal(out.length, 3);
  });

  it('emits the conflict:iran-events:v1 event schema', () => {
    const [event] = strikes.deriveStrikeEvents([candidate('SaudiDCD', cls({ place: 'Riyadh', kind: 'intercept', severity: 'elevated' }))], NOW);
    assert.deepEqual(Object.keys(event).sort(), ['category', 'countryCode', 'id', 'latitude', 'locationName', 'longitude', 'severity', 'sourceUrl', 'timestamp', 'title'].sort());
    assert.equal(event.countryCode, 'SA', 'the CII scores an event by the country it carries');
    assert.equal(event.category, 'defense');
    assert.equal(typeof event.timestamp, 'number');
    assert.equal(event.severity, 'elevated');
  });

  it('drops reports older than 72h and from the future', () => {
    const aging = candidate('SaudiDCD', cls(), 71 * HOUR);
    assert.equal(strikes.deriveStrikeEvents([aging], NOW).length, 1);
    assert.equal(strikes.deriveStrikeEvents([aging], NOW + 2 * HOUR).length, 0, 'ages out after 72h');
    assert.equal(strikes.buildTelegramCandidate(post('SaudiDCD', 'x', -2 * HOUR), cls(), NOW), null);
    const expired = { ...candidate('SaudiDCD', cls()), id: 'tg:saudidcd:1', ts: NOW - 80 * HOUR };
    const store = strikes.mergeCandidateStore({ candidates: [expired] }, [candidate('SaudiDCD', cls())], NOW);
    assert.equal(store.candidates.length, 1);
    assert.notEqual(store.candidates[0].id, expired.id, 'the stored candidate past 72h is pruned');
  });

  it('drops out-of-theater and non-strike classifications', () => {
    assert.equal(strikes.buildTelegramCandidate(post('ClashReport', 'x'), cls({ countryIso2: 'UA', place: 'Kyiv' }), NOW), null);
    assert.equal(strikes.buildTelegramCandidate(post('ClashReport', 'x'), { isStrike: false }, NOW), null);
  });
});

describe('GDELT backstop', () => {
  it('maps the FIPS codes it filters on to the same ISO-2 codes as the shared GDELT table', () => {
    for (const [fips, iso2] of Object.entries(strikes.GDELT_STRIKE_FIPS)) assert.equal(GDELT_FIPS_TO_ISO2[fips], iso2, fips);
    assert.equal(strikes.GDELT_STRIKE_FIPS.YM, 'YE');
    assert.equal(strikes.GDELT_STRIKE_FIPS.IZ, 'IQ');
  });

  it('keeps city-level force events in the theater and clusters them with enough sources', () => {
    const csv = [
      gdeltRow({ id: '1', numSources: 2, url: 'https://a.example/1' }),
      gdeltRow({ id: '2', numSources: 1, url: 'https://b.example/2', lat: 16.9, lon: 42.56 }),
      gdeltRow({ id: '3', geoType: '1', numSources: 9 }),
      gdeltRow({ id: '4', baseCode: '042', numSources: 9 }),
      gdeltRow({ id: '5', fips: 'UP', lat: 50.45, lon: 30.52, numSources: 9 }),
      gdeltRow({ id: '6', fips: 'YM', lat: 15.46, lon: 45.33, numSources: 2, url: 'https://c.example/6', fullName: 'Marib, Ma\'rib, Yemen' }),
    ].join('\n');
    const cands = strikes.mapGdeltExportToStrikeCandidates(csv);
    assert.deepEqual(cands.map((c) => `${c.iso2}:${c.place}:${c.sources}`).sort(), ['SA:Jizan:3', "YE:Ma'rib:2"],
      'country-level, non-force and out-of-theater rows are dropped; same place and bucket cluster');
    for (const c of cands) {
      assert.equal(c.src, 'gdelt');
      assert.equal(c.severity, 'moderate');
    }
    const events = strikes.deriveStrikeEvents(cands, NOW);
    assert.deepEqual(events.map((e) => e.locationName), ['Jizan'], 'Marib has one URL and two mentions: below the source gate');
  });

  it('ignores rows geocoded to capital datelines', () => {
    const csv = [
      gdeltRow({ id: '1', lat: 24.69, lon: 46.72, numSources: 5, url: 'https://a.example/1', fullName: 'Riyadh, Ar Riyad, Saudi Arabia' }),
      gdeltRow({ id: '2', lat: 24.7, lon: 46.7, numSources: 5, url: 'https://b.example/2', fullName: 'Riyadh, Ar Riyad, Saudi Arabia' }),
      gdeltRow({ id: '3', fips: 'IR', lat: 35.69, lon: 51.42, numSources: 5, url: 'https://c.example/3', fullName: 'Tehran, Tehran, Iran' }),
    ].join('\n');
    assert.deepEqual(strikes.mapGdeltExportToStrikeCandidates(csv), []);
  });

  it('ignores Gaza coded as Israel and rows whose province GDELT could not resolve', () => {
    const csv = [
      gdeltRow({ id: '1', fips: 'IS', lat: 31.42, lon: 34.33, numSources: 5, url: 'https://a.example/1', fullName: 'Gaza, Israel (general), Israel' }),
      gdeltRow({ id: '2', lat: 28.57, lon: 37.27, numSources: 5, url: 'https://b.example/2', fullName: 'Al-Azhar, Saudi Arabia (general), Saudi Arabia' }),
    ].join('\n');
    assert.deepEqual(strikes.mapGdeltExportToStrikeCandidates(csv), []);
  });

  it('accumulates sources for one incident across export files', () => {
    const a = strikes.mapGdeltExportToStrikeCandidates(gdeltRow({ id: '1', numSources: 1, url: 'https://a.example/1' }));
    const b = strikes.mapGdeltExportToStrikeCandidates(gdeltRow({ id: '2', numSources: 2, url: 'https://b.example/2', added: '20261019114500' }));
    assert.equal(strikes.deriveStrikeEvents(a, NOW).length, 0);
    assert.equal(strikes.deriveStrikeEvents([...a, ...b], NOW).length, 1);
  });

  it('prunes GDELT clusters that never reach the source gate', () => {
    const lone = strikes.mapGdeltExportToStrikeCandidates(gdeltRow({ id: '1', numSources: 1, added: '20261019060000' }));
    assert.equal(strikes.mergeCandidateStore(null, lone, NOW).candidates.length, 0);
    const recent = strikes.mapGdeltExportToStrikeCandidates(gdeltRow({ id: '2', numSources: 1, added: '20261019113000' }));
    assert.equal(strikes.mergeCandidateStore(null, recent, NOW).candidates.length, 1, 'recent clusters wait for late coverage');
  });

  it('publishes a GDELT-only cluster as a flagged lower-trust event', () => {
    const csv = [gdeltRow({ id: '1', numSources: 3, url: 'https://a.example/1' }), gdeltRow({ id: '2', numSources: 1, url: 'https://b.example/2' })].join('\n');
    const [event] = strikes.deriveStrikeEvents(strikes.mapGdeltExportToStrikeCandidates(csv), NOW);
    assert.match(event.id, /^gdelt:SA:/);
    assert.equal(event.countryCode, 'SA');
    assert.equal(event.category, 'gdelt');
    assert.equal(event.severity, 'moderate');
  });

  it('folds a GDELT cluster into a nearby Telegram event instead of double counting', () => {
    const csv = [gdeltRow({ id: '1', numSources: 3, url: 'https://a.example/1' }), gdeltRow({ id: '2', numSources: 1, url: 'https://b.example/2' })].join('\n');
    const out = strikes.deriveStrikeEvents([
      ...strikes.mapGdeltExportToStrikeCandidates(csv),
      candidate('SaudiDCD', cls({ place: 'Sabya' }), 30 * MIN),
    ], NOW);
    assert.equal(out.length, 1);
    assert.match(out[0].id, /^tg:/);
  });

  it('fetches only unprocessed exports, verifies them, and retries a failed one', async () => {
    const bulk = await import('../scripts/_conflict-gdelt-bulk.mjs');
    const csv = [gdeltRow({ id: '1', numSources: 3, url: 'https://a.example/1' }), gdeltRow({ id: '2', url: 'https://b.example/2' })].join('\n');
    const zipOf = (stamp, body) => {
      const name = Buffer.from(`${stamp}.export.CSV`);
      const raw = Buffer.from(body);
      const data = deflateRawSync(raw);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
      header.writeUInt32LE(data.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(name.length, 26);
      return Buffer.concat([header, name, data]);
    };
    const good = zipOf('20261019113000', csv);
    const bad = zipOf('20261019114500', csv);
    const md5 = (b) => createHash('md5').update(b).digest('hex');
    const manifest = [
      `${good.length} ${md5(good)} http://data.gdeltproject.org/gdeltv2/20261019113000.export.CSV.zip`,
      `${bad.length} ${'0'.repeat(32)} http://data.gdeltproject.org/gdeltv2/20261019114500.export.CSV.zip`,
    ].join('\n');
    const requested = [];
    const fetchImpl = async (url) => {
      requested.push(url);
      const body = url === bulk.GDELT_MASTER_FILELIST_URL ? Buffer.from(manifest) : (url.includes('113000') ? good : bad);
      return new Response(body, { status: url === bulk.GDELT_MASTER_FILELIST_URL ? 206 : 200 });
    };
    const first = await strikes.fetchGdeltStrikeCandidates({ bulk, fetchImpl });
    assert.equal(first.candidates.length, 1);
    assert.deepEqual(first.processed, ['20261019113000']);
    assert.equal(first.errors.length, 1, 'checksum mismatch is reported, not mapped');
    requested.length = 0;
    const second = await strikes.fetchGdeltStrikeCandidates({ bulk, fetchImpl, processed: first.processed });
    assert.equal(second.candidates.length, 0);
    assert.ok(!requested.some((url) => url.includes('113000')), 'a processed export is not downloaded again');
    assert.ok(requested.some((url) => url.includes('114500')), 'the failed export is retried');
  });

  it('can corroborate a propaganda-leaning report', () => {
    const csv = [gdeltRow({ id: '1', numSources: 3, url: 'https://a.example/1' }), gdeltRow({ id: '2', numSources: 1, url: 'https://b.example/2' })].join('\n');
    const out = strikes.deriveStrikeEvents([
      ...strikes.mapGdeltExportToStrikeCandidates(csv),
      candidate('sepah', cls(), 30 * MIN),
    ], NOW);
    assert.equal(out.length, 1);
    assert.match(out[0].id, /^tg:/);
  });
});

describe('incident integrity', () => {
  const gdelt = (row) => strikes.mapGdeltExportToStrikeCandidates(gdeltRow(row));

  it('a trusted report two hours earlier does not let a lone propaganda report publish a second event', () => {
    const official = candidate('PikudHaOref_all', cls({ place: 'Haifa', countryIso2: 'IL', kind: 'intercept', severity: 'elevated' }), 240 * MIN);
    const tasnim = candidate('TasnimNewsEN', cls({ place: 'Haifa', countryIso2: 'IL', kind: 'strike', severity: 'critical' }), 150 * MIN);
    const out = strikes.deriveStrikeEvents([official, tasnim], NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].sourceUrl, official.url);
    assert.equal(out[0].severity, 'elevated');
  });

  it('takes severity from trusted members, not from a propaganda report in the same incident', () => {
    const official = candidate('SaudiDCD', cls({ place: 'Riyadh', kind: 'intercept', severity: 'elevated' }), 20 * MIN);
    const sepah = candidate('sepah', cls({ place: 'Riyadh', kind: 'strike', severity: 'critical' }), 15 * MIN);
    assert.equal(strikes.deriveStrikeEvents([official, sepah], NOW)[0].severity, 'elevated');
  });

  it('caps a corroborated propaganda-only incident below critical', () => {
    const sepah = candidate('sepah', cls({ place: 'Abha', severity: 'critical' }), 20 * MIN);
    const clash = candidate('ClashReport', cls({ place: 'Abha', kind: 'claim', severity: 'elevated' }), 15 * MIN);
    assert.equal(strikes.deriveStrikeEvents([sepah, clash], NOW)[0].severity, 'high');
  });

  it('never emits two events with one id when GDELT precedes the Telegram reports', () => {
    const early = gdelt({ id: '1', fips: 'IS', lat: 32.81, lon: 35.0, numSources: 3, url: 'https://a.example/1', added: '20261019093100', fullName: 'Haifa, Haifa, Israel' });
    const out = strikes.deriveStrikeEvents([
      ...early,
      candidate('PikudHaOref_all', cls({ place: 'Haifa', countryIso2: 'IL', kind: 'intercept', severity: 'elevated' }), 120 * MIN),
      candidate('PikudHaOref_all', cls({ place: 'Haifa', countryIso2: 'IL', kind: 'intercept', severity: 'elevated' }), 118 * MIN),
    ], NOW);
    assert.equal(new Set(out.map((e) => e.id)).size, out.length, out.map((e) => e.id).join(', '));
    assert.equal(out.filter((e) => e.id.startsWith('tg:')).length, 1);
  });

  it('a word-for-word repost is one voice, not independent agreement', () => {
    const text = 'IRGC statement: our missiles struck military targets in Haifa';
    const a = candidate('RezistanceTrench1', cls({ place: 'Haifa', countryIso2: 'IL' }), 20 * MIN, text);
    const b = candidate('FotrosResistancee', cls({ place: 'Haifa', countryIso2: 'IL' }), 15 * MIN, text);
    assert.equal(strikes.deriveStrikeEvents([a, b], NOW).length, 0);
  });

  it('keeps a published GDELT incident that straddles two 30-minute buckets past the pending TTL', () => {
    const halves = [
      ...gdelt({ id: '1', numSources: 2, url: 'https://a.example/1', added: '20261019082500' }),
      ...gdelt({ id: '2', numSources: 1, url: 'https://b.example/2', added: '20261019083500' }),
    ];
    assert.equal(strikes.deriveStrikeEvents(halves, Date.parse('2026-10-19T09:00:00Z')).length, 1);
    const store = strikes.mergeCandidateStore(null, halves, NOW);
    assert.equal(store.candidates.length, 2);
    assert.equal(strikes.deriveStrikeEvents(store.candidates, NOW).length, 1);
  });

  it('keeps GDELT support for a stored propaganda report past the pending TTL', () => {
    const lone = gdelt({ id: '1', numSources: 3, url: 'https://a.example/1', added: '20261019080000' });
    const sepah = candidate('sepah', cls(), 230 * MIN);
    const store = strikes.mergeCandidateStore(null, [...lone, ...gdelt({ id: '2', url: 'https://b.example/2', added: '20261019083500' }), sepah], NOW);
    assert.equal(strikes.deriveStrikeEvents(store.candidates, NOW).length, 1);
  });

  it('labels GDELT events by distinct articles, not summed row mentions', () => {
    const csv = [gdeltRow({ id: '1', numSources: 5, url: 'https://a.example/1' }), gdeltRow({ id: '2', numSources: 4, url: 'https://b.example/2' })].join('\n');
    const [event] = strikes.deriveStrikeEvents(strikes.mapGdeltExportToStrikeCandidates(csv), NOW);
    assert.match(event.title, /\(2 articles\)$/);
  });
});

describe('extraction cycle', () => {
  function harness(overrides = {}) {
    const cache = new Map();
    const calls = [];
    const deps = {
      now: NOW,
      telegramItems: [],
      previousStore: null,
      readCache: async (key) => cache.get(key) ?? null,
      writeCache: async (key, value) => { cache.set(key, value); },
      classify: async (texts) => {
        calls.push(texts);
        return texts.map((_, i) => ({ i, isStrike: true, kind: 'strike', place: 'Jizan', countryIso2: 'SA', severity: 'high' }));
      },
      gdeltCandidates: [],
      telegramPolledAt: NOW - 2 * MIN,
      ...overrides,
    };
    return { deps, cache, calls };
  }

  it('classifies only pre-filtered posts, caches by text hash, and writes the window', async () => {
    const items = [
      post('SaudiDCD', 'سقوط مقذوف عسكري في جازان وإصابة شخصين'),
      post('ClashReport', 'Russian drone strike on Kharkiv'),
      post('ClashReport', 'Football: Al Hilal wins in Riyadh'),
    ];
    const { deps, calls, cache } = harness({ telegramItems: items });
    const first = await strikes.runStrikeCycle(deps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 1, 'only the Saudi strike post reaches the model');
    assert.equal(first.payload.events.length, 1);
    assert.equal(first.payload.events[0].locationName, 'Jizan');
    assert.equal(first.healthy, true);
    assert.ok([...cache.keys()].every((k) => /^conflict:iran-events:classify:v1:[0-9a-f]{16}$/.test(k)));

    const again = harness({ telegramItems: [{ ...items[0], id: 'saudidcd:99999' }], previousStore: first.store });
    for (const [k, v] of cache) again.cache.set(k, v);
    const second = await strikes.runStrikeCycle(again.deps);
    assert.equal(again.calls.length, 0, 'identical text is served from the classification cache');
    assert.equal(second.payload.events.length, 1, 'the repost dedupes into the same event');
  });

  it('reports unhealthy when Telegram stalls or the classifier fails, so seed-meta stops advancing', async () => {
    const stalled = await strikes.runStrikeCycle(harness({ telegramPolledAt: NOW - 3 * HOUR }).deps);
    assert.equal(stalled.healthy, false);
    const failing = await strikes.runStrikeCycle(harness({
      telegramItems: [post('SaudiDCD', 'Missile intercepted over Riyadh')],
      classify: async () => null,
    }).deps);
    assert.equal(failing.healthy, false);
    assert.equal(failing.pending.length, 1, 'unclassified posts are retried next cycle');
    const useless = await strikes.runStrikeCycle(harness({
      telegramItems: [post('SaudiDCD', 'Missile intercepted over Riyadh')],
      classify: async () => [],
    }).deps);
    assert.equal(useless.healthy, false, 'an answer with nothing usable is a classifier failure');
    const partial = await strikes.runStrikeCycle(harness({
      telegramItems: [post('SaudiDCD', 'Missile intercepted over Riyadh'), post('SaudiDCD', 'Drone debris fell in Jizan')],
      classify: async () => [{ i: 0, isStrike: true, kind: 'intercept', place: 'Riyadh', countryIso2: 'SA', severity: 'elevated' }],
    }).deps);
    assert.equal(partial.healthy, false, 'an unanswered post is not a healthy cycle');
    assert.equal(partial.pending.length, 1);
    let calls = 0;
    const many = Array.from({ length: 45 }, (_, i) => post('SaudiDCD', `Missile intercepted over Riyadh, wave ${i}`));
    const dead = await strikes.runStrikeCycle(harness({ telegramItems: many, classify: async () => { calls += 1; return null; } }).deps);
    assert.equal(calls, 1, 'a dead provider chain is not retried batch after batch inside one cycle');
    assert.equal(dead.pending.length, 45);
    const quiet = await strikes.runStrikeCycle(harness().deps);
    assert.equal(quiet.healthy, true, 'a quiet window with a live poll is healthy');
    assert.equal(quiet.payload.events.length, 0);
  });

  function publishHarness(overrides = {}) {
    const writes = { store: [], canonical: [], meta: [] };
    const deps = {
      now: NOW,
      pendingItems: [post('SaudiDCD', 'Missile intercepted over Riyadh')],
      readStore: async () => ({ ok: true, value: null }),
      writeStore: async (s) => { writes.store.push(s); return true; },
      writeCanonical: async (p, n) => { writes.canonical.push({ p, n }); return true; },
      writeSeedMeta: async (m) => { writes.meta.push(m); return true; },
      readCache: async () => null,
      writeCache: async () => {},
      classify: async (texts) => texts.map((_, i) => ({ i, isStrike: true, kind: 'intercept', place: 'Riyadh', countryIso2: 'SA', severity: 'elevated' })),
      loadGdelt: async (processed) => ({ candidates: [], processed, fetched: 0 }),
      telegramPolledAt: NOW - MIN,
      ...overrides,
    };
    return { deps, writes };
  }

  it('publishes canonical and seed-meta on a healthy cycle', async () => {
    const { deps, writes } = publishHarness();
    const out = await strikes.publishStrikeCycle(deps);
    assert.equal(out.status, 'ok');
    assert.equal(writes.canonical[0].n, 1);
    assert.deepEqual(writes.meta, [{ fetchedAt: NOW, recordCount: 1, sourceVersion: 'telegram-strikes-v1' }]);
    assert.deepEqual(out.doneIds, deps.pendingItems.map((i) => i.id));
  });

  it('skips the cycle entirely when the store read fails, so 72h of history is never overwritten', async () => {
    const { deps, writes } = publishHarness({ readStore: async () => ({ ok: false, value: null }) });
    const out = await strikes.publishStrikeCycle(deps);
    assert.equal(out.status, 'store-read-failed');
    assert.deepEqual([writes.store.length, writes.canonical.length, writes.meta.length], [0, 0, 0]);
  });

  it('keeps the data fresh but withholds seed-meta when Telegram stalls or the classifier dies', async () => {
    for (const overrides of [{ telegramPolledAt: NOW - 2 * HOUR }, { classify: async () => null }]) {
      const { deps, writes } = publishHarness(overrides);
      const out = await strikes.publishStrikeCycle(deps);
      assert.equal(out.status, 'degraded');
      assert.equal(writes.canonical.length, 1);
      assert.equal(writes.meta.length, 0, 'health must age into STALE_SEED');
    }
  });

  it('reports a failed seed-meta write instead of ok', async () => {
    const { deps } = publishHarness({ writeSeedMeta: async () => false });
    assert.equal((await strikes.publishStrikeCycle(deps)).status, 'write-failed');
  });

  it('withholds seed-meta and keeps posts pending when a Redis write fails', async () => {
    const { deps, writes } = publishHarness({ writeStore: async () => false });
    const out = await strikes.publishStrikeCycle(deps);
    assert.equal(out.status, 'write-failed');
    assert.equal(writes.meta.length, 0);
    assert.deepEqual(out.doneIds, [], 'unpersisted posts are offered again next cycle');
  });

  it('keeps previously stored candidates and GDELT exports across cycles', async () => {
    const { deps } = harness({ telegramItems: [post('SaudiDCD', 'Missile intercepted over Riyadh')] });
    const first = await strikes.runStrikeCycle(deps);
    const second = await strikes.runStrikeCycle(harness({ previousStore: first.store }).deps);
    assert.equal(second.payload.events.length, 1);
    assert.equal(second.payload.scrapedAt, NOW);
  });
});

describe('strike pressure tally (conflict:strike-pressure:v1)', () => {
  const DAY = 24 * HOUR;
  const ev = (id, countryCode, severity, ageMs, extra = {}) => ({
    id, countryCode, severity, timestamp: NOW - ageMs, title: id, category: 'airstrike', ...extra,
  });
  const window = [
    ev('tg:SA:SA:riyadh:1', 'SA', 'high', 2 * HOUR),
    ev('tg:SA:SA:najran:2', 'SA', 'elevated', 3 * HOUR),
    ev('tg:SA:SA:jizan:3', 'SA', 'critical', 30 * HOUR),
    ev('gdelt:YE:YE:sanaa:4', 'YE', 'moderate', 5 * HOUR),
  ];

  it('tallies published events per country, UTC day of the event and severity', () => {
    const out = strikes.mergeStrikePressure(null, window, NOW);
    assert.equal(out.version, 1);
    assert.equal(out.updatedAt, NOW);
    // [critical, high, elevated, moderate]
    assert.deepEqual(out.days['2026-10-19'], { SA: [0, 1, 1, 0], YE: [0, 0, 0, 1] });
    assert.deepEqual(out.days['2026-10-18'], { SA: [1, 0, 0, 0] });
  });

  it('never counts an event twice when the 72h window is republished every cycle', () => {
    let state = strikes.mergeStrikePressure(null, window, NOW);
    for (let i = 1; i <= 5; i++) state = strikes.mergeStrikePressure(state, window, NOW + i * 10 * MIN);
    assert.deepEqual(state.days['2026-10-19'], { SA: [0, 1, 1, 0], YE: [0, 0, 0, 1] });
    assert.deepEqual(state.days['2026-10-18'], { SA: [1, 0, 0, 0] });
  });

  // Event ids are not stable across cycles: an id carries the 30-minute bucket
  // of its session's first report, and sessions re-partition when a late post
  // with an earlier timestamp arrives or the oldest post leaves the window.
  // The tally must count what the window shows, not every id it ever saw.
  const at = Date.parse('2026-10-15T10:00:00Z');
  const riyadh = (id, ts) => ({
    id, src: 'telegram', cls: 'official', kind: 'strike', severity: 'high', iso2: 'SA', placeKey: 'riyadh',
    place: 'Riyadh', lat: 24.7, lon: 46.7, ts, title: id, url: '', handle: 'h', group: 'g',
  });

  it('does not count a re-partitioned incident twice when a late report with an earlier time arrives', () => {
    const cands = [riyadh('a', at + 10 * MIN), riyadh('b', at + 35 * MIN)];
    const first = strikes.deriveStrikeEvents(cands, at + 2 * HOUR);
    assert.equal(first.length, 1);
    let state = strikes.mergeStrikePressure(null, first, at + 2 * HOUR);
    const late = strikes.deriveStrikeEvents([...cands, riyadh('z', at - 15 * MIN)], at + 2 * HOUR + 10 * MIN);
    assert.equal(late.length, 2, 'the late post splits the incident into two sessions');
    state = strikes.mergeStrikePressure(state, late, at + 2 * HOUR + 10 * MIN);
    assert.deepEqual(state.days['2026-10-15'], { SA: [0, 2, 0, 0] });
  });

  it('does not count an incident again when its first report leaves the 72h window and its id moves', () => {
    const cands = [riyadh('a', at + 25 * MIN), riyadh('b', at + 40 * MIN), riyadh('c', at + 60 * MIN)];
    let state = null;
    for (const now of [at + 2 * HOUR, at + 72 * HOUR + 26 * MIN, at + 72 * HOUR + 41 * MIN]) {
      state = strikes.mergeStrikePressure(state, strikes.deriveStrikeEvents(cands, now), now);
    }
    assert.deepEqual(state.days['2026-10-15'], { SA: [0, 2, 0, 0] });
  });

  it('does not move an incident to the next day when its first report, just before midnight, leaves the window', () => {
    // 23:55 and 00:10 form one incident dated 23:55; at 72h the 23:55 report
    // leaves and the 00:10 report alone would be re-dated to the next day.
    const midnight = Date.parse('2026-10-16T00:00:00Z');
    const cands = [riyadh('a', midnight - 5 * MIN), riyadh('b', midnight + 10 * MIN)];
    let state = null;
    for (const now of [midnight + 2 * HOUR, midnight - 5 * MIN + 72 * HOUR + MIN, midnight - 5 * MIN + 72 * HOUR + 11 * MIN]) {
      state = strikes.mergeStrikePressure(state, strikes.deriveStrikeEvents(cands, now), now);
    }
    assert.deepEqual(state.days, { '2026-10-15': { SA: [0, 1, 0, 0] } });
  });

  it('moves an event to its higher severity when later reports raise it, and never lowers it', () => {
    const first = strikes.mergeStrikePressure(null, [ev('tg:SA:SA:riyadh:1', 'SA', 'elevated', HOUR)], NOW);
    const raised = strikes.mergeStrikePressure(first, [ev('tg:SA:SA:riyadh:1', 'SA', 'critical', HOUR)], NOW);
    assert.deepEqual(raised.days['2026-10-19'], { SA: [1, 0, 0, 0] });
    const lowered = strikes.mergeStrikePressure(raised, [ev('tg:SA:SA:riyadh:1', 'SA', 'high', HOUR)], NOW);
    assert.deepEqual(lowered.days['2026-10-19'], { SA: [1, 0, 0, 0] });
  });

  it('keeps 30 days of tallies after the events leave the 72h window, then drops the oldest day', () => {
    let state = strikes.mergeStrikePressure(null, window, NOW);
    // Ten days on, the window holds none of these events; the tallies stay.
    state = strikes.mergeStrikePressure(state, [], NOW + 10 * DAY);
    assert.deepEqual(state.days['2026-10-19'], { SA: [0, 1, 1, 0], YE: [0, 0, 0, 1] });
    state = strikes.mergeStrikePressure(state, [], NOW + 30 * DAY);
    assert.equal(state.days['2026-10-19'], undefined);
    assert.equal(state.days['2026-10-18'], undefined);
  });

  it('ignores events it cannot place: no country, unknown severity, future or ancient timestamps', () => {
    const out = strikes.mergeStrikePressure(null, [
      ev('a', 'Saudi', 'high', HOUR),
      ev('b', 'SA', 'catastrophic', HOUR),
      ev('c', 'SA', 'high', -2 * HOUR),
      ev('d', 'SA', 'high', 40 * DAY),
      { ...ev('e', 'SA', 'high', HOUR), timestamp: 'yesterday' },
      ev('', 'SA', 'high', HOUR),
      null,
    ], NOW);
    assert.deepEqual(out.days, {});
  });

  it('survives a malformed stored snapshot without throwing or keeping garbage', () => {
    const out = strikes.mergeStrikePressure({ days: { 'not-a-date': { SA: [1, 0, 0, 0] }, '2026-10-18': { SA: 'x', YE: [0, 1, 0, 0] } }, events: [] }, [], NOW);
    assert.deepEqual(out.days, { '2026-10-18': { YE: [0, 1, 0, 0] } });
  });

  function pressureHarness(overrides = {}) {
    const writes = { store: [], canonical: [], meta: [], pressure: [], pressureMeta: [] };
    const deps = {
      now: NOW,
      pendingItems: [post('SaudiDCD', 'Missile intercepted over Riyadh')],
      readStore: async () => ({ ok: true, value: null }),
      writeStore: async (s) => { writes.store.push(s); return true; },
      writeCanonical: async (p, n) => { writes.canonical.push({ p, n }); return true; },
      writeSeedMeta: async (m) => { writes.meta.push(m); return true; },
      readCache: async () => null,
      writeCache: async () => {},
      classify: async (texts) => texts.map((_, i) => ({ i, isStrike: true, kind: 'intercept', place: 'Riyadh', countryIso2: 'SA', severity: 'elevated' })),
      loadGdelt: async (processed) => ({ candidates: [], processed, fetched: 0 }),
      telegramPolledAt: NOW - MIN,
      readPressure: async () => ({ ok: true, value: null }),
      writePressure: async (p) => { writes.pressure.push(p); return true; },
      writePressureMeta: async (m) => { writes.pressureMeta.push(m); return true; },
      ...overrides,
    };
    return { deps, writes };
  }

  it('adds each published window to the tally and advances its seed-meta on a healthy cycle', async () => {
    const { deps, writes } = pressureHarness();
    const out = await strikes.publishStrikeCycle(deps);
    assert.equal(out.status, 'ok');
    assert.equal(out.pressureStatus, 'ok');
    assert.deepEqual(writes.pressure[0].days['2026-10-19'], { SA: [0, 0, 1, 0] });
    assert.deepEqual(writes.pressureMeta, [{ fetchedAt: NOW, recordCount: 1, sourceVersion: 'strike-pressure-v1' }]);
  });

  it('never overwrites 30 days of tallies after a failed read, and keeps the feed publishing', async () => {
    const { deps, writes } = pressureHarness({ readPressure: async () => ({ ok: false, value: null }) });
    const out = await strikes.publishStrikeCycle(deps);
    assert.equal(out.status, 'ok', 'the strike feed itself is unaffected');
    assert.equal(out.pressureStatus, 'read-failed');
    assert.deepEqual([writes.pressure.length, writes.pressureMeta.length], [0, 0]);
  });

  it('records the events of a degraded cycle but withholds the tally seed-meta', async () => {
    const { deps, writes } = pressureHarness({ telegramPolledAt: NOW - 2 * HOUR });
    const out = await strikes.publishStrikeCycle(deps);
    assert.equal(out.status, 'degraded');
    assert.equal(out.pressureStatus, 'degraded');
    assert.equal(writes.pressure.length, 1);
    assert.equal(writes.pressureMeta.length, 0);
  });

  it('does not touch the tally when the canonical window was not written', async () => {
    const { deps, writes } = pressureHarness({ writeCanonical: async () => false });
    const out = await strikes.publishStrikeCycle(deps);
    assert.equal(out.status, 'write-failed');
    assert.equal(out.pressureStatus, 'skipped');
    assert.equal(writes.pressure.length, 0);
  });

  it('reports a failed tally write without failing the feed', async () => {
    const { deps, writes } = pressureHarness({ writePressure: async () => false });
    const out = await strikes.publishStrikeCycle(deps);
    assert.equal(out.status, 'ok');
    assert.equal(out.pressureStatus, 'write-failed');
    assert.equal(writes.pressureMeta.length, 0);
  });
});
