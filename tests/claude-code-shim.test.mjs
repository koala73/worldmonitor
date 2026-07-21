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
