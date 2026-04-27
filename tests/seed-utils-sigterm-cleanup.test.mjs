// Regression test: runSeed must release its lock and extend existing-data
// TTL when it receives SIGTERM from _bundle-runner.mjs. Without this, the
// 30-min acquireLock reservation leaks to the NEXT cron tick, which then
// silently skips the resource — long-tail outage window described in
// memory `bundle-runner-sigkill-leaks-child-lock` (PR #3128).
//
// Strategy: spawn a real child that monkey-patches global fetch to capture
// every Upstash call, invokes runSeed() with a fetchFn that awaits forever,
// sends SIGTERM, and verifies the child (a) exits 143 (b) prints the
// "SIGTERM received" line (c) emits the DEL (releaseLock) + EXPIRE pipeline
// (extendExistingTtl) calls before exit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS_DIR = new URL('../scripts/', import.meta.url).pathname;

function runFixture(bodyJs) {
  const path = join(SCRIPTS_DIR, `_sigterm-fixture-${Date.now()}.mjs`);
  writeFileSync(path, bodyJs);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        UPSTASH_REDIS_REST_URL: 'https://fake-upstash.example.com',
        UPSTASH_REDIS_REST_TOKEN: 'fake-token',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code, signal) => {
      try { unlinkSync(path); } catch {}
      resolve({ code, signal, stdout, stderr });
    });
    // Let runSeed register the SIGTERM handler and enter fetchFn before we kill.
    // The fixture logs "READY" once the fetchFn is awaited; we kill then.
    const readyCheck = setInterval(() => {
      if (stdout.includes('READY')) {
        clearInterval(readyCheck);
        child.kill('SIGTERM');
      }
    }, 25);
    setTimeout(() => {
      clearInterval(readyCheck);
      try { child.kill('SIGKILL'); } catch {}
    }, 10_000);
  });
}

test('runSeed releases lock and extends existing TTL on SIGTERM', async () => {
  // Fixture logs every Upstash HTTP call (shape + body) on its own
  // line so the test can assert that the SIGTERM cleanup actually
  // emitted (a) an EVAL DEL-on-match for the lock key, and (b) an
  // EXPIRE pipeline for the canonical + seed-meta keys. Log goes to
  // stderr so READY-signal on stdout stays uncontended.
  const body = `
    import { runSeed } from './_seed-utils.mjs';
    globalThis.fetch = async (url, opts = {}) => {
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return opts.body; } })() : null;
      // Shape signature: EVAL / EXPIRE / pipeline / other — so the test
      // asserts on the exact op without having to deep-inspect.
      let shape = 'other';
      if (Array.isArray(body)) {
        if (Array.isArray(body[0])) {
          shape = body[0][0] === 'EXPIRE' ? 'pipeline-EXPIRE' : 'pipeline-other';
        } else if (body[0] === 'EVAL') {
          shape = 'EVAL';
        } else {
          shape = 'cmd-' + body[0];
        }
      }
      console.error('FETCH_OP shape=' + shape + ' body=' + JSON.stringify(body));
      // Lock SET NX → return result:0 (not already held). Pipeline → array.
      if (Array.isArray(body) && Array.isArray(body[0])) {
        return new Response(JSON.stringify(body.map(() => ({ result: 1 }))), { status: 200 });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    };
    // fetchFn that awaits "forever" — we want SIGTERM to interrupt mid-fetch.
    // setInterval keeps the event loop alive (otherwise Node bails with
    // "Detected unsettled top-level await" before SIGTERM can be delivered).
    const foreverFetch = () => new Promise(() => {
      console.log('READY');
      setInterval(() => {}, 10_000);
    });
    await runSeed('test-domain', 'sigterm', 'data:test:sigterm:v1', foreverFetch, {
      ttlSeconds: 900,
      lockTtlMs: 60_000,
    });
  `;
  const { code, signal, stderr } = await runFixture(body);
  // process.exit(143) should produce code=143; on some platforms Node maps it
  // back to a signal termination, so accept either code or signal.
  assert.ok(code === 143 || signal === 'SIGTERM',
    `expected exit 143 or SIGTERM; got code=${code} signal=${signal}\nstderr:\n${stderr}`);
  assert.match(stderr, /SIGTERM received during fetch phase — releasing lock/,
    `expected fetch-phase SIGTERM cleanup log; stderr:\n${stderr}`);

  // Verify cleanup actually ISSUED the Redis ops, not just logged intent.
  // Extract FETCH_OP lines; separate the acquire-time ops from SIGTERM-time.
  const fetchOps = stderr.split('\n').filter((l) => l.startsWith('FETCH_OP '));
  const evalOps = fetchOps.filter((l) => l.includes('shape=EVAL'));
  const pipelineExpireOps = fetchOps.filter((l) => l.includes('shape=pipeline-EXPIRE'));
  // The SIGTERM handler must emit at least one EVAL (releaseLock Lua
  // script on the lock key) and at least one pipeline EXPIRE (extend
  // existing TTL on canonical + seed-meta keys).
  assert.ok(evalOps.length >= 1,
    `expected >=1 EVAL (releaseLock) call; saw ${evalOps.length}\nstderr:\n${stderr}`);
  assert.ok(pipelineExpireOps.length >= 1,
    `expected >=1 pipeline-EXPIRE (extendExistingTtl) call; saw ${pipelineExpireOps.length}\nstderr:\n${stderr}`);
  // Specific: the EVAL body must reference our runId (body[4]) so we
  // know it's the SIGTERM-time release, not a different lock op.
  // runId format: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`
  // → e.g. "1777061031282-cmgso6", JSON-quoted inside the EVAL body.
  const evalHasRunId = evalOps.some((l) => /"\d{10,}-[a-z0-9]{6}"/.test(l));
  assert.ok(evalHasRunId,
    `expected EVAL body to carry the runSeed-generated runId; stderr:\n${stderr}`);
  // Specific: the EXPIRE pipeline must reference both the canonical
  // key and the seed-meta key (proves keys[] was constructed correctly).
  const expireTouchesCanonical = pipelineExpireOps.some((l) => l.includes('data:test:sigterm:v1'));
  const expireTouchesSeedMeta = pipelineExpireOps.some((l) => l.includes('seed-meta:test-domain:sigterm'));
  assert.ok(expireTouchesCanonical,
    `EXPIRE pipeline must include canonicalKey; stderr:\n${stderr}`);
  assert.ok(expireTouchesSeedMeta,
    `EXPIRE pipeline must include seed-meta key; stderr:\n${stderr}`);
});

test('runSeed SIGTERM handler fires once even if multiple SIGTERMs arrive', async () => {
  // Uses process.once under the hood; verify by emitting SIGTERM twice.
  // A second SIGTERM while the handler is mid-cleanup should not trigger
  // re-entry. If the handler was registered with process.on instead of
  // process.once, the second SIGTERM would re-enter and double-release.
  const body = `
    import { runSeed } from './_seed-utils.mjs';
    globalThis.fetch = async (url, opts = {}) => {
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return opts.body; } })() : null;
      if (Array.isArray(body) && Array.isArray(body[0])) {
        return new Response(JSON.stringify(body.map(() => ({ result: 0 }))), { status: 200 });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    };
    const foreverFetch = () => new Promise(() => { console.log('READY'); setInterval(() => {}, 10_000); });
    await runSeed('test-domain', 'sigterm-once', 'data:test:sigterm-once:v1', foreverFetch, {
      ttlSeconds: 900,
      lockTtlMs: 60_000,
    });
  `;
  const path = join(SCRIPTS_DIR, `_sigterm-once-fixture-${Date.now()}.mjs`);
  writeFileSync(path, body);
  try {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [path], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          UPSTASH_REDIS_REST_URL: 'https://fake-upstash.example.com',
          UPSTASH_REDIS_REST_TOKEN: 'fake-token',
        },
      });
      let stdout = '';
      let stderr = '';
      let sigtermLinesSeen = 0;
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => {
        stderr += c;
        sigtermLinesSeen = (stderr.match(/SIGTERM received/g) || []).length;
      });
      const ready = setInterval(() => {
        if (stdout.includes('READY')) {
          clearInterval(ready);
          child.kill('SIGTERM');
          setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 50);
        }
      }, 25);
      child.on('close', (code) => {
        clearInterval(ready);
        assert.equal(sigtermLinesSeen, 1,
          `handler must fire once (process.once); saw ${sigtermLinesSeen} SIGTERM lines\nstderr:\n${stderr}`);
        resolve();
      });
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10_000);
    });
  } finally {
    try { unlinkSync(path); } catch {}
  }
});

test('publish-phase SIGTERM releases lock but does NOT extend TTL (strict-floor invariant preserved)', async () => {
  // After fetchFn returns, runSeed transitions to publish phase. The
  // SIGTERM handler is now KEPT installed (whole-run scope) so a SIGTERM
  // during atomicPublish/extendExistingTtl/verify still releases the
  // lock — closes the leak path that was leaving seed-lock:<domain>
  // dangling for the full lockTtlMs (default 120s) when bundle-runner
  // SIGTERMed mid-publish.
  //
  // STRICT-FLOOR INVARIANT (still preserved): publish-phase cleanup must
  // NOT extend canonical/seed-meta TTL. Strict-floor seeders
  // (emptyDataIsFailure: true — IMF-External, WB-bulk) deliberately let
  // seed-meta fetchedAt go stale on rejection so health flips to
  // STALE_SEED and the bundle retries on the next cron tick. If the
  // publish-phase handler refreshed TTL, it would silently mask that
  // failure mode. We assert this by counting pipeline-EXPIRE ops AFTER
  // SIGTERM: must be exactly 0.
  //
  // Driving the seeder INTO publish phase deterministically: stub Redis
  // so the first post-fetch op (the seed-meta SETEX inside atomicPublish)
  // never resolves. fetchFn returns synthetic data → publish starts →
  // first SETEX hangs → SIGTERM arrives → handler fires.
  const body = `
    import { runSeed } from './_seed-utils.mjs';
    let opIndex = 0;
    let postFetchReady = false;
    globalThis.fetch = async (url, opts = {}) => {
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return opts.body; } })() : null;
      let shape = 'other';
      if (Array.isArray(body)) {
        if (Array.isArray(body[0])) {
          shape = body[0][0] === 'EXPIRE' ? 'pipeline-EXPIRE' : 'pipeline-other';
        } else if (body[0] === 'EVAL') {
          shape = 'EVAL';
        } else {
          shape = 'cmd-' + body[0];
        }
      }
      console.error('FETCH_OP idx=' + (opIndex++) + ' shape=' + shape + ' body=' + JSON.stringify(body));
      // ONLY the acquireLock op (SET key val NX PX ttl) and the SIGTERM
      // handler's releaseLock EVAL get real OKs. The lock-release path
      // must NOT hang — otherwise the handler would block on its own
      // releaseLock call and never reach process.exit(143).
      if (Array.isArray(body) && body[0] === 'SET' && body[3] === 'NX') {
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      if (Array.isArray(body) && body[0] === 'EVAL') {
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      }
      // First non-lock op signals the test we've entered publish phase,
      // then hangs so SIGTERM has time to arrive. setInterval keeps the
      // event loop alive — without it Node's "unsettled top-level await"
      // detection bails before setImmediate fires.
      if (!postFetchReady) {
        postFetchReady = true;
        setInterval(() => {}, 10_000);
        setImmediate(() => console.log('PUBLISH_HUNG'));
      }
      return new Promise(() => {});  // never resolves
    };
    const quickFetch = async () => {
      // Tiny payload — atomicPublish should accept it past validate.
      return { items: [{ k: 1 }] };
    };
    await runSeed('test-domain', 'post-fetch', 'data:test:post-fetch:v1', quickFetch, {
      ttlSeconds: 900,
      lockTtlMs: 60_000,
    });
  `;
  const path = join(SCRIPTS_DIR, `_sigterm-postfetch-fixture-${Date.now()}.mjs`);
  writeFileSync(path, body);
  try {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [path], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          UPSTASH_REDIS_REST_URL: 'https://fake-upstash.example.com',
          UPSTASH_REDIS_REST_TOKEN: 'fake-token',
        },
      });
      let stdout = '';
      let stderr = '';
      let sigtermSent = false;
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      const ready = setInterval(() => {
        if (stdout.includes('PUBLISH_HUNG') && !sigtermSent) {
          clearInterval(ready);
          sigtermSent = true;
          child.kill('SIGTERM');
        }
      }, 25);
      child.on('close', (code, signal) => {
        clearInterval(ready);
        // Cleanup log line MUST appear AND must indicate publish-phase context.
        // We anchor every "post-SIGTERM" assertion to the position of THIS log
        // line in stderr — not to a parent-side op-count snapshot. The
        // op-count approach was IPC-buffer-lag-sensitive: pre-SIGTERM child
        // ops not yet flushed to the parent at SIGTERM-send time would later
        // appear with idx >= snapshot and could falsely satisfy "post-SIGTERM"
        // assertions even if the handler never fired. The cleanup log is
        // emitted SYNCHRONOUSLY by the handler before any cleanup op runs, so
        // anything stderr-after that line was emitted by the handler or later.
        const cleanupLogIdx = stderr.search(/SIGTERM received during publish phase — releasing lock/);
        assert.ok(cleanupLogIdx >= 0,
          `expected publish-phase SIGTERM cleanup log; stderr:\n${stderr}`);
        const postCleanupStderr = stderr.slice(cleanupLogIdx);
        // Lock release MUST happen — at least one EVAL (the LUA verify-and-DEL)
        // must appear AFTER the cleanup log line, AND its body must carry the
        // runSeed-generated runId pattern (matches test 1 line 121's idiom).
        // The runId pin defends against any pre-cleanup EVAL the publish path
        // might issue in the future (currently atomicPublish uses SET/DEL only,
        // but future refactors could change that — Greptile P2 on PR #3414).
        const evalAfter = (postCleanupStderr.match(/^FETCH_OP idx=\d+ shape=EVAL[^\n]*/gm) || []);
        assert.ok(evalAfter.length >= 1,
          `publish-phase SIGTERM must release the lock; saw 0 EVAL ops after cleanup log\nstderr:\n${stderr}`);
        const evalCarriesRunId = evalAfter.some((l) => /"\d{10,}-[a-z0-9]{6}"/.test(l));
        assert.ok(evalCarriesRunId,
          `EVAL after cleanup log must carry the runSeed-generated runId; stderr:\n${stderr}`);
        // Critical strict-floor invariant: NO pipeline-EXPIRE ops AFTER cleanup
        // log. publish-phase handler releases lock only.
        const expireAfter = (postCleanupStderr.match(/^FETCH_OP idx=\d+ shape=pipeline-EXPIRE[^\n]*/gm) || []);
        assert.equal(expireAfter.length, 0,
          `publish-phase SIGTERM must NOT extend TTL (strict-floor invariant); saw ${expireAfter.length} pipeline-EXPIRE ops after cleanup log\nstderr:\n${stderr}`);
        // Process should exit 143 (SIGTERM convention) or be killed by signal.
        assert.ok(code === 143 || signal === 'SIGTERM',
          `expected exit 143 or SIGTERM signal; got code=${code} signal=${signal}\nstderr:\n${stderr}`);
        resolve();
      });
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10_000);
    });
  } finally {
    try { unlinkSync(path); } catch {}
  }
});

test('SIGTERM during fetch-failure cleanup still triggers handler (no leak window between catch and process.exit)', async () => {
  // Pre-fix code path: the fetch-failure catch block did
  //   process.off('SIGTERM', sigTermHandler);
  //   await releaseLock(...);   ← if SIGTERM lands here, no handler
  //   await extendExistingTtl(...);  ← or here
  //   process.exit(0);
  // That window (the two Upstash awaits, ~100ms-1s) was unprotected: a
  // bundle-runner SIGTERM during it fell through to Node's default
  // termination and could leak the lock or skip the TTL extension.
  //
  // Fix: keep the handler installed across the cleanup. Both code
  // paths (catch's manual ops and the handler's parallel ops) are
  // idempotent (LUA verify-and-DEL; pipeline-EXPIRE on existing
  // keys), so a race converges on correct end state.
  //
  // This test drives the seeder INTO the catch block by throwing from
  // fetchFn, then hangs the catch's first Upstash await (the manual
  // releaseLock EVAL) so SIGTERM has a deterministic window to land.
  // Asserts that the handler still fires (cleanup log appears) and
  // that exit code is 143 (handler-driven) rather than 0 (catch's
  // process.exit) or signal=SIGTERM (no handler ran).
  const body = `
    import { runSeed } from './_seed-utils.mjs';
    let opIndex = 0;
    let cleanupHung = false;
    globalThis.fetch = async (url, opts = {}) => {
      const body = opts?.body ? (() => { try { return JSON.parse(opts.body); } catch { return opts.body; } })() : null;
      let shape = 'other';
      if (Array.isArray(body)) {
        if (Array.isArray(body[0])) {
          shape = body[0][0] === 'EXPIRE' ? 'pipeline-EXPIRE' : 'pipeline-other';
        } else if (body[0] === 'EVAL') {
          shape = 'EVAL';
        } else {
          shape = 'cmd-' + body[0];
        }
      }
      const idx = opIndex++;
      console.error('FETCH_OP idx=' + idx + ' shape=' + shape + ' body=' + JSON.stringify(body));
      // acquireLock SET NX → return OK (lock free)
      if (Array.isArray(body) && body[0] === 'SET' && body[3] === 'NX') {
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      // First EVAL is the catch block's manual releaseLock — HANG it so
      // SIGTERM has a deterministic window. Subsequent EVALs (e.g. from
      // the handler firing) must succeed so the handler can complete
      // and exit 143.
      if (shape === 'EVAL' && !cleanupHung) {
        cleanupHung = true;
        setInterval(() => {}, 10_000);
        setImmediate(() => console.log('FETCH_FAILURE_CLEANUP_HUNG'));
        return new Promise(() => {});  // never resolves
      }
      // Subsequent EVALs (handler-issued) succeed.
      if (shape === 'EVAL') {
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      }
      // Pipeline-EXPIRE (handler's extendExistingTtl) — succeed.
      if (Array.isArray(body) && Array.isArray(body[0])) {
        return new Response(JSON.stringify(body.map(() => ({ result: 1 }))), { status: 200 });
      }
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    };
    // fetchFn rejects so runSeed enters the fetch-failure catch path.
    const failingFetch = async () => { throw new Error('synthetic upstream failure'); };
    await runSeed('test-domain', 'fetch-fail', 'data:test:fetch-fail:v1', failingFetch, {
      ttlSeconds: 900,
      lockTtlMs: 60_000,
      maxRetries: 0,  // fail fast — no withRetry retries
    });
  `;
  const path = join(SCRIPTS_DIR, `_sigterm-fetchfail-fixture-${Date.now()}.mjs`);
  writeFileSync(path, body);
  try {
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [path], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          UPSTASH_REDIS_REST_URL: 'https://fake-upstash.example.com',
          UPSTASH_REDIS_REST_TOKEN: 'fake-token',
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      const ready = setInterval(() => {
        if (stdout.includes('FETCH_FAILURE_CLEANUP_HUNG')) {
          clearInterval(ready);
          child.kill('SIGTERM');
        }
      }, 25);
      child.on('close', (code, signal) => {
        clearInterval(ready);
        // Decisive signal that the handler fired (NOT default termination):
        // the cleanup log line. Pre-fix this would NOT appear because
        // process.off had already removed the handler.
        assert.match(stderr, /SIGTERM received during fetch phase — releasing lock/,
          `handler must fire even when SIGTERM lands during fetch-failure cleanup; stderr:\n${stderr}`);
        // Process exits 143 from the handler (NOT 0 from catch's
        // process.exit, NOT signal=SIGTERM from default termination).
        assert.ok(code === 143 || signal === 'SIGTERM',
          `expected exit 143 (handler-driven) or SIGTERM signal; got code=${code} signal=${signal}\nstderr:\n${stderr}`);
        resolve();
      });
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10_000);
    });
  } finally {
    try { unlinkSync(path); } catch {}
  }
});
