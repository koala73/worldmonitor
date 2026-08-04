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
  parseCbrDecimal,
  parseDailyRates,
  parseKeyRateSoap,
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
  assert.equal(rates.JPY.value, 51.5171);
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
  assert.equal(payload.keyRate.date, '2026-08-04');
  assert.equal(payload.keyRate.previousRate, 14.25);
  // The cut landed on 2026-07-27 — the FIRST day at the current rate, not the
  // last day at the old one, and not the newest observation.
  assert.equal(payload.keyRate.changedAt, '2026-07-27');
  assert.equal(payload.keyRate.previousDate, '2026-07-24');
  assert.equal(payload.keyRate.change, -0.25);

  // CBR repeats the same rate on every business day between decisions, so the
  // series is run-length encoded to its steps. 6 observations, 2 levels.
  assert.equal(payload.keyRate.observationCount, 6);
  assert.deepEqual(payload.keyRate.path, [
    { date: '2026-07-23', rate: 14.25 },
    { date: '2026-07-27', rate: 14 },
  ]);
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
  assert.deepEqual(payload.keyRate.path, [{ date: '2026-07-27', rate: 14 }]);
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
  assert.equal(payload.rates.USD.change1d, 1);
  assert.equal(payload.rates.JPY.change1d, 0, 'unchanged pairs report a real zero');
});

test('buildCbrPayload reports change1d as null when the prior day is unavailable', () => {
  const payload = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });
  assert.equal(payload.previousDate, null);
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

test('cbrContentMeta uses the FX date once it is no longer in the future', () => {
  const payload = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-05T09:00:00Z'),
  });
  const meta = cbrContentMeta(payload, Date.parse('2026-08-05T09:00:00Z'));
  assert.equal(meta.newestItemAt, Date.parse('2026-08-05T00:00:00Z'));
});

test('cbrContentMeta stays fresh while the key rate is merely on hold', () => {
  // The rate last MOVED eight months ago but CBR is still publishing daily.
  // Clocking off the newest step instead of the newest observation would report
  // eight-month-old content and fire STALE_CONTENT on a perfectly live feed.
  const onHold = {
    date: '2026-08-05',
    keyRate: { date: '2026-08-04', path: [{ date: '2025-12-15', rate: 14 }] },
  };
  const now = Date.parse('2026-08-04T20:00:00Z');
  const meta = cbrContentMeta(onHold, now);
  assert.equal(meta.newestItemAt, Date.parse('2026-08-04T00:00:00Z'));
  assert.ok((now - meta.newestItemAt) / 60000 < 14 * DAY_MIN);
});

test('cbrContentMeta goes stale when the upstream freezes', () => {
  const frozen = {
    date: '2026-06-01',
    keyRate: { date: '2026-05-29', path: [{ date: '2026-05-29', rate: 14 }] },
  };
  const now = Date.parse('2026-08-04T20:00:00Z');
  const meta = cbrContentMeta(frozen, now);
  const ageMin = (now - meta.newestItemAt) / 60000;
  assert.ok(ageMin > 14 * DAY_MIN, `a 64-day-old feed must exceed the 14-day budget (got ${ageMin}min)`);
});

// ─── 7. fail-closed validation ─────────────────────────────────────────────────

test('validateCbrPayload rejects a payload whose key rate went missing', () => {
  const good = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });
  assert.equal(validateCbrPayload(good), true);

  // The key rate is half of what this seeder exists to publish. Letting a
  // keyRate-less payload through would overwrite last-good with a silently
  // half-empty document while /api/health stayed green.
  assert.equal(validateCbrPayload({ ...good, keyRate: null }), false);
  assert.equal(validateCbrPayload({ ...good, keyRate: { ...good.keyRate, rate: null } }), false);
});

test('validateCbrPayload rejects an empty or shrunken rate table', () => {
  const good = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });
  assert.equal(validateCbrPayload({ ...good, rates: {} }), false);
  assert.equal(validateCbrPayload({ ...good, rates: { USD: good.rates.USD } }), false);
  assert.equal(validateCbrPayload(null), false);
});

test('validateCbrPayload rejects a payload with no usable CBR date', () => {
  const good = buildCbrPayload({
    daily: parseDailyRates(decodeCbrXml(dailyFixtureBytes())),
    previousDaily: null,
    keyRateObservations: parseKeyRateSoap(KEY_RATE_SOAP),
    seededAtMs: Date.parse('2026-08-04T20:00:00Z'),
  });
  assert.equal(validateCbrPayload({ ...good, date: null }), false);
});
