import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { streamAtl13Request, reduceRows } from '../scripts/_reservoir-levels.mjs';
import { streamResponse, splitEvery } from './helpers/sliderule-stream.mjs';

const granule = 'ATL13_20181118180604_07810101_007_01.h5';
const native = readFileSync(new URL('./fixtures/reservoir-levels/mead-atl13-native-2018-11-18.bin', import.meta.url));

it('uses source segment RGT 783 rather than granule metadata RGT 781', async () => {
  const rows = [];
  const r = await streamAtl13Request([], granule, row => rows.push(row), async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.resource, granule);
    assert.equal(body.key_space, 0);
    assert.ok(body.parms.atl13.anc_fields.includes('rgt'));
    return streamResponse(splitEvery(native, [1, 11, 97]));
  });
  assert.equal(r.rows, 409);
  assert.ok(rows.every(row => row.rgt === 783 && row.sourceRgt === 781));
  const [p] = reduceRows(rows);
  assert.equal(p.rgt, 783);
  assert.equal(p.levelM, 328.965);
});

it('rejects a truncated native response without publishing partial rows', async () => {
  const rows = [];
  await assert.rejects(streamAtl13Request([], granule, row => rows.push(row), async () => streamResponse([native.subarray(0, native.length - 1)])), /truncated/);
  assert.equal(rows.length, 0);
});

it('rejects complete framing with a missing or malformed EOF or a missing segment RGT', async () => {
  const { createRecordParser } = await import('../scripts/_reservoir-levels.mjs');
  const { encodeRecord } = await import('./helpers/sliderule-stream.mjs');
  for (const missing of ['eof', 'rgt', 'short-eof', 'empty-eof']) {
    const records = [];
    let removed = false;
    const parser = createRecordParser((type, d) => {
      const kind = d.readUInt32LE(16);
      const name = d.subarray(32, 160).toString().split('\0')[0];
      if (!removed && missing === 'short-eof' && kind === 3) {
        removed = true;
        records.push(encodeRecord(type, d.subarray(0, 160)));
        return;
      }
      if (!removed && missing === 'empty-eof' && kind === 3 && d.readUInt32LE(28) > 0) {
        removed = true;
        const empty = Buffer.from(d);
        empty.writeUInt32LE(0, 28);
        records.push(encodeRecord(type, empty));
        return;
      }
      if (!removed && ((missing === 'eof' && kind === 3) || (missing === 'rgt' && kind === 0 && name === 'rgt'))) { removed = true; return; }
      records.push(encodeRecord(type, d));
    });
    parser.push(native);
    parser.end();
    assert.ok(removed, missing);
    const rows = [];
    await assert.rejects(streamAtl13Request([], granule, row => rows.push(row), async () => streamResponse(records)), /incomplete ATL13|missing ATL13|invalid ATL13/);
    assert.equal(rows.length, 0);
  }
});
