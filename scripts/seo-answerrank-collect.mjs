#!/usr/bin/env node

/**
 * Ask AI models a fixed set of buyer questions every week, record how often
 * they name World Monitor, and say whether that moved since the last
 * comparable week. Writes `answerrank/<date>.json` and `answerrank/<date>.md`
 * beside the Search Console, Bing and Umami snapshots, in the same weekly PR.
 *
 * The measurement is answerrank (github.com/misbahsy/answerrank): each
 * question goes to each model variant (GPT and Claude with and without a web
 * search tool, Perplexity Sonar with its own search) three times, and a judge
 * model records whether World Monitor was named, recommended or cited. These
 * are model API answers, not the ChatGPT, Perplexity or Google AI products a
 * person uses, so the snapshot is a proxy and never fills the baseline's
 * `aiSurfaces`.
 *
 * The questions, product profile and answerrank config are committed under
 * `answerrank/inputs/`. Their digest pins the series: a snapshot is compared
 * only with the newest earlier snapshot that has the same digest and the same
 * answered variants. Mentions and citations are counts out of a few hundred
 * answers, so a week-over-week change is called only when a two-proportion
 * z-test clears |z| >= 1.96; anything smaller is reported as no measurable
 * change rather than as a trend.
 *
 * Usage:
 *   node scripts/seo-answerrank-collect.mjs --live
 *   node scripts/seo-answerrank-collect.mjs --from-run <answerrank run dir> --date 2026-11-10
 *
 * Options:
 *   --live                  run answerrank now (needs OPENROUTER_API_KEY,
 *                           ANTHROPIC_API_KEY and EXA_API_KEY)
 *   --from-run <dir>        build the snapshot from a finished answerrank run
 *   --date <YYYY-MM-DD>     snapshot date (default today, UTC)
 *   --dir <path>            snapshot directory (default docs/research/seo-ai-visibility/answerrank)
 *   --stdout                print the snapshot instead of writing files
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { loadEnvFile } from './_seed-utils.mjs';
import { isMainModule } from './lib/main-module.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = 'docs/research/seo-ai-visibility/answerrank';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SNAPSHOT_PATTERN = /^\d{4}-\d{2}-\d{2}\.json$/;
export const SCHEMA_VERSION = 1;
export const REQUIRED_KEYS = Object.freeze(['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'EXA_API_KEY']);
/** Two-sided 95%: a smaller |z| is reported as no measurable change. */
export const Z_THRESHOLD = 1.96;
/** More unscored answers (failed answers or failed judgments) than this share makes the week partial and not compared. */
export const MAX_FAILED_SHARE = 0.05;

function invariant(condition, message) {
  if (!condition) throw new Error(`[seo-answerrank-collect] ${message}`);
}

const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readJsonl = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));

/**
 * answerrank appends to answers.jsonl, so a retried answer leaves its error
 * line and its success line. The last line for a key is the one it scored.
 */
const latestByKey = (rows) => [...new Map(rows.map((row) => [row.key, row])).values()];

export const INPUT_FILES = Object.freeze(['queries.json', 'profile.json', 'config.yaml', 'requirements.txt']);

/** One digest over the committed inputs, in a fixed order. */
export function inputsDigest(files) {
  return sha256(JSON.stringify(INPUT_FILES.map((name) => {
    invariant(typeof files[name] === 'string', `missing input ${name}`);
    return sha256(files[name]);
  })));
}

function group(metrics, searchedAnswers = null) {
  invariant(Number.isInteger(metrics?.n) && metrics.n > 0, 'a scored group has no answers');
  const count = (rate, of) => (rate === null || rate === undefined ? null : Math.round(rate * of));
  const webAnswers = metrics.web_answers ?? 0;
  return {
    answers: metrics.n,
    mentions: count(metrics.mention_rate, metrics.n),
    topPicks: count(metrics.top_pick_rate, metrics.n),
    recommendations: count(metrics.recommend_rate, metrics.n),
    webAnswers,
    // Web answers that actually ran a search. The citation rate is over all
    // web answers, so a fall here explains a citation drop without a
    // visibility change.
    searchedAnswers: webAnswers > 0 ? searchedAnswers : null,
    citations: webAnswers > 0 ? count(metrics.citation_rate, webAnswers) : null,
    aeoScore: metrics.aeo_score,
    shareOfVoice: metrics.share_of_voice ?? null,
  };
}

/**
 * The snapshot for one finished answerrank run directory. `answers.jsonl`
 * gives the planned answers per variant. `scores.json` gives the judged
 * metrics, which answerrank computes only over answers that neither failed
 * nor lost their judgment, so planned minus scored is everything unscored.
 */
export function buildSnapshot({ runDir, date, observedAt, digest, revision = null }) {
  invariant(DATE_PATTERN.test(date ?? ''), 'date must be YYYY-MM-DD');
  const scores = readJson(join(runDir, 'scores.json'));
  const spend = existsSync(join(runDir, 'spend.json')) ? readJson(join(runDir, 'spend.json')) : {};
  const run = readJson(join(runDir, 'run.json'));
  const answers = latestByKey(readJsonl(join(runDir, 'answers.jsonl')));
  const queries = readJson(join(runDir, 'queries.json'));
  const plannedByVariant = {};
  const searchedByVariant = {};
  for (const answer of answers) {
    plannedByVariant[answer.model] = (plannedByVariant[answer.model] ?? 0) + 1;
    if (!answer.error && answer.web_search && answer.searched) searchedByVariant[answer.model] = (searchedByVariant[answer.model] ?? 0) + 1;
  }
  const unscoredByVariant = Object.fromEntries(Object.entries(plannedByVariant)
    .map(([label, planned]) => [label, planned - (scores.by_model?.[label]?.n ?? 0)])
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b)));
  const byVariant = Object.fromEntries(
    Object.entries(scores.by_model ?? {})
      .filter(([, metrics]) => metrics?.n > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, metrics]) => [label, group(metrics, searchedByVariant[label] ?? 0)]),
  );
  const planned = answers.length;
  const scored = scores.overall?.n ?? 0;
  const unscored = planned - scored;
  invariant(unscored >= 0, `scores.json has ${scored} scored answers but answers.jsonl plans only ${planned}`);
  const status = planned > 0 && unscored / planned <= MAX_FAILED_SHARE ? 'available' : 'partial';
  const spendUsd = Object.fromEntries(Object.entries(spend).map(([key, value]) => [key, Number(value.toFixed(4))]));
  spendUsd.total = Number(Object.values(spend).reduce((sum, value) => sum + value, 0).toFixed(4));
  return {
    schemaVersion: SCHEMA_VERSION,
    date,
    observedAt,
    status,
    reason: status === 'partial'
      ? `${unscored} of ${planned} answers were not scored (${Object.entries(unscoredByVariant).map(([label, count]) => `${label} ${count}`).join(', ')}), over the ${MAX_FAILED_SHARE * 100}% limit, so this week is not compared.`
      : null,
    tool: { name: 'answerrank', revision },
    inputsDigest: digest,
    design: {
      questions: queries.length,
      repetitions: run.repetitions,
      judgeModel: run.judge_model,
      variants: Object.keys(byVariant),
    },
    answers: { planned, scored, unscored, unscoredByVariant },
    overall: group(scores.overall, Object.values(searchedByVariant).reduce((sum, value) => sum + value, 0)),
    byVariant,
    spendUsd,
  };
}

/** Two-proportion z-test; null when either side has no denominator. */
export function proportionChange(before, after) {
  if (!before || !after || before.of <= 0 || after.of <= 0 || before.count === null || after.count === null) return null;
  const p1 = before.count / before.of;
  const p2 = after.count / after.of;
  const pooled = (before.count + after.count) / (before.of + after.of);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / before.of + 1 / after.of));
  const z = se === 0 ? 0 : (p2 - p1) / se;
  const verdict = z >= Z_THRESHOLD ? 'improved' : z <= -Z_THRESHOLD ? 'declined' : 'no measurable change';
  return { before: p1, after: p2, z: Number(z.toFixed(2)), verdict };
}

const sameVariants = (a, b) => a.design.variants.join('|') === b.design.variants.join('|');

/**
 * How a run's own settings (`run.json`) differ from the committed config, as
 * readable lines; empty when they match. The inputs digest names the committed
 * config, so a run made with other models, judge, repetitions or search
 * settings must not carry it.
 */
export function runSettingsMismatch(run, config) {
  const web = config.web_search ?? {};
  const expected = {
    judge_model: config.judge_model,
    generator_model: config.generator_model,
    repetitions: config.repetitions,
    models: (config.models ?? []).map((model) => ({ name: model.name, label: model.label, web_search: Boolean(model.web_search) })),
    web_search: {
      compare: Boolean(web.compare), mode: web.mode, search: web.search,
      max_results: web.max_results, max_searches: web.max_searches, force: Boolean(web.force),
    },
  };
  const actual = {
    judge_model: run.judge_model,
    generator_model: run.generator_model,
    repetitions: run.repetitions,
    models: (run.models ?? []).map((model) => ({ name: model.name, label: model.label, web_search: Boolean(model.web_search) })),
    web_search: Object.fromEntries(Object.keys(expected.web_search).map((key) => [key, run.web_search?.[key]])),
  };
  return Object.keys(expected)
    .filter((key) => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]))
    .map((key) => `${key}: run has ${JSON.stringify(actual[key])}, config has ${JSON.stringify(expected[key])}`);
}

/** Why two snapshots cannot be compared, or null when they can. */
export function incomparability(previous, current) {
  if (!previous) return 'No earlier snapshot.';
  if (previous.inputsDigest !== current.inputsDigest) return `The questions, profile, config or dependency lock changed since ${previous.date}, so this week starts a new series.`;
  if (previous.design.judgeModel !== current.design.judgeModel) return `The judge model changed from ${previous.design.judgeModel} to ${current.design.judgeModel} since ${previous.date}, so this week starts a new series.`;
  if (previous.tool.revision !== current.tool.revision) return `answerrank moved from ${previous.tool.revision ?? 'unknown'} to ${current.tool.revision ?? 'unknown'} since ${previous.date}; its judging may differ, so this week starts a new series.`;
  if (!sameVariants(previous, current)) return `The answered model variants differ from ${previous.date} (${previous.design.variants.join(', ')} then, ${current.design.variants.join(', ')} now).`;
  if (previous.status !== 'available') return `The ${previous.date} snapshot is partial.`;
  if (current.status !== 'available') return 'This snapshot is partial.';
  return null;
}

/**
 * The newest earlier snapshot this one can be compared with. A partial or
 * otherwise incomparable week in between is skipped, so a drop that spans it
 * is still measured against the last good week.
 */
export function previousComparable(earlier, current) {
  return earlier.findLast((entry) => incomparability(entry, current) === null) ?? null;
}

export function compareSnapshots(previous, current) {
  const reason = incomparability(previous, current);
  if (reason) return { previousDate: previous?.date ?? null, comparable: false, reason, verdict: 'not compared' };
  const mentions = proportionChange(
    { count: previous.overall.mentions, of: previous.overall.answers },
    { count: current.overall.mentions, of: current.overall.answers },
  );
  const citations = proportionChange(
    { count: previous.overall.citations, of: previous.overall.webAnswers },
    { count: current.overall.citations, of: current.overall.webAnswers },
  );
  const verdicts = [mentions?.verdict, citations?.verdict].filter(Boolean);
  const verdict = verdicts.includes('declined') ? 'declined' : verdicts.includes('improved') ? 'improved' : 'no measurable change';
  return { previousDate: previous.date, comparable: true, reason: null, verdict, mentions, citations };
}

/** Every snapshot in `dir` dated before `date`, oldest first. */
export function readEarlierSnapshots(dir, date) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => SNAPSHOT_PATTERN.test(name) && name.slice(0, 10) < date)
    .sort()
    .map((name) => readJson(join(dir, name)));
}

const pct = (ratio) => (ratio === null || ratio === undefined ? 'n/a' : `${(ratio * 100).toFixed(1)}%`);
const rate = (count, of) => (count === null || !of ? null : count / of);
const usd = (value) => (value === null || value === undefined ? 'n/a' : `$${value.toFixed(2)}`);

function changeLine(label, change) {
  if (!change) return `- ${label}: not compared (no answers on one side).`;
  return `- ${label}: ${pct(change.before)} → ${pct(change.after)} (z = ${change.z}), ${change.verdict}.`;
}

export function renderMarkdown(snapshot, comparison, earlier) {
  const { overall } = snapshot;
  const lines = [
    `# AI-answer visibility, ${snapshot.date}`,
    '',
    `World Monitor was named in ${overall.mentions} of ${overall.answers} model answers (${pct(rate(overall.mentions, overall.answers))}) to ${snapshot.design.questions} fixed buyer questions, asked ${snapshot.design.repetitions} times each per model variant.`,
    overall.webAnswers > 0
      ? `Answers that had web search cited worldmonitor.app ${overall.citations} of ${overall.webAnswers} times (${pct(rate(overall.citations, overall.webAnswers))}); ${overall.searchedAnswers} of those ${overall.webAnswers} actually searched.`
      : 'No answer used web search, so there is no citation rate.',
    '',
    'These are model API answers judged by answerrank, not observations of the ChatGPT, Perplexity or Google AI products. Read the counts, not the AEO score: its weights were never fitted to real traffic.',
    '',
    '## Change since the last comparable week',
    '',
  ];
  if (comparison.comparable) {
    lines.push(
      `Compared with ${comparison.previousDate}: **${comparison.verdict}**.`,
      '',
      changeLine('Named in answers', comparison.mentions),
      changeLine('Cited in web-search answers', comparison.citations),
      '',
      `A change is called only at |z| >= ${Z_THRESHOLD}. With about ${overall.answers} answers a week, smaller moves are within normal week-to-week churn.`,
    );
  } else {
    lines.push(`Not compared. ${comparison.reason}`);
  }
  if (snapshot.status !== 'available') lines.push('', `**Partial:** ${snapshot.reason}`);
  lines.push(
    '',
    '## By model variant',
    '',
    '| Variant | Answers | Named | Top pick | Searched | Cited (web answers) | AEO score |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(snapshot.byVariant).map(([label, g]) => (
      `| ${label} | ${g.answers} | ${g.mentions} (${pct(rate(g.mentions, g.answers))}) | ${g.topPicks} | ${g.webAnswers > 0 ? `${g.searchedAnswers} of ${g.webAnswers}` : 'n/a'} | ${g.webAnswers > 0 ? `${g.citations} of ${g.webAnswers}` : 'n/a'} | ${g.aeoScore} |`
    )),
  );
  if (snapshot.answers.unscored > 0) {
    lines.push('', `${snapshot.answers.unscored} of ${snapshot.answers.planned} planned answers were not scored (the answer or its judgment failed) and are excluded: ${Object.entries(snapshot.answers.unscoredByVariant).map(([label, count]) => `${label} ${count}`).join(', ')}.`);
  }
  const series = [...earlier.filter((entry) => entry.inputsDigest === snapshot.inputsDigest && entry.tool.revision === snapshot.tool.revision), snapshot];
  lines.push(
    '',
    '## Series with the same inputs and answerrank commit',
    '',
    '| Date | Answers | Named | Cited (web answers) | Status |',
    '|---|---:|---:|---:|---|',
    ...series.map((entry) => (
      `| ${entry.date} | ${entry.overall.answers} | ${pct(rate(entry.overall.mentions, entry.overall.answers))} | ${pct(rate(entry.overall.citations, entry.overall.webAnswers))} | ${entry.status} |`
    )),
    '',
    `Spend this run: ${usd(snapshot.spendUsd.total)}. Inputs digest \`${snapshot.inputsDigest}\`, answerrank revision \`${snapshot.tool.revision ?? 'unknown'}\`.`,
    '',
  );
  return lines.join('\n');
}

/** Refuse to write a snapshot that contains any provider key value. */
export function assertNoSecrets(serialized, env) {
  for (const name of REQUIRED_KEYS) {
    const value = env[name];
    if (value && value.length >= 8 && serialized.includes(value)) {
      throw new Error(`[seo-answerrank-collect] refusing to write: the snapshot contains the ${name} value`);
    }
  }
}

export function parseArgs(argv) {
  const options = { live: false, fromRun: null, date: null, dir: DEFAULT_DIR, stdout: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--live') { options.live = true; continue; }
    if (flag === '--stdout') { options.stdout = true; continue; }
    const value = argv[index + 1];
    invariant(value !== undefined && !value.startsWith('--'), `${flag} requires a value`);
    index += 1;
    switch (flag) {
      case '--from-run': options.fromRun = value; break;
      case '--date': options.date = value; break;
      case '--dir': options.dir = value; break;
      default: throw new Error(`[seo-answerrank-collect] unknown argument ${flag}`);
    }
  }
  invariant(options.live !== Boolean(options.fromRun), 'pass exactly one of --live or --from-run');
  invariant(options.date === null || DATE_PATTERN.test(options.date), '--date must be YYYY-MM-DD');
  return options;
}

/** Run answerrank on the committed inputs in a fresh directory and return that directory. */
export function runAnswerrank({ inputsDir, env, bin = 'answerrank', spawn = spawnSync }) {
  const missing = REQUIRED_KEYS.filter((name) => !env[name]);
  invariant(missing.length === 0, `missing ${missing.join(', ')}`);
  const runDir = mkdtempSync(join(tmpdir(), 'answerrank-'));
  // answerrank reuses a run directory's profile.json and queries.json, so
  // seeding them pins the questions instead of regenerating them.
  copyFileSync(join(inputsDir, 'profile.json'), join(runDir, 'profile.json'));
  copyFileSync(join(inputsDir, 'queries.json'), join(runDir, 'queries.json'));
  const result = spawn(bin, ['run', '-c', join(inputsDir, 'config.yaml'), '--out', runDir], {
    env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  invariant(!result.error, `could not start ${bin}: ${result.error?.message}`);
  invariant(result.status === 0, `${bin} exited with status ${result.status}`);
  return runDir;
}

export async function runCli(argv, { env = process.env, log = console.log, now = Date.now, spawn = spawnSync } = {}) {
  const options = parseArgs(argv);
  const date = options.date ?? new Date(now()).toISOString().slice(0, 10);
  const dir = resolve(REPO_ROOT, options.dir);
  const inputsDir = join(dir, 'inputs');
  const digest = inputsDigest(Object.fromEntries(INPUT_FILES.map((name) => [name, readFileSync(join(inputsDir, name), 'utf8')])));
  let runDir;
  let observedAt;
  if (options.live) {
    loadEnvFile(import.meta.url, { only: [...REQUIRED_KEYS] });
    runDir = runAnswerrank({ inputsDir, env, bin: env.ANSWERRANK_BIN || 'answerrank', spawn });
    observedAt = new Date(now()).toISOString();
  } else {
    runDir = resolve(options.fromRun);
    invariant(options.date, '--from-run needs --date');
    observedAt = statSync(join(runDir, 'scores.json')).mtime.toISOString();
  }
  // The digest names the committed inputs, so the run must have used them:
  // the same questions and profile, and the same models, judge and settings.
  const mismatch = runSettingsMismatch(
    readJson(join(runDir, 'run.json')),
    YAML.parse(readFileSync(join(inputsDir, 'config.yaml'), 'utf8')),
  );
  invariant(mismatch.length === 0, `the run in ${runDir} used other settings than inputs/config.yaml: ${mismatch.join('; ')}`);
  for (const name of ['queries.json', 'profile.json']) {
    invariant(
      readFileSync(join(runDir, name), 'utf8') === readFileSync(join(inputsDir, name), 'utf8'),
      `${name} in ${runDir} differs from ${join(options.dir, 'inputs', name)}`,
    );
  }
  const snapshot = buildSnapshot({ runDir, date, observedAt, digest, revision: env.ANSWERRANK_REVISION || null });
  const earlier = readEarlierSnapshots(dir, date);
  snapshot.comparison = compareSnapshots(previousComparable(earlier, snapshot) ?? earlier.at(-1) ?? null, snapshot);
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  const markdown = renderMarkdown(snapshot, snapshot.comparison, earlier);
  assertNoSecrets(json + markdown, env);
  if (options.stdout) {
    log(json);
    return { snapshot, markdown, written: [] };
  }
  mkdirSync(dir, { recursive: true });
  const written = [join(dir, `${date}.json`), join(dir, `${date}.md`)];
  writeFileSync(written[0], json);
  writeFileSync(written[1], markdown);
  log(`[seo-answerrank-collect] named ${snapshot.overall.mentions}/${snapshot.overall.answers}; ${snapshot.comparison.verdict}${snapshot.comparison.previousDate ? ` vs ${snapshot.comparison.previousDate}` : ''}`);
  log(`[seo-answerrank-collect] wrote ${written.map((path) => path.replace(`${REPO_ROOT}/`, '')).join(', ')}`);
  return { snapshot, markdown, written };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
