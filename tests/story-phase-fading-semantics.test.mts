/**
 * StoryPhase.FADING semantics — issue #7081.
 *
 * The wire enum and the proto documentation promised a FADING phase derived
 * from `currentScore < 0.5 * peakScore`. This suite records the outcome of the
 * bounded lifecycle study that issue asked for: a no-go, backed by frozen
 * production evidence in tests/fixtures/story-phase-fading-study.json.
 *
 * The tests are the durable half of that result. They prove the three findings
 * against the SHIPPING scoring function rather than a restatement of it, lock
 * the phases that do ship, and fail if someone reactivates FADING in the feed
 * digest without new evidence.
 *
 * Run: npx tsx --test tests/story-phase-fading-semantics.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest.ts';
import {
  ACCEPTANCE,
  assessCandidate,
  evaluateCandidates,
  firesDocumentedRule,
  loadStudy,
  recencyOnlyRatio,
  severityDynamicRange,
  verifyIntegrity,
} from '../scripts/study-story-phase-fading.mjs';

const { derivePhase, computeImportanceScore } = __testing__;
const __dirname = dirname(fileURLToPath(import.meta.url));
const study = loadStudy();

const HOUR = 60 * 60 * 1000;
/** An unrecognised feed name falls to source tier 4 (25 points). */
const TIER4 = '__unknown_feed_for_tier_4__';

/** The documented rule, exactly as the proto comment described it. */
function documentedRule(currentScore: number, peakScore: number): boolean {
  return currentScore > 0 && peakScore > 0 && currentScore < peakScore * 0.5;
}

describe('#7081 frozen evidence — provenance and integrity', () => {
  it('records the repository ref, capture window, eligibility and sanitization', () => {
    assert.equal(study.schema, 'worldmonitor-story-phase-fading-study/v1');
    assert.equal(study.issue, 7081);
    assert.match(study.repositoryRef, /^[0-9a-f]{40}$/, 'repositoryRef must be a full commit sha');
    assert.match(study.captureUtc, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'captureUtc must be UTC ISO-8601');
    assert.ok(study.eligibility.length > 40, 'eligibility rule must be recorded');
    assert.ok(study.sanitization.length > 40, 'sanitization rule must be recorded');
    assert.ok(Array.isArray(study.source.keys) && study.source.keys.length >= 3);
    assert.equal(study.source.access, 'read-only');
  });

  it('row payload matches the recorded sha256', () => {
    const integrity = verifyIntegrity(study);
    assert.equal(integrity.ok, true,
      `fixture rows sha256 ${integrity.actual} != recorded ${integrity.expected}`);
    assert.equal(integrity.evidenceOk, true,
      `fixture evidence sha256 ${integrity.evidenceActual} != recorded ${integrity.evidenceExpected}`);
  });

  it('rejects verdict-driving aggregate mutations', () => {
    const mutated = structuredClone(study);
    mutated.populationAggregates = {
      ...mutated.populationAggregates,
      firesThatAreCriticalOrHigh: mutated.populationAggregates.firesThatAreCriticalOrHigh + 1,
    };
    const integrity = verifyIntegrity(mutated);
    assert.equal(integrity.rowsOk, true, 'the row digest should remain unchanged');
    assert.equal(integrity.evidenceOk, false,
      'changing a top-level verdict input must invalidate the frozen evidence');
  });

  it('holds at least the required number of trajectories, with the adverse examples', () => {
    assert.ok(study.rows.length >= ACCEPTANCE.minTrajectories,
      `study has ${study.rows.length} rows, below the ${ACCEPTANCE.minTrajectories} minimum`);
    const required = [
      'serving_now',              // the population derivePhase actually runs on
      'active_high_severity',     // the control that must never be labelled fading
      'renewed_after_a_day',      // renewed coverage
      'low_severity_followup',    // low-severity follow-ups
      'multi_day',                // multi-day events
      'silent_over_24h',          // genuinely quiet stories
    ];
    for (const stratum of required) {
      assert.ok((study.retainedStrataCounts[stratum] ?? 0) > 0,
        `frozen set must contain the ${stratum} adverse example`);
      assert.ok(study.strataDefinitions[stratum],
        `${stratum} must have a recorded definition`);
    }
  });

  it('carries no upstream free text and no absolute clock values', () => {
    const banned = ['title', 'link', 'description', 'snippet', 'source', 'url', 'feed'];
    for (const row of study.rows) {
      for (const key of Object.keys(row)) {
        assert.ok(!banned.includes(key), `row must not carry a ${key} field`);
      }
      // Offsets, never wall-clock timestamps: an absolute epoch-ms value would
      // be ~1.7e12 and would silently re-date the fixture against a live clock.
      for (const key of ['ageMs', 'silentMs', 'pubAgeMs']) {
        const v = row[key];
        if (v === null || v === undefined) continue;
        assert.ok(Number.isInteger(v), `${key} must be an integer for a reproducible hash`);
        assert.ok(Math.abs(v) < 1e12, `${key}=${v} looks like an absolute timestamp, not an offset`);
      }
    }
  });
});

describe('#7081 finding 1 — the documented rule was unreachable', () => {
  const writerSrc = readFileSync(
    resolve(__dirname, '..', 'server', 'worldmonitor', 'news', 'v1', 'list-feed-digest.ts'),
    'utf-8',
  );

  it('no production row ever carried a peakScore hash field', () => {
    assert.equal(study.populationAggregates.hashPeakScorePresent, 0,
      'a story:track hash now carries peakScore — finding 1 must be re-checked');
    assert.equal(study.populationAggregates.sampledRows,
      study.populationAggregates.zsetPeakPositive,
      'every sampled row should have a positive peak in the story:peak ZSet');
  });

  it('the peak is written to the ZSet, never to the track hash', () => {
    const fields = __testing__.buildStoryTrackHsetFields(
      { title: 't', link: 'l', level: 'high', lang: 'en', description: '', publishedAt: 1,
        entityCorroborationCount: 0, isOpinion: false, isFeelGood: false,
        isEphemeralLiveCoverage: false, category: 'world' } as never,
      '123', 42,
    );
    assert.ok(!fields.includes('peakScore'),
      'buildStoryTrackHsetFields must not write peakScore — the peak lives in story:peak:v1');
    assert.ok(fields.includes('currentScore'),
      'currentScore IS written every cycle; the old "zero placeholder" comment was wrong about it');
    assert.match(writerSrc, /ZADD', peakKey, 'GT'/,
      'the peak must still be maintained in the ZSet for other consumers');
  });

  it('currentScore was positive on every sampled row, contradicting the old comment', () => {
    assert.equal(study.populationAggregates.currentScorePositive,
      study.populationAggregates.sampledRows);
  });

  it('the digest read path no longer requests the phantom field', () => {
    const readerStart = writerSrc.indexOf('async function readStoryTracks');
    const reader = writerSrc.slice(readerStart, writerSrc.indexOf('\n}', readerStart));
    assert.ok(!/const fields = \[[^\]]*peakScore/.test(reader),
      'readStoryTracks must not HMGET peakScore — nothing writes that field');
  });
});

describe('#7081 finding 2 — the ratio tracks severity class, not traction', () => {
  it('critical and high cannot reach half their peak without a severity change', () => {
    for (const sev of ['critical', 'high'] as const) {
      const r = severityDynamicRange(sev);
      assert.equal(r.canFire, false,
        `${sev} min/max is ${r.minOverMax.toFixed(3)} — it must stay above the 0.5 threshold`);
    }
  });

  it('info, low and medium cross it on the score floor alone', () => {
    for (const sev of ['medium', 'low', 'info'] as const) {
      assert.equal(severityDynamicRange(sev).canFire, true);
    }
  });

  it('the shipping score function reproduces the analytic range', () => {
    const now = Date.now();
    // Same story, same source, same corroboration — only the article's age moves.
    const fresh = computeImportanceScore('info', TIER4, 1, now);
    const aged = computeImportanceScore('info', TIER4, 1, now - 30 * HOUR);
    assert.equal(fresh, 18, 'an info/tier-4/single-source item scores 18 while fresh');
    assert.equal(aged, 8, 'and 8 once the article passes the 24h recency horizon');
    assert.ok(documentedRule(aged, fresh),
      'so the documented rule fires on article age alone, with no change in attention');
    const analytic = recencyOnlyRatio('info', 25, 20);
    assert.ok(Math.abs(analytic.ratio - aged / fresh) < 1e-9,
      'the analytic recency-only ratio must match the shipping function');
  });

  it('the same age change cannot fire the rule on a critical story', () => {
    const now = Date.now();
    const fresh = computeImportanceScore('critical', TIER4, 1, now);
    const aged = computeImportanceScore('critical', TIER4, 1, now - 30 * HOUR);
    assert.ok(aged < fresh, 'the critical score still decays with article age');
    assert.equal(documentedRule(aged, fresh), false,
      'but the severity term dominates, so it never reaches half its peak');
  });

  it('fires while attention is unchanged — only the article aged', () => {
    const now = Date.now();
    // The same single publisher, the same story, the same everything. The only
    // difference is that the article passed the 24h recency horizon. This is
    // the shape of the 660 info-severity firings in the frozen population.
    const peak = computeImportanceScore('info', TIER4, 1, now);
    const current = computeImportanceScore('info', TIER4, 1, now - 30 * HOUR);
    assert.ok(documentedRule(current, peak),
      'nothing about the coverage changed, yet the story is reported as losing traction');
  });

  it('fires on a story whose corroboration went UP fivefold', () => {
    const now = Date.now();
    // Peak set while the story read as `high` from one tier-1 publisher. Now
    // FIVE tier-1 publishers carry it — attention is plainly accelerating — but
    // the keyword classifier has since read it as `info` and the article aged.
    // The severity term is 55% of the score, so the flip swamps the corroboration
    // gain and the rule fires on a story that is being covered five times harder.
    const peak = computeImportanceScore('high', 'Reuters', 1, now);
    const current = computeImportanceScore('info', 'Reuters', 5, now - 30 * HOUR);
    assert.ok(documentedRule(current, peak),
      'a fivefold rise in corroborating publishers does not save the story from '
      + 'being labelled fading — the rule is dominated by severity reclassification');
  });

  it('a critical story downgraded to high crosses the threshold', () => {
    const now = Date.now();
    // The highest-cost case: the story is still HIGH severity and still active,
    // but its peak was set while it read as critical. The client alert gate
    // suppresses fading, so activating this rule would pull the banner from a
    // live high-severity story — exactly what the issue forbids.
    const peak = computeImportanceScore('critical', 'Reuters', 5, now);
    const current = computeImportanceScore('high', TIER4, 1, now - 30 * HOUR);
    assert.ok(documentedRule(current, peak),
      'a critical->high reclassification reaches half the peak');
    assert.equal(severityDynamicRange('high').canFire, false,
      'note this is reachable only ACROSS a severity change, never within `high` itself');
  });

  it('no critical or high production row fired, across the whole sampled population', () => {
    assert.equal(study.populationAggregates.firesThatAreCriticalOrHigh, 0);
    assert.ok(study.populationAggregates.criticalOrHighRows > 100,
      'the control group must be large enough for that zero to mean something');
    const agg = study.populationAggregates;
    const infoLowShare = agg.firesThatAreInfoOrLow / agg.firesUnderDocumentedRule;
    assert.ok(infoLowShare > 0.95,
      `${(infoLowShare * 100).toFixed(1)}% of firings are info/low — the rule targets `
      + 'unimportant items, so it cannot meet the precision bar for "losing traction"');
  });

  it('the frozen control rows are individually clean', () => {
    const controls = study.rows.filter((r) => r.strata.includes('active_high_severity'));
    assert.ok(controls.length >= 10, 'need a real control group');
    for (const row of controls) {
      assert.equal(firesDocumentedRule(row), false,
        `active high-severity row ${row.id} would have been labelled fading`);
    }
  });
});

describe('#7081 finding 3 — fading is not observable at this call site', () => {
  it('derivePhase only ever sees stories present in the current cycle', () => {
    const agg = study.populationAggregates;
    assert.ok(agg.notServingRows > agg.servingNowRows,
      'most tracked stories are absent from any given cycle — those never reach derivePhase');
    assert.ok(agg.servingNowMaxSilentMs <= 30 * 60 * 1000,
      'and everything derivePhase does see was seen within the current cycle');
  });

  it('the handler passes a track whose lastSeen is the current cycle clock', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'server', 'worldmonitor', 'news', 'v1', 'list-feed-digest.ts'),
      'utf-8',
    );
    const mergedStart = src.indexOf('const merged: StoryTrack = {');
    assert.ok(mergedStart > 0, 'the merged track must still be built for the phase');
    const merged = src.slice(mergedStart, src.indexOf('};', mergedStart));
    assert.match(merged, /lastSeen:\s*now/,
      'lastSeen is the current cycle time, so "time since last appearance" is 0 by construction');
  });

  it('every proposed alternative is evaluated and none is accepted', () => {
    const candidates = evaluateCandidates(study);
    const ids = candidates.map((c) => c.id);
    for (const required of ['documented-score-ratio', 'time-since-last-appearance',
      'mention-velocity', 'publisher-narrowing']) {
      assert.ok(ids.includes(required), `the study must evaluate ${required}`);
    }
    for (const c of candidates) {
      assert.notEqual(c.verdict, 'accept', `${c.id} must not be accepted without new evidence`);
      assert.ok(c.reason.length > 40, `${c.id} must record why it was rejected`);
    }
  });

  it('derives candidate verdicts from the acceptance bar', () => {
    const documented = evaluateCandidates(study).find((c) => c.id === 'documented-score-ratio');
    assert.ok(documented);
    assert.equal(documented.verdict, 'reject');
    assert.equal(documented.precision, 3 / 673);
    assert.equal(documented.activeHighSeverityFalsePositives, 0);

    assert.equal(assessCandidate({
      precision: ACCEPTANCE.minFadingPrecision,
      activeHighSeverityFalsePositives: ACCEPTANCE.maxActiveHighSeverityFalsePositives,
    }).verdict, 'accept');
    assert.equal(assessCandidate({
      precision: ACCEPTANCE.minFadingPrecision - 0.01,
      activeHighSeverityFalsePositives: 0,
    }).verdict, 'reject');
    assert.equal(assessCandidate({
      precision: 1,
      activeHighSeverityFalsePositives: ACCEPTANCE.maxActiveHighSeverityFalsePositives + 1,
    }).verdict, 'reject');
  });

  it('the seeder, which CAN see silence, already has a working fading rule', () => {
    const seeder = readFileSync(
      resolve(__dirname, '..', 'scripts', 'seed-digest-notifications.mjs'), 'utf-8');
    assert.match(seeder, /deriveNotificationStoryPhase/,
      'the notification seeder derives fading via shared/story-phase.js');
  });
});

describe('#7081 no-go contract — the feed digest must not emit FADING', () => {
  it('never returns FADING for any frozen production row', () => {
    const now = Date.now();
    // The track carries this row's REAL currentScore and peak alongside the
    // fields derivePhase reads today. They are surplus to the current signature
    // on purpose: if anyone reinstates a score branch, these rows feed it the
    // production values that made 673 of them fire, and this test goes red.
    const firing = study.rows.filter(firesDocumentedRule);
    assert.ok(firing.length > 50,
      `only ${firing.length} frozen rows satisfy the old rule — this guard needs rows that would fire`);
    for (const row of study.rows) {
      const track = {
        firstSeen: now - row.ageMs,
        lastSeen: now - row.silentMs,
        mentionCount: row.mc,
        sourceCount: Math.max(1, row.srcSet),
        currentScore: row.cur,
        peakScore: row.peak,
      };
      const phase = derivePhase(track as unknown as Parameters<typeof derivePhase>[0], now);
      assert.notEqual(phase, 'STORY_PHASE_FADING',
        `row ${row.id} (sev=${row.sev}, cur=${row.cur}, peak=${row.peak}) was labelled fading`);
    }
  });

  it('never returns FADING for adversarial score-collapse tracks', () => {
    const now = Date.now();
    // The exact shape the old rule was built to catch: a long-lived story whose
    // current score has collapsed to a fraction of its peak.
    for (const mentionCount of [2, 6, 50, 1700]) {
      for (const ageH of [1, 3, 30, 200]) {
        const phase = derivePhase({
          firstSeen: now - ageH * HOUR,
          lastSeen: now,
          mentionCount,
          sourceCount: 1,
        }, now);
        assert.notEqual(phase, 'STORY_PHASE_FADING');
      }
    }
  });

  it('the phase deriver carries no score input at all', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'server', 'worldmonitor', 'news', 'v1', 'list-feed-digest.ts'),
      'utf-8',
    );
    const start = src.indexOf('function derivePhase(');
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.ok(!body.includes('currentScore') && !body.includes('peakScore'),
      'derivePhase must not reference a score — reintroducing one reopens the #7081 no-go');
    assert.ok(!body.includes('STORY_PHASE_FADING'),
      'derivePhase must not emit FADING');
  });
});

describe('#7081 regression locks — the phases that DO ship', () => {
  const now = 1_800_000_000_000; // fixed clock; derivePhase takes nowMs explicitly
  const track = (mentionCount: number, ageMs: number, lastSeenAgoMs = 0) => ({
    firstSeen: now - ageMs,
    lastSeen: now - lastSeenAgoMs,
    mentionCount,
    sourceCount: 1,
  });

  it('a first appearance is BREAKING', () => {
    assert.equal(derivePhase(track(1, 0), now), 'STORY_PHASE_BREAKING');
    assert.equal(derivePhase(track(0, 5 * HOUR), now), 'STORY_PHASE_BREAKING');
  });

  it('2-5 mentions inside two hours is DEVELOPING', () => {
    assert.equal(derivePhase(track(2, 1), now), 'STORY_PHASE_DEVELOPING');
    assert.equal(derivePhase(track(5, 2 * HOUR - 1), now), 'STORY_PHASE_DEVELOPING');
  });

  it('the DEVELOPING boundaries are exact', () => {
    // Exactly two hours old is no longer developing.
    assert.equal(derivePhase(track(5, 2 * HOUR), now), 'STORY_PHASE_SUSTAINED');
    // A sixth mention leaves developing even while fresh.
    assert.equal(derivePhase(track(6, 1), now), 'STORY_PHASE_SUSTAINED');
  });

  it('a long-running story is SUSTAINED', () => {
    assert.equal(derivePhase(track(40, 9 * HOUR), now), 'STORY_PHASE_SUSTAINED');
    assert.equal(derivePhase(track(1700, 200 * HOUR), now), 'STORY_PHASE_SUSTAINED');
  });

  it('renewed coverage after a long silence is SUSTAINED, never FADING', () => {
    // Reappearing after three days of quiet is renewal, the adverse example the
    // issue called out — it must not be reported as losing traction.
    const phase = derivePhase(track(30, 120 * HOUR, 0), now);
    assert.equal(phase, 'STORY_PHASE_SUSTAINED');
    const renewed = study.rows.filter((r) => r.strata.includes('renewed_after_a_day'));
    assert.ok(renewed.length > 0, 'the frozen set must contain renewed-coverage rows');
  });

  it('is deterministic — the injected clock fully controls the boundary', () => {
    const a = derivePhase(track(3, 90 * 60 * 1000), now);
    const b = derivePhase(track(3, 90 * 60 * 1000), now);
    assert.equal(a, b);
    assert.equal(a, 'STORY_PHASE_DEVELOPING');
    // The same track read two hours later has crossed into SUSTAINED.
    assert.equal(derivePhase(track(3, 90 * 60 * 1000), now + 2 * HOUR), 'STORY_PHASE_SUSTAINED');
  });
});

describe('#7081 consumers — FADING stays wire-compatible', () => {
  const read = (...p: string[]) => readFileSync(resolve(__dirname, '..', ...p), 'utf-8');

  it('the proto keeps the enum value and its number', () => {
    const proto = read('proto', 'worldmonitor', 'news', 'v1', 'news_item.proto');
    assert.match(proto, /STORY_PHASE_FADING\s*=\s*4;/,
      'the wire value must not be removed or renumbered');
  });

  it('the generated client and server still carry the value', () => {
    for (const side of ['client', 'server']) {
      const gen = read('src', 'generated', side, 'worldmonitor', 'news', 'v1',
        side === 'client' ? 'service_client.ts' : 'service_server.ts');
      assert.match(gen, /"STORY_PHASE_FADING"/);
    }
  });

  it('the client still maps the value rather than falling through', () => {
    const loader = read('src', 'app', 'data-loader.ts');
    assert.match(loader, /STORY_PHASE_FADING:\s*'fading'/,
      'an unmapped FADING would silently render as breaking');
  });

  it('the alert gate still suppresses a fading story', () => {
    const alerts = read('src', 'services', 'breaking-news-alerts.ts');
    assert.match(alerts, /phase === 'sustained' \|\| phase === 'fading'/,
      'the banner gate must keep handling fading defensively');
  });

  it('MCP passes the phase through untouched', () => {
    const rpc = read('api', 'mcp', 'registry', 'rpc-tools.ts');
    assert.match(rpc, /storyPhase = item\.storyMeta\.phase/);
    assert.match(rpc, /STORY_PHASE_FADING/, 'the MCP schema must keep advertising the enum value');
  });

  it('the MCP description states that the digest does not emit it', () => {
    const rpc = read('api', 'mcp', 'registry', 'rpc-tools.ts');
    assert.match(rpc, /STORY_PHASE_FADING is reserved and is not currently emitted/,
      'agents must be told the value never arrives from this surface');
  });

  it('the news panel renders no fading badge, and the stylesheet agrees', () => {
    // Documented gap rather than a silent one: FADING is unemitted here, so no
    // badge is correct. This assertion fails loudly if a badge is added without
    // the phase being reactivated, or vice versa.
    const panel = read('src', 'components', 'NewsPanel.ts');
    assert.ok(!panel.includes("phase === 'fading'"),
      'a fading badge implies an emitted phase — reactivate the phase first');
    const css = read('src', 'styles', 'main.css');
    assert.ok(!css.includes('.phase-badge.fading'),
      'no fading badge style while the phase is unemitted');
  });
});
