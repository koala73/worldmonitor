/**
 * #4913 — anonymous dashboards flooded the premium-gated summarize-article
 * endpoint after #4675/#4687 gated its LLM spend server-side without a
 * client-side entitlement gate: every summarize attempt fanned out up to 3
 * doomed RPCs (ollama→groq→openrouter through the same gated endpoint)
 * before landing on the browser-T5 fallback anon users get anyway.
 *
 * Three seams under test (same shape as tests/classify-entitlement-gate for
 * #4865 — the sibling instance of this flood class):
 *   1. src/services/summarize-gate.ts — pure session gate (probe + timed
 *      suppression), node-test-safe (summarization.ts itself imports
 *      @/services/i18n etc. and cannot be loaded under tsx --test).
 *   2. src/services/summarization-outcome.ts — call-local attempt state and a
 *      PURE outcome classifier, also node-test-safe. #5605 moved the whole
 *      decision here so it can be executed as a truth table; three source-grep
 *      guards were proven to stay green with the #5377 bug restored, so the
 *      real behaviour must be covered by execution, not by grep.
 *   3. Source-grep assertions on summarization.ts — kept ONLY for what regex
 *      is good at: call-site counts and "does it route through the helper at
 *      all". All of them strip comments first (an `indexOf` that matched a
 *      comment was one of the proven bypasses) and assert their slice anchors
 *      resolve (a renamed anchor made `slice(a, -1)` silently widen to EOF).
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canAttemptServerSummarization,
  configureSummarizeGate,
  isServerSummarizationSuppressed,
  parseSummarizeRetryAfterMs,
  suppressServerSummarization,
  suppressServerSummarizationFor,
  SUMMARIZE_RETRY_AFTER_MAX_MS,
  SUMMARIZE_RETRY_AFTER_MIN_MS,
  SUMMARIZE_SUPPRESS_MS,
  __resetSummarizeGateForTests,
} from '../src/services/summarize-gate.ts';
import {
  classifySummarizationChainOutcome,
  createSummarizationAttemptState,
  describeSummarizationChainOutcome,
  logChainOutcome,
  markSummarizationAttempt,
  markSummarizationShortCircuited,
  markSummarizationSuppressed,
  type SummarizationChainOutcome,
} from '../src/services/summarization-outcome.ts';

/**
 * Strip comments before any source-order assertion.
 *
 * #5605: `indexOf` matches the FIRST textual occurrence, including one inside
 * a comment — proven by execution to let the #5377 bug back in with the guard
 * still green (add a comment naming the gate above a mark moved before it).
 * The `(?<!:)` guard keeps `https://` inside string literals intact.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
}

describe('summarize-gate — entitlement probe + timed suppression', () => {
  beforeEach(() => {
    __resetSummarizeGateForTests();
  });

  it('allows by default when no probe is configured (fail-open; server still gates)', () => {
    assert.equal(canAttemptServerSummarization(), true);
  });

  it('denies when the probe reports not entitled', () => {
    configureSummarizeGate(() => false);
    assert.equal(canAttemptServerSummarization(), false);
  });

  it('allows when the probe reports entitled', () => {
    configureSummarizeGate(() => true);
    assert.equal(canAttemptServerSummarization(), true);
  });

  it('fails OPEN when the probe throws — a gating bug must not silence Pro summaries', () => {
    configureSummarizeGate(() => { throw new Error('gating module exploded'); });
    assert.equal(canAttemptServerSummarization(), true);
  });

  it('suppression denies even an entitled probe for the full window', () => {
    configureSummarizeGate(() => true);
    const t0 = 1_000_000;
    suppressServerSummarization(t0);
    assert.equal(canAttemptServerSummarization(t0), false);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_SUPPRESS_MS - 1), false);
  });

  it('suppression expires after the window — self-heals a mid-session upgrade without event plumbing', () => {
    configureSummarizeGate(() => true);
    const t0 = 1_000_000;
    suppressServerSummarization(t0);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_SUPPRESS_MS), true);
  });

  it('post-suppression attempts still consult the probe (free user stays denied)', () => {
    configureSummarizeGate(() => false);
    const t0 = 1_000_000;
    suppressServerSummarization(t0);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_SUPPRESS_MS), false);
  });

  it('suppression window is long enough to matter (>= 5 minutes)', () => {
    assert.ok(SUMMARIZE_SUPPRESS_MS >= 5 * 60_000, `window too short: ${SUMMARIZE_SUPPRESS_MS}`);
  });

  it('parses Retry-After delta-seconds and HTTP dates deterministically', () => {
    const t0 = Date.parse('2026-07-11T12:00:00.000Z');
    assert.equal(parseSummarizeRetryAfterMs('90', t0), 90_000);
    assert.equal(
      parseSummarizeRetryAfterMs('Sat, 11 Jul 2026 12:02:00 GMT', t0),
      120_000,
    );
  });

  it('rejects malformed/expired Retry-After values and clamps untrusted extremes', () => {
    const t0 = Date.parse('2026-07-11T12:00:00.000Z');
    for (const value of [null, '', '-1', '1.5', 'not-a-date']) {
      assert.equal(parseSummarizeRetryAfterMs(value, t0), null, String(value));
    }
    assert.equal(parseSummarizeRetryAfterMs('0', t0), SUMMARIZE_RETRY_AFTER_MIN_MS);
    assert.equal(
      parseSummarizeRetryAfterMs('999999999999999999999999', t0),
      SUMMARIZE_RETRY_AFTER_MAX_MS,
    );
    assert.equal(
      parseSummarizeRetryAfterMs('Sat, 11 Jul 2026 11:59:59 GMT', t0),
      null,
    );
  });

  it('never shortens an existing server-directed suppression window', () => {
    configureSummarizeGate(() => true);
    const t0 = 1_000_000;
    suppressServerSummarizationFor(60_000, t0);
    suppressServerSummarizationFor(5_000, t0 + 1_000);

    assert.equal(canAttemptServerSummarization(t0 + 59_999), false);
    assert.equal(canAttemptServerSummarization(t0 + 60_000), true);
  });

  it('bounds direct suppression inputs as defense in depth', () => {
    configureSummarizeGate(() => true);
    const t0 = 1_000_000;
    suppressServerSummarizationFor(1, t0);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_RETRY_AFTER_MIN_MS - 1), false);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_RETRY_AFTER_MIN_MS), true);

    suppressServerSummarizationFor(Number.POSITIVE_INFINITY, t0);
    assert.equal(canAttemptServerSummarization(t0 + SUMMARIZE_RETRY_AFTER_MIN_MS), true);
  });

  it('keeps state separate from classify-gate — a summarize 403 must not silence classification', async () => {
    const classifyGate = await import('../src/services/classify-gate.ts');
    classifyGate.__resetClassifyGateForTests();
    suppressServerSummarization();
    assert.equal(classifyGate.canAttemptAiClassification(), true);
    __resetSummarizeGateForTests();
  });
});

describe('summarization.ts wiring (source-grep — module not loadable under node:test)', () => {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(
    path.join(dirname, '..', 'src', 'services', 'summarization.ts'),
    'utf8',
  );

  it('tryApiProvider consults canAttemptServerSummarization() before dispatching the RPC', () => {
    const fn = src.slice(src.indexOf('async function tryApiProvider'));
    const gateIdx = fn.indexOf('canAttemptServerSummarization()');
    const rpcIdx = fn.indexOf('premiumNewsClient.summarizeArticle');
    assert.ok(gateIdx > -1, 'tryApiProvider must call canAttemptServerSummarization()');
    assert.ok(rpcIdx > -1, 'expected premiumNewsClient.summarizeArticle in tryApiProvider');
    assert.ok(gateIdx < rpcIdx, 'the gate must run BEFORE the RPC is dispatched');
  });

  it('a server 403 suppresses the provider chain (entitlement drift must not recreate the flood)', () => {
    // Duck-typed status check: a value import of the generated client's
    // ApiError would pull the RPC client chunk into the main static graph
    // and fail the eager-chunk budget (caught on PR #4915's first CI run).
    assert.match(src, /getRpcErrorStatusCode\(error\) === 403/, 'must branch on 403 explicitly via the duck-typed helper');
    const branch = src.slice(src.indexOf('getRpcErrorStatusCode(error) === 403'));
    assert.ok(
      branch.indexOf('suppressServerSummarization()') > -1,
      '403 branch must call suppressServerSummarization()',
    );
  });

  it('a premium 429 consumes Retry-After at the fetch boundary before provider fan-out continues', () => {
    const clientInit = src.slice(
      src.indexOf('const premiumNewsClient'),
      src.indexOf('// #4913'),
    );
    assert.match(clientInit, /response\.status === 429/, 'premium fetch boundary must inspect 429 responses');
    assert.match(
      clientInit,
      /parseSummarizeRetryAfterMs\(response\.headers\.get\('Retry-After'\)\)/,
      '429 path must parse the server Retry-After header',
    );
    assert.match(
      clientInit,
      /suppressServerSummarizationFor\(retryAfterMs\)/,
      'valid Retry-After must suppress future premium dispatches',
    );
    assert.match(
      clientInit,
      /retryAfterMs === null[\s\S]*suppressServerSummarization\(\)/,
      'malformed/missing Retry-After must still stop the current provider fan-out',
    );
  });

  it('gate probe is wired to hasPremiumAccess (dual-signal entitlement)', () => {
    assert.match(src, /configureSummarizeGate\(\s*\(\)\s*=>\s*hasPremiumAccess\(\)/);
  });

  it('every premium dispatch flows through tryApiProvider (single choke point)', () => {
    // If a second call site of premiumNewsClient.summarizeArticle appears
    // outside tryApiProvider, it bypasses the gate — force the author here.
    const matches = src.match(/premiumNewsClient\.summarizeArticle/g) ?? [];
    assert.equal(matches.length, 1, 'premiumNewsClient.summarizeArticle must have exactly one call site (inside tryApiProvider)');
  });

  it('translateText stays ungated — mode=translate is the server-allowed anon path', () => {
    const fn = src.slice(src.indexOf('export async function translateText'));
    assert.ok(fn.indexOf("mode: 'translate'") > -1, 'translateText must use mode=translate');
    assert.ok(
      fn.indexOf('newsClient.summarizeArticle') > -1,
      'translateText must use the plain newsClient (anon-allowed), not the premium client',
    );
    const nextFnIdx = fn.indexOf('canAttemptServerSummarization');
    assert.equal(nextFnIdx, -1, 'translateText must not consult the premium gate');
  });

  // #5377: a gated/declined chain must not log the outage-shaped
  // "All providers failed" warning — that string cost a live investigation
  // two wrong hypotheses. `warn` is reserved for chains where a provider was
  // genuinely attempted; the declined-by-design path logs at `debug`.
  it('the outage string exists only inside logChainOutcome (#5377)', () => {
    // Delimiter-agnostic on purpose. The previous /console\.warn\(['"].../
    // form missed backticks — and a template literal is this very file's
    // console.warn idiom, so the bypass was the natural way to write it.
    // The literal now lives only in summarization-outcome.ts.
    assert.doesNotMatch(
      stripComments(src),
      /All providers failed/,
      'summarization.ts must never emit the outage string directly — route through logChainOutcome',
    );
    const outcomeCalls = stripComments(src).match(/logChainOutcome\(/g) ?? [];
    assert.equal(outcomeCalls.length, 2, 'both chain-exhausted sites (BETA + normal) must route through logChainOutcome');
    assert.match(src, /logChainOutcome\('\[BETA\]', attemptState\)/);
    assert.match(src, /logChainOutcome\('\[Summarization\]', attemptState\)/);
  });

  it('a dispatch is marked only from inside the breaker callback (#5605)', () => {
    // Structural, not positional: the breaker returns its default WITHOUT
    // running the callback while on cooldown, so a mark that lives inside it
    // cannot be reached by a gated OR a short-circuited chain. Reordering
    // statements can no longer restore the bug the way it could when this was
    // an indexOf proximity check.
    const code = stripComments(src);
    const apiStart = code.indexOf('async function tryApiProvider');
    const apiEnd = code.indexOf('async function tryBrowserT5');
    assert.ok(apiStart > -1 && apiEnd > apiStart, 'tryApiProvider slice anchors must resolve');
    const api = code.slice(apiStart, apiEnd);

    const gateIdx = api.indexOf('if (!canAttemptServerSummarization())');
    const executeIdx = api.indexOf('summaryBreaker.execute(');
    const markIdx = api.indexOf('markSummarizationAttempt(');
    assert.ok(gateIdx > -1, 'tryApiProvider must branch on the entitlement gate');
    assert.ok(executeIdx > gateIdx, 'the breaker dispatch must sit after the gate');
    assert.ok(markIdx > executeIdx, 'the attempt must be marked INSIDE the breaker callback, not before it');

    // A short-circuited dispatch must be recorded as its own cause.
    assert.match(api, /if \(!dispatched\)[\s\S]{0,120}markSummarizationShortCircuited\(/);
    // A cooldown denial must be distinguishable from an entitlement denial.
    assert.match(api, /isServerSummarizationSuppressed\(\)[\s\S]{0,80}markSummarizationSuppressed\(/);
  });

  it('tryBrowserT5 marks only after the worker availability check (#5377)', () => {
    const code = stripComments(src);
    const t5Start = code.indexOf('async function tryBrowserT5');
    const t5End = code.indexOf('async function runApiChain');
    assert.ok(t5Start > -1 && t5End > t5Start, 'tryBrowserT5 slice anchors must resolve — a rename must not silently widen this guard to end-of-file');
    const t5 = code.slice(t5Start, t5End);
    const availIdx = t5.indexOf('if (!mlWorker.isAvailable)');
    const t5MarkIdx = t5.indexOf("markSummarizationAttempt(attemptState, 'browser')");
    assert.ok(availIdx > -1 && t5MarkIdx > availIdx, 'tryBrowserT5 must mark the attempt after the availability check');
  });

  it('attempt state is created exactly once, inside generateSummary (#5377)', () => {
    // The previous form matched the whole file, so hoisting the state back to
    // module scope kept this green — proven by execution. Scope it and pin the
    // creation count instead.
    const code = stripComments(src);
    const genStart = code.indexOf('export async function generateSummary(');
    const genEnd = code.indexOf('async function generateSummaryInternal');
    assert.ok(genStart > -1 && genEnd > genStart, 'generateSummary slice anchors must resolve');
    const gen = code.slice(genStart, genEnd);
    assert.match(gen, /const attemptState = createSummarizationAttemptState\(\)/, 'state must be created inside generateSummary, not at module scope');
    assert.match(gen, /generateSummaryInternal\(attemptState,/);

    const creations = code.match(/createSummarizationAttemptState\(\)/g) ?? [];
    assert.equal(creations.length, 1, 'exactly one creation site — a second means some caller reuses shared state');
    // Broadened from /^let lastAttemptedProvider/m, which var/export/indent/rename all evaded.
    const moduleScope = code.slice(0, code.indexOf('async function tryApiProvider'));
    assert.doesNotMatch(
      moduleScope,
      /^\s*(export\s+)?(let|var|const)\s+\w*[aA]ttempt\w*\s*[:=]/m,
      'attempt tracking must not live in module-scope mutable state',
    );
  });
});

describe('summarization outcome classification (#5605 truth table)', () => {
  // The whole decision surface, executed rather than grepped. Each row is a
  // state the chain can actually reach; only the first is expected.
  const rows: Array<{ name: string; build: () => ReturnType<typeof createSummarizationAttemptState>; outcome: SummarizationChainOutcome; level: 'debug' | 'warn' }> = [
    {
      name: 'nothing eligible (anon/free, feature off, no local model)',
      build: () => createSummarizationAttemptState(),
      outcome: 'no-eligible-provider',
      level: 'debug',
    },
    {
      name: 'gate denied while the post-403/429 cooldown was armed',
      build: () => { const s = createSummarizationAttemptState(); markSummarizationSuppressed(s); return s; },
      outcome: 'suppressed',
      level: 'warn',
    },
    {
      name: 'eligible but the breaker short-circuited the dispatch',
      build: () => { const s = createSummarizationAttemptState(); markSummarizationShortCircuited(s); return s; },
      outcome: 'not-dispatched',
      level: 'warn',
    },
    {
      name: 'a provider actually ran and failed',
      build: () => { const s = createSummarizationAttemptState(); markSummarizationAttempt(s, 'groq'); return s; },
      outcome: 'provider-failure',
      level: 'warn',
    },
  ];

  for (const row of rows) {
    it(`classifies "${row.name}" as ${row.outcome} at ${row.level}`, () => {
      const state = row.build();
      assert.equal(classifySummarizationChainOutcome(state), row.outcome);
      assert.equal(describeSummarizationChainOutcome('[t]', row.outcome).level, row.level);
    });
  }

  it('reserves the outage-shaped string for a genuine provider failure', () => {
    for (const row of rows) {
      const { message } = describeSummarizationChainOutcome('[t]', row.outcome);
      const claimsOutage = message.includes('All providers failed');
      assert.equal(
        claimsOutage,
        row.outcome === 'provider-failure',
        `"${row.outcome}" must not claim "All providers failed"`,
      );
    }
  });

  it('never claims a fallback ran — no provider executed on the quiet path', () => {
    // #5605: reaching 'no-eligible-provider' means browser T5 returned at its
    // availability guard, so callers render an error/unavailable state. The
    // old text said "using designed fallback", which was false there.
    const { message } = describeSummarizationChainOutcome('[t]', 'no-eligible-provider');
    assert.doesNotMatch(message, /using designed fallback/);
    assert.match(message, /no summary produced/);
  });

  it('a real 403 suppression is warn-visible end to end (the #5600 shape)', () => {
    __resetSummarizeGateForTests();
    configureSummarizeGate(() => true); // entitled premium principal
    suppressServerSummarization();      // server just returned 403
    assert.equal(isServerSummarizationSuppressed(), true);
    assert.equal(canAttemptServerSummarization(), false, 'gate denies during the cooldown');

    // The chain records WHY it was denied, so the outcome stays observable.
    const state = createSummarizationAttemptState();
    markSummarizationSuppressed(state);
    const events: string[] = [];
    logChainOutcome('[Summarization]', state, {
      debug: (m: string) => events.push(`debug:${m}`),
      warn: (m: string) => events.push(`warn:${m}`),
    });
    assert.equal(events.length, 1);
    assert.match(events[0], /^warn:/, 'a suppressed premium chain must not be demoted to debug');
    __resetSummarizeGateForTests();
  });

  it('uses console by default — the production call sites pass no logger', () => {
    const originalDebug = console.debug;
    const originalWarn = console.warn;
    const seen: string[] = [];
    console.debug = (m?: unknown) => { seen.push(`debug:${String(m)}`); };
    console.warn = (m?: unknown) => { seen.push(`warn:${String(m)}`); };
    try {
      logChainOutcome('[Summarization]', createSummarizationAttemptState());
      const attempted = createSummarizationAttemptState();
      markSummarizationAttempt(attempted, 'ollama');
      logChainOutcome('[Summarization]', attempted);
    } finally {
      console.debug = originalDebug;
      console.warn = originalWarn;
    }
    assert.equal(seen.length, 2);
    assert.match(seen[0], /^debug:/);
    assert.match(seen[1], /^warn:\[Summarization\] All providers failed$/);
  });
});

describe('summarization outcome logging', () => {
  it('keeps overlapping attempted and declined chains isolated', async () => {
    const attemptedState = createSummarizationAttemptState();
    const declinedState = createSummarizationAttemptState();
    const events: string[] = [];
    const logger = {
      debug: (message: string) => events.push(`debug:${message}`),
      warn: (message: string) => events.push(`warn:${message}`),
    };

    let releaseAttemptedChain!: () => void;
    const attemptedChainMayFinish = new Promise<void>((resolve) => {
      releaseAttemptedChain = resolve;
    });
    let attemptedChainMarked!: () => void;
    const attemptedProviderMarked = new Promise<void>((resolve) => {
      attemptedChainMarked = resolve;
    });

    const attemptedChain = (async () => {
      markSummarizationAttempt(attemptedState, 'browser');
      attemptedChainMarked();
      await attemptedChainMayFinish;
      logChainOutcome('[attempted]', attemptedState, logger);
    })();

    const declinedChain = (async () => {
      await attemptedProviderMarked;
      logChainOutcome('[declined]', declinedState, logger);
      releaseAttemptedChain();
    })();

    await Promise.all([attemptedChain, declinedChain]);

    assert.deepEqual(events, [
      'debug:[declined] Summarization skipped: no eligible provider (entitlement-gated, disabled, or local model unavailable) — no summary produced',
      'warn:[attempted] All providers failed',
    ]);
  });
});
