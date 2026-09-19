'use strict';

// Jev in SHADOW beside the relay's classify seed.
//
// The LLM chain labels every headline exactly as it does without this module.
// After a chunk's labels are cached and its alerts published, Jev is asked the
// level question about the same Latin-script headlines, and each disagreement
// is appended to a capped Redis list. Nothing Jev says reaches a label, a
// cache row or an alert. With TYPESAFE_API_KEY unset the observer returns null
// without a request.
//
// In a deployment TYPESAFE_API_KEY belongs on the `ais-relay` Railway service,
// the only deployed process that runs this file (the local eval script reads
// the same variable for its own live calls). Look for `[Classify] Jev shadow <variant>: asked ...` in
// its logs to confirm it is on.
//
// Why shadow and not labeller: on 413 blind-judged headlines Jev-as-labeller
// TIED the fixed LLM (#8341) on alerts, and a tie does not justify a second
// labeller. The two miss DIFFERENT headlines, though, so their disagreements
// are the cheapest way to find where either is wrong, on live traffic, without
// paying an annotator for every title. Review them with
// scripts/eval-jev-classify.mjs --shadow-report.
//
// Lives outside ais-relay.cjs because the relay boots a live server on
// require, so nothing inside it can be unit-tested.

const { JEV_ENDPOINT, buildJevRequest, parseJevAnswers, hasNonLatinLetters } = require('../../shared/jev-classify.js');

const SHADOW_LOG_KEY = 'classify:jev-shadow:v1';
// Newest-first, trimmed on every push. ~30% of headlines disagree on level, so
// 2,000 rows is a few days at current volume; the TTL drops an abandoned log.
const SHADOW_LOG_MAX = 2000;
const SHADOW_LOG_TTL_S = 14 * 24 * 60 * 60;

// TypeSafe allows 1,200 req/min. At the measured 374ms p50, 6 in flight is
// ~16 req/s (~960/min); 16 in flight would be ~2,500/min.
const JEV_CONCURRENCY = 6;
const JEV_TIMEOUT_MS = 5_000;
const JEV_RETRY_STATUSES = new Set([429, 529]);
const JEV_MAX_RETRY_WAIT_MS = 5_000;
// This many CONSECUTIVE titles with no Jev answer means it is down, browning
// out or the key is bad; stop paying its timeout per title for a while. The
// streak carries across chunks: a warm cache leaves chunks of one or two
// titles, which would never trip a per-chunk count.
const JEV_BREAKER_MIN_ATTEMPTS = 5;
const JEV_BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
const JEV_USER_AGENT = 'WorldMonitor-Relay/1.0';

const jevApiKey = (env = process.env) => (typeof env.TYPESAFE_API_KEY === 'string' ? env.TYPESAFE_API_KEY.trim() : '');

async function fetchJevLabel(title, maxTextChars, {
  apiKey, fetchFn = fetch, timeoutMs = JEV_TIMEOUT_MS, retryDelayMs = 1000,
} = {}) {
  const body = JSON.stringify(buildJevRequest([title], { maxTextChars, levelOnly: true }));
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp;
    try {
      resp = await fetchFn(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': JEV_USER_AGENT },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
    if (resp.ok) {
      const [label] = parseJevAnswers(await resp.json().catch(() => null), 1, { levelOnly: true });
      return label ?? null;
    }
    resp.body?.cancel?.().catch(() => {});
    if (!JEV_RETRY_STATUSES.has(resp.status) || attempt === 1) return null;
    // Spending the one retry before the provider's cooldown ends wastes it; a
    // long cooldown is not worth waiting out for an observation.
    const retryAfterMs = Number(resp.headers?.get?.('retry-after')) * 1000;
    if (retryAfterMs > JEV_MAX_RETRY_WAIT_MS) return null;
    await new Promise((r) => setTimeout(r, Math.max(retryAfterMs || 0, retryDelayMs * (0.5 + Math.random()))));
  }
  return null;
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const isAlertLevel = (level) => level === 'critical' || level === 'high';

/**
 * observe(variant, [{ title, level }]) -> { asked, answered, agreed, alertFlips } | null.
 * `level` is the label the LLM chain already cached. Never throws: an
 * observation failing must not cost the classify loop anything but time.
 */
function createShadowObserver({ env = process.env, fetchJevLabel: fetchLabel, record, warn = console.warn, now = Date.now }) {
  let pausedUntil = 0;
  let unansweredStreak = 0;

  return async function observe(variant, labelled, maxTextChars = 200) {
    if (!jevApiKey(env) || now() < pausedUntil) return null;
    const subjects = labelled.filter((entry) => !hasNonLatinLetters(entry.title));
    if (subjects.length === 0) return null;

    const answers = await mapWithConcurrency(subjects, JEV_CONCURRENCY, async (entry) => {
      try { return await fetchLabel(entry.title, maxTextChars); } catch { return null; }
    });

    const tally = { asked: subjects.length, answered: 0, agreed: 0, alertFlips: 0 };
    let longestStreak = unansweredStreak;
    for (let i = 0; i < subjects.length; i++) {
      const answer = answers[i];
      // Consecutive, in title order, across chunks: counted per chunk, one
      // answer among 49 timeouts reset the streak and the pause never came.
      if (!answer) { unansweredStreak += 1; longestStreak = Math.max(longestStreak, unansweredStreak); continue; }
      unansweredStreak = 0;
      tally.answered += 1;
      const { title, level } = subjects[i];
      if (answer.l === level) { tally.agreed += 1; continue; }
      const alertFlip = isAlertLevel(answer.l) !== isAlertLevel(level);
      if (alertFlip) tally.alertFlips += 1;
      try {
        await record({ at: now(), variant, title, llm: level, jev: answer.l, pAlert: Math.round(answer.pAlert * 100) / 100, alertFlip });
      } catch { /* an unrecorded disagreement is a lost observation, nothing more */ }
    }

    if (longestStreak >= JEV_BREAKER_MIN_ATTEMPTS) {
      warn(`[Classify] Jev shadow answered none of the last ${JEV_BREAKER_MIN_ATTEMPTS} titles in a row; pausing it for ${JEV_BREAKER_COOLDOWN_MS / 60000}min`);
      pausedUntil = now() + JEV_BREAKER_COOLDOWN_MS;
      unansweredStreak = 0;
    }
    return tally;
  };
}

module.exports = {
  createShadowObserver,
  fetchJevLabel,
  jevApiKey,
  SHADOW_LOG_KEY,
  SHADOW_LOG_MAX,
  SHADOW_LOG_TTL_S,
};
