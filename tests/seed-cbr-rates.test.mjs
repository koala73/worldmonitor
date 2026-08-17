// Bank of Russia (cbr.ru) seeder parsers — issue #6154.
//
// Two upstream properties silently corrupt this feed if the parser assumes the
// defaults every other seeder in this repo gets away with. Both are locked here
// because neither produces an error, a null, or an out-of-range number — they
// produce a plausible wrong answer that renders fine on a chart:
//
//   1. `Content-Type: application/xml; charset=windows-1251`. `Response.text()`
//      decodes as UTF-8, so every Cyrillic currency name comes back as U+FFFD
//      mojibake while the ASCII numbers survive intact — the payload looks
//      healthy and validate() passes.
//   2. `<Value>81,1291</Value>` — decimal COMMA. `parseFloat('81,1291')` returns
//      81, silently dropping the fraction (a 0.16% error on this sample). A test
//      written against a dot-decimal fixture cannot see this, so every numeric
//      fixture below uses commas.
//
// A third, quieter one: rates are quoted per `<Nominal>` units (JPY per 100,
// UZS per 10 000), so the per-unit rate is Value / Nominal, not Value.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCbrPayload,
  cbrContentMeta,
  cbrDateToIso,
  decodeCbrXml,
  fetchCbrRates,
  isoToCbrDateReq,
  MIN_RATE_COUNT,
  parseCbrDecimal,
  parseDailyRates,
  parseKeyRateSoap,
  previousIsoDate,
  validateCbrPayload,
} from '../scripts/seed-cbr-rates.mjs';
import { DAY_MIN } from '../scripts/_content-age-helpers.mjs';

// ─── windows-1251 fixtures ─────────────────────────────────────────────────────
//
// Cyrillic is written as explicit cp1251 code units so the fixture is a real
// byte sequence rather than a re-encoded copy of whatever this file is saved as.
// Expected strings are escaped code points for the same reason.

/** cp1251 bytes for "Доллар США" (Dollar SShA). */
const USD_NAME_CP1251 = [0xc4, 0xee, 0xeb, 0xeb, 0xe0, 0xf0, 0x20, 0xd1, 0xd8, 0xc0];
const USD_NAME_UNICODE = 'Доллар США';

/** cp1251 bytes for "Иен" (Ien — the CBR label for the JPY row). */
const JPY_NAME_CP1251 = [0xc8, 0xe5, 0xed];
const JPY_NAME_UNICODE = 'Иен';

/** cp1251 bytes for "Узбекских сумов" (Uzbekskikh sumov). */
const UZS_NAME_CP1251 = [
  0xd3, 0xe7, 0xe1, 0xe5, 0xea, 0xf1, 0xea, 0xe8, 0xf5, 0x20, 0xf1, 0xf3, 0xec, 0xee, 0xe2,
];
const UZS_NAME_UNICODE = 'Узбекских сумов';

/** Splice ASCII markup and cp1251 name bytes into one buffer, like the wire. */
function cp1251Bytes(...parts) {
  return Buffer.concat(
    parts.map((p) => (Array.isArray(p) ? Buffer.from(p) : Buffer.from(p, 'ascii'))),
  );
}

/**
 * A three-currency XML_daily.asp response, byte-identical in shape to the live
 * one probed on 2026-08-04 (Nominal 1 / 100 / 10000, decimal commas, DD.MM.YYYY).
 */
function dailyFixtureBytes({ date = '05.08.2026', usdValue = '81,1291' } = {}) {
  return cp1251Bytes(
    '<?xml version="1.0" encoding="windows-1251"?>',
    `<ValCurs Date="${date}" name="Foreign Currency Market">`,
    '<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>',
    USD_NAME_CP1251,
    `</Name><Value>${usdValue}</Value><VunitRate>${usdValue}</VunitRate></Valute>`,
    '<Valute ID="R01820"><NumCode>392</NumCode><CharCode>JPY</CharCode><Nominal>100</Nominal><Name>',
    JPY_NAME_CP1251,
    '</Name><Value>51,5171</Value><VunitRate>0,515171</VunitRate></Valute>',
    '<Valute ID="R01717"><NumCode>860</NumCode><CharCode>UZS</CharCode><Nominal>10000</Nominal><Name>',
    UZS_NAME_CP1251,
    '</Name><Value>67,9347</Value><VunitRate>0,00679347</VunitRate></Valute>',
    '</ValCurs>',
  );
}

/**
 * A rate table with `count` distinct currencies, for the validation floor.
 * Codes are synthetic (AAA, AAB, ...) — only the cardinality matters here.
 */
function syntheticRates(count) {
  const rates = {};
  for (let i = 0; i < count; i++) {
    const code = `A${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
    rates[code] = { rate: 1 + i / 100, value: 1 + i / 100, nominal: 1, name: '', numCode: '', id: '', change1d: null };
  }
  return rates;
}

/** A KeyRate SOAP response (this endpoint is UTF-8 and uses DOT decimals). */
const KEY_RATE_SOAP = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><KeyRateResponse xmlns="http://web.cbr.ru/"><KeyRateResult><diffgr:diffgram xmlns:msdata="urn:schemas-microsoft-com:xml-msdata" xmlns:diffgr="urn:schemas-microsoft-com:xml-diffgram-v1"><KeyRate xmlns="">
<KR diffgr:id="KR1" msdata:rowOrder="0"><DT>2026-08-04T00:00:00+03:00</DT><Rate>14.00</Rate></KR>
<KR diffgr:id="KR2" msdata:rowOrder="1"><DT>2026-08-03T00:00:00+03:00</DT><Rate>14.00</Rate></KR>
<KR diffgr:id="KR3" msdata:rowOrder="2"><DT>2026-07-31T00:00:00+03:00</DT><Rate>14.00</Rate></KR>
<KR diffgr:id="KR4" msdata:rowOrder="3"><DT>2026-07-27T00:00:00+03:00</DT><Rate>14.00</Rate></KR>
<KR diffgr:id="KR5" msdata:rowOrder="4"><DT>2026-07-24T00:00:00+03:00</DT><Rate>14.25</Rate></KR>
<KR diffgr:id="KR6" msdata:rowOrder="5"><DT>2026-07-23T00:00:00+03:00</DT><Rate>14.25</Rate></KR>
</KeyRate></diffgr:diffgram></KeyRateResult></KeyRateResponse></soap:Body></soap:Envelope>`;

// ─── 1. windows-1251 decoding ──────────────────────────────────────────────────

test('decodeCbrXml decodes windows-1251 bytes to the correct Cyrillic name', () => {
  const xml = decodeCbrXml(dailyFixtureBytes());
  assert.ok(xml.includes(USD_NAME_UNICODE), `expected the decoded name in: ${xml.slice(0, 200)}`);
  assert.ok(!xml.includes('�'), 'no replacement characters after a correct decode');
});

test('the same bytes decoded as UTF-8 mojibake — the reason decodeCbrXml exists', () => {
  // Guards the fix itself: if someone "simplifies" decodeCbrXml back to
  // res.text() / a default TextDecoder, THIS is what the payload would carry.
  const asUtf8 = new TextDecoder().decode(dailyFixtureBytes());
  assert.ok(asUtf8.includes('�'), 'cp1251 name bytes are not valid UTF-8');
  assert.ok(!asUtf8.includes(USD_NAME_UNICODE), 'UTF-8 decoding must NOT recover the name');
  // …and the numbers survive regardless, which is exactly why nothing downstream
  // notices: validate() passes on a payload whose names are all garbage.
  assert.ok(asUtf8.includes('81,1291'));
});

test('decodeCbrXml accepts an ArrayBuffer (what Response.arrayBuffer() returns)', () => {
  const buf = dailyFixtureBytes();
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  assert.ok(decodeCbrXml(ab).includes(USD_NAME_UNICODE));
});

// ─── 2. decimal comma ──────────────────────────────────────────────────────────

test('parseCbrDecimal keeps the fraction that parseFloat silently drops', () => {
  assert.equal(parseCbrDecimal('81,1291'), 81.1291);
  // The mutation this test exists to kill: parseFloat('81,1291') === 81.
  assert.notEqual(parseCbrDecimal('81,1291'), 81);
  assert.equal(parseCbrDecimal('0,00679347'), 0.00679347);
  assert.equal(parseCbrDecimal('56,9445'), 56.9445);
});

test('parseCbrDecimal also handles the dot decimals the SOAP endpoint returns', () => {
  assert.equal(parseCbrDecimal('14.00'), 14);
  assert.equal(parseCbrDecimal('14.25'), 14.25);
});

test('parseCbrDecimal rejects anything that is not a single clean number', () => {
  for (const bad of ['', '   ', 'n/a', '1,2,3', '1.2.3', '81,1291abc', null, undefined, {}, NaN]) {
    assert.equal(parseCbrDecimal(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ─── 3. Nominal ────────────────────────────────────────────────────────────────

test('parseDailyRates divides by Nominal instead of publishing the block price', () => {
  const { rates } = parseDailyRates(decodeCbrXml(dailyFixtureBytes()));

  assert.equal(rates.USD.rate, 81.1291);
  assert.equal(rates.USD.nominal, 1);

  // JPY is quoted per 100 units: 51.5171 RUB per 100 JPY.
  assert.equal(rates.JPY.nominal, 100);
  assert.equal(rates.JPY.valuePerNominal, 51.5171);
  assert.equal(rates.JPY.rate, 0.515171);
  assert.notEqual(rates.JPY.rate, 51.5171, 'publishing Value as the per-unit rate is a 100x error');

  // UZS is quoted per 10 000 — the same bug at 10 000x.
  assert.equal(rates.UZS.nominal, 10000);
  assert.equal(rates.UZS.rate, 0.00679347);
});

test('parseDailyRates carries the decoded name, numCode and CBR date', () => {
  const { date, rates } = parseDailyRates(decodeCbrXml(dailyFixtureBytes()));
  assert.equal(date, '2026-08-05', 'DD.MM.YYYY is reordered to ISO, not passed through');
  assert.equal(rates.USD.name, USD_NAME_UNICODE);
  assert.equal(rates.JPY.name, JPY_NAME_UNICODE);
  assert.equal(rates.UZS.name, UZS_NAME_UNICODE);
  assert.equal(rates.USD.numCode, '840');
  assert.equal(rates.UZS.numCode, '860');
});

test('parseDailyRates drops rows whose value or nominal is unusable', () => {
  const broken = cp1251Bytes(
    '<?xml version="1.0" encoding="windows-1251"?>',
    '<ValCurs Date="05.08.2026" name="Foreign Currency Market">',
    '<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>',
    USD_NAME_CP1251,
    '</Name><Value>81,1291</Value></Valute>',
    '<Valute ID="R09999"><NumCode>999</NumCode><CharCode>BAD</CharCode><Nominal>0</Nominal><Name>x</Name><Value>1,0</Value></Valute>',
    '<Valute ID="R09998"><NumCode>998</NumCode><CharCode>NAN</CharCode><Nominal>1</Nominal><Name>x</Name><Value>n/a</Value></Valute>',
    '<Valute ID="R09997"><NumCode>997</NumCode><CharCode>NEG</CharCode><Nominal>1</Nominal><Name>x</Name><Value>-3,5</Value></Valute>',
    '</ValCurs>',
  );
  const { rates } = parseDailyRates(decodeCbrXml(broken));
  assert.deepEqual(Object.keys(rates), ['USD']);
});

test('parseDailyRates handles a single-Valute document (not an array)', () => {
  const single = cp1251Bytes(
    '<?xml version="1.0" encoding="windows-1251"?>',
    '<ValCurs Date="05.08.2026" name="Foreign Currency Market">',
    '<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal><Name>',
    USD_NAME_CP1251,
    '</Name><Value>81,1291</Value></Valute></ValCurs>',
  );
  const { rates } = parseDailyRates(decodeCbrXml(single));
  assert.equal(rates.USD.rate, 81.1291);
});

test('cbrDateToIso reorders DD.MM.YYYY and rejects anything else', () => {
  assert.equal(cbrDateToIso('05.08.2026'), '2026-08-05');
  assert.equal(cbrDateToIso('31.12.2025'), '2025-12-31');
  // A naive Date.parse('05.08.2026') reads this as MAY 8 in some runtimes; the
  // day/month swap is invisible for the first 12 days of every month.
  assert.notEqual(cbrDateToIso('05.08.2026'), '2026-05-08');
  for (const bad of ['2026-08-05', '5.8.2026', '', null, undefined]) {
    assert.equal(cbrDateToIso(bad), null);
  }
});

// ─── 4. key rate ───────────────────────────────────────────────────────────────

test('parseKeyRateSoap returns ascending observations from a newest-first response', () => {
  const obs = parseKeyRateSoap(KEY_RATE_SOAP);
  assert.equal(obs.length, 6);
  assert.deepEqual(obs.map((o) => o.date), [
    '2026-07-23', '2026-07-24', '2026-07-27', '2026-07-31', '2026-08-03', '2026-08-04',
  ]);
  assert.equal(obs.at(-1).value, 14);
  assert.equal(obs[0].value, 14.25);
});

test('parseKeyRateSoap truncates the +03:00 timestamp to the Moscow calendar date', () => {
  // DT is midnight Moscow time. Naively taking the UTC date would shift every
  // observation back one day (2026-08-04T00:00+03:00 === 2026-08-03T21:00Z).
  const obs = parseKeyRateSoap(KEY_RATE_SOAP);
  assert.equal(obs.at(-1).date, '2026-08-04');
});

test('parseKeyRateSoap returns an empty list for an empty or malformed envelope', () => {
  assert.deepEqual(parseKeyRateSoap('<soap:Envelope/>'), []);
  assert.deepEqual(parseKeyRateSoap('not xml at all <<<'), []);
  assert.deepEqual(parseKeyRateSoap(''), []);
});

test('buildCbrPayload summarises the key-rate path, not just the spot value', () => {
  const payload = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });

  assert.equal(payload.keyRate.rate, 14);
  assert.equal(payload.keyRate.observedAt, '2026-08-04');
  assert.equal(payload.keyRate.previousRate, 14.25);
  // The cut landed on 2026-07-27 — the FIRST day at the current rate, not the
  // last day at the old one, and not the newest observation.
  assert.equal(payload.keyRate.changedAt, '2026-07-27');
  assert.equal(payload.keyRate.previousObservedAt, '2026-07-24');
  assert.equal(payload.keyRate.change, -0.25);

  // CBR repeats the same rate on every business day between decisions, so the
  // series is run-length encoded to its steps. 6 observations, 2 levels.
  assert.equal(payload.keyRate.observationCount, 6);
  assert.deepEqual(payload.keyRate.windowStart, { date: '2026-07-23', rate: 14.25 });
  assert.deepEqual(payload.keyRate.changes, [{ date: '2026-07-27', rate: 14 }]);
});

test('buildCbrPayload reports no prior rate when the whole window is flat', () => {
  const flat = parseKeyRateSoap(KEY_RATE_SOAP).filter((o) => o.value === 14);
  const payload = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: flat,
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });
  assert.equal(payload.keyRate.rate, 14);
  assert.equal(payload.keyRate.previousRate, null);
  assert.equal(payload.keyRate.change, null);
  // changedAt is only known to be "at or before the oldest observation we have",
  // so it must not claim the start of the window as a policy change.
  assert.equal(payload.keyRate.changedAt, null);
  // The single path entry is the window's left edge for the same reason.
  assert.deepEqual(payload.keyRate.windowStart, { date: '2026-07-27', rate: 14 });
  assert.deepEqual(payload.keyRate.changes, [], 'a flat window has NO observed transitions');
});

// ─── 5. change1d ───────────────────────────────────────────────────────────────

test('buildCbrPayload computes change1d against the previous business day', () => {
  const payload = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: parseDailyRates(decodeCbrXml(dailyFixtureBytes({ date: '04.08.2026', usdValue: '80,1291' }))),
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });
  assert.equal(payload.previousDate, '2026-08-04');
  assert.equal(payload.previousEffectiveDate, '2026-08-04');
  assert.equal(payload.rates.USD.change1d, 1);
  assert.equal(payload.rates.JPY.change1d, 0, 'unchanged pairs report a real zero');
});

test('buildCbrPayload separates the requested comparison day from CBR effective date', () => {
  // cbr.ru answers date_req with the table IN FORCE on that day, stamped with the
  // day it took effect: asking for 2026-08-03 (a Monday after a weekend) returns
  // Date="01.08.2026". Reporting only the effective date makes a true one-day
  // delta read as a three-day move.
  const payload = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes({ date: '04.08.2026' }))),
    previousDaily: parseDailyRates(decodeCbrXml(dailyFixtureBytes({ date: '01.08.2026', usdValue: '80,1291' }))),
    previousRequestedDate: '2026-08-03',
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });
  assert.equal(payload.previousDate, '2026-08-03', 'the day we asked for');
  assert.equal(payload.previousEffectiveDate, '2026-08-01', 'the day CBR stamped on the answer');
});

test('buildCbrPayload states the quote direction instead of leaving it to convention', () => {
  // `base: 'RUB'` would read, under the usual base/quote convention, as "units of
  // X per 1 RUB" — the inverse of these numbers. A consumer that guesses wrong
  // inverts USD by a factor of ~6600.
  const payload = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });
  assert.equal(payload.quoteCurrency, 'RUB');
  assert.match(payload.rateUnit, /RUB per 1 unit/);
  assert.equal(payload.base, undefined, 'the ambiguous field must not come back');
  assert.equal(payload.rates.USD.rate, 81.1291, 'RUB per 1 USD, matching rateUnit');
});

test('buildCbrPayload reports change1d as null when the prior day is unavailable', () => {
  const payload = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });
  assert.equal(payload.previousDate, null);
  assert.equal(payload.previousEffectiveDate, null);
  // null, never 0 — a best-effort fetch that failed must not render as "flat".
  assert.equal(payload.rates.USD.change1d, null);
});

// ─── 6. content age ────────────────────────────────────────────────────────────

test('cbrContentMeta ignores the next-day FX date and clocks off the key rate', () => {
  // CBR publishes TOMORROW's official rate: on 2026-08-04 the document is dated
  // 2026-08-05. tokensToContentMeta drops tokens >1h in the future, so an
  // FX-date-only contract would collapse to null (= instant STALE_CONTENT)
  // every evening. The key-rate series is always dated in the past.
  const payload = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });
  const meta = cbrContentMeta(payload, Date.parse('2026-08-04T20:00:00Z'));
  assert.ok(meta, 'content meta must not be null while the feed is live');
  assert.equal(meta.newestItemAt, Date.parse('2026-08-04T00:00:00Z'));
  assert.equal(meta.oldestItemAt, Date.parse('2026-07-23T00:00:00Z'));
});

test('cbrContentMeta reports the OLDER of the two clocks when both are current', () => {
  // Both halves must be current for the payload to read as fresh, so the FX date
  // — dated a day ahead — never pulls the verdict forward past the key rate.
  const payload = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-05T09:00:00Z'),
  });
  const now = Date.parse('2026-08-05T09:00:00Z');
  const meta = cbrContentMeta(payload, now);
  assert.equal(meta.newestItemAt, Date.parse('2026-08-04T00:00:00Z'), 'the key-rate clock is the older one');
  assert.ok((now - meta.newestItemAt) / 60000 < 14 * DAY_MIN, 'a live feed still reads as fresh');
});

test('cbrContentMeta stays fresh while the key rate is merely on hold', () => {
  // The rate last MOVED eight months ago but CBR is still publishing daily.
  // Clocking off the newest step instead of the newest observation would report
  // eight-month-old content and fire STALE_CONTENT on a perfectly live feed.
  const onHold = {
    effectiveDate: '2026-08-05',
    keyRate: { observedAt: '2026-08-04', changes: [{ date: '2025-12-15', rate: 14 }] },
  };
  const now = Date.parse('2026-08-04T20:00:00Z');
  const meta = cbrContentMeta(onHold, now);
  assert.equal(meta.newestItemAt, Date.parse('2026-08-04T00:00:00Z'));
  assert.ok((now - meta.newestItemAt) / 60000 < 14 * DAY_MIN);
});

test('cbrContentMeta goes stale when both upstreams freeze', () => {
  const frozen = {
    effectiveDate: '2026-06-01',
    keyRate: { observedAt: '2026-05-29', changes: [{ date: '2026-05-29', rate: 14 }] },
  };
  const now = Date.parse('2026-08-04T20:00:00Z');
  const meta = cbrContentMeta(frozen, now);
  const ageMin = (now - meta.newestItemAt) / 60000;
  assert.ok(ageMin > 14 * DAY_MIN, `a 64-day-old feed must exceed the 14-day budget (got ${ageMin}min)`);
});

test('cbrContentMeta reports a FROZEN FX table even while the key rate publishes daily', () => {
  // The two halves come from independent cbr.ru services and either can freeze
  // alone. Reducing both sets of dates with one max() would let the live series
  // hide the dead one, so the alarm could only fire when BOTH died at once.
  const now = Date.parse('2026-08-04T20:00:00Z');
  const meta = cbrContentMeta({
    effectiveDate: '2026-06-01',
    keyRate: { observedAt: '2026-08-04', changes: [{ date: '2026-07-27', rate: 14 }] },
  }, now);
  assert.equal(meta.newestItemAt, Date.parse('2026-06-01T00:00:00Z'));
  assert.ok((now - meta.newestItemAt) / 60000 > 14 * DAY_MIN, 'a frozen FX table must trip the budget');
});

test('cbrContentMeta reports a FROZEN key rate even while the FX table advances daily', () => {
  const now = Date.parse('2026-08-04T20:00:00Z');
  const meta = cbrContentMeta({
    effectiveDate: '2026-08-05',
    keyRate: { observedAt: '2026-06-01', changes: [{ date: '2026-05-01', rate: 14 }] },
  }, now);
  assert.equal(meta.newestItemAt, Date.parse('2026-06-01T00:00:00Z'));
  assert.ok((now - meta.newestItemAt) / 60000 > 14 * DAY_MIN, 'a frozen key rate must trip the budget');
});

test('cbrContentMeta fails closed when either clock is missing entirely', () => {
  const now = Date.parse('2026-08-04T20:00:00Z');
  assert.equal(cbrContentMeta({ effectiveDate: null, keyRate: { observedAt: '2026-08-04', changes: [] } }, now), null);
  assert.equal(cbrContentMeta({ effectiveDate: '2026-08-05', keyRate: null }, now), null);
  assert.equal(cbrContentMeta({ date: '2026-08-05', keyRate: { date: null, changes: [] } }, now), null);
  assert.equal(cbrContentMeta(null, now), null);
});

test('cbrContentMeta never reports a future newestItemAt', () => {
  // /api/health treats a negative content age as stale, and tokensToContentMeta
  // accepts tokens up to an hour ahead — so an unclamped next-day FX date would
  // fire a false STALE_CONTENT in the last hour of every UTC day.
  const now = Date.parse('2026-08-04T23:30:00Z');
  const meta = cbrContentMeta({
    effectiveDate: '2026-08-05',
    keyRate: { observedAt: '2026-08-04', changes: [{ date: '2026-07-27', rate: 14 }] },
  }, now);
  assert.ok(meta.newestItemAt <= now, `newestItemAt ${meta.newestItemAt} must not exceed now ${now}`);
});

// ─── 7. fail-closed validation ─────────────────────────────────────────────────

/** A payload that passes validation: full-size rate table + a live key rate. */
function publishablePayload(overrides = {}) {
  const payload = buildCbrPayload({
    daily: { date: '2026-08-05', rates: syntheticRates(MIN_RATE_COUNT) },
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });
  return { ...payload, ...overrides };
}

test('validateCbrPayload accepts a full-size table with a live key rate', () => {
  assert.equal(validateCbrPayload(publishablePayload()), true);
});

test('validateCbrPayload rejects a payload whose key rate went missing', () => {
  const good = publishablePayload();
  // The key rate is half of what this seeder exists to publish. Letting a
  // keyRate-less payload through would overwrite last-good with a silently
  // half-empty document while /api/health stayed green.
  assert.equal(validateCbrPayload({ ...good, keyRate: null }), false);
  assert.equal(validateCbrPayload({ ...good, keyRate: { ...good.keyRate, rate: null } }), false);
});

test('validateCbrPayload rejects a truncated table that still parses cleanly', () => {
  // The failure this floor exists for: a cbr.ru body cut short by ddos-guard, a
  // proxy, or a reset connection is still well-formed XML for the rows that did
  // arrive. A floor of 3 would publish 4 currencies over a healthy 54 with every
  // monitoring surface green, because nothing downstream counts rows.
  assert.equal(validateCbrPayload(publishablePayload()), true);
  assert.equal(
    validateCbrPayload({ ...publishablePayload(), rates: syntheticRates(MIN_RATE_COUNT - 1) }),
    false,
    'one currency below the floor must not publish',
  );
  assert.equal(validateCbrPayload({ ...publishablePayload(), rates: syntheticRates(4) }), false);
  assert.equal(validateCbrPayload({ ...publishablePayload(), rates: {} }), false);
  assert.equal(validateCbrPayload(null), false);
  // The floor must stay well under CBR's real cohort (54 as of 2026-08) so a
  // retired currency or two cannot wedge the seeder into never publishing.
  assert.ok(MIN_RATE_COUNT >= 10 && MIN_RATE_COUNT <= 50, `implausible floor: ${MIN_RATE_COUNT}`);
});

test('validateCbrPayload rejects a table whose COUNT is fine but whose rates are not', () => {
  // Mutation guard: without this, deleting the per-currency `rate > 0` predicate
  // and returning true would not turn a single test red — every other case is
  // decided by the count guard alone.
  const rates = syntheticRates(MIN_RATE_COUNT);
  const [firstCode] = Object.keys(rates);
  for (const bad of [0, -1, Number.NaN, null, undefined]) {
    const broken = { ...rates, [firstCode]: { ...rates[firstCode], rate: bad } };
    assert.equal(
      validateCbrPayload({ ...publishablePayload(), rates: broken }),
      false,
      `rate ${JSON.stringify(bad)} must fail validation`,
    );
  }
});

test('validateCbrPayload rejects a payload with no usable CBR date', () => {
  assert.equal(validateCbrPayload({ ...publishablePayload(), effectiveDate: null }), false);
  assert.equal(validateCbrPayload({ ...publishablePayload(), effectiveDate: '' }), false);
});

// ─── 8. hostile and malformed input ────────────────────────────────────────────

test('parseDailyRates fails closed on unparseable XML', () => {
  for (const junk of ['not xml at all <<<', '', '<ValCurs', '{"json":true}']) {
    assert.deepEqual(parseDailyRates(junk), { date: null, rates: {} }, `junk: ${junk}`);
  }
});

test('parseDailyRates fails closed on a document declaring an external entity', () => {
  // fast-xml-parser 5.x refuses external entities outright, and the parser's
  // try/catch turns that into an empty table, which fetchCbrRates then rejects.
  // This locks the behaviour so a version float or a parser-option change that
  // reintroduced entity resolution cannot pass silently.
  const xxe = '<?xml version="1.0" encoding="windows-1251"?>'
    + '<!DOCTYPE ValCurs [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>'
    + '<ValCurs Date="05.08.2026"><Valute ID="R01235"><NumCode>840</NumCode>'
    + '<CharCode>USD</CharCode><Nominal>1</Nominal><Name>&xxe;</Name>'
    + '<Value>81,1291</Value></Valute></ValCurs>';
  const parsed = parseDailyRates(xxe);
  assert.deepEqual(parsed.rates, {}, 'an external-entity document must publish nothing');
  assert.ok(!JSON.stringify(parsed).includes('root:'), 'no file content may leak into the payload');
});

// ─── 9. request-side date helpers ──────────────────────────────────────────────

test('isoToCbrDateReq emits DD/MM/YYYY, the inverse of cbrDateToIso', () => {
  assert.equal(isoToCbrDateReq('2026-08-05'), '05/08/2026');
  assert.equal(isoToCbrDateReq('2025-12-31'), '31/12/2025');
  // The same day/month swap cbrDateToIso guards against, in the outbound
  // direction: it is invisible for the first twelve days of every month and
  // would silently fetch the wrong reference day, yielding a plausible-but-wrong
  // change1d rather than an error.
  assert.notEqual(isoToCbrDateReq('2026-08-05'), '08/05/2026');
  // Round-trips through cbrDateToIso once the separator is swapped: `date_req`
  // takes slashes on the way out, the ValCurs Date attribute comes back dotted.
  assert.equal(cbrDateToIso(isoToCbrDateReq('2026-08-05').replaceAll('/', '.')), '2026-08-05');
  for (const bad of ['05.08.2026', '2026-8-5', '', null, undefined, 20260805]) {
    assert.equal(isoToCbrDateReq(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('previousIsoDate steps back one calendar day across month and year ends', () => {
  assert.equal(previousIsoDate('2026-08-05'), '2026-08-04');
  assert.equal(previousIsoDate('2026-08-01'), '2026-07-31');
  assert.equal(previousIsoDate('2026-01-01'), '2025-12-31');
  assert.equal(previousIsoDate('2024-03-01'), '2024-02-29', 'leap year');
  for (const bad of ['05.08.2026', 'yesterday', '', null, undefined]) {
    assert.equal(previousIsoDate(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

// ─── 10. fetch-layer wiring ────────────────────────────────────────────────────
//
// The encoding fix lives in the WIRING, not in any pure function: fetchCbrBytes
// must hand raw bytes to decodeCbrXml rather than calling Response.text().
// Swapping those back would leave every parser test above green, so the stubs
// here deliberately expose BOTH — text() returns the UTF-8 mojibake a naive
// implementation would get, arrayBuffer() returns the real cp1251 bytes — and
// the assertions can only pass on the arrayBuffer path.

const DAILY_HOST_PATH = 'https://www.cbr.ru/scripts/XML_daily.asp';
const KEY_RATE_HOST_PATH = 'https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx';

function stubResponse(body, { contentLength = null } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return {
    ok: true,
    status: 200,
    headers: new Map([['content-length', contentLength ?? String(bytes.byteLength)]]),
    // A naive implementation would take this and mojibake every Cyrillic name.
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes,
  };
}

/**
 * Install a fetch stub for one run and restore it afterwards.
 * `routes` maps a URL substring to a handler receiving (url, init).
 */
async function withFetchStub(routes, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [needle, handler] of routes) {
      if (String(url).includes(needle)) return handler(String(url), init);
    }
    throw new Error(`unstubbed fetch: ${url}`);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** A full-size daily document: MIN_RATE_COUNT rows plus the three real fixtures. */
function fullDailyBytes(date = '05.08.2026', usdValue = '81,1291') {
  const filler = [];
  for (let i = 0; i < MIN_RATE_COUNT; i++) {
    const code = `Z${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
    filler.push(
      `<Valute ID="R9${String(i).padStart(4, '0')}"><NumCode>${900 + i}</NumCode>`
      + `<CharCode>${code}</CharCode><Nominal>1</Nominal><Name>x</Name>`
      + `<Value>${10 + i},5000</Value></Valute>`,
    );
  }
  const head = dailyFixtureBytes({ date, usdValue });
  // Splice the filler in before the closing tag, keeping the cp1251 name bytes.
  const closing = Buffer.from('</ValCurs>', 'ascii');
  return Buffer.concat([
    head.subarray(0, head.length - closing.length),
    Buffer.from(filler.join(''), 'ascii'),
    closing,
  ]);
}

test('fetchCbrRates decodes the daily table from BYTES, not Response.text()', async () => {
  const { result, calls } = await withFetchStub([
    [DAILY_HOST_PATH, () => stubResponse(fullDailyBytes())],
    [KEY_RATE_HOST_PATH, () => stubResponse(KEY_RATE_SOAP)],
  ], () => fetchCbrRates());

  // Only reachable through arrayBuffer() + TextDecoder('windows-1251').
  assert.equal(result.rates.USD.name, USD_NAME_UNICODE);
  assert.equal(result.rates.USD.rate, 81.1291);
  assert.equal(result.rates.JPY.rate, 0.515171, 'Nominal division survives the wiring');
  assert.equal(result.keyRate.rate, 14);
  assert.equal(validateCbrPayload(result), true);

  // Three sequential calls: current table, prior day, key rate.
  assert.equal(calls.length, 3);
  assert.ok(calls[1].url.includes('date_req=04/08/2026'), `prior-day URL: ${calls[1].url}`);
  assert.equal(calls[2].init.method, 'POST');
  assert.match(calls[2].init.headers.SOAPAction, /KeyRate$/);
});

test('fetchCbrRates fails closed when the daily table comes back empty', async () => {
  await assert.rejects(
    withFetchStub([
      [DAILY_HOST_PATH, () => stubResponse('<?xml version="1.0"?><ValCurs Date="05.08.2026"></ValCurs>')],
      [KEY_RATE_HOST_PATH, () => stubResponse(KEY_RATE_SOAP)],
    ], () => fetchCbrRates()),
    /no usable rate rows/,
  );
});

test('fetchCbrRates fails closed when the key rate comes back empty', async () => {
  // The FX half succeeded here — publishing it alone would overwrite last-good
  // with a half-empty document while /api/health stayed green.
  await assert.rejects(
    withFetchStub([
      [DAILY_HOST_PATH, () => stubResponse(fullDailyBytes())],
      [KEY_RATE_HOST_PATH, () => stubResponse('<soap:Envelope/>')],
    ], () => fetchCbrRates()),
    /KeyRate returned no observations/,
  );
});

test('fetchCbrRates survives a failed prior-day fetch with change1d null', async () => {
  let dailyCalls = 0;
  const { result } = await withFetchStub([
    [DAILY_HOST_PATH, (url) => {
      dailyCalls++;
      // Only the dated (prior-day) request fails; the current table succeeds.
      if (url.includes('date_req=')) throw new Error('simulated upstream 503');
      return stubResponse(fullDailyBytes());
    }],
    [KEY_RATE_HOST_PATH, () => stubResponse(KEY_RATE_SOAP)],
  ], () => fetchCbrRates());

  assert.equal(dailyCalls, 2, 'the prior-day call is attempted once, best-effort');
  assert.equal(result.rates.USD.change1d, null, 'null, never 0 — a failed fetch is not "flat"');
  assert.equal(result.previousDate, null);
  assert.equal(validateCbrPayload(result), true, 'the run still publishes');
});

test('fetchCbrRates rejects an oversized body before parsing it', async () => {
  await assert.rejects(
    withFetchStub([
      [DAILY_HOST_PATH, () => stubResponse(fullDailyBytes(), { contentLength: String(9 * 1024 * 1024) })],
      [KEY_RATE_HOST_PATH, () => stubResponse(KEY_RATE_SOAP)],
    ], () => fetchCbrRates()),
    /response too large/,
  );
});

// ─── 11. agent-facing payload contract ─────────────────────────────────────────
//
// This dataset has no dashboard panel — an MCP caller is its only reader, so
// there is no UI for a user to cross-check a misreading against. Each field name
// below was chosen to defeat a specific misreading, and each assertion here
// fails if the name reverts to the ambiguous one.

test('the published payload names every field a consumer could misread', () => {
  const payload = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });

  // Direction: `base: 'RUB'` reads, by FX-API convention, as "units of X per 1
  // RUB" — the reciprocal. Inverting USD is a ~6600x error.
  assert.equal(payload.quoteCurrency, 'RUB');
  assert.match(payload.rateUnit, /RUB per 1 unit/);
  assert.equal(payload.base, undefined);

  // Date: CBR sets tomorrow's rate, so a field called `date` reads as "as of"
  // and is a day off on every call.
  assert.equal(payload.effectiveDate, '2026-08-05');
  assert.equal(payload.date, undefined, 'the ambiguous name must not come back');

  // Block price vs unit rate: `value` reads as authoritative as `rate` to a
  // consumer with no other signal, and is 100x off for JPY.
  assert.equal(payload.rates.JPY.rate, 0.515171);
  assert.equal(payload.rates.JPY.valuePerNominal, 51.5171);
  assert.equal(payload.rates.JPY.value, undefined, 'the ambiguous name must not come back');

  // Window edge vs policy decision: the oldest observation is where the lookback
  // opened, not a rate move, so it must not sit in the same list as real ones.
  assert.equal(payload.keyRate.path, undefined, 'the conflated list must not come back');
  assert.deepEqual(payload.keyRate.windowStart, { date: '2026-07-23', rate: 14.25 });
  assert.ok(Array.isArray(payload.keyRate.changes));
  for (const step of payload.keyRate.changes) {
    assert.notEqual(step.date, payload.keyRate.windowStart.date,
      'the window boundary must never appear as an observed transition');
  }

  // observedAt is the newest OBSERVATION, distinct from when the rate last moved.
  assert.equal(payload.keyRate.observedAt, '2026-08-04');
  assert.equal(payload.keyRate.changedAt, '2026-07-27');
  assert.notEqual(payload.keyRate.observedAt, payload.keyRate.changedAt);
});
