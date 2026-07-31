'use strict';

const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const zlib = require('node:zlib');

const DECODO_GATE_HOST = 'gate.decodo.com';
// Decodo's curl endpoint differs from its CONNECT endpoint.
const DECODO_CURL_HOST = 'us.decodo.com';
const DECODO_STICKY_PORT_MIN = 10_001;
const DECODO_STICKY_PORT_MAX = 49_999;

function parseProxyConfig(raw) {
  if (!raw) return null;

  // Standard URL format: http://user:pass@host:port or https://user:pass@host:port
  try {
    const u = new URL(raw);
    if (u.hostname && (u.protocol === 'http:' || u.protocol === 'https:')) {
      const tls = u.protocol === 'https:';
      return {
        host: u.hostname,
        port: u.port ? parseInt(u.port, 10) : (tls ? 443 : 80),
        auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null,
        tls,
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
      if (host && port && auth) return { host, port, auth, tls: true };
    }
  }

  // Decodo/Smartproxy format: host:port:user:pass
  const parts = raw.split(':');
  if (parts.length >= 4) {
    const host = parts[0];
    const port = parseInt(parts[1], 10);
    const user = parts[2];
    const pass = parts.slice(3).join(':');
    if (host && port && user) return { host, port, auth: `${user}:${pass}`, tls: true };
  }

  return null;
}

/**
 * Parse a proxy configuration and, for Decodo sticky gateway ports, advance
 * each retry to a distinct sticky session. Other providers and Decodo rotating
 * ports retain their configured route exactly.
 */
function parseProxyConfigForAttempt(raw, attempt = 0) {
  const config = parseProxyConfig(raw);
  if (!config) return null;
  const port = Number(config.port);
  // Normalize for provider detection only: the host:port:user:pass form keeps
  // whatever casing the operator typed, while the URL form is lowercased by the
  // URL parser. config.host stays verbatim so the connection is unchanged.
  const host = String(config.host || '').toLowerCase().replace(/\.$/u, '');
  if (
    host !== DECODO_GATE_HOST
    || !Number.isInteger(port)
    || port < DECODO_STICKY_PORT_MIN
    || port > DECODO_STICKY_PORT_MAX
  ) {
    return config;
  }

  const stickyPortCount = DECODO_STICKY_PORT_MAX - DECODO_STICKY_PORT_MIN + 1;
  return {
    ...config,
    port: DECODO_STICKY_PORT_MIN
      + ((port - DECODO_STICKY_PORT_MIN + attempt) % stickyPortCount),
  };
}

/**
 * Resolve proxy from PROXY_URL only. Returns { host, port, auth } or null.
 * Use this for sources where OREF (IL-exit) proxy must NOT be used (e.g. USNI).
 */
function resolveProxyConfig() {
  return parseProxyConfig(process.env.PROXY_URL || '');
}

/**
 * Resolve proxy from PROXY_URL only.
 * OREF_PROXY_AUTH is IL-exit and expensive — reserved exclusively for OREF alerts.
 */
function resolveProxyConfigWithFallback() {
  return parseProxyConfig(process.env.PROXY_URL || '');
}

/**
 * Returns proxy as "user:pass@host:port" string for use with curl -x.
 * Decodo: gate.decodo.com → us.decodo.com (curl endpoint differs from CONNECT endpoint).
 * Returns empty string if no proxy configured.
 */
function resolveProxyString(raw = process.env.PROXY_URL || '') {
  const cfg = parseProxyConfig(raw);
  if (!cfg) return '';
  // Exact provider match, not a `gate.` prefix rewrite. Two reasons:
  //   - parseProxyConfig's host:port:user:pass branch returns parts[0] verbatim,
  //     so an operator's casing reaches this compare unchanged; a case-sensitive
  //     match silently skipped the rewrite and left a curl caller pointed at the
  //     CONNECT endpoint.
  //   - a prefix match rewrites ANY `gate.*` host, so an unrelated proxy would be
  //     redirected to a Decodo endpoint with its credentials attached. Matching
  //     the one host we actually mean keeps every other provider untouched.
  const normalizedHost = String(cfg.host || '').toLowerCase().replace(/\.$/u, '');
  const host = normalizedHost === DECODO_GATE_HOST ? DECODO_CURL_HOST : cfg.host;
  return cfg.auth ? `${cfg.auth}@${host}:${cfg.port}` : `${host}:${cfg.port}`;
}

/**
 * Returns proxy as "user:pass@host:port" string for use with HTTP CONNECT tunneling.
 * Does NOT replace gate.decodo.com → us.decodo.com; CONNECT endpoint is gate.decodo.com.
 * When PROXY_URL uses https:// (TLS proxy), returns "https://user:pass@host:port" so
 * httpsProxyFetchJson uses tls.connect to the proxy instead of plain net.connect.
 * Returns empty string if no proxy configured.
 */
function resolveProxyStringConnect() {
  const cfg = resolveProxyConfigWithFallback();
  if (!cfg) return '';
  const base = cfg.auth ? `${cfg.auth}@${cfg.host}:${cfg.port}` : `${cfg.host}:${cfg.port}`;
  return cfg.tls ? `https://${base}` : base;
}

function proxyConnectTunnel(targetHostname, proxyConfig, { timeoutMs = 20_000, targetPort = 443, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(signal.reason || new Error('aborted'));
    }

    let proxySock;
    let settled = false;
    let onAbort = null;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (val) => { if (settled) return; settled = true; cleanup(); resolve(val); };
    const rejectOnce = (err) => { if (settled) return; settled = true; cleanup(); reject(err); };

    const timer = setTimeout(() => {
      if (proxySock) proxySock.destroy();
      rejectOnce(new Error('CONNECT tunnel timeout'));
    }, timeoutMs);

    if (signal) {
      onAbort = () => {
        if (proxySock) proxySock.destroy();
        rejectOnce(signal.reason || new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const onError = (e) => rejectOnce(e);

    const connectCb = () => {
      const authHeader = proxyConfig.auth
        ? `\r\nProxy-Authorization: Basic ${Buffer.from(proxyConfig.auth).toString('base64')}`
        : '';
      proxySock.write(
        `CONNECT ${targetHostname}:${targetPort} HTTP/1.1\r\nHost: ${targetHostname}:${targetPort}${authHeader}\r\n\r\n`
      );

      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('ascii');
        if (!buf.includes('\r\n\r\n')) return;
        proxySock.removeListener('data', onData);
        const statusLine = buf.split('\r\n')[0];
        if (!statusLine.startsWith('HTTP/1.1 200') && !statusLine.startsWith('HTTP/1.0 200')) {
          proxySock.destroy();
          return rejectOnce(
            Object.assign(new Error(`Proxy CONNECT: ${statusLine}`), {
              status: parseInt(statusLine.split(' ')[1], 10) || 0,
              // Marks a gateway-layer rejection (auth, quota, policy) as opposed
              // to a status the target origin returned through the tunnel. The
              // two are indistinguishable once both collapse to HTTP_<status>,
              // and only the origin case can be helped by a different exit.
              proxyConnect: true,
            })
          );
        }
        proxySock.pause();

        const tlsSocket = tls.connect(
          { socket: proxySock, servername: targetHostname, ALPNProtocols: ['http/1.1'] },
          () => {
            proxySock.resume();
            resolveOnce({
              socket: tlsSocket,
              destroy: () => { tlsSocket.destroy(); proxySock.destroy(); },
            });
          }
        );
        tlsSocket.on('error', onError);
      };
      proxySock.on('data', onData);
    };

    if (proxyConfig.tls) {
      proxySock = tls.connect(
        { host: proxyConfig.host, port: proxyConfig.port, servername: proxyConfig.host, ALPNProtocols: ['http/1.1'] },
        connectCb
      );
    } else {
      proxySock = net.connect({ host: proxyConfig.host, port: proxyConfig.port }, connectCb);
    }
    proxySock.on('error', onError);
  });
}

function readBoundedResponseStream(stream, maxResponseBytes = Infinity) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let responseBytes = 0;
    stream.on('data', (chunk) => {
      responseBytes += chunk.byteLength;
      if (responseBytes > maxResponseBytes) {
        stream.destroy();
        reject(Object.assign(new Error('proxy response too large'), {
          code: 'RESPONSE_TOO_LARGE',
        }));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function proxyFetch(url, proxyConfig, {
  accept = '*/*',
  headers = {},
  method = 'GET',
  body = null,
  maxResponseBytes = Infinity,
  timeoutMs = 20_000,
  signal,
} = {}) {
  const targetUrl = new URL(url);

  if (signal && signal.aborted) {
    return Promise.reject(signal.reason || new Error('aborted'));
  }

  return proxyConnectTunnel(targetUrl.hostname, proxyConfig, { timeoutMs, signal }).then(({ socket: tlsSocket, destroy }) => {
    return new Promise((resolve, reject) => {
      let settled = false;
      let onAbort = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      // Both terminal paths destroy the TLS tunnel (mirrors the original
      // behavior where success + failure both released the socket).
      const resolveOnce = (v) => { if (settled) return; settled = true; cleanup(); destroy(); resolve(v); };
      const rejectOnce = (e) => { if (settled) return; settled = true; cleanup(); destroy(); reject(e); };

      const timer = setTimeout(() => rejectOnce(new Error('proxy fetch timeout')), timeoutMs);

      if (signal) {
        onAbort = () => rejectOnce(signal.reason || new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const reqHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: accept,
        'Accept-Encoding': 'gzip, deflate',
        ...headers,
      };
      if (body != null && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
        reqHeaders['Content-Length'] = Buffer.byteLength(body);
      }

      const req = https.request({
        hostname: targetUrl.hostname,
        path: targetUrl.pathname + targetUrl.search,
        method,
        headers: reqHeaders,
        createConnection: () => tlsSocket,
      }, (resp) => {
        let stream = resp;
        const enc = (resp.headers['content-encoding'] || '').trim().toLowerCase();
        if (enc === 'gzip') stream = resp.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = resp.pipe(zlib.createInflate());

        readBoundedResponseStream(stream, maxResponseBytes).then(
          (buffer) => resolveOnce({
            ok: resp.statusCode >= 200 && resp.statusCode < 300,
            status: resp.statusCode,
            buffer,
            contentType: resp.headers['content-type'] || '',
          }),
          rejectOnce,
        );
      });
      req.on('error', rejectOnce);
      if (body != null) req.write(body);
      req.end();
    });
  });
}

module.exports = {
  parseProxyConfig,
  parseProxyConfigForAttempt,
  resolveProxyConfig,
  resolveProxyConfigWithFallback,
  resolveProxyString,
  resolveProxyStringConnect,
  proxyConnectTunnel,
  proxyFetch,
  _readBoundedResponseStream: readBoundedResponseStream,
};
