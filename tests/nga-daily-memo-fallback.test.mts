import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  NGA_BROADCAST_WARN_URL,
  NGA_DAILY_MEMO_URLS,
  fetchNgaBroadcastWarnings,
  parseNgaDailyMemo,
} from '../server/_shared/nga-broadcast-warnings.ts';
import { processNgaSignals } from '../server/worldmonitor/infrastructure/v1/get-cable-health.ts';

// Memoranda are "IN FORCE AS OF 061440Z NOV 26".
const AS_OF = Date.UTC(2026, 10, 6, 14, 40);
const NOW = AS_OF + 6 * 60 * 60 * 1000;

const MEMO_FIXTURES: Record<string, string> = Object.fromEntries(NGA_DAILY_MEMO_URLS.map((url) => {
  const file = url.slice(url.lastIndexOf('/') + 1);
  return [url, readFileSync(new URL(`./fixtures/nga-daily-memos/${file}`, import.meta.url), 'utf8')];
}));

const MAINTENANCE_PAGE = '<html><body>MSI IS CURRENTLY UNDER MAINTENANCE</body></html>';

function maintenanceFetch(overrides: Record<string, Response | (() => Response)> = {}) {
  const requested: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    requested.push(url);
    const override = overrides[url];
    if (override) return typeof override === 'function' ? override() : override;
    if (url === NGA_BROADCAST_WARN_URL) return new Response(MAINTENANCE_PAGE, { status: 503 });
    const memo = MEMO_FIXTURES[url];
    if (memo !== undefined) return new Response(memo);
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { requested, fetchImpl };
}

describe('NGA daily memo fallback', () => {
  it('parses dated and undated memo warnings into broadcast-warn records', () => {
    const pac = parseNgaDailyMemo(MEMO_FIXTURES[NGA_DAILY_MEMO_URLS[3]!]!, 'P', 'HYDROPAC', NOW);
    assert.ok(pac);
    assert.deepEqual(pac.map((w) => [w.msgNumber, w.msgYear, w.subregion, w.issueDate]), [
      [3229, 2026, '', '061306Z NOV 2026'],
      [3228, 2026, '', '061224Z NOV 2026'],
      [3155, 2026, '', '300251Z OCT 2026'],
      [311, 2024, '62', '251548Z JAN 2024'],
    ]);
    const hormuz = pac.find((w) => w.msgNumber === 3155)!;
    assert.equal(hormuz.navArea, 'P');
    assert.match(hormuz.text, /^STRAIT OF HORMUZ\.\nOMAN\.\nM\/V RITI SUFFERED A SECURITY INCIDENT/);

    const iv = parseNgaDailyMemo(MEMO_FIXTURES[NGA_DAILY_MEMO_URLS[0]!]!, '4', 'NAVAREA IV', NOW);
    assert.deepEqual(iv?.map((w) => [w.msgNumber, w.subregion, w.issueDate]), [
      [1070, '', '052129Z NOV 2026'],
      // Legacy MSGID/RMKS notices carry no date-time group.
      [227, '25', ''],
    ]);
    assert.match(iv![1]!.text, /^WESTERN NORTH ATLANTIC\.\nDOMINICAN REPUBLIC\./);
  });

  it('rejects a memo for another area, a stale memo, and a non-memo body', () => {
    const pac = MEMO_FIXTURES[NGA_DAILY_MEMO_URLS[3]!]!;
    assert.equal(parseNgaDailyMemo(pac, 'A', 'HYDROLANT', NOW), null);
    assert.equal(parseNgaDailyMemo(pac, 'P', 'HYDROPAC', AS_OF + 5 * 24 * 60 * 60 * 1000), null);
    assert.equal(parseNgaDailyMemo(MAINTENANCE_PAGE, 'P', 'HYDROPAC', NOW), null);
  });

  it('skips the area\'s own in-force summary notice, which carries no warning number', () => {
    // NAVAREA IV began listing its in-force summary as a block of its own on
    // 2026-11-09 (Sentry WORLDMONITOR-1C4): a date-time group, the bare
    // authority, then the list of warning numbers. It is an index of the
    // warnings already in the memo, not a hazard.
    const iv = MEMO_FIXTURES[NGA_DAILY_MEMO_URLS[0]!]!;
    const summary = [
      '061615Z NOV 26',
      'NAVAREA IV',
      '1. NAVAREA IV WARNINGS IN FORCE AS OF 061615Z NOV. ',
      '   ALL THE INFORCE WARNINGS ARE LISTED HERE.',
      '   1070/2026, 227/2025.',
      '2. CANCEL NAVAREA IV 1060/26.',
    ].join('\n');
    const withSummary = iv.replace('052129Z NOV 26\n', `${summary}\n\n052129Z NOV 26\n`);
    assert.notEqual(withSummary, iv);
    const parsed = parseNgaDailyMemo(withSummary, '4', 'NAVAREA IV', NOW);
    assert.deepEqual(parsed?.map((w) => [w.msgNumber, w.subregion]), [[1070, ''], [227, '25']]);

    // Only that exact notice is skipped: a bare-authority block saying anything
    // else is still a format change, and another area's summary is not ours.
    const unknownBare = withSummary.replace('WARNINGS IN FORCE AS OF 061615Z NOV.', 'NEW FORMAT NOTICE.');
    assert.equal(parseNgaDailyMemo(unknownBare, '4', 'NAVAREA IV', NOW), null);
    const otherArea = withSummary.replace('1. NAVAREA IV WARNINGS IN FORCE', '1. HYDROLANT WARNINGS IN FORCE');
    assert.equal(parseNgaDailyMemo(otherArea, '4', 'NAVAREA IV', NOW), null);
    // Without the blank line after it, the next warning joins the summary
    // block; skipping that block would return a short list as complete.
    const unseparated = iv.replace('052129Z NOV 26\n', `${summary}\n052129Z NOV 26\n`);
    assert.equal(parseNgaDailyMemo(unseparated, '4', 'NAVAREA IV', NOW), null);
    // The same holds for a following notice with no warning id of its own.
    const unseparatedBare = iv.replace('052129Z NOV 26\n', `${summary}\n061700Z NOV 26\nNAVAREA IV\n1. NOTICE.\n\n052129Z NOV 26\n`);
    assert.equal(parseNgaDailyMemo(unseparatedBare, '4', 'NAVAREA IV', NOW), null);
    // Undated notices with no date-time group: another area's warning id,
    // another area's bare authority, and a legacy MSGID preamble.
    for (const joined of [
      'HYDROLANT 123/26.\nNORTH ATLANTIC.',
      'HYDROLANT\n1. NOTICE.',
      'MSGID/GENADMIN/NGA NAVSAFETY WASHINGTON DC//\nRMKS/\nNAVAREA IV 228/22(25).',
    ]) {
      const memo = iv.replace('052129Z NOV 26\n', `${summary}\n${joined}\n\n052129Z NOV 26\n`);
      assert.equal(parseNgaDailyMemo(memo, '4', 'NAVAREA IV', NOW), null, joined);
    }
  });

  it('rejects a memo with an unrecognized block or no warnings instead of reading it as quiet', () => {
    const pac = MEMO_FIXTURES[NGA_DAILY_MEMO_URLS[3]!]!;
    const reformatted = pac.replace('HYDROPAC 3229/26', 'HYDROPAC WARNING 3229-26');
    assert.equal(parseNgaDailyMemo(reformatted, 'P', 'HYDROPAC', NOW), null);
    const headerOnly = pac.slice(0, pac.indexOf('061306Z NOV 26'));
    assert.equal(parseNgaDailyMemo(headerOnly, 'P', 'HYDROPAC', NOW), null);
  });

  it('keeps time for the memoranda when the API hangs, within one total budget', async () => {
    const { fetchImpl: memoFetch } = maintenanceFetch();
    const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => url === NGA_BROADCAST_WARN_URL
      ? new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))
      : memoFetch(url);
    const started = performance.now();
    const warnings = await fetchNgaBroadcastWarnings({ userAgent: 'test', timeoutMs: 400, fetchImpl, nowMs: NOW });
    const elapsed = performance.now() - started;
    assert.equal(warnings?.length, 9);
    assert.ok(elapsed >= 180 && elapsed < 400, `elapsed ${elapsed}`);
  });

  it('serves the memoranda when the broadcast-warn API is in maintenance', async () => {
    const { requested, fetchImpl } = maintenanceFetch();
    const warnings = await fetchNgaBroadcastWarnings({ userAgent: 'test', timeoutMs: 1000, fetchImpl, nowMs: NOW });
    assert.ok(warnings);
    assert.deepEqual(requested, [NGA_BROADCAST_WARN_URL, ...NGA_DAILY_MEMO_URLS]);
    assert.deepEqual(
      [...new Set(warnings.map((w) => w.navArea))],
      ['4', '12', 'A', 'P', 'C'],
    );
    assert.equal(warnings.length, 9);
  });

  it('feeds memo cable notices into cable-health signals', async () => {
    const { fetchImpl } = maintenanceFetch();
    const warnings = await fetchNgaBroadcastWarnings({ userAgent: 'test', timeoutMs: 1000, fetchImpl, nowMs: NOW });
    const signals = processNgaSignals(warnings!, NOW);
    assert.ok(signals.length > 0);
    assert.ok(signals.every((s) => s.evidence.every((e) => e.source === 'NGA')));
  });

  it('returns null when any memo is missing rather than reporting that area as quiet', async () => {
    const { fetchImpl } = maintenanceFetch({ [NGA_DAILY_MEMO_URLS[2]!]: () => new Response('gone', { status: 404 }) });
    assert.equal(await fetchNgaBroadcastWarnings({ userAgent: 'test', timeoutMs: 1000, fetchImpl, nowMs: NOW }), null);
  });

  it('does not touch the memoranda while the API answers', async () => {
    const { requested, fetchImpl } = maintenanceFetch({ [NGA_BROADCAST_WARN_URL]: () => Response.json({ 'broadcast-warn': [] }) });
    assert.deepEqual(await fetchNgaBroadcastWarnings({ userAgent: 'test', timeoutMs: 1000, fetchImpl, nowMs: NOW }), []);
    assert.deepEqual(requested, [NGA_BROADCAST_WARN_URL]);
  });

  it('falls back when the API answers 200 with an unparseable body', async () => {
    const { fetchImpl } = maintenanceFetch({ [NGA_BROADCAST_WARN_URL]: () => new Response(MAINTENANCE_PAGE) });
    const warnings = await fetchNgaBroadcastWarnings({ userAgent: 'test', timeoutMs: 1000, fetchImpl, nowMs: NOW });
    assert.equal(warnings?.length, 9);
  });
});
