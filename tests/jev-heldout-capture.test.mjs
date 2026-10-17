import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JEV_ENDPOINT, JEV_MODEL, buildJevRequest } from '../shared/jev-classify.js';
import {
  FROZEN, NOUL_QUESTIONS, askJev, buildNoulRequest, latinRows, parseNoulAnswers, readCapture,
} from '../scripts/lib/jev-heldout.mjs';

const levelBody = { answers: { l0: { type: 'choice', choice: 'high', confidence: 0.8, probabilities: { critical: 0.25, high: 0.5, medium: 0.25 } } }, usage: { input_tokens: 600 } };
const noulBody = { answers: { commentary: { noul: 0.05 }, worsening: { noul: 0.9 }, violence: { noul: 0.7 } }, usage: { input_tokens: 400 } };
const level = { l: 'high', levelConf: 0.8, pAlert: 0.75 };
const noul = { commentary: 0.05, worsening: 0.9, violence: 0.7 };
const reply = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const timeout = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };

describe('Noul request and parser', () => {
  it('asks the three frozen Nouls about `headline`, sanitised like the level request', () => {
    const title = 'Line one\nline two';
    const req = buildNoulRequest(title);
    assert.equal(req.model, JEV_MODEL);
    assert.deepEqual(req.state, buildJevRequest([title], { levelOnly: true }).state);
    assert.deepEqual(req.state, { headline: 'Line one line two' });
    assert.equal(req.questions, NOUL_QUESTIONS);
    for (const q of Object.values(req.questions)) assert.match(q.instructions, /`headline`/);
    assert.equal(buildNoulRequest('x'.repeat(250)).state.headline.length, 200);
  });

  it('reads every Noul as a finite number and drops the whole answer otherwise', () => {
    assert.deepEqual(parseNoulAnswers(noulBody), noul);
    assert.equal(parseNoulAnswers({ answers: { ...noulBody.answers, violence: {} } }), null);
    assert.equal(parseNoulAnswers({ answers: { ...noulBody.answers, violence: { noul: '0.7' } } }), null);
    assert.equal(parseNoulAnswers({ answers: { ...noulBody.answers, violence: { noul: Number.NaN } } }), null);
    assert.equal(parseNoulAnswers(null), null);
  });
});

describe('askJev', () => {
  const ask = async (steps, title = 'Strait closed') => {
    const sent = [];
    const fetchFn = async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body), userAgent: init.headers['User-Agent'] });
      return steps.shift()();
    };
    const usage = { inputTokens: 0, requests: 0, authRejected: 0 };
    const answer = await askJev(title, { apiKey: 'k', fetchFn, usage, retryDelayMs: 0 });
    return { answer, sent, usage };
  };
  const ok = (body) => () => reply(200, body);
  const status = (code, headers) => () => reply(code, {}, headers);

  it('sends the production level request through fetchJevLabel, then the Noul request', async () => {
    const { answer, sent, usage } = await ask([ok(levelBody), ok(noulBody)]);
    assert.deepEqual(sent.map((s) => s.url), [JEV_ENDPOINT, JEV_ENDPOINT]);
    assert.deepEqual(sent[0].body, buildJevRequest(['Strait closed'], { levelOnly: true, maxTextChars: 200 }));
    assert.equal(sent[0].userAgent, 'WorldMonitor-Relay/1.0');
    assert.deepEqual(sent[1].body, JSON.parse(JSON.stringify(buildNoulRequest('Strait closed'))));
    assert.deepEqual(answer, { level, noul });
    assert.deepEqual(usage, { inputTokens: 1000, requests: 2, authRejected: 0 });
  });

  it('counts every token when titles are asked concurrently', async () => {
    const fetchFn = async (_url, init) => reply(200, JSON.parse(init.body).questions.l0 ? levelBody : noulBody);
    const usage = { inputTokens: 0, requests: 0, authRejected: 0 };
    await Promise.all(Array.from({ length: 12 }, (_, i) => askJev(`t${i}`, { apiKey: 'k', fetchFn, usage })));
    assert.deepEqual(usage, { inputTokens: 12_000, requests: 24, authRejected: 0 });
  });

  it('keeps the level when only the Noul request fails', async () => {
    assert.deepEqual((await ask([ok(levelBody), ok({ answers: {} })])).answer, { level, noul: null });
  });

  it('skips the Noul request when the level has no valid answer', async () => {
    const { answer, sent } = await ask([ok({ answers: {} })]);
    assert.deepEqual(answer, { level: null, noul: null });
    assert.equal(sent.length, 1);
  });

  it('gives up on a timeout without a retry', async () => {
    const level1 = await ask([timeout]);
    assert.deepEqual([level1.answer, level1.sent.length, level1.usage.requests], [{ level: null, noul: null }, 1, 1]);
    const noul1 = await ask([ok(levelBody), timeout]);
    assert.deepEqual([noul1.answer, noul1.sent.length], [{ level, noul: null }, 2]);
  });

  it('retries a 429 or 529 once', async () => {
    const levelRetry = await ask([status(429), ok(levelBody), status(529), ok(noulBody)]);
    assert.deepEqual([levelRetry.answer, levelRetry.sent.length], [{ level, noul }, 4]);
    const twice = await ask([status(429), status(429)]);
    assert.deepEqual([twice.answer, twice.sent.length], [{ level: null, noul: null }, 2]);
    const noulTwice = await ask([ok(levelBody), status(529), status(429)]);
    assert.deepEqual([noulTwice.answer, noulTwice.sent.length], [{ level, noul: null }, 3]);
  });

  it('does not retry a 429 whose retry-after is over 5 s', async () => {
    const level1 = await ask([status(429, { 'retry-after': '6' })]);
    assert.equal(level1.sent.length, 1);
    const noul1 = await ask([ok(levelBody), status(429, { 'retry-after': '6' })]);
    assert.deepEqual([noul1.answer, noul1.sent.length], [{ level, noul: null }, 2]);
  });

  it('does not retry a 500', async () => {
    assert.equal((await ask([status(500)])).sent.length, 1);
    const noul1 = await ask([ok(levelBody), status(500)]);
    assert.deepEqual([noul1.answer, noul1.sent.length], [{ level, noul: null }, 2]);
  });

  it('counts a 401 or 403 as an auth rejection', async () => {
    assert.deepEqual((await ask([status(401)])).usage, { inputTokens: 0, requests: 1, authRejected: 1 });
    assert.equal((await ask([ok(levelBody), status(403)])).usage.authRejected, 1);
  });
});

describe('readCapture', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/classify-judged-headlines-heldout.json', import.meta.url), 'utf8'));
  const titles = latinRows(fixture.rows).map((r) => r.title);
  const answers = titles.map((_, i) => [null, { level: null, noul: null }, { level, noul: null }, { level, noul }][i % 4]);
  const valid = {
    freezeSha: 'a'.repeat(40), questionSetSha: FROZEN.questionSetSha, ruleSha: FROZEN.ruleSha, fixtureSha: FROZEN.fixtureSha,
    model: JEV_MODEL, titles, runs: { 'jev-1': { answers } },
  };
  const dir = mkdtempSync(join(tmpdir(), 'jev-heldout-capture-'));
  let n = 0;
  const write = (capture) => { const file = join(dir, `c${n++}.json`); writeFileSync(file, JSON.stringify(capture)); return file; };
  const withAnswer = (i, a) => ({ ...valid, runs: { 'jev-1': { answers: answers.map((x, j) => (j === i ? a : x)) } } });

  it('accepts the frozen SHAs, the pinned model, the frozen run names and the Latin titles in order', () => {
    assert.deepEqual(readCapture(write(valid), fixture), valid);
    assert.deepEqual(readCapture(write({ ...valid, runs: {} }), fixture).runs, {});
  });

  it('rejects a fixture that is not the frozen held-out set', () => {
    const relabelled = structuredClone(fixture);
    relabelled.rows[0].judge = relabelled.rows[0].judge === 'info' ? 'low' : 'info';
    assert.throws(() => readCapture(write(valid), relabelled), /is not the frozen held-out set/);
  });

  it('rejects a capture of another question set, rule, fixture, model, freeze or title list', () => {
    for (const key of ['questionSetSha', 'ruleSha', 'fixtureSha']) {
      assert.throws(() => readCapture(write({ ...valid, [key]: '0000000000000000' }), fixture), new RegExp(`${key} 0000000000000000 is not the frozen`));
    }
    assert.throws(() => readCapture(write({ ...valid, freezeSha: 'abc' }), fixture), /freezeSha/);
    assert.throws(() => readCapture(write({ ...valid, model: 'jev-1.12.0' }), fixture), /model/);
    assert.throws(() => readCapture(write({ ...valid, titles: [...titles].reverse() }), fixture), /titles/);
    assert.throws(() => readCapture(write({ ...valid, titles: fixture.rows.map((r) => r.title) }), fixture), /titles/);
  });

  it('rejects runs that are not an object of frozen run names with one answer per title', () => {
    assert.throws(() => readCapture(write({ ...valid, runs: [] }), fixture), /runs is not an object/);
    assert.throws(() => readCapture(write({ ...valid, runs: null }), fixture), /runs is not an object/);
    assert.throws(() => readCapture(write({ ...valid, runs: { 'jev-3': { answers } } }), fixture), /runs\["jev-3"\] is not one of jev-1, jev-2/);
    assert.throws(() => readCapture(write({ ...valid, runs: { 'jev-2': { answers: answers.slice(1) } } }), fixture), new RegExp(`runs\\["jev-2"\\] has ${titles.length - 1} answers for ${titles.length}`));
    assert.throws(() => readCapture(write({ ...valid, runs: { 'jev-2': {} } }), fixture), /runs\["jev-2"\] has undefined answers/);
  });

  it('rejects a malformed answer, naming the file, run and index', () => {
    const bad = [
      [5, 'yes', /is not an object/],
      [5, [], /is not an object/],
      [5, { noul: null }, /level/],
      [5, { level: { ...level, l: 'severe' }, noul: null }, /level/],
      [5, { level: { ...level, levelConf: '0.8' }, noul: null }, /level/],
      [5, { level: { ...level, pAlert: 1.2 }, noul: null }, /level/],
      [5, { level: { l: 'high', levelConf: 0.8 }, noul: null }, /level/],
      [5, { level, noul: { worsening: 0.9, violence: 0.7 } }, /noul/],
      [5, { level, noul: { ...noul, violence: -0.1 } }, /noul/],
      [5, { level, noul: { ...noul, commentary: null } }, /noul/],
      [5, { level }, /noul/],
    ];
    for (const [i, answer, pattern] of bad) {
      const file = write(withAnswer(i, answer));
      assert.throws(() => readCapture(file, fixture), (err) => pattern.test(err.message) && err.message.startsWith(`${file}: runs["jev-1"].answers[${i}] `), JSON.stringify(answer));
    }
  });
});
