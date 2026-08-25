#!/usr/bin/env node
/**
 * Upstash-compatible Redis REST proxy.
 * Translates REST URL paths to raw Redis commands via redis npm package.
 *
 * Supports:
 *   GET  /{command}/{arg1}/{arg2}/...  → Redis command
 *   POST /                            → JSON body ["COMMAND", "arg1", ...]
 *   POST /pipeline                    → JSON body [["CMD1",...], ["CMD2",...]]
 *   POST /multi-exec                  → JSON body [["CMD1",...], ["CMD2",...]]
 *
 * Env:
 *   REDIS_URL           - Redis connection string (default: redis://redis:6379)
 *   SRH_TOKEN           - Bearer token for auth (default: none)
 *   PORT                - Listen port (default: 80)
 *   SRH_MAX_BODY_BYTES  - Max request body size (default: 16777216 / 16 MB)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createClient } from 'redis';

const REDIS_URL = process.env.SRH_CONNECTION_STRING || process.env.REDIS_URL || 'redis://redis:6379';
const TOKEN = process.env.SRH_TOKEN || '';
const PORT = parseInt(process.env.PORT || '80', 10);

// Redact userinfo before a connection string ever reaches stdout — REDIS_URL
// carries the Redis password (SRH_CONNECTION_STRING: redis://:<password>@host:port)
// and docker logs are readable by anyone with docker/compose access.
function maskRedisUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '<unparsable redis URL>';
  }
}

const client = createClient({ url: REDIS_URL });
client.on('error', (err) => console.error('Redis error:', err.message));
await client.connect();
console.log(`Connected to Redis at ${maskRedisUrl(REDIS_URL)}`);

// Compare BYTE lengths, not String.length. String.length counts UTF-16 code
// units while timingSafeEqual compares bytes, and Node parses header values as
// latin1 — so `Bearer aaa…<0xFF>` matches TOKEN.length while Buffer.from() makes
// it one byte longer, and timingSafeEqual throws RangeError
// ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH. That throw happens above the request
// handler's try block, so it became an unhandled rejection and Node exited:
// one unauthenticated request killed the container. Verified on node 24.
function checkAuth(req) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || '';
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) return false;
  const provided = Buffer.from(auth.slice(prefix.length));
  const expected = Buffer.from(TOKEN);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

// Command safety: allowlist of expected Redis commands.
// Blocks dangerous operations like FLUSHALL, CONFIG SET, EVAL, DEBUG, SLAVEOF.
const ALLOWED_COMMANDS = new Set([
  'GET', 'SET', 'DEL', 'MGET', 'MSET', 'SCAN',
  'TTL', 'EXPIRE', 'PEXPIRE', 'EXISTS', 'TYPE',
  'HGET', 'HSET', 'HDEL', 'HGETALL', 'HMGET', 'HMSET', 'HKEYS', 'HVALS', 'HEXISTS', 'HLEN',
  'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LRANGE', 'LLEN', 'LTRIM', 'LREM',
  'SADD', 'SREM', 'SMEMBERS', 'SISMEMBER', 'SCARD',
  'ZADD', 'ZREM', 'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZSCORE', 'ZCARD', 'ZRANDMEMBER',
  'GEOADD', 'GEOSEARCH', 'GEOPOS', 'GEODIST',
  'INCR', 'DECR', 'INCRBY', 'DECRBY',
  'PING', 'ECHO', 'INFO', 'DBSIZE',
  'PUBLISH', 'SUBSCRIBE',
  'SETNX', 'SETEX', 'PSETEX', 'GETSET',
  'APPEND', 'STRLEN',
]);

async function runCommand(args) {
  const cmd = args[0].toUpperCase();
  if (!ALLOWED_COMMANDS.has(cmd)) {
    throw new Error(`Command not allowed: ${cmd}`);
  }
  const cmdArgs = args.slice(1);
  return client.sendCommand([cmd, ...cmdArgs.map(String)]);
}

// Every seeder that publishes through atomicPublish (scripts/_seed-utils.mjs) is
// capped at MAX_PAYLOAD_BYTES (5 MB) per key, and atomicPublish sends that payload
// as a JSON *string* nested inside ["SET", key, <payload>, "EX", ttl] — so escaping
// makes the wire body strictly larger than the payload (~1.14x on real fire data,
// 2x in the worst case of a payload that is nothing but quotes). 16 MB clears that
// 2x worst case with room to spare; the previous 1 MB cap sat below the ceiling of
// every such seeder, not just the fire seeder's, so on a self-hosted install
// `wildfire:fires:v1` was simply never written (#7099).
//
// The 5 MB bound covers atomicPublish only. seed-forecasts.mjs and
// backtest-resilience-outcomes.mjs each keep a local redisSet() that writes to this
// proxy with no size check, so they are outside the arithmetic above — both
// already degrade gracefully on a 4xx (nonRetryable + warn), and both write small
// cache values in practice.
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MB

function resolveMaxBodyBytes(env = process.env) {
  const raw = env.SRH_MAX_BODY_BYTES;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_MAX_BODY_BYTES;
  }
  const parsed = Number(String(raw).trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.warn(`Ignoring invalid SRH_MAX_BODY_BYTES=${JSON.stringify(String(raw))} — using ${DEFAULT_MAX_BODY_BYTES} bytes`);
    return DEFAULT_MAX_BODY_BYTES;
  }
  return parsed;
}

const MAX_BODY_BYTES = resolveMaxBodyBytes();

// How much of an over-cap body we are willing to read and throw away so the caller
// can finish writing and actually read our 413. Discarded, never buffered — but
// still bounded, so a hostile client cannot use the proxy as an unbounded sink.
//
// The floor matters: derived purely from the cap, lowering SRH_MAX_BODY_BYTES would
// shrink the window in which a 413 is still deliverable, so a 2 MB cap would answer
// a normal 5.98 MB atomicPublish body with a destroyed socket — the exact #7099
// symptom, re-created by the very knob SELF_HOSTING.md offers as the safe way to
// tune this. Draining buffers nothing, so holding the floor at the default costs
// bandwidth only.
const OVERSIZE_DRAIN_BYTES = Math.max(MAX_BODY_BYTES * 2, DEFAULT_MAX_BODY_BYTES);

class PayloadTooLargeError extends Error {
  constructor(limit) {
    super(`Request body too large: limit is ${limit} bytes`);
    this.name = 'PayloadTooLargeError';
    this.statusCode = 413;
  }
}

// The over-cap path used to call req.destroy() and throw, which destroys the
// underlying socket before any response is written. The caller then saw a
// transport failure with no HTTP status at all — `write EPIPE` /
// `other side closed` — which reads as an upstream outage rather than a proxy
// limit, and cost six scheduled seed-fire-detections runs misdiagnosed as a NASA
// FIRMS connectivity problem. Keep reading and discarding instead so the request
// completes normally and the 413 the handler writes is actually delivered.
//
// Event-driven rather than the shorter `for await (const chunk of req)` for one
// reason: draining to 'end' lets the request COMPLETE, so the connection stays
// reusable. Measured — a second request on the same socket after a 413 succeeds.
// Abandoning the body instead (a `break`) does deliver the status, but ends the
// connection. The single req.destroy() is also explicit and greppable here, and
// a test pins it to the drain-cap branch and nowhere else — which matters,
// because destroying before a response is written is the whole #7099 bug.
function readBody(req, limit = MAX_BODY_BYTES, drainLimit = OVERSIZE_DRAIN_BYTES) {
  return new Promise((resolve, reject) => {
    // Well-behaved clients declare Content-Length, so the cheapest and most
    // reliable rejection is before a single byte is buffered: no drain budget is
    // spent, and the 413 is deliverable no matter how far over the cap the body
    // is. Node's own resOnFinish dumps the unread body once the response
    // finishes, so the caller reads the status instead of a reset. Without this,
    // anything past drainLimit falls to the destroy branch below and the caller
    // is back to a statusless EPIPE — the #7099 symptom.
    //
    // Accepted trade-off: Node's dump is not bounded by drainLimit, so a client
    // that declares a huge body still gets those bytes read and discarded. That
    // costs bandwidth, not memory (nothing is buffered), and reaching it needs
    // both SRH_TOKEN and access to a port compose binds to 127.0.0.1 — a caller
    // who has those can issue Redis commands anyway. Bounding it instead would
    // mean closing the connection on every oversize request, losing the
    // keep-alive property the drain below exists to preserve.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      const err = new PayloadTooLargeError(limit);
      err.remoteAddress = req.socket?.remoteAddress;
      reject(err);
      return;
    }

    let chunks = [];
    let totalLength = 0;
    let overflowed = false;
    let settled = false;

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      if (err) reject(err);
      else resolve(value);
    };

    const onData = (chunk) => {
      totalLength += chunk.length;
      if (!overflowed && totalLength > limit) {
        overflowed = true;
        chunks = []; // release what was buffered; it can never be used now
      }
      if (overflowed) {
        if (totalLength > drainLimit) {
          // Read the peer address BEFORE destroying — afterwards req.socket is
          // gone, and this is exactly the branch where the client receives no
          // response and the log line is the only surviving record.
          const err = new PayloadTooLargeError(limit);
          err.remoteAddress = req.socket?.remoteAddress;
          req.destroy();
          settle(err);
        }
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (overflowed) settle(new PayloadTooLargeError(limit));
      else settle(null, Buffer.concat(chunks).toString());
    };
    const onError = (err) => settle(err);

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

// Errors that carry a statusCode answer with it, so the caller gets a diagnosable
// HTTP status (413 is already in the seeder's PERMANENT_4XX_STATUSES, so
// atomicPublish aborts immediately instead of burning its retries on a limit that
// will never pass). Everything else stays a 500.
function respondError(res, err) {
  const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  // Log BEFORE any guard that can return early: when the response can no longer
  // be written the client gets nothing, and this line is then the only surviving
  // record of the rejection. #7099 was a six-run misdiagnosis precisely because
  // the container log said nothing while the caller saw an unexplained transport
  // failure — `docker compose logs redis-rest` must corroborate every rejection.
  if (status === 413) {
    const from = err.remoteAddress || res.socket?.remoteAddress || 'unknown';
    console.warn(`Rejected oversized request body from ${from}: ${err.message}`);
  }
  // headersSent is checked separately from the writability guard below: if
  // something threw between writeHead() and end(), the response is neither ended
  // nor destroyed, so that guard passes and a second writeHead() throws
  // ERR_HTTP_HEADERS_SENT — from inside an async handler's catch, i.e. an
  // unhandled rejection that exits the process. No current path reaches it (every
  // writeHead/end pair here is synchronous and adjacent); this keeps a future one
  // from turning a handled error into a crash.
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (res.writableEnded || res.destroyed || res.socket?.destroyed) return;
  res.writeHead(status);
  res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');

  if (!checkAuth(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    // POST / — single command
    if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
      const body = JSON.parse(await readBody(req));
      const result = await runCommand(body);
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
      return;
    }

    // POST /pipeline — batch commands
    if (req.method === 'POST' && req.url === '/pipeline') {
      const commands = JSON.parse(await readBody(req));
      const results = [];
      for (const cmd of commands) {
        try {
          const result = await runCommand(cmd);
          results.push({ result });
        } catch (err) {
          results.push({ error: err.message });
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify(results));
      return;
    }

    // POST /multi-exec — transaction
    if (req.method === 'POST' && req.url === '/multi-exec') {
      const commands = JSON.parse(await readBody(req));
      const multi = client.multi();
      for (const cmd of commands) {
        const cmdName = cmd[0].toUpperCase();
        if (!ALLOWED_COMMANDS.has(cmdName)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: `Command not allowed: ${cmdName}` }));
          return;
        }
        multi.sendCommand(cmd.map(String));
      }
      const results = await multi.exec();
      res.writeHead(200);
      res.end(JSON.stringify(results.map((r) => ({ result: r }))));
      return;
    }

    // GET / — welcome
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      res.writeHead(200);
      res.end('"Welcome to Serverless Redis HTTP!"');
      return;
    }

    // GET /{command}/{args...} — REST style
    if (req.method === 'GET') {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const parts = pathname.slice(1).split('/').map(decodeURIComponent);
      if (parts.length === 0 || !parts[0]) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No command specified' }));
        return;
      }
      const result = await runCommand(parts);
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
      return;
    }

    // POST /{command}/{args...} — Upstash-compatible path-based POST
    // Used by setCachedJson(): POST /set/<key>/<value>/EX/<ttl>
    if (req.method === 'POST') {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const parts = pathname.slice(1).split('/').map(decodeURIComponent);
      if (parts.length === 0 || !parts[0]) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No command specified' }));
        return;
      }
      const result = await runCommand(parts);
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
      return;
    }

    // OPTIONS
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    respondError(res, err);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Redis REST proxy listening on 0.0.0.0:${PORT}`);
});
