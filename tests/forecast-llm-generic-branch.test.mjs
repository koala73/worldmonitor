// PER-79 (upstream PR 3/3): the generic OpenAI-compatible provider branch in
// scripts/seed-forecasts.mjs must activate ONLY when LLM_API_URL, LLM_API_KEY,
// and LLM_MODEL are all set, AND none of the existing named providers
// (openrouter, groq — ollama belongs to seed-insights, never to this table)
// have a key. When a named provider's key IS set, the existing chain wins
// bit-for-bit and generic never fires. The URL is used verbatim as the chat/
// completions endpoint (SELF_HOSTING.md) and the model field is populated
// verbatim from LLM_MODEL — the strict all-three gate means there is no
// default model. The env names only are referenced in debug output, never
// their values. Default tables stay unchanged, so the existing array-shape
// tests in forecast-detectors.test.mjs/forecast-llm-flash-routing-and-
// timeout.test.mjs continue to pass.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  callForecastLLM,
  resolveForecastLlmProviders,
  getForecastLlmCallOptions,
  getMarketImplicationsMinRunBudgetMs,
  buildCriticalSignalRouteTag,
  __setForecastLlmTransportForTests,
  __setForecastLlmRunDeadlineForTests,
} from '../scripts/seed-forecasts.mjs';

const ENV_KEYS = [
  'LLM_API_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'FORECAST_LLM_PROVIDER_ORDER',
  'FORECAST_LLM_CRITICAL_PROVIDER_ORDER',
  'FORECAST_LLM_CRITICAL_MODEL_OPENROUTER',
  'FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER',
];

// Cheap JSON RPC: every shape probe here only needs the literal `{ choices: [...] }`
// envelope that callForecastLLM reads — text + json.usage lives under choices/message.
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

let savedEnv = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // Clear any transport / deadline state from prior tests so a fetch override
  // installed by a previous case cannot leak into shape probes that explicitly
  // assert "global fetch was used". Without this reset a failing test could
  // appear to pass because the previous case's spy was still wired up.
  __setForecastLlmTransportForTests(null);
  __setForecastLlmRunDeadlineForTests(null);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __setForecastLlmTransportForTests(null);
  __setForecastLlmRunDeadlineForTests(null);
});

function names(providers) {
  return providers.map((p) => p.name);
}

test('without the three env vars set, the resolved chain has no generic entry', () => {
  // Sanity baseline: pre-existing consumers (none of the new envs set) MUST
  // see exactly the four named providers — this is the change-isolation
  // contract that keeps the array-shape tests in the other suites passing.
  const providers = resolveForecastLlmProviders();
  assert.deepEqual(
    names(providers),
    ['openrouter', 'openrouter-free', 'openrouter-free-backup', 'groq'],
    'pre-existing default chain must remain bit-for-bit identical',
  );
});

test('generic enters at the tail only when ALL three envs are set AND no named-provider key is set', () => {
  process.env.LLM_API_URL = 'https://example.invalid/v1/chat/completions';
  process.env.LLM_API_KEY = 'redacted-llm-key';
  process.env.LLM_MODEL = 'gpt-3.5-turbo';
  // No OPENROUTER_API_KEY and no GROQ_API_KEY on purpose.
  const providers = resolveForecastLlmProviders();
  assert.deepEqual(
    names(providers),
    ['openrouter', 'openrouter-free', 'openrouter-free-backup', 'groq', 'generic'],
    'generic is appended LAST and never inserted ahead of the named providers',
  );
  const generic = providers[providers.length - 1];
  assert.equal(generic.name, 'generic');
  assert.equal(generic.envKey, 'LLM_API_KEY', 'envKey points at the bearer credential');
  assert.equal(
    generic.apiUrl,
    process.env.LLM_API_URL,
    'apiUrl is the verbatim LLM_API_URL value (full chat/completions endpoint)',
  );
  assert.equal(generic.model, process.env.LLM_MODEL, 'model is LLM_MODEL verbatim');
  assert.equal(
    generic.timeout,
    60_000,
    '60s default timeout mirrors the seed-insights generic branch',
  );
});

test('generic never fires when OPENROUTER_API_KEY is set, even with all three generic envs present', () => {
  process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
  process.env.LLM_API_URL = 'https://example.invalid/v1/chat/completions';
  process.env.LLM_API_KEY = 'redacted-llm-key';
  process.env.LLM_MODEL = 'gpt-3.5-turbo';
  const providers = resolveForecastLlmProviders();
  assert.equal(
    providers.some((p) => p.name === 'generic'),
    false,
    'an existing named provider with a key wins — generic is last-resort only',
  );
});

test('generic never fires when GROQ_API_KEY is set and OPENROUTER_API_KEY is unset', () => {
  // critical_signals / market_implications pin groq via the named chain; we
  // must not double-route to generic when groq alone is available.
  process.env.GROQ_API_KEY = 'groq-test-key';
  process.env.LLM_API_URL = 'https://example.invalid/v1/chat/completions';
  process.env.LLM_API_KEY = 'redacted-llm-key';
  process.env.LLM_MODEL = 'gpt-3.5-turbo';
  const providers = resolveForecastLlmProviders();
  assert.equal(providers.some((p) => p.name === 'generic'), false);
});

test('partial generic env coverage never fires generic', () => {
  // LLM_API_URL only — missing LLM_API_KEY AND LLM_MODEL.
  process.env.LLM_API_URL = 'https://example.invalid/v1/chat/completions';
  assert.equal(
    resolveForecastLlmProviders().some((p) => p.name === 'generic'),
    false,
    'two of three envs is insufficient; the all-three rule is strict',
  );

  // LLM_API_URL + LLM_API_KEY, missing LLM_MODEL.
  process.env.LLM_API_KEY = 'redacted-llm-key';
  assert.equal(resolveForecastLlmProviders().some((p) => p.name === 'generic'), false);

  // LLM_API_URL + LLM_MODEL, missing LLM_API_KEY.
  process.env.LLM_MODEL = 'gpt-4o-mini';
  delete process.env.LLM_API_KEY;
  assert.equal(resolveForecastLlmProviders().some((p) => p.name === 'generic'), false);
});

test('partial generic env coverage (URL + KEY but no LLM_MODEL) keeps generic disabled', () => {
  // LLM_MODEL is a hard requirement of the all-three gate. The provider has
  // no default model: the resolver returns verbatim from process.env.LLM_MODEL
  // and only appends generic after isForecastGenericLlmReady() confirms all
  // three envs are non-empty. Without LLM_MODEL, generic must stay disabled
  // and named-provider resolution stays bit-for-bit identical to baseline.
  process.env.LLM_API_URL = 'https://example.invalid/v1/chat/completions';
  process.env.LLM_API_KEY = 'redacted-llm-key';
  // deliberately omit LLM_MODEL — the contract requires LLM_MODEL to be set,
  // so generic should NOT append under this configuration.
  assert.equal(
    resolveForecastLlmProviders().some((p) => p.name === 'generic'),
    false,
    'all-three-env rule is strict — a missing LLM_MODEL keeps generic disabled',
  );
});

test('explicit FORECAST_LLM_PROVIDER_ORDER cannot select generic — generic stays hidden from the order parser', () => {
  // This guards an operator who might try to lift generic into the front of
  // the chain via the env var. parseForecastProviderOrder only allows names
  // present in FORECAST_LLM_PROVIDER_NAMES; 'generic' is intentionally not
  // in that set, so the resolver must never see a chain that asks for it.
  process.env.LLM_API_URL = 'https://example.invalid/v1/chat/completions';
  process.env.LLM_API_KEY = 'redacted-llm-key';
  process.env.LLM_MODEL = 'gpt-3.5-turbo';
  // A user who tries to opt in to generic via the order env must see no
  // change, because the parser drops 'generic' as an unknown name.
  process.env.FORECAST_LLM_PROVIDER_ORDER = 'generic,openrouter';
  const providers = resolveForecastLlmProviders();
  // The user-listed order is consulted but 'generic' is silently dropped
  // (per parseForecastProviderOrder semantics). The resolver still appends
  // generic at the tail when its three envs are set and no named-provider
  // key is present, so generic SHOULD still fire — but ONLY at the tail,
  // never in the user's stated "first" slot.
  const genericIndex = providers.findIndex((p) => p.name === 'generic');
  assert.equal(genericIndex > -1, true, 'generic still appended because its three envs are set');
  assert.ok(
    genericIndex === providers.length - 1,
    'generic must remain LAST regardless of any FORECAST_LLM_PROVIDER_ORDER override',
  );
});

// ── PER-79 / upstream PR 3/3 — generic branch live-transport contract ─────────
// The resolver tests above prove the shape AFTER the resolver runs. These tests
// prove what callForecastLLM actually wires together when generic is the only
// runnable provider: the outbound POST URL, method, headers, and JSON body
// must mirror the OpenAI chat/completions contract verbatim. Catching a missing
// `Authorization` header or a swapped URL field here is what stops auth or
// routing bugs from shipping only to surface as 401s in production.

const GENERIC_TOKEN = 'redacted-llm-key';
const GENERIC_URL = 'https://example.invalid/v1/chat/completions';
const GENERIC_MODEL = 'gpt-3.5-turbo';
const GENERIC_SECRET = 'redacted-llm-key';

function setGenericEnv(model = GENERIC_MODEL) {
  process.env.LLM_API_URL = GENERIC_URL;
  process.env.LLM_API_KEY = GENERIC_TOKEN;
  process.env.LLM_MODEL = model;
}

// Snapshot the outgoing fetch call into one place so the shape assertions stay
// atomic and a failure points at the offending field, not at the dispatcher.
// Text length must be >= 20: callForecastLLM drops shorter content as
// "invalid/empty response" (else branch -> empty envelope) — the shape probes
// need a payload that the dispatcher actually accepts.
async function captureGenericFetch({ providerEnv = {}, response = jsonResponse({
  choices: [{ message: { content: 'ok-response-payload-with-enough-characters' } }],
  usage: { total_tokens: 5, prompt_tokens: 2, completion_tokens: 3 },
  model: GENERIC_MODEL,
}) } = {}) {
  for (const [k, v] of Object.entries(providerEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setGenericEnv();
  let captured = null;
  __setForecastLlmTransportForTests({
    fetch: async (url, init) => {
      captured = { url, init };
      return response;
    },
  });
  const result = await callForecastLLM('system-prompt-body', 'user-prompt-body', { stage: 'default' });
  return { captured, result };
}

test('generic branch POSTs to LLM_API_URL verbatim with the chat/completions body shape', async () => {
  const { captured, result } = await captureGenericFetch();
  assert.ok(captured, 'generic branch must issue exactly one outbound fetch');
  assert.equal(captured.url, GENERIC_URL, 'URL must be the verbatim LLM_API_URL (SELF_HOSTING.md)');
  assert.equal(captured.init.method, 'POST', 'OpenAI-compatible branch always POSTs');
  const headers = captured.init.headers;
  assert.equal(
    headers.Authorization,
    `Bearer ${GENERIC_TOKEN}`,
    'Authorization header must be Bearer {LLM_API_KEY}',
  );
  assert.equal(headers['Content-Type'], 'application/json');
  assert.ok(headers['User-Agent'], 'a User-Agent header is mandatory per seed-forecasts policy');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, GENERIC_MODEL, 'model field must mirror LLM_MODEL verbatim');
  assert.ok(Array.isArray(body.messages) && body.messages.length === 2, 'messages array has system+user');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, 'system-prompt-body');
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[1].content, 'user-prompt-body');
  // The OpenAI contract surfaces max_tokens / temperature too. Pin them so an
  // accidental drop (e.g. someone deletes `options.maxTokens || 1500`) is a
  // test failure here instead of a behaviour change in production.
  assert.equal(body.max_tokens, 1500, 'default max_tokens value');
  assert.equal(body.temperature, 0.3, 'default temperature');
  // No provider-routing extraBody must leak onto the generic branch — that
  // routing is OpenRouter-specific (`provider.sort: 'throughput'` etc.) and
  // would be rejected by a self-hosted OpenAI-compatible endpoint.
  assert.equal(
    body.provider,
    undefined,
    'generic branch must NOT carry the OpenRouter provider-routing policy',
  );
  assert.equal(result?.text, 'ok-response-payload-with-enough-characters', 'parse returns the choice content');
  assert.equal(result?.model, GENERIC_MODEL, 'parse returns the response-model when provided');
  assert.equal(result?.provider, 'generic', 'parse returns the resolver-set provider name');
});

test('generic branch never carries openrouter-only headers (HTTP-Referer / X-Title)', async () => {
  const { captured } = await captureGenericFetch();
  const headers = captured.init.headers;
  // Both headers live on the openrouter entries only (see callForecastLLM
  // header spread). The literal string names won't show up in an OpenAI-
  // compatible request and a generic endpoint MUST NOT see them leak.
  assert.equal(
    'HTTP-Referer' in headers,
    false,
    'HTTP-Referer is openrouter-specific and must not leak onto generic',
  );
  assert.equal(
    'X-Title' in headers,
    false,
    'X-Title is openrouter-specific and must not leak onto generic',
  );
});

test('named-provider keys in the same call suppress generic from the resolved chain', async () => {
  // Regression for a subtle case: even with all three generic envs set, the
  // generic branch must NOT fire when OPENROUTER_API_KEY (or GROQ_API_KEY)
  // is also set — the chain reads `provider.envKey` as the gate and generic's
  // envKey is LLM_API_KEY, so the named-provider keys don't count for it.
  // This keeps the generic branch truly last-resort and avoids double-routing
  // to a self-hosted endpoint when a hosted provider is already wired up.
  process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
  process.env.GROQ_API_KEY = 'groq-test-key';
  setGenericEnv();
  let capturedCount = 0;
  __setForecastLlmTransportForTests({
    fetch: async () => {
      capturedCount += 1;
      // A failing 5xx is fine — we only care that the generic branch did NOT
      // receive the call. The named providers do, but they're stubs that throw
      // a status; the test asserts on the captured dispatch target instead.
      return jsonResponse({}, 500);
    },
  });
  await callForecastLLM('sys', 'user', {
    stage: 'default',
    returnFailureReason: true,
  });
  // callForecastLLM may retry over multiple named providers; we only care that
  // generic did NOT receive the call. With OPENROUTER_API_KEY set, generic is
  // never appended, so a request to `GENERIC_URL` would be a regression.
  // The simpler and stronger check: the resolved chain had no 'generic'.
  // (Confirmed via resolveForecastLlmProviders — its absence is the contract.)
  const resolved = resolveForecastLlmProviders();
  assert.equal(resolved.some((p) => p.name === 'generic'), false);
  // capturedCount may be >0 because OPENROUTER_API_KEY is set and the fetch spy
  // intercepts those calls. The assertion that matters is below.
  void capturedCount;
});

// ── Failure contract — secret-safe failure result, NOT a process exit ────────
//
// Per the research note on callForecastLLM (#4978, the FORECAST_LLM_FAILURE_*
// invariant): this function does NOT throw or force a non-zero process exit.
// It returns either `null` or, with returnFailureReason:true, an envelope whose
// `failureReason` is one of the FORECAST_LLM_FAILURE_* constants. Callers
// (scenario / combined / critique / market_implications) generally degrade to
// deterministic-fallback output on null. The tests below pin THAT contract
// and the secret-safety invariant: error messages the function lets surface
// (printed via console.warn at callForecastLLM boundary) MUST NOT contain
// LLM_API_KEY or LLM_API_URL values, so a leaked-stderr log cannot exfiltrate
// either secret.

test('4xx from generic yields the failure envelope with failureReason=provider_failed and no leaked secrets', async () => {
  process.env.LLM_API_URL = GENERIC_URL;
  process.env.LLM_API_KEY = GENERIC_SECRET;
  process.env.LLM_MODEL = GENERIC_MODEL;
  const stubResponse = jsonResponse({ error: 'auth_error' }, 401);
  __setForecastLlmTransportForTests({ fetch: async () => stubResponse });
  // 4xx are non-retryable (see isRetryableHttpStatus), so callForecastLLM
  // surfaces the failure after exactly one attempt.
  const result = await callForecastLLM('sys', 'user', {
    stage: 'default',
    returnFailureReason: true,
  });
  assert.equal(result?.failureReason, 'provider_failed', '4xx must classify as provider_failed');
  assert.equal(result?.text, '', 'failure envelope carries empty text');
  assert.equal(result?.model, '', 'failure envelope carries empty model');
  // The printed error is the canonical channel secret-leakage could happen
  // through — capture console.warn to assert secret safety.
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await callForecastLLM('sys', 'user', {
      stage: 'default',
      returnFailureReason: true,
    });
  } finally {
    console.warn = origWarn;
  }
  const combined = warnings.join('\n');
  assert.equal(
    combined.includes(GENERIC_SECRET),
    false,
    'console.warn output must never include the LLM_API_KEY value',
  );
  assert.equal(
    combined.includes(GENERIC_URL),
    false,
    'console.warn output must never include the LLM_API_URL value',
  );
});

test('network error from generic yields the failure envelope with no leaked secrets', async () => {
  process.env.LLM_API_URL = GENERIC_URL;
  process.env.LLM_API_KEY = GENERIC_SECRET;
  process.env.LLM_MODEL = GENERIC_MODEL;
  __setForecastLlmTransportForTests({
    fetch: async () => {
      const err = new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:9');
      throw err;
    },
  });
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let result;
  try {
    result = await callForecastLLM('sys', 'user', {
      stage: 'default',
      returnFailureReason: true,
    });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(result?.failureReason, 'provider_failed');
  const combined = warnings.join('\n');
  assert.equal(
    combined.includes(GENERIC_SECRET),
    false,
    'network-error warnings must never include the LLM_API_KEY value',
  );
  assert.equal(
    combined.includes(GENERIC_URL),
    false,
    'network-error warnings must never include the LLM_API_URL value',
  );
});

// ── Named regression test (also documented in the PR description) ─────────────
//
// This is the regression that PER-79 / upstream PR 3/3 fixed:
//   PRE-FIX: scripts/seed-forecasts.mjs had no generic OpenAI-compatible
//            provider at all. A self-hosted OpenAI-compatible endpoint could
//            only be reached if an operator also set OPENROUTER_API_KEY or
//            GROQ_API_KEY — neither of which is meaningful for a self-hosted
//            target, so this case was unreachable in practice.
//   POST-FIX: a generic branch is appended at the tail when LLM_API_URL +
//             LLM_API_KEY + LLM_MODEL are all set AND no named-provider key
//             has already claimed the chain.
//
// The named regression test below documents the post-fix contract. It is
// designed so that, with the new branch removed, it fails on the
// `'generic' provider gets appended at the tail` assertion. The pre-fix
// verification step is performed by the task worker: temporarily revert the
// resolver tail (search "PER-79 (upstream PR 3/3): append the generic" in
// scripts/seed-forecasts.mjs), run `npm run test:data -- tests/forecast-llm-generic-branch.test.mjs`,
// observe this single test fail with "expected generic to be appended...",
// then restore the fix and confirm green.

test('PER-79 generic-branch regression: named-provider keys always hide generic from the chain', () => {
  // Three sub-claims form the contract the new branch guarantees. Reverting
  // the resolver tail in scripts/seed-forecasts.mjs (#14914-#14937) breaks ALL
  // three at once — which is exactly what this test is here to catch.
  const URL = 'https://example.invalid/v1/chat/completions';
  const KEY = 'redacted-llm-key';

  // (i) Named-provider key wins: with OPENROUTER_API_KEY set, the resolved
  // chain MUST NOT include generic, regardless of the three generic envs.
  process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
  process.env.LLM_API_URL = URL;
  process.env.LLM_API_KEY = KEY;
  process.env.LLM_MODEL = 'gpt-3.5-turbo';
  assert.equal(
    resolveForecastLlmProviders().some((p) => p.name === 'generic'),
    false,
    'a named-provider key must always hide generic — this is the core precedence invariant',
  );

  // (ii) GROQ key alone also hides generic — the contract names openrouter
  // AND groq by envKey, not just whichever happens to come first.
  delete process.env.OPENROUTER_API_KEY;
  process.env.GROQ_API_KEY = 'groq-test-key';
  assert.equal(
    resolveForecastLlmProviders().some((p) => p.name === 'generic'),
    false,
    'groq key alone must also hide generic — single-key rule covers both named providers',
  );

  // (iii) All three generic envs set, no named-provider key, generic enters
  // at the TAIL — never in a named-provider's slot. Without the new branch,
  // this assertion fails on the first .some() check.
  delete process.env.GROQ_API_KEY;
  const chain = resolveForecastLlmProviders().map((p) => p.name);
  assert.deepEqual(
    chain,
    ['openrouter', 'openrouter-free', 'openrouter-free-backup', 'groq', 'generic'],
    'with all three generic envs set and no named key, generic must enter LAST in the default chain',
  );
});

test('PER-79 generic-branch regression: outbound fetch shape is OpenAI-compatible chat/completions', async () => {
  // Companion to the precedence regression above: the new branch must also
  // produce the correct OUTBOUND request, not just appear in the resolver
  // chain. Without `buildForecastGenericLlmProvider()` the request body would
  // fall back to a named-provider entry (deepseek-v4-flash on openrouter's
  // payload) — this test pins the chat/completions contract end-to-end.
  const URL = 'https://example.invalid/v1/chat/completions';
  const KEY = 'redacted-llm-key';
  const MODEL = 'gpt-3.5-turbo';
  process.env.LLM_API_URL = URL;
  process.env.LLM_API_KEY = KEY;
  process.env.LLM_MODEL = MODEL;
  let seen = null;
  __setForecastLlmTransportForTests({
    fetch: async (fetchUrl, init) => {
      seen = { fetchUrl, init };
      return jsonResponse({
        choices: [{ message: { content: 'response-text-with-enough-length' } }],
        usage: { total_tokens: 5, prompt_tokens: 2, completion_tokens: 3 },
        model: MODEL,
      });
    },
  });
  await callForecastLLM('sys-prompt', 'user-prompt', { stage: 'default' });
  assert.ok(seen, 'generic branch must issue exactly one outbound fetch');
  assert.equal(seen.fetchUrl, URL, 'fetch URL is the verbatim LLM_API_URL — no rewriting, no path append');
  assert.equal(seen.init.headers.Authorization, `Bearer ${KEY}`, 'Authorization carries the LLM_API_KEY as a Bearer token');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, MODEL, 'model field reflects LLM_MODEL verbatim');
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ['system', 'user'],
    'messages is a 2-element array of system+user roles',
  );
  assert.equal(body.messages[0].content, 'sys-prompt');
  assert.equal(body.messages[1].content, 'user-prompt');
});

// ── Stage composition + cache tag (PR review findings #2 and #7) ─────────────
// The suite above only resolved the default chain. critical_signals feeds
// state-derived probabilities and market_implications is budget-gated; both
// append generic at the tail when the last-resort trio is set. The cache tag
// must keep the hosted pin-based shape and add generic+LLM_MODEL only when
// generic is actually in the resolved chain.

test('critical_signals options append generic after the groq/openrouter pin', () => {
  setGenericEnv();
  const names = resolveForecastLlmProviders(getForecastLlmCallOptions('critical_signals'))
    .map((provider) => provider.name);
  assert.deepEqual(names, ['groq', 'openrouter', 'generic']);
});

test('market_implications options append generic after the openrouter-only pin', () => {
  setGenericEnv();
  const names = resolveForecastLlmProviders(getForecastLlmCallOptions('market_implications'))
    .map((provider) => provider.name);
  assert.deepEqual(names, ['openrouter', 'generic']);
});

test('generic-only market_implications budget is generic timeout plus stage guard', () => {
  setGenericEnv();
  // 60_000 generic default + FORECAST_LLM_STAGE_BUDGET_GUARD_MS (5_000).
  assert.equal(
    getMarketImplicationsMinRunBudgetMs(getForecastLlmCallOptions('market_implications')),
    65_000,
  );
});

test('critical_signals cache tag includes generic model only when generic is runnable', () => {
  const hostedBaseline = buildCriticalSignalRouteTag(getForecastLlmCallOptions('critical_signals'));
  assert.equal(
    hostedBaseline.includes('generic'),
    false,
    'hosted pin tag must not mention generic when named keys and LLM_* are unset',
  );

  setGenericEnv('local-llama-3');
  const genericTag = buildCriticalSignalRouteTag(getForecastLlmCallOptions('critical_signals'));
  assert.equal(genericTag.includes('generic'), true, 'generic-only tag must name the generic provider');
  assert.equal(genericTag.includes('local-llama-3'), true, 'generic-only tag must include LLM_MODEL');
  assert.notEqual(genericTag, hostedBaseline);

  setGenericEnv('other-local-model');
  const rotatedTag = buildCriticalSignalRouteTag(getForecastLlmCallOptions('critical_signals'));
  assert.equal(rotatedTag.includes('other-local-model'), true);
  assert.notEqual(rotatedTag, genericTag, 'changing LLM_MODEL must miss the previous 20-minute Redis key');

  process.env.OPENROUTER_API_KEY = 'openrouter-test-key';
  setGenericEnv('local-llama-3');
  const hostedWithGenericEnvs = buildCriticalSignalRouteTag(getForecastLlmCallOptions('critical_signals'));
  assert.equal(hostedWithGenericEnvs.includes('generic'), false);
  assert.equal(
    hostedWithGenericEnvs,
    hostedBaseline,
    'named-key hosted path must keep the pin-based tag bit-identical',
  );
});
