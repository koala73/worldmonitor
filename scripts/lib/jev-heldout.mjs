// Jev on the held-out judged set (#8478): the frozen arms, the go/no-go, and the pure
// scoring behind scripts/eval-jev-heldout.mjs.
//
// FROZEN. The Noul questions and thresholds are the ones measured on 2026-09-18 in
// session 820214a2-d7bf-4b03-8c28-01e6f216435a: questions from its v2-collect.mjs
// (transcript line 2085, 13:55Z), rule from line 3352. The held-out titles were judged
// after that. No value in this block changes once a Jev answer on the held-out set
// exists: FROZEN pins the question set, the scoring rule and the fixture, this module
// refuses to load when the first two move, and readCapture refuses the third.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  JEV_ENDPOINT, JEV_MODEL, THREAT_LEVELS, buildJevRequest, hasNonLatinLetters, sanitizeHeadline,
} from '../../shared/jev-classify.js';
import { isAlertLevel, promptSha, scoreAlertLabels } from './classify-eval.mjs';

const { fetchJevLabel } = createRequire(import.meta.url)('./jev-classify-relay.cjs');

export const FROZEN = { questionSetSha: 'e81030c97b184942', ruleSha: '4a5647a4be54cc0f', fixtureSha: 'aa538a252c25da77' };

const noul = (instructions, t, f) => ({ type: 'noul', instructions, criteria: { true: t, false: f } });

export const NOUL_QUESTIONS = {
  commentary: noul(
    'Is `headline` an opinion piece, editorial, column, analysis, explainer, interview, retrospective, review, listicle or how-to guide, rather than a news report that something happened?',
    'Opinion, analysis or explainer. Examples: "Guardian view on the ceasefire", "Why the dollar keeps falling", "How to secure your router".',
    'A report that an event occurred. Examples: "Iran closes Strait of Hormuz", "At least 16 killed in mosque bombing".'),
  worsening: noul(
    'Does `headline` describe a situation getting worse, rather than improving, easing, receding, being contained or being resolved?',
    'Escalation, spread, a new attack, a collapse, rising deaths, a new restriction.',
    'Gains, recovery, passing its peak, slowing, aid arriving, a blockade lifted, an agreement reached, no change.'),
  violence: noul(
    'Does `headline` report armed violence or a deliberate attack that has actually taken place: a military strike, bombing, shooting, armed clash, or terrorist attack?',
    'An attack or strike that occurred.',
    'No violence occurred: threats, warnings, plans, sanctions, protests, accidents, disease, weather.'),
};

export const THRESHOLDS = { pAlert: 0.7, worsening: 0.2, violence: 0.5, commentary: 0.5 };

// answer: { level: { l, levelConf, pAlert } | null, noul: { worsening, violence, commentary } | null }
const v1 = ({ level }) => isAlertLevel(level.l) && level.pAlert >= THRESHOLDS.pAlert;
// Veto only when the story is easing AND reports no violence, or is commentary.
const veto = (a) => v1(a)
  && !(a.noul.worsening < THRESHOLDS.worsening && a.noul.violence < THRESHOLDS.violence)
  && a.noul.commentary < THRESHOLDS.commentary;

export const ARMS = [
  { name: 'jev-argmax', primary: false, needs: ['level'], alert: ({ level }) => isAlertLevel(level.l) },
  { name: 'jev-v1', primary: false, needs: ['level'], alert: v1 },
  { name: 'jev-veto', primary: true, needs: ['level', 'noul'], alert: veto },
];
export const PRIMARY_ARM = 'jev-veto';
export const RELAY_ARM = 'relay';
export const RELAY_RUNS = ['relay-after', 'relay-after-rerun'];
// Paired by index: an unanswered title in jev-1 falls back to relay-after's label.
export const JEV_RUNS = ['jev-1', 'jev-2'];
export const SLICES = ['full', 'clearCut'];

export const QUESTION_SET_SHA = promptSha(JSON.stringify({
  level: buildJevRequest([''], { levelOnly: true }).questions,
  noul: NOUL_QUESTIONS,
}));

// Exact caught/flagged, not the rounded precisionPct: two fractions a tenth of a point
// apart can round to the same value and read as a tie.
const precision = (s) => {
  const flagged = s.alertLevel - s.missed + s.falseAlerts;
  return flagged ? (s.alertLevel - s.missed) / flagged : null;
};

// On the full set Jev has to beat the relay. The clear-cut slice is a guard it must hold:
// both captured relay runs are at 100% precision there, so "beat" could never pass.
const SLICE_RULE = { full: 'beat', clearCut: 'hold' };

const exactly = (names, expected) => names.length === expected.length && expected.every((n) => names.includes(n));

// scores: { [arm]: { [run]: { full, clearCut } } }, each a scoreAlertLabels result.
// beat: the primary arm's worst run has higher precision than the relay's best run.
// hold: the primary arm's worst run has precision at least the relay's worst run.
// Both: the primary arm's worst run misses no more alerts than the relay's worst run.
// Any other set of runs than the frozen ones is no verdict, so a bad run cannot be
// dropped and a lucky one cannot be added.
export function verdict(scores) {
  const jevRuns = Object.keys(scores[PRIMARY_ARM] ?? {});
  const relayRuns = Object.keys(scores[RELAY_ARM] ?? {});
  if (!exactly(jevRuns, JEV_RUNS) || !exactly(relayRuns, RELAY_RUNS)) {
    return {
      arm: PRIMARY_ARM, pass: false, incomplete: true,
      reason: `needs exactly ${PRIMARY_ARM} runs [${JEV_RUNS}] and ${RELAY_ARM} runs [${RELAY_RUNS}], has [${jevRuns}] and [${relayRuns}]`,
    };
  }
  const slices = {};
  for (const slice of SLICES) {
    const rule = SLICE_RULE[slice];
    const jev = jevRuns.map((run) => scores[PRIMARY_ARM][run][slice]);
    const relay = relayRuns.map((run) => scores[RELAY_ARM][run][slice]);
    const jevPrecision = jev.map(precision);
    const relayPrecision = relay.map(precision);
    const jevWorstPrecision = jevPrecision.includes(null) ? null : Math.min(...jevPrecision);
    const relayBestPrecision = relayPrecision.includes(null) ? null : Math.max(...relayPrecision);
    const relayWorstPrecision = relayPrecision.includes(null) ? null : Math.min(...relayPrecision);
    const jevWorstMissed = Math.max(...jev.map((s) => s.missed));
    const relayWorstMissed = Math.max(...relay.map((s) => s.missed));
    const reasons = [];
    if (jevWorstPrecision === null) reasons.push(`a ${PRIMARY_ARM} run flagged no alert`);
    if (relayWorstPrecision === null) reasons.push(`a ${RELAY_ARM} run flagged no alert, so there is no precision to compare`);
    if (reasons.length === 0) {
      if (rule === 'beat' && !(jevWorstPrecision > relayBestPrecision)) reasons.push(`worst ${PRIMARY_ARM} precision ${pct(jevWorstPrecision)} is not above best ${RELAY_ARM} ${pct(relayBestPrecision)}`);
      if (rule === 'hold' && jevWorstPrecision < relayWorstPrecision) reasons.push(`worst ${PRIMARY_ARM} precision ${pct(jevWorstPrecision)} is below worst ${RELAY_ARM} ${pct(relayWorstPrecision)}`);
    }
    if (jevWorstMissed > relayWorstMissed) reasons.push(`worst ${PRIMARY_ARM} run missed ${jevWorstMissed}, worst ${RELAY_ARM} run ${relayWorstMissed}`);
    slices[slice] = {
      rule, pass: reasons.length === 0, jevWorstPrecision, relayBestPrecision, relayWorstPrecision, jevWorstMissed, relayWorstMissed, reasons,
    };
  }
  return { arm: PRIMARY_ARM, pass: SLICES.every((s) => slices[s].pass), slices };
}

const pct = (p) => `${(100 * p).toFixed(1)}%`;

// Production keeps non-Latin titles off Jev, so every arm is scored without them.
export const latinRows = (rows) => rows.filter((r) => !hasNonLatinLetters(r.title));

export const isAnswered = (arm, a) => arm.needs.every((part) => a?.[part]);

// Mapped onto levels so scoreAlertLabels reads them unchanged; only its alert fields
// mean anything for a Jev arm. A title the arm has no answer for takes the relay's
// label, because a Jev labeller would fall back to the LLM there.
export const armLabels = (arm, answersByTitle, fallbackByTitle) => Object.fromEntries(
  Object.entries(answersByTitle).map(([title, a]) => [
    title, isAnswered(arm, a) ? (arm.alert(a) ? 'high' : 'info') : (fallbackByTitle[title] ?? null),
  ]),
);

// jevRuns: { [JEV_RUNS name]: { [title]: JevAnswer | null } }; relayRuns: { [RELAY_RUNS name]: { [title]: level } }.
export function scoreArms(rows, jevRuns, relayRuns) {
  const full = latinRows(rows);
  const clearCut = full.filter((r) => !r.borderline);
  const bySlice = (labels) => ({ full: scoreAlertLabels(full, labels), clearCut: scoreAlertLabels(clearCut, labels) });
  const pairedRelay = (run) => {
    const labels = relayRuns[RELAY_RUNS[JEV_RUNS.indexOf(run)]];
    if (!labels) throw new Error(`Jev run ${run} has no paired relay run; runs are ${JEV_RUNS} paired with ${RELAY_RUNS}`);
    return labels;
  };
  const jevArm = (arm) => Object.fromEntries(Object.entries(jevRuns).map(([run, answers]) => [run, {
    ...bySlice(armLabels(arm, answers, pairedRelay(run))),
    unanswered: Object.values(answers).filter((a) => !isAnswered(arm, a)).length,
  }]));
  return {
    [RELAY_ARM]: Object.fromEntries(Object.entries(relayRuns).map(([run, labels]) => [run, bySlice(labels)])),
    ...Object.fromEntries(ARMS.map((arm) => [arm.name, jevArm(arm)])),
  };
}

export const RULE_SHA = promptSha(JSON.stringify({
  THRESHOLDS, SLICE_RULE, SLICES, PRIMARY_ARM, RELAY_ARM, RELAY_RUNS, JEV_RUNS,
  arms: ARMS.map(({ name, primary, needs, alert }) => ({ name, primary, needs, alert: String(alert) })),
  src: [v1, veto, precision, exactly, verdict, latinRows, isAnswered, armLabels, scoreArms].map(String),
}));

for (const [name, value] of [['questionSetSha', QUESTION_SET_SHA], ['ruleSha', RULE_SHA]]) {
  if (value !== FROZEN[name]) throw new Error(`jev-heldout: frozen ${name} moved (${FROZEN[name]} -> ${value}); a new held-out set is owed`);
}

// The judged rows and the relay runs Jev is compared with; a relabelled or re-captured
// fixture is a different experiment.
export const fixtureSha = (fixture) => promptSha(JSON.stringify({
  rows: fixture.rows.map(({ title, judge, borderline }) => ({ title, judge, borderline })),
  relay: RELAY_RUNS.map((name) => {
    const { model, promptSha: sha, labels } = fixture.runs?.[name] ?? {};
    return { name, model, promptSha: sha, labels };
  }),
}));

// ais-relay.cjs calls the shadow observer without maxTextChars, so its default applies.
const MAX_TEXT_CHARS = 200;

// The Nouls go in their own request, as they were measured; production's level request
// is sent unchanged beside it.
export const buildNoulRequest = (title) => ({
  model: JEV_MODEL,
  state: { headline: sanitizeHeadline(title, MAX_TEXT_CHARS) },
  questions: NOUL_QUESTIONS,
});

export function parseNoulAnswers(body) {
  const noul = {};
  for (const key of Object.keys(NOUL_QUESTIONS)) {
    const p = body?.answers?.[key]?.noul;
    if (typeof p !== 'number' || !Number.isFinite(p)) return null;
    noul[key] = p;
  }
  return noul;
}

// fetchJevLabel's policy (jev-classify-relay.cjs), which does not export its constants.
const JEV_TIMEOUT_MS = 5_000;
const JEV_RETRY_STATUSES = new Set([429, 529]);
const JEV_MAX_RETRY_WAIT_MS = 5_000;

async function fetchNoul(title, { apiKey, fetchFn, retryDelayMs }) {
  const body = JSON.stringify(buildNoulRequest(title));
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp;
    try {
      resp = await fetchFn(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'WorldMonitor-Eval/1.0' },
        body,
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (resp.ok) return parseNoulAnswers(await resp.json().catch(() => null));
    resp.body?.cancel?.().catch(() => {});
    if (!JEV_RETRY_STATUSES.has(resp.status) || attempt === 1) return null;
    const retryAfterMs = Number(resp.headers?.get?.('retry-after')) * 1000;
    if (retryAfterMs > JEV_MAX_RETRY_WAIT_MS) return null;
    await new Promise((r) => setTimeout(r, Math.max(retryAfterMs || 0, retryDelayMs * (0.5 + Math.random()))));
  }
  return null;
}

// usage: { inputTokens, requests, authRejected }, updated in place.
const metered = (fetchFn, usage) => async (...args) => {
  usage.requests += 1;
  const resp = await fetchFn(...args);
  if (resp.status === 401 || resp.status === 403) usage.authRejected += 1;
  if (resp.ok) {
    // Read before adding: `x += await y` reads x before the await and drops concurrent adds.
    const tokens = (await resp.clone().json().catch(() => null))?.usage?.input_tokens ?? 0;
    usage.inputTokens += tokens;
  }
  return resp;
};

// One title through production's level request and transport, then the Noul request
// under the same policy. A title with no level skips the Nouls: no arm can use them.
export async function askJev(title, { apiKey, fetchFn = (...args) => globalThis.fetch(...args), usage, retryDelayMs = 1000 }) {
  const transport = { apiKey, fetchFn: metered(fetchFn, usage), retryDelayMs };
  const label = await fetchJevLabel(title, MAX_TEXT_CHARS, transport);
  if (!label) return { level: null, noul: null };
  return { level: { l: label.l, levelConf: label.levelConf, pAlert: label.pAlert }, noul: await fetchNoul(title, transport) };
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isProbability = (p) => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;

function answerError(a) {
  if (a === null) return null;
  if (!isObject(a)) return 'is not an object or null';
  const { level, noul: n } = a;
  if (level !== null && !(isObject(level) && THREAT_LEVELS.includes(level.l)
    && typeof level.levelConf === 'number' && Number.isFinite(level.levelConf) && isProbability(level.pAlert))) {
    return 'has a level that is neither null nor { l, levelConf, pAlert }';
  }
  if (n !== null && !(isObject(n) && Object.keys(NOUL_QUESTIONS).every((k) => isProbability(n[k])))) {
    return `has a noul that is neither null nor { ${Object.keys(NOUL_QUESTIONS).join(', ')} } in [0, 1]`;
  }
  return null;
}

// A capture is trusted only for the frozen questions, rule and fixture, the pinned model,
// the frozen run names and exactly the held-out Latin titles in fixture order.
export function readCapture(file, fixture) {
  const actualFixtureSha = fixtureSha(fixture);
  if (actualFixtureSha !== FROZEN.fixtureSha) throw new Error(`fixture ${actualFixtureSha} is not the frozen held-out set ${FROZEN.fixtureSha}`);
  const capture = JSON.parse(readFileSync(file, 'utf8'));
  const bad = (message) => { throw new Error(`${file}: ${message}`); };
  if (!isObject(capture)) bad('is not an object');
  for (const key of ['questionSetSha', 'ruleSha', 'fixtureSha']) {
    if (capture[key] !== FROZEN[key]) bad(`${key} ${capture[key]} is not the frozen ${FROZEN[key]}`);
  }
  if (!/^[0-9a-f]{40}$/.test(capture.freezeSha)) bad(`freezeSha ${capture.freezeSha} is not a full commit SHA`);
  if (capture.model !== JEV_MODEL) bad(`model ${capture.model} is not ${JEV_MODEL}`);
  const titles = latinRows(fixture.rows).map((r) => r.title);
  if (JSON.stringify(capture.titles) !== JSON.stringify(titles)) bad('titles are not the held-out Latin titles in order');
  if (!isObject(capture.runs)) bad('runs is not an object');
  for (const [name, run] of Object.entries(capture.runs)) {
    if (!JEV_RUNS.includes(name)) bad(`runs["${name}"] is not one of ${JEV_RUNS.join(', ')}`);
    if (!Array.isArray(run?.answers) || run.answers.length !== titles.length) bad(`runs["${name}"] has ${run?.answers?.length} answers for ${titles.length} titles`);
    run.answers.forEach((a, i) => {
      const error = answerError(a);
      if (error) bad(`runs["${name}"].answers[${i}] ${error}`);
    });
  }
  return capture;
}
