#!/usr/bin/env node
// OpenAI-compatible /v1/chat/completions shim backed by headless Claude Code
// (`claude -p`). Lets self-hosters use a Claude subscription as the `generic`
// LLM provider (LLM_API_URL/LLM_API_KEY) with zero app changes.
// Zero-dependency by design, matching docker/redis-rest-proxy.mjs.
// See SELF_HOSTING.md "Claude Code (use your Claude subscription)".
// Contributed by Will Kemp — liftedholdings.com
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

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

const AUTH_HEADER = `Bearer ${API_KEY}`;
// Constant-time compare, matching docker/redis-rest-proxy.mjs's checkAuth so the
// subscription-backing key can't be probed by response timing. timingSafeEqual
// throws on unequal-length buffers, so the length pre-check gates it.
function authOk(header) {
  if (typeof header !== 'string' || header.length !== AUTH_HEADER.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(AUTH_HEADER));
}

// --- Quota guards: keep a runaway client from draining the Claude subscription.
let capDay = '';
let capCount = 0;
// Rolls the UTC-day window and reports headroom. Call before counting so a
// request queued across midnight lands on the correct day's budget.
function underCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== capDay) { capDay = today; capCount = 0; }
  return capCount < DAILY_CAP;
}
const countCall = () => { capCount += 1; };

let running = 0;
const waiters = [];
// Callers (server/_shared/llm.ts) abort after their own timeout. A request that
// cannot start promptly must fail fast — otherwise it spawns claude after the
// caller has already given up, burning subscription quota for a discarded
// result. Cap re-checks and client-disconnect checks also run at slot entry.
class QueueTimeoutError extends Error {}
class CapError extends Error {}
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
    // Re-check under the slot: many requests can pass the pre-queue underCap()
    // while slots are full, so the count is only authoritative here.
    if (!underCap()) throw new CapError('daily cap reached');
    countCall();
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

// Line-leading "User:" / "Assistant:" markers inside message content would be
// indistinguishable from real transcript turns after flattening. Neutralize
// them so caller content can't forge turns.
function neutralizeRoleMarkers(text) {
  return text.replace(/^(User|Assistant):/gm, '$1​:');
}

class BadRequestError extends Error {}

// OpenAI messages[] -> { system, prompt }. System turns become --system-prompt
// (replacing Claude Code's own system prompt — the big per-call token saving);
// remaining turns are flattened into a single transcript prompt. Supported
// shapes are documented in SELF_HOSTING.md: system + a user/assistant
// transcript. Tool/function roles and assistant-prefill continuation are not
// supported and are rejected rather than silently mislabeled.
function splitMessages(messages) {
  for (const m of messages) {
    if (!['system', 'user', 'assistant'].includes(m.role)) {
      throw new BadRequestError(`unsupported message role: ${m.role}`);
    }
  }
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => contentText(m.content))
    .join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  if (turns.length === 0) {
    throw new BadRequestError('at least one user or assistant message is required');
  }
  if (turns.length > 1 && turns[turns.length - 1].role === 'assistant') {
    throw new BadRequestError('assistant-prefill continuation is not supported');
  }
  const prompt = turns.length === 1
    ? contentText(turns[0].content)
    : `${turns.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${neutralizeRoleMarkers(contentText(m.content))}`).join('\n\n')}\n\nAssistant:`;
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

// Explicit child env: the spawned CLI needs its OAuth credential and a working
// PATH/HOME, but NOT the shim's own secrets (SHIM_API_KEY) or the app's LLM/DB
// env. The prompt is fully attacker-influenced (it embeds third-party feed
// content), so even with tools disabled we don't hand the child anything it
// doesn't need. STUB_* passes through only for the test stub (a local .mjs).
function childEnv() {
  const allow = [
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ',
    'SYSTEMROOT', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR',
  ];
  const env = {};
  for (const k of allow) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLAUDE_') || k.startsWith('ANTHROPIC_')) env[k] = v;
  }
  const viaNode = /\.(mjs|cjs|js)$/i.test(CLAUDE_BIN);
  if (viaNode) {
    for (const [k, v] of Object.entries(process.env)) if (k.startsWith('STUB_')) env[k] = v;
  }
  return env;
}

// The stub CLI used in tests is a .mjs; run scripts through the current node.
function spawnClaude(args) {
  const viaNode = /\.(mjs|cjs|js)$/i.test(CLAUDE_BIN);
  const bin = viaNode ? process.execPath : CLAUDE_BIN;
  const argv = viaNode ? [CLAUDE_BIN, ...args] : args;
  return spawn(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
}

// Error thrown to the client carries only a coarse class; the full stderr/stdout
// is logged server-side, never reflected in the HTTP body.
class ClaudeError extends Error {
  constructor(clientMessage, detail) {
    super(clientMessage);
    this.detail = detail;
  }
}

function runClaude(args, prompt, { isAbandoned = () => false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnClaude(args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(reject, new ClaudeError('upstream claude invocation timed out', `timeout after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    // Abort the child if the caller hangs up — no point finishing a discarded
    // generation, and it frees the concurrency slot immediately.
    const abortPoll = setInterval(() => {
      if (isAbandoned()) {
        clearInterval(abortPoll);
        child.kill('SIGKILL');
        done(reject, new ClaudeError('client disconnected', 'client aborted'));
      }
    }, 250);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearInterval(abortPoll);
      done(reject, new ClaudeError('upstream claude invocation failed', err.message));
    });
    child.on('close', (code) => {
      clearInterval(abortPoll);
      if (settled) return;
      const lines = stdout.trim().split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      let parsed;
      try {
        parsed = JSON.parse(last);
      } catch {
        return done(reject, new ClaudeError('upstream claude invocation failed',
          `exit ${code}, unparseable output: ${(stderr || stdout).slice(0, 500)}`));
      }
      if (parsed.is_error) {
        return done(reject, new ClaudeError('upstream claude returned an error',
          String(parsed.result).slice(0, 500)));
      }
      done(resolve, parsed);
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

class BodyTooLargeError extends Error {}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        req.resume(); // drain rather than destroy, so the 413 can flush
        reject(new BodyTooLargeError('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Streams claude stream-json events to the client as OpenAI SSE chunks.
// A clean stop (a result event with no error) is the ONLY path that writes a
// finish_reason chunk + [DONE]. Any abnormal end — timeout SIGKILL, spawn
// error, is_error result, or the child closing before a clean result —
// destroys the socket mid-body instead, so the consumer's stream reader throws
// and records the turn as truncated (server/_shared/llm.ts) rather than
// treating a cut-off brief as a complete answer.
function streamChat(res, args, prompt, model, { isAbandoned = () => false } = {}) {
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
  let ended = false;
  let timer;
  let abortPoll;
  // Every terminal path routes through finishClean or abort; both clear BOTH
  // the timeout and the abandon-poll interval, so no exit can leak a handle.
  const finishClean = (finishReasonValue) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    clearInterval(abortPoll);
    chunk({}, finishReasonValue);
    res.write('data: [DONE]\n\n');
    res.end();
  };
  const abort = (why) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    clearInterval(abortPoll);
    child.kill('SIGKILL'); // no-op if already dead (child close path)
    console.error(`claude-code-shim: stream aborted: ${why}`);
    res.destroy(); // sever mid-body → caller sees a truncated stream, not success
  };
  timer = setTimeout(() => abort(`timeout after ${TIMEOUT_MS}ms`), TIMEOUT_MS);
  abortPoll = setInterval(() => { if (isAbandoned()) abort('client disconnected'); }, 250);
  chunk({ role: 'assistant' });
  let buf = '';
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
        if (evt.is_error) { abort(`result is_error: ${String(evt.result).slice(0, 200)}`); return; }
        // If the CLI buffered its whole answer (no incremental deltas), emit it
        // as one delta before closing cleanly.
        if (!streamedText && evt.result) chunk({ content: String(evt.result) });
        finishClean(finishReason(evt.stop_reason));
      }
    }
  });
  // The child closing WITHOUT having produced a clean result event is a crash
  // or a kill — abort rather than synthesize a clean stop.
  child.on('close', () => abort('child closed before a clean result'));
  child.on('error', (err) => abort(`spawn error: ${err.message}`));
  res.on('close', () => abort('client closed'));
  child.stdin.end(prompt);
}

async function handleChat(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return sendJson(res, 413, { error: { message: 'request body too large' } });
    }
    return sendJson(res, 400, { error: { message: 'could not read request body' } });
  }
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, { error: { message: 'invalid JSON body' } });
  }
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return sendJson(res, 400, { error: { message: 'messages[] required' } });
  }
  const model = mapModel(body.model);
  let system;
  let prompt;
  try {
    ({ system, prompt } = splitMessages(messages));
  } catch (err) {
    if (err instanceof BadRequestError) return sendJson(res, 400, { error: { message: err.message } });
    throw err;
  }
  let clientGone = false;
  res.on('close', () => { clientGone = !res.writableEnded; });
  const isAbandoned = () => clientGone;
  const slotOpts = { isAbandoned };

  if (body.stream === true) {
    if (!underCap()) return sendJson(res, 429, { error: { message: 'daily cap reached' } });
    return withSlot(
      () => streamChatAwaited(res, claudeArgs({ model, system, stream: true }), prompt, model, isAbandoned),
      slotOpts,
    ).catch((err) => {
      if ((err instanceof QueueTimeoutError || err instanceof CapError) && !res.headersSent) {
        const status = err instanceof CapError ? 429 : 503;
        sendJson(res, status, { error: { message: err.message } });
      }
    });
  }

  const key = cacheKey(model, messages);
  const cached = cacheGet(key);
  if (cached) {
    return sendJson(res, 200, {
      ...cached,
      id: `chatcmpl-${randomUUID()}`,
      created: Math.floor(Date.now() / 1000),
    });
  }
  if (!underCap()) return sendJson(res, 429, { error: { message: 'daily cap reached' } });
  const args = claudeArgs({ model, system, stream: false });
  try {
    const result = await withSlot(() => runClaude(args, prompt, { isAbandoned }), slotOpts);
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
    if (err instanceof CapError) return sendJson(res, 429, { error: { message: err.message } });
    if (err instanceof QueueTimeoutError) return sendJson(res, 503, { error: { message: err.message } });
    // ClaudeError carries a client-safe message; detail is logged, not returned.
    const detail = err instanceof ClaudeError ? err.detail : err.message;
    console.error(`claude-code-shim: completion failed: ${err.message}${detail ? ` (${detail})` : ''}`);
    if (!res.headersSent) sendJson(res, 502, { error: { message: err.message } });
  }
}

// Wraps streamChat so the concurrency slot is held until the SSE stream ends.
function streamChatAwaited(res, args, prompt, model, isAbandoned) {
  return new Promise((resolve) => {
    res.on('close', resolve);
    streamChat(res, args, prompt, model, { isAbandoned });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    underCap(); // roll the day window so `today` is current
    return sendJson(res, 200, { ok: true, today: capCount, cap: DAILY_CAP });
  }
  if (!authOk(req.headers.authorization)) {
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
  const addr = server.address();
  console.log(`claude-code-shim listening on http://${addr.address}:${addr.port}`);
});
