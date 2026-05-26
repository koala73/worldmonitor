import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { extractSentimentData, parseHtmlSentiment, parseXlsRows, excelDateToISO } = await import('../scripts/seed-aaii-sentiment.mjs');

describe('AAII Sentiment seed parsing', () => {
  describe('excelDateToISO', () => {
    it('converts known serial dates correctly', () => {
      assert.equal(excelDateToISO(1), '1900-01-01');
      assert.equal(excelDateToISO(59), '1900-02-28');
      assert.equal(excelDateToISO(61), '1900-03-01'); // serial 60 is Lotus bug
      assert.equal(excelDateToISO(46115), '2026-04-03');
    });

    it('returns null for invalid inputs', () => {
      assert.equal(excelDateToISO(0), null);
      assert.equal(excelDateToISO(-5), null);
      assert.equal(excelDateToISO('abc'), null);
    });
  });

  describe('extractSentimentData', () => {
    it('extracts data from rows with header row containing Bullish/Neutral/Bearish', () => {
      const rows = [
        ['Date', 'Bullish', 'Neutral', 'Bearish', 'Bull-Bear Spread'],
        [46115, 0.357, 0.213, 0.43, null],  // 2026-04-03 as Excel serial
        [46108, 0.224, 0.218, 0.558, null],  // 2026-03-27
        [46101, 0.192, 0.237, 0.571, null],  // 2026-03-20
      ];
      const result = extractSentimentData(rows);
      assert.ok(result.length === 3, `Expected 3 rows, got ${result.length}`);
      assert.equal(result[0].date, '2026-04-03');
      assert.equal(result[0].bullish, 35.7);
      assert.equal(result[0].bearish, 43.0);
      assert.equal(result[0].neutral, 21.3);
      assert.equal(result[0].spread, -7.3);
    });

    it('handles percentages > 1 (already in percentage form)', () => {
      const rows = [
        ['Date', 'Bullish', 'Neutral', 'Bearish'],
        ['2026-01-02', 43.1, 31.6, 25.3],
      ];
      const result = extractSentimentData(rows);
      assert.ok(result.length === 1);
      assert.equal(result[0].bullish, 43.1);
      assert.equal(result[0].bearish, 25.3);
      assert.equal(result[0].neutral, 31.6);
      assert.equal(result[0].spread, 17.8);
    });

    it('handles fractions (0-1 range) and converts to percentages', () => {
      const rows = [
        ['Date', 'Bullish', 'Neutral', 'Bearish'],
        ['2026-01-02', 0.45, 0.30, 0.25],
      ];
      const result = extractSentimentData(rows);
      assert.ok(result.length === 1);
      assert.equal(result[0].bullish, 45);
      assert.equal(result[0].bearish, 25);
      assert.equal(result[0].neutral, 30);
    });

    it('returns empty array when no header found', () => {
      const rows = [
        ['foo', 'bar', 'baz'],
        [1, 2, 3],
      ];
      const result = extractSentimentData(rows);
      assert.equal(result.length, 0);
    });

    it('skips rows with null bull/bear values', () => {
      const rows = [
        ['Date', 'Bullish', 'Neutral', 'Bearish'],
        ['2026-01-02', 43.1, 31.6, 25.3],
        ['2026-01-09', null, 28.0, null],
        ['2026-01-16', 35.0, 30.0, 35.0],
      ];
      const result = extractSentimentData(rows);
      assert.equal(result.length, 2);
    });

    it('computes neutral when missing', () => {
      const rows = [
        ['Date', 'Bullish', 'Bearish'],
        ['2026-01-02', 40.0, 30.0],
      ];
      const result = extractSentimentData(rows);
      assert.ok(result.length === 1);
      assert.equal(result[0].neutral, 30.0);
    });

    it('sorts output by date descending', () => {
      const rows = [
        ['Date', 'Bullish', 'Neutral', 'Bearish'],
        ['2026-01-02', 40, 30, 30],
        ['2026-03-01', 35, 35, 30],
        ['2026-02-01', 42, 28, 30],
      ];
      const result = extractSentimentData(rows);
      assert.equal(result[0].date, '2026-03-01');
      assert.equal(result[1].date, '2026-02-01');
      assert.equal(result[2].date, '2026-01-02');
    });
  });

  describe('parseHtmlSentiment', () => {
    it('extracts percentages from AAII-style HTML with tableTxt class', () => {
      const html = `
        <table>
          <tr><td class="tableTxt">35.7%</td></tr>
          <tr><td class="tableTxt">21.3%</td></tr>
          <tr><td class="tableTxt">43.0%</td></tr>
        </table>
      `;
      const result = parseHtmlSentiment(html);
      assert.ok(result.length === 1);
      assert.equal(result[0].bullish, 35.7);
      assert.equal(result[0].neutral, 21.3);
      assert.equal(result[0].bearish, 43.0);
      assert.equal(result[0].spread, -7.3);
    });

    it('returns empty array when fewer than 3 percentages found', () => {
      const html = `<td class="tableTxt">35.7%</td><td class="tableTxt">21.3%</td>`;
      const result = parseHtmlSentiment(html);
      assert.equal(result.length, 0);
    });

    it('assigns a date that is a Thursday', () => {
      const html = `
        <td class="tableTxt">40.0%</td>
        <td class="tableTxt">30.0%</td>
        <td class="tableTxt">30.0%</td>
      `;
      const result = parseHtmlSentiment(html);
      assert.ok(result.length === 1);
      const d = new Date(result[0].date + 'T12:00:00Z');
      assert.equal(d.getUTCDay(), 4, 'Expected Thursday (day 4)');
    });
  });

  describe('parseXlsRows', () => {
    it('returns empty array for empty buffer', () => {
      const result = parseXlsRows(new ArrayBuffer(0));
      assert.deepEqual(result, []);
    });

    it('returns empty array for non-XLS data', () => {
      const buf = new ArrayBuffer(100);
      const view = new Uint8Array(buf);
      for (let i = 0; i < 100; i++) view[i] = i;
      const result = parseXlsRows(buf);
      assert.deepEqual(result, []);
    });
  });
});
