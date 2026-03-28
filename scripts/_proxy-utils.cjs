'use strict';

/**
 * Shared proxy configuration parser used by ais-relay.cjs and _seed-utils.mjs.
 *
 * Supported formats for PROXY_URL:
 *   - http://user:pass@host:port   (standard URL)
 *   - host:port:user:pass          (Decodo/Smartproxy)
 *
 * Returns { host, port, auth: 'user:pass' } or null.
 */
function parseProxyConfig(raw) {
  if (!raw) return null;

  // Standard URL format: http://user:pass@host:port
  try {
    const u = new URL(raw);
    if (u.hostname) {
      return {
        host: u.hostname,
        port: parseInt(u.port, 10),
        auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null,
      };
    }
  } catch { /* fall through */ }

  // Froxy/OREF format: user:pass@host:port
  if (raw.includes('@')) {
    const atIdx = raw.lastIndexOf('@');
    const auth = raw.slice(0, atIdx);
    const hostPort = raw.slice(atIdx + 1);
    const colonIdx = hostPort.lastIndexOf(':');
    if (colonIdx !== -1) {
      const host = hostPort.slice(0, colonIdx);
      const port = parseInt(hostPort.slice(colonIdx + 1), 10);
      if (host && port && auth) return { host, port, auth };
    }
  }

  // Decodo/Smartproxy format: host:port:user:pass
  const parts = raw.split(':');
  if (parts.length >= 4) {
    const host = parts[0];
    const port = parseInt(parts[1], 10);
    const user = parts[2];
    const pass = parts.slice(3).join(':');
    if (host && port && user) return { host, port, auth: `${user}:${pass}` };
  }

  return null;
}

/**
 * Resolve proxy from PROXY_URL only. Returns { host, port, auth } or null.
 * Use this for sources where OREF (IL-exit) proxy must NOT be used (e.g. USNI).
 */
function resolveProxyConfig() {
  return parseProxyConfig(process.env.PROXY_URL || '');
}

/**
 * Resolve proxy from PROXY_URL with fallback to OREF_PROXY_AUTH.
 * Use this for general seeders (fear-greed, disease-outbreaks, etc.).
 */
function resolveProxyConfigWithFallback() {
  return parseProxyConfig(process.env.PROXY_URL || process.env.OREF_PROXY_AUTH || '');
}

/**
 * Returns proxy as "user:pass@host:port" string for use with curl -x.
 * Decodo: gate.decodo.com → us.decodo.com (curl endpoint differs from CONNECT endpoint).
 * Returns empty string if no proxy configured.
 */
function resolveProxyString() {
  const cfg = resolveProxyConfigWithFallback();
  if (!cfg) return '';
  const host = cfg.host.replace(/^gate\./, 'us.');
  return cfg.auth ? `${cfg.auth}@${host}:${cfg.port}` : `${host}:${cfg.port}`;
}

module.exports = { parseProxyConfig, resolveProxyConfig, resolveProxyConfigWithFallback, resolveProxyString };
