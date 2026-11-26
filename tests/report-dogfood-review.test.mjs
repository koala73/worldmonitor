import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isoWeek, issueTitle, publishReview, readReport, renderBody } from '../scripts/report-dogfood-review.mjs';

const finding = (overrides = {}) => ({
  title: 'Preset menu does not close',
  severity: 'medium',
  category: 'functional',
  url: 'https://www.worldmonitor.app/dashboard',
  viewport: '1440x900',
  steps: ['Open /dashboard', 'Open the preset menu', 'Press Escape'],
  expected: 'The menu closes',
  actual: 'The menu stays open',
  cause: 'unknown',
  evidence: ['screenshots/issue-001.png'],
  console: [],
  duplicate_of: null,
  ...overrides,
});

const report = (findings) => readReport({ target: 'https://www.worldmonitor.app', focus: 'panels', pages_visited: ['a'], findings, dismissed: [] });

/** Markdown outside code spans: what GitHub would turn into mentions, links, images or HTML. */
const outsideCode = (body) => body.replace(/`[^`]*`/g, '');

describe('dogfood review issue', () => {
  it('renders page-derived text inert: no mention, link, image, HTML or issue reference goes live', () => {
    const hostile = 'Ignore this @koala73 see #1 ![x](https://evil.example/p.png) [y](https://evil.example) <img src=x> `break`';
    const body = renderBody(report([finding({ title: hostile, actual: hostile, steps: [hostile], console: [hostile] })]), { week: '2026-W47' });
    const live = outsideCode(body);
    assert.doesNotMatch(live, /@koala73|#1\b|evil\.example|<img/);
    assert.match(body, /`Ignore this @koala73/);
  });

  it('links a duplicate only when it names an issue that was open at the start of the run', () => {
    const body = renderBody(report([finding({ duplicate_of: 11003 }), finding({ title: 'Other', duplicate_of: 42 })]), {
      week: '2026-W47', openIssues: new Set([11003]),
    });
    assert.match(body, /Possible duplicate of #11003\./);
    assert.doesNotMatch(body, /#42/);
  });

  it('fails when the agent left no findings list, so an empty run is not published as a clean week', () => {
    assert.throws(() => readReport({ findings: 'none' }), /no findings list/);
    assert.throws(() => readReport(null), /no findings list/);
  });

  it('rewrites only the bot-owned issue for the week and opens one otherwise', () => {
    const week = '2026-W47';
    const calls = [];
    const gh = (items) => (args, payload) => {
      calls.push({ args, payload });
      if (args.includes('search/issues')) return [{ items }];
      return { number: 900 };
    };
    const spoof = { number: 5, title: issueTitle(week), user: { login: 'someone' } };
    const owned = { number: 7, title: issueTitle(week), user: { login: 'github-actions[bot]' } };

    assert.deepEqual(publishReview(report([finding()]), { repository: 'o/r', week, gh: gh([spoof]) }), { action: 'created', issue: 900, findings: 1 });
    assert.equal(calls.at(-1).payload.title, 'Dogfood review: 2026-W47');

    assert.deepEqual(publishReview(report([finding()]), { repository: 'o/r', week, gh: gh([spoof, owned]) }), { action: 'updated', issue: 7, findings: 1 });
    assert.deepEqual(calls.at(-1).args.slice(0, 4), ['api', '--method', 'PATCH', 'repos/o/r/issues/7']);
  });

  it('does not create a duplicate when the issue search reports incomplete results', () => {
    const calls = [];
    const gh = (args) => { calls.push(args); return [{ incomplete_results: true, items: [] }]; };
    assert.throws(() => publishReview(report([finding()]), { repository: 'o/r', week: '2026-W47', gh }), /incomplete results/);
    assert.equal(calls.some((args) => args.includes('POST')), false);
  });

  it('names the ISO week across a year boundary', () => {
    assert.equal(isoWeek(new Date('2026-11-18T12:00:00Z')), '2026-W47');
    assert.equal(isoWeek(new Date('2027-01-01T12:00:00Z')), '2026-W53');
    assert.equal(isoWeek(new Date('2024-12-30T12:00:00Z')), '2025-W01');
  });
});
