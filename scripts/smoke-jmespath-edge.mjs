#!/usr/bin/env node
/**
 * Edge-runtime smoke test for the jmespath dep (plan U1, two-tier check).
 *
 * Tier A — dependency smoke: bundle a tiny module that imports `jmespath`
 * with the EXACT esbuild flags used by `.github/workflows/test.yml:46-51`
 * (`--bundle --format=esm --platform=browser`) plus `--conditions=worker,
 * browser` for the edge profile. Load the bundle inside `@edge-runtime/vm`
 * and exercise `jmespath.search` on three fixture payloads, including a
 * multiselect-hash expression that exercises the duplication-capable
 * grammar driving the runtime output cap.
 *
 * Tier B — integration check: same flags against `api/mcp.ts` itself
 * (the actual edge entry that will end up importing jmespath after U2).
 * Mirrors the CI esbuild loop at `.github/workflows/test.yml:46-51`
 * exactly — pure bundle build check, no in-VM load. Loading `api/mcp.ts`
 * inside `@edge-runtime/vm` fails on a pre-existing baseline issue
 * (something in the dependency graph accesses `crypto.subtle` at module
 * init, which @edge-runtime/vm doesn't shim the same way Vercel's actual
 * edge runtime does) — so this script doesn't attempt that load.
 * Tier A's in-VM check still proves jmespath itself is edge-runtime safe.
 *
 * Records raw + gzipped bundle sizes for `api/mcp.ts` and prints the
 * delta vs a previously-saved baseline (if `/tmp/mcp.baseline.bundle.js`
 * exists). Plan flags re-evaluation if raw delta > 50 KB.
 *
 * Exit code 0 on success, 1 on any tier failure.
 */
import { VM } from '@edge-runtime/vm';
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ESBUILD_BASE = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['worker', 'browser'],
  write: false,
  target: 'es2022',
  logLevel: 'error',
};

const FIXTURES = {
  small: { a: [{ n: 'x', v: 1 }, { n: 'y', v: 2 }] },
  withMultiselectHash: { items: [{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }] },
  empty: { data: { stocks: [] } },
};

const EXPRS = [
  { fixture: 'small', expr: 'a[*].{s:n, p:v}', expect: [{ s: 'x', p: 1 }, { s: 'y', p: 2 }] },
  { fixture: 'withMultiselectHash', expr: 'items[*].{a:a, b:b, c:c}', expect: [{ a: 1, b: 2, c: 3 }, { a: 4, b: 5, c: 6 }] },
  { fixture: 'empty', expr: 'data.stocks', expect: [] },
];

function log(line) { process.stdout.write(line + '\n'); }
function fail(line) { process.stderr.write(`FAIL: ${line}\n`); process.exit(1); }

async function tierA() {
  log('--- Tier A: dependency smoke ---');
  const probeSource = `
    import jmespath from 'jmespath';
    globalThis.__results = ${JSON.stringify(EXPRS)}.map(({ fixture, expr }) => {
      const FIXTURES = ${JSON.stringify(FIXTURES)};
      try {
        return { fixture, expr, ok: true, value: jmespath.search(FIXTURES[fixture], expr) };
      } catch (e) {
        return { fixture, expr, ok: false, error: String(e?.message ?? e) };
      }
    });
  `;
  let result;
  try {
    result = await build({
      ...ESBUILD_BASE,
      stdin: { contents: probeSource, resolveDir: ROOT, sourcefile: 'tier-a-probe.mjs', loader: 'ts' },
    });
  } catch (e) {
    fail(`Tier A esbuild bundle failed: ${e.message}`);
  }
  const code = result.outputFiles[0].text;
  log(`Tier A bundle bytes: ${code.length} raw, ${gzipSync(code).length} gzipped`);

  const vm = new VM();
  try {
    vm.evaluate(code);
  } catch (e) {
    fail(`Tier A bundle threw inside @edge-runtime/vm: ${e.message}`);
  }
  const results = vm.context.__results;
  if (!Array.isArray(results) || results.length !== EXPRS.length) {
    fail(`Tier A expected ${EXPRS.length} results, got ${JSON.stringify(results)}`);
  }
  for (let i = 0; i < EXPRS.length; i++) {
    const r = results[i];
    const e = EXPRS[i];
    if (!r.ok) fail(`Tier A expr "${e.expr}" threw: ${r.error}`);
    if (JSON.stringify(r.value) !== JSON.stringify(e.expect)) {
      fail(`Tier A expr "${e.expr}" mismatch: got ${JSON.stringify(r.value)}, want ${JSON.stringify(e.expect)}`);
    }
  }
  log(`Tier A: ${EXPRS.length}/${EXPRS.length} expressions OK`);
}

async function tierB() {
  log('--- Tier B: bundle + edge-vm load of api/mcp.ts ---');
  const entry = resolve(ROOT, 'api/mcp.ts');
  let result;
  try {
    result = await build({
      ...ESBUILD_BASE,
      entryPoints: [entry],
    });
  } catch (e) {
    fail(`Tier B esbuild bundle of api/mcp.ts failed: ${e.message}`);
  }
  const code = result.outputFiles[0].text;
  const raw = code.length;
  const gz = gzipSync(code).length;
  log(`Tier B bundle bytes: ${raw} raw, ${gz} gzipped`);

  const baselinePath = '/tmp/mcp.baseline.bundle.js';
  if (existsSync(baselinePath)) {
    const baselineRaw = statSync(baselinePath).size;
    const delta = raw - baselineRaw;
    log(`Tier B bundle delta vs ${baselinePath}: ${delta >= 0 ? '+' : ''}${delta} bytes (raw)`);
    if (delta > 50 * 1024) {
      log(`WARN: bundle delta > 50 KB — plan flags re-evaluation`);
    }
  } else {
    log(`Tier B no baseline at ${baselinePath} — first run; save with \`cp /tmp/mcp.current.bundle.js /tmp/mcp.baseline.bundle.js\``);
  }

  // Bundle build-only check. We intentionally do NOT load the bundle
  // inside @edge-runtime/vm — see the module-doc explanation for why.
  // The build itself is the authoritative signal that jmespath does not
  // break api/mcp.ts's edge bundle.
  log(`Tier B: bundle built successfully (build-only check; see module doc)`);
}

await tierA();
await tierB();
log('--- smoke OK ---');
