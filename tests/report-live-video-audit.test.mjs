import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import YAML from 'yaml';

import { ALONE_RECHECK_BUDGET_MS, runCheck } from '../scripts/check-live-video-sources.mjs';
import { ISSUE_TITLE, MAX_ISSUE_BODY_CHARS, publishAudit, renderAuditBody } from '../scripts/report-live-video-audit.mjs';

const watch = (id) => `https://www.youtube.com/watch?v=${id}`;
const CANARY_1 = 'https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg';
const CANARY_2 = 'https://www.youtube.com/channel/UCknLrEdhRCp1aegoMqRaCZg';
const BBC_HLS = 'https://vs-hls-push-uk.live.fastly.md.bbci.co.uk/x=4/iptv_hd_abr_v1.m3u8';

const baseCatalog = {
  webcams: {
    jerusalem: [watch('zp6LNSoq000')],
    kyiv: [watch('e2gC37ILQmk'), watch('VGnFLdQW39A')],
    taipei: [watch('z_fY1pj1VBw')],
    sydney: [watch('5uZa3-RMFos')],
    'tel-aviv': [watch('oDCAAfOSqvA')],
  },
  gridPriority: ['jerusalem', 'kyiv', 'taipei', 'sydney', 'tel-aviv'],
  news: {
    bloomberg: [watch('QB5BNdBFujE')],
    'bbc-news': [BBC_HLS],
    rtve: [watch('KQp-e_XQnDE')],
  },
  canaries: [CANARY_1, CANARY_2],
};

const SURFACES = {
  'webcams/jerusalem': ['Webcam grid cell 1', true],
  'webcams/kyiv': ['Webcam grid cell 2', true],
  'webcams/taipei': ['Webcam grid cell 3', true],
  'webcams/sydney': ['Webcam grid cell 4', true],
  'webcams/tel-aviv': ['Webcam (Middle East)', false],
  'live-news/bloomberg': ['Live News default (full, tech)', true],
  'live-news/bbc-news': ['Live News optional', false],
  'live-news/rtve': ['Live News optional', false],
};

function attempt(entry, verdict, { why, unverifiableFromRunner = false, evidence = {} } = {}) {
  return {
    entry,
    kind: entry.endsWith('.m3u8') ? 'hls' : entry.includes('/channel/') ? 'channel' : 'video',
    verdict,
    why: why ?? (verdict === 'live'
      ? 'YouTube reports a live stream (isLive=true) and it is playing'
      : 'YouTube player error 150: the owner does not allow embedding, or the video is unavailable here'),
    unverifiableFromRunner,
    evidence: { videoId: null, title: null, author: null, isLive: null, errorCode: null, httpStatus: null, durationSeconds: null, verdictAtMs: null, ...evidence },
  };
}
const live = (entry) => attempt(entry, 'live', { evidence: { title: 'Live cam', author: 'Cams', isLive: true } });
const dead = (entry) => attempt(entry, 'failed', { evidence: { errorCode: 150 } });

/** A report for `catalog`: every entry live unless `problems` gives a slot its status and attempts. */
function reportFor(catalog, problems = {}, shownInstead = {}) {
  const slots = [
    ...Object.entries(catalog.webcams).map(([id, entries]) => [`webcams/${id}`, entries]),
    ...Object.entries(catalog.news).map(([id, entries]) => [`live-news/${id}`, entries]),
  ].map(([slot, entries]) => {
    const [surface, shownByDefault] = SURFACES[slot];
    const { status, attempts } = problems[slot] ?? { status: 'ok', attempts: entries.map(live) };
    return { slot, surface, shownByDefault, status, attempts, shownInstead: shownInstead[slot] ?? null };
  });
  return { checkedAt: '2026-09-15T05:17:00.000Z', canaries: catalog.canaries.map(live), slots };
}

const AUDIT_AUTHOR = { login: 'github-actions[bot]' };
/**
 * A fake gh: the open-issue search returns `openIssues`, the closed-issue search `closedIssues`, writes return an
 * issue. Issues are the audit's own unless the fixture gives them a `user`.
 */
function fakeGh(openIssues = [], closedIssues = []) {
  const calls = [];
  const gh = (args, payload) => {
    calls.push({ args, payload });
    if (!args.includes('search/issues')) return { number: 42 };
    const query = args.find((arg) => arg.startsWith('q='));
    assert.match(query, /^q=repo:owner\/repo is:issue is:(open|closed) in:title "/, query);
    const items = (query.includes('is:open') ? openIssues : closedIssues).map((issue) => ({ user: AUDIT_AUTHOR, ...issue }));
    return [{ total_count: items.length, items }, { total_count: items.length, items: [] }];
  };
  return { calls, gh };
}

/** The search this reporter makes for its own issues in `state`. */
const searchArgs = (state) => [
  'api', '--paginate', '--slurp', '--method', 'GET', 'search/issues',
  '-f', `q=repo:owner/repo is:issue is:${state} in:title "${ISSUE_TITLE}"`, '-f', 'per_page=100',
];

const unexpectedGh = () => { throw new Error('unexpected GitHub call'); };
const publish = (report, options) => publishAudit(report, { repository: 'owner/repo', catalog: baseCatalog, ...options });

describe('live video audit issue', () => {
  it('creates the issue with slot, where it shows, status, entry, why and shown-instead columns', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-summary-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const summaryPath = join(dir, 'summary.md');
    const report = reportFor(baseCatalog, { 'webcams/jerusalem': { status: 'needs-replacement', attempts: [dead(watch('zp6LNSoq000'))] } }, { 'webcams/jerusalem': 'webcams/tel-aviv' });
    const { calls, gh } = fakeGh([]);

    const result = await publish(report, { gh, runUrl: 'https://github.com/owner/repo/actions/runs/7', summaryPath });

    assert.deepEqual(result, { findings: 1, action: 'created' });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].args, searchArgs('open'), 'the open lookup is scoped to this title, never a repository-wide listing');
    assert.deepEqual(calls[1].args, searchArgs('closed'));
    assert.deepEqual(calls[2].args, ['api', '--method', 'POST', 'repos/owner/repo/issues', '--input', '-']);
    const { title, body } = calls[2].payload;
    assert.equal(title, ISSUE_TITLE);
    assert.equal(calls[2].payload.state, undefined, 'a new issue sends no state');
    assert.match(body, /^\| Slot \| Where it shows \| Status \| Entry \| Why \| Shown instead \|$/m);
    assert.match(body, /^\| webcams\/jerusalem \| Webcam grid cell 1 \| needs-replacement \| `https:\/\/www\.youtube\.com\/watch\?v=zp6LNSoq000` \| YouTube player error 150: [^|]+ \| webcams\/tel-aviv \|$/m);
    assert.match(body, /actions\/runs\/7/);
    assert.match(body, /Canaries: 2 of 2 live/);
    assert.match(body, /npm run live-video:check -- <url>/);
    assert.match(body, /`src\/config\/live-video-sources\.ts`/);
    assert.equal(readFileSync(summaryPath, 'utf8'), `${body}\n`);
  });

  it('updates the open issue whose title matches exactly, ignoring pull requests and near misses', async () => {
    const report = reportFor(baseCatalog, { 'webcams/kyiv': { status: 'needs-replacement', attempts: [dead(watch('e2gC37ILQmk')), dead(watch('VGnFLdQW39A'))] } });
    const { calls, gh } = fakeGh([
      { number: 3, title: `${ISSUE_TITLE} (old)` },
      { number: 4, title: ISSUE_TITLE, pull_request: {} },
      { number: 5, title: ISSUE_TITLE.toLowerCase() },
      { number: 6, title: ISSUE_TITLE },
    ], [{ number: 2, title: ISSUE_TITLE, state: 'closed', updated_at: '2026-09-14T05:20:00Z' }]);

    const result = await publish(report, { gh });

    assert.deepEqual(result, { findings: 1, action: 'updated' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args, ['api', '--method', 'PATCH', 'repos/owner/repo/issues/6', '--input', '-']);
    assert.equal(calls[1].payload.title, ISSUE_TITLE);
    assert.equal(calls[1].payload.state, 'open', 'an issue closed between the lookup and the update is reopened');
    assert.match(calls[1].payload.body, /webcams\/kyiv/);
  });

  it('reopens the most recently updated closed issue with the exact title instead of creating another, with a Regressed comment', async () => {
    const report = reportFor(baseCatalog, { 'webcams/kyiv': { status: 'needs-replacement', attempts: [dead(watch('e2gC37ILQmk')), dead(watch('VGnFLdQW39A'))] } });
    const { calls, gh } = fakeGh([], [
      { number: 11, title: ISSUE_TITLE, state: 'closed', updated_at: '2026-08-01T05:20:00Z' },
      { number: 17, title: ISSUE_TITLE, state: 'closed', updated_at: '2026-09-10T05:20:00Z' },
      { number: 14, title: ISSUE_TITLE, state: 'closed', updated_at: '2026-09-02T05:20:00Z' },
      { number: 19, title: `${ISSUE_TITLE} (old)`, state: 'closed', updated_at: '2026-09-14T05:20:00Z' },
      { number: 20, title: ISSUE_TITLE, state: 'closed', updated_at: '2026-09-14T06:00:00Z', pull_request: {} },
    ]);

    const result = await publish(report, { gh, runUrl: 'https://github.com/owner/repo/actions/runs/9' });

    assert.deepEqual(result, { findings: 1, action: 'reopened', issue: 17 });
    assert.equal(calls.length, 4);
    assert.ok(calls[1].args.includes('search/issues'));
    assert.deepEqual(calls[2].args, ['api', '--method', 'PATCH', 'repos/owner/repo/issues/17', '--input', '-']);
    assert.equal(calls[2].payload.title, ISSUE_TITLE);
    assert.equal(calls[2].payload.state, 'open');
    assert.match(calls[2].payload.body, /webcams\/kyiv/);
    assert.deepEqual(calls[3].args, ['api', '--method', 'POST', 'repos/owner/repo/issues/17/comments', '--input', '-']);
    assert.match(calls[3].payload.body, /^Regressed: 1 slot\(s\) need attention as of 2026-09-15T05:17:00\.000Z\./);
    assert.match(calls[3].payload.body, /actions\/runs\/9/);
  });

  it('creates a new issue only when no open or closed issue has the exact title', async () => {
    const report = reportFor(baseCatalog, { 'webcams/kyiv': { status: 'needs-replacement', attempts: [dead(watch('e2gC37ILQmk')), dead(watch('VGnFLdQW39A'))] } });
    const { calls, gh } = fakeGh([{ number: 3, title: ISSUE_TITLE.toUpperCase() }], [
      { number: 19, title: `${ISSUE_TITLE} (old)`, state: 'closed', updated_at: '2026-09-14T05:20:00Z' },
      { number: 20, title: ISSUE_TITLE, state: 'closed', updated_at: '2026-09-14T06:00:00Z', pull_request: {} },
      { number: 21, title: `Re: ${ISSUE_TITLE}`, state: 'closed', updated_at: '2026-09-14T07:00:00Z' },
    ]);

    assert.deepEqual(await publish(report, { gh }), { findings: 1, action: 'created' });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].args, ['api', '--method', 'POST', 'repos/owner/repo/issues', '--input', '-']);
  });

  it('ignores an open issue with the exact title that the audit did not author', async () => {
    const report = reportFor(baseCatalog, { 'webcams/kyiv': { status: 'needs-replacement', attempts: [dead(watch('e2gC37ILQmk')), dead(watch('VGnFLdQW39A'))] } });
    const { calls, gh } = fakeGh(
      [{ number: 30, title: ISSUE_TITLE, user: { login: 'someone' } }],
      [{ number: 31, title: ISSUE_TITLE, state: 'closed', updated_at: '2026-09-14T05:20:00Z', user: { login: 'someone' } }],
    );

    assert.deepEqual(await publish(report, { gh }), { findings: 1, action: 'created' });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2].args, ['api', '--method', 'POST', 'repos/owner/repo/issues', '--input', '-'], 'an outsider issue is never rewritten or reopened');
  });

  it('leaves a closed issue closed when nothing needs attention', async () => {
    const { calls, gh } = fakeGh([], [{ number: 17, title: ISSUE_TITLE, state: 'closed', updated_at: '2026-09-10T05:20:00Z' }]);
    assert.deepEqual(await publish(reportFor(baseCatalog), { gh }), { findings: 0, action: 'none' });
    assert.equal(calls.length, 1, 'only the open-issue search: no closed-issue search, no reopen');
  });

  it('comments "Recovered" and closes the open issue when no slot needs attention', async () => {
    const { calls, gh } = fakeGh([{ number: 6, title: ISSUE_TITLE }]);

    const result = await publish(reportFor(baseCatalog), { gh, runUrl: 'https://github.com/owner/repo/actions/runs/8' });

    assert.deepEqual(result, { findings: 0, action: 'closed', issue: 6 });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].args, ['api', '--method', 'POST', 'repos/owner/repo/issues/6/comments', '--input', '-']);
    assert.match(calls[1].payload.body, /^Recovered/);
    assert.match(calls[1].payload.body, /actions\/runs\/8/);
    assert.deepEqual(calls[2].args, ['api', '--method', 'PATCH', 'repos/owner/repo/issues/6', '--input', '-']);
    assert.deepEqual(calls[2].payload, { state: 'closed', state_reason: 'completed' });
  });

  it('leaves GitHub alone after the lookup when nothing is open and nothing needs attention', async () => {
    const { calls, gh } = fakeGh([]);
    assert.deepEqual(await publish(reportFor(baseCatalog), { gh }), { findings: 0, action: 'none' });
    assert.equal(calls.length, 1);
  });

  it('closes the issue, or files none, when the only empty slots are hidden from viewers', async (t) => {
    const catalog = { ...baseCatalog, webcams: { ...baseCatalog.webcams, 'tel-aviv': [] }, news: { ...baseCatalog.news, rtve: [] } };
    const report = reportFor(catalog, {
      'webcams/tel-aviv': { status: 'empty', attempts: [] },
      'live-news/rtve': { status: 'empty', attempts: [] },
    });
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-hidden-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const summaryPath = join(dir, 'summary.md');

    const { calls, gh } = fakeGh([{ number: 6, title: ISSUE_TITLE }]);
    assert.deepEqual(await publish(report, { gh, catalog, summaryPath }), { findings: 0, action: 'closed', issue: 6 });
    assert.equal(calls.length, 3);
    assert.match(calls[1].payload.body, /^Recovered/);
    assert.match(calls[1].payload.body, /2 unfilled slot\(s\) stay hidden from viewers/);
    assert.deepEqual(calls[2].payload, { state: 'closed', state_reason: 'completed' });
    assert.match(readFileSync(summaryPath, 'utf8'), /^Daily live video source audit: 0 slot\(s\) need attention, 0 of them shown by default\.$/m);

    const { calls: noneCalls, gh: noneGh } = fakeGh([]);
    assert.deepEqual(await publish(report, { gh: noneGh, catalog }), { findings: 0, action: 'none' });
    assert.equal(noneCalls.length, 1);
  });

  it('publishes on the canaries the checker recorded, without probing them again', async () => {
    const report = reportFor(baseCatalog, { 'webcams/jerusalem': { status: 'needs-replacement', attempts: [dead(watch('zp6LNSoq000'))] } });
    report.canaries = [dead(CANARY_1), live(CANARY_2)];
    const { calls, gh } = fakeGh([]);

    const result = await publish(report, { gh });

    assert.equal(result.action, 'created');
    assert.match(calls.at(-1).payload.body, /Canaries: 1 of 2 live$/m);
  });

  it('throws before any GitHub call when the checker could not verify a canary either', async () => {
    const report = reportFor(baseCatalog);
    report.canaries = [
      attempt(CANARY_1, 'unverifiable', { why: 'the player frame loaded but never became ready', unverifiableFromRunner: true }),
      attempt(CANARY_2, 'unverifiable', { why: 'the player no longer reports whether a video is live (isLive missing)', unverifiableFromRunner: true }),
    ];

    await assert.rejects(publish(report, { gh: unexpectedGh }), /every audit canary failed twice/);
  });

  it('throws on an incomplete or malformed report before the canary guard or any GitHub call', async () => {
    const complete = () => reportFor(baseCatalog);
    const variants = {
      'not an object': null,
      'no slots': { ...complete(), slots: undefined },
      'unparseable checkedAt': { ...complete(), checkedAt: 'yesterday' },
      'a missing canary': { ...complete(), canaries: [live(CANARY_1)] },
      'a canary for another entry': { ...complete(), canaries: [live(CANARY_1), live(CANARY_1)] },
      'a missing slot': { ...complete(), slots: complete().slots.slice(1) },
      'an unknown slot': { ...complete(), slots: [...complete().slots.slice(1), { ...complete().slots[0], slot: 'webcams/atlantis' }] },
      'a repeated slot': { ...complete(), slots: [complete().slots[1], ...complete().slots.slice(1)] },
    };
    const mutate = (edit) => {
      const report = complete();
      edit(report.slots.find((slot) => slot.slot === 'webcams/kyiv'));
      return report;
    };
    Object.assign(variants, {
      'a missing attempt': mutate((slot) => { slot.attempts.pop(); }),
      'an attempt for another entry': mutate((slot) => { slot.attempts[1] = live(watch('zp6LNSoq000')); }),
      'an unknown verdict': mutate((slot) => { slot.attempts[0].verdict = 'maybe'; }),
      'an attempt with no why': mutate((slot) => { delete slot.attempts[0].why; }),
      'a status its attempts contradict': mutate((slot) => { slot.attempts[0] = dead(watch('e2gC37ILQmk')); }),
      'an unknown status': mutate((slot) => { slot.status = 'fine'; }),
      'no surface': mutate((slot) => { slot.surface = ''; }),
      'a non-boolean shownByDefault': mutate((slot) => { slot.shownByDefault = 'yes'; }),
      'a non-string shownInstead': mutate((slot) => { slot.shownInstead = 3; }),
      'a why carrying Markdown': mutate((slot) => { slot.attempts[0].why = 'YouTube player error 150 @koala73'; }),
      'a surface carrying an issue reference': mutate((slot) => { slot.surface = 'Webcam grid #2'; }),
      'a shownInstead carrying a link': mutate((slot) => { slot.shownInstead = '[x](https://evil.example)'; }),
    });

    for (const [label, report] of Object.entries(variants)) {
      await assert.rejects(publish(report, { gh: unexpectedGh }), /incomplete/, label);
    }
  });

  it('lists an HLS 403 under "Could not verify from the runner", never as a finding', async () => {
    const geoBlocked = {
      status: 'unverifiable-from-runner',
      attempts: [attempt(BBC_HLS, 'failed', { why: 'manifest returned HTTP 403', unverifiableFromRunner: true, evidence: { httpStatus: 403 } })],
    };
    const report = reportFor(baseCatalog, {
      'webcams/jerusalem': { status: 'needs-replacement', attempts: [dead(watch('zp6LNSoq000'))] },
      'live-news/bbc-news': geoBlocked,
    });
    const { calls, gh } = fakeGh([]);

    assert.deepEqual(await publish(report, { gh }), { findings: 1, action: 'created' });
    const { body } = calls.at(-1).payload;
    const section = body.indexOf('### Could not verify from the runner');
    assert.ok(section > 0, body);
    assert.equal(body.indexOf('live-news/bbc-news'), body.lastIndexOf('live-news/bbc-news'), 'listed once');
    assert.ok(body.indexOf('live-news/bbc-news') > section, 'listed only in the unverifiable section');
    assert.match(body.slice(section), /\| live-news\/bbc-news \| Live News optional \| `https:\/\/vs-hls-push-uk[^`]+` \| manifest returned HTTP 403 \|/);

    const { calls: closeCalls, gh: closeGh } = fakeGh([{ number: 9, title: ISSUE_TITLE }]);
    const onlyGeo = reportFor(baseCatalog, { 'live-news/bbc-news': geoBlocked });
    assert.deepEqual(await publish(onlyGeo, { gh: closeGh }), { findings: 0, action: 'closed', issue: 9 });
    assert.match(closeCalls[1].payload.body, /1 slot\(s\) could not be verified from the runner/);
  });

  it('lists a YouTube player the runner could not verify under "Could not verify from the runner", never as a finding', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-unverified-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const summaryPath = join(dir, 'summary.md');
    const silent = attempt(watch('QB5BNdBFujE'), 'unverifiable', { why: 'the player frame loaded but never became ready', unverifiableFromRunner: true });
    const report = reportFor(baseCatalog, { 'live-news/bloomberg': { status: 'unverifiable-from-runner', attempts: [silent] } });
    const { gh } = fakeGh([{ number: 6, title: ISSUE_TITLE }]);

    assert.deepEqual(await publish(report, { gh, summaryPath }), { findings: 0, action: 'closed', issue: 6 });
    const body = readFileSync(summaryPath, 'utf8');
    const section = body.indexOf('### Could not verify from the runner');
    assert.ok(section > 0, body);
    assert.match(body.slice(section), /^An HLS 403[^\n]*a YouTube player that never became ready[^\n]*$/m);
    assert.match(body.slice(section), /\| live-news\/bloomberg \| Live News default \(full, tech\) \| `https:\/\/www\.youtube\.com\/watch\?v=QB5BNdBFujE` \| the player frame loaded but never became ready \|/);
    assert.equal(body.indexOf('live-news/bloomberg'), body.indexOf('live-news/bloomberg', section), 'listed only in the unverifiable section');
  });

  it('notes in the header how many never-ready entries the time budget left unchecked', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-budget-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const skipped = (entry) => attempt(entry, 'unverifiable', { why: 'not re-checked: audit time budget used up', unverifiableFromRunner: true, evidence: { recheckSkipped: true } });
    const report = reportFor(baseCatalog, {
      'live-news/bloomberg': { status: 'unverifiable-from-runner', attempts: [skipped(watch('QB5BNdBFujE'))] },
      'live-news/rtve': { status: 'unverifiable-from-runner', attempts: [skipped(watch('KQp-e_XQnDE'))] },
    });

    const summaryPath = join(dir, 'summary.md');
    await publish(report, { gh: fakeGh([]).gh, summaryPath });
    assert.match(readFileSync(summaryPath, 'utf8'), /^- Alone checks skipped: 2 stalled YouTube entries, because the audit time budget was used up$/m);

    const quietPath = join(dir, 'quiet.md');
    await publish(reportFor(baseCatalog), { gh: fakeGh([]).gh, summaryPath: quietPath });
    assert.doesNotMatch(readFileSync(quietPath, 'utf8'), /Alone checks skipped/);
  });

  it('counts an empty grid hotspot as "no entries configured", first, with the slot shown in its cell', async () => {
    const catalog = { ...baseCatalog, webcams: { ...baseCatalog.webcams, jerusalem: [] } };
    const report = reportFor(catalog, {
      'webcams/jerusalem': { status: 'empty', attempts: [] },
      'live-news/bloomberg': { status: 'needs-replacement', attempts: [dead(watch('QB5BNdBFujE'))] },
    }, { 'webcams/jerusalem': 'webcams/tel-aviv' });
    report.slots.reverse();
    const { calls, gh } = fakeGh([]);

    assert.deepEqual(await publish(report, { gh, catalog }), { findings: 2, action: 'created' });
    const { body } = calls.at(-1).payload;
    const rows = body.split('\n').filter((line) => /^\| (webcams|live-news)\//.test(line));
    assert.equal(rows[0], '| webcams/jerusalem | Webcam grid cell 1 | empty | — | no entries configured | webcams/tel-aviv |');
    assert.match(rows[1], /^\| live-news\/bloomberg \|/);
    assert.match(body, /^Daily live video source audit: 2 slot\(s\) need attention, 2 of them shown by default\.$/m);
    assert.doesNotMatch(body, /### Unfilled slots/);
  });

  it('lists hotspot wall slots first, then other slots shown by default, then the rest', async () => {
    const report = reportFor(baseCatalog, {
      'webcams/kyiv': { status: 'needs-replacement', attempts: [dead(watch('e2gC37ILQmk')), dead(watch('VGnFLdQW39A'))] },
      'webcams/tel-aviv': { status: 'needs-replacement', attempts: [dead(watch('oDCAAfOSqvA'))] },
      'live-news/bloomberg': { status: 'needs-replacement', attempts: [dead(watch('QB5BNdBFujE'))] },
      'live-news/rtve': { status: 'needs-replacement', attempts: [dead(watch('KQp-e_XQnDE'))] },
    });
    report.slots.reverse();
    const { calls, gh } = fakeGh([]);

    await publish(report, { gh });

    const { body } = calls.at(-1).payload;
    const order = ['### Shown by default', '| webcams/kyiv |', '| live-news/bloomberg |', '### Not shown by default', '| webcams/tel-aviv |', '| live-news/rtve |']
      .map((needle) => [needle, body.indexOf(needle)]);
    for (const [needle, index] of order) assert.ok(index >= 0, `${needle} is missing:\n${body}`);
    assert.deepEqual(order.map(([needle]) => needle), [...order].sort((a, b) => a[1] - b[1]).map(([needle]) => needle));
    assert.match(body, /^Daily live video source audit: 4 slot\(s\) need attention, 2 of them shown by default\.$/m);
  });

  it('lists hidden empty slots by surface under "Unfilled slots", without counting them', async () => {
    const catalog = {
      ...baseCatalog,
      webcams: { ...baseCatalog.webcams, 'tel-aviv': [] },
      news: { ...baseCatalog.news, 'bbc-news': [], rtve: [] },
    };
    const report = reportFor(catalog, {
      'webcams/kyiv': { status: 'degraded', attempts: [dead(watch('e2gC37ILQmk')), live(watch('VGnFLdQW39A'))] },
      'webcams/tel-aviv': { status: 'empty', attempts: [] },
      'live-news/bbc-news': { status: 'empty', attempts: [] },
      'live-news/rtve': { status: 'empty', attempts: [] },
    });
    const { calls, gh } = fakeGh([]);

    assert.deepEqual(await publish(report, { gh, catalog }), { findings: 1, action: 'created' });
    const { body } = calls.at(-1).payload;
    assert.match(body, /^Daily live video source audit: 1 slot\(s\) need attention, 1 of them shown by default\.$/m);
    assert.doesNotMatch(body, /### Not shown by default/);
    const section = body.indexOf('### Unfilled slots (hidden from viewers)');
    assert.ok(section > body.indexOf('| webcams/kyiv |'), body);
    assert.ok(section < body.indexOf('### Fix a slot'), body);
    assert.equal(body.indexOf('webcams/tel-aviv'), body.indexOf('webcams/tel-aviv', section), 'tel-aviv appears only in the unfilled section');
    assert.equal(body.indexOf('live-news/rtve'), body.indexOf('live-news/rtve', section), 'rtve appears only in the unfilled section');
    assert.match(body, /^- Webcam \(Middle East\): webcams\/tel-aviv$/m);
    assert.match(body, /^- Live News optional: live-news\/bbc-news, live-news\/rtve$/m);
    assert.doesNotMatch(body, /\| empty \|/);
  });

  it('fills the shown-instead column with the stand-in slot, the live backup entry, or a dash', async () => {
    const report = reportFor(baseCatalog, {
      'webcams/jerusalem': { status: 'needs-replacement', attempts: [dead(watch('zp6LNSoq000'))] },
      'webcams/kyiv': { status: 'degraded', attempts: [dead(watch('e2gC37ILQmk')), live(watch('VGnFLdQW39A'))] },
      'live-news/bloomberg': { status: 'needs-replacement', attempts: [dead(watch('QB5BNdBFujE'))] },
    }, { 'webcams/jerusalem': 'webcams/tel-aviv' });
    const { calls, gh } = fakeGh([]);

    await publish(report, { gh });

    const rows = calls.at(-1).payload.body.split('\n').filter((line) => /^\| (webcams|live-news)\//.test(line));
    const shownInstead = rows.map((row) => row.split(' | ').at(-1).replace(/ \|$/, ''));
    assert.deepEqual(rows.map((row) => row.split(' | ')[0].slice(2)), ['webcams/jerusalem', 'webcams/kyiv', 'live-news/bloomberg']);
    assert.deepEqual(shownInstead, ['webcams/tel-aviv', 'entry 2 (live)', '—']);
  });

  it('files a dead entry ahead of an unverifiable one as degraded, shown instead by the unverified entry', async () => {
    const unverified = attempt(watch('VGnFLdQW39A'), 'unverifiable', {
      why: 'the player no longer reports whether a video is live (isLive missing)',
      unverifiableFromRunner: true,
    });
    const report = reportFor(baseCatalog, { 'webcams/kyiv': { status: 'degraded', attempts: [dead(watch('e2gC37ILQmk')), unverified] } });
    const { calls, gh } = fakeGh([]);

    assert.deepEqual(await publish(report, { gh }), { findings: 1, action: 'created' });
    const { body } = calls.at(-1).payload;
    assert.deepEqual(body.split('\n').filter((line) => line.startsWith('| webcams/kyiv |')), [
      '| webcams/kyiv | Webcam grid cell 2 | degraded | `https://www.youtube.com/watch?v=e2gC37ILQmk` | YouTube player error 150: the owner does not allow embedding, or the video is unavailable here | entry 2 (unverified) |',
    ]);
    assert.doesNotMatch(body, /### Could not verify from the runner/);
  });

  it('counts a slot as a finding when a dead entry sits behind one the runner could not verify', async () => {
    const catalog = { ...baseCatalog, webcams: { ...baseCatalog.webcams, kyiv: [BBC_HLS, watch('e2gC37ILQmk'), watch('VGnFLdQW39A')] } };
    const blocked = attempt(BBC_HLS, 'failed', { why: 'manifest returned HTTP 403', unverifiableFromRunner: true, evidence: { httpStatus: 403 } });
    const report = reportFor(catalog, {
      'webcams/kyiv': { status: 'degraded', attempts: [blocked, dead(watch('e2gC37ILQmk')), dead(watch('VGnFLdQW39A'))] },
    });
    const { calls, gh } = fakeGh([{ number: 6, title: ISSUE_TITLE }]);

    assert.deepEqual(await publish(report, { gh, catalog }), { findings: 1, action: 'updated' });
    const { body } = calls.at(-1).payload;
    assert.match(body, /^Daily live video source audit: 1 slot\(s\) need attention, 1 of them shown by default\.$/m);
    assert.deepEqual(body.split('\n').filter((line) => line.startsWith('| webcams/kyiv |')), [
      '| webcams/kyiv | Webcam grid cell 2 | degraded | entry 2: `https://www.youtube.com/watch?v=e2gC37ILQmk` | YouTube player error 150: the owner does not allow embedding, or the video is unavailable here | entry 1 (unverified) |',
      '| webcams/kyiv | Webcam grid cell 2 | degraded | entry 3: `https://www.youtube.com/watch?v=VGnFLdQW39A` | YouTube player error 150: the owner does not allow embedding, or the video is unavailable here | entry 1 (unverified) |',
    ]);
    assert.doesNotMatch(body, /### Could not verify from the runner/);
  });

  it('keeps a dead backup out of "Could not verify from the runner"', () => {
    const stalled = attempt(watch('e2gC37ILQmk'), 'unverifiable', { why: 'the player frame loaded but never became ready', unverifiableFromRunner: true });
    const report = {
      checkedAt: '2026-09-15T05:17:00.000Z',
      canaries: [live(CANARY_1)],
      slots: [{
        slot: 'webcams/kyiv',
        surface: 'Webcam grid cell 2',
        shownByDefault: true,
        status: 'unverifiable-from-runner',
        attempts: [stalled, dead(watch('VGnFLdQW39A'))],
        shownInstead: null,
      }],
    };

    const body = renderAuditBody(report, { canaries: '1 of 1 live' });

    const section = body.indexOf('### Could not verify from the runner');
    assert.ok(section > 0, body);
    assert.match(body.slice(section), /\| webcams\/kyiv \| Webcam grid cell 2 \| `https:\/\/www\.youtube\.com\/watch\?v=e2gC37ILQmk` \| the player frame loaded but never became ready \|/);
    assert.doesNotMatch(body, /VGnFLdQW39A/, 'a definitively dead entry is never listed as runner-dependent');
  });

  it('throws before any GitHub call, and without re-probing, when no canary in the report is live', async () => {
    const report = reportFor(baseCatalog, { 'webcams/jerusalem': { status: 'needs-replacement', attempts: [dead(watch('zp6LNSoq000'))] } });
    report.canaries = [dead(CANARY_1), dead(CANARY_2)];

    await assert.rejects(publish(report, { gh: unexpectedGh }), /every audit canary failed twice/);
  });

  it('renders probe titles, authors, entries and error details as inert code in the issue and the step summary', async (t) => {
    const hostile = "@koala73 @github/staff `tick` [x](https://evil.example) ![](https://evil.example/p.png) fixes #1 a\\|b | <script>alert(1)</script>\nsecond line";
    const hostileHls = 'https://evil.example/@koala73/fixes-#1/a`b|c.m3u8';
    const hostileGeo = 'https://evil.example/![](p)/[x](y).m3u8';
    const catalog = { ...baseCatalog, news: { ...baseCatalog.news, 'bbc-news': [hostileGeo], rtve: [hostileHls] } };
    const report = reportFor(catalog, {
      'webcams/kyiv': {
        status: 'needs-replacement',
        attempts: [
          attempt(watch('e2gC37ILQmk'), 'recording', { why: 'ended recording (isLive=false, duration 24,181 s)', evidence: { title: hostile, author: hostile } }),
          attempt(watch('VGnFLdQW39A'), 'failed', { evidence: { errorCode: 150, title: hostile, author: hostile } }),
        ],
      },
      'live-news/rtve': { status: 'needs-replacement', attempts: [attempt(hostileHls, 'failed', { why: 'stream failed', evidence: { detail: hostile } })] },
      'live-news/bbc-news': {
        status: 'unverifiable-from-runner',
        attempts: [attempt(hostileGeo, 'failed', { why: 'stream failed', unverifiableFromRunner: true, evidence: { detail: hostile } })],
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-inert-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const summaryPath = join(dir, 'summary.md');
    const { calls, gh } = fakeGh([]);

    assert.deepEqual(await publish(report, { gh, catalog, summaryPath }), { findings: 2, action: 'created' });
    const { body } = calls.at(-1).payload;
    assert.equal(readFileSync(summaryPath, 'utf8'), `${body}\n`, 'the step summary carries the same inert body');
    const outsideCode = body.replace(/`[^`\n]*`/g, '');
    assert.doesNotMatch(outsideCode, /@\w/, 'a mention outside a code span');
    assert.doesNotMatch(outsideCode, /#\d/, 'an issue reference outside a code span');
    assert.doesNotMatch(outsideCode, /evil\.example|<script|\]\(|!\[/, 'a link, image or HTML outside a code span');
    assert.doesNotMatch(body, /^second line/m, 'a newline in probe text started a new Markdown line');
    const cellCount = (row) => row.slice(2, -2).split(/(?<!\\)\|/).length;
    const rowsFor = (slot) => body.split('\n').filter((line) => line.startsWith(`| ${slot} |`));
    assert.equal(rowsFor('webcams/kyiv').length, 2);
    for (const row of [...rowsFor('webcams/kyiv'), ...rowsFor('live-news/rtve')]) assert.equal(cellCount(row), 6, row);
    assert.equal(rowsFor('live-news/bbc-news').length, 1);
    for (const row of rowsFor('live-news/bbc-news')) assert.equal(cellCount(row), 4, row);
    assert.match(body, /`@koala73 @github\/staff 'tick' \[x\]\(https:\/\/evil\.example\)/, 'the title stays readable inside its code span');
  });

  it("keeps the issue body under GitHub's size limit and puts every row in the step summary", async (t) => {
    const count = 400;
    const news = {};
    const slots = [];
    for (let i = 0; i < count; i++) {
      const entry = `https://streams.example/${'p'.repeat(150)}/${i}.m3u8`;
      const unverifiable = i % 2 === 0;
      news[`channel-${i}`] = [entry];
      slots.push({
        slot: `live-news/channel-${i}`,
        surface: 'Live News optional',
        shownByDefault: false,
        status: unverifiable ? 'unverifiable-from-runner' : 'needs-replacement',
        attempts: [attempt(entry, 'failed', { why: 'stream failed', unverifiableFromRunner: unverifiable, evidence: { detail: 'D'.repeat(200) } })],
        shownInstead: null,
      });
    }
    for (let i = 0; i < 300; i++) {
      news[`unfilled-${i}`] = [];
      slots.push({ slot: `live-news/unfilled-${i}`, surface: 'Live News optional', shownByDefault: false, status: 'empty', attempts: [], shownInstead: null });
    }
    const catalog = { webcams: {}, gridPriority: [], news, canaries: [CANARY_1, CANARY_2] };
    const report = { checkedAt: '2026-09-15T05:17:00.000Z', canaries: catalog.canaries.map(live), slots };
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-size-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const summaryPath = join(dir, 'summary.md');
    const { calls, gh } = fakeGh([]);

    assert.deepEqual(await publish(report, { gh, catalog, summaryPath }), { findings: count / 2, action: 'created' });
    const { body } = calls.at(-1).payload;
    const summary = readFileSync(summaryPath, 'utf8');
    assert.ok(summary.length > 65_536, `the synthetic report must really be oversized (${summary.length} characters)`);
    assert.ok(body.length <= MAX_ISSUE_BODY_CHARS, `the issue body is ${body.length} characters`);
    const rowCount = (markdown) => markdown.split('\n').filter((line) => line.startsWith('| live-news/channel-')).length;
    const overflow = [...body.matchAll(/^… and (\d+) more \(see the run summary\)$/gm)].reduce((sum, [, more]) => sum + Number(more), 0);
    assert.equal(rowCount(summary), count, 'the step summary lists every row');
    assert.ok(overflow > 0, 'the issue says rows were left out');
    assert.equal(rowCount(body) + overflow, count, 'every row is in the issue or counted by an overflow line');
    assert.match(body, /^- Live News optional: .*… and \d+ more \(see the run summary\)$/m);
    assert.doesNotMatch(summary, /see the run summary/);
  });

  it('checks the repository before the canary guard', async () => {
    const report = reportFor(baseCatalog);
    report.canaries = [dead(CANARY_1), dead(CANARY_2)];
    await assert.rejects(publish(report, { repository: '', gh: unexpectedGh }), /GITHUB_REPOSITORY/);
  });

  it('requires the repository before looking up the issue', async () => {
    await assert.rejects(publish(reportFor(baseCatalog), { repository: '', gh: unexpectedGh }), /GITHUB_REPOSITORY/);
  });
});

describe('live video audit command line', () => {
  it('reports a real-catalog audit through a fake gh, and fails on a missing report', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'live-video-audit-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const reportPath = join(dir, 'live-video-audit.json');
    const payloadPath = join(dir, 'payload.json');
    const liveVerdict = { verdict: { verdict: 'live', video: { videoId: 'gCNeDWCI0vo', isLive: true, title: 'Live', author: 'Channel' } } };
    const blockedVerdict = { verdict: { verdict: 'failed', outcome: { kind: 'player-error', code: 150 } } };
    // The canaries (probed first, on their own page) play and every slot entry fails, so the outcome depends only on
    // the catalog having entries, never on which slots are filled or empty today.
    let youtubeCalls = 0;
    await runCheck(['--all', '--report', reportPath], {
      write: () => {},
      probeYouTube: async (candidates) => {
        youtubeCalls += 1;
        return candidates.map(() => (youtubeCalls === 1 ? liveVerdict : blockedVerdict));
      },
      probeHls: async (candidates) => candidates.map(() => ({ verdict: { verdict: 'failed', outcome: { kind: 'hls-http', status: 404 } } })),
    });
    // The open search answers with an oversized body, so the real ghJson maxBuffer is exercised end to end.
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const query = process.argv.find((arg) => arg.startsWith('q=')) ?? '';
if (query.includes('is:open')) {
  console.log(JSON.stringify([{ total_count: 1, items: [{ number: 1, title: 'Unrelated issue', body: 'x'.repeat(1_100_000), user: { login: 'github-actions[bot]' } }] }]));
} else if (query.includes('is:closed')) {
  console.log(JSON.stringify([{ total_count: 1, items: [{ number: 2, title: 'Unrelated closed issue', updated_at: '2026-09-01T00:00:00Z', user: { login: 'github-actions[bot]' } }] }]));
} else {
  fs.writeFileSync(process.env.MOCK_PAYLOAD, fs.readFileSync(0, 'utf8'));
  console.log(JSON.stringify({ number: 123 }));
}
`, { mode: 0o755 });
    const runReporter = (env) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/report-live-video-audit.mjs'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo', MOCK_PAYLOAD: payloadPath, GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), ...env },
    });

    const reported = runReporter({ LIVE_VIDEO_AUDIT_REPORT: reportPath });
    assert.equal(reported.status, 0, reported.stderr);
    const result = JSON.parse(reported.stdout);
    assert.equal(result.action, 'created');
    assert.ok(result.findings > 0, 'every slot entry failed');
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
    assert.equal(payload.title, ISSUE_TITLE);
    assert.match(payload.body, /^\| (webcams|live-news)\/[a-z0-9-]+ \| [^|]+ \| needs-replacement \| `[^`]+` \| (YouTube player error 150|manifest returned HTTP 404)/m);

    const missing = runReporter({ LIVE_VIDEO_AUDIT_REPORT: join(dir, 'missing.json') });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Live video audit could not report/);
  });
});

describe('live video source audit workflow', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/live-video-source-audit.yml', import.meta.url), 'utf8'));

  it('runs daily and on demand, never on pull requests or pushes', () => {
    assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
    assert.deepEqual(workflow.on.schedule, [{ cron: '17 5 * * *' }]);
    assert.deepEqual(workflow.permissions, { contents: 'read', issues: 'write' });
    assert.equal(workflow.concurrency.group, 'live-video-source-audit');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
  });

  it('checks every slot, then reports from the same file even when the check exits 1', () => {
    const [job, ...others] = Object.values(workflow.jobs);
    assert.deepEqual(others, []);
    assert.equal(job['timeout-minutes'], 30);
    const runs = job.steps.map((step) => step.run ?? '');
    const install = runs.indexOf('npm ci --ignore-scripts');
    const browser = runs.indexOf('npx playwright install --with-deps chromium');
    assert.equal(job.steps[browser]?.['timeout-minutes'], 8, 'a hung Chromium install must not eat the job budget');
    const check = job.steps.findIndex((step) => /scripts\/check-live-video-sources\.mjs/.test(step.run ?? ''));
    const report = job.steps.findIndex((step) => /scripts\/report-live-video-audit\.mjs/.test(step.run ?? ''));
    assert.ok(install >= 0 && install < browser && browser < check && check < report, runs.join('\n'));

    const checkStep = job.steps[check];
    assert.equal(checkStep.run, 'node --import tsx scripts/check-live-video-sources.mjs --all --report "$RUNNER_TEMP/live-video-audit.json"');
    assert.equal(checkStep['continue-on-error'], true, 'the checker exits 1 on findings; the reporter must still run');

    const reportStep = job.steps[report];
    assert.equal(reportStep.run, 'node --import tsx scripts/report-live-video-audit.mjs');
    assert.equal(reportStep.env.LIVE_VIDEO_AUDIT_REPORT, '${{ runner.temp }}/live-video-audit.json');
    assert.equal(reportStep.env.GH_TOKEN, '${{ github.token }}');
    assert.equal(reportStep['continue-on-error'], undefined, 'a broken report or failed canaries must turn the run red');
  });

  it('uploads the JSON report whatever the run did, pinned to a commit', () => {
    const [job] = Object.values(workflow.jobs);
    const report = job.steps.findIndex((step) => /scripts\/report-live-video-audit\.mjs/.test(step.run ?? ''));
    const upload = job.steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact@'));
    assert.ok(upload > report, 'the evidence is uploaded after the reporter has read it');
    assert.equal(job.steps[upload].uses, 'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f');
    assert.equal(job.steps[upload].if, 'always()', 'a failed report is exactly when the JSON is worth reading');
    assert.deepEqual(job.steps[upload].with, {
      name: 'live-video-audit-report',
      path: '${{ runner.temp }}/live-video-audit.json',
      'retention-days': 14,
    });
  });

  it('gives every phase its own timeout and leaves the job real headroom over the worst case', () => {
    const [job] = Object.values(workflow.jobs);
    const timeoutOf = (matches) => job.steps.find(matches)?.['timeout-minutes'];
    const install = timeoutOf((step) => step.run === 'npx playwright install --with-deps chromium');
    const check = timeoutOf((step) => /scripts\/check-live-video-sources\.mjs/.test(step.run ?? ''));
    const report = timeoutOf((step) => /scripts\/report-live-video-audit\.mjs/.test(step.run ?? ''));
    // The batched check (7 pages of up to 8 players at up to about 31 s, HLS fetches capped at 15 s: about 4) plus
    // every alone re-check (the budget), and the reporter (GitHub calls capped at 30 s, no browser: about 1).
    const checking = 4 + ALONE_RECHECK_BUDGET_MS / 60_000;
    assert.equal(ALONE_RECHECK_BUDGET_MS, 8 * 60_000);
    for (const [phase, timeout] of Object.entries({ install, check, report })) {
      assert.equal(typeof timeout, 'number', `${phase} runs without a step timeout, so it can eat the job budget`);
    }
    assert.ok(checking <= check, `the check phase needs ${checking} min against a ${check} min step timeout`);
    assert.ok(1 <= report, `the reporter needs 1 min against a ${report} min step timeout`);
    // Checkout and npm ci (about 3) ahead of the capped phases.
    const worstCase = 3 + install + checking + 1;
    assert.ok(
      worstCase + 5 <= job['timeout-minutes'],
      `worst case ${worstCase} min leaves under 5 min of headroom in a ${job['timeout-minutes']} min job timeout`,
    );
  });
});
