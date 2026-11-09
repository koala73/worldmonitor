#!/usr/bin/env node
// Authenticated MCP tool canary: call every read-only production tool with a
// real credential and check the answer, not just the status code.
//
// WHY THIS EXISTS: an MCP server can answer 200 while its tools are broken.
// mcp-live-smoke.mjs (every 15 min) walks the anonymous protocol surface and
// asserts the tools/call auth wall answers 401; it never runs a gated tool. A
// seeder that stops writing, a handler that throws on a new upstream shape, or
// a response that drifts from its advertised outputSchema all pass that walk.
// This canary follows the MCP Canary model (github.com/xakpc-dev-labs/canary):
// call real tools with deterministic arguments, assert on the result, never
// call a tool without readOnlyHint, and fail loudly.
//
// For each read-only tool advertised by tools/list on production:
//   1. tools/call with the fixture arguments below (or {} when the tool has no
//      required input). Arguments that depend on another tool's output (a
//      forecast id, a webcam id) are derived from that tool's live result.
//   2. The call must answer HTTP 200 within its deadline, carry no JSON-RPC
//      error, not set result.isError, and return structuredContent that
//      validates against the tool's own advertised outputSchema.
//   3. A failed call is retried once after a pause, so a single transient
//      upstream blip does not page anyone. A second failure is a finding.
//
// The run fails (exit 1) on any finding, and on any advertised read-only tool
// that has required inputs but no fixture here — a new tool cannot silently
// escape the canary. tests/mcp-tool-canary.test.mjs pins fixture coverage
// against the in-repo tool registry so that gap is caught in the PR that adds
// the tool, before it reaches production.
//
// Usage:
//   MCP_CANARY_KEY=wm_... node scripts/mcp-tool-canary.mjs [--report out.json]
//     [--only tool_a,tool_b] [--publish-issue]
//   MCP_CANARY_URL overrides the endpoint (default https://worldmonitor.app/mcp).
//   --publish-issue opens/updates one GitHub issue on failure and closes it on
//   recovery (needs GH_TOKEN and GITHUB_REPOSITORY, as in Actions).

import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

import { formatSafeError } from './mcp-smoke-http.mjs';
import { isMainModule } from './lib/main-module.mjs';

export const DEFAULT_MCP_URL = 'https://worldmonitor.app/mcp';
export const ISSUE_TITLE = 'MCP tool canary: production tool failures';
const USER_AGENT = 'worldmonitor-mcp-tool-canary/1.0 (+https://github.com/koala73/worldmonitor)';
const PROTOCOL_VERSION = '2025-06-18';

// Per-call deadline. LLM-backed tools (analyze_situation, verify_claim, …) and
// live flight search are the slowest legitimate answers.
const CALL_DEADLINE_MS = 90_000;
const RETRY_DELAY_MS = 15_000;
// Paced well under the per-credential 60/min MCP limit: at most CONCURRENCY
// calls in flight and at least MIN_START_GAP_MS between call starts (≤ 40/min).
const CONCURRENCY = 3;
const MIN_START_GAP_MS = 1_500;
// No call or retry starts after this budget; tools not reached are reported as
// budget_exhausted findings. Worst case after the budget: an in-flight call,
// its retry pause and its retry (~3.3 min), so report + issue publication
// always land inside the workflow's 30-minute job timeout.
const RUN_BUDGET_MS = 20 * 60_000;

function isoDateOffset(days, now = new Date()) {
  const d = new Date(now.getTime() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Fixture arguments for every read-only tool that has required inputs.
 * A value is either a static argument object or `{ after, derive }`: run after
 * tool `after` and build the arguments from its structuredContent (return null
 * when the live result has nothing to chain from).
 */
export function buildFixtures(now = new Date()) {
  return {
    get_country_history: { country_code: 'US' },
    get_defense_industrial_base: { country_code: 'DE' },
    get_country_brief: { country_code: 'US' },
    get_country_risk: { country_code: 'US' },
    get_country_coverage: { country_code: 'US' },
    get_food_stocks: { country_code: 'WORLD' },
    get_demographics_capability: { country_code: 'US' },
    get_resilience_indicators: { country_code: 'US' },
    get_consumer_prices: { country_code: 'AE' },
    get_fred_series: { series_ids: ['BAMLC0A0CM'] },
    get_airspace: { country_code: 'US' },
    get_maritime_activity: { country_code: 'US' },
    analyze_situation: { query: 'What are the implications of shipping disruption in the Strait of Hormuz?' },
    search_flights: { origin: 'JFK', destination: 'LHR', departure_date: isoDateOffset(30, now) },
    search_flight_prices_by_date: {
      origin: 'JFK', destination: 'LHR', start_date: isoDateOffset(30, now), end_date: isoDateOffset(37, now),
    },
    get_supply_vulnerabilities: { country_code: 'JP' },
    get_chokepoint_dependencies: { chokepoint_id: 'hormuz_strait' },
    search_intel_history: { query: 'naval blockade of a shipping strait' },
    get_similar_events: { situation: 'a naval blockade closes a major shipping strait' },
    describe_tool: { tool_name: 'get_sources' },
    classify_event: { text: 'Magnitude 6.1 earthquake strikes off the coast of northern Japan' },
    verify_claim: { claim: 'The Strait of Hormuz is closed to all commercial shipping' },
    get_media_perspective: { subject_country: 'SA' },
    analyze_news_headlines: { headlines: ['Oil prices rise as tensions grow in the Gulf'] },
    get_macro_history: { dataset: 'us-cpi' },
    get_supply_chain_cost_shock: { mode: 'energy', country: 'JP', chokepoint_id: 'hormuz_strait' },
    compute_energy_shock: { country: 'JP', chokepoint_id: 'hormuz_strait' },
    open_country_brief: { country_code: 'US' },
    get_country_brief_section: { section: 'facts', arguments: { country_code: 'US' } },
    // No top-level `required`, but the input is constrained by oneOf/prose:
    // a bare {} is rejected with -32602.
    get_five_factor_scorecard: { country_code: 'US' },
    get_intel_timeline: { domain: 'conflict' },
    // Answers -32002 for an operator (non-user-bound) key by design; the
    // canary records which credential kind it ran with.
    get_mcp_allowance: { args: {}, acceptRpcErrorCodes: [-32002] },
    get_bilateral_tariff: { reporter: 'US', partner: 'CN', hs_code: '870380' },
    get_us_import_duty: { hs_code: '870380', partner: 'CN' },
    find_webcams: { bound_w: 2.2, bound_s: 48.8, bound_e: 2.45, bound_n: 48.92, zoom: 12 },
    get_webcam_media: {
      after: 'find_webcams',
      derive: (sc) => {
        const id = firstString(unwrap(sc), ['webcams', 'cameras', 'items', 'results'], ['webcamId', 'id']);
        return id ? { webcam_id: id } : null;
      },
    },
    get_forecast_case: {
      after: 'get_forecast_predictions',
      derive: (sc) => {
        // Cached tools wrap the payload as { cached_at, stale, data }; the
        // forecast list lives at data.predictions.{generatedAt, predictions[]}.
        const body = unwrap(sc)?.predictions ?? unwrap(sc);
        const list = firstArray(body, ['predictions', 'forecasts', 'items']);
        const row = list?.find((r) => r && typeof r.id === 'string');
        const generatedAt = body?.generatedAt ?? body?.generated_at;
        if (!row || generatedAt == null) return null;
        return { forecast_id: row.id, generated_at: String(generatedAt) };
      },
    },
  };
}

function unwrap(sc) {
  return sc && typeof sc === 'object' && sc.data && typeof sc.data === 'object' ? sc.data : sc;
}

function firstArray(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) if (Array.isArray(obj[k])) return obj[k];
  return null;
}

function firstString(obj, listKeys, idKeys) {
  const list = firstArray(obj, listKeys) ?? [];
  for (const row of list) {
    for (const k of idKeys) if (row && typeof row[k] === 'string' && row[k]) return row[k];
  }
  return null;
}

/** Tools the canary calls: advertised, explicitly readOnlyHint: true. */
export function selectCanaryTools(tools) {
  return tools.filter((t) => t?.annotations?.readOnlyHint === true);
}

/** True when the input schema rejects {}: top-level required, or every oneOf/anyOf branch requires a key. */
export function requiresInput(inputSchema) {
  if ((inputSchema?.required ?? []).length > 0) return true;
  for (const k of ['oneOf', 'anyOf']) {
    const branches = inputSchema?.[k];
    if (Array.isArray(branches) && branches.length && branches.every((b) => (b?.required ?? []).length > 0)) return true;
  }
  return false;
}

/** Read-only tools whose input rejects {} and that have no fixture. */
export function findUncoveredTools(tools, fixtures) {
  return selectCanaryTools(tools)
    .filter((t) => requiresInput(t.inputSchema) && !(t.name in fixtures))
    .map((t) => t.name);
}

/** Normalise a fixture entry to { args, derive?, after?, acceptRpcErrorCodes }. */
export function resolveFixture(entry) {
  if (!entry) return { args: {}, acceptRpcErrorCodes: [] };
  if (typeof entry.derive === 'function') return { ...entry, acceptRpcErrorCodes: entry.acceptRpcErrorCodes ?? [] };
  if (entry.args && typeof entry.args === 'object' && 'acceptRpcErrorCodes' in entry) {
    return { args: entry.args, acceptRpcErrorCodes: entry.acceptRpcErrorCodes };
  }
  return { args: entry, acceptRpcErrorCodes: [] };
}

/**
 * Judge one tools/call exchange. Returns { ok, kind, detail }.
 * kind: ok | http | timeout | transport | rpc_error | tool_error | no_structured | schema
 */
export function evaluateCall({ status, body, error, timedOut }, validateOutput, { acceptRpcErrorCodes = [] } = {}) {
  if (timedOut) return { ok: false, kind: 'timeout', detail: `no complete answer within ${CALL_DEADLINE_MS / 1000}s` };
  if (error) return { ok: false, kind: 'transport', detail: error };
  if (status !== 200) return { ok: false, kind: 'http', detail: `HTTP ${status}` };
  let msg;
  try {
    msg = parseRpcBody(body);
  } catch {
    return { ok: false, kind: 'rpc_error', detail: 'response body is not JSON-RPC' };
  }
  if (msg.error && acceptRpcErrorCodes.includes(msg.error.code)) {
    return { ok: true, kind: 'accepted_error', detail: `accepted JSON-RPC ${msg.error.code}: ${truncate(msg.error.message, 120)}` };
  }
  if (msg.error) {
    return { ok: false, kind: 'rpc_error', detail: `JSON-RPC ${msg.error.code}: ${truncate(msg.error.message, 200)}` };
  }
  const result = msg.result;
  if (!result || typeof result !== 'object') return { ok: false, kind: 'rpc_error', detail: 'JSON-RPC result missing' };
  if (result.isError === true) {
    const text = (result.content ?? []).find((c) => c?.type === 'text')?.text ?? '';
    return { ok: false, kind: 'tool_error', detail: `isError: ${truncate(text, 200)}` };
  }
  if (!result.structuredContent || typeof result.structuredContent !== 'object') {
    return { ok: false, kind: 'no_structured', detail: 'result has no structuredContent' };
  }
  if (validateOutput && !validateOutput(result.structuredContent)) {
    const errs = (validateOutput.errors ?? []).slice(0, 3)
      .map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    return { ok: false, kind: 'schema', detail: `outputSchema mismatch: ${truncate(errs, 300)}` };
  }
  const sc = result.structuredContent;
  return { ok: true, kind: 'ok', detail: '', structuredContent: sc, ...(sc.stale === true ? { stale: true, cachedAt: sc.cached_at ?? null } : {}) };
}

// The transport may answer application/json or a single-message SSE stream.
export function parseRpcBody(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
  for (let i = data.length - 1; i >= 0; i--) {
    const parsed = JSON.parse(data[i]);
    if (parsed && ('result' in parsed || 'error' in parsed)) return parsed;
  }
  throw new Error('no JSON-RPC message in body');
}

function truncate(s, n) {
  const str = String(s ?? '').replace(/\s+/g, ' ');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

function cell(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/[\\|]/g, '\\$&').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRpcClient({ url, key, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  let nextId = 1;
  return async function rpc(method, params, deadlineMs = CALL_DEADLINE_MS) {
    const id = nextId++;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
    const startedAt = Date.now();
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL_VERSION,
          'User-Agent': USER_AGENT,
          'X-WorldMonitor-Key': key,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
      });
      const body = await res.text();
      return { status: res.status, body, ms: Date.now() - startedAt };
    } catch (err) {
      // Node's header validation quotes the offending value, which here is
      // the credential; never let it into a finding.
      return { status: null, body: '', ms: Date.now() - startedAt, timedOut,
        error: timedOut ? null : redactCredential(formatSafeError(err), key) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** A key the transport can send as one header value: one printable-ASCII token. */
export function isWellFormedKey(key) {
  return typeof key === 'string' && /^[\x21-\x7e]+$/.test(key);
}

/** Strip the credential, raw or whitespace-collapsed, from any text. */
export function redactCredential(text, key) {
  let out = String(text ?? '');
  const raw = String(key ?? '');
  for (const secret of new Set([raw, raw.replace(/\s+/g, ' '), raw.slice(3)])) {
    if (secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

// An advertised outputSchema that is missing or cannot compile is itself a
// contract failure: skipping the check would let any payload pass.
function compileValidator(ajv, tool) {
  if (!tool.outputSchema || typeof tool.outputSchema !== 'object') {
    return { validate: null, error: 'tool advertises no outputSchema' };
  }
  try {
    return { validate: ajv.compile(tool.outputSchema), error: null };
  } catch (err) {
    return { validate: null, error: `advertised outputSchema does not compile: ${truncate(err.message, 200)}` };
  }
}

/**
 * Run the canary. Returns a report object; never throws for tool failures.
 */
export async function runCanary({
  url = DEFAULT_MCP_URL,
  key,
  only = null,
  now = new Date(),
  fetchImpl,
  retryDelayMs = RETRY_DELAY_MS,
  minStartGapMs = MIN_START_GAP_MS,
  runBudgetMs = RUN_BUDGET_MS,
  log = (line) => console.log(line),
} = {}) {
  if (!key) throw new Error('MCP_CANARY_KEY is required');
  const budgetEndsAt = Date.now() + runBudgetMs;
  const budgetSpent = () => Date.now() >= budgetEndsAt;
  const BUDGET_EXHAUSTED = { ok: false, kind: 'budget_exhausted', detail: `not run: the ${Math.round(runBudgetMs / 60_000)}-minute run budget was spent`, ms: 0 };
  const rpc = createRpcClient({ url, key, fetchImpl });
  const report = {
    checkedAt: now.toISOString(), url, credential: 'unknown',
    toolCount: 0, results: [], uncovered: [], setupError: null,
  };

  // tools/list is stateless on this transport (the published CLI calls it
  // with no initialize); a failure here means nothing below can run.
  const list = await rpc('tools/list', undefined, 30_000);
  let tools;
  try {
    if (list.status !== 200) throw new Error(list.timedOut ? 'timeout' : (list.error ?? `HTTP ${list.status}`));
    const msg = parseRpcBody(list.body);
    if (msg.error) throw new Error(`JSON-RPC ${msg.error.code}: ${msg.error.message}`);
    tools = msg.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0) throw new Error('tools/list returned no tools');
  } catch (err) {
    report.setupError = redactCredential(`tools/list failed: ${truncate(err.message, 300)}`, key);
    return report;
  }

  const fixtures = buildFixtures(now);
  let canaryTools = selectCanaryTools(tools);
  report.toolCount = canaryTools.length;
  report.uncovered = findUncoveredTools(tools, fixtures);
  if (only) canaryTools = canaryTools.filter((t) => only.includes(t.name));

  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  const structuredByTool = new Map();
  const waiters = new Map();
  const done = (name) => {
    if (!waiters.has(name)) {
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      waiters.set(name, { p, resolve });
    }
    return waiters.get(name);
  };

  let lastStart = 0;
  const pace = async () => {
    const wait = lastStart + minStartGapMs - Date.now();
    lastStart = Math.max(Date.now(), lastStart + minStartGapMs);
    if (wait > 0) await sleep(wait);
  };

  async function callOnce(tool, args, validate, acceptRpcErrorCodes) {
    if (budgetSpent()) return BUDGET_EXHAUSTED;
    await pace();
    if (budgetSpent()) return BUDGET_EXHAUSTED;
    const r = await rpc('tools/call', { name: tool.name, arguments: args });
    return { ...evaluateCall(r, validate, { acceptRpcErrorCodes }), ms: r.ms };
  }

  async function runTool(tool) {
    const fixture = resolveFixture(fixtures[tool.name]);
    let args = fixture.args;
    if (typeof fixture.derive === 'function') {
      const inCanary = canaryTools.some((t) => t.name === fixture.after);
      if (inCanary) await done(fixture.after).p;
      const upstream = structuredByTool.get(fixture.after);
      args = upstream ? fixture.derive(upstream) : null;
      if (!args) {
        // A tool the canary could not reach is untested, not healthy: a run
        // that skipped it must not close the tracking issue.
        return { name: tool.name, ok: false, kind: 'unchained', attempts: 0, ms: 0,
          detail: `${fixture.after} returned nothing to derive arguments from` };
      }
    }

    const { validate, error: schemaError } = compileValidator(ajv, tool);
    if (schemaError) return { name: tool.name, ok: false, kind: 'schema_invalid', detail: schemaError, attempts: 0, ms: 0 };
    let outcome = await callOnce(tool, args, validate, fixture.acceptRpcErrorCodes);
    let attempts = 1;
    if (!outcome.ok && outcome.kind !== 'budget_exhausted') {
      await sleep(retryDelayMs);
      outcome = await callOnce(tool, args, validate, fixture.acceptRpcErrorCodes);
      attempts = 2;
    }
    if (outcome.structuredContent) structuredByTool.set(tool.name, outcome.structuredContent);
    if (tool.name === 'get_mcp_allowance') report.credential = outcome.kind === 'accepted_error' ? 'operator' : (outcome.ok ? 'user' : 'unknown');
    return { name: tool.name, ok: outcome.ok, kind: outcome.kind, detail: outcome.detail, attempts, ms: outcome.ms,
      ...(outcome.stale ? { stale: true, cachedAt: outcome.cachedAt } : {}) };
  }

  // Tools whose output feeds another fixture run first so dependents can wait.
  const queue = [...canaryTools].sort((a, b) => Number(Boolean(fixtures[a.name]?.derive)) - Number(Boolean(fixtures[b.name]?.derive)));
  const results = [];
  const worker = async () => {
    while (queue.length) {
      const tool = queue.shift();
      let result;
      try {
        result = await runTool(tool);
      } catch (err) {
        result = { name: tool.name, ok: false, kind: 'canary_error', detail: truncate(err.message, 200), attempts: 0, ms: 0 };
      }
      result.detail = redactCredential(result.detail, key);
      results.push(result);
      done(tool.name).resolve();
      log(`${result.ok ? 'PASS' : 'FAIL'} ${tool.name} ${result.ms}ms${result.attempts > 1 ? ' (retried)' : ''}${result.detail ? ` — ${result.detail}` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  report.results = results.sort((a, b) => a.name.localeCompare(b.name));
  return report;
}

export function summarize(report) {
  const failures = report.results.filter((r) => !r.ok);
  const stale = report.results.filter((r) => r.stale);
  const passed = report.results.filter((r) => r.ok);
  const healthy = !report.setupError && failures.length === 0 && report.uncovered.length === 0;
  return { healthy, failures, passed, stale };
}

export function renderMarkdown(report, { runUrl = '' } = {}) {
  const { healthy, failures, passed, stale } = summarize(report);
  const lines = [
    `MCP tool canary against \`${report.url}\`: ${healthy ? 'healthy' : 'FAILING'}.`,
    '',
    `Observed: ${cell(report.checkedAt)}${runUrl ? ` — [Workflow run](${runUrl})` : ''}`,
    '',
  ];
  if (report.setupError) {
    lines.push(`**Setup failed:** ${cell(report.setupError)}`, '');
  } else {
    lines.push(`${passed.length} passed, ${failures.length} failed, of ${report.results.length} read-only tools called (credential: ${report.credential}).`, '');
  }
  if (failures.length) {
    lines.push('| Tool | Failure | Detail | Attempts |', '| --- | --- | --- | --- |',
      ...failures.map((f) => `| \`${cell(f.name)}\` | ${cell(f.kind)} | ${cell(f.detail)} | ${f.attempts} |`), '');
  }
  if (report.uncovered.length) {
    lines.push(`**Read-only tools with required inputs but no canary fixture:** ${report.uncovered.map((n) => `\`${cell(n)}\``).join(', ')}. Add one to \`buildFixtures\` in \`scripts/mcp-tool-canary.mjs\`.`, '');
  }
  if (stale.length) {
    // Freshness is owned by /api/health and its monitors; listed here so a
    // reader sees which tool answers carried stale:true, but not a failure.
    lines.push(`Answered with \`stale: true\` (not a failure; seed freshness is alarmed by /api/health): ${stale.map((s) => `\`${cell(s.name)}\``).join(', ')}.`, '');
  }
  lines.push(
    'Each read-only tool is called with a real credential; a call passes when it answers HTTP 200 with no JSON-RPC error, no `isError`, and `structuredContent` that validates against the tool\'s advertised `outputSchema`. Failed calls are retried once before they count.',
    '',
    'Run locally: `MCP_CANARY_KEY=wm_... node scripts/mcp-tool-canary.mjs --only <tool>`.',
  );
  return lines.join('\n');
}

function ghJson(args, payload) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    input: payload ? JSON.stringify(payload) : undefined,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || 'GitHub API call failed');
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

/** Open/update one tracking issue while failing; close it on recovery. */
export function publishIssue(report, { repository = process.env.GITHUB_REPOSITORY, runUrl = '', gh = ghJson } = {}) {
  if (!repository) throw new Error('GITHUB_REPOSITORY is required to publish canary findings');
  const { healthy } = summarize(report);
  const pages = gh(['api', '--paginate', '--slurp', `repos/${repository}/issues?state=open&per_page=100`]);
  const existing = pages.flat().find((issue) => !issue.pull_request
    && issue.title === ISSUE_TITLE && issue.user?.login === 'github-actions[bot]');
  const body = renderMarkdown(report, { runUrl });
  if (healthy) {
    if (!existing) return { action: 'none' };
    gh(['api', '--method', 'POST', `repos/${repository}/issues/${existing.number}/comments`, '--input', '-'],
      { body: `Recovered.\n\n${body}` });
    gh(['api', '--method', 'PATCH', `repos/${repository}/issues/${existing.number}`, '--input', '-'],
      { state: 'closed', state_reason: 'completed' });
    return { action: 'closed', number: existing.number };
  }
  const endpoint = `repos/${repository}/issues${existing ? `/${existing.number}` : ''}`;
  const issue = gh(['api', '--method', existing ? 'PATCH' : 'POST', endpoint, '--input', '-'], { title: ISSUE_TITLE, body });
  return { action: existing ? 'updated' : 'created', number: issue?.number ?? existing?.number };
}

function parseArgs(argv) {
  const out = { report: null, only: null, publishIssue: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') out.report = argv[++i];
    else if (argv[i] === '--only') out.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === '--publish-issue') out.publishIssue = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

/**
 * Emit per-tool annotations, then publish the tracking issue. Annotations go
 * first so a GitHub API failure cannot swallow them; a publish failure is
 * reported and fails the run. Returns the process exit code.
 */
export function finalizeRun(report, { publish = false, runUrl = '', log = (l) => console.log(l), publishFn = publishIssue } = {}) {
  const { healthy, failures } = summarize(report);
  if (report.setupError) log(`::error title=MCP canary setup::${report.setupError}`);
  for (const f of failures) log(`::error title=MCP canary ${f.name}::${f.kind}: ${f.detail}`);
  let published = true;
  if (publish) {
    try {
      log(JSON.stringify(publishFn(report, { runUrl })));
    } catch (err) {
      published = false;
      log(`::error title=MCP canary issue update failed::${formatSafeError(err)}`);
    }
  }
  return healthy && published ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.MCP_CANARY_KEY ?? '';
  if (!key) {
    console.error('::error title=Missing canary credential::Set MCP_CANARY_KEY (a WorldMonitor API key with MCP access).');
    process.exit(2);
  }
  // A secret stored with a line break would be quoted verbatim by Node's
  // header validation; refuse it before any request is made.
  if (!isWellFormedKey(key)) {
    console.error('::error title=Malformed canary credential::MCP_CANARY_KEY must be one line of printable ASCII with no whitespace.');
    process.exit(2);
  }
  const report = await runCanary({ url: process.env.MCP_CANARY_URL || DEFAULT_MCP_URL, key, only: args.only });
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : '';
  const markdown = renderMarkdown(report, { runUrl });
  if (args.report) writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  console.log(`\n${markdown}`);
  // A partial --only run must never close the tracking issue on a subset.
  process.exit(finalizeRun(report, { publish: args.publishIssue && !args.only, runUrl }));
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(`::error title=MCP canary crashed::${formatSafeError(err)}`);
    process.exit(2);
  });
}
