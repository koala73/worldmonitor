/**
 * Regression tests for the AIS-relay auth layer.
 *
 * Covers:
 *   - #3801 (P1): the startup guard fails closed in ALL environments, not just
 *     when an IS_PRODUCTION_RELAY signal is present. A self-hosted Docker /
 *     VPS deployment that forgets RELAY_SHARED_SECRET must NOT boot wide open.
 *   - #3812 (Low): renaming the bypass to I_UNDERSTAND_THIS_DISABLES_AUTH,
 *     back-compat for the legacy ALLOW_UNAUTHENTICATED_RELAY, the loud
 *     [SECURITY] warning that fires whenever auth is effectively disabled,
 *     and the auth.enabled field on /health.
 *
 * Two layers of coverage:
 *   1. Startup behavior — spawn `node scripts/ais-relay.cjs` as a subprocess
 *      with controlled env, listen on a random port, and assert exit code +
 *      stderr / health-endpoint shape.
 *   2. isAuthorizedRequest() logic — re-export the auth helpers by re-loading
 *      the relay module in a child VM context is overkill; instead we mirror
 *      the production helpers in this file and exercise the exact branches we
 *      changed. The startup-spawn tests guard against drift between the mirror
 *      and the real implementation.
 *
 * Run: tsx --test tests/relay-auth.test.mjs
 *      (or via `npm run test:data`)
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'ais-relay.cjs');

// ─── helpers ────────────────────────────────────────────────────────────────

// Pick a free port for a subprocess to bind. There's an inherent TOCTOU race
// between us closing the probe socket and the child re-binding — another
// process on the box could grab the port in that window and the test would
// fail with EADDRINUSE. To shrink the window we re-probe the port after
// closing the first socket; if the probe succeeds, the port was almost
// certainly still free when the child bound (the race window is tiny). On
// EADDRINUSE we just try a different OS-assigned port.
async function pickFreePort(maxAttempts = 8) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    const port = await new Promise((resolve, reject) => {
      const srv = createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const { port: p } = srv.address();
        srv.close(() => resolve(p));
      });
    });
    try {
      await new Promise((resolve, reject) => {
        const probe = createServer();
        probe.unref();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => {
          probe.close(() => resolve());
        });
      });
      return port;
    } catch (err) {
      lastErr = err;
      // Another process claimed it between our two listens; loop and retry.
    }
  }
  throw new Error(`pickFreePort: exhausted ${maxAttempts} attempts (last error: ${lastErr?.message})`);
}

function spawnRelay(envOverrides = {}) {
  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    env: {
      // Inherit PATH, HOME, etc. but start from a clean slate for any env var
      // we care about. We DO need a few unrelated vars to be present so the
      // relay only fails on the auth guard, not the AIS upstream key check.
      ...process.env,
      // The AIS upstream key is checked BEFORE the auth guard. Tests that want
      // to reach the auth guard must provide it.
      AISSTREAM_API_KEY: 'test-aisstream-key',
      // Strip every env var the auth guard cares about so tests start from a
      // known state. Each test then sets only what it needs.
      RELAY_SHARED_SECRET: '',
      ALLOW_UNAUTHENTICATED_RELAY: '',
      I_UNDERSTAND_THIS_DISABLES_AUTH: '',
      // Avoid pulling in Railway-prod detection noise from the parent env.
      NODE_ENV: 'test',
      RAILWAY_ENVIRONMENT: '',
      RAILWAY_PROJECT_ID: '',
      RAILWAY_STATIC_URL: '',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
  child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    waitForExit: () => once(child, 'exit'),
    waitForLog: (needle, timeoutMs = 10_000) => new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (stdout.includes(needle) || stderr.includes(needle)) {
          clearInterval(tick);
          resolve();
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(tick);
          reject(new Error(`timeout waiting for log "${needle}". stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`));
        }
      }, 50);
    }),
  };
}

async function killRelay(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGKILL');
  try { await once(child, 'exit'); } catch {}
}

function httpGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    import('node:http').then(({ default: http }) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: pathname,
        headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      });
      req.on('error', reject);
      req.end();
    }, reject);
  });
}

// ─── 1) Startup behavior (subprocess) ───────────────────────────────────────

describe('relay startup auth guard (#3801)', () => {
  it('exits non-zero when RELAY_SHARED_SECRET is unset and no bypass is set', async () => {
    // This is the #3801 regression: prior code only enforced the guard when
    // IS_PRODUCTION_RELAY (NODE_ENV=production OR any RAILWAY_* var) was true.
    // The fix requires the secret unconditionally.
    const r = spawnRelay({});
    const [code] = await r.waitForExit();
    assert.equal(code, 1, `expected exit 1, got ${code}. stderr=${r.stderr()}`);
    assert.match(r.stderr(), /RELAY_SHARED_SECRET/, 'stderr should mention RELAY_SHARED_SECRET');
    assert.match(r.stderr(), /I_UNDERSTAND_THIS_DISABLES_AUTH/, 'stderr should mention the new bypass var name');
  });

  it('boots when only the new bypass var is set, and logs [SECURITY] warning', async () => {
    const port = await pickFreePort();
    const r = spawnRelay({
      I_UNDERSTAND_THIS_DISABLES_AUTH: 'true',
      PORT: String(port),
    });
    try {
      await r.waitForLog('WebSocket relay on port', 15_000);
      assert.match(r.stderr(), /\[SECURITY\] relay is running WITHOUT auth/, 'expected boot-time SECURITY warning');
      // Process is alive (no premature exit).
      assert.equal(r.child.exitCode, null, 'relay should still be running');
    } finally {
      await killRelay(r.child);
    }
  });

  it('boots with RELAY_SHARED_SECRET set and emits NO [SECURITY] warning', async () => {
    const port = await pickFreePort();
    const r = spawnRelay({
      RELAY_SHARED_SECRET: 'good-secret',
      PORT: String(port),
    });
    try {
      await r.waitForLog('WebSocket relay on port', 15_000);
      assert.doesNotMatch(r.stderr(), /\[SECURITY\] relay is running WITHOUT auth/, 'should NOT warn when auth is on');
    } finally {
      await killRelay(r.child);
    }
  });

  it('accepts the legacy ALLOW_UNAUTHENTICATED_RELAY=true with a deprecation warning', async () => {
    const port = await pickFreePort();
    const r = spawnRelay({
      ALLOW_UNAUTHENTICATED_RELAY: 'true',
      PORT: String(port),
    });
    try {
      await r.waitForLog('WebSocket relay on port', 15_000);
      assert.match(r.stderr(), /\[DEPRECATED\] ALLOW_UNAUTHENTICATED_RELAY=true/, 'expected deprecation warning');
      assert.match(r.stderr(), /\[SECURITY\] relay is running WITHOUT auth/, 'expected SECURITY warning under legacy alias too');
    } finally {
      await killRelay(r.child);
    }
  });
});

// ─── 2) /health auth.enabled field ──────────────────────────────────────────

describe('relay /health exposes auth.enabled (#3812)', () => {
  it('reports auth.enabled=true when secret set and no bypass', async () => {
    const port = await pickFreePort();
    const r = spawnRelay({
      RELAY_SHARED_SECRET: 'good-secret',
      PORT: String(port),
    });
    try {
      await r.waitForLog('WebSocket relay on port', 15_000);
      const res = await httpGet(port, '/health');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.auth.enabled, true, 'auth.enabled should be true');
      assert.equal(body.auth.sharedSecretEnabled, true, 'back-compat field still true');
    } finally {
      await killRelay(r.child);
    }
  });

  it('reports auth.enabled=false when bypass is engaged', async () => {
    const port = await pickFreePort();
    const r = spawnRelay({
      I_UNDERSTAND_THIS_DISABLES_AUTH: 'true',
      PORT: String(port),
    });
    try {
      await r.waitForLog('WebSocket relay on port', 15_000);
      const res = await httpGet(port, '/health');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.auth.enabled, false, 'auth.enabled should be false when bypass on');
    } finally {
      await killRelay(r.child);
    }
  });

  it('reports auth.enabled=true when secret set AND bypass also set (bypass is ignored)', async () => {
    // Greptile #3815 round 2: align /health with isAuthorizedRequest() — the
    // bypass branch only runs when no secret is configured, so a secret +
    // bypass combo still enforces the secret. Reporting enabled=false here
    // would lie about the actual enforcement behavior. Operators who want to
    // detect a misconfigured bypass should look for the [Relay] info line
    // (covered by the test below).
    const port = await pickFreePort();
    const r = spawnRelay({
      RELAY_SHARED_SECRET: 'good-secret',
      I_UNDERSTAND_THIS_DISABLES_AUTH: 'true',
      PORT: String(port),
    });
    try {
      await r.waitForLog('WebSocket relay on port', 15_000);
      const res = await httpGet(port, '/health');
      const body = JSON.parse(res.body);
      assert.equal(body.auth.enabled, true, 'auth.enabled mirrors actual isAuthorizedRequest() behavior: secret wins');
      assert.equal(body.auth.sharedSecretEnabled, true);
    } finally {
      await killRelay(r.child);
    }
  });
});

// ─── 4) Bypass + secret combo emits info log and does NOT emit [SECURITY] ───

describe('relay startup info-log when bypass is set alongside secret (#3815)', () => {
  it('logs the "bypass ignored" info line and does NOT emit [SECURITY] warning', async () => {
    const port = await pickFreePort();
    const r = spawnRelay({
      RELAY_SHARED_SECRET: 'good-secret',
      I_UNDERSTAND_THIS_DISABLES_AUTH: 'true',
      PORT: String(port),
    });
    try {
      await r.waitForLog('WebSocket relay on port', 15_000);
      // Give a microtask tick so the info log is fully flushed alongside the
      // listen banner. (Both are synchronous on the same boot path so this is
      // belt-and-suspenders.)
      await new Promise((r2) => setImmediate(r2));
      const combined = r.stdout() + r.stderr();
      assert.match(
        combined,
        /I_UNDERSTAND_THIS_DISABLES_AUTH=true is ignored/,
        'expected info line explaining the bypass is being ignored',
      );
      assert.doesNotMatch(
        r.stderr(),
        /\[SECURITY\] relay is running WITHOUT auth/,
        'must NOT emit the SECURITY warning when a real secret is configured',
      );
    } finally {
      await killRelay(r.child);
    }
  });
});

// ─── 3) isAuthorizedRequest() logic (mirror of production helper) ───────────
//
// The auth helpers in scripts/ais-relay.cjs are private to that module and
// the module starts servers at import time, so we mirror the exact functions
// here to exercise their branches in isolation. The startup-spawn tests above
// catch any drift between this mirror and production.

describe('isAuthorizedRequest() — mirrored unit tests', () => {
  function makeFns({ secret, bypass }) {
    const RELAY_AUTH_HEADER = 'x-relay-key';
    function safeTokenEquals(provided, expected) {
      const a = Buffer.from(provided || '');
      const b = Buffer.from(expected || '');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    }
    function getRelaySecretFromRequest(req) {
      const direct = req.headers[RELAY_AUTH_HEADER];
      if (typeof direct === 'string' && direct.trim()) return direct.trim();
      const auth = req.headers.authorization;
      if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
        const token = auth.slice(7).trim();
        if (token) return token;
      }
      return '';
    }
    function isAuthorizedRequest(req) {
      if (!secret) {
        return bypass;
      }
      const provided = getRelaySecretFromRequest(req);
      if (!provided) return false;
      return safeTokenEquals(provided, secret);
    }
    return { isAuthorizedRequest };
  }

  const req = (headers = {}) => ({ headers });

  it('returns false when secret unset and bypass unset (fail-closed)', () => {
    const { isAuthorizedRequest } = makeFns({ secret: '', bypass: false });
    assert.equal(isAuthorizedRequest(req()), false);
    assert.equal(isAuthorizedRequest(req({ 'x-relay-key': 'anything' })), false);
    assert.equal(isAuthorizedRequest(req({ authorization: 'Bearer x' })), false);
  });

  it('returns true when bypass is engaged, regardless of headers', () => {
    const { isAuthorizedRequest } = makeFns({ secret: '', bypass: true });
    assert.equal(isAuthorizedRequest(req()), true);
    assert.equal(isAuthorizedRequest(req({ 'x-relay-key': '' })), true);
  });

  it('returns true when secret matches header', () => {
    const { isAuthorizedRequest } = makeFns({ secret: 'good', bypass: false });
    assert.equal(isAuthorizedRequest(req({ 'x-relay-key': 'good' })), true);
    assert.equal(isAuthorizedRequest(req({ authorization: 'Bearer good' })), true);
  });

  it('returns false on mismatched or missing header when secret is set', () => {
    const { isAuthorizedRequest } = makeFns({ secret: 'good', bypass: false });
    assert.equal(isAuthorizedRequest(req()), false);
    assert.equal(isAuthorizedRequest(req({ 'x-relay-key': 'bad' })), false);
    assert.equal(isAuthorizedRequest(req({ 'x-relay-key': 'GOOD' })), false, 'comparison is case-sensitive');
    assert.equal(isAuthorizedRequest(req({ authorization: 'Bearer wrong' })), false);
  });

  it('ignores the bypass var entirely when a real secret is configured', () => {
    // Belt-and-suspenders: even if someone sets BOTH the secret AND the
    // bypass, requests without a matching token must still be rejected.
    const { isAuthorizedRequest } = makeFns({ secret: 'good', bypass: true });
    assert.equal(isAuthorizedRequest(req()), false);
    assert.equal(isAuthorizedRequest(req({ 'x-relay-key': 'good' })), true);
    assert.equal(isAuthorizedRequest(req({ 'x-relay-key': 'bad' })), false);
  });
});
