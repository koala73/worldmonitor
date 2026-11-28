import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPasses,
  createCsvLineReader,
  createRecordParser,
  MAX_CSV_LINE_BYTES,
  MAX_RECORD_BYTES,
  decodeEventRecord,
  dedupeGranules,
  failedGranulesFromEvents,
  fetchSegments,
  granuleDate,
  listGranules,
  mergePasses,
  passIsOk,
  passToTuple,
  reduceRows,
  tupleToPass,
  streamSlideRuleRequest,
} from '../scripts/_reservoir-levels.mjs';
import {
  csvFileRecords,
  atl13FileRecords,
  csvFromRows,
  encodeRecord,
  eventRecord,
  exceptRecord,
  splitEvery,
  streamResponse,
} from './helpers/sliderule-stream.mjs';

const G1 = 'ATL13_20260601195921_12013101_007_01.h5';
const G2 = 'ATL13_20260603094214_12253101_007_01.h5';
const G3 = 'ATL13_20260607075937_12853101_007_01.h5';

function lakeRows({ t, rgt, h, n = 30, beams = [10, 30, 50], jitter = 0.02 }) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ t, rgt, gt: beams[i % beams.length], h: h + ((i % 5) - 2) * jitter / 2 });
  return rows;
}

describe('SlideRule record stream parser', () => {
  const stream = Buffer.concat([
    eventRecord('Starting proxy for atl13x'),
    ...csvFileRecords(csvFromRows(lakeRows({ t: '2026-06-01T20:00:00Z', rgt: 1201, h: 320 })), 50),
    exceptRecord(`H5Coro::Future read failure on ${G2}/gt1l/segment_lat`, -1, 3),
  ]);

  function parseAll(chunks) {
    const seen = [];
    const p = createRecordParser((type, d) => seen.push({ type, d: Buffer.from(d) }));
    for (const c of chunks) p.push(c);
    p.end();
    return seen;
  }

  it('yields identical records for every chunking, including splits inside headers and payloads', () => {
    const whole = parseAll([stream]);
    assert.ok(whole.length >= 5);
    for (const sizes of [[1], [3], [7], [8], [9], [5, 13, 2], [stream.length - 1, 1]]) {
      const got = parseAll(splitEvery(stream, sizes));
      assert.deepEqual(got.map((r) => r.type), whole.map((r) => r.type), `sizes ${sizes}`);
      assert.ok(got.every((r, i) => r.d.equals(whole[i].d)), `payload bytes differ for sizes ${sizes}`);
    }
  });

  it('decodes events and exceptions and attributes failures to granules', () => {
    const recs = parseAll([stream]);
    const events = recs.map((r) => decodeEventRecord(r.type, r.d)).filter(Boolean);
    assert.equal(events[0].kind, 'event');
    assert.equal(events[0].msg, 'Starting proxy for atl13x');
    const ex = events.find((e) => e.kind === 'exception');
    assert.equal(ex.code, -1);
    assert.equal(ex.level, 3);
    assert.deepEqual(failedGranulesFromEvents(events), [G2]);
    // An info-level event that names a granule is not a failure.
    assert.deepEqual(failedGranulesFromEvents([{ kind: 'event', level: 1, msg: `processing ${G1}` }]), []);
  });

  it('rejects a truncated stream and a wrong record version', () => {
    const p = createRecordParser(() => {});
    p.push(stream.subarray(0, stream.length - 3));
    assert.throws(() => p.end(), /truncated/);
    const bad = Buffer.from(encodeRecord('eventrec', Buffer.alloc(70)));
    bad.writeInt16BE(3, 0);
    assert.throws(() => createRecordParser(() => {}).push(bad), /version 3/);
  });

  it('reads CSV lines split across data chunks', () => {
    const rows = [];
    const r = createCsvLineReader((row) => rows.push(row));
    const text = 'a,b\n1,2\n3,4\n5,6';
    for (const piece of ['a,', 'b\n1', ',2\n3,4', '\n', '5,6']) r.push(Buffer.from(piece));
    r.end();
    assert.deepEqual(rows, [{ a: '1', b: '2' }, { a: '3', b: '4' }, { a: '5', b: '6' }]);
    assert.equal(text.split('\n').length - 1, rows.length);
  });
});

describe('fetchSegments', () => {
  const okRows = lakeRows({ t: '2026-06-01T20:00:00Z', rgt: 1201, h: 320 });
  const csv = csvFromRows(okRows);

  it('streams rows and treats a per-granule server failure as partial success', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.resource);
      return streamResponse(body.resource === G2
        ? [exceptRecord(`H5Coro::Future read failure on ${G2}/gt2r/ht_ortho`)]
        : splitEvery(Buffer.concat(atl13FileRecords(okRows)), [11]));
    };
    const rows = [];
    const r = await fetchSegments([{ lon: 0, lat: 0 }], [G1, G2, G3], (row) => rows.push(row), fetchImpl);
    assert.deepEqual(calls, [G1, G2, G3]);
    assert.equal(rows.length, 2 * okRows.length);
    assert.deepEqual(r.processed, [G1, G3]);
    assert.deepEqual(r.failed, [G2]);
  });

  it('accepts a complete file without an arrowrec.eof record (server v5.8 omits it)', async () => {
    const recs = csvFileRecords(csv, 37);
    recs.pop(); // drop arrowrec.eof
    const rows = [];
    const r = await streamSlideRuleRequest('https://example.test', {}, (row) => rows.push(row), async () => streamResponse([Buffer.concat(recs)]));
    assert.equal(r.csvBytes, r.fileSize);
    assert.equal(rows.length, okRows.length);
  });

  it('reads ATL13 granules singly to keep source columns separate from metadata', async () => {
    const names = Array.from({ length: 45 }, (_, i) => `ATL13_202606${String(1 + (i % 28)).padStart(2, '0')}0000${String(i).padStart(2, '0')}_0${String(1000 + i)}3101_007_01.h5`);
    const resources = [];
    const fetchImpl = async (_url, init) => {
      resources.push(JSON.parse(init.body).resource);
      return streamResponse(atl13FileRecords([]));
    };
    const r = await fetchSegments([], names, () => {}, fetchImpl);
    assert.deepEqual(resources, names);
    assert.equal(r.processed.length, 45);
    assert.equal(r.failed.length, 0);
  });

  it('marks the whole batch failed and emits no rows when the stream is cut', async () => {
    const full = Buffer.concat(atl13FileRecords(okRows));
    const fetchImpl = async () => streamResponse([full.subarray(0, full.length - 40)]);
    const rows = [];
    const r = await fetchSegments([], [G1, G3], (row) => rows.push(row), fetchImpl);
    assert.deepEqual(r.failed, [G1, G3]);
    assert.equal(rows.length, 0);
  });

  it('marks the batch failed on HTTP errors and leaves granules past the deadline untouched', async () => {
    const r1 = await fetchSegments([], [G1], () => {}, async () => streamResponse([Buffer.from('busy')], { status: 503, contentType: 'text/plain' }));
    assert.deepEqual(r1.failed, [G1]);
    assert.match(r1.errors[0], /HTTP 503/);
    const r2 = await fetchSegments([], [G1, G2], () => {}, async () => { throw new Error('unreachable'); }, { deadlineAtMs: Date.now() - 1 });
    assert.deepEqual(r2.skipped, [G1, G2]);
    assert.deepEqual(r2.failed, []);
  });
});

describe('listGranules', () => {
  it('paginates with CMR-Search-After, extracts names and keeps the newest revision', async () => {
    const page1 = Array.from({ length: 2000 }, (_, i) => ({ producer_granule_id: `ATL13_2025${String(1 + (i % 12)).padStart(2, '0')}01000000_${String(1000 + (i % 1387)).padStart(4, '0')}0101_007_01.h5` }));
    const page2 = [
      { title: `${G1}_7OvzyTGv` },
      { producer_granule_id: G1.replace('_01.h5', '_02.h5') },
      { title: 'not-a-granule' },
    ];
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(init.headers['CMR-Search-After'] ?? null);
      const body = seen.length === 1 ? page1 : page2;
      return { ok: true, status: 200, headers: new Headers(seen.length === 1 ? { 'cmr-search-after': '[1,2]' } : {}), json: async () => ({ feed: { entry: body } }) };
    };
    const names = await listGranules([-1, -1, 1, 1], '2025-01-01', fetchImpl);
    assert.deepEqual(seen, [null, '[1,2]']);
    assert.ok(names.includes(G1.replace('_01.h5', '_02.h5')));
    assert.ok(!names.includes(G1));
    assert.equal(new Set(names).size, names.length);
  });

  it('does not retry a CMR 400', async () => {
    let n = 0;
    await assert.rejects(listGranules([0, 0, 1, 1], '2025-01-01', async () => { n++; return { ok: false, status: 400 }; }), /CMR HTTP 400/);
    assert.equal(n, 1);
  });

  it('parses granule dates and dedupes revisions', () => {
    assert.equal(granuleDate(G1), '2026-06-01');
    assert.equal(granuleDate('nope'), null);
    assert.deepEqual(dedupeGranules([G2, G1, G1.replace('_01.h5', '_02.h5'), 'x']), [G1.replace('_01.h5', '_02.h5'), G2]);
  });
});

describe('pass reduction', () => {
  it('drops fill values, clips outliers and reports per-pass stats', () => {
    const rows = [
      ...lakeRows({ t: '2026-06-01T20:00:00Z', rgt: 1201, h: 320, n: 40 }),
      { t: '2026-06-01T20:00:01Z', rgt: 1201, gt: 10, h: 3.4028234663852886e38 },
      { t: '2026-06-01T20:00:01Z', rgt: 1201, gt: 10, h: 335 },
    ];
    const csv = csvFromRows(rows).trim().split('\n');
    const head = csv[0].split(',');
    const objs = csv.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));
    const [p] = reduceRows(objs);
    assert.equal(p.date, '2026-06-01');
    assert.equal(p.rgt, 1201);
    assert.equal(p.n, 40); // 335 m clipped, fill dropped
    assert.ok(Math.abs(p.levelM - 320) < 0.02);
    assert.ok(p.madM <= 0.02);
    assert.ok(p.beamSpreadM < 0.05);
    assert.equal(passIsOk(p), true);
  });

  it('fails the beam-agreement rule when beams sample different water', () => {
    const rows = [
      ...lakeRows({ t: '2026-06-01T20:00:00Z', rgt: 1, h: 320, n: 20, beams: [10] }),
      ...lakeRows({ t: '2026-06-01T20:00:00Z', rgt: 1, h: 320.5, n: 20, beams: [50] }),
    ].map((r) => ({ time_ns: String(BigInt(Date.parse(r.t)) * 1000000n), rgt: r.rgt, gt: r.gt, ht_ortho: r.h }));
    const [p] = reduceRows(rows);
    assert.ok(p.beamSpreadM > 0.3);
    assert.equal(passIsOk(p), false);
  });

  it('skips rows whose height field is empty instead of reading them as 0 m', () => {
    const rows = lakeRows({ t: '2026-06-01T20:00:00Z', rgt: 1, h: 320 })
      .map((r) => ({ time_ns: String(BigInt(Date.parse(r.t)) * 1000000n), rgt: r.rgt, gt: r.gt, ht_ortho: String(r.h) }));
    const blanks = rows.slice(0, 12).map((r) => ({ ...r, ht_ortho: '' }));
    const [p] = reduceRows([...rows, ...blanks]);
    assert.equal(p.n, rows.length);
    assert.ok(Math.abs(p.levelM - 320) < 0.02);
    // A pass whose heights are all empty must not become a clean 0 m pass.
    assert.deepEqual(reduceRows(rows.map((r) => ({ ...r, ht_ortho: '' }))), []);
  });

  it('keeps only the configured ATL13 water body when refid is set', () => {
    const rows = [
      ...lakeRows({ t: '2026-06-01T20:00:00Z', rgt: 1, h: 320 }).map((r) => ({ ...r, refid: 7 })),
      ...lakeRows({ t: '2026-06-01T20:00:00Z', rgt: 1, h: 196 }).map((r) => ({ ...r, refid: 9 })),
    ].map((r) => ({ time_ns: String(BigInt(Date.parse(r.t)) * 1000000n), rgt: r.rgt, gt: r.gt, ht_ortho: r.h, atl13refid: String(r.refid) }));
    assert.ok(Math.abs(reduceRows(rows, { refid: 7 })[0].levelM - 320) < 0.02);
    assert.equal(reduceRows(rows, { refid: 9 })[0].n, 30);
  });

  it('despikes the GERD-style 744 m pass during the fill and keeps the trend', () => {
    // Monthly passes rising from 530 m to 635 m, with one isolated 744 m pass of n=20.
    const passes = [];
    for (let i = 0; i < 24; i++) {
      const d = new Date(Date.UTC(2020, 6 + i, 10, 12));
      passes.push({ time: d.toISOString().slice(0, 16) + 'Z', date: d.toISOString().slice(0, 10), rgt: 100 + i, levelM: 530 + i * (105 / 23), madM: 0.03, n: 80, beamSpreadM: 0.04 });
    }
    passes.splice(12, 0, { time: '2021-07-20T12:00Z', date: '2021-07-20', rgt: 999, levelM: 744.2, madM: 0.05, n: 20, beamSpreadM: null });
    const c = classifyPasses(passes);
    const spike = c.find((p) => p.rgt === 999);
    assert.equal(spike.ok, false);
    assert.equal(spike.spike, true);
    assert.equal(c.filter((p) => p.ok).length, 24);
    // Despike is recomputed, never stored: the stored stats are unchanged.
    assert.equal(passes[12].levelM, 744.2);
    assert.equal('ok' in passes[12], false);
  });

  it('keeps a real collapse (Kakhovka) instead of despiking it', () => {
    const level = (i) => (i < 10 ? 16 : 3);
    const passes = Array.from({ length: 16 }, (_, i) => {
      const d = new Date(Date.UTC(2022, 9, 1) + i * 30 * 86400e3);
      return { time: d.toISOString().slice(0, 16) + 'Z', date: d.toISOString().slice(0, 10), rgt: i + 1, levelM: level(i), madM: 0.05, n: 40, beamSpreadM: 0.1 };
    });
    const c = classifyPasses(passes);
    assert.equal(c.filter((p) => p.spike).length, 0);
  });
});

describe('pass merge', () => {
  const a = { time: '2026-06-01T20:00Z', date: '2026-06-01', rgt: 1201, levelM: 320, madM: 0.02, n: 40, beamSpreadM: 0.03 };
  const b = { time: '2026-06-07T08:00Z', date: '2026-06-07', rgt: 1285, levelM: 319.9, madM: 0.03, n: 25, beamSpreadM: null };

  it('is idempotent: re-processing the same granule changes nothing', () => {
    const once = mergePasses([a], [b]);
    assert.deepEqual(mergePasses(once, [b]), once);
    assert.deepEqual(mergePasses(once, once), once);
    assert.deepEqual(mergePasses([b], [a]), once);
  });

  it('keeps the record with more segments when a pass arrives twice', () => {
    const partial = { ...a, n: 12, levelM: 320.4 };
    assert.deepEqual(mergePasses([partial], [a]), [a]);
    assert.deepEqual(mergePasses([a], [partial]), [a]);
  });

  it('round-trips the compact tuple form', () => {
    for (const p of [a, b]) assert.deepEqual(tupleToPass(passToTuple(p)), { ...p, revision: 1 });
    // Revision 1 keeps the six-element baseline form; a later revision is stored as a seventh.
    assert.equal(passToTuple(a).length, 6);
    const r2 = { ...a, revision: 2 };
    assert.equal(passToTuple(r2).length, 7);
    assert.deepEqual(tupleToPass(passToTuple(r2)), r2);
  });

  it('a higher granule revision wins the merge whatever its segment count', () => {
    const old = { ...a, n: 400, levelM: 320 };
    const corrected = { ...a, n: 12, levelM: 320.4, revision: 2 };
    for (const order of [[[old], [corrected]], [[corrected], [old]]]) {
      const [m] = mergePasses(...order);
      assert.equal(m.levelM, 320.4);
    }
  });
});

describe('stream ceilings', () => {
  it('rejects a record that declares a size above the ceiling', () => {
    const h = Buffer.alloc(8);
    h.writeInt16BE(2, 0); h.writeInt16BE(8, 2); h.writeInt32BE(MAX_RECORD_BYTES, 4);
    const p = createRecordParser(() => {});
    assert.throws(() => p.push(h), /record size out of range/);
  });

  it('rejects a negative declared size', () => {
    const h = Buffer.alloc(8);
    h.writeInt16BE(2, 0); h.writeInt16BE(8, 2); h.writeInt32BE(-5, 4);
    assert.throws(() => createRecordParser(() => {}).push(h), /record size out of range/);
  });

  it('rejects a CSV stream with no newline past the line ceiling', () => {
    const r = createCsvLineReader(() => {});
    assert.throws(() => r.push(Buffer.alloc(MAX_CSV_LINE_BYTES + 1, 0x31)), /CSV line exceeds/);
  });
});
