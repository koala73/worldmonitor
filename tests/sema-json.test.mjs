import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sema from '../scripts/_sema-sanctions.mjs';

// Named rows from the official HTML table data source; no shifted XML repair.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/sema-table-slice.json', import.meta.url), 'utf8'));
const ingest = (data) => sema.ingestSemaEntries({ fetchFn: async () => new Response(JSON.stringify(data)) });
const fieldMap = {
  Regulation: 'Country', 'Entity or Ship': 'EntityOrShip', 'Title or Ship type': 'TitleOrShip',
  'Last Name': 'LastName', 'Given Names': 'GivenName', Aliases: 'Aliases',
  'Ship IMO number': 'ShipIMONumber', Schedule: 'Schedule', 'Item Number': 'Item',
  'Date of Listing': 'DateOfListing',
};
const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('official SEMA table JSON', () => {
  it('ingests named fields with canonical parity to equivalent valid XML', async () => {
    const expectedXml = fixture.data.map(row => `<record>${Object.entries(fieldMap)
      .map(([key, tag]) => `<${tag}>${escapeXml(row[key])}</${tag}>`).join('')}</record>`).join('');
    const expected = sema.parseSemaXml(expectedXml);
    const result = await ingest(fixture);
    assert.equal(result.error, null);
    assert.deepEqual(result.records, expected.records);
    assert.equal(result.publishedAtMs, expected.publishedAtMs);
    assert.equal(result.oldestItemAt, expected.oldestItemAt);
    assert.equal(result.records[0].id, 'sema-ca:belarus:1-part-1:1');
    assert.equal(result.records[0].name, 'Khazalbek Bakhtibekovich Atabekov');
    assert.equal(result.records[2].id, 'sema-ca:russia:1-1:731');
    assert.deepEqual(result.records[2]._identifiers, ['imo:9118355']);
    assert.equal(result.records[4].name, 'Toe Yi');
    assert.ok(result.records[3].id.includes(':unspecified:'));
    assert.ok(result.records.every(r => r.countryCodes.length === 0));
  });

  it('accepts only positive safe integers for the two numeric identifier fields', async () => {
    for (const key of ['Item Number', 'Ship IMO number']) {
      const result = await ingest({ data: [{ ...fixture.data[0], [key]: 1234567 }] });
      assert.equal(result.error, null);
    }
    for (const key of Object.keys(fieldMap).filter(k => !['Item Number', 'Ship IMO number'].includes(k))) {
      const result = await ingest({ data: [{ ...fixture.data[0], [key]: 1 }] });
      assert.ok(result.error, key);
    }
  });

  it('rejects every missing or non-string named field without partial records', async () => {
    for (const key of Object.keys(fixture.data[0])) {
      for (const value of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, [], {}]) {
        const data = structuredClone(fixture);
        data.data[1][key] = value;
        const result = await ingest(data);
        assert.ok(result.error, `${key}: ${JSON.stringify(value)}`);
        assert.deepEqual(result.records, []);
        assert.equal(result.publishedAtMs, 0);
      }
    }
  });

  it('rejects missing identities and names even with valid neighbors', async () => {
    for (const patch of [{ Regulation: ' ' }, { 'Item Number': ' ' }, { 'Item Number': '0' },
      { 'Entity or Ship': ' ', 'Last Name': ' ', 'Given Names': ' ' }]) {
      const data = structuredClone(fixture);
      Object.assign(data.data[1], patch);
      const result = await ingest(data);
      assert.equal(result.error, 'SEMA_INVALID_RECORD');
      assert.deepEqual(result.records, []);
    }
  });

  it('rejects malformed string identifiers without dropping the affected rows', async () => {
    for (const [key, value] of [
      ['Item Number', '-1'], ['Item Number', 'N/A'], ['Item Number', '1e2'],
      ['Ship IMO number', 'N/A'], ['Ship IMO number', '123'],
      ['Ship IMO number', 'اسکندر مهمی'],
    ]) {
      const data = structuredClone(fixture);
      data.data[0][key] = value;
      const result = await ingest(data);
      assert.equal(result.error, 'SEMA_INVALID_RECORD', `${key}: ${value}`);
      assert.deepEqual(result.records, []);
    }
  });

  it('rejects duplicate normalized canonical identities', async () => {
    const duplicate = { ...fixture.data[0], Regulation: ' Belarus ', Schedule: '1,  Part 1', 'Last Name': 'Different' };
    const result = await ingest({ data: [...fixture.data, duplicate] });
    assert.equal(result.error, 'SEMA_DUPLICATE_ID');
    assert.deepEqual(result.records, []);
  });

  it('rejects malformed shapes and empty sources', async () => {
    for (const data of [null, [], {}, { data: {} }, { data: [null] }, { data: [] }]) {
      const result = await ingest(data);
      assert.ok(result.error);
      assert.deepEqual(result.records, []);
    }
  });

  it('requires genuine listing dates, preserves leap days and source time', async () => {
    for (const date of ['', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-09-00', '2026-9-2', 'yesterday']) {
      const result = await ingest({ data: [{ ...fixture.data[0], 'Date of Listing': date }] });
      assert.equal(result.error, 'SEMA_INVALID_DATE', date);
      assert.deepEqual(result.records, []);
    }
    const result = await ingest({ data: [{ ...fixture.data[0], 'Date of Listing': '2024-02-29' }] });
    assert.equal(result.error, null);
    assert.equal(result.publishedAtMs, Date.UTC(2024, 1, 29));
    assert.equal(result.records[0].effectiveAt, String(Date.UTC(2024, 1, 29)));
  });

  it('fetches only the JSON source with the existing policy and reports HTTP/body failures', async () => {
    const result = await sema.ingestSemaEntries({ fetchFn: async (url, options) => {
      assert.match(url, /sanctions-consolidated-list-eng\.json$/);
      assert.equal(options.headers.Accept, 'application/json');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(JSON.stringify(fixture));
    } });
    assert.equal(result.error, null);
    for (const response of [new Response('bad', { status: 503 }), new Response('{broken')]) {
      const failed = await sema.ingestSemaEntries({ fetchFn: async () => response });
      assert.ok(failed.error);
      assert.deepEqual(failed.records, []);
    }
  });

  it('rejects streamed overflow and aborts a stalled fetch', async () => {
    const large = await sema.ingestSemaEntries({ maxBytes: 8, fetchFn: async () => new Response('123456789') });
    assert.equal(large.error, 'RESPONSE_TOO_LARGE');
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      const timed = await sema.ingestSemaEntries({ timeoutMs: 5, fetchFn: async (_url, { signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
      assert.ok(timed.error);
      assert.deepEqual(timed.records, []);
    } finally { clearTimeout(keepAlive); }
  });
});
