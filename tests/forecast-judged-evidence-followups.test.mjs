// Follow-ups to #8995 (#8990 Phase 2 review): subject disambiguation and
// recall, title-first ranking, the event-word absence floor, the political
// event terms, the SLA clock, the prompt's window start, blanked-link writes,
// the scorecard's overdue count and the generatedAt branch of the window.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  JUDGED_EVIDENCE_GRACE_MS,
  JUDGED_EVIDENCE_MAX_LOOKBACK_MS,
  buildJudgedResolutionPrompt,
  judgedArchiveHorizonMs,
  judgedArchiveWindowForEntry,
  judgedSubjectKind,
  resolveJudgedEntry,
  selectJudgedArchiveItems,
} from '../scripts/seed-forecast-resolutions.mjs';
import { computeScorecard, DEFAULT_JUDGED_SLA_MS } from '../scripts/_forecast-scorecard.mjs';
import { buildForecastEvidenceRecordWrite, FORECAST_EVIDENCE_KEEP_LINK_SCRIPT } from '../scripts/_forecast-evidence-archive.mjs';
import { EMITTED_REGION_LABELS } from '../scripts/seed-forecasts.mjs';
import { buildJudgedSubjectTerms } from '../scripts/build-judged-subject-terms.mjs';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEADLINE = Date.parse('2026-10-05T23:00:00Z');
const JUDGED_AT = DEADLINE + JUDGED_EVIDENCE_GRACE_MS + HOUR_MS;

function entryFor(region, overrides = {}) {
  return {
    id: `fc-${region}`,
    domain: 'conflict',
    region,
    title: `Active armed conflict: ${region}`,
    generatedAt: DEADLINE - 7 * DAY_MS,
    deadline: DEADLINE,
    status: 'pending-judge',
    spec: { kind: 'judged', deadline: DEADLINE, question: `Did ${region} escalate?` },
    ...overrides,
  };
}

function item(id, title, description = '', publishedAt = DEADLINE - DAY_MS) {
  return { id, title, description, url: `https://news.example/${id}`, publishedAt };
}

function shownIds(region, items, overrides) {
  return selectJudgedArchiveItems(entryFor(region, overrides), items, { nowMs: JUDGED_AT }).map((row) => row.id).sort();
}

function archiveOf(items, overrides = {}) {
  return { available: true, coverageStartMs: JUDGED_AT - JUDGED_EVIDENCE_MAX_LOOKBACK_MS, coverageEndMs: JUDGED_AT, items, ...overrides };
}

describe('N2 subject matching: word boundaries, collisions and recall', () => {
  it('matches whole words only, case-folded', () => {
    assert.deepEqual(shownIds('Mali', [
      item('in', 'MALI junta extends transition'),
      item('somalia', 'Somalia drought worsens'),
      item('animal', 'Animalia exhibit opens'),
    ]), ['in']);
  });

  it('does not take a Texas paper or a beer cartel for the subject', () => {
    assert.deepEqual(shownIds('Black Sea', [
      item('texas', 'DAILY OIL PRICE: Brent edges up', 'Odessa American'),
      item('odesa', 'Drone strike hits a tanker off Odesa'),
    ]), ['odesa']);
    assert.deepEqual(shownIds('Mexico', [
      item('beer', 'Japanese brewers raided over alleged beer price cartel'),
      item('sinaloa', 'Mexican gunmen kill 12 in Sinaloa'),
    ]), ['sinaloa']);
  });

  it('keeps the Black Sea and Korean Peninsula aliases', () => {
    assert.deepEqual(shownIds('Black Sea', [item('crimea', 'Drones hit Crimea fuel depot')]), ['crimea']);
    assert.deepEqual(shownIds('Korean Peninsula', [item('pyongyang', 'Pyongyang fires a ballistic missile')]), ['pyongyang']);
  });

  it('needs a co-term before an ambiguous country name counts', () => {
    assert.deepEqual(shownIds('Georgia', [
      item('state', 'Georgia block party shooting leaves 3 dead'),
      item('tbilisi', 'Police clear protest camp in Tbilisi'),
      item('both', 'Georgia arrests opposition leaders as Moscow watches'),
    ]), ['both', 'tbilisi']);
    assert.deepEqual(shownIds('Jordan', [
      item('mj', "Michael Jordan's sneakers sell for $2m"),
      item('amman', 'Jordan intercepts drones over Amman'),
    ]), ['amman']);
    assert.deepEqual(shownIds('Chad', [
      item('actor', 'Chad Lowe joins the cast'),
      item('border', 'Chad closes its border with Sudan'),
    ]), ['border']);
    assert.deepEqual(shownIds('Niger', [
      item('state', "Miners die in Nigeria's Niger State"),
      item('junta', 'Niger junta expels French envoy'),
    ]), ['junta']);
    assert.deepEqual(shownIds('Guinea', [
      item('bissau', 'Guinea-Bissau votes in a tense election'),
      item('equatorial', 'Equatorial Guinea court jails activist'),
      item('conakry', 'Guinea soldiers deploy in Conakry'),
    ]), ['conakry']);
  });

  it('recognises "US" and "U.K." spellings', () => {
    assert.deepEqual(shownIds('United States', [
      item('us', 'US strikes Houthi targets'),
      item('dotted', 'U.S. Navy shoots down drones'),
      item('pronoun', 'Join us for the weekend market'),
    ]), ['dotted', 'us']);
    assert.deepEqual(shownIds('United Kingdom', [item('uk', 'U.K. sanctions Russian oligarchs')]), ['uk']);
  });

  it('has a subject entry for every region label the forecast emitter can produce', () => {
    const uncovered = EMITTED_REGION_LABELS.filter((label) => judgedSubjectKind(label) === 'fallback');
    assert.deepEqual(uncovered, []);
    assert.ok(EMITTED_REGION_LABELS.includes('Western Pacific'));
    assert.ok(EMITTED_REGION_LABELS.includes('Burkina Faso'), 'CII country names are part of the emitter set');
  });

  it('resolves conflict-feed labels with a parenthetical', () => {
    assert.equal(judgedSubjectKind('DR Congo (Zaire)'), 'country');
    assert.equal(judgedSubjectKind('Yemen (North Yemen)'), 'country');
    assert.equal(judgedSubjectKind('Global'), 'none');
  });

  it('commits the table the generator builds', () => {
    const committed = readFileSync(new URL('../scripts/shared/judged-subject-terms.json', import.meta.url), 'utf8');
    assert.equal(committed, `${JSON.stringify(buildJudgedSubjectTerms(), null, 1)}\n`);
  });
});

describe('N3 title subject matches rank first', () => {
  it('puts a headline about the subject ahead of a roundup that names it only in passing', () => {
    const selected = selectJudgedArchiveItems(entryFor('Syria'), [
      item('roundup', 'Houthis claim missile and drone attacks on Saudi airport', 'Muslims in Syria and Yemen condemned the strikes'),
      item('headline', 'Syria reopens a museum in Damascus'),
    ], { nowMs: JUDGED_AT });
    assert.deepEqual(selected.map((row) => row.id), ['headline', 'roundup']);
  });
});

describe('N4 absence floor counts on-subject reports with an event word', () => {
  const absence = (ids) => async () => ({ provider: 'p', model: 'm', outcome: 'NO', basis: 'absence', citations: ids.map((id) => ({ id, quote: `Mali item ${id}` })), rationale: 'fixture' });

  it('does not count culture and sport items as coverage of a conflict', async () => {
    const items = ['A', 'B', 'C'].map((id) => item(id, `Mali item ${id}: national team wins friendly`));
    const result = await resolveJudgedEntry(entryFor('Mali'), archiveOf(items), JUDGED_AT, { judgeModels: [absence(['A']), absence(['B'])] });
    assert.equal(result.outcome, 'VOID');
    assert.deepEqual(result.evidence.judgments.map((row) => row.reason), ['insufficient_subject_items', 'insufficient_subject_items']);
  });

  it('counts on-subject reports that carry the domain event words', async () => {
    const items = ['A', 'B', 'C'].map((id) => item(id, `Mali item ${id}: ceasefire holds in the north`));
    const result = await resolveJudgedEntry(entryFor('Mali'), archiveOf(items), JUDGED_AT, { judgeModels: [absence(['A']), absence(['B'])] });
    assert.equal(result.outcome, 'NO');
    assert.equal(result.evidence.basis, 'absence');
  });
});

describe('N5 political forecasts rank protest reports', () => {
  it('uses the unrest event words for the political domain', () => {
    const selected = selectJudgedArchiveItems(entryFor('Kenya', { domain: 'political' }), [
      item('weather', 'Kenya braces for heavy rain'),
      item('protest', 'Kenya police fire tear gas at protesters'),
    ], { nowMs: JUDGED_AT });
    assert.equal(selected[0].id, 'protest');
  });
});

describe('N1 judged SLA starts when judging is allowed', () => {
  function judgedRow(resolvedAt) {
    return {
      id: 'fc-sla', status: 'resolved', outcome: 'YES', deadline: DEADLINE, resolvedAt, probability: 0.6,
      spec: { kind: 'judged', deadline: DEADLINE }, evidence: { kind: 'judged', reason: 'dual_model_agreement' },
    };
  }

  it('counts a retry on the second daily run inside the SLA', () => {
    const lastInside = DEADLINE + JUDGED_EVIDENCE_GRACE_MS + DEFAULT_JUDGED_SLA_MS;
    assert.equal(computeScorecard({ a: judgedRow(lastInside) }, lastInside).judgedLane.scoredWithinSla, 1);
    assert.equal(computeScorecard({ a: judgedRow(lastInside + 1) }, lastInside + 1).judgedLane.scoredWithinSla, 0);
  });
});

describe('N9 scorecard overdue count excludes rows inside the grace', () => {
  it('matches the health meta', () => {
    const pending = (deadline) => ({ id: `p${deadline}`, status: 'pending-judge', deadline, probability: 0.5, spec: { kind: 'judged', deadline } });
    const nowMs = DEADLINE + JUDGED_EVIDENCE_GRACE_MS;
    const lane = computeScorecard({ inGrace: pending(DEADLINE + 1), due: pending(DEADLINE) }, nowMs).judgedLane;
    assert.equal(lane.pendingJudgePastDeadline, 1);
  });
});

describe('N6 the prompt states the window the archive served', () => {
  it('starts the stated window at the served coverage start', async () => {
    const coverageStartMs = DEADLINE - 9 * DAY_MS;
    const entry = entryFor('Syria', { generatedAt: DEADLINE - 30 * DAY_MS });
    const { userPrompt } = buildJudgedResolutionPrompt(entry, [], JUDGED_AT, { coverageStartMs });
    assert.ok(userPrompt.includes(`Evidence window: ${new Date(coverageStartMs).toISOString()} to`));
    let seen;
    const capture = async (judgedEntry, items, nowMs, context) => {
      seen = buildJudgedResolutionPrompt(judgedEntry, items, nowMs, context).userPrompt;
      return { outcome: 'VOID', citations: [] };
    };
    await resolveJudgedEntry(entry, archiveOf([item('N1', 'Syria army shells Idlib')], { coverageStartMs }), JUDGED_AT, { judgeModels: [capture, capture] });
    assert.ok(seen.includes(`Evidence window: ${new Date(coverageStartMs).toISOString()} to`));
  });
});

describe('N7 a blanked link never replaces a stored link', () => {
  it('writes a linked member with a plain SET and a blanked one through the keep-link script', () => {
    const linked = buildForecastEvidenceRecordWrite('forecast:evidence:record:v1:h', '{"link":"https://a"}', 'https://a', 1_296_000, 7);
    assert.deepEqual(linked, ['SET', 'forecast:evidence:record:v1:h', '{"link":"https://a"}', 'EX', 1_296_000]);
    const blanked = buildForecastEvidenceRecordWrite('forecast:evidence:record:v1:h', '{"link":""}', '', 1_296_000, 7);
    assert.deepEqual(blanked, ['EVAL', FORECAST_EVIDENCE_KEEP_LINK_SCRIPT, '1', 'forecast:evidence:record:v1:h', '{"link":""}', '1296000', '7']);
  });
});

describe('N8 the required start follows a late generation', () => {
  it('requires coverage from generation when the forecast is younger than a week', () => {
    const entry = entryFor('Syria', { generatedAt: DEADLINE - 3 * DAY_MS });
    assert.equal(judgedArchiveWindowForEntry(entry, JUDGED_AT).requiredStartMs, DEADLINE - 3 * DAY_MS);
    assert.equal(judgedArchiveHorizonMs(entry), DEADLINE - 3 * DAY_MS + JUDGED_EVIDENCE_MAX_LOOKBACK_MS);
  });
});
