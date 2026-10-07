// Judged-lane evidence selection (#8990 Phase 2): the subject gate, the
// deadline cutoff, the window start, the absence truncation count, the
// archive cutover and the completeness-before-judges ordering.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DEFAULT_JUDGED_ARCHIVE_ITEMS,
  JUDGED_EVIDENCE_GRACE_MS,
  JUDGED_EVIDENCE_LOOKBACK_MS,
  JUDGED_EVIDENCE_MAX_LOOKBACK_MS,
  buildJudgedLaneHealthPatch,
  buildJudgedResolutionPrompt,
  judgedArchiveWindowForEntry,
  judgedSubjectTermsForEntry,
  readJudgedNewsArchiveForLedger,
  resolveJudgedEntry,
  selectJudgedArchiveItems,
} from '../scripts/seed-forecast-resolutions.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEADLINE = Date.parse('2026-10-05T23:00:00Z');

function syriaEntry(overrides = {}) {
  return {
    id: 'fc-conflict-syria',
    domain: 'conflict',
    region: 'Syria',
    title: 'Active armed conflict: Syria',
    generatedAt: DEADLINE - 30 * DAY_MS,
    deadline: DEADLINE,
    status: 'pending-judge',
    spec: {
      kind: 'judged',
      deadline: DEADLINE,
      question: 'Within the 30d horizon, did Syria experience a materially escalated level of armed conflict versus its recent baseline, consistent with "Active armed conflict: Syria"?',
    },
    ...overrides,
  };
}

function item(id, title, publishedAt, description = '') {
  return { id, title, description, url: `https://news.example/${id}`, publishedAt };
}

function coveredArchive(items, nowMs, overrides = {}) {
  return {
    available: true,
    coverageStartMs: nowMs - JUDGED_EVIDENCE_MAX_LOOKBACK_MS,
    coverageEndMs: nowMs,
    items,
    ...overrides,
  };
}

const judgedAt = DEADLINE + JUDGED_EVIDENCE_GRACE_MS + HOUR_MS;

function judge(outcome, citations, basis) {
  return async () => ({ provider: 'openrouter', model: 'test-model', outcome, basis, citations, rationale: 'fixture' });
}

function refusingJudge() {
  return async () => { throw new Error('judge must not be called'); };
}

describe('judged subject gate (#8990)', () => {
  it('derives the subject from the region, never from the question template', () => {
    const terms = judgedSubjectTermsForEntry(syriaEntry());
    assert.ok(terms.includes('syria'));
    for (const stock of ['experience', 'level', 'recent', 'escalated', 'baseline', 'conflict', 'armed']) {
      assert.ok(!terms.includes(stock), `template word "${stock}" must not be a subject term`);
    }
  });

  it('shows only items that name the subject, whatever template words they share', () => {
    const selected = selectJudgedArchiveItems(syriaEntry(), [
      item('N1', 'Haiti - Jamaica : Training and exchange of experience in risk management', DEADLINE - DAY_MS, 'experience-sharing on risk'),
      item('N2', 'Germany could be pulled into armed conflict with Russia', DEADLINE - DAY_MS),
      item('N3', 'Clashes erupt in Christian town in central Syria', DEADLINE - 2 * DAY_MS),
      item('N4', 'UN envoy meets Syrian officials in Damascus', DEADLINE - 3 * DAY_MS),
    ], { nowMs: judgedAt });
    assert.deepEqual(selected.map((row) => row.id).sort(), ['N3', 'N4']);
  });

  it('ranks items dated by the deadline ahead of later reports, then event terms ahead of other subject news', () => {
    const selected = selectJudgedArchiveItems(syriaEntry(), [
      item('late', 'Syria clashes kill dozens near Aleppo', DEADLINE + 2 * HOUR_MS),
      item('quiet', 'Syria reopens a museum in Damascus', DEADLINE - HOUR_MS),
      item('event', 'Airstrike kills 12 in northern Syria', DEADLINE - 5 * DAY_MS),
    ], { nowMs: judgedAt });
    assert.deepEqual(selected.map((row) => row.id), ['event', 'quiet', 'late']);
  });

  it('matches multi-country regions through their aliases and excludes a neighbour that contains the name', () => {
    const sudan = { ...syriaEntry(), region: 'Sudan', title: 'Active armed conflict: Sudan' };
    const selected = selectJudgedArchiveItems(sudan, [
      item('S1', 'South Sudan opposition rejects the deal', DEADLINE - DAY_MS),
      item('S2', 'RSF shelling hits Khartoum suburbs', DEADLINE - DAY_MS),
      item('S3', 'Sudanese army retakes El Fasher road', DEADLINE - DAY_MS),
    ], { nowMs: judgedAt });
    assert.deepEqual(selected.map((row) => row.id).sort(), ['S2', 'S3']);
  });
});

describe('judged evidence window (#8990)', () => {
  it('ends at the deadline plus the reporting grace, not at resolution time', () => {
    const window = judgedArchiveWindowForEntry(syriaEntry(), DEADLINE + 5 * DAY_MS);
    assert.equal(window.endMs, DEADLINE + JUDGED_EVIDENCE_GRACE_MS);
    const selected = selectJudgedArchiveItems(syriaEntry(), [
      item('inGrace', 'Syria clashes reported overnight', DEADLINE + JUDGED_EVIDENCE_GRACE_MS),
      item('afterCutoff', 'Syria clashes resume', DEADLINE + JUDGED_EVIDENCE_GRACE_MS + 1),
    ], { nowMs: DEADLINE + 5 * DAY_MS });
    assert.deepEqual(selected.map((row) => row.id), ['inGrace']);
  });

  it('starts at generation time when the archive still holds it', () => {
    const sevenDay = syriaEntry({ generatedAt: DEADLINE - 7 * DAY_MS });
    assert.equal(judgedArchiveWindowForEntry(sevenDay, judgedAt).startMs, DEADLINE - 7 * DAY_MS);
  });

  it('gives a 30-day question everything the archive retains, never less than the last week', () => {
    const window = judgedArchiveWindowForEntry(syriaEntry(), judgedAt);
    assert.equal(window.startMs, judgedAt - JUDGED_EVIDENCE_MAX_LOOKBACK_MS);
    assert.equal(window.requiredStartMs, DEADLINE - JUDGED_EVIDENCE_LOOKBACK_MS);
    const clipped = judgedArchiveWindowForEntry(syriaEntry(), judgedAt, { coverageStartMs: DEADLINE - 9 * DAY_MS });
    assert.equal(clipped.startMs, DEADLINE - 9 * DAY_MS);
    const selected = selectJudgedArchiveItems(syriaEntry(), [
      item('early', 'Syria shelling kills five in Idlib', DEADLINE - 12 * DAY_MS),
      item('beforeGeneration', 'Syria shelling kills four in Idlib', DEADLINE - 31 * DAY_MS),
    ], { nowMs: judgedAt });
    assert.deepEqual(selected.map((row) => row.id), ['early']);
  });

  it('waits out the reporting grace before judging', async () => {
    const result = await resolveJudgedEntry(syriaEntry(), coveredArchive([
      item('N1', 'Airstrike kills 12 in northern Syria', DEADLINE - DAY_MS),
    ], DEADLINE + HOUR_MS), DEADLINE + HOUR_MS, { judgeModels: [refusingJudge(), refusingJudge()] });
    assert.equal(result.status, 'skip');
  });

  it('rejects a YES or an event NO that cites a report dated after the cutoff', async () => {
    const archive = coveredArchive([
      item('N1', 'Syria reopens a museum in Damascus', DEADLINE - DAY_MS),
      item('N2', 'Airstrike kills 12 in northern Syria', DEADLINE + 3 * DAY_MS),
    ], DEADLINE + 4 * DAY_MS);
    for (const outcome of ['YES', 'NO']) {
      const citations = [{ id: 'N2', quote: 'Airstrike kills 12 in northern Syria' }];
      const result = await resolveJudgedEntry(syriaEntry(), archive, DEADLINE + 4 * DAY_MS, {
        judgeModels: [judge(outcome, citations), judge(outcome, citations)],
      });
      assert.equal(result.outcome, 'VOID', `${outcome} on a post-cutoff report must not seal`);
      assert.deepEqual(result.evidence.judgments.map((row) => row.reason), ['invalid_citations', 'invalid_citations']);
    }
  });

  it('states the window and the cutoff to the judges', () => {
    const { userPrompt } = buildJudgedResolutionPrompt(syriaEntry(), [], judgedAt);
    assert.match(userPrompt, /Evidence window: .* to 2026-10-05T23:00:00\.000Z/);
    assert.match(userPrompt, new RegExp(new Date(DEADLINE + JUDGED_EVIDENCE_GRACE_MS).toISOString().replace(/\./g, '\\.')));
  });
});

describe('absence gate (#8990)', () => {
  const absence = (ids) => judge('NO', ids.map((id) => ({ id, quote: `Syria reports ${id}` })), 'absence');

  function quietItems(count, offsetMs = 0) {
    return Array.from({ length: count }, (_, index) => item(`Q${index + 1}`, `Syria reports Q${index + 1}`, DEADLINE - offsetMs - (index + 1) * HOUR_MS));
  }

  it('shows about 32 items', () => {
    assert.equal(DEFAULT_JUDGED_ARCHIVE_ITEMS, 32);
  });

  it('ignores off-subject and post-deadline items when deciding the view was truncated', async () => {
    const offSubject = Array.from({ length: 60 }, (_, index) => item(`X${index}`, `Armed conflict risk level experience ${index}`, DEADLINE - HOUR_MS));
    const afterDeadline = Array.from({ length: 40 }, (_, index) => item(`L${index}`, `Syria update ${index}`, DEADLINE + HOUR_MS));
    const archive = coveredArchive([...quietItems(5), ...offSubject, ...afterDeadline], judgedAt);
    const result = await resolveJudgedEntry(syriaEntry(), archive, judgedAt, {
      judgeModels: [absence(['Q1', 'Q2']), absence(['Q1', 'Q3'])],
    });
    assert.equal(result.outcome, 'NO');
    assert.equal(result.evidence.basis, 'absence');
  });

  it('still blocks an absence NO when on-subject reports dated by the deadline were left out', async () => {
    const archive = coveredArchive(quietItems(DEFAULT_JUDGED_ARCHIVE_ITEMS + 1), judgedAt);
    const result = await resolveJudgedEntry(syriaEntry(), archive, judgedAt, {
      judgeModels: [absence(['Q1', 'Q2']), absence(['Q1', 'Q3'])],
    });
    assert.equal(result.outcome, 'VOID');
    assert.deepEqual(result.evidence.judgments.map((row) => row.reason), ['absence_selection_truncated', 'absence_selection_truncated']);
  });

  it('tells the judges that quiet on-subject coverage is NO by absence, not VOID', () => {
    const { systemPrompt } = buildJudgedResolutionPrompt(syriaEntry(), [], judgedAt);
    assert.match(systemPrompt, /no item reports the event, answer NO with basis absence, not VOID/);
  });
});

describe('archive completeness and cutover (#8990)', () => {
  it('makes no judge call when the archive does not cover the window', async () => {
    const archive = coveredArchive([item('N1', 'Airstrike kills 12 in northern Syria', DEADLINE - DAY_MS)], judgedAt, {
      coverageStartMs: DEADLINE - 2 * DAY_MS,
    });
    const result = await resolveJudgedEntry(syriaEntry(), archive, judgedAt, { judgeModels: [refusingJudge(), refusingJudge()] });
    assert.equal(result.status, 'pending');
    assert.equal(result.reason, 'archive_incomplete');
  });

  it('judges from the dedicated archive only, with no environment flag, and never reads the accumulator', async () => {
    const calls = [];
    const result = await readJudgedNewsArchiveForLedger({ row: syriaEntry() }, judgedAt, {
      redisUrl: 'https://redis.example',
      redisToken: 'token',
      env: {},
      fetchFn: async (url, init) => {
        calls.push(JSON.parse(init.body));
        return new Response(JSON.stringify(calls.length === 1 ? { result: null } : { result: [] }), { status: 200 });
      },
    });
    assert.equal(result.available, false);
    assert.ok(calls.every((command) => !JSON.stringify(command).includes('digest:accumulator')), 'the legacy accumulator must not be read');
  });

  it('does not count rows still inside the reporting grace as overdue', async () => {
    const inGrace = syriaEntry({ deadline: Date.now() - HOUR_MS, spec: { ...syriaEntry().spec, deadline: Date.now() - HOUR_MS } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ result: null }), { status: 200 });
    process.env.UPSTASH_REDIS_REST_URL ??= 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN ??= 'token';
    try {
      const health = await buildJudgedLaneHealthPatch({ row: inGrace }, Date.now(), { archiveReadable: false });
      assert.equal(health.pendingJudgePastDeadline, 0);
      assert.deepEqual(health.reasons, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
