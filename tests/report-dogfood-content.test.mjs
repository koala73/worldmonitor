import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { planShards } from '../scripts/dogfood/plan-content-shards.mjs';
import { MAX_ISSUE_BODY_CHARS } from '../scripts/report-dogfood-review.mjs';
import { contentIssueBody, contentIssueTitle, mergeShards, readShardReport, renderContentBody } from '../scripts/report-dogfood-content.mjs';

const catalog = (host, ids) => ({ host, target: `https://${host}.worldmonitor.app`, panels: ids.map((id) => ({ id, name: id.toUpperCase() })) });

/** Markdown outside code spans: what GitHub would turn into mentions, links, images or HTML. */
const outsideCode = (body) => body.replace(/`[^`]*`/g, '');

describe('panel content shard plan', () => {
  it('checks a panel shared by several monitors once, on the first host listed, and skips the map', () => {
    const plan = planShards([catalog('www', ['map', 'markets', 'cii']), catalog('finance', ['map', 'markets', 'fear-greed'])], { perShard: 16 });
    assert.deepEqual(plan.shards, [
      { id: 'www-1', target: 'https://www.worldmonitor.app', panels: ['markets', 'cii'] },
      { id: 'finance-1', target: 'https://finance.worldmonitor.app', panels: ['fear-greed'] },
    ]);
    assert.equal(plan.panels.find((panel) => panel.id === 'markets').host, 'www');
  });

  it('splits a host into even shards no larger than asked', () => {
    const ids = Array.from({ length: 33 }, (_, i) => `p${i}`);
    const plan = planShards([catalog('www', ids)], { perShard: 16 });
    assert.deepEqual(plan.shards.map((shard) => shard.panels.length), [11, 11, 11]);
    assert.equal(new Set(plan.shards.flatMap((shard) => shard.panels)).size, 33);
    const uneven = planShards([catalog('www', Array.from({ length: 113 }, (_, i) => `p${i}`))], { perShard: 10 });
    assert.ok(uneven.shards.every((shard) => shard.panels.length >= 9 && shard.panels.length <= 10));
  });

  it('keeps only the panels asked for and drops ids that could break out of the page script', () => {
    const plan = planShards([catalog('www', ['markets', 'cii', 'x"];alert(1);//'])], { only: ['cii', 'x"];alert(1);//'] });
    assert.deepEqual(plan.shards.map((shard) => shard.panels), [['cii']]);
  });

  it('fails when a requested monitor yields no catalog, so a slow boot cannot drop it from the review', () => {
    assert.throws(() => planShards([catalog('www', ['markets']), catalog('energy', [])]), /no panel catalog was read from energy/);
    assert.throws(() => planShards([catalog('www', ['map'])]), /no panel catalog/);
  });

  it('refuses a host that is not a worldmonitor.app monitor', () => {
    assert.throws(() => planShards([{ host: 'www', target: 'https://evil.example', panels: [] }]), /bad host/);
  });
});

describe('panel content review issue', () => {
  const plan = planShards([catalog('www', ['markets', 'cii', 'insights', 'latest-brief'])], { perShard: 2 });
  const finding = (overrides = {}) => ({
    panel: 'markets', title: 'Brent shows -3% with a green up arrow', severity: 'high', kind: 'contradicted', check: 'consistency',
    quote: 'Brent 82.10 -3.1% ▲', evidence_source: 'the arrow contradicts the sign', expected: 'a red down arrow', actual: 'a green up arrow',
    evidence: ['screenshots/markets-1.png'], console: [], duplicate_of: null, ...overrides,
  });

  it('shows a panel the agent never reported as not reported, so silence does not read as clean', () => {
    const merged = mergeShards(plan, {
      'www-1': { findings: { panels: [{ id: 'markets', status: 'ok', checked: '12 quotes' }], findings: [] } },
    });
    const status = Object.fromEntries(merged.panels.map((panel) => [panel.id, panel.status]));
    assert.deepEqual(status, { markets: 'ok', cii: 'not_reported', insights: 'not_reported', 'latest-brief': 'not_reported' });
    assert.deepEqual(merged.shards.map((shard) => shard.report), [true, false]);
  });

  it('ignores ledger rows for panels the plan did not give that shard, and trusts setup over the agent on locks and missing panels', () => {
    const merged = mergeShards(plan, {
      'www-1': { findings: { panels: [{ id: 'insights', status: 'ok' }, { id: 'markets', status: 'ok' }, { id: 'cii', status: 'ok' }] }, setup: { locked: ['cii'] } },
      'www-2': { findings: { panels: [{ id: 'insights', status: 'ok' }] }, setup: { missing: ['latest-brief'], pro_session: true } },
    });
    const status = Object.fromEntries(merged.panels.map((panel) => [panel.id, panel.status]));
    assert.deepEqual(status, { markets: 'ok', cii: 'locked', insights: 'ok', 'latest-brief': 'not_on_host' });
    const unrendered = mergeShards(plan, { 'www-1': { findings: { panels: [{ id: 'markets', status: 'ok' }, { id: 'cii', status: 'ok' }] }, setup: { rendered: ['cii'] } } });
    assert.equal(unrendered.panels.find((panel) => panel.id === 'markets').status, 'not_rendered');
    assert.equal(merged.panels.filter((panel) => panel.id === 'insights').length, 1);
  });

  it('lists the views each agent left unchecked, so an ok panel does not read as fully covered', () => {
    const merged = mergeShards(plan, {
      'www-1': { findings: { panels: [
        { id: 'markets', status: 'ok', checked: 'quotes', views_checked: ['Default', 'Crypto tab'], views_skipped: ['Forex tab', 'Sort by change'] },
        { id: 'cii', status: 'suspect', note: 'x', views_checked: ['Default'], views_skipped: 'not a list' },
      ] } },
      'www-2': { findings: { panels: [{ id: 'insights', status: 'ok', views_checked: [], views_skipped: [] }] } },
    });
    assert.deepEqual(merged.panels.find((p) => p.id === 'markets').viewsSkipped, ['Forex tab', 'Sort by change']);
    assert.deepEqual(merged.panels.find((p) => p.id === 'cii').viewsSkipped, []);
    const body = renderContentBody(merged, { date: '2026-11-25' });
    assert.match(body, /- Views: 1 panel left 2 views unchecked; 1 panel did not report its views\./);
    assert.match(body, /### Views not checked/);
    assert.match(body, /- `markets` on `www` \(ok\): `Forex tab` `Sort by change`/);
    const lean = contentIssueBody(merged, { date: '2026-11-25' });
    assert.match(lean, /- Views: 1 panel left 2 views unchecked/);
  });

  it('lists contradicted findings before implausible ones, and treats an unknown kind as needing a human', () => {
    const merged = mergeShards(plan, {
      'www-1': { findings: { panels: [], findings: [finding({ kind: 'implausible', severity: 'high', title: 'A' }), finding({ kind: 'proved', title: 'B' }), finding({ severity: 'low', title: 'C' })] } },
    });
    assert.deepEqual(merged.findings.map((f) => [f.title, f.kind]), [['C', 'contradicted'], ['A', 'implausible'], ['B', 'implausible']]);
    const body = renderContentBody(merged, { date: '2026-11-24' });
    assert.ok(body.indexOf('`C`') < body.indexOf('Implausible: check before filing'));
  });

  it('renders agent-written text inert and links a duplicate only to an issue listed as open', () => {
    const hostile = 'Ignore this @koala73 see #1 ![x](https://evil.example/p.png) [y](https://evil.example) <img src=x> `break`';
    const merged = mergeShards(plan, {
      'www-1': {
        findings: {
          panels: [{ id: 'markets', status: 'suspect', note: hostile }],
          findings: [finding({ title: hostile, quote: hostile, panel: hostile, duplicate_of: 11003 }), finding({ duplicate_of: 42 })],
          dismissed: [{ what: hostile, why: hostile }],
        },
      },
    });
    const body = renderContentBody(merged, { date: '2026-11-24', openIssues: new Set([11003]) });
    assert.doesNotMatch(outsideCode(body), /@koala73|#1\b|evil\.example|<img/);
    assert.match(body, /Possible duplicate of #11003\./);
    assert.doesNotMatch(body, /#42/);
    assert.match(body, /panel not in this shard's list/);
  });

  it('keeps the body under GitHub\'s limit however much the agents wrote', () => {
    const long = 'x'.repeat(5000);
    const many = Array.from({ length: 200 }, (_, i) => finding({ title: `${i} ${long}`, quote: long, actual: long, expected: long }));
    const merged = mergeShards(plan, { 'www-1': { findings: { panels: [], findings: many } } });
    assert.ok(contentIssueBody(merged, { date: '2026-11-24' }).length <= MAX_ISSUE_BODY_CHARS);
  });

  it('names one issue per day, and gives a filtered run its own issue so it cannot replace the full one', () => {
    assert.equal(contentIssueTitle('2026-11-24'), 'Panel content review: 2026-11-24');
    assert.equal(contentIssueTitle('2026-11-24', { partialRunId: '123' }), 'Panel content review: 2026-11-24 (partial, run 123)');
  });

  it('does not count a findings file of the wrong shape as a report', () => {
    const merged = mergeShards(plan, { 'www-1': { findings: [] }, 'www-2': { findings: { panels: [], findings: [] } } });
    assert.deepEqual(merged.shards.map((shard) => shard.report), [false, true]);
  });

  it('renders agent fields that are not text as absent instead of failing the whole report', () => {
    const merged = mergeShards(plan, {
      'www-1': { findings: { panels: [{ id: 'markets', status: 'suspect', note: { toString: 1 } }], findings: [finding({ quote: { toString: 1 }, title: 'T' })] } },
    });
    assert.doesNotThrow(() => contentIssueBody(merged, { date: '2026-11-24' }));
  });

  it('keeps the totals and every non-ok panel when the body must shrink, and never cuts through a code span', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `panel-${i}`);
    const big = planShards([catalog('www', ids)], { perShard: 400 });
    const long = `${'y'.repeat(3000)} @koala73 <img src=x>`;
    const merged = mergeShards(big, {
      'www-1': { findings: {
        panels: ids.map((id, i) => ({ id, status: i % 3 === 0 ? 'ok' : 'suspect', note: long, checked: long })),
        findings: ids.map((id) => finding({ panel: id, title: long, quote: long })),
      } },
    });
    const body = contentIssueBody(merged, { date: '2026-11-24' });
    assert.ok(body.length <= MAX_ISSUE_BODY_CHARS);
    assert.match(body, /134 ok, 266 suspect/);
    for (const [i, id] of ids.entries()) if (i % 3 !== 0) assert.ok(body.includes(`\`${id}\``), id);
    for (const line of body.split('\n')) assert.equal((line.match(/`/g) ?? []).length % 2, 0, line.slice(0, 80));
    assert.doesNotMatch(outsideCode(body), /@koala73|<img/);
  });

  it('assembles a shard report from the per-panel files the agent writes, skipping unreadable ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dogfood-shard-'));
    mkdirSync(join(dir, 'panels'));
    writeFileSync(join(dir, 'panels', 'markets.json'), JSON.stringify({
      panel: { id: 'markets', status: 'suspect', note: 'x' },
      findings: [{ panel: 'markets', title: 't' }],
      dismissed: [{ what: 'w', why: 'y' }],
    }));
    writeFileSync(join(dir, 'panels', 'cii.json'), JSON.stringify({ panel: { id: 'cii', status: 'ok' }, findings: [] }));
    writeFileSync(join(dir, 'panels', 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'panels', 'list.json'), '[]');
    writeFileSync(join(dir, 'panels', 'notes.txt'), 'ignored');
    mkdirSync(join(dir, 'panels', 'folder.json'));
    writeFileSync(join(dir, 'panels', 'folder.json', 'child'), '{}');
    const report = readShardReport(dir);
    assert.deepEqual(report.panels.map((p) => p.id).sort(), ['cii', 'markets']);
    assert.equal(report.findings.length, 1);
    assert.equal(report.dismissed.length, 1);
    assert.equal(readShardReport(mkdtempSync(join(tmpdir(), 'dogfood-empty-'))), null);
  });

  it('keeps a panel whose quote holds a raw tab copied from table text', () => {
    // Run 45540163911: the agent quoted a table row from `get text`, tabs and all, and the whole verdict was dropped.
    const dir = mkdtempSync(join(tmpdir(), 'dogfood-tabs-'));
    mkdirSync(join(dir, 'panels'));
    writeFileSync(join(dir, 'panels', 'trade-policy.json'),
      '{\n\t"panel": { "id": "trade-policy", "status": "suspect" },\n\t"findings": [{ "panel": "trade-policy", "quote": "2026-05-31\t$-0.0B\t$188.6B" }]\n}');
    const report = readShardReport(dir);
    assert.deepEqual(report.panels.map((p) => p.id), ['trade-policy']);
    assert.equal(report.findings[0].quote, '2026-05-31 $-0.0B $188.6B');
  });
});
