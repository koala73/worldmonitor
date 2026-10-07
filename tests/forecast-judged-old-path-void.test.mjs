import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  JUDGED_OLD_SELECTION_VOID_REASON,
  SUBJECT_GATED_SELECTION_SINCE_MS,
  collectUnarchivedReceipts,
  ingestHistory,
  markReceiptsArchived,
  processResolutionCycleWithJudges,
  receiptNeedsRearchive,
  voidOldSelectionJudgedResolutions,
} from '../scripts/seed-forecast-resolutions.mjs';
import { RECEIPT_VOID_REASON_LABELS, buildPublicReceipts, computeScorecard } from '../scripts/_forecast-scorecard.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
// #8995 reached production at 2026-10-07T14:39Z. Pinned here, not read from
// the resolver, so moving the resolver's cutoff fails these tests.
const CUTOFF = Date.parse('2026-10-07T14:39:00Z');
const NOW = CUTOFF + 2 * DAY_MS;

// Shaped like the live rows: fc-conflict-750e2fea@1784631793426 sealed NO on
// 2026-07-22 by dual_model_agreement under the stock-word selection.
function judgedRow(id, { outcome = 'YES', resolvedAt = CUTOFF - 70 * DAY_MS, status = 'resolved', reason = 'dual_model_agreement' } = {}) {
  const deadline = resolvedAt - DAY_MS;
  const question = `Within the 7d horizon, did ${id} experience a materially escalated level of armed conflict versus its recent baseline?`;
  const row = {
    id,
    key: `${id}@${deadline}`,
    domain: 'conflict',
    region: 'Ukraine',
    title: 'Escalation risk: Ukraine',
    timeHorizon: '7d',
    generationOrigin: 'legacy_detector',
    spec: { kind: 'judged', deadline, question },
    probability: 0.332,
    firstSeenProbability: 0.332,
    generatedAt: deadline - 7 * DAY_MS,
    deadline,
    firstSeenAt: deadline - 7 * DAY_MS,
    lastSeenAt: deadline - 7 * DAY_MS,
    lastSeenProbability: 0.332,
    status,
    samples: { count: 0, recent: [] },
  };
  if (status !== 'resolved') return row;
  return {
    ...row,
    outcome,
    resolvedAt,
    sealedAt: resolvedAt,
    evidence: {
      kind: 'judged',
      reason,
      resolvedAt,
      question,
      deadline,
      citations: [{ id: 'N29', title: 'Ukraine fires its military chief', publishedAt: deadline + 10 * 60 * 60 * 1000 }],
      archive: [{ id: 'N29', title: 'Ukraine fires its military chief', publishedAt: deadline + 10 * 60 * 60 * 1000 }],
    },
    receiptArchivedAt: resolvedAt + 60_000,
  };
}

function hardRow(id) {
  const resolvedAt = CUTOFF - 30 * DAY_MS;
  const deadline = resolvedAt - DAY_MS;
  const metricKey = 'conflict:ucdp-events:v1|count(country==Mali)';
  return {
    id,
    key: `${id}@${deadline}`,
    domain: 'conflict',
    region: 'Mali',
    title: 'Active armed conflict: Mali',
    timeHorizon: '7d',
    generationOrigin: 'legacy_detector',
    spec: { kind: 'hard', deadline, metricKey, operator: '>=', threshold: 3, window: 'within-horizon', sourceFeed: 'conflict:ucdp-events:v1' },
    probability: 0.6,
    firstSeenProbability: 0.6,
    generatedAt: deadline - 7 * DAY_MS,
    deadline,
    firstSeenAt: deadline - 7 * DAY_MS,
    lastSeenAt: deadline - 7 * DAY_MS,
    lastSeenProbability: 0.6,
    status: 'resolved',
    samples: { count: 2, recent: [] },
    outcome: 'YES',
    resolvedAt,
    sealedAt: resolvedAt,
    evidence: { metricKey, metricValue: 4, comparison: '4 >= 3', resolvedAt, envelopeAware: true },
    receiptArchivedAt: resolvedAt + 60_000,
  };
}

function liveShapedLedger() {
  const pending = judgedRow('fc-conflict-pending', { status: 'pending-judge' });
  pending.deadline = NOW + 3 * DAY_MS;
  pending.spec.deadline = pending.deadline;
  pending.key = `${pending.id}@${pending.deadline}`;
  const rows = [
    judgedRow('fc-conflict-old-yes', { outcome: 'YES' }),
    judgedRow('fc-conflict-old-no', { outcome: 'NO', resolvedAt: CUTOFF - 1 }),
    judgedRow('fc-conflict-new-yes', { outcome: 'YES', resolvedAt: CUTOFF + 60 * 60 * 1000 }),
    judgedRow('fc-conflict-old-void', { outcome: 'VOID', reason: 'all_judges_void' }),
    hardRow('fc-conflict-hard-yes'),
    pending,
  ];
  return Object.fromEntries(rows.map((row) => [row.key, row]));
}

// The production two-call shape of buildLedgerForRun: ingestHistory, then the
// judged cycle, then the R2 receipt queue and its archive stamp.
async function runLikeProduction(existing, nowMs) {
  const preLedger = ingestHistory(existing, [], nowMs);
  const result = await processResolutionCycleWithJudges(preLedger, [], {}, { items: [], available: false }, nowMs, {
    judgeModels: [async () => null, async () => null],
  });
  const queued = collectUnarchivedReceipts(result.ledger);
  markReceiptsArchived(result.ledger, queued.map(({ key }) => ({ key })), nowMs + 1);
  return { ...result, queued };
}

const byId = (ledger) => Object.fromEntries(Object.values(ledger).map((row) => [row.id, row]));

describe('judged verdicts sealed on the stock-word selection (#8990)', () => {
  it('cuts over at the #8995 deploy', () => {
    assert.equal(SUBJECT_GATED_SELECTION_SINCE_MS, CUTOFF);
  });

  it('voids every old-path judged YES and NO through the production run, keeping the verdict as superseded', async () => {
    const before = byId(liveShapedLedger());
    const { ledger } = await runLikeProduction(liveShapedLedger(), NOW);
    const after = byId(ledger);
    for (const id of ['fc-conflict-old-yes', 'fc-conflict-old-no']) {
      const original = before[id];
      assert.equal(after[id].status, 'resolved', id);
      assert.equal(after[id].outcome, 'VOID', id);
      assert.deepEqual(after[id].evidence, {
        reason: JUDGED_OLD_SELECTION_VOID_REASON,
        resolvedAt: original.resolvedAt,
        supersededOutcome: original.outcome,
        supersededEvidence: original.evidence,
        voidedAt: NOW,
      }, id);
      assert.equal(after[id].resolvedAt, original.resolvedAt, `${id} stays in its rolling window`);
    }
  });

  it('leaves new-path verdicts, earlier VOIDs, hard rows and pending rows untouched', async () => {
    const before = byId(liveShapedLedger());
    const { ledger } = await runLikeProduction(liveShapedLedger(), NOW);
    const after = byId(ledger);
    for (const id of ['fc-conflict-new-yes', 'fc-conflict-old-void', 'fc-conflict-hard-yes']) {
      const { receiptArchivedAt: _a, ...kept } = after[id];
      const { receiptArchivedAt: _b, ...original } = before[id];
      assert.deepEqual(kept, original, id);
    }
    assert.equal(after['fc-conflict-pending'].status, 'pending-judge');
    assert.equal(after['fc-conflict-pending'].supersededOutcome, undefined);
  });

  it('leaves a duplicate window to the window correction, whichever correction reaches the ledger first', async () => {
    const keeper = judgedRow('fc-supply-dup');
    const duplicate = structuredClone(keeper);
    duplicate.generatedAt += 60 * 60 * 1000;
    duplicate.firstSeenAt = duplicate.generatedAt;
    duplicate.deadline += 60 * 60 * 1000;
    duplicate.spec.deadline = duplicate.deadline;
    duplicate.key = `${duplicate.id}@${duplicate.deadline}`;
    duplicate.resolvedAt += DAY_MS;
    duplicate.evidence.resolvedAt = duplicate.resolvedAt;
    const { ledger } = await runLikeProduction({ [keeper.key]: keeper, [duplicate.key]: duplicate }, NOW);
    assert.equal(ledger[keeper.key].evidence.reason, JUDGED_OLD_SELECTION_VOID_REASON);
    assert.equal(ledger[duplicate.key].duplicateOf, keeper.key);
    assert.equal(ledger[duplicate.key].evidence.reason, 'duplicate_window');
    assert.equal(ledger[duplicate.key].evidence.supersededOutcome, 'YES');
  });

  it('is idempotent across runs', async () => {
    const first = await runLikeProduction(liveShapedLedger(), NOW);
    const second = await runLikeProduction(structuredClone(first.ledger), NOW + DAY_MS);
    const a = byId(first.ledger);
    const b = byId(second.ledger);
    for (const id of ['fc-conflict-old-yes', 'fc-conflict-old-no']) {
      assert.deepEqual(b[id].evidence, a[id].evidence, `${id} keeps its first voidedAt`);
    }
    assert.equal(voidOldSelectionJudgedResolutions(structuredClone(first.ledger), NOW + DAY_MS), 0);
  });

  it('queues each voided receipt for R2 re-archive once, through the receiptNeedsRearchive path', async () => {
    const preLedger = ingestHistory(liveShapedLedger(), [], NOW);
    const stale = Object.values(preLedger).filter(receiptNeedsRearchive).map((row) => row.id).sort();
    assert.deepEqual(stale, ['fc-conflict-old-no', 'fc-conflict-old-yes']);
    const { queued, ledger } = await runLikeProduction(liveShapedLedger(), NOW);
    assert.deepEqual(queued.filter(({ entry }) => entry.evidence?.reason === JUDGED_OLD_SELECTION_VOID_REASON).map(({ entry }) => entry.id).sort(), stale);
    assert.equal(Object.values(ledger).some(receiptNeedsRearchive), false, 'the archive stamp clears the correction');
  });

  it('drops the rows from the scored cohort and publishes a labelled VOID receipt', async () => {
    const before = computeScorecard(liveShapedLedger(), NOW);
    const { ledger, scorecard } = await runLikeProduction(liveShapedLedger(), NOW);
    assert.equal(before.totals.scored - scorecard.totals.scored, 2);
    assert.equal(scorecard.totals.void - before.totals.void, 2);
    assert.equal(scorecard.judgedLane.voidByReason[JUDGED_OLD_SELECTION_VOID_REASON], 2);
    const receipt = buildPublicReceipts(ledger, NOW).find((row) => row.voidReason === JUDGED_OLD_SELECTION_VOID_REASON);
    assert.ok(receipt, 'the voided row is published with its own reason');
    assert.equal(RECEIPT_VOID_REASON_LABELS[receipt.voidReason], 'Judged on evidence later found unreliable');
  });

  it('labels the reason on the card chips in every locale', () => {
    const source = readFileSync(new URL('../src/components/forecast-record.ts', import.meta.url), 'utf8');
    assert.match(source, new RegExp(`'${JUDGED_OLD_SELECTION_VOID_REASON}'`));
    const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));
    assert.equal(en.components.forecast.resolution.void[JUDGED_OLD_SELECTION_VOID_REASON], 'Judged on evidence later found unreliable');
  });
});
