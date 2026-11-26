// Records what the cross-wording matcher and the reworded-repeat check decide
// for each replayed incident, from the production embedder and judge models:
// the embedding similarity and the "same incident?" verdict for every pair the
// cross-wording check asks about, the similarity of every earlier alert the
// repeat check compares, and the repeat judge's two replies for each shortlist
// it is shown. The replay test (tests/alert-replay.test.mts) then answers from
// the record.
//
//   npx tsx --env-file=.env.local tests/helpers/record-alert-replay-matches.mts
//
// Needs OPENROUTER_API_KEY (ANTHROPIC_API_KEY is the repeat judge's fallback). The harness points every Redis client at an invalid
// host, and the embedder runs with no cache, so nothing is read from or written
// to production. Re-run it when an incident's wordings change or the replay
// test reports a pair with no record.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { parseRewritePrompt, replayIncident, sameTitle, type Incident, type Match, type RewriteVerdict } from './alert-replay-harness.mts';
import { cosineSimilarity, embedBatch } from '../../scripts/lib/brief-embedding.mjs';
import { EMBED_MODEL } from '../../scripts/lib/brief-dedup-consts.mjs';
import { parseJudgeVerdict } from '../../scripts/lib/news-corroboration.mjs';
import {
  REWRITE_JUDGE_MODEL, REWRITE_JUDGE_SYSTEM_PROMPT, defaultRewriteJudge, parseRewriteVerdict,
} from '../../scripts/lib/news-alert-coverage.mjs';

const { callLLM } = createRequire(import.meta.url)('../../scripts/lib/llm-chain.cjs');
// The options the matcher's default judge passes (scripts/lib/news-corroboration.mjs).
const JUDGE_OPTIONS = { maxTokens: 20, temperature: 0, timeoutMs: 6_000, allowedProviders: ['openrouter'], stage: 'news-cross-wording' };
const JUDGE_MODEL = 'google/gemini-2.5-flash';

if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');

const fixtureUrl = new URL('../fixtures/alert-replays.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as { incidents: Incident[] };

// The matcher swallows embed and judge errors, so a failed call would otherwise
// record a partial answer set and overwrite the fixture.
const failures: string[] = [];
const recording = <A extends unknown[], R>(what: string, call: (...args: A) => Promise<R>) => async (...args: A) => {
  try {
    return await call(...args);
  } catch (err) {
    failures.push(`${what}: ${(err as Error).message}`);
    throw err;
  }
};

for (const incident of fixture.incidents) {
  const titleOf = (text: string) => {
    const hit = incident.wordings.find((w) => sameTitle(w.title, text));
    if (!hit) throw new Error(`${incident.id}: no wording for ${JSON.stringify(text)}`);
    return hit.title;
  };
  const matches: Match[] = [];
  const rewrites: RewriteVerdict[] = [];
  const entry = (candidate: string, earlier: string) => {
    let row = matches.find((m) => m.candidate === candidate && m.earlier === earlier);
    if (!row) matches.push(row = { candidate, earlier, similarity: Number.NaN });
    return row;
  };
  const embed = recording(`${incident.id} embed`, async (texts: string[]) => {
    const vectors = await embedBatch(texts, { wallClockMs: 30_000, redisPipeline: async (commands: unknown[]) => commands.map(() => ({ result: null })) });
    const candidate = titleOf(texts[0]!);
    texts.slice(1).forEach((text, i) => { entry(candidate, titleOf(text)).similarity = cosineSimilarity(vectors[0], vectors[i + 1]); });
    return vectors;
  });
  const judge = recording(`${incident.id} judge`, async (systemPrompt: string, userPrompt: string, opts?: unknown) => {
    if (systemPrompt === REWRITE_JUDGE_SYSTEM_PROMPT) {
      const asked = parseRewritePrompt(userPrompt);
      const candidate = titleOf(asked.candidate);
      const earlier = asked.earlier.map(titleOf);
      let row = rewrites.find((r) => r.candidate === candidate && r.earlier.join('\n') === earlier.join('\n'));
      if (!row) rewrites.push(row = { candidate, earlier, votes: [] });
      // The check asks both votes at once and names its anchor from the first,
      // so each reply keeps the slot of the call that asked it, not its finish order.
      const slot = row.votes.push(Number.NaN) - 1;
      const text = await defaultRewriteJudge(systemPrompt, userPrompt, opts as { deadlineAt?: number });
      const pick = parseRewriteVerdict(text, earlier.length);
      // parseRewriteVerdict returns null for 0 and for an unreadable reply; a
      // zero is told apart with the same parse, code fence included.
      if (pick === null && parseRewriteVerdict(String(text).replace(/\{\s*"same"\s*:\s*0\s*\}/, '{"same":1}'), 1) !== 0) {
        throw new Error(`unparseable repeat verdict ${JSON.stringify(text)}`);
      }
      row.votes[slot] = pick === null ? 0 : pick + 1;
      return text;
    }
    const pair = /^Headline A: (.*)\nHeadline B, seen \d+h earlier: (.*)$/.exec(userPrompt);
    if (!pair) throw new Error(`unexpected judge prompt: ${userPrompt}`);
    const reply = await callLLM(systemPrompt, userPrompt, JUDGE_OPTIONS);
    const text = typeof reply === 'string' ? reply : reply?.content;
    const same = parseJudgeVerdict(text);
    if (same === null) throw new Error(`unparseable verdict ${JSON.stringify(text)}`);
    entry(titleOf(pair[1]!), titleOf(pair[2]!)).same = same;
    return text;
  });
  const log = (line: string) => {
    console.log(`  ${line}`);
    if (line.includes('"error"')) failures.push(`${incident.id}: ${line}`);
  };
  const rows = await replayIncident(incident, { embed, judge, deadlineMs: 120_000, log });
  for (const row of rows) if (row.repeatCheckError) failures.push(`${incident.id}: repeat check on ${JSON.stringify(row.wording.title)}: ${row.repeatCheckError}`);
  const unjudged = matches.filter((m) => !Number.isFinite(m.similarity));
  if (unjudged.length) throw new Error(`${incident.id}: judged a pair that was never embedded`);
  if (rewrites.length) incident.rewrites = rewrites;
  else delete incident.rewrites;
  if (matches.length) {
    (incident as Incident & { matchesRecorded?: unknown }).matchesRecorded = {
      embedModel: EMBED_MODEL, judgeModel: JUDGE_MODEL, ...(rewrites.length ? { repeatJudgeModel: REWRITE_JUDGE_MODEL } : {}), on: new Date().toISOString().slice(0, 10),
    };
    incident.matches = matches;
  } else {
    delete incident.matches;
  }
  console.log(`${incident.id}: ${matches.length} pairs, ${matches.filter((m) => m.same).length} same, ${rewrites.length} repeat checks judged`);
}

if (failures.length) throw new Error(`fixture left unchanged; matcher calls failed:\n${failures.join('\n')}`);
writeFileSync(fixtureUrl, `${JSON.stringify(fixture, null, 2)}\n`);
