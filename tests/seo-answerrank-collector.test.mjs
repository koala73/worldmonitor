import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import YAML from 'yaml';

import {
  acceptSnapshot,
  assertNoSecrets,
  buildSnapshot,
  compareSnapshots,
  INPUT_FILES,
  inputsDigest,
  previousComparable,
  proportionChange,
  parseArgs,
  renderMarkdown,
  runAnswerrank,
  runCli,
  runSettingsMismatch,
  variantLabels,
} from '../scripts/seo-answerrank-collect.mjs';

const repoPath = (relativePath) => new URL(`../${relativePath}`, import.meta.url).pathname;
const INPUTS = repoPath('docs/research/seo-ai-visibility/answerrank/inputs');
const silent = () => {};
const CONFIG = YAML.parse(readFileSync(join(INPUTS, 'config.yaml'), 'utf8'));
/** run.json as answerrank writes it for the committed config. */
const RUN_SETTINGS = {
  generator_model: CONFIG.generator_model,
  judge_model: CONFIG.judge_model,
  models: CONFIG.models.map(({ name, label, web_search = false }) => ({ name, label, web_search })),
  repetitions: CONFIG.repetitions,
  web_search: { ...CONFIG.web_search, search_tool: '' },
};
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'answerrank-test-'));
const tempDir = (prefix) => mkdtempSync(join(TMP_ROOT, prefix));
after(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

const metrics = (n, named, web = 0, cited = 0) => ({
  n,
  aeo_score: 5,
  mention_rate: named / n,
  top_pick_rate: 0,
  recommend_rate: named / n,
  web_answers: web,
  citation_rate: web ? cited / web : null,
  share_of_voice: 0.05,
});

/**
 * A finished answerrank run directory using the committed inputs: `variants`
 * maps a label to [answers, named, web answers, cited]. `failed` adds
 * errored answers for a label, `unjudged` adds answers whose judgment failed
 * (answerrank leaves both out of scores.json), and `retried` adds an error line
 * before that many scored answers, as a resumed run leaves behind.
 */
function writeRun({ variants, failed = {}, unjudged = {}, retried = 0, settings = RUN_SETTINGS }) {
  const dir = tempDir('run-');
  cpSync(join(INPUTS, 'queries.json'), join(dir, 'queries.json'));
  cpSync(join(INPUTS, 'profile.json'), join(dir, 'profile.json'));
  const answers = [];
  const byModel = {};
  const totals = [0, 0, 0, 0];
  for (const [label, [n, named, web, cited]] of Object.entries(variants)) {
    byModel[label] = metrics(n, named, web, cited);
    [n, named, web, cited].forEach((value, index) => { totals[index] += value; });
    // The first `web` answers had web search; all but the last of those searched.
    for (let i = 0; i < n; i += 1) {
      answers.push({ key: `${label}|${i}`, model: label, text: 'answer', web_search: i < web, searched: i < web - 1 });
    }
  }
  for (const [label, count] of Object.entries(failed)) {
    for (let i = 0; i < count; i += 1) answers.push({ key: `${label}|f${i}`, model: label, error: 'NotFoundError' });
  }
  // Every answer that did not fail gets a judgment; an unjudged one gets an
  // error line, searched with web search on so it would inflate a search count.
  const judgments = answers.filter((row) => !row.error).map(({ key }) => ({ key, judge: { target: null } }));
  for (const [label, count] of Object.entries(unjudged)) {
    for (let i = 0; i < count; i += 1) {
      answers.push({ key: `${label}|u${i}`, model: label, text: 'answer', web_search: true, searched: true });
      judgments.push({ key: `${label}|u${i}`, error: 'RateLimitError' });
    }
  }
  answers.unshift(...answers.slice(0, retried).map(({ key, model }) => ({ key, model, error: 'RateLimitError' })));
  writeFileSync(join(dir, 'answers.jsonl'), answers.map((row) => JSON.stringify(row)).join('\n'));
  writeFileSync(join(dir, 'judgments.jsonl'), judgments.map((row) => JSON.stringify(row)).join('\n'));
  writeFileSync(join(dir, 'scores.json'), JSON.stringify({ overall: metrics(...totals), by_model: byModel }));
  writeFileSync(join(dir, 'spend.json'), JSON.stringify({ answer: 5.1, search: 0.6, judge: 1.55 }));
  writeFileSync(join(dir, 'run.json'), JSON.stringify(settings));
  return dir;
}

const VARIANTS = {
  claude: [39, 0, 0, 0],
  'claude +web': [39, 7, 39, 9],
  gpt: [39, 2, 0, 0],
  'gpt +web': [39, 1, 39, 2],
  perplexity: [39, 4, 39, 3],
};

const snapshotOf = (runDir, date, digest = 'sha256:same') => buildSnapshot({
  runDir, date, observedAt: `${date}T06:00:00.000Z`, digest, revision: 'abc',
});

/** A snapshot directory holding the committed inputs and any earlier snapshots. */
function snapshotDir(earlier = []) {
  const dir = tempDir('snapshots-');
  cpSync(INPUTS, join(dir, 'inputs'), { recursive: true });
  for (const entry of earlier) writeFileSync(join(dir, `${entry.date}.json`), JSON.stringify(entry));
  return dir;
}

const committedDigest = () => inputsDigest(Object.fromEntries(
  INPUT_FILES.map((name) => [name, readFileSync(join(INPUTS, name), 'utf8')]),
));

describe('buildSnapshot', () => {
  it('turns judged rates back into counts per variant and overall', () => {
    const snapshot = snapshotOf(writeRun({ variants: VARIANTS }), '2026-11-17');
    assert.equal(snapshot.status, 'available');
    assert.deepEqual(snapshot.overall, {
      answers: 195, mentions: 14, topPicks: 0, recommendations: 14,
      webAnswers: 117, searchedAnswers: 114, citations: 14, aeoScore: 5, shareOfVoice: 0.05,
    });
    assert.equal(snapshot.byVariant['gpt +web'].searchedAnswers, 38);
    assert.equal(snapshot.byVariant.gpt.searchedAnswers, null, 'no web answers means no search count, not zero');
    assert.equal(snapshot.byVariant['claude +web'].citations, 9);
    assert.equal(snapshot.byVariant.claude.citations, null, 'no web answers means no citation rate, not zero');
    assert.deepEqual(snapshot.design.variants, ['claude', 'claude +web', 'gpt', 'gpt +web', 'perplexity']);
    assert.equal(snapshot.spendUsd.total, 7.25);
  });

  it('marks a run with more than 5% failed answers as partial and names the failing variant', () => {
    const snapshot = snapshotOf(writeRun({ variants: VARIANTS, failed: { 'perplexity +web': 39 } }), '2026-11-17');
    assert.equal(snapshot.status, 'partial');
    assert.deepEqual(snapshot.answers, { planned: 234, scored: 195, unscored: 39, unscoredByVariant: { 'perplexity +web': 39 } });
    assert.match(snapshot.reason, /39 of 234 answers were not scored \(perplexity \+web 39\)/);
  });

  it('counts answers whose judgment failed as unscored, so a judge outage makes the week partial', () => {
    const snapshot = snapshotOf(writeRun({ variants: VARIANTS, unjudged: { 'claude +web': 20, gpt: 5 } }), '2026-11-17');
    assert.equal(snapshot.status, 'partial');
    assert.deepEqual(snapshot.answers, { planned: 220, scored: 195, unscored: 25, unscoredByVariant: { 'claude +web': 20, gpt: 5 } });
  });

  it('counts searches only among scored answers, so an unjudged answer that searched is left out', () => {
    const snapshot = snapshotOf(writeRun({ variants: VARIANTS, unjudged: { 'claude +web': 2 } }), '2026-11-17');
    assert.equal(snapshot.status, 'available');
    assert.equal(snapshot.byVariant['claude +web'].searchedAnswers, 38);
    assert.ok(snapshot.byVariant['claude +web'].searchedAnswers <= snapshot.byVariant['claude +web'].webAnswers);
    assert.equal(snapshot.overall.searchedAnswers, 114);
  });

  it('keeps a run with a few unscored answers available', () => {
    const snapshot = snapshotOf(writeRun({ variants: VARIANTS, failed: { gpt: 3 } }), '2026-11-17');
    assert.equal(snapshot.status, 'available');
    assert.equal(snapshot.answers.unscored, 3);
  });

  it('counts a retried answer once, by its last line', () => {
    const snapshot = snapshotOf(writeRun({ variants: VARIANTS, retried: 10 }), '2026-11-17');
    assert.deepEqual(snapshot.answers, { planned: 195, scored: 195, unscored: 0, unscoredByVariant: {} });
    assert.equal(snapshot.status, 'available');
  });
});

describe('proportionChange', () => {
  it('calls a drop from 14/195 to 2/195 a decline', () => {
    const change = proportionChange({ count: 14, of: 195 }, { count: 2, of: 195 });
    assert.equal(change.verdict, 'declined');
    assert.ok(change.z <= -1.96);
  });

  it('treats 14/195 to 12/195 as normal churn', () => {
    assert.equal(proportionChange({ count: 14, of: 195 }, { count: 12, of: 195 }).verdict, 'no measurable change');
  });

  it('calls a rise from 14/195 to 30/195 an improvement', () => {
    assert.equal(proportionChange({ count: 14, of: 195 }, { count: 30, of: 195 }).verdict, 'improved');
  });

  it('refuses a side with no denominator or no count', () => {
    assert.equal(proportionChange({ count: 0, of: 0 }, { count: 1, of: 10 }), null);
    assert.equal(proportionChange({ count: null, of: 10 }, { count: 1, of: 10 }), null);
  });

  it('reports zero to zero as no change rather than dividing by zero', () => {
    assert.deepEqual(proportionChange({ count: 0, of: 50 }, { count: 0, of: 50 }), {
      before: 0, after: 0, z: 0, verdict: 'no measurable change',
    });
  });
});

describe('compareSnapshots', () => {
  const before = snapshotOf(writeRun({ variants: VARIANTS }), '2026-11-10');

  it('reports a decline when mentions fall significantly', () => {
    const fewer = { ...VARIANTS, 'claude +web': [39, 0, 39, 9], perplexity: [39, 0, 39, 3], gpt: [39, 0, 0, 0] };
    const comparison = compareSnapshots(before, snapshotOf(writeRun({ variants: fewer }), '2026-11-17'));
    assert.equal(comparison.comparable, true);
    assert.equal(comparison.mentions.verdict, 'declined');
    assert.equal(comparison.verdict, 'declined');
  });

  it('reports an improvement when only citations rise significantly', () => {
    const cited = { ...VARIANTS, 'gpt +web': [39, 1, 39, 20], perplexity: [39, 4, 39, 15] };
    const comparison = compareSnapshots(before, snapshotOf(writeRun({ variants: cited }), '2026-11-17'));
    assert.equal(comparison.mentions.verdict, 'no measurable change');
    assert.equal(comparison.citations.verdict, 'improved');
    assert.equal(comparison.verdict, 'improved');
  });

  it('lets a decline outrank an improvement in the headline', () => {
    const mixed = { claude: [39, 0, 0, 0], 'claude +web': [39, 0, 39, 30], gpt: [39, 0, 0, 0], 'gpt +web': [39, 0, 39, 20], perplexity: [39, 0, 39, 15] };
    assert.equal(compareSnapshots(before, snapshotOf(writeRun({ variants: mixed }), '2026-11-17')).verdict, 'declined');
  });

  it('does not compare across changed inputs, variants or a partial week', () => {
    const after = snapshotOf(writeRun({ variants: VARIANTS }), '2026-11-17');
    assert.match(compareSnapshots(null, after).reason, /No earlier snapshot/);
    assert.match(compareSnapshots({ ...before, inputsDigest: 'sha256:other' }, after).reason, /new series/);
    const { perplexity, ...withoutPerplexity } = VARIANTS;
    assert.ok(perplexity);
    const fewerVariants = snapshotOf(writeRun({ variants: withoutPerplexity }), '2026-11-17');
    assert.match(compareSnapshots(before, fewerVariants).reason, /variants differ/);
    const otherJudge = { ...before, design: { ...before.design, judgeModel: 'openrouter/openai/gpt-5.5' } };
    assert.match(compareSnapshots(otherJudge, after).reason, /judge model changed/);
    const otherTool = { ...before, tool: { name: 'answerrank', revision: 'def' } };
    assert.match(compareSnapshots(otherTool, after).reason, /answerrank moved from def to abc/);
    const partial = snapshotOf(writeRun({ variants: VARIANTS, failed: { gpt: 30 } }), '2026-11-17');
    assert.match(compareSnapshots(before, partial).reason, /This snapshot is partial/);
    assert.equal(compareSnapshots(before, fewerVariants).verdict, 'not compared');
    assert.equal(compareSnapshots(before, partial).verdict, 'not compared');
  });
});

describe('previousComparable', () => {
  it('skips a partial week, so a drop that spans it is still measured', () => {
    const good = snapshotOf(writeRun({ variants: VARIANTS }), '2026-11-10');
    const low = { claude: [39, 0, 0, 0], 'claude +web': [39, 0, 39, 9], gpt: [39, 0, 0, 0], 'gpt +web': [39, 1, 39, 2], perplexity: [39, 0, 39, 3] };
    const outage = snapshotOf(writeRun({ variants: low, failed: { perplexity: 39 } }), '2026-11-17');
    const after = snapshotOf(writeRun({ variants: low }), '2026-11-24');
    assert.equal(outage.status, 'partial');
    assert.equal(previousComparable([good, outage], after), good);
    assert.equal(compareSnapshots(previousComparable([good, outage], after), after).verdict, 'declined');
  });

  it('returns null when no earlier week is comparable', () => {
    const after = snapshotOf(writeRun({ variants: VARIANTS }), '2026-11-24');
    assert.equal(previousComparable([{ ...after, date: '2026-11-17', inputsDigest: 'sha256:old' }], after), null);
  });
});

describe('renderMarkdown', () => {
  it('states the counts, the verdict and only the series with the same inputs', () => {
    const before = snapshotOf(writeRun({ variants: VARIANTS }), '2026-11-10');
    const otherSeries = { ...snapshotOf(writeRun({ variants: VARIANTS }), '2026-11-03'), inputsDigest: 'sha256:old' };
    const after = snapshotOf(writeRun({ variants: VARIANTS }), '2026-11-17');
    const markdown = renderMarkdown(after, compareSnapshots(before, after), [otherSeries, before]);
    assert.match(markdown, /named in 14 of 195 model answers \(7\.2%\)/);
    assert.match(markdown, /cited worldmonitor\.app 14 of 117 times \(12\.0%\); 114 of those 117 actually searched/);
    assert.match(markdown, /\| gpt \+web \| 39 \| 1 \(2\.6%\) \| 0 \| 38 of 39 \| 2 of 39 \|/);
    assert.match(markdown, /Compared with 2026-11-10: \*\*no measurable change\*\*/);
    assert.match(markdown, /\| 2026-11-10 \|/);
    assert.match(markdown, /\| 2026-11-17 \|/);
    assert.doesNotMatch(markdown, /\| 2026-11-03 \|/);
    assert.match(markdown, /not observations of the ChatGPT, Perplexity or Google AI products/);
  });
});

describe('runCli', () => {
  it('writes the dated pair and compares it with the newest earlier snapshot in the directory', async () => {
    const digest = committedDigest();
    const earlier = snapshotOf(writeRun({ variants: VARIANTS }), '2026-11-10', digest);
    const dir = snapshotDir([earlier]);
    const fewer = { ...VARIANTS, 'claude +web': [39, 0, 39, 9], perplexity: [39, 0, 39, 3], gpt: [39, 0, 0, 0] };
    const { snapshot, written } = await runCli(
      ['--from-run', writeRun({ variants: fewer }), '--date', '2026-11-17', '--dir', dir],
      { env: { ANSWERRANK_REVISION: 'abc' }, log: silent },
    );
    assert.equal(snapshot.inputsDigest, digest);
    assert.equal(snapshot.comparison.previousDate, '2026-11-10');
    assert.equal(snapshot.comparison.verdict, 'declined');
    assert.deepEqual(written, [join(dir, '2026-11-17.json'), join(dir, '2026-11-17.md')]);
    assert.deepEqual(JSON.parse(readFileSync(written[0], 'utf8')), snapshot);
  });

  it('is idempotent on rerun: the same date never compares with itself', async () => {
    const dir = snapshotDir();
    const runDir = writeRun({ variants: VARIANTS });
    await runCli(['--from-run', runDir, '--date', '2026-11-17', '--dir', dir], { env: {}, log: silent });
    const { snapshot } = await runCli(['--from-run', runDir, '--date', '2026-11-17', '--dir', dir], { env: {}, log: silent });
    assert.equal(snapshot.comparison.previousDate, null);
  });

  it('counts answer rows a run never wrote as unscored, so a truncated run is partial', async () => {
    const { snapshot } = await runCli(
      ['--from-run', writeRun({ variants: { ...VARIANTS, perplexity: [10, 1, 10, 1] } }), '--date', '2026-11-17', '--dir', snapshotDir(), '--stdout'],
      { env: {}, log: silent },
    );
    assert.deepEqual(snapshot.answers, { planned: 195, scored: 166, unscored: 29, unscoredByVariant: { perplexity: 29 } });
    assert.equal(snapshot.status, 'partial');
  });

  it('refuses a run whose scores cover answer rows it no longer has', async () => {
    const runDir = writeRun({ variants: VARIANTS });
    const rows = readFileSync(join(runDir, 'answers.jsonl'), 'utf8').split('\n');
    writeFileSync(join(runDir, 'answers.jsonl'), rows.filter((row) => !row.includes('"gpt +web|3')).join('\n'));
    await assert.rejects(
      runCli(['--from-run', runDir, '--date', '2026-11-17', '--dir', snapshotDir(), '--stdout'], { env: {}, log: silent }),
      /gpt \+web has 39 scored answers but only \d+ answer rows/,
    );
  });

  it('refuses a run whose scores have no mention rate, which would hide a decline', async () => {
    const runDir = writeRun({ variants: VARIANTS });
    const scores = JSON.parse(readFileSync(join(runDir, 'scores.json'), 'utf8'));
    scores.overall.mention_rate = null;
    writeFileSync(join(runDir, 'scores.json'), JSON.stringify(scores));
    await assert.rejects(
      runCli(['--from-run', runDir, '--date', '2026-11-17', '--dir', snapshotDir(), '--stdout'], { env: {}, log: silent }),
      /a scored group has no mention_rate/,
    );
  });

  it('refuses a run whose overall scores disagree with its variant scores', async () => {
    const runDir = writeRun({ variants: VARIANTS });
    const scores = JSON.parse(readFileSync(join(runDir, 'scores.json'), 'utf8'));
    scores.overall.mention_rate = 0;
    writeFileSync(join(runDir, 'scores.json'), JSON.stringify(scores));
    await assert.rejects(
      runCli(['--from-run', runDir, '--date', '2026-11-17', '--dir', snapshotDir(), '--stdout'], { env: {}, log: silent }),
      /overall\.mentions is 0 but the variants add up to 14/,
    );
  });

  it('refuses a run whose questions differ from the committed inputs', async () => {
    const runDir = writeRun({ variants: VARIANTS });
    writeFileSync(join(runDir, 'queries.json'), '[]');
    await assert.rejects(
      runCli(['--from-run', runDir, '--date', '2026-11-17', '--dir', snapshotDir(), '--stdout'], { env: {}, log: silent }),
      /queries\.json .* differs/,
    );
  });

  it('refuses a run made with another judge, models or repetitions than the committed config', async () => {
    const otherJudge = writeRun({ variants: VARIANTS, settings: { ...RUN_SETTINGS, judge_model: 'openrouter/openai/gpt-5.5' } });
    await assert.rejects(
      runCli(['--from-run', otherJudge, '--date', '2026-11-17', '--dir', snapshotDir(), '--stdout'], { env: {}, log: silent }),
      /other settings than inputs\/config\.yaml: judge_model/,
    );
    const oldPerplexity = RUN_SETTINGS.models.map((model) => ({ ...model, web_search: false }));
    assert.match(runSettingsMismatch({ ...RUN_SETTINGS, models: oldPerplexity, repetitions: 5 }, CONFIG).join('\n'), /repetitions[\s\S]*models/);
    assert.deepEqual(runSettingsMismatch(RUN_SETTINGS, CONFIG), []);
  });

  it('accepts the 2026-11-11 run settings answerrank actually wrote', () => {
    const recorded = {
      generator_model: 'openrouter/openai/gpt-5.5',
      judge_model: 'anthropic/claude-sonnet-5-5',
      models: [
        { name: 'openrouter/openai/gpt-5.5', label: 'gpt', web_search: false },
        { name: 'anthropic/claude-sonnet-5-5', label: 'claude', web_search: false },
        { name: 'openrouter/perplexity/sonar-pro', label: 'perplexity', web_search: true },
      ],
      repetitions: 3,
      web_search: { compare: true, mode: 'tool', search: 'exa_ai', max_results: 5, max_searches: 3, force: false, search_tool: '' },
    };
    assert.deepEqual(runSettingsMismatch(recorded, CONFIG), []);
  });

  it('requires exactly one source and a date for --from-run', async () => {
    await assert.rejects(runCli([], { env: {}, log: silent }), /exactly one of --live, --from-run or --accept/);
    await assert.rejects(runCli(['--from-run', 'x', '--live'], { env: {}, log: silent }), /exactly one/);
    await assert.rejects(runCli(['--from-run', writeRun({ variants: VARIANTS }), '--dir', snapshotDir()], { env: {}, log: silent }), /needs --date/);
  });
});

describe('acceptSnapshot (the collect job taking the AI-answer artifact)', () => {
  const REVISION = 'abc';
  const acceptContext = () => ({
    date: '2026-11-17',
    digest: committedDigest(),
    revision: REVISION,
    config: CONFIG,
    questions: JSON.parse(readFileSync(join(INPUTS, 'queries.json'), 'utf8')).length,
  });

  /** The pair the answerrank job uploads, made the way that job makes it. */
  async function produce(variants = VARIANTS, earlier = []) {
    const dir = snapshotDir(earlier);
    await runCli(
      ['--from-run', writeRun({ variants }), '--date', '2026-11-17', '--dir', dir],
      { env: { ANSWERRANK_REVISION: REVISION }, log: silent },
    );
    return { json: join(dir, '2026-11-17.json'), md: join(dir, '2026-11-17.md') };
  }

  it('lists the variants answerrank answers with for the committed config', () => {
    assert.deepEqual(variantLabels(CONFIG), ['gpt', 'gpt +web', 'claude', 'claude +web', 'perplexity']);
  });

  it('rebuilds the uploaded pair byte for byte from the measured fields', async () => {
    const earlier = snapshotOf(writeRun({ variants: VARIANTS }), '2026-11-10', committedDigest());
    const produced = await produce({ ...VARIANTS, gpt: [39, 0, 0, 0] }, [earlier]);
    const dir = snapshotDir([earlier]);
    const { written } = await runCli(
      ['--accept', produced.json, '--date', '2026-11-17', '--dir', dir],
      { env: { ANSWERRANK_REVISION: REVISION }, log: silent },
    );
    assert.equal(readFileSync(written[0], 'utf8'), readFileSync(produced.json, 'utf8'));
    assert.equal(readFileSync(written[1], 'utf8'), readFileSync(produced.md, 'utf8'));
  });

  it('recomputes the comparison, status and markdown instead of copying them', async () => {
    const produced = await produce();
    const raw = JSON.parse(readFileSync(produced.json, 'utf8'));
    const injected = '[click](https://evil.example) @owner';
    raw.comparison = { previousDate: injected, comparable: true, verdict: 'declined', reason: injected };
    raw.reason = injected;
    writeFileSync(produced.json, JSON.stringify(raw));
    writeFileSync(produced.md, injected);
    const { snapshot, markdown } = await runCli(
      ['--accept', produced.json, '--date', '2026-11-17', '--dir', snapshotDir(), '--stdout'],
      { env: { ANSWERRANK_REVISION: REVISION }, log: silent },
    );
    assert.equal(snapshot.comparison.verdict, 'not compared');
    assert.equal(snapshot.comparison.previousDate, null);
    assert.equal(snapshot.reason, null);
    assert.doesNotMatch(JSON.stringify(snapshot) + markdown, /evil\.example|@owner/);
  });

  it('rejects text where the snapshot holds counts, labels, amounts or ids', async () => {
    const valid = JSON.parse(readFileSync((await produce()).json, 'utf8'));
    assert.doesNotThrow(() => acceptSnapshot(structuredClone(valid), acceptContext()));
    const relabel = (raw, from, to) => {
      raw.design.variants = raw.design.variants.map((label) => (label === from ? to : label)).sort((a, b) => a.localeCompare(b));
      raw.byVariant = Object.fromEntries(raw.design.variants.map((label) => [label, raw.byVariant[label === to ? from : label]]));
    };
    const cases = {
      'a count as text': (raw) => { raw.overall.mentions = '13 <img src=x>'; },
      'a variant count as text': (raw) => { raw.byVariant.gpt.citations = 'x'; },
      'a citation count above its web answers': (raw) => { raw.byVariant['gpt +web'].citations = 40; },
      'a variant label outside the config': (raw) => relabel(raw, 'gpt', 'gpt](https://evil.example)'),
      'another inputs digest': (raw) => { raw.inputsDigest = 'sha256:other'; },
      'another answerrank revision': (raw) => { raw.tool.revision = 'def'; },
      'another judge': (raw) => { raw.design.judgeModel = 'openrouter/openai/gpt-5.5'; },
      'markup in a spend key': (raw) => { raw.spendUsd['<b>x</b>'] = 1; },
      'a spend amount as text': (raw) => { raw.spendUsd.total = '$7'; },
      'an unscored label outside the config': (raw) => { raw.answers = { planned: 196, scored: 195, unscored: 1, unscoredByVariant: { '@owner': 1 } }; },
      'answer counts that do not add up': (raw) => { raw.answers.planned = 300; },
      'a free-text timestamp': (raw) => { raw.observedAt = 'yesterday @owner'; },
      'another date': (raw) => { raw.date = '2026-11-18'; },
      'a null mention count, which would skip the decline test': (raw) => { raw.overall.mentions = null; },
      'a null citation count on a web variant': (raw) => { raw.byVariant['gpt +web'].citations = null; },
      'overall counts that disagree with the variants': (raw) => { raw.overall.mentions = 0; },
      'fewer answers than the design, claimed complete': (raw) => {
        raw.byVariant.gpt.answers = 5;
        raw.byVariant.gpt.mentions = 0;
        raw.overall.answers -= 34;
        raw.overall.mentions -= 2;
        raw.answers = { planned: 161, scored: 161, unscored: 0, unscoredByVariant: {} };
      },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const raw = structuredClone(valid);
      mutate(raw);
      assert.throws(() => acceptSnapshot(raw, acceptContext()), /seo-answerrank-collect/, name);
    }
  });

  it('accepts a run that lost answers only as a partial week measured against the full design', async () => {
    const produced = await produce({ ...VARIANTS, gpt: [5, 0, 0, 0] });
    const raw = JSON.parse(readFileSync(produced.json, 'utf8'));
    assert.deepEqual(raw.answers, { planned: 195, scored: 161, unscored: 34, unscoredByVariant: { gpt: 34 } });
    assert.equal(raw.status, 'partial');
    assert.equal(acceptSnapshot(raw, acceptContext()).status, 'partial');
  });

  it('needs a date and takes no other source', () => {
    assert.throws(() => parseArgs(['--accept', 'x.json']), /--accept needs --date/);
    assert.throws(() => parseArgs(['--accept', 'x.json', '--live', '--date', '2026-11-17']), /exactly one of/);
  });
});

describe('runAnswerrank', () => {
  const env = { OPENROUTER_API_KEY: 'or-key-123456', ANTHROPIC_API_KEY: 'an-key-123456', EXA_API_KEY: 'exa-key-123456' };

  it('refuses to start without every provider key', () => {
    assert.throws(() => runAnswerrank({ inputsDir: INPUTS, env: { OPENROUTER_API_KEY: 'x' } }), /missing ANTHROPIC_API_KEY, EXA_API_KEY/);
  });

  it('seeds the run directory with the fixed questions and runs the committed config', () => {
    const calls = [];
    const runDir = runAnswerrank({
      inputsDir: INPUTS,
      env,
      spawn: (bin, args, options) => { calls.push({ bin, args, options }); return { status: 0 }; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, 'answerrank');
    assert.deepEqual(calls[0].args, ['run', '-c', join(INPUTS, 'config.yaml'), '--out', runDir]);
    assert.equal(calls[0].options.env, env);
    assert.equal(readFileSync(join(runDir, 'queries.json'), 'utf8'), readFileSync(join(INPUTS, 'queries.json'), 'utf8'));
    assert.ok(existsSync(join(runDir, 'profile.json')));
    rmSync(runDir, { recursive: true, force: true });
  });

  it('fails when answerrank exits non-zero', () => {
    let runDir;
    assert.throws(
      () => runAnswerrank({ inputsDir: INPUTS, env, spawn: (_bin, args) => { runDir = args.at(-1); return { status: 2 }; } }),
      /exited with status 2/,
    );
    rmSync(runDir, { recursive: true, force: true });
  });
});

describe('assertNoSecrets', () => {
  it('refuses output that contains a provider key value', () => {
    assert.throws(() => assertNoSecrets('x sk-or-v1-abcdef y', { OPENROUTER_API_KEY: 'sk-or-v1-abcdef' }), /OPENROUTER_API_KEY/);
    assert.doesNotThrow(() => assertNoSecrets('clean', { OPENROUTER_API_KEY: 'sk-or-v1-abcdef' }));
  });
});

describe('committed inputs', () => {
  it('give Perplexity native search so no variant fails on every answer', () => {
    const config = readFileSync(join(INPUTS, 'config.yaml'), 'utf8');
    assert.match(config, /label: perplexity, web_search: true/);
    assert.equal(JSON.parse(readFileSync(join(INPUTS, 'queries.json'), 'utf8')).length, 13);
  });
});
