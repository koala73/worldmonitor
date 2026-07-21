#!/usr/bin/env node
// OpenAI-compatible /v1/chat/completions shim backed by headless Claude Code
// (`claude -p`). Lets self-hosters use a Claude subscription as the `generic`
// LLM provider (LLM_API_URL/LLM_API_KEY) with zero app changes.
// Zero-dependency by design, matching docker/redis-rest-proxy.mjs.
// See SELF_HOSTING.md "Claude Code (use your Claude subscription)".
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

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

const MODELS = ['haiku', 'sonnet', 'opus'];

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
  const args = [
    '-p',
    '--output-format', stream ? 'stream-json' : 'json',
    '--model', model,
    '--max-turns', '1',
    '--setting-sources', '',
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
  if (body.stream === true) {
    return streamChat(res, claudeArgs({ model, system, stream: true }), prompt, model);
  }
  const args = claudeArgs({ model, system, stream: false });
  try {
    const result = await runClaude(args, prompt);
    return sendJson(res, 200, {
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
    });
  } catch (err) {
    console.error(`claude-code-shim: completion failed: ${err.message}`);
    return sendJson(res, 502, { error: { message: err.message } });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, { ok: true });
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

server.listen(PORT, HOST, () => {
  console.log(`claude-code-shim listening on http://127.0.0.1:${server.address().port}`);
});
