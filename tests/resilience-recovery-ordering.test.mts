import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RESILIENCE_DIMENSION_DOMAINS,
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DIMENSION_WEIGHTS,
  RESILIENCE_DOMAIN_ORDER,
  getResilienceDomainWeight,
  scoreAllDimensions,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { RESILIENCE_FIXTURES } from './helpers/resilience-fixtures.mts';

// Sensitivity proxy: the recovery-domain weight rebalance (PR 2 §3.4)
// must not disturb the NO > US > YE country ordering on the committed
// fixture. Plan §6 sets a ≥0.85 Spearman rank-correlation gate against
// the live post-PR-0 ranking; that check runs post-merge against real
// seed data (snapshot committed as docs/snapshots/resilience-ranking-
// live-post-pr2-<date>.json). This file is the pre-merge proxy — with
// only 3 fixture countries, strict ordering preservation is the
// strongest signal we can compute without live data.

function overallScore(scoreMap: Record<string, { score: number; coverage: number }>): number {
  function round(v: number, d = 2) { return Number(v.toFixed(d)); }
  let overall = 0;
  for (const domainId of RESILIENCE_DOMAIN_ORDER) {
    const dims = RESILIENCE_DIMENSION_ORDER
      .filter((id) => RESILIENCE_DIMENSION_DOMAINS[id] === domainId)
      .map((id) => ({ id, score: round(scoreMap[id].score), coverage: round(scoreMap[id].coverage) }));
    let totalW = 0, sum = 0;
    for (const d of dims) {
      const w = (RESILIENCE_DIMENSION_WEIGHTS as Record<string, number>)[d.id] ?? 1.0;
      const eff = d.coverage * w;
      totalW += eff;
      sum += d.score * eff;
    }
    const cwMean = totalW ? sum / totalW : 0;
    overall += round(cwMean) * getResilienceDomainWeight(domainId);
  }
  return round(overall);
}

describe('resilience fixture country ordering (PR 2 §3.4 sensitivity proxy)', () => {
  it('NO > US > YE on overall score after the weight rebalance', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const [no, us, ye] = await Promise.all([
      scoreAllDimensions('NO'),
      scoreAllDimensions('US'),
      scoreAllDimensions('YE'),
    ]);
    const noScore = overallScore(no);
    const usScore = overallScore(us);
    const yeScore = overallScore(ye);
    assert.ok(noScore > usScore,
      `fixture ordering broken: NO overall=${noScore} must exceed US overall=${usScore}. ` +
      `The PR 2 §3.4 weight rebalance is expected to preserve country ranks — verify against the live snapshot.`);
    assert.ok(usScore > yeScore,
      `fixture ordering broken: US overall=${usScore} must exceed YE overall=${yeScore}.`);
  });

  it('NO > US > YE on recovery-domain score after the weight rebalance', async () => {
    installRedis(RESILIENCE_FIXTURES);
    const recoveryOf = async (iso: string) => {
      const scoreMap = await scoreAllDimensions(iso);
      const dims = RESILIENCE_DIMENSION_ORDER
        .filter((id) => RESILIENCE_DIMENSION_DOMAINS[id] === 'recovery')
        .map((id) => ({ id, score: scoreMap[id].score, coverage: scoreMap[id].coverage }));
      let totalW = 0, sum = 0;
      for (const d of dims) {
        const w = (RESILIENCE_DIMENSION_WEIGHTS as Record<string, number>)[d.id] ?? 1.0;
        const eff = d.coverage * w;
        totalW += eff;
        sum += d.score * eff;
      }
      return totalW ? sum / totalW : 0;
    };
    const [noR, usR, yeR] = await Promise.all([recoveryOf('NO'), recoveryOf('US'), recoveryOf('YE')]);
    assert.ok(noR > usR, `recovery rebalance regressed NO > US (NO=${noR.toFixed(2)}, US=${usR.toFixed(2)})`);
    assert.ok(usR > yeR, `recovery rebalance regressed US > YE (US=${usR.toFixed(2)}, YE=${yeR.toFixed(2)})`);
  });
});
