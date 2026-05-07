'use strict';

const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const zlib = require('node:zlib');
function parseProxyConfig(raw) {
  if (!raw) return null;

  // Standard URL format: http://user:pass@host:port or https://user:pass@host:port
  try {
    const u = new URL(raw);
    if (u.hostname) {
      return {
        host: u.hostname,
        port: parseInt(u.port, 10),
        auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null,
        tls: u.protocol === 'https:',
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
function resolveProxyString() {
  const cfg = resolveProxyConfigWithFallback();
  if (!cfg) return '';
  const host = cfg.host.replace(/^gate\./, 'us.');
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
              status: parseInt(statusLine.split(' ')[1]) || 0,
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

function proxyFetch(url, proxyConfig, {
  accept = '*/*',
  headers = {},
  method = 'GET',
  body = null,
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

        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          resolveOnce({
            ok: resp.statusCode >= 200 && resp.statusCode < 300,
            status: resp.statusCode,
            buffer: Buffer.concat(chunks),
            contentType: resp.headers['content-type'] || '',
          });
        });
        stream.on('error', rejectOnce);
      });
      req.on('error', rejectOnce);
      if (body != null) req.write(body);
      req.end();
    });
  });
}

module.exports = { parseProxyConfig, resolveProxyConfig, resolveProxyConfigWithFallback, resolveProxyString, resolveProxyStringConnect, proxyConnectTunnel, proxyFetch };
