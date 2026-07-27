import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startShim } from './helpers/shim-harness.mjs';

const logDir = () => mkdtempSync(path.join(tmpdir(), 'shim-test-'));
const readLog = (file) =>
  readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function chat(base, body, headers = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('health endpoint responds without auth', async (t) => {
  const { base } = await startShim(t);
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
});

test('models endpoint lists claude tiers', async (t) => {
  const { base } = await startShim(t);
  const r = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer test-key' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.data.map((m) => m.id).sort(), ['haiku', 'opus', 'sonnet']);
});

test('rejects missing or wrong bearer', async (t) => {
  const { base } = await startShim(t);
  const noAuth = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' });
  assert.equal(noAuth.status, 401);
  const wrong = await chat(base, { messages: [] }, { authorization: 'Bearer nope' });
  assert.equal(wrong.status, 401);
});

test('non-stream completion maps CLI json to OpenAI shape', async (t) => {
  const log = path.join(logDir(), 'calls.jsonl');
  const { base } = await startShim(t, { STUB_LOG: log });
  const r = await chat(base, {
    model: 'claude-haiku',
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'ping' },
    ],
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, 'chat.completion');
  assert.equal(j.choices[0].message.role, 'assistant');
  assert.equal(j.choices[0].message.content, 'STUB_RESPONSE');
  assert.equal(j.choices[0].finish_reason, 'stop');
  assert.equal(j.usage.prompt_tokens, 35); // 10 input + 5 cache_creation + 20 cache_read
  assert.equal(j.usage.completion_tokens, 7);
  assert.equal(j.usage.total_tokens, 42);

  const [call] = readLog(log);
  const modelIdx = call.argv.indexOf('--model');
  assert.equal(call.argv[modelIdx + 1], 'haiku');
  const sysIdx = call.argv.indexOf('--system-prompt');
  assert.equal(call.argv[sysIdx + 1], 'You are terse.');
  assert.ok(call.argv.includes('--max-turns'));
  assert.match(call.stdin, /ping/);
});

test('unknown model falls back to default; multi-turn flattens to transcript', async (t) => {
  const log = path.join(logDir(), 'calls.jsonl');
  const { base } = await startShim(t, { STUB_LOG: log, CLAUDE_SHIM_DEFAULT_MODEL: 'sonnet' });
  const r = await chat(base, {
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ],
  });
  assert.equal(r.status, 200);
  const [call] = readLog(log);
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'sonnet');
  assert.match(call.stdin, /User: first[\s\S]*Assistant: reply[\s\S]*User: second/);
});

test('length stop reason maps to finish_reason length', async (t) => {
  const { base } = await startShim(t, { STUB_STOP_REASON: 'max_tokens' });
  const r = await chat(base, { model: 'claude-haiku', messages: [{ role: 'user', content: 'x' }] });
  const j = await r.json();
  assert.equal(j.choices[0].finish_reason, 'length');
});

test('stream:true emits SSE deltas and [DONE]', async (t) => {
  const log = path.join(logDir(), 'calls.jsonl');
  const { base } = await startShim(t, { STUB_LOG: log });
  const r = await chat(base, {
    model: 'claude-sonnet',
    stream: true,
    messages: [{ role: 'user', content: 'stream please' }],
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const raw = await r.text();
  const datas = raw.split('\n\n').filter(Boolean)
    .map((b) => b.replace(/^data: /, '').trim()).filter(Boolean);
  assert.equal(datas[datas.length - 1], '[DONE]');
  const parsed = datas.slice(0, -1).map((d) => JSON.parse(d));
  const text = parsed.map((p) => p.choices?.[0]?.delta?.content || '').join('');
  assert.equal(text, 'STUB STREAM');
  const last = parsed[parsed.length - 1];
  assert.equal(last.choices[0].finish_reason, 'stop');
  const [call] = readLog(log);
  assert.ok(call.argv.includes('stream-json'));
});

test('daily cap returns 429 once exceeded', async (t) => {
  const { base } = await startShim(t, { SHIM_DAILY_CAP: '1' });
  const body = { model: 'claude-haiku', messages: [{ role: 'user', content: 'one' }] };
  assert.equal((await chat(base, body)).status, 200);
  const second = await chat(base, { ...body, messages: [{ role: 'user', content: 'two' }] });
  assert.equal(second.status, 429);
  const health = await (await fetch(`${base}/`)).json();
  assert.equal(health.today, 1);
  assert.equal(health.cap, 1);
});

test('identical non-stream requests are served from cache', async (t) => {
  const log = path.join(logDir(), 'calls.jsonl');
  const { base } = await startShim(t, { STUB_LOG: log });
  const body = { model: 'claude-haiku', messages: [{ role: 'user', content: 'cached?' }] };
  const a = await (await chat(base, body)).json();
  const b = await (await chat(base, body)).json();
  assert.equal(a.choices[0].message.content, b.choices[0].message.content);
  assert.equal(readLog(log).length, 1);
});

test('concurrency limit serializes claude invocations', async (t) => {
  const { base } = await startShim(t, { SHIM_MAX_CONCURRENCY: '1', STUB_SLEEP_MS: '300' });
  const mk = (s) => chat(base, { model: 'claude-haiku', messages: [{ role: 'user', content: s }] });
  const t0 = Date.now();
  const [a, b] = await Promise.all([mk('p1'), mk('p2')]);
  const elapsed = Date.now() - t0;
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.ok(elapsed >= 550, `expected serialized execution, took ${elapsed}ms`);
});

test('queued requests past the queue deadline fail fast without spawning', async (t) => {
  const log = path.join(logDir(), 'calls.jsonl');
  const { base } = await startShim(t, {
    STUB_LOG: log,
    SHIM_MAX_CONCURRENCY: '1',
    STUB_SLEEP_MS: '800',
    SHIM_QUEUE_TIMEOUT_MS: '200',
  });
  const mk = (s) => chat(base, { model: 'claude-haiku', messages: [{ role: 'user', content: s }] });
  const [a, b] = await Promise.all([mk('runs'), mk('rejected')]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 503);
  const j = await b.json();
  assert.match(j.error.message, /queue/i);
  assert.equal(readLog(log).length, 1); // second request never spawned claude
});

// --- Failure-path coverage (added after the adversarial review flagged that a
// truncated stream was delivered as a complete success).

async function collectStream(base, body) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  let text = '';
  let threw = false;
  try {
    for await (const chunk of res.body) text += Buffer.from(chunk).toString('utf8');
  } catch { threw = true; }
  return { status: res.status, text, threw };
}

test('non-stream: is_error result returns 502 with a generic message and no stderr leak', async (t) => {
  const { base } = await startShim(t, { STUB_MODE: 'error' });
  const r = await chat(base, { model: 'claude-haiku', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.doesNotMatch(j.error.message, /stubbed claude error/); // detail stays server-side
});

test('non-stream: unparseable output returns 502, not a fake 200', async (t) => {
  const { base } = await startShim(t, { STUB_MODE: 'garbage' });
  const r = await chat(base, { model: 'claude-haiku', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 502);
});

test('non-stream: is_error result is NOT cached', async (t) => {
  const log = path.join(logDir(), 'calls.jsonl');
  const { base } = await startShim(t, { STUB_MODE: 'error', STUB_LOG: log });
  const body = { model: 'claude-haiku', messages: [{ role: 'user', content: 'same' }] };
  assert.equal((await chat(base, body)).status, 502);
  assert.equal((await chat(base, body)).status, 502);
  assert.equal(readLog(log).length, 2); // both spawned — no poisoned cache entry
});

test('stream: child crash after partial deltas does NOT end with a clean [DONE]', async (t) => {
  const { base } = await startShim(t, { STUB_MODE: 'crash' });
  const { text, threw } = await collectStream(base, {
    model: 'claude-sonnet', messages: [{ role: 'user', content: 'x' }],
  });
  // The partial text may arrive, but the stream must be severed — never a
  // finish_reason:"stop" + [DONE] that the consumer would treat as complete.
  assert.ok(threw || !text.includes('[DONE]'),
    `truncated stream must not deliver [DONE]; got: ${text.slice(-120)}`);
  assert.doesNotMatch(text, /"finish_reason":"stop"/);
});

test('stream: timeout SIGKILL severs the connection, no synthetic stop', async (t) => {
  const { base } = await startShim(t, { STUB_MODE: 'hang', SHIM_TIMEOUT_MS: '400' });
  const { text, threw } = await collectStream(base, {
    model: 'claude-sonnet', messages: [{ role: 'user', content: 'x' }],
  });
  assert.ok(threw || !text.includes('[DONE]'), 'hung stream must not deliver [DONE]');
});

test('stream: is_error result severs instead of completing', async (t) => {
  const { base } = await startShim(t, { STUB_MODE: 'error' });
  const { text, threw } = await collectStream(base, {
    model: 'claude-sonnet', messages: [{ role: 'user', content: 'x' }],
  });
  assert.ok(threw || !text.includes('[DONE]'), 'errored stream must not deliver [DONE]');
});

test('the spawned CLI does not inherit SHIM_API_KEY', async (t) => {
  const log = path.join(logDir(), 'calls.jsonl');
  const { base } = await startShim(t, { STUB_LOG: log });
  await chat(base, { model: 'claude-haiku', messages: [{ role: 'user', content: 'x' }] });
  const [call] = readLog(log);
  assert.equal(call.sawShimKey, false);
});

test('unsupported role and prefill continuation are rejected with 400', async (t) => {
  const { base } = await startShim(t);
  const toolRole = await chat(base, { model: 'claude-haiku', messages: [{ role: 'tool', content: 'x' }] });
  assert.equal(toolRole.status, 400);
  const prefill = await chat(base, { model: 'claude-haiku', messages: [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: 'partial' },
  ] });
  assert.equal(prefill.status, 400);
  const systemOnly = await chat(base, { model: 'claude-haiku', messages: [{ role: 'system', content: 'x' }] });
  assert.equal(systemOnly.status, 400);
});

test('oversized body returns 413, not a connection reset', async (t) => {
  const { base } = await startShim(t);
  const big = 'x'.repeat(1_100_000);
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku', messages: [{ role: 'user', content: big }] }),
  });
  assert.equal(r.status, 413);
});

test('cache hit re-stamps created', async (t) => {
  const { base } = await startShim(t);
  const body = { model: 'claude-haiku', messages: [{ role: 'user', content: 'ts' }] };
  const a = await (await chat(base, body)).json();
  await new Promise((r) => setTimeout(r, 1100));
  const b = await (await chat(base, body)).json();
  assert.notEqual(a.id, b.id);
  assert.ok(b.created >= a.created);
});
