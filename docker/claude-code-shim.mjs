#!/usr/bin/env node
// OpenAI-compatible /v1/chat/completions shim backed by headless Claude Code
// (`claude -p`). Lets self-hosters use a Claude subscription as the `generic`
// LLM provider (LLM_API_URL/LLM_API_KEY) with zero app changes.
// Zero-dependency by design, matching docker/redis-rest-proxy.mjs.
// See SELF_HOSTING.md "Claude Code (use your Claude subscription)".
// Contributed by Will Kemp — liftedholdings.com
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8383);
const HOST = process.env.SHIM_HOST || '0.0.0.0';
const API_KEY = process.env.SHIM_API_KEY;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const DEFAULT_MODEL = process.env.CLAUDE_SHIM_DEFAULT_MODEL || 'haiku';
const TIMEOUT_MS = Number(process.env.SHIM_TIMEOUT_MS ?? 120_000);
const MAX_BODY_BYTES = 1_048_576;

if (!API_KEY) {
  console.error('claude-code-shim: SHIM_API_KEY is required');
  process.exit(1);
}

const MAX_CONCURRENCY = Number(process.env.SHIM_MAX_CONCURRENCY ?? 4);
const DAILY_CAP = Number(process.env.SHIM_DAILY_CAP ?? 300);
const CACHE_TTL_MS = Number(process.env.SHIM_CACHE_TTL_MS ?? 900_000);
const QUEUE_TIMEOUT_MS = Number(process.env.SHIM_QUEUE_TIMEOUT_MS ?? 15_000);

const MODELS = ['haiku', 'sonnet', 'opus'];

// --- Quota guards: keep a runaway client from draining the Claude subscription.
let capDay = '';
let capCount = 0;
function underCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== capDay) { capDay = today; capCount = 0; }
  return capCount < DAILY_CAP;
}
const countCall = () => { capCount += 1; };

let running = 0;
const waiters = [];
// Callers (server/_shared/llm.ts) abort at ~25s. A request that cannot start
// promptly must fail fast — otherwise it spawns claude after the caller has
// already given up, burning subscription quota for a discarded result.
class QueueTimeoutError extends Error {}
async function withSlot(fn, { queueTimeoutMs = QUEUE_TIMEOUT_MS, isAbandoned = () => false } = {}) {
  if (running >= MAX_CONCURRENCY) {
    await new Promise((resolve, reject) => {
      const waiter = { resolve, timer: setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        reject(new QueueTimeoutError(`queue wait exceeded ${queueTimeoutMs}ms`));
      }, queueTimeoutMs) };
      waiters.push(waiter);
    });
  }
  running += 1;
  try {
    if (isAbandoned()) throw new QueueTimeoutError('client disconnected while queued');
    return await fn();
  } finally {
    running -= 1;
    const next = waiters.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
  }
}

const cache = new Map(); // key -> { expires, payload }
function cacheKey(model, messages) {
  return createHash('sha256').update(model + JSON.stringify(messages)).digest('hex');
}
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { cache.delete(key); return null; }
  return hit.payload;
}
function cacheSet(key, payload) {
  if (CACHE_TTL_MS <= 0) return;
  if (cache.size > 500) {
    for (const [k, v] of cache) if (v.expires < Date.now()) cache.delete(k);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, payload });
}

function mapModel(name) {
  const n = String(name || '').toLowerCase();
  for (const m of MODELS) if (n.includes(m)) return m;
  return DEFAULT_MODEL;
}

function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n');
  return String(c ?? '');
}

// OpenAI messages[] -> { system, prompt }. System turns become --system-prompt
// (replacing Claude Code's own system prompt — the big per-call token saving);
// conversation turns are flattened into a single transcript prompt.
function splitMessages(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => contentText(m.content))
    .join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  const prompt = turns.length === 1
    ? contentText(turns[0].content)
    : `${turns.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${contentText(m.content)}`).join('\n\n')}\n\nAssistant:`;
  return { system, prompt };
}

function claudeArgs({ model, system, stream }) {
  // --setting-sources '' + --tools '' + a replaced --system-prompt strip the
  // Claude Code session context (user settings, skills, MCP, tool schemas) so a
  // call costs little more than the caller's own prompt.
  const args = [
    '-p',
    '--output-format', stream ? 'stream-json' : 'json',
    '--model', model,
    '--max-turns', '1',
    '--setting-sources', '',
    '--tools', '',
  ];
  if (stream) args.push('--verbose', '--include-partial-messages');
  if (system) args.push('--system-prompt', system);
  return args;
}

// The stub CLI used in tests is a .mjs; run scripts through the current node.
function spawnClaude(args) {
  const viaNode = /\.(mjs|cjs|js)$/i.test(CLAUDE_BIN);
  const bin = viaNode ? process.execPath : CLAUDE_BIN;
  const argv = viaNode ? [CLAUDE_BIN, ...args] : args;
  return spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function runClaude(args, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawnClaude(args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { if (!settled) { clearTimeout(timer); reject(err); } });
    child.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      const lines = stdout.trim().split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      let parsed;
      try {
        parsed = JSON.parse(last);
      } catch {
        return reject(new Error(`claude exited ${code}, unparseable output: ${(stderr || stdout).slice(0, 500)}`));
      }
      if (parsed.is_error) return reject(new Error(`claude error: ${String(parsed.result).slice(0, 500)}`));
      resolve(parsed);
    });
    child.stdin.end(prompt);
  });
}

function toUsage(u = {}) {
  const prompt =
    (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const completion = u.output_tokens || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function finishReason(stopReason) {
  return stopReason === 'max_tokens' ? 'length' : 'stop';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Streams claude stream-json events to the client as OpenAI SSE chunks.
// If no partial text deltas arrive (older CLI without --include-partial-messages
// support), the final result text is emitted as a single delta instead.
function streamChat(res, args, prompt, model) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = `chatcmpl-${randomUUID()}`;
  const chunk = (delta, finish = null) => {
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
  };
  const child = spawnClaude(args);
  let streamedText = false;
  let buf = '';
  let done = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
  const finish = (finishReasonValue) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    chunk({}, finishReasonValue);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  chunk({ role: 'assistant' });
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      const deltaText = evt?.event?.delta?.type === 'text_delta' ? evt.event.delta.text : null;
      if (evt.type === 'stream_event' && deltaText) {
        streamedText = true;
        chunk({ content: deltaText });
      } else if (evt.type === 'result') {
        if (!streamedText && !evt.is_error && evt.result) chunk({ content: String(evt.result) });
        finish(finishReason(evt.stop_reason));
      }
    }
  });
  child.on('close', () => finish('stop'));
  child.on('error', (err) => {
    console.error(`claude-code-shim: stream spawn failed: ${err.message}`);
    finish('stop');
  });
  res.on('close', () => { clearTimeout(timer); child.kill('SIGKILL'); });
  child.stdin.end(prompt);
}

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: { message: 'invalid JSON body' } });
  }
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return sendJson(res, 400, { error: { message: 'messages[] required' } });
  }
  const model = mapModel(body.model);
  const { system, prompt } = splitMessages(messages);
  let clientGone = false;
  res.on('close', () => { clientGone = !res.writableEnded; });
  const slotOpts = { isAbandoned: () => clientGone };
  if (body.stream === true) {
    if (!underCap()) return sendJson(res, 429, { error: { message: 'daily cap reached' } });
    return withSlot(async () => {
      countCall();
      return streamChatAwaited(res, claudeArgs({ model, system, stream: true }), prompt, model);
    }, slotOpts).catch((err) => {
      if (err instanceof QueueTimeoutError && !res.headersSent) {
        sendJson(res, 503, { error: { message: `busy: ${err.message}` } });
      }
    });
  }
  const key = cacheKey(model, messages);
  const cached = cacheGet(key);
  if (cached) return sendJson(res, 200, { ...cached, id: `chatcmpl-${randomUUID()}` });
  if (!underCap()) return sendJson(res, 429, { error: { message: 'daily cap reached' } });
  const args = claudeArgs({ model, system, stream: false });
  try {
    const result = await withSlot(() => {
      countCall();
      return runClaude(args, prompt);
    }, slotOpts);
    const payload = {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: String(result.result ?? '') },
        finish_reason: finishReason(result.stop_reason),
      }],
      usage: toUsage(result.usage),
    };
    cacheSet(key, payload);
    return sendJson(res, 200, payload);
  } catch (err) {
    if (err instanceof QueueTimeoutError) {
      return sendJson(res, 503, { error: { message: `busy: ${err.message}` } });
    }
    console.error(`claude-code-shim: completion failed: ${err.message}`);
    return sendJson(res, 502, { error: { message: err.message } });
  }
}

// Wraps streamChat so the concurrency slot is held until the SSE stream ends.
function streamChatAwaited(res, args, prompt, model) {
  return new Promise((resolve) => {
    res.on('close', resolve);
    streamChat(res, args, prompt, model);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    underCap(); // roll the day window so `today` is current
    return sendJson(res, 200, { ok: true, today: capCount, cap: DAILY_CAP });
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${API_KEY}`) {
    return sendJson(res, 401, { error: { message: 'unauthorized' } });
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return sendJson(res, 200, {
      object: 'list',
      data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'claude-code' })),
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return handleChat(req, res);
  }
  return sendJson(res, 404, { error: { message: 'not found' } });
});

// Node's 5s keep-alive default races pooled client connections (undici/fetch
// reuses an idle socket exactly as the server closes it → ECONNRESET, and the
// caller's provider chain treats the shim as failed). Outlive typical client
// idle-reuse windows instead.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(PORT, HOST, () => {
  console.log(`claude-code-shim listening on http://127.0.0.1:${server.address().port}`);
});
