import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planShards } from '../scripts/dogfood/plan-content-shards.mjs';
import { MAX_ISSUE_BODY_CHARS } from '../scripts/report-dogfood-review.mjs';
import { contentIssueBody, contentIssueTitle, mergeShards, renderContentBody } from '../scripts/report-dogfood-content.mjs';

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

  it('names one issue per day', () => {
    assert.equal(contentIssueTitle('2026-11-24'), 'Panel content review: 2026-11-24');
  });
});
