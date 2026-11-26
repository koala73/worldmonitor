// Records what the cross-wording matcher decides for each replayed incident:
// the embedding similarity and the "same incident?" verdict for every pair the
// real code asks about, from the production embedder and judge model. The
// replay test (tests/alert-replay.test.mts) then answers from the record.
//
//   npx tsx --env-file=.env.local tests/helpers/record-alert-replay-matches.mts
//
// Needs OPENROUTER_API_KEY. The harness points every Redis client at an invalid
// host, and the embedder runs with no cache, so nothing is read from or written
// to production. Re-run it when an incident's wordings change or the replay
// test reports a pair with no record.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { replayIncident, sameTitle, type Incident, type Match } from './alert-replay-harness.mts';
import { cosineSimilarity, embedBatch } from '../../scripts/lib/brief-embedding.mjs';
import { EMBED_MODEL } from '../../scripts/lib/brief-dedup-consts.mjs';

const { callLLM } = createRequire(import.meta.url)('../../scripts/lib/llm-chain.cjs');
// The options the matcher's default judge passes (scripts/lib/news-corroboration.mjs).
const JUDGE_OPTIONS = { maxTokens: 20, temperature: 0, timeoutMs: 6_000, allowedProviders: ['openrouter'], stage: 'news-cross-wording' };
const JUDGE_MODEL = 'google/gemini-2.5-flash';

if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');

const fixtureUrl = new URL('../fixtures/alert-replays.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as { incidents: Incident[] };

for (const incident of fixture.incidents) {
  const titleOf = (text: string) => {
    const hit = incident.wordings.find((w) => sameTitle(w.title, text));
    if (!hit) throw new Error(`${incident.id}: no wording for ${JSON.stringify(text)}`);
    return hit.title;
  };
  const matches: Match[] = [];
  const entry = (candidate: string, earlier: string) => {
    let row = matches.find((m) => m.candidate === candidate && m.earlier === earlier);
    if (!row) matches.push(row = { candidate, earlier, similarity: Number.NaN });
    return row;
  };
  const embed = async (texts: string[]) => {
    const vectors = await embedBatch(texts, { wallClockMs: 30_000, redisPipeline: async (commands: unknown[]) => commands.map(() => ({ result: null })) });
    const candidate = titleOf(texts[0]!);
    texts.slice(1).forEach((text, i) => { entry(candidate, titleOf(text)).similarity = Number(cosineSimilarity(vectors[0], vectors[i + 1]).toFixed(4)); });
    return vectors;
  };
  const judge = async (systemPrompt: string, userPrompt: string) => {
    const pair = /^Headline A: (.*)\nHeadline B, seen \d+h earlier: (.*)$/.exec(userPrompt);
    if (!pair) throw new Error(`unexpected judge prompt: ${userPrompt}`);
    const reply = await callLLM(systemPrompt, userPrompt, JUDGE_OPTIONS);
    const text = typeof reply === 'string' ? reply : reply?.content;
    entry(titleOf(pair[1]!), titleOf(pair[2]!)).same = JSON.parse(text).same;
    return text;
  };
  await replayIncident(incident, { embed, judge, deadlineMs: 120_000, log: (line) => console.log(`  ${line}`) });
  const unjudged = matches.filter((m) => !Number.isFinite(m.similarity));
  if (unjudged.length) throw new Error(`${incident.id}: judged a pair that was never embedded`);
  if (matches.length) {
    (incident as Incident & { matchesRecorded?: unknown }).matchesRecorded = { embedModel: EMBED_MODEL, judgeModel: JUDGE_MODEL, on: new Date().toISOString().slice(0, 10) };
    incident.matches = matches;
  } else {
    delete incident.matches;
  }
  console.log(`${incident.id}: ${matches.length} pairs, ${matches.filter((m) => m.same).length} same`);
}

writeFileSync(fixtureUrl, `${JSON.stringify(fixture, null, 2)}\n`);
