// Explicit operator configuration only. Never derive a target or secret name
// from a browser-supplied URL, header, or environment-variable reference.
// The sidecar additionally checks configured origins before honoring this
// process-local marker. It is never serialized as an HTTP header.
export const LOCAL_MCP_FETCH = Symbol.for('worldmonitor.localMcpFetch');

const LOCAL_MODES = new Set(['docker', 'desktop-sidecar', 'tauri-sidecar']);
const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DENIED_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'upgrade',
  'metadata-flavor', 'metadata', 'x-aws-ec2-metadata-token',
  'x-aws-ec2-metadata-token-ttl-seconds',
]);

export function localMcpServerName(raw) {
  if (typeof raw !== 'string') return null;
  return /^mcp-local:\/\/([a-z0-9][a-z0-9_-]{0,63})\/?$/.exec(raw)?.[1] ?? null;
}

function configuredServers(env) {
  if (!LOCAL_MODES.has(env.LOCAL_API_MODE)) return {};
  const raw = env.MCP_LOCAL_SERVERS;
  if (typeof raw !== 'string' || raw.length > 65536) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).length > 16) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function getLocalMcpServer(name, env = process.env) {
  if (typeof name !== 'string' || !SERVER_NAME.test(name)) return null;
  const servers = configuredServers(env);
  if (!Object.hasOwn(servers, name)) return null;
  const entry = servers[name];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || typeof entry.url !== 'string') return null;
  let url;
  try { url = new URL(entry.url); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;

  const refs = entry.headers ?? {};
  if (!refs || typeof refs !== 'object' || Array.isArray(refs) || Object.keys(refs).length > 16) return null;
  const headers = {};
  const seen = new Set();
  for (const [header, ref] of Object.entries(refs)) {
    const lower = header.toLowerCase();
    if (!HEADER_NAME.test(header) || DENIED_HEADERS.has(lower) || seen.has(lower)
      || !ref || typeof ref !== 'object' || Array.isArray(ref)
      || typeof ref.env !== 'string' || !ENV_NAME.test(ref.env)) return null;
    const prefix = ref.prefix ?? '';
    const value = env[ref.env];
    if (typeof prefix !== 'string' || prefix.length > 64 || /[\r\n]/.test(prefix)
      || typeof value !== 'string' || !value || value.length > 8192 || /[\r\n]/.test(value)) return null;
    seen.add(lower);
    headers[header] = prefix + value;
  }
  return { name, url, headers };
}

export function getLocalMcpOrigins(env = process.env) {
  return [...new Set(Object.keys(configuredServers(env))
    .map((name) => getLocalMcpServer(name, env)?.url.origin).filter(Boolean))];
}

export function isLocalMcpUrlAllowed(url, server, { sseEndpoint = false } = {}) {
  if (!server || url.username || url.password || url.hash) return false;
  // Legacy SSE advertises a message endpoint on the configured server. It
  // cannot change scheme, hostname, or port. Streamable HTTP stays exact.
  return sseEndpoint ? url.origin === server.url.origin : url.href === server.url.href;
}
