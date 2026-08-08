/**
 * U5 (plan 2026-07-25-001) — PDF data report (KTD7).
 *
 * The report renders RAW feed strings (news titles, source names) rather than
 * already-rendered DOM, so two obligations the cloned print pattern
 * (src/components/CountryBriefPage.ts:753-791) does not carry are asserted
 * here: every interpolated value is escaped, and the LLM-annotation stripper
 * runs inside the builder. The print routine takes an injected document so the
 * failure paths — null iframe document, print() throw — are provable without a
 * DOM; the source pattern fails silently and ours must not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDataReportDocument,
  printReportDocument,
  sanitizeExportData,
} from '@/utils/export-report';

const TS = Date.parse('2026-07-25T12:00:00.000Z');

function newsItem(overrides: Record<string, unknown> = {}) {
  return {
    source: 'Reuters',
    title: 'Baseline headline',
    link: 'https://example.com/a',
    pubDate: new Date(TS),
    isAlert: false,
    ...overrides,
  };
}

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    meta: { exportedAt: '2026-07-25T12:00:00.000Z', note: 'Export reflects all active sources.' },
    timestamp: TS,
    news: [newsItem(), newsItem({ title: 'Second headline', source: 'AFP' })],
    newsClusters: [
      {
        id: 'c1',
        primaryTitle: 'Cluster headline',
        primarySource: 'Reuters',
        primaryLink: 'https://example.com/c1',
        sourceCount: 3,
        topSources: [{ name: 'Reuters', tier: 1, url: 'https://example.com' }],
        allItems: [newsItem()],
        firstSeen: new Date(TS),
        lastUpdated: new Date(TS),
        isAlert: true,
      },
    ],
    markets: [{ symbol: 'BRENT', name: 'Brent Crude', display: '$80', price: 80.12, change: -1.4 }],
    predictions: [{ title: 'Ceasefire by year end', yesPrice: 42, volume: 120000 }],
    intelligence: {
      protests: { events: [{ title: 'Rally in capital', country: 'FR', eventType: 'Protest', severity: 'medium', time: new Date(TS) }] },
      earthquakes: [{ place: 'Off the coast', magnitude: 6.1, depthKm: 10, occurredAt: TS / 1000, sourceUrl: 'https://example.com/q' }],
    },
    cyberThreats: [{ indicator: '1.2.3.4', indicatorType: 'ip', severity: 3, country: 'RU', source: 'OTX', firstSeen: '2026-07-24' }],
    convergenceCards: [{ domain: 'energy', title: 'Convergence card', score: 71, trend: 'rising', countries: ['IR', 'SA'] }],
    monitors: [{ name: 'Hormuz watch', keywords: ['hormuz', 'tanker'], color: '#ff0000' }],
    ...overrides,
  } as never;
}

describe('buildDataReportDocument — content', () => {
  it('builds a non-empty printable document from a representative export', () => {
    const html = buildDataReportDocument(fixture());
    assert.ok(html.length > 500, 'report should carry real content');
    assert.match(html, /<!DOCTYPE html>/i);
    assert.ok(html.includes('WorldMonitor Data Report'));
    assert.ok(html.includes('Export reflects all active sources.'));
    assert.ok(html.includes('Baseline headline'));
    assert.ok(html.includes('Cluster headline'));
    assert.ok(html.includes('Brent Crude'));
    assert.ok(html.includes('Ceasefire by year end'));
    assert.ok(html.includes('Rally in capital'));
    assert.ok(html.includes('Convergence card'));
    assert.ok(html.includes('Hormuz watch'));
  });

  it('is a data report, not a screenshot — no canvas elements', () => {
    const html = buildDataReportDocument(fixture());
    assert.ok(!html.includes('<canvas'), 'v1 is data-driven; canvas capture is deferred');
  });

  it('renders an empty export without throwing', () => {
    const html = buildDataReportDocument({ timestamp: TS } as never);
    assert.ok(html.includes('WorldMonitor Data Report'));
    assert.ok(html.length > 200);
  });

  it('stamps the generated-at timestamp', () => {
    const html = buildDataReportDocument(fixture());
    assert.ok(html.includes('2026-07-25T12:00:00.000Z'));
  });
});

describe('buildDataReportDocument — sanitization (KTD7)', () => {
  it('strips LLM-derived threat annotations from news items', () => {
    const html = buildDataReportDocument(fixture({
      news: [newsItem({ title: 'Annotated headline', threat: { level: 'critical', category: 'LLM_ONLY_MARKER', source: 'llm' } })],
      newsClusters: undefined,
    }));
    assert.ok(html.includes('Annotated headline'));
    assert.ok(!html.includes('LLM_ONLY_MARKER'), 'llm annotations must not feed back into AI');
  });

  it('strips LLM annotations from clusters and their nested items', () => {
    const html = buildDataReportDocument(fixture({
      news: undefined,
      newsClusters: [{
        id: 'c1',
        primaryTitle: 'Cluster headline',
        primarySource: 'Reuters',
        primaryLink: 'https://example.com/c1',
        sourceCount: 1,
        topSources: [],
        allItems: [newsItem({ threat: { level: 'high', category: 'NESTED_LLM_MARKER', source: 'llm' } })],
        firstSeen: new Date(TS),
        lastUpdated: new Date(TS),
        isAlert: false,
        threat: { level: 'critical', category: 'CLUSTER_LLM_MARKER', source: 'llm' },
      }],
    }));
    assert.ok(!html.includes('CLUSTER_LLM_MARKER'));
    assert.ok(!html.includes('NESTED_LLM_MARKER'));
  });

  it('keeps keyword and ML classifications', () => {
    const html = buildDataReportDocument(fixture({
      news: [newsItem({ title: 'Keyword headline', threat: { level: 'high', category: 'KEYWORD_MARKER', source: 'keyword' } })],
      newsClusters: undefined,
    }));
    assert.ok(html.includes('KEYWORD_MARKER'));
  });

  it('sanitizeExportData leaves the caller fixture untouched', () => {
    const data = fixture({ news: [newsItem({ threat: { level: 'high', category: 'X', source: 'llm' } })] }) as Record<string, unknown>;
    sanitizeExportData(data as never);
    const news = data.news as Array<Record<string, unknown>>;
    assert.ok(news[0].threat, 'sanitize must not mutate the live dashboard state');
  });
});

describe('buildDataReportDocument — escaping (untrusted feed strings)', () => {
  it('escapes a script tag in a news title', () => {
    const html = buildDataReportDocument(fixture({
      news: [newsItem({ title: `<script>alert('xss')</script>` })],
      newsClusters: undefined,
    }));
    assert.ok(!html.includes('<script'), 'no element node may derive from a feed string');
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('escapes an img/onerror payload in a source name', () => {
    const html = buildDataReportDocument(fixture({
      news: [newsItem({ source: `<img src=x onerror="alert(1)">` })],
      newsClusters: undefined,
    }));
    assert.ok(!html.includes('<img'), 'no element node may derive from a feed string');
    // The whole payload survives only in escaped form — quotes included, so it
    // can never break out of a text node OR an attribute value.
    assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  });

  it('escapes markup in every rendered section', () => {
    const payload = `<b onclick="x">`;
    const html = buildDataReportDocument(fixture({
      news: [newsItem({ title: payload })],
      newsClusters: [{
        id: payload,
        primaryTitle: payload,
        primarySource: payload,
        primaryLink: payload,
        sourceCount: 1,
        topSources: [],
        allItems: [],
        firstSeen: new Date(TS),
        lastUpdated: new Date(TS),
        isAlert: false,
      }],
      markets: [{ symbol: payload, name: payload, display: payload, price: 1, change: 1 }],
      predictions: [{ title: payload, yesPrice: 1, volume: 1 }],
      convergenceCards: [{ domain: payload, title: payload, score: 1, trend: payload, countries: [payload] }],
      monitors: [{ name: payload, keywords: [payload], color: payload }],
      meta: { exportedAt: payload, note: payload },
    }));
    assert.ok(!html.includes('<b '), 'no element node may derive from a feed string');
    assert.ok(html.includes('&lt;b onclick=&quot;x&quot;&gt;'), 'payload survives only escaped');
    // Every occurrence of the payload is the escaped one — count them to prove
    // no section renders it raw.
    assert.equal(html.split('&lt;b onclick=&quot;x&quot;&gt;').length - 1, html.split('onclick=').length - 1);
  });

  it('drops non-http links rather than emitting a javascript: href', () => {
    const html = buildDataReportDocument(fixture({
      news: [newsItem({ link: 'javascript:alert(1)' })],
      newsClusters: undefined,
    }));
    assert.ok(!html.includes('javascript:'), 'unsafe schemes must never reach an href');
  });
});

// ---------------------------------------------------------------------------
// Print routine — injected document doubles
// ---------------------------------------------------------------------------

interface FakeWindow {
  printCalls: number;
  onafterprint: (() => void) | null;
  print(): void;
}

function fakeDoc(options: { nullDocument?: boolean; printThrows?: boolean } = {}) {
  const removed: unknown[] = [];
  const appended: unknown[] = [];
  const win: FakeWindow = {
    printCalls: 0,
    onafterprint: null,
    print() {
      win.printCalls += 1;
      if (options.printThrows) throw new Error('print blocked');
    },
  };
  const frameDoc = {
    written: '',
    open() {},
    write(html: string) { frameDoc.written += html; },
    close() {},
  };
  const iframe = {
    style: { cssText: '' },
    setAttribute() {},
    contentDocument: options.nullDocument ? null : frameDoc,
    contentWindow: options.nullDocument ? null : win,
  };
  const doc = {
    createElement: () => iframe,
    body: {
      appendChild: (node: unknown) => { appended.push(node); },
      removeChild: (node: unknown) => { removed.push(node); },
    },
  };
  return { doc, iframe, win, frameDoc, appended, removed };
}

/** Runs scheduled callbacks inline so no timer keeps the test process alive. */
const inlineSchedule = (fn: () => void) => { fn(); };

describe('printReportDocument — failure surfaces (no silent no-op)', () => {
  it('writes the report and calls print()', async () => {
    const fake = fakeDoc();
    await printReportDocument('<html></html>', { doc: fake.doc as never, schedule: inlineSchedule });
    assert.equal(fake.win.printCalls, 1);
    assert.ok(fake.frameDoc.written.includes('<html>'));
    assert.equal(fake.appended.length, 1);
  });

  it('cleans the iframe up after printing', async () => {
    const fake = fakeDoc();
    await printReportDocument('<html></html>', { doc: fake.doc as never, schedule: inlineSchedule });
    assert.equal(fake.removed.length, 1, 'the offscreen iframe must not leak');
  });

  it('rejects when the iframe has no document', async () => {
    const fake = fakeDoc({ nullDocument: true });
    await assert.rejects(
      () => printReportDocument('<html></html>', { doc: fake.doc as never, schedule: inlineSchedule }),
      /document/i,
    );
    assert.equal(fake.removed.length, 1, 'the failed iframe must still be removed');
  });

  it('rejects when print() throws (popup blocker / print denied)', async () => {
    const fake = fakeDoc({ printThrows: true });
    await assert.rejects(
      () => printReportDocument('<html></html>', { doc: fake.doc as never, schedule: inlineSchedule }),
      /print blocked/,
    );
    assert.equal(fake.removed.length, 1);
  });

  it('rejects when no document is available at all', async () => {
    await assert.rejects(
      () => printReportDocument('<html></html>', { doc: null as never, schedule: inlineSchedule }),
      /document/i,
    );
  });
});
