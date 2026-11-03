// Minimal streamable-HTTP MCP client for the WorldMonitor server.
//
// Speaks JSON-RPC over POST, accepts either a JSON body or an SSE stream back,
// and keeps the Mcp-Session-Id the server hands out on initialize. No SDK so
// the demo has one dependency (the Anthropic SDK) and starts in a second.

const PROTOCOL_VERSION = '2025-06-18';
const USER_AGENT = 'WorldMonitor-VerificationDesk/1.0 (+https://worldmonitor.app)';

export class McpError extends Error {
  constructor(message, { code, data } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

function parseSseBody(text) {
  // Last `data:` event that carries a JSON-RPC response wins.
  let last = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) last = parsed;
    } catch {
      // keep scanning
    }
  }
  return last;
}

export class WorldMonitorMcp {
  // 10 s: on stage a slow answer is as bad as no answer, and every grade step
  // has a fallback. The board and markets snapshots are cached, so one slow
  // call never blocks the next check.
  constructor({ url = 'https://worldmonitor.app/mcp', apiKey, bearerToken, timeoutMs = 10_000, fetchImpl } = {}) {
    if (!apiKey && !bearerToken) {
      throw new McpError('WorldMonitor MCP needs WORLDMONITOR_API_KEY (or WORLDMONITOR_MCP_TOKEN).');
    }
    this.url = url;
    this.apiKey = apiKey;
    this.bearerToken = bearerToken;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.sessionId = null;
    this.nextId = 1;
    this.initializing = null;
  }

  headers() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': USER_AGENT,
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (this.apiKey) headers['X-WorldMonitor-Key'] = this.apiKey;
    if (this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  async rpc(method, params, { notification = false } = {}) {
    const body = notification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: this.nextId++, method, params };
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (notification) return null;
    const text = await res.text();
    if (!res.ok && !text) throw new McpError(`MCP HTTP ${res.status}`, { code: res.status });
    const contentType = res.headers.get('content-type') || '';
    let message;
    try {
      message = contentType.includes('text/event-stream') ? parseSseBody(text) : JSON.parse(text);
    } catch {
      throw new McpError(`MCP returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, { code: res.status });
    }
    if (!message) throw new McpError(`MCP returned no response (HTTP ${res.status})`, { code: res.status });
    if (message.error) {
      throw new McpError(message.error.message || 'MCP error', { code: message.error.code, data: message.error.data });
    }
    return message.result;
  }

  async ensureInitialized() {
    if (this.sessionId) return;
    if (!this.initializing) {
      this.initializing = (async () => {
        await this.rpc('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'verification-desk', version: '1.0.0' },
        });
        await this.rpc('notifications/initialized', {}, { notification: true }).catch(() => {});
      })().finally(() => { this.initializing = null; });
    }
    await this.initializing;
  }

  async listTools() {
    await this.ensureInitialized();
    const result = await this.rpc('tools/list', {});
    return result.tools ?? [];
  }

  /** Calls a tool and returns its structured payload (structuredContent, else parsed text). */
  async callTool(name, args = {}) {
    await this.ensureInitialized();
    const result = await this.rpc('tools/call', { name, arguments: args });
    if (result?.isError) {
      const msg = result.content?.find((c) => c.type === 'text')?.text || `${name} failed`;
      throw new McpError(msg, { data: result });
    }
    let payload;
    if (result?.structuredContent && typeof result.structuredContent === 'object') {
      payload = result.structuredContent;
    } else {
      const text = result?.content?.find((c) => c.type === 'text')?.text;
      if (!text) return {};
      try {
        payload = JSON.parse(text);
      } catch {
        return { text };
      }
    }
    // A payload over the tool's output budget comes back as a SUCCESSFUL,
    // charged result holding only this envelope. Read as data it is an empty
    // board; surfaced as an error it falls back to the archive.
    if (payload?._budget_exceeded) {
      throw new McpError(`${name}: response exceeds WorldMonitor's tool output budget (${payload.actual_bytes} > ${payload.budget_bytes} bytes); lower the limit`, { data: payload });
    }
    return payload;
  }
}

/** Unwraps cache-tool envelopes ({data: {...}} or {<key>: {...}}) to the first object that has `key`. */
export function dig(payload, key) {
  const seen = new Set();
  const stack = [payload];
  while (stack.length) {
    const node = stack.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
  }
  return undefined;
}
