// Runs the user's local Claude Code (`claude -p`) as a research and writing
// engine for the Phenomena view. No API key: the subprocess uses whatever the
// user's `claude` login already has. Output is the stream-json protocol, parsed
// line by line so the view can show the research being "spoken out" (searches,
// pages read, partial text) while it happens.
import { spawn } from 'node:child_process';
import { findExecutable } from '../video.mjs';

export const DEFAULT_MODEL = 'opus';

// Locate the claude binary; honours WM_CLAUDE_BIN for odd installs.
export function findClaude(env = process.env) {
  if (env.WM_CLAUDE_BIN) return env.WM_CLAUDE_BIN;
  return findExecutable('claude', env);
}

// Arguments for one non-interactive run. `tools` empty means pure writing.
export function claudeArgs({ model = DEFAULT_MODEL, system = '', tools = [], maxTurns = 1, effort = null } = {}) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model, '--max-turns', String(maxTurns), '--setting-sources', '', '--exclude-dynamic-system-prompt-sections', '--disable-slash-commands', '--tools', tools.join(',')];
  if (tools.length) args.push('--allowedTools', tools.join(','));
  if (system) args.push('--system-prompt', system);
  if (effort) args.push('--effort', effort);
  return args;
}

// Parse one stream-json line into a compact event for the UI, or null.
// Returns { type: 'text', text } | { type: 'tool', name, input } | { type: 'result', ok, text, error, cost, durationMs } | { type: 'status', text }.
export function parseStreamLine(line) {
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  if (d.type === 'stream_event') {
    const e = d.event || {};
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') return { type: 'text', text: e.delta.text || '' };
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') return { type: 'tool_start', name: e.content_block.name || '' };
    return null;
  }
  if (d.type === 'assistant') {
    // The complete message carries tool inputs (queries, URLs) the deltas split up.
    const tools = (d.message?.content || []).filter((c) => c.type === 'tool_use').map((c) => ({ type: 'tool', name: c.name, input: c.input || {} }));
    return tools.length ? { type: 'tools', tools } : null;
  }
  if (d.type === 'result') {
    const err = d.is_error ? String(d.result || d.error || 'claude failed') : '';
    return { type: 'result', ok: !d.is_error, text: String(d.result || ''), error: err, cost: d.total_cost_usd || 0, durationMs: d.duration_ms || 0, turns: d.num_turns || 0 };
  }
  if (d.type === 'rate_limit_event' && d.rate_limit_info?.status === 'rejected') return { type: 'status', text: 'rate limited', rateLimited: true };
  return null;
}

// Human line for a tool call, for the research log.
export function describeTool(name, input = {}) {
  if (name === 'WebSearch') return `⌕ searching: ${input.query || ''}`;
  if (name === 'WebFetch') return `⇣ reading: ${String(input.url || '').replace(/^https?:\/\//, '').slice(0, 90)}`;
  return `⚙ ${name}`;
}

export class ClaudeRunner {
  constructor({ env = process.env, spawnImpl = spawn, cwd = null, model = null } = {}) {
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.cwd = cwd;
    this.model = model || env.WM_PHENOMENA_MODEL || DEFAULT_MODEL;
    this.bin = findClaude(env);
    this.procs = new Set();
  }

  get available() {
    return Boolean(this.bin);
  }

  // Run one prompt. Resolves to { ok, text, error, cost, durationMs, log }.
  // onEvent receives the parsed events as they stream.
  run({ prompt, system = '', tools = [], maxTurns = 1, onEvent = () => {}, signal = null, effort = null, timeoutMs = 25 * 60000 }) {
    return new Promise((resolve) => {
      if (!this.bin) return resolve({ ok: false, error: 'claude not found: install Claude Code (npm i -g @anthropic-ai/claude-code) and sign in once', text: '', cost: 0, durationMs: 0 });
      // A nested Claude Code refuses to start while these are set.
      const env = { ...this.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      const args = claudeArgs({ model: this.model, system, tools, maxTurns, effort });
      let child;
      try {
        // npm's Windows shims are .cmd files and need a shell; elsewhere spawn directly so signals reach the CLI.
        const shell = /\.(cmd|bat)$/i.test(this.bin);
        child = this.spawnImpl(this.bin, args, { cwd: this.cwd || undefined, env, stdio: ['pipe', 'pipe', 'pipe'], shell });
      } catch (err) {
        return resolve({ ok: false, error: `could not start claude: ${err.message}`, text: '', cost: 0, durationMs: 0 });
      }
      this.procs.add(child);
      const started = Date.now();
      let buf = '';
      let text = '';
      let result = null;
      let stderr = '';
      let rateLimited = false;
      const finish = (extra = {}) => {
        this.procs.delete(child);
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        const out = result || { ok: false, error: extra.error || (stderr.trim().split('\n').pop() || 'claude exited without a result'), text, cost: 0, durationMs: Date.now() - started };
        if (!out.ok && rateLimited && !/limit/i.test(out.error)) out.error = `rate limited: ${out.error}`;
        out.text = out.text || text;
        resolve(out);
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish({ error: 'timed out' });
      }, timeoutMs);
      const onAbort = () => {
        child.kill('SIGTERM');
        finish({ error: 'cancelled' });
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const ev = parseStreamLine(line);
          if (!ev) continue;
          if (ev.type === 'text') text += ev.text;
          if (ev.type === 'status' && ev.rateLimited) rateLimited = true;
          if (ev.type === 'result') result = { ok: ev.ok, text: ev.text || text, error: ev.error, cost: ev.cost, durationMs: ev.durationMs, turns: ev.turns };
          try {
            onEvent(ev);
          } catch {
            // the view's log must never break the stream
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => {
        stderr += c;
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      child.on('error', (err) => finish({ error: err.message }));
      child.on('close', () => finish());
      // claude can exit before reading the whole prompt (auth, rate limit); EPIPE must not crash the dashboard.
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }

  cancelAll() {
    for (const p of this.procs) p.kill('SIGTERM');
    this.procs.clear();
  }
}
