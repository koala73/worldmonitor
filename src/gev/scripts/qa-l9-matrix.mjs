/**
 * qa-l9-matrix.mjs — the L9 release-candidate QA matrix, in one command.
 *
 * L9 is the final live keyed end-to-end QA pass, including the browser tracking
 * gate and a re-confirmation of the release bar, run against a release
 * candidate before publication.
 *
 * This runner does everything in that matrix that a machine can honestly do:
 *
 *   A · REPO     static gates — unit suite, build, the Node-24 allocation gate,
 *                secret/private-name scans, LAN-safe defaults, public files.
 *   B · FEED     server-side probes — does each keyed proxy actually return
 *                live data, and does a MISSING key degrade honestly?
 *   C · APP      one real browser session — layers populate, credits list,
 *                clean-UI keeps attribution, no key leaks into the client.
 *   D · HARNESS  the existing qa-*.mjs fleet, invoked as subprocesses and
 *                aggregated. This runner never reimplements what they cover.
 *   M · MANUAL   checks that require a person (voice microphone round trips,
 *                the LAN warning, the live-vessel transfer, …). Always
 *                reported as SKIPPED/OWNER-RUN so coverage stays honest; use
 *                --list to print their descriptions.
 *
 * Honest degradation is the core contract: a check that needs a key THIS run
 * does not have is SKIPPED with an OWNER-RUN tag, never failed. A FAIL always
 * means "the product is wrong", not "my environment was thin".
 *
 * Run:
 *   node scripts/qa-l9-matrix.mjs                        # against :4173
 *   node scripts/qa-l9-matrix.mjs --url http://localhost:4220
 *   node scripts/qa-l9-matrix.mjs --cheap                # read-only, no heavy harnesses
 *   node scripts/qa-l9-matrix.mjs --only A,B             # groups or ids
 *   node scripts/qa-l9-matrix.mjs --skip D8,D12          # drop specific checks
 *   node scripts/qa-l9-matrix.mjs --list                 # print the matrix and exit
 *   node scripts/qa-l9-matrix.mjs --json out.json        # machine-readable results
 *   node scripts/qa-l9-matrix.mjs --headful              # watch the browser group
 *
 * Exit codes: 0 = no FAILs · 1 = at least one FAIL · 2 = target unreachable.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── CLI ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function getOpt(flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const has = (flag) => argv.includes(flag);

const APP_URL = getOpt('--url', 'http://localhost:4173').replace(/\/$/, '');
const APP_ORIGIN = new URL(APP_URL).origin;
const CHEAP = has('--cheap');
const HEADFUL = has('--headful');
const LIST_ONLY = has('--list');
const JSON_OUT = getOpt('--json', null);
const ONLY = (getOpt('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SKIP_IDS = (getOpt('--skip', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// ── THE GOVERNING PRINCIPLE ───────────────────────────────────────────────
//
//   FAIL means the product is wrong. ENV/SKIP must be POSITIVELY identified,
//   never a default:
//     · connection-refused / target-gone            → ENV
//     · HTTP 500 or a malformed payload from a
//       RESPONSIVE app                              → PRODUCT FAIL
//     · a harness crash                             → HARNESS-CRASH (its own
//       visible category — never ENV, never PASS)
//     · a check that could not verify its claim     → that check FAILS or
//       reports HARNESS-CRASH, never silently passes
//
// Corollary: "no evidence of failure" is not "evidence of success". Every
// check asserts the behaviour its description claims, or it says it could not.
//
// ── result model ──────────────────────────────────────────────────────────
const PASS = 'PASS';
const PASS_SKIPS = 'PASS-WITH-SKIPS'; // green, but the harness left assertions unrun
const FAIL = 'FAIL';
const CRASH = 'HARNESS-CRASH';        // the check itself broke — counts against green
const SKIP = 'SKIPPED';
const results = [];
const C = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  m: (s) => `\x1b[35m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};
const pass = (detail) => ({ status: PASS, detail });
const passWithSkips = (detail, unrun) => ({ status: PASS_SKIPS, detail, unrun });
const fail = (detail) => ({ status: FAIL, detail });
const crash = (detail) => ({ status: CRASH, detail });
const skip = (detail, tag = 'OWNER-RUN') => ({ status: SKIP, detail, tag });

/** The closed set of outcomes. Anything else is a bug in the runner itself. */
const OUTCOMES = new Set([PASS, PASS_SKIPS, FAIL, CRASH, SKIP]);
const SKIP_TAGS = new Set(['OWNER-RUN', 'ENV', 'CHEAP', 'N/A']);

/**
 * Every verdict passes through here before it is recorded. A malformed result
 * — undefined, a non-object, an unknown status, a SKIP with no tag — used to
 * render as `SKIPPED[undefined]`, land in no counter, and leave the run green.
 * A runner that cannot classify its own result has verified nothing, so it
 * reports HARNESS-CRASH against itself.
 * @param {unknown} res The raw verdict a check returned.
 * @returns {{status: string, detail: string, tag?: string}} A valid verdict.
 */
function normalizeVerdict(res) {
  if (!res || typeof res !== 'object' || Array.isArray(res)) {
    return crash(`the runner produced a malformed verdict (${res === undefined ? 'undefined' : JSON.stringify(res)?.slice(0, 80)}) — this check verified nothing`);
  }
  if (!OUTCOMES.has(res.status)) {
    return crash(`the runner produced an unknown outcome "${String(res.status)}" — not one of ${[...OUTCOMES].join(' / ')}; this check verified nothing`);
  }
  if (res.status === SKIP && !SKIP_TAGS.has(res.tag)) {
    return crash(`a SKIPPED verdict carried an invalid tag "${String(res.tag)}" — a skip must name its reason (${[...SKIP_TAGS].join(' / ')}), or it is indistinguishable from a silent pass`);
  }
  return res;
}

/** Environment facts discovered in preflight; checks read this. */
const env = {
  // FIRMS/TOMTOM/AIS/OPENAI/OPENSKY →
  //   true    key positively present
  //   false   key positively ABSENT (the endpoint said so in its own words)
  //   'error' the status endpoint is unhealthy — key state UNKNOWN, and any
  //           check that depends on it FAILS rather than skipping
  //   null    deliberately not probed (--cheap)
  keys: {},
  node24: null,      // { bin, label } for the calibrated allocation runtime
  reachable: false,  // got ANY HTTP response (even a 500) — vs connection refused
  shellStatus: null, // the app shell's HTTP status, for the ENV-vs-FAIL split
  browserVersion: null,
  boot: null,
};

/**
 * Branch on a key's POSITIVELY established state. Returns a verdict to return
 * immediately when the state is not usable, or null to continue.
 * `'error'` (status endpoint unhealthy on a responsive app) is a product FAIL,
 * never a quiet skip; `null` (deliberately unprobed) is an honest skip.
 */
function keyGuard(name, state) {
  if (state === true || state === false) return null;
  if (state === 'error') {
    return fail(`${name} key state UNKNOWN — its status endpoint errored or returned a malformed payload on a responsive server, so this check cannot say whether the key is merely absent`);
  }
  return skip(`${name} key presence was not probed (--cheap) — this check cannot pick its keyed/keyless branch`, 'CHEAP');
}

/**
 * Required attribution per layer id, checked against the credits actually
 * registered in `viewer.creditDisplay` (source strings live in
 * src/data/dataCredits.js). C12 asserts EVERY enabled layer, and an enabled
 * layer that appears in neither this map nor the exemption list FAILS — an
 * unmapped layer must never pass silently just because nobody added it here.
 */
const CREDIT_EXPECTATIONS = {
  flights: /OpenSky/i,
  military: /adsb\.lol/i,
  satellites: /CelesTrak/i,
  earthquakes: /Geological Survey|USGS/i,
  'rocket-launches': /Launch Library|LL2/i,
  traffic: /TomTom|OpenStreetMap/i,
  cctv: /Austin|Caltrans|Transport for London|TfL/i,
  radio: /Radio Browser/i,
  bikeshare: /GBFS|bikeshare/i,
  'ais-live-vessels': /AISStream/i,
  'military-installations': /OpenStreetMap/i,
  'local-datacenters': /OpenStreetMap/i,
  'local-dams': /OpenStreetMap/i,
  'local-firms': /FIRMS/i,
  'telegeography-submarine-cables': /TeleGeography/i,
  'local-neighborhoods': /DataSF|San Francisco/i,
  'weather-effects': /Open-Meteo/i,
};

/**
 * Layers that legitimately register no third-party credit, with the reason.
 * Anything here is an explicit decision, not an oversight.
 */
const CREDIT_EXEMPT_LAYERS = {
  'military-awareness': 'derived view over other layers; it ships no data of its own and its sources carry their own credits',
  detection: 'a rendering treatment over already-credited layers, not a data source',
  annotations: 'user-drawn marks; no third-party data',
};

/** @returns {{regex: RegExp}|{exempt: string}|null} null = unmapped (fails closed). */
function requiredCreditFor(layerId) {
  if (CREDIT_EXPECTATIONS[layerId]) return { regex: CREDIT_EXPECTATIONS[layerId] };
  if (CREDIT_EXEMPT_LAYERS[layerId]) return { exempt: CREDIT_EXEMPT_LAYERS[layerId] };
  return null;
}

/**
 * Evaluate a package.json `engines.node` range against a version, without
 * pulling in semver. Supports the comparator forms this repo uses:
 * `>=24.14.0 <25 || >=26 <27`.
 *
 * Checking only the major version passed Node 24.0.0 against a `>=24.14.0`
 * floor — the floor exists because the allocation budgets are calibrated, so
 * "close enough" is exactly the wrong answer for a release gate.
 * @param {string} version e.g. "24.19.0"
 * @param {string} range e.g. ">=24.14.0 <25 || >=26 <27"
 * @returns {?boolean} null when the range uses syntax this cannot evaluate.
 */
function satisfiesEngines(version, range) {
  const parse = (v) => String(v).trim().replace(/^[v=]+/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const cmp = (a, b) => {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i += 1) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
    }
    return 0;
  };
  const ops = { '>=': (c) => c >= 0, '>': (c) => c > 0, '<=': (c) => c <= 0, '<': (c) => c < 0, '=': (c) => c === 0 };
  let unsupported = false;
  const ok = String(range || '').split('||').some((clause) => {
    const parts = clause.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return false;
    return parts.every((part) => {
      const m = /^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+){0,2})$/.exec(part);
      if (!m) { unsupported = true; return false; }
      return ops[m[1] || '='](cmp(version, m[2]));
    });
  });
  return unsupported && !ok ? null : ok;
}

/**
 * Does a `node --version` string name the runtime the allocation budgets are
 * calibrated for? A3 pins the binary it actually invoked, because npm can
 * re-resolve the interpreter from PATH and hand the gate a different Node than
 * the one the check believes it selected.
 * @param {string} version e.g. "v24.19.0"
 * @returns {boolean} true only for a parseable Node 24.
 */
function isCalibratedAllocationRuntime(version) {
  const [maj] = String(version || '').trim().replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10));
  return maj === 24;
}

/**
 * Did C10's traffic measurement expire before the flow fetch landed?
 *
 * The same discrimination C11 makes for the bundled layers: "still loading when
 * my budget expired" is not "empty". The discriminator is whether the flow
 * request ever completed — NOT whether the answer was empty — so a result that
 * landed and is empty keeps failing. That empty-but-landed shape is the
 * Overpass-outage signature (no road graph to colour: tiles fetched, nothing
 * coloured), and it must stay a FAIL.
 * @param {object} stats the traffic layer's getStats() snapshot.
 * @returns {boolean} true when the check observed no flow fetch at all.
 */
function trafficFlowInconclusive(stats) {
  const s = stats || {};
  return s.mode === 'live'
    && !(s.tilesFetched > 0)
    && Boolean(s.loading || s.loadingLabel)
    && !s.error;
}

/** Positively-identified "the target is not there at all" (never an HTTP error). */
const CONNECTION_REFUSED_RE = /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|fetch failed|socket hang up|Connect Timeout/i;
/** Harness preflight messages that positively mean "no server", not "harness broke". */
const HARNESS_ENV_RE = /Dev server (?:not reachable|unavailable)|Dev server unavailable at|not reachable at http/i;

// ── small helpers ─────────────────────────────────────────────────────────
async function jget(path, { method = 'GET', timeoutMs = 25000, body = null } = {}) {
  const res = await fetch(`${APP_URL}${path}`, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
    ...(body ? { body, headers: { 'Content-Type': 'application/json' } } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text payload */ }
  return { status: res.status, ok: res.ok, headers: res.headers, text, json };
}

function sh(cmd, args, { cwd = REPO_ROOT, env: extraEnv = {}, timeoutMs = 600000 } = {}) {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group: killing a timed-out harness must also take its
      // Chromium descendants down. An orphaned browser keeps a GPU context and
      // a websocket alive and contaminates every later check in the fleet.
      detached: true,
    });
    let out = '';
    let err = '';
    const killTree = () => {
      // Negative pid = the whole process group. Fall back to the bare child if
      // the group is already gone.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    const timer = setTimeout(killTree, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Sweep the group again on normal exit too: a harness that leaks its
      // browser would otherwise leave it running for the rest of the matrix.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already reaped */ }
      resolveP({ code, signal, out, err, timedOut: signal === 'SIGKILL' });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveP({ code: -1, signal: null, out, err: String(e?.message || e), timedOut: false });
    });
  });
}

const tail = (s, n = 220) => (s || '').trim().split('\n').slice(-3).join(' | ').slice(-n);

// ── harness adapters ──────────────────────────────────────────────────────
// Exit-code semantics across the fleet are NOT uniform: 1 = assertions failed,
// 2 = environment/preflight (server down, key missing), 3 = harness crash. And
// qa-floor-verify never sets a code at all. So every harness declares how to
// read itself.
// Verdict lines are ANCHORED and matched across the WHOLE transcript, not
// "first hit wins". A parser that accepts the first match will happily read a
// scoreboard that has trailing garbage on it, or take the first of two
// contradictory scoreboards — both of which let a broken harness pass.
const RESULT_RE = /^[^\S\n]*RESULT:[^\S\n]*(\d+)[^\S\n]+passed,[^\S\n]*(\d+)[^\S\n]+failed(?:,[^\S\n]*(\d+)[^\S\n]+(?:skipped|inconclusive))?[^\S\n]*$/gm;
const COCKPIT_RE = /^[^\S\n]*RESULT:[^\S\n]*(READY|NOT_READY)[^\S\n]*\((\d+)[^\S\n]+failures\)[^\S\n]*$/gm;
const FLOOR_RE = /^[^\S\n]*VERDICT:[^\S\n]*(PASS|INCONCLUSIVE|FAIL)[^\S\n]*$/gm;
const OVERLAY_RE = /^[^\S\n]*Summary:[^\S\n]*(\d+)[^\S\n]+measured[^\S\n]*·[^\S\n]*(\d+)[^\S\n]+skipped[^\S\n]*·[^\S\n]*(\d+)[^\S\n]+errors[^\S\n]*$/gm;

/**
 * Collect EVERY complete verdict line in a transcript.
 *
 * A harness must emit exactly one. Zero means it never reported; more than one
 * means its output is self-contradictory (two scoreboards) or duplicated, and
 * a runner that silently takes the first is choosing which truth to believe.
 * @param {RegExp} re A /gm/-flagged, line-anchored verdict pattern.
 * @param {string} text The transcript to scan.
 * @returns {RegExpExecArray[]} All matches, in order.
 */
function allVerdictLines(re, text) {
  re.lastIndex = 0;
  return [...String(text || '').matchAll(re)];
}

/**
 * Enforce "exactly one complete verdict line" across stdout and stderr.
 * @returns {{matches: RegExpExecArray[], verdict: ?object}} verdict set = stop.
 */
function soleVerdict(re, kind, { out, err }) {
  const matches = [...allVerdictLines(re, out), ...allVerdictLines(re, err)];
  if (matches.length > 1) {
    const rendered = matches.map((m) => m[0].trim()).join(' || ');
    // Identical duplicates are still a defect (which run is being reported?),
    // but contradictory ones are the dangerous case. Both stop the check.
    const distinct = new Set(matches.map((m) => m[0].trim()));
    return {
      matches,
      verdict: crash(distinct.size > 1
        ? `contradictory harness output: ${matches.length} different ${kind} lines — ${rendered}; this check cannot be trusted either way`
        : `duplicated harness output: the ${kind} line was emitted ${matches.length} times — ${rendered}; it is unclear which run this reports`),
    };
  }
  return { matches, verdict: null };
}

/**
 * Positively classify a non-parseable harness run. A missing scoreboard is a
 * HARNESS-CRASH by default; it only becomes ENV when the harness itself said,
 * in words, that the server was not there. Exit code 2 is NOT evidence of
 * environment — several harnesses use it for arbitrary top-level exceptions.
 */
function classifyNoScoreboard(kind, { code, out, err }) {
  const blob = `${err}\n${out}`;
  if (HARNESS_ENV_RE.test(blob)) return skip(`harness preflight: target not reachable — ${tail(err) || tail(out)}`, 'ENV');
  return crash(`no ${kind} line (exit ${code}) — the harness did not complete: ${tail(err) || tail(out)}`);
}

function readResultLine({ code, out, err, timedOut }) {
  if (timedOut) return fail('timed out');
  const sole = soleVerdict(RESULT_RE, 'RESULT', { out, err });
  if (sole.verdict) return sole.verdict;
  const m = sole.matches[0];
  if (!m) return classifyNoScoreboard('RESULT', { code, out, err });
  const [, p, f, s] = m;
  const skipped = Number(s || 0);
  const detail = `${p} passed, ${f} failed${skipped ? `, ${skipped} skipped/inconclusive` : ''}`;
  if (Number(f) > 0) return fail(detail);
  // A scoreboard with no assertions at all means the harness bailed before
  // testing anything. It cannot be a pass, and it is not automatically ENV.
  if (Number(p) === 0) return classifyNoScoreboard('asserting RESULT', { code, out, err: `${err}\nharness asserted nothing (${detail})` });
  // Exit 2/3 alongside a clean scoreboard means it broke AFTER reporting
  // (browser teardown, cleanup) — still not a clean pass.
  if (code !== 0) return crash(`${detail}, but the harness exited ${code} after reporting: ${tail(err)}`);
  // Green, but assertions were left unrun — visible, never silently green.
  if (skipped > 0) return passWithSkips(detail, skipped);
  return pass(detail);
}

function readCockpit({ code, out, err, timedOut }) {
  if (timedOut) return fail('timed out');
  const sole = soleVerdict(COCKPIT_RE, 'RESULT', { out, err });
  if (sole.verdict) return sole.verdict;
  const m = sole.matches[0];
  if (!m) return classifyNoScoreboard('RESULT', { code, out, err });
  const failures = Number(m[2]);
  if (m[1] !== 'READY') return fail(`NOT_READY, ${failures} failures`);
  // READY with a nonzero failure count is self-contradictory output. Reading
  // only the word and ignoring the number it carries is exactly how a broken
  // harness passes a gate.
  if (failures > 0) {
    return crash(`contradictory harness output: "READY (${failures} failures)" — the verdict and the count disagree, so this check cannot be trusted either way`);
  }
  if (code !== 0) return crash(`READY, but the harness exited ${code} after reporting: ${tail(err)}`);
  return pass('READY, 0 failures');
}

/**
 * A check may declare KNOWN CONDITIONS: an evidence-gated one-line
 * classification for a non-passing verdict. The note explains a failure; it
 * NEVER changes it. A condition only applies when its pattern is actually
 * present in the harness transcript, so it cannot become a blanket excuse.
 * @param {{status: string}} verdict The verdict to annotate.
 * @param {{when: RegExp, note: string}[]} conditions Declared conditions.
 * @param {string} transcript The harness stdout+stderr.
 * @returns {{status: string}} The same verdict, possibly with `.note`.
 */
function applyKnownConditions(verdict, conditions, transcript) {
  if (!verdict || verdict.status === PASS || !Array.isArray(conditions)) return verdict;
  const hit = conditions.find((c) => c.when.test(transcript || ''));
  if (hit) verdict.note = hit.note;
  return verdict;
}

function readFloorVerdict({ code, out, err, timedOut }) {
  // qa-floor-verify.mjs never sets an exit code — stdout is the only truth.
  if (timedOut) return fail('timed out');
  const sole = soleVerdict(FLOOR_RE, 'VERDICT', { out, err });
  if (sole.verdict) return sole.verdict;
  const m = sole.matches[0];
  if (!m) return classifyNoScoreboard('VERDICT', { code, out, err });
  if (m[1] === 'FAIL') return fail('VERDICT: FAIL — grounded contacts buried below the mesh floor');
  if (m[1] === 'INCONCLUSIVE') {
    // The oracle found nothing to measure. That is a failure of ITS
    // preconditions — hiding every grounded contact must not silently skip the
    // regression it exists to catch.
    const counts = /low contacts with plausible mesh readings:\s*(\d+)/.exec(out);
    return fail(`VERDICT: INCONCLUSIVE — the floor oracle had no candidates to measure (${counts ? `${counts[1]} plausible low contacts` : 'no count reported'}). Preconditions unmet: expected grounded/low traffic at the test airport`);
  }
  if (code !== 0 && code !== null) return crash(`VERDICT: PASS, but the harness exited ${code} afterwards: ${tail(err)}`);
  return pass('VERDICT: PASS');
}

/**
 * qa-overlay-baseline's `Summary:` line only proves SAMPLING completed — a
 * scene whose layer never activated still reports `1 measured · 0 errors`. The
 * harness's own `--json` carries the proof: `layerActivations[].toggleResult`
 * and `.delta` (entities / primitiveLabels / nonemptyLabelText). Read that.
 */
function readOverlaySummary(layerId, jsonPath) {
  return ({ code, out, err, timedOut }) => {
    if (timedOut) return fail('timed out');
    const sole = soleVerdict(OVERLAY_RE, 'Summary', { out, err });
    if (sole.verdict) return sole.verdict;
    const m = sole.matches[0];
    if (!m) return classifyNoScoreboard('Summary', { code, out, err });
    const [, measured, skipped, errors] = m;
    if (Number(errors) > 0) return fail(`${measured} measured, ${errors} errors`);
    if (Number(measured) === 0) {
      return fail(`0 measured, ${skipped} skipped — the ${layerId} scene produced nothing to measure, so the layer never activated`);
    }
    let run = null;
    try { run = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch (e) {
      return crash(`harness reported ${measured} measured but wrote no readable --json (${String(e?.message || e).slice(0, 80)}); this check cannot prove the ${layerId} overlay was nonempty`);
    }
    const act = (run.scenes || [])
      .flatMap((sc) => sc.layerActivations || [])
      .find((a) => a.layerId === layerId);
    if (!act) return crash(`no activation record for ${layerId} in the harness JSON — the check cannot verify its claim`);
    if (act.toggleResult?.error) return fail(`${layerId} failed to activate: ${String(act.toggleResult.error).slice(0, 120)}`);
    if (act.toggleResult?.enabled !== true) return fail(`${layerId} did not report enabled after activation: ${JSON.stringify(act.toggleResult).slice(0, 120)}`);
    const d = act.delta || {};
    const drawn = (d.entities || 0) + (d.primitiveLabels || 0) + (d.primitiveBillboards || 0) + (d.primitivePoints || 0);
    const layerCount = act.state?.stats?.count;
    if (!(drawn > 0)) {
      return fail(`${layerId} activated but drew nothing (entities=${d.entities ?? 'n/a'} primitiveLabels=${d.primitiveLabels ?? 'n/a'} stats.count=${layerCount ?? 'n/a'}) — an empty overlay is not a baseline`);
    }
    if (code !== 0) return crash(`${measured} measured, but the harness exited ${code} after reporting: ${tail(err)}`);
    return pass(`${measured} measured, 0 errors; ${layerId} activated and drew ${drawn} (entities=${d.entities} labels=${d.primitiveLabels} nonemptyLabelText=${d.nonemptyLabelText ?? 'n/a'} stats.count=${layerCount ?? 'n/a'})`);
  };
}

const HARNESS_LOG_DIR = resolve(REPO_ROOT, '.gev-logs', 'qa-l9-matrix');
/** Where D12 asks qa-overlay-baseline to write its machine-readable run. */
const OVERLAY_JSON = resolve(HARNESS_LOG_DIR, 'D12-overlay-baseline.json');

/** Declarative harness runner: reuses the shipped fleet, never reimplements it. */
function harness({ id, script, args = [], parse = readResultLine, timeoutMs = 900000, envExtra = {}, knownConditions = [] }) {
  return async () => {
    mkdirSync(HARNESS_LOG_DIR, { recursive: true });
    const r = await sh(process.execPath, [resolve(REPO_ROOT, 'scripts', script), ...args], {
      timeoutMs,
      env: { QA_BASE_URL: APP_URL, ...envExtra },
    });
    const verdict = applyKnownConditions(parse(r), knownConditions, `${r.out}\n${r.err}`);
    // A dev server whose dependency optimizer re-runs mid-test answers 504
    // "Outdated Optimize Dep" and the module never evaluates. Everything
    // downstream is then measured against a broken module graph — on a cold
    // cache this turned the geoid module into five bogus height-datum
    // "failures". That is a positively identified environment condition (an
    // exact Vite marker, not a guess), so it is an ENV skip rather than a false
    // accusation against the product. It never rescues a run that passed.
    if ((verdict.status === FAIL || verdict.status === CRASH)
      && /Outdated Optimize Dep/.test(`${r.out}\n${r.err}`)) {
      verdict.status = SKIP;
      verdict.tag = 'ENV';
      verdict.detail = `${verdict.detail} — but the dev server re-optimized dependencies mid-run (Vite 504 "Outdated Optimize Dep"), so this ran against a broken module graph. Load the app once to warm the server, then re-run this check.`;
    }
    // Keep the full transcript of anything that did not pass — otherwise
    // diagnosing a harness failure costs a whole second run.
    if (verdict.status !== PASS) {
      try {
        mkdirSync(HARNESS_LOG_DIR, { recursive: true });
        const logPath = resolve(HARNESS_LOG_DIR, `${id || script.replace(/\.mjs$/, '')}.log`);
        writeFileSync(logPath, `$ node scripts/${script} ${args.join(' ')}\nexit=${r.code} signal=${r.signal}\n\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}\n`);
        verdict.detail = `${verdict.detail}  [log: ${logPath.replace(`${REPO_ROOT}/`, '')}]`;
      } catch { /* logging must never change a verdict */ }
    }
    return verdict;
  };
}

// ── the matrix ────────────────────────────────────────────────────────────
// heavy: dropped by --cheap (long, or drives real load against the target)
// costly: dropped by --cheap (spends third-party API credit)
// needsKey: SKIPPED/OWNER-RUN when the target server has no such key
const CHECKS = [];
const check = (spec) => { CHECKS.push(spec); };

// ─── A · REPO GATES ───────────────────────────────────────────────────────
check({
  id: 'A1', group: 'A', desc: 'Node runtime satisfies package.json engines (allocation budgets are pinned to Node 24)',
  run: async () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    const range = pkg.engines?.node || '(unset)';
    const satisfied = satisfiesEngines(process.versions.node, range);
    if (satisfied === null) {
      return crash(`could not evaluate engines range "${range}" against node ${process.versions.node} — this check cannot confirm the runtime is supported`);
    }
    if (satisfied) return pass(`node ${process.versions.node} satisfies "${range}"`);
    // An off-range runtime is an environment problem, not a product defect —
    // but it silently disables the allocation gate, so say so loudly. A3 then
    // runs that gate under a discovered Node 24.
    return env.node24
      ? skip(`node ${process.versions.node} is OUTSIDE "${range}"; A3 runs the allocation gate under ${env.node24.label}, but prefer running the whole L9 pass on Node 24`, 'ENV')
      : fail(`node ${process.versions.node} is OUTSIDE "${range}" and no Node 24 runtime was found — the allocation gate cannot run at all`);
  },
});

check({
  id: 'A2', group: 'A', desc: 'npm test — unit suite green',
  heavy: false,
  run: async () => {
    const r = await sh('npm', ['test'], { timeoutMs: 600000 });
    const m = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(r.out) || /pass (\d+)[\s\S]*?fail (\d+)/.exec(r.out);
    if (!m) return fail(`could not parse test output (exit ${r.code}): ${tail(r.err) || tail(r.out)}`);
    const [, p, f] = m;
    return Number(f) === 0 && r.code === 0
      ? pass(`${p} passed, ${f} failed`)
      : fail(`${p} passed, ${f} failed (exit ${r.code})`);
  },
});

check({
  id: 'A3', group: 'A', desc: 'Allocation microbenchmarks actually EXECUTE (they silently skip off Node 24)',
  run: async () => {
    // npm test prints "[unit] SKIPPED n allocation microbenchmarks" and still
    // exits 0 when the runtime is not Node 24. A green suite is therefore NOT
    // proof the gate ran. Force it, under Node 24 when one is discoverable.
    //
    // ALWAYS invoke the Node 24 BINARY directly — never `npm test`. npm
    // re-resolves the interpreter from PATH and can land back on the system
    // Node even when THIS process is already 24: running the whole matrix under
    // `mise exec node@24.19.0 --`, the npm shell-out still re-execed system
    // Node 25 and the forced gate refused with "received 25.6.1", which the
    // check then reported as a product failure. That silent re-resolution is
    // the very thing A3 exists to catch, so both branches now take the same
    // route and both PIN the runtime they actually invoked.
    const runGate = async (bin, label) => {
      const v = await sh(bin, ['--version'], { timeoutMs: 60000 });
      const version = (v.out || '').trim();
      if (!isCalibratedAllocationRuntime(version)) {
        // run-unit-tests.mjs refuses to measure calibrated budgets off Node 24,
        // so a wrong binary means the gate never ran. That is this check failing
        // to establish its own claim — not evidence about the product.
        return crash(`the runtime selected for the allocation gate (${label}) reports ${version || 'no parseable version'}, not Node 24 — the gate would refuse or silently skip, so this check verified nothing`);
      }
      const r = await sh(bin, [resolve(REPO_ROOT, 'scripts/run-unit-tests.mjs')], {
        timeoutMs: 600000, env: { GEV_REQUIRE_ALLOCATION_GATE: '1' },
      });
      return r.code === 0
        ? pass(`allocation gate ran under ${label} (${version}) and passed`)
        : fail(`allocation gate failed under ${label} (${version}): ${tail(r.out) || tail(r.err)}`);
    };

    const [maj] = process.versions.node.split('.').map(Number);
    if (maj === 24) return runGate(process.execPath, 'this runtime');
    if (env.node24) return runGate(env.node24.bin, env.node24.label);
    return skip(`no Node 24 runtime found (running ${process.versions.node}); the gate SKIPS silently — install Node 24 and re-run`, 'OWNER-RUN');
  },
});

check({
  id: 'A4', group: 'A', desc: 'npm run build — production build clean',
  run: async () => {
    const r = await sh('npm', ['run', 'build'], { timeoutMs: 900000 });
    return r.code === 0 ? pass('build succeeded') : fail(`build failed: ${tail(r.err) || tail(r.out)}`);
  },
});

check({
  id: 'A5', group: 'A',
  // Named for what it actually does. It is a KNOWN-PREFIX scan, not a general
  // secret detector — a high-entropy blob with no recognised prefix passes it.
  desc: 'No tracked .env, and no known-prefix credential literals (OpenAI/Google/AWS/GitHub/Slack/Stripe/private keys)',
  run: async () => {
    const tracked = await sh('git', ['ls-files'], { timeoutMs: 60000 });
    // git ls-files exits non-zero only on real failure — a failed enumeration
    // must not read as "no .env files found".
    if (tracked.code !== 0) return crash(`git ls-files failed (exit ${tracked.code}): ${tail(tracked.err)}`);
    const files = tracked.out.split('\n').filter(Boolean);
    if (files.length === 0) return crash('git ls-files returned nothing — cannot claim the tree is clean');
    const envFiles = files.filter((f) => /(^|\/)\.env($|\.(?!example))/.test(f));
    if (envFiles.length) return fail(`tracked env file(s): ${envFiles.join(', ')}`);

    const patterns = [
      'sk-[A-Za-z0-9]{20,}',                 // OpenAI
      'AIza[0-9A-Za-z_\\-]{30,}',            // Google
      'AKIA[0-9A-Z]{16}',                    // AWS access key id
      'ASIA[0-9A-Z]{16}',                    // AWS session key id
      'gh[pousr]_[A-Za-z0-9]{30,}',          // GitHub tokens
      'xox[baprs]-[A-Za-z0-9-]{10,}',        // Slack
      '(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}', // Stripe
      '-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----',
    ];
    const grep = await sh('git', ['grep', '-nIE', `(${patterns.join('|')})`, '--', ':!*.md', ':!docs/**'], { timeoutMs: 120000 });
    // git grep: 0 = matches found, 1 = no matches (the clean case), >1 = error.
    if (grep.code > 1) return crash(`git grep failed (exit ${grep.code}): ${tail(grep.err)}`);
    const hits = grep.out.split('\n').filter(Boolean);
    return hits.length === 0
      ? pass(`no tracked .env; ${patterns.length} credential prefixes scanned across ${files.length} tracked files, no hits`)
      : fail(`${hits.length} credential literal(s): ${hits.slice(0, 2).join(' | ').slice(0, 200)}`);
  },
});

check({
  id: 'A6', group: 'A', desc: 'Private-name scan over publicly shipped paths (release checklist)',
  run: async () => {
    // The public snapshot must not carry non-public scenario vocabulary. This
    // check scans the complete tracked candidate, which is already curated.
    //
    // The release checklist also lists two more terms that are dropped as
    // blockers because both are legitimately present in the shipping tree: one
    // is the name of the auto-detection default view (README, CHANGELOG,
    // src/data/*), the other appears inside the bundled public geodata
    // (datacenter and submarine-cable landing points). Scanning for them
    // produces only false positives, so they are intentionally omitted here.
    //
    // The terms are assembled from fragments so THIS file carries no literal
    // copy of the private vocabulary. Spelling them out here would make the
    // scanner its own first hit — and this script ships publicly.
    const terms = [['horm', 'uz'], ['cease', 'fire'], ['gps-', 'jamming']].map(([a, b]) => a + b);
    const grep = await sh('git', ['grep', '-lIiE', terms.join('|'), '--'], { timeoutMs: 120000 });
    // 0 = matches, 1 = no matches, >1 = the scan itself failed.
    if (grep.code > 1) return crash(`git grep failed (exit ${grep.code}): ${tail(grep.err)}`);
    const hits = grep.out.split('\n').filter(Boolean);
    return hits.length === 0
      ? pass(`clean for: ${terms.join(', ')}`)
      : fail(`${hits.length} file(s) carry private terms: ${hits.slice(0, 4).join(', ')}`);
  },
});

check({
  id: 'A7', group: 'A', desc: 'Public-facing files present (LICENSE, SECURITY, DATA_SOURCES, README, .env.example)',
  run: async () => {
    const want = ['LICENSE', 'SECURITY.md', 'DATA_SOURCES.md', 'README.md', '.env.example', 'CHANGELOG.md'];
    const missing = want.filter((f) => !existsSync(resolve(REPO_ROOT, f)));
    return missing.length === 0 ? pass(want.join(', ')) : fail(`missing: ${missing.join(', ')}`);
  },
});

check({
  id: 'A8', group: 'A', desc: 'Default launch binds localhost; LAN is an explicit opt-in that warns (release bar #3)',
  run: async () => {
    const sh_ = readFileSync(resolve(REPO_ROOT, 'scripts/dev-fresh.sh'), 'utf8');
    const localDefault = /HOST="\$\{HOST:-localhost\}"/.test(sh_);
    const warns = /WARNING: HOST=/.test(sh_) && /brokers your configured API keys/i.test(sh_);
    const localBanner = /Local-only mode/.test(sh_);
    if (localDefault && warns && localBanner) return pass('HOST defaults to localhost; LAN path prints the key-exposure warning');
    return fail(`localhost-default=${localDefault} lan-warning=${warns} local-banner=${localBanner}`);
  },
});

check({
  id: 'A9', group: 'A', desc: '.env.example documents LAN opt-in + the cost-control throttles',
  run: async () => {
    const t = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8');
    const bits = {
      lan: /HOST=0\.0\.0\.0/.test(t),
      google: /GEV_RATELIMIT_GOOGLE_PER_MIN/.test(t),
      openai: /GEV_RATELIMIT_OPENAI_PER_MIN/.test(t),
      notBilling: /not.*billing cap|billing cap/i.test(t),
    };
    const bad = Object.entries(bits).filter(([, v]) => !v).map(([k]) => k);
    return bad.length === 0 ? pass('LAN opt-in + both throttles + the not-a-billing-cap caveat') : fail(`missing: ${bad.join(', ')}`);
  },
});

// ─── B · FEED PROBES (server side) ────────────────────────────────────────
check({
  id: 'B1', group: 'B', desc: 'Target serves the app shell',
  run: async () => {
    const r = await jget('/');
    return r.ok && /<div id="cesiumContainer"|<title>/i.test(r.text)
      ? pass(`HTTP ${r.status}, ${r.text.length} bytes`)
      : fail(`HTTP ${r.status}`);
  },
});

check({
  id: 'B2', group: 'B', desc: 'Flights proxy returns live contacts (/api/opensky)',
  run: async () => {
    const r = await jget('/api/opensky?lamin=24&lomin=-125&lamax=50&lomax=-66', { timeoutMs: 45000 });
    if (!r.ok) return fail(`HTTP ${r.status}: ${r.text.slice(0, 120)}`);
    const n = r.json?.states?.length || 0;
    return n > 0 ? pass(`${n} states, cache=${r.headers.get('x-opensky-cache') || 'n/a'}`) : fail('0 states returned');
  },
});

check({
  id: 'B3', group: 'B', desc: 'OpenSky credentials are actually in use (not the anonymous/fallback path)',
  run: async () => {
    const r = await jget('/api/opensky?lamin=24&lomin=-125&lamax=50&lomax=-66', { timeoutMs: 45000 });
    // Header names are exact: X-OpenSky-Auth-Mode-Used / X-OpenSky-Auth-Reason.
    // (An earlier guess at these names made this check pass vacuously.)
    const reason = r.headers.get('X-OpenSky-Auth-Reason') || '';
    const used = r.headers.get('X-OpenSky-Auth-Mode-Used') || r.headers.get('X-OpenSky-Auth') || '';
    if (!r.ok) return fail(`HTTP ${r.status} from a responsive proxy (auth=${used || 'n/a'} reason=${reason || 'n/a'}): ${r.text.slice(0, 120)}`);
    if (!used) return fail('proxy answered 200 without the X-OpenSky-Auth headers — cannot verify which auth mode served this');
    if (/invalid_credentials|rejected/.test(reason)) return fail(`OpenSky rejected the configured credentials (reason=${reason})`);
    if (/missing_.*creds|invalid_or_missing/.test(reason) || used === 'anon') {
      return skip(`OpenSky served ANONYMOUSLY (auth=${used}, reason=${reason || 'n/a'}) — the keyed claim needs configured credentials`, 'OWNER-RUN');
    }
    if (!/^(oauth|basic)$/.test(used)) {
      // 'cached'/'unknown'/'adsblol-regional' etc. — real, but not proof that
      // credentials are in use right now.
      return fail(`served by mode "${used}" (reason=${reason || 'n/a'}) — not a live authenticated OpenSky fetch, so this check cannot confirm credentials are in use`);
    }
    return pass(`authenticated: auth=${used}, reason=${reason || 'n/a'}, cache=${r.headers.get('X-OpenSky-Cache') || 'n/a'}`);
  },
});

check({
  id: 'B4', group: 'B', desc: 'CelesTrak TLE proxy serves and caches (/api/celestrak/stations)',
  run: async () => {
    const r = await jget('/api/celestrak/stations', { timeoutMs: 40000 });
    if (!r.ok) return fail(`HTTP ${r.status}`);
    const lines = r.text.split('\n').filter((l) => /^1 /.test(l)).length;
    const cache = r.headers.get('x-tle-cache');
    return lines > 0 ? pass(`${lines} TLE records, x-tle-cache=${cache}`) : fail('no TLE lines in response');
  },
});

check({
  id: 'B5', group: 'B', desc: 'TLEs are FRESH (epoch under 14 days — a stale catalog silently mis-propagates)',
  run: async () => {
    const r = await jget('/api/celestrak/stations', { timeoutMs: 40000 });
    if (!r.ok) return fail(`HTTP ${r.status}`);
    const line1 = r.text.split('\n').find((l) => /^1 /.test(l));
    if (!line1) return fail('no TLE line 1 found');
    // Columns 19-32: epoch YYDDD.DDDDDDDD
    const yy = Number(line1.slice(18, 20));
    const ddd = Number(line1.slice(20, 32));
    const year = yy < 57 ? 2000 + yy : 1900 + yy;
    const epoch = new Date(Date.UTC(year, 0, 1) + (ddd - 1) * 86400000);
    const ageDays = (Date.now() - epoch.getTime()) / 86400000;
    return ageDays >= 0 && ageDays < 14
      ? pass(`newest epoch ${epoch.toISOString().slice(0, 10)} (${ageDays.toFixed(1)} d old)`)
      : fail(`TLE epoch ${epoch.toISOString().slice(0, 10)} is ${ageDays.toFixed(1)} days old`);
  },
});

check({
  id: 'B6', group: 'B', desc: 'FIRMS proxy returns live fires', needsKey: 'FIRMS',
  run: async () => {
    const r = await jget('/api/firms', { timeoutMs: 60000 });
    if (!r.ok) return fail(`HTTP ${r.status}: ${r.text.slice(0, 120)}`);
    const n = r.json?.count ?? r.json?.fires?.length ?? 0;
    return n > 0
      ? pass(`${n} fires, stale=${r.json?.stale}, sources=${(r.json?.sources || []).length}`)
      : fail('0 fires from a keyed FIRMS proxy');
  },
});

check({
  id: 'B7', group: 'B', desc: 'FIRMS without a key fails HONESTLY (503 no_key, never a healthy-empty)',
  run: async () => {
    const guard = keyGuard('FIRMS', env.keys.FIRMS);
    if (guard) return guard;
    if (env.keys.FIRMS === true) return skip('server HAS a FIRMS key — the keyless path needs an unkeyed server', 'N/A');
    const r = await jget('/api/firms');
    return r.status === 503 && r.json?.error === 'no_key'
      ? pass('503 {"error":"no_key"}')
      : fail(`expected 503 no_key, got ${r.status} ${r.text.slice(0, 120)}`);
  },
});

check({
  id: 'B8', group: 'B', desc: 'AIS vessel feed is live (/api/ais-live)', needsKey: 'AIS',
  run: async () => {
    const r = await jget('/api/ais-live', { timeoutMs: 40000 });
    const rows = r.json?.rows?.length || 0;
    const status = r.json?.status;
    if (!r.ok) return fail(`HTTP ${r.status} status=${status}`);
    // Rows alone are NOT liveness. The watchdog keeps serving cached vessels
    // through stale/reconnecting/down — "the cached vessels on screen are
    // exactly what makes an outage invisible" (src/data/aisLiveVessels.js:183).
    // A live claim therefore needs status === 'live' AND rows.
    // ('open' is the pre-watchdog spelling: still accepted by the client, never
    // emitted by this server — aisWatchdog.js:72.)
    const healthy = status === 'live' || status === 'open';
    if (healthy && rows > 0) {
      return pass(`${rows} vessels, status=${status}, newest=${r.json?.newestPositionAt || 'n/a'}, silentFor=${r.json?.silentForMs ?? 'n/a'}ms`);
    }
    if (status === 'auth-failed') {
      // A rejected key is terminal and is the product's problem to report.
      return fail(`AISStream rejected the configured key (status=auth-failed, rows=${rows}) — retry is terminal (retryInSec 0)`);
    }
    if (healthy && rows === 0) {
      return skip(`status=live but 0 rows — AISStream connects open-but-silent upstream (their #23/#15); recheck when it wakes`, 'ENV');
    }
    if (['stale', 'reconnecting', 'down', 'connecting'].includes(status)) {
      // Transient/degraded is ENV only because the payload SAYS so — the
      // honesty is the evidence. rows>0 here means cached, not live.
      return skip(`feed is ${status}${rows > 0 ? ` while still serving ${rows} CACHED rows` : ''} (attempt=${r.json?.reconnectAttempt ?? 'n/a'}, nextAttemptAt=${r.json?.nextAttemptAt ?? 'n/a'}, silentFor=${r.json?.silentForMs ?? 'n/a'}ms) — surfaced honestly, but this is not a live feed`, 'ENV');
    }
    return fail(`unexpected AIS feed status "${status}" with ${rows} rows — not one of live/stale/reconnecting/down/auth-failed/connecting`);
  },
});

check({
  id: 'B9', group: 'B', desc: 'AIS without a key fails HONESTLY (503 + missing-key status, no reconnect loop)',
  run: async () => {
    const guard = keyGuard('AIS', env.keys.AIS);
    if (guard) return guard;
    if (env.keys.AIS === true) return skip('server HAS an AISStream key', 'N/A');
    const r = await jget('/api/ais-live');
    return r.status === 503 && r.json?.status === 'missing-key' && Array.isArray(r.json?.rows)
      ? pass(`503 status=missing-key, rows=[] — "${String(r.json?.error).slice(0, 60)}"`)
      : fail(`expected 503/missing-key, got ${r.status} ${r.text.slice(0, 120)}`);
  },
});

check({
  id: 'B10', group: 'B', desc: 'TomTom traffic reports LIVE mode with budget accounting', needsKey: 'TOMTOM',
  run: async () => {
    const r = await jget('/api/tomtom/status');
    if (!r.ok) return fail(`HTTP ${r.status}`);
    return r.json?.hasKey
      ? pass(`hasKey=true, used ${r.json.dailyCount}/${r.json.budget} tiles today`)
      : fail('status says hasKey=false on a server that reported a TomTom key');
  },
});

check({
  id: 'B11', group: 'B', desc: 'TomTom without a key identifies SIMULATION honestly (200 hasKey:false)',
  run: async () => {
    const guard = keyGuard('TOMTOM', env.keys.TOMTOM);
    if (guard) return guard;
    if (env.keys.TOMTOM === true) return skip('server HAS a TomTom key', 'N/A');
    const r = await jget('/api/tomtom/status');
    const tile = await jget('/api/tomtom/flow/12/1000/1600.pbf');
    return r.ok && r.json?.hasKey === false && tile.status === 503 && tile.json?.error === 'no_key'
      ? pass('status 200 hasKey:false; flow tile 503 no_key')
      : fail(`status=${r.status} hasKey=${r.json?.hasKey}; tile=${tile.status} ${tile.text.slice(0, 60)}`);
  },
});

check({
  id: 'B12', group: 'B', desc: 'CCTV source packs registered (Austin + at least one more city)',
  run: async () => {
    const r = await jget('/api/cctv/sources', { timeoutMs: 60000 });
    if (!r.ok) return fail(`HTTP ${r.status}`);
    const src = r.json?.sources || [];
    const cities = [...new Set(src.map((s) => s.cityId || s.city))];
    const austin = src.some((s) => /austin/i.test(s.cityId || s.city || ''));
    return src.length > 0 && austin && cities.length >= 2
      ? pass(`${src.length} cameras across ${cities.length} packs: ${cities.slice(0, 6).join(', ')}`)
      : fail(`${src.length} cameras, austin=${austin}, packs=${cities.join(',')}`);
  },
});

check({
  id: 'B13', group: 'B', desc: 'CCTV frame proxy returns real image bytes',
  run: async () => {
    const list = await jget('/api/cctv/sources', { timeoutMs: 60000 });
    const first = (list.json?.sources || [])[0];
    if (!first) return fail('no CCTV sources to sample');
    const res = await fetch(`${APP_URL}/api/cctv/frame/${encodeURIComponent(first.id)}`, { signal: AbortSignal.timeout(45000) });
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    return res.ok && /^image\//.test(ct) && buf.length > 512
      ? pass(`${first.id}: ${ct}, ${(buf.length / 1024).toFixed(0)} KB`)
      : fail(`HTTP ${res.status} content-type=${ct} bytes=${buf.length}`);
  },
});

check({
  id: 'B14', group: 'B', desc: 'CCTV health route answers (per-camera upstream status)',
  run: async () => {
    const r = await jget('/api/cctv/health', { timeoutMs: 45000 });
    return r.ok && Array.isArray(r.json?.cameras)
      ? pass(`cameras[]=${r.json.cameras.length} tracked`)
      : fail(`HTTP ${r.status} ${r.text.slice(0, 100)}`);
  },
});

check({
  id: 'B15', group: 'B', desc: 'Radio directory proxy returns stations (or a labelled degraded state)',
  run: async () => {
    const r = await jget('/api/radio/stations?limit=20', { timeoutMs: 45000 });
    const rows = Array.isArray(r.json) ? r.json.length : (r.json?.stations?.length || 0);
    if (r.ok && rows > 0) return pass(`${rows} stations`);
    if (r.status === 503 && r.json?.degraded) return skip(`upstream Radio Browser degraded: ${r.json.degradedReason}`, 'ENV');
    return fail(`HTTP ${r.status} rows=${rows} ${r.text.slice(0, 100)}`);
  },
});

check({
  id: 'B16', group: 'B', desc: 'Launch Library proxy returns upcoming missions',
  run: async () => {
    const r = await jget('/api/launches', { timeoutMs: 45000 });
    const n = r.json?.results?.length ?? r.json?.launches?.length ?? (Array.isArray(r.json) ? r.json.length : 0);
    if (r.ok && n > 0) return pass(`${n} launches`);
    if (r.ok) return skip('proxy up but no upcoming launches listed', 'ENV');
    return fail(`HTTP ${r.status}`);
  },
});

check({
  id: 'B17', group: 'B', desc: 'Terrain height service answers (the height-datum backbone)',
  run: async () => {
    // Contract: points="lon,lat;lon,lat;…" (longitude first).
    const r = await jget('/api/terrain/heights?points=-97.7431,30.2672', { timeoutMs: 45000 });
    if (r.status === 502) return skip(`terrain upstream unavailable and no cache: ${r.text.slice(0, 90)}`, 'ENV');
    if (!r.ok) return fail(`HTTP ${r.status} ${r.text.slice(0, 100)}`);
    const first = r.json?.results?.[0];
    return Number.isFinite(first?.elevation) && Number.isFinite(first?.geoid)
      ? pass(`Austin: elevation ${first.elevation.toFixed(1)} m, geoid ${first.geoid.toFixed(1)} m, ellipsoid ${first.ellipsoid.toFixed(1)} m`)
      : fail(`unexpected payload: ${r.text.slice(0, 120)}`);
  },
});

check({
  id: 'B18', group: 'B', desc: 'Overpass proxy answers a real query (roads, annotations, installations)',
  heavy: true,
  run: async () => {
    // Contract: a form-encoded body with exactly one bounded `data` query.
    const query = '[out:json][timeout:25];node(30.26,-97.75,30.27,-97.74)["amenity"="cafe"];out 5;';
    const res = await fetch(`${APP_URL}/api/overpass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }).toString(),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    if (res.ok && Array.isArray(json?.elements)) return pass(`${json.elements.length} elements`);
    return res.status === 502
      ? skip(`Overpass upstream unavailable: ${text.slice(0, 80)}`, 'ENV')
      : fail(`HTTP ${res.status} ${text.slice(0, 100)}`);
  },
});

check({
  id: 'B19', group: 'B', desc: 'Realtime token endpoint mints an EPHEMERAL secret and never the raw key',
  needsKey: 'OPENAI', costly: true,
  run: async () => {
    const r = await jget('/api/realtime/token', { method: 'POST', timeoutMs: 30000 });
    if (!r.ok) return fail(`HTTP ${r.status}: ${r.text.slice(0, 120)}`);
    const blob = r.text;
    if (/\bsk-[A-Za-z0-9]{20,}/.test(blob)) return fail('response contains a raw sk- key');
    return /ek_|client_secret|value/.test(blob)
      ? pass('ephemeral client secret returned; no raw key in the payload')
      : fail(`unexpected token payload: ${blob.slice(0, 120)}`);
  },
});

check({
  id: 'B20', group: 'B', desc: 'Voice without a key fails HONESTLY (503, app unaffected)',
  run: async () => {
    const guard = keyGuard('OPENAI', env.keys.OPENAI);
    if (guard) return guard;
    if (env.keys.OPENAI === true) return skip('server HAS an OpenAI key — the keyless path needs an unkeyed server', 'N/A');
    const r = await jget('/api/realtime/token', { method: 'POST' });
    return r.status === 503 && /OPENAI_API_KEY is not set/.test(r.text)
      ? pass('503 "OPENAI_API_KEY is not set"')
      : fail(`expected 503, got ${r.status} ${r.text.slice(0, 120)}`);
  },
});

check({
  id: 'B21', group: 'B', desc: 'No proxy echoes credential material back to the client (P1-5 acceptance #4)',
  run: async () => {
    const paths = ['/api/cctv/sources', '/api/tomtom/status', '/api/firms/status', '/api/celestrak/stations', '/api/ais-live'];
    const leaked = [];
    const unscannable = [];
    for (const p of paths) {
      let r;
      // A route this check could not read is a route it did not scan. Swallowing
      // the exception and still reporting "5 routes scanned" is a false PASS.
      try { r = await jget(p, { timeoutMs: 30000 }); } catch (e) {
        unscannable.push(`${p} (${String(e?.message || e).slice(0, 60)})`);
        continue;
      }
      // An error page is not a payload. Scanning five 500s and finding no key
      // is trivially true and proves nothing — a broken app must not satisfy a
      // negative assertion. The one documented exception is the keyless
      // 503 {status:'missing-key'} from /api/ais-live, which IS its real shape.
      const documentedKeyless = r.status === 503
        && (r.json?.status === 'missing-key' || r.json?.error === 'no_key' || /OPENAI_API_KEY is not set/.test(r.text));
      if (!r.ok && !documentedKeyless) {
        unscannable.push(`${p} (HTTP ${r.status})`);
        continue;
      }
      const body = r.text.slice(0, 400000);
      if (/\bsk-[A-Za-z0-9]{20,}/.test(body)) leaked.push(`${p}: sk- key`);
      if (/AIza[0-9A-Za-z_\-]{30,}/.test(body)) leaked.push(`${p}: Google key`);
      if (/(client_secret|api_?key|MAP_KEY)["']?\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}/i.test(body)) leaked.push(`${p}: key-shaped assignment`);
    }
    if (leaked.length) return fail(leaked.join('; '));
    if (unscannable.length) {
      return fail(`could not read ${unscannable.length}/${paths.length} routes, so this check cannot claim they are clean: ${unscannable.join(', ')}`);
    }
    return pass(`${paths.length} routes scanned, no credential material`);
  },
});

// ─── C · IN-BROWSER PROBES (single shared session) ────────────────────────
// These run inside runBrowserGroup(); each declares only its id/desc here so
// --list and the scoreboard stay complete.
const BROWSER_CHECKS = [
  ['C1', 'App boots: viewer + dataManager live, first paint under 60 s'],
  ['C2', 'Photorealistic 3D basemap attached (globe alive on arrival)'],
  ['C3', 'Boot produces no uncaught page errors'],
  ['C4', 'Flights layer populates with live contacts'],
  ['C5', 'Satellites layer propagates the live catalog'],
  ['C6', 'Earthquakes layer populates'],
  ['C7', 'CCTV layer populates and its frame loop is healthy'],
  ['C8', 'Vessels: live rows when keyed, honest UNAVAILABLE when not'],
  ['C9', 'Fires: live cells when keyed, honest KEY REQUIRED when not'],
  ['C10', 'Traffic: LIVE mode when keyed, clearly-labelled SIMULATION when not'],
  ['C11', 'Bundled layers render: datacenters, dams, submarine cables, installations'],
  ['C12', 'Attribution lightbox lists a credit for every enabled layer'],
  ['C13', 'Clean-UI keeps the Google/Cesium credit line visible (ToS)'],
  ['C14', 'No key material reaches browser state, URLs or storage'],
  ['C15', 'Sensor styles (CRT/NVG/FLIR) apply without moving the camera'],
  ['C16', 'Reset-to-globe control returns the camera to the global band'],
  ['C17', 'Voice surface degrades honestly without a key'],
];
for (const [id, desc] of BROWSER_CHECKS) check({ id, group: 'C', desc, browser: true });

// ─── D · EXISTING HARNESS FLEET ───────────────────────────────────────────
check({
  id: 'D1', group: 'D', desc: 'track-regression — the tracking/height-datum invariant gate (P1-7)',
  heavy: true, run: harness({ id: 'D1', script: 'track-regression.mjs', args: ['--url', APP_URL], timeoutMs: 1200000 }),
});
check({
  id: 'D2', group: 'D', desc: 'qa-heading-b3 — path-derived display heading',
  heavy: true, run: harness({ id: 'D2', script: 'qa-heading-b3.mjs', args: ['--url', APP_URL], timeoutMs: 900000 }),
});
check({
  id: 'D3', group: 'D', desc: 'qa-sprites-b5 — per-class billboard silhouettes',
  heavy: true,
  run: harness({
    id: 'D3',
    script: 'qa-sprites-b5.mjs',
    args: ['--url', APP_URL],
    timeoutMs: 900000,
    knownConditions: [{
      // Evidence-gated: only when its console assertion is the failing one AND
      // the transcript actually shows a 503. Explains, never excuses.
      when: /no console errors[\s\S]{0,300}?503/,
      note: 'not key-tolerant — its "no console errors" assertion counts the honest keyless 503s (e.g. /api/openai/hud-summary) as errors; expected to PASS on the fully keyed server. Still a FAIL here.',
    }],
  }),
});
check({
  id: 'D4', group: 'D', desc: 'qa-cctv-v2 — camera geometry, projection, ambient cards',
  heavy: true, run: harness({ id: 'D4', script: 'qa-cctv-v2.mjs', args: ['--url', APP_URL], timeoutMs: 1500000 }),
});
check({
  id: 'D5', group: 'D', desc: 'qa-failstate-b10 — fabricated upstream failures degrade honestly',
  run: harness({ id: 'D5', script: 'qa-failstate-b10.mjs', args: ['--url', APP_URL], timeoutMs: 900000 }),
});
check({
  id: 'D6', group: 'D', desc: 'qa-attribution-b12 — per-layer credits + clean/recording credit line',
  run: harness({ id: 'D6', script: 'qa-attribution-b12.mjs', args: ['--url', APP_URL], timeoutMs: 600000 }),
});
check({
  id: 'D7', group: 'D', desc: 'qa-cockpit-utility — cockpit display/radio layout readiness',
  heavy: true, parseNote: 'READY/NOT_READY',
  run: harness({
    id: 'D7',
    script: 'qa-cockpit-utility.mjs',
    parse: readCockpit,
    timeoutMs: 900000,
    knownConditions: [{
      // Narrow and evidence-gated: the console assertion is the failing one AND
      // the noise is an upstream proxy honestly reporting unavailability.
      when: /runtime console remains clean[\s\S]{0,400}?503/,
      note: 'the only failing assertion is "runtime console remains clean", and the noise is honest 503s from an upstream-backed proxy (e.g. /api/military-installations reporting "temporarily unavailable"). Environmental, but still a FAIL: re-run when the upstream recovers before filing anything.',
    }],
  }),
});
check({
  id: 'D8', group: 'D', desc: 'qa-radio — worldwide radio browse/play surface',
  heavy: true, run: harness({ id: 'D8', script: 'qa-radio.mjs', args: ['--url', APP_URL], timeoutMs: 900000 }),
});
check({
  id: 'D9', group: 'D', desc: 'qa-floor-verify — grounded contacts sit ON the rendered mesh floor',
  heavy: true,
  run: harness({
    id: 'D9',
    script: 'qa-floor-verify.mjs',
    parse: readFloorVerdict,
    timeoutMs: 600000,
    knownConditions: [],
  }),
});
check({
  id: 'D10', group: 'D', desc: 'qa-voice-routing (behavior layer) — tool behavior without model turns',
  heavy: true, run: harness({ id: 'D10', script: 'qa-voice-routing.mjs', args: ['--layer', 'behavior', '--url', APP_URL], timeoutMs: 1500000 }),
});
check({
  id: 'D11', group: 'D', desc: 'qa-firms — live fire rendering and interaction', needsKey: 'FIRMS', heavy: true,
  run: harness({ id: 'D11', script: 'qa-firms.mjs', args: ['--url', APP_URL], timeoutMs: 900000 }),
});
check({
  id: 'D12', group: 'D', desc: 'qa-overlay-baseline (submarine cables scene) — overlay/label baseline',
  heavy: true,
  run: harness({
    id: 'D12',
    script: 'qa-overlay-baseline.mjs',
    args: ['--url', APP_URL, '--scene', 'cables', '--json', OVERLAY_JSON],
    parse: readOverlaySummary('telegeography-submarine-cables', OVERLAY_JSON),
    timeoutMs: 900000,
  }),
});

// ─── M · OWNER-EYES (never automated; steps in the runbook) ───────────────
const MANUAL = [
  ['M1', 'Voice mic round trip 1/3 — "when is the next ISS pass?" (next_iss_pass)'],
  ['M2', 'Voice mic round trip 2/3 — connect/disconnect twice in one tab + keyed set_context_mode and control_cockpit'],
  ['M3', 'Voice mic round trip 3/3 — adsbdb enrichment readout on a live tracked flight'],
  ['M4', 'LAN warning path — HOST=0.0.0.0 banner, LAN URL, and a throttled response'],
  ['M5', 'Live AIS vessel one-click camera transfer — requires status=live, not cached rows (never verified against a live feed)'],
  ['M6', 'CCTV dense-city interaction — cold fill, hover, select, card removal, monitor plane, coverage, auto-hop suspend'],
  ['M7', 'Grounded + airborne tracked aircraft from 2-3 headings (DISPLAY 3D ON, non-TR-3B subject)'],
  ['M8', 'Voice analyst_query: exact unrounded count + scopeLabel, contactsWindow verbatim, follow-up re-filter'],
  ['M9', 'First-run: the arrival camera feels alive within 30 seconds'],
  ['M10', 'Sensor styles + Contacts-owned detection (DENSE/75 on activation-from-OFF; Cockpit inert; restore on deactivation)'],
  ['M11', 'Cancelled cross-mode Context switch rests on Context OFF (contextOff + priorMode, no restoration)'],
];
for (const [id, desc] of MANUAL) check({ id, group: 'M', desc, manual: true });

// ── selection ─────────────────────────────────────────────────────────────
function selected(c) {
  if (SKIP_IDS.includes(c.id)) return false;
  if (!ONLY.length) return true;
  // EXACT id or whole-group only. Prefix matching made `--only D1` quietly
  // select D10/D11/D12 as well, so a "single-check rerun" was not one.
  return ONLY.some((sel) => c.id === sel || c.group === sel);
}

// ── browser group runner ──────────────────────────────────────────────────
const BOOT_JS = () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager;

async function runBrowserGroup(record) {
  const ids = BROWSER_CHECKS.map(([id]) => id).filter((id) => selected(CHECKS.find((c) => c.id === id)));
  if (!ids.length) return;
  const emit = (id, res, ms) => { if (ids.includes(id)) record(CHECKS.find((c) => c.id === id), res, ms); };
  const only = (id) => ids.includes(id);

  const exe = (() => { try { return puppeteer.executablePath(); } catch { return null; } })();
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(exe ? { executablePath: exe } : {}),
    // Heavy layers (CCTV fleet admission, traffic road graphs) can block the
    // page's main thread past puppeteer's 180 s default and turn a healthy
    // layer into a bogus "probe threw" FAIL.
    protocolTimeout: 420000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      // C17 drives the keyless voice path, which asks for a microphone before
      // it mints a token. A fake device + auto-granted permission keeps the
      // failure under test the MISSING KEY, not a missing microphone.
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  env.browserVersion = await browser.version();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  const pageErrors = [];
  const consoleErrors = [];
  const requestUrls = [];
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('request', (r) => { requestUrls.push(r.url()); });

  // A saturated main thread (SwiftShader + ~20k entities) makes every CDP call
  // wait the full protocolTimeout — 7 minutes per call, and a check that never
  // returns never reports. Every in-page read is therefore bounded.
  //
  // evalBounded: for POLL loops — null means "nothing this tick, try again".
  const evalBounded = (fn, arg, ms = 8000) => Promise.race([
    page.evaluate(fn, arg).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), ms)),
  ]);

  // mustEval: for one-shot reads a check depends on. A deadline expiry is a
  // positively-identified condition (the page stopped answering), so the check
  // reports HARNESS-CRASH — it verified nothing. It never degrades to a pass.
  const UNRESPONSIVE = Symbol('page-unresponsive');
  const mustEval = async (fn, arg = null, ms = 30000) => {
    const outcome = await Promise.race([
      page.evaluate(fn, arg).then((value) => ({ ok: true, value }), (e) => ({ ok: false, reason: `page threw: ${String(e?.message || e).slice(0, 140)}` })),
      new Promise((r) => setTimeout(() => r({ ok: false, reason: `page did not answer within ${ms} ms`, unresponsive: UNRESPONSIVE }), ms)),
    ]);
    return outcome;
  };

  const step = async (id, fn) => {
    if (!only(id)) return null;
    const t0 = Date.now();
    try {
      const res = await fn();
      emit(id, res, Date.now() - t0);
      return res;
    } catch (e) {
      // The probe itself broke — it verified nothing, so it is a crash, not a
      // product failure.
      emit(id, crash(`probe threw, so this check verified nothing: ${String(e?.message || e).slice(0, 180)}`), Date.now() - t0);
      return null;
    }
  };

  // ── C1 boot ─────────────────────────────────────────────────────────────
  const t0 = Date.now();
  let booted = false;
  let bootNote = '';
  for (let attempt = 1; attempt <= 3 && !booted; attempt += 1) {
    try {
      await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction(BOOT_JS, { timeout: 90000, polling: 1000 });
      booted = true;
    } catch {
      // A dev server that re-optimizes deps mid-load answers 504 "Outdated
      // Optimize Dep" and the module graph never evaluates. One reload after
      // the optimizer settles clears it; three strikes is a real failure.
      const stale = consoleErrors.some((e) => /Outdated Optimize Dep|504/.test(e));
      bootNote = stale ? 'vite dep re-optimization (504) on attempt ' + attempt : `attempt ${attempt} timed out`;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const bootSec = (Date.now() - t0) / 1000;
  // The check's stated claim is "live, first paint under 60 s". Both halves are
  // asserted: globals existing is not a painted frame, and a boot that took
  // three attempts and four minutes is not a 60-second boot.
  const BOOT_BUDGET_S = 60;
  let paint = null;
  if (booted) {
    const paintR = await mustEval(async () => {
      const g = window.__godsEyeView;
      // Wait for Cesium to actually render a frame, then confirm the canvas
      // holds non-blank pixels.
      const painted = await new Promise((resolve) => {
        let done = false;
        const stop = g.viewer.scene.postRender.addEventListener(() => {
          if (done) return;
          done = true;
          setTimeout(() => { try { stop(); } catch { /* removed */ } resolve(true); }, 0);
        });
        g.viewer.scene.requestRender();
        setTimeout(() => { if (!done) { done = true; try { stop(); } catch { /* removed */ } resolve(false); } }, 20000);
      });
      const canvas = g.viewer.scene.canvas;
      return { painted, w: canvas?.width ?? 0, h: canvas?.height ?? 0, frames: g.viewer.scene.frameState?.frameNumber ?? null };
    }, null, 45000);
    paint = paintR.ok ? paintR.value : { probeError: paintR.reason };
  }
  env.boot = { ok: booted, seconds: bootSec, paint };
  const bootDetail = `viewer + dataManager live in ${bootSec.toFixed(1)} s${bootNote ? ` (after ${bootNote})` : ''}; first paint frame=${paint?.frames ?? 'n/a'} canvas=${paint?.w ?? 0}x${paint?.h ?? 0}`;
  emit('C1', (() => {
    if (!booted) return fail(`app never booted in ${bootSec.toFixed(0)} s — ${bootNote}; if 504, clear node_modules/.vite and restart the dev server`);
    if (paint?.probeError) return crash(`booted in ${bootSec.toFixed(1)} s but the first-paint probe failed: ${paint.probeError}`);
    if (!paint?.painted) return fail(`${bootDetail} — the scene never rendered a frame, so "first paint" is unproven`);
    if (!(paint.w > 0 && paint.h > 0)) return fail(`${bootDetail} — the render canvas has no size`);
    if (bootSec > BOOT_BUDGET_S) {
      return fail(`${bootDetail} — over the ${BOOT_BUDGET_S} s budget this check states${bootNote ? ` (${bootNote})` : ''}`);
    }
    return pass(bootDetail);
  })(), Date.now() - t0);

  if (!booted) {
    for (const [id] of BROWSER_CHECKS.slice(1)) {
      emit(id, skip('app did not boot — see C1', 'ENV'), 0);
    }
    await browser.close();
    return;
  }

  // Cancel the intro flyTo: it clobbers any setView issued mid-flight.
  await evalBounded(() => { try { window.__godsEyeView.viewer.camera.cancelFlight(); } catch { /* none */ } });
  await new Promise((r) => setTimeout(r, 3000));

  // Enable a layer, then poll its stats from THIS side. Polling in Node (many
  // short evaluates) instead of one long in-page loop keeps every CDP call far
  // below the protocol timeout even when a layer stalls the main thread.
  const settle = async (layerId, maxSec = 45) => {
    const enabled = (await evalBounded(async (id) => {
      const dm = window.__godsEyeView.dataManager;
      if (!dm.layers.has(id)) return { missing: true };
      try {
        // setEnabled resolves when the whole lifecycle transaction settles —
        // for a viewport-scoped layer over a huge extent that can be minutes.
        // Race it: the layer is still enabling, and the poll loop below is the
        // real observer. Blocking here just burns the CDP protocol timeout.
        await Promise.race([
          dm.setEnabled(id, true, { origin: 'user' }),
          new Promise((r) => setTimeout(r, 20000)),
        ]);
      } catch (e) { return { enableError: String(e?.message || e) }; }
      return { ok: true };
    }, layerId, 30000)) || { ok: true, enableUnconfirmed: true };
    if (enabled.missing || enabled.enableError) return enabled;

    let stats = null;
    let lifecycleState = null;
    for (let i = 0; i < maxSec; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1000));
      // eslint-disable-next-line no-await-in-loop
      const snap = await evalBounded((id) => {
        const dm = window.__godsEyeView.dataManager;
        const mod = dm.layers.get(id)?.module;
        const s = mod?.getStats ? mod.getStats() : null;
        const projected = dm.getAll().find((l) => l.id === id) || {};
        return { stats: s, lifecycleState: projected.lifecycleState, enabled: projected.enabled };
      }, layerId);
      if (!snap) continue;
      stats = snap.stats;
      lifecycleState = snap.lifecycleState;
      if (!stats) continue;
      const answered = (stats.count > 0) || stats.error;
      // Some layers (CCTV frame fill, traffic road graphs) keep `loading` true
      // long after they have data. Wait for a quiet settle for a while, then
      // accept "has data" so one progressive layer cannot eat the budget.
      if (answered && (!stats.loading || i >= Math.min(12, Math.floor(maxSec / 2)))) break;
    }
    return { stats, lifecycleState };
  };

  // The late checks (C16 reset control, C17 voice surface) make claims about
  // CONTROLS, not about layer load. By the time they run, ~20k entities and the
  // sensor-style post-processing stages have saturated the main thread hard
  // enough that a trivial read times out — honest as a CRASH, but useless as a
  // verdict. Put the stage back down first. Defined here (not inside C16) so it
  // still runs when only one of the late checks is selected.
  let quiesced = false;
  const quiesce = async () => {
    if (quiesced) return;
    quiesced = true;
    await evalBounded(async () => {
      const dm = window.__godsEyeView.dataManager;
      const heavy = ['cctv', 'traffic', 'flights', 'satellites', 'telegeography-submarine-cables',
        'local-datacenters', 'local-dams', 'military-installations', 'earthquakes'];
      for (const id of heavy) {
        if (!dm.layers.has(id)) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await Promise.race([dm.setEnabled(id, false, { origin: 'user' }), new Promise((r) => setTimeout(r, 3000))]);
        } catch { /* teardown is best-effort */ }
      }
    }, null, 45000);
    await new Promise((r) => setTimeout(r, 4000));
  };

  await step('C2', async () => {
    // The claim is PHOTOREALISTIC 3D, so an ordinary imagery layer is not
    // evidence: an OSM-only fallback would have satisfied the old OR-chain
    // while the headline feature was missing.
    const infoR = await mustEval(() => {
      const g = window.__godsEyeView;
      const prims = g.viewer.scene.primitives;
      const tilesets = [];
      for (let i = 0; i < prims.length; i += 1) {
        const prim = prims.get(i);
        if (prim?.constructor?.name !== 'Cesium3DTileset') continue;
        tilesets.push({
          url: String(prim.resource?.url || prim._url || ''),
          ready: prim.ready !== false,
          tilesLoaded: prim.tilesLoaded === true,
        });
      }
      return {
        hasTileset: !!g.tileset,
        tilesets,
        imagery: g.viewer.imageryLayers?.length ?? 0,
        mapStack: g.styleManager?.getVisualState?.()?.mapStack ?? null,
      };
    });
    if (!infoR.ok) return crash(`could not read the scene graph: ${infoR.reason}`);
    const info = infoR.value;
    const photoreal = info.tilesets.find((t) => /google|tile\.googleapis|photorealistic|3dtiles/i.test(t.url));
    if (!info.tilesets.length) {
      return fail(`no Cesium3DTileset attached (imagery layers=${info.imagery}, mapStack=${info.mapStack}) — the photorealistic globe is absent`);
    }
    if (!photoreal) {
      return fail(`a 3D tileset is attached but none resolves to Google Photorealistic tiles (urls: ${info.tilesets.map((t) => t.url.slice(0, 60) || '(no url)').join(' | ')}, mapStack=${info.mapStack})`);
    }
    if (!photoreal.ready) {
      return fail(`the photorealistic tileset is attached but not ready (mapStack=${info.mapStack})`);
    }
    return pass(`Photorealistic 3D attached and ready (mapStack=${info.mapStack}, ${info.tilesets.length} tileset(s), imagery layers=${info.imagery})`);
  });

  await step('C3', async () => (pageErrors.length === 0
    ? pass(`0 uncaught page errors (${consoleErrors.length} console errors, keyless 503s expected)`)
    : fail(`${pageErrors.length} uncaught: ${pageErrors.slice(0, 2).join(' | ')}`)));

  // Snapshot the voice surface NOW, before the layer probes below saturate the
  // main thread. C17 reports from this — a real observation, taken at a moment
  // the page can answer. (Under SwiftShader with ~20k entities up, a trivial
  // evaluate can starve for minutes.)
  const voiceSnapshotR = await mustEval(() => {
    const vc = window.__gevVoiceCommands;
    if (!vc) return { present: false };
    let diag = null;
    try { diag = vc.getDiagnostics?.(); } catch { /* never started */ }
    return { present: true, active: !!vc.isActive?.(), status: diag?.status ?? null, hasRunner: typeof vc.runner === 'function' };
  }, null, 30000);
  const voiceSnapshot = voiceSnapshotR.ok ? voiceSnapshotR.value : { probeError: voiceSnapshotR.reason };

  await step('C4', async () => {
    const r = await settle('flights', 40);
    const s = r.stats || {};
    if (!(s.count > 0)) return fail(`0 contacts (status=${s.status || ''} error=${s.error || ''})`);
    const src = String(s.source || '');
    return /adsb\.lol/i.test(src)
      ? skip(`${s.count} contacts but via the adsb.lol FALLBACK (source=${src}) — OpenSky credentials needed for the live claim`, 'OWNER-RUN')
      : pass(`${s.count} contacts, source=${src || 'OpenSky'}, stale=${!!s.stale}`);
  });

  await step('C5', async () => {
    const r = await settle('satellites', 40);
    const s = r.stats || {};
    return s.count > 0 ? pass(`${s.count} satellites, status=${s.status || 'nominal'}`) : fail(`0 satellites (status=${s.status} error=${s.error || ''})`);
  });

  await step('C6', async () => {
    const r = await settle('earthquakes', 30);
    const s = r.stats || {};
    return s.count > 0 ? pass(`${s.count} events`) : fail(`0 events (error=${s.error || ''})`);
  });

  await step('C7', async () => {
    const r = await settle('cctv', 45);
    // A camera COUNT proves registration, not that the frame loop runs. Poll
    // until ambient cards exist AND frames have actually been fetched, then
    // assert both — "healthy frame loop" is the claim, so it is the assertion.
    let ui = null;
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      ui = await evalBounded(() => {
        const st = window.__godsEyeView.dataManager.layers.get('cctv')?.module?.getUIState?.();
        return st ? { count: st.count, loading: st.loading, ambient: st.ambientCards, error: st.error } : null;
      }, null) || ui;
      if (ui && ui.count > 0 && (ui.ambient?.count || 0) > 0 && (ui.ambient?.frameFetches || 0) > 0) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, 1000));
    }
    if (!ui) return fail('cctv module exposed no UI state');
    const s = r.stats || {};
    if (!(ui.count > 0)) return fail(`0 cameras registered (error=${ui.error || s.error || 'none'})`);
    const cards = ui.ambient?.count || 0;
    const fetches = ui.ambient?.frameFetches || 0;
    if (cards === 0) return fail(`${ui.count} cameras registered but 0 ambient cards were produced — nothing is rendering`);
    if (fetches === 0) {
      return fail(`${ui.count} cameras and ${cards} ambient cards, but frameFetches=0 — the frame loop never ran, so "healthy" is unproven`);
    }
    return pass(`${ui.count} cameras, ${cards} ambient cards, ${fetches} frame fetches (${ui.ambient?.fetchMode}, ${ui.ambient?.fetchesInFlight} in flight), loading=${ui.loading?.active}`);
  });

  await step('C8', async () => {
    const guard = keyGuard('AIS', env.keys.AIS);
    if (guard) return guard;
    const r = await settle('ais-live-vessels', 30);
    const s = r.stats || {};
    // The rendered chip is the honesty claim, so read the chip. An empty layer
    // that says nothing is exactly the silent-failure this check must catch —
    // count === 0 is NOT evidence of an honest UNAVAILABLE state.
    const chipR = await mustEval(() => {
      const row = document.querySelector('[data-layer-id="ais-live-vessels"]');
      const btn = row?.querySelector('.data-toggle-btn');
      return {
        text: (btn?.textContent || '').trim(),
        feedState: btn?.dataset?.feedState || null,
        meta: (row?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      };
    });
    if (!chipR.ok) return crash(`could not read the vessels layer row: ${chipR.reason}`);
    const chip = chipR.value;
    if (!chip) return fail('no [data-layer-id="ais-live-vessels"] row in the DOM — cannot read the surfaced feed state');

    if (env.keys.AIS === false) {
      const surfaced = chip.feedState === 'unavailable' && /UNAVAILABLE/i.test(chip.text);
      if (!surfaced) {
        return fail(`keyless vessels did not SURFACE the unavailable state: chip="${chip.text}" feedState=${chip.feedState} (stats: status=${s.status} error=${s.error}) — a silently empty layer is the failure mode this check exists for`);
      }
      if (s.count > 0) return fail(`chip says UNAVAILABLE but the layer reports ${s.count} vessels`);
      return pass(`keyless and honest: chip="${chip.text}" feedState=unavailable, stats.status=${s.status}, error="${String(s.error || '').slice(0, 40)}", count=0`);
    }
    // getStats().status is ONLY ever 'unavailable' or undefined; the feed state
    // rides on transportStatus (src/data/aisLiveVessels.js:646-668). And cached
    // rows survive a degraded feed on purpose, so count > 0 is not liveness.
    const transport = s.transportStatus;
    const live = transport === 'live' || transport === 'open';
    if (live && s.count > 0) {
      // Chip vocabulary: ON / LOADING / DEGRADED / STALE / FALLBACK /
      // UNAVAILABLE (src/data/manager.js:12-19). A live feed with rows reads ON.
      return /^ON$/i.test(chip.text)
        ? pass(`${s.count} vessels live: chip="ON", transport=${transport}, lastMessage=${s.lastMessageAt || 'n/a'}`)
        : fail(`transport=${transport} with ${s.count} vessels, but the chip reads "${chip.text}" — a live feed must present as ON`);
    }
    if (transport === 'auth-failed') {
      const surfaced = /UNAVAILABLE/i.test(chip.text) && /key rejected/i.test(String(s.error || ''));
      return surfaced
        ? fail(`AISStream rejected the key — surfaced correctly (chip="${chip.text}", error="${s.error}", retryInSec=${s.retryInSec}) but a rejected key is a product-blocking failure, not an environment condition`)
        : fail(`AISStream rejected the key and the UI did not say so: chip="${chip.text}", error="${String(s.error || 'none')}"`);
    }
    if (['stale', 'reconnecting', 'down'].includes(transport)) {
      // Degraded is ENV only when it is SURFACED. Cached rows must read STALE;
      // no usable rows must read UNAVAILABLE.
      const expected = s.count > 0 ? /STALE|DEGRADED/i : /UNAVAILABLE|DEGRADED/i;
      return expected.test(chip.text)
        ? skip(`feed is ${transport}${s.count > 0 ? ` with ${s.count} CACHED vessels` : ''} and the UI says so (chip="${chip.text}", error="${String(s.error || '').slice(0, 60)}", retryInSec=${s.retryInSec}) — honest degradation, not a live feed`, 'ENV')
        : fail(`feed is ${transport} with ${s.count} vessels but the chip reads "${chip.text}" — a degraded feed that presents as healthy is exactly the invisible outage this check exists for`);
    }
    if (s.count > 0) {
      return fail(`${s.count} vessels with transport="${transport}" — neither live nor a recognised degraded state, so this cannot be called a live feed (chip="${chip.text}")`);
    }
    // Keyed but empty: honest only if the UI says so.
    return /UNAVAILABLE|LOADING|DEGRADED|STALE/i.test(chip.text)
      ? skip(`keyed but 0 vessels and the UI says so (chip="${chip.text}", transport=${transport}, error="${String(s.error || '').slice(0, 60)}") — AISStream connects open-but-silent upstream`, 'ENV')
      : fail(`keyed, 0 vessels, and the chip claims "${chip.text}" — the layer is empty without surfacing it`);
  });

  await step('C9', async () => {
    const guard = keyGuard('FIRMS', env.keys.FIRMS);
    if (guard) return guard;
    const r = await settle('local-firms', 30);
    const s = r.stats || {};
    if (env.keys.FIRMS === false) {
      return s.error === 'KEY REQUIRED'
        ? pass('keyless and honest: getStats().error === "KEY REQUIRED"')
        : fail(`keyless but error=${s.error} count=${s.count} — expected "KEY REQUIRED"`);
    }
    return s.count > 0 ? pass(`${s.count} fires, cells=${s.cells}`) : fail(`keyed but 0 fires (error=${s.error || ''})`);
  });

  await step('C10', async () => {
    // Traffic is viewport-scoped: enabling it from a global camera asks for a
    // planet-sized road graph. Put the camera over a dense city first — that
    // is also the only altitude at which "live flow" means anything.
    await evalBounded(async () => {
      const g = window.__godsEyeView;
      g.viewer.camera.cancelFlight();
      g.styleManager.applyCameraState({ lat: 30.2672, lon: -97.7431, alt: 2500, heading: 0, pitch: -40 }, 1.2);
      await new Promise((r) => setTimeout(r, 3500));
    });
    const guard = keyGuard('TOMTOM', env.keys.TOMTOM);
    if (guard) return guard;
    const r = await settle('traffic', 45);
    const s = r.stats || {};
    if (env.keys.TOMTOM === false) {
      const label = String(s.loadingLabel || '');
      return s.mode === 'sim' && /SIMULATED/i.test(label)
        ? pass(`sim mode labelled honestly: "${label.slice(0, 70)}"`)
        : fail(`mode=${s.mode} label="${label.slice(0, 70)}" — expected sim + a SIMULATED label`);
    }
    const colored = (s.flowBuckets?.free || 0) + (s.flowBuckets?.slow || 0) + (s.flowBuckets?.jam || 0);
    if (s.mode === 'live' && s.tilesFetched > 0 && colored > 0) {
      return pass(`live: ${s.flowCoveragePct}% coverage, ${s.tilesFetched} tiles, ${colored} colored dots`);
    }
    // Same discrimination C11 already makes for the bundled layers: "still
    // loading when my budget expired" is not "empty", and calling it a product
    // failure is a false accusation. The discriminator here is whether the FLOW
    // FETCH ever completed, not whether the answer was empty:
    //   · zero tiles + still fetching + no error = the request had not landed,
    //     so this check never observed live flow at all -> INCONCLUSIVE.
    //   · tiles fetched but nothing coloured = loaded and empty -> FAIL, which
    //     is the Overpass-outage signature (no road graph to colour, observed as
    //     tiles=4 colored=0) and must keep failing.
    // Narrow on purpose: it cannot absorb an empty result that actually landed.
    // (settle() breaks once the road graph answers, so the flow tiles can still
    // be in flight — that is how a full pass produced tiles=0 on a build whose
    // isolated re-run coloured 3,891 dots.)
    if (trafficFlowInconclusive(s)) {
      return crash(`traffic's flow fetch had not landed when the 45 s budget expired: tiles=0, loading=${!!s.loading}, label="${String(s.loadingLabel || '').slice(0, 40)}", road dots=${s.count ?? 0} — this check could not determine whether live flow renders, so it verified nothing`);
    }
    return fail(`mode=${s.mode} tiles=${s.tilesFetched} coverage=${s.flowCoveragePct} colored=${colored}`);
  });

  await step('C11', async () => {
    // These are GLOBAL datasets and their rendered counts are viewport-scoped.
    // C10 leaves the camera at 2,500 m over Austin, where a worldwide
    // datacenter/dam set legitimately has nothing in view — inheriting that
    // camera made this check report an empty layer that was actually fine.
    // Establish the camera this check needs instead of inheriting one.
    await evalBounded(async () => {
      const g = window.__godsEyeView;
      g.viewer.camera.cancelFlight();
      g.styleManager.applyCameraState({ lat: 20, lon: 0, alt: 14000000, heading: 0, pitch: -90 }, 1.5);
      await new Promise((r) => setTimeout(r, 4000));
    }, null, 30000);
    await new Promise((r) => setTimeout(r, 2000));

    const bundled = ['local-datacenters', 'local-dams', 'telegeography-submarine-cables'];
    const out = [];
    const stillLoading = [];
    let loadNote = '';
    for (const id of bundled) {
      // eslint-disable-next-line no-await-in-loop
      const r = await settle(id, 45);
      const s = r.stats || {};
      const label = id.replace(/^local-|^telegeography-/, '');
      out.push(`${label}=${r.missing ? 'MISSING' : (s.count ?? 0)}`);
      // "Still loading when my budget expired" is not "empty". Under full-run
      // load these can take longer than an isolated run, and calling that a
      // product failure is a false accusation — say the measurement was
      // inconclusive instead.
      if (!r.missing && !(s.count > 0) && (s.loading || s.loadingLabel) && !s.error) stillLoading.push(label);
    }
    if (stillLoading.length) {
      return crash(`still loading when the ${45}s budget expired: ${stillLoading.join(', ')} [all: ${out.join(', ')}] — this check could not determine whether they render, so it verified nothing`);
    }
    let zero = out.filter((o) => /=0$|MISSING/.test(o));
    if (zero.length) {
      // A bundled layer can read 0 while the heavy layers are live (flights,
      // CCTV, traffic) — the perf-wave budgets and scope mask legitimately
      // suppress work under load. This check claims "bundled layers render",
      // not "they render while everything else is on", and it must not guess
      // between suppression-by-budget and a real render failure. Put the stage
      // down and measure again: that is conclusive either way.
      const contested = zero.map((o) => o.split('=')[0]);
      await quiesce();
      const retried = [];
      for (const label of contested) {
        const id = bundled.find((b2) => b2.replace(/^local-|^telegeography-/, '') === label);
        if (!id) continue;
        // eslint-disable-next-line no-await-in-loop
        const r2 = await settle(id, 45);
        retried.push(`${label}=${r2.stats?.count ?? 0}`);
      }
      const stillZero = retried.filter((o) => /=0$/.test(o));
      if (stillZero.length) {
        return fail(`empty bundled layer(s) even on a quiet stage: ${stillZero.join(', ')} [under load: ${out.join(', ')}]`);
      }
      // Do NOT return here: the installations assertion below is part of this
      // check's claim and must still run.
      loadNote = ` (under load: ${out.join(', ')}; on a quiet stage: ${retried.join(', ')} — the zero reading was load-related suppression, not a render failure)`;
    }
    zero = [];

    // military-installations is named in this check's description, so it is
    // asserted — not quietly excluded. It is viewport-scoped (≤10° span,
    // src/data/militaryInstallations.js MAX_VIEWPORT_DEGREES) and returns 0
    // from a global camera, so fly to a tight box over a known base cluster
    // first, and cross-check the layer against its own API: rows from the API
    // but nothing on the map is a PRODUCT failure; nothing from either is a
    // positively-identified upstream-data condition.
    const box = { name: 'San Diego / Coronado', lat: 32.70, lon: -117.18, span: 0.6 };
    const api = await jget(`/api/military-installations?south=${(box.lat - box.span).toFixed(5)}&west=${(box.lon - box.span).toFixed(5)}&north=${(box.lat + box.span).toFixed(5)}&east=${(box.lon + box.span).toFixed(5)}`, { timeoutMs: 60000 })
      .catch((e) => ({ status: 0, json: null, text: String(e?.message || e) }));
    const apiRows = Array.isArray(api.json?.features) ? api.json.features.length
      : (Array.isArray(api.json?.elements) ? api.json.elements.length
        : (Array.isArray(api.json) ? api.json.length : null));
    // The layer gates on the camera's COMPUTED VIEW RECTANGLE (<=10 degrees,
    // MAX_VIEWPORT_DEGREES), not on the request box. An oblique camera sees to
    // the horizon and blows past that even from low altitude, so look straight
    // down: nadir at 25 km spans well under a degree.
    await evalBounded(async (b) => {
      const g = window.__godsEyeView;
      g.viewer.camera.cancelFlight();
      g.styleManager.applyCameraState({ lat: b.lat, lon: b.lon, alt: 25000, heading: 0, pitch: -90 }, 1.2);
      await new Promise((r) => setTimeout(r, 4000));
    }, box, 30000);
    // `zoom-in` is a TRANSIENT: the layer evaluates the viewport at enable time
    // and republishes after the camera settles. settle() breaks on the first
    // truthy `error`, so it latched that transient and never saw the real load.
    // Poll for a definitive outcome instead, and only then judge.
    const mi = await settle('military-installations', 5);
    let ms = mi.stats || {};
    for (let i = 0; i < 40; i += 1) {
      if (ms.count > 0) break;
      if (ms.error && !/zoom.?in/i.test(String(ms.error))) break;
      // eslint-disable-next-line no-await-in-loop
      const snap = await evalBounded(() => {
        const dm = window.__godsEyeView.dataManager;
        // Nudge the viewport-driven reload: the layer reloads on camera settle.
        try { dm.layers.get('military-installations')?.module?.refresh?.(); } catch { /* optional */ }
        return dm.layers.get('military-installations')?.module?.getStats?.() ?? null;
      }, null, 10000);
      if (snap) ms = snap;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (mi.missing) return fail(`military-installations layer is not registered [bundled: ${out.join(', ')}]`);
    if (ms.count > 0) return pass(`${out.join(', ')}, military-installations=${ms.count} over ${box.name}${loadNote}`);
    if (/zoom-in/.test(String(ms.status || ''))) {
      return fail(`military-installations refused the ${box.span * 2}° box over ${box.name} as too wide (status=${ms.status}, error="${ms.error}") — the probe camera and the layer's own ≤10° gate disagree`);
    }
    if (api.status !== 200) {
      // Distinguish an honest upstream outage from a broken route: the proxy
      // has a documented degraded shape (503 + "temporarily unavailable") for
      // when Overpass is down. That is the app degrading correctly, so it is a
      // positively identified ENV condition — anything else is a product FAIL.
      const honestOutage = api.status === 503 && /temporarily unavailable/i.test(String(api.text || ''));
      if (honestOutage) {
        return skip(`bundled layers OK (${out.join(', ')}); military-installations could not be checked — its upstream is down and the proxy says so honestly (HTTP 503 "${String(api.json?.error || '').slice(0, 60)}")`, 'ENV');
      }
      return fail(`military-installations rendered 0 and its API returned HTTP ${api.status} for ${box.name} — a responsive app failing this route is a product failure: ${String(api.text || '').slice(0, 100)}`);
    }
    if (apiRows === null) return crash(`could not read a row count from /api/military-installations to cross-check the empty layer: ${String(api.text || '').slice(0, 100)}`);
    if (apiRows > 0) {
      return fail(`/api/military-installations returned ${apiRows} features over ${box.name} but the layer rendered 0 (status=${ms.status}, error=${ms.error || 'none'}) [bundled: ${out.join(', ')}]`);
    }
    return skip(`bundled layers OK (${out.join(', ')}); military-installations rendered 0 AND its API returned 0 features over ${box.name} — positively an upstream-data condition, not a render failure`, 'ENV');
  });

  await step('C12', async () => {
    // This check reads the credits of whatever THIS run switched on. Run
    // standalone (`--only C12`) nothing is on, and it would pass vacuously off
    // the static credit list — so self-arm a deterministic set first.
    const armed = (await evalBounded(() => [...(window.__godsEyeView.dataManager.getEnabledLayerIds?.() || [])], null, 20000)) || [];
    const SELF_ARM = ['flights', 'satellites', 'earthquakes', 'telegeography-submarine-cables'];
    if (armed.length === 0) {
      for (const id of SELF_ARM) {
        // eslint-disable-next-line no-await-in-loop
        await settle(id, 25);
      }
      const nowOn = (await evalBounded(() => [...(window.__godsEyeView.dataManager.getEnabledLayerIds?.() || [])], null, 20000)) || [];
      if (nowOn.length === 0) {
        return crash('no layers are enabled and self-arming failed — this check has nothing to verify credits against');
      }
    }
    const credR = await mustEval(async () => {
      const viewer = window.__godsEyeView.viewer;
      const dm = window.__godsEyeView.dataManager;
      viewer.scene.requestRender();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const html = (viewer.creditDisplay._staticCredits || []).map((c) => c.html);
      viewer.creditDisplay.showLightbox();
      viewer.scene.requestRender();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const listCount = document.querySelector('.cesium-credit-lightbox > ul')?.children?.length || 0;
      viewer.creditDisplay.hideLightbox();
      // getEnabledLayerIds() returns a Set — spread it or it crosses the CDP
      // bridge as {}.
      return { html, listCount, enabled: [...(dm.getEnabledLayerIds?.() || [])] };
    }, null, 60000);
    if (!credR.ok) return crash(`could not read the credit display: ${credR.reason}`);
    const cred = credR.value;
    // EVERY enabled layer is checked. Filtering to a known subset meant a layer
    // outside the list — military-installations, which C11 now enables — could
    // ship with no attribution while this check claimed full coverage.
    const missing = [];
    const unmapped = [];
    const exempted = [];
    for (const id of cred.enabled) {
      const expectation = requiredCreditFor(id);
      if (!expectation) { unmapped.push(id); continue; }
      if (expectation.exempt) { exempted.push(id); continue; }
      if (!cred.html.some((h) => expectation.regex.test(h))) missing.push(id);
    }
    if (missing.length) {
      return fail(`enabled layer(s) with NO registered attribution: ${missing.join(', ')} — legal requirement (DATA_SOURCES.md, finding H11); lightbox items=${cred.listCount}`);
    }
    if (unmapped.length) {
      // Fail closed: an unmapped layer is an unchecked layer.
      return fail(`enabled layer(s) this check has no attribution expectation for: ${unmapped.join(', ')} — add them to CREDIT_EXPECTATIONS, or to CREDIT_EXEMPT_LAYERS with a reason. Until then their attribution is unverified`);
    }
    if (!(cred.listCount > 0)) return fail(`the attribution lightbox listed 0 items despite ${cred.html.length} registered credits`);
    return pass(`${cred.html.length} credits registered, lightbox lists ${cred.listCount}; all ${cred.enabled.length} enabled layers verified${exempted.length ? ` (${exempted.length} exempt: ${exempted.join(', ')})` : ''}`);
  });

  await step('C13', async () => {
    const stR = await mustEval(async () => {
      const viewer = window.__godsEyeView.viewer;
      window.__godsEyeView.styleManager.setCleanView(true);
      // Cesium paints the credit line during a render — force frames before
      // measuring, or a healthy credit reads as 0x0.
      for (let i = 0; i < 4; i += 1) {
        viewer.scene.requestRender();
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      await new Promise((r) => setTimeout(r, 1200));
      const el = document.getElementById('cesium-credits');
      const cs = el ? getComputedStyle(el) : null;
      const rect = el?.getBoundingClientRect();
      const out = {
        clean: document.body.classList.contains('ui-clean-view'),
        present: !!el,
        display: cs?.display, visibility: cs?.visibility, opacity: cs?.opacity,
        w: rect?.width, h: rect?.height,
        text: (el?.textContent || '').trim().slice(0, 80),
        hasLogo: !!el?.querySelector('.cesium-credit-logoContainer, img'),
        // The container itself can measure 0x0 while its positioned children
        // paint — report the largest child box so the number means something.
        childBox: [...(el?.querySelectorAll('*') || [])]
          .map((n) => n.getBoundingClientRect())
          .reduce((best, r) => ((r.width * r.height > best.w * best.h) ? { w: r.width, h: r.height } : best), { w: 0, h: 0 }),
      };
      window.__godsEyeView.styleManager.setCleanView(false);
      return out;
    }, null, 60000);
    if (!stR.ok) return crash(`could not measure the clean-UI credit line: ${stR.reason}`);
    const st = stR.value;
    // Same contract the shipped attribution harness pins (qa-attribution-b12):
    // not display:none, not visibility:hidden, and the expand link present.
    const visible = st.present && st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) !== 0;
    const labelled = /Data attribution/i.test(st.text) || st.hasLogo;
    const box = `${Math.round(st.w || 0)}x${Math.round(st.h || 0)} (largest child ${Math.round(st.childBox?.w || 0)}x${Math.round(st.childBox?.h || 0)})`;
    return visible && labelled && st.clean
      ? pass(`clean-UI on, #cesium-credits painted ${box} ("${st.text.slice(0, 40)}")`)
      : fail(`clean=${st.clean} present=${st.present} display=${st.display} opacity=${st.opacity} size=${st.w}x${st.h} text="${st.text.slice(0, 40)}"`);
  });

  await step('C14', async () => {
    const leaked = [];
    const inPageR = await mustEval(() => {
      const ls = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        ls[k] = String(localStorage.getItem(k)).slice(0, 200);
      }
      return { storage: JSON.stringify(ls), href: location.href };
    });
    if (!inPageR.ok) return crash(`could not read browser state for the key-leak scan: ${inPageR.reason}`);
    const inPage = inPageR.value;
    if (/\bsk-[A-Za-z0-9]{20,}/.test(inPage.storage)) leaked.push('localStorage holds an sk- key');
    if (/AIza[0-9A-Za-z_\-]{30,}/.test(inPage.storage)) leaked.push('localStorage holds a Google key');
    const keyish = requestUrls.filter((u) => u.startsWith(APP_ORIGIN) && /[?&](key|api_?key|token|client_secret)=[A-Za-z0-9_\-]{12,}/i.test(u));
    if (keyish.length) leaked.push(`${keyish.length} same-origin URL(s) carry a key query param: ${keyish[0].slice(0, 90)}`);
    return leaked.length === 0
      ? pass(`${requestUrls.length} requests + localStorage scanned, no credential material`)
      : fail(leaked.join('; '));
  });

  await step('C15', async () => {
    // CRT/NVG/FLIR are DISPLAY LABELS; the real style ids are retro /
    // surveillance / thermal (src/ui.js STYLE_STATUS_LABELS). Passing the
    // labels made every call a silent no-op that still "passed" — so assert
    // the returned visual state actually changed to the requested style.
    const wanted = [['retro', 'CRT'], ['surveillance', 'NVG'], ['thermal', 'FLIR'], ['normal', 'Normal']];
    const rR = await mustEval(async (styles) => {
      const g = window.__godsEyeView;
      const cam = g.viewer.camera;
      const before = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      const seen = [];
      for (const [style, label] of styles) {
        try {
          g.styleManager.applyVisualState({ style });
        } catch (e) { seen.push({ style, label, error: String(e?.message || e).slice(0, 80) }); continue; }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, 700));
        const vs = g.styleManager.getVisualState?.() ?? null;
        seen.push({ style, label, observed: vs?.style ?? null, activeStyle: g.styleManager.activeStyle ?? null });
      }
      const after = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      return { seen, drift: Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) };
    }, wanted, 90000);
    if (!rR.ok) return crash(`could not exercise the style presets: ${rR.reason}`);
    const r = rR.value;

    const threw = r.seen.filter((s) => s.error);
    if (threw.length) return fail(`style application threw for: ${threw.map((s) => `${s.style} (${s.error})`).join('; ')}`);
    const noop = r.seen.filter((s) => s.observed !== s.style);
    if (noop.length) {
      return fail(`style did not take effect for: ${noop.map((s) => `${s.label}/${s.style} → getVisualState().style=${s.observed}`).join('; ')} — the call was a no-op`);
    }
    if (r.seen.length !== wanted.length) return crash(`only ${r.seen.length}/${wanted.length} styles were exercised`);
    return r.drift < 1
      ? pass(`${r.seen.map((s) => `${s.label}→${s.observed}`).join(', ')} each confirmed in getVisualState(); camera drift ${r.drift.toFixed(3)} m`)
      : fail(`styles applied but the camera moved ${r.drift.toFixed(1)} m while switching`);
  });

  await step('C16', async () => {
    await quiesce();
    // L6 shipped two entry points into one release route: the map control
    // (#reset-globe-view) and the cockpit-native one (#cockpit-reset-globe).
    const foundR = await mustEval(() => {
      const el = document.getElementById('reset-globe-view');
      if (!el) return null;
      return {
        label: el.getAttribute('aria-label') || el.title || 'reset-globe-view',
        cockpitTwin: !!document.getElementById('cockpit-reset-globe'),
      };
    });
    if (!foundR.ok) return crash(`could not look for the reset-to-globe control: ${foundR.reason}`);
    const found = foundR.value;
    if (!found) return fail('#reset-globe-view is missing from the DOM (L6 shipped it)');
    // Drop to a city altitude first so "back to the globe" is a real assertion.
    // Uses the app's own camera facade rather than a Cesium global.
    //
    // BOTH the setup and the click are checked. If the setup silently failed
    // and the inherited camera happened to already be above the global
    // threshold, this check would "pass" while proving nothing about the reset
    // control at all.
    const setupR = await mustEval(async () => {
      const g = window.__godsEyeView;
      g.viewer.camera.cancelFlight();
      g.styleManager.applyCameraState({ lat: 30.2672, lon: -97.7431, alt: 3000, heading: 0, pitch: -35 }, 1.5);
      await new Promise((r) => setTimeout(r, 3000));
      return { altKm: g.viewer.camera.positionCartographic.height / 1000 };
    }, null, 60000);
    if (!setupR.ok) return crash(`could not put the camera at city altitude to test the reset: ${setupR.reason}`);
    const before = setupR.value?.altKm;
    if (!Number.isFinite(before)) return crash('the city-altitude setup returned no altitude — cannot establish a starting point');
    if (before > 5000) {
      return crash(`the camera is still at ${Math.round(before)} km after the city-altitude setup, so "returns to the global band" cannot be tested from here`);
    }
    const clickR = await mustEval(() => {
      const el = document.getElementById('reset-globe-view');
      if (!el) return { clicked: false, reason: 'control vanished before the click' };
      el.click();
      return { clicked: true };
    }, null, 45000);
    if (!clickR.ok) return crash(`could not click the reset-to-globe control: ${clickR.reason}`);
    if (!clickR.value?.clicked) return fail(`the reset control could not be clicked: ${clickR.value?.reason}`);
    let altKm = before;
    for (let i = 0; i < 15; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1000));
      // eslint-disable-next-line no-await-in-loop
      altKm = (await evalBounded(() => window.__godsEyeView.viewer.camera.positionCartographic.height / 1000, null, 20000)) ?? altKm;
      if (altKm > 5000) break;
    }
    return altKm > 5000
      ? pass(`"${found.label}" ${Math.round(before)} km → ${Math.round(altKm)} km (global band); cockpit twin present=${found.cockpitTwin}`)
      : fail(`reset left the camera at ${Math.round(altKm)} km (from ${Math.round(before)} km)`);
  });

  await step('C17', async () => {
    await quiesce();
    const v = voiceSnapshot || {};
    // The snapshot failing means this check learned nothing — not that the
    // product is wrong.
    if (v.probeError) return crash(`voice snapshot failed, so nothing was verified: ${v.probeError}`);
    if (!v.present) return fail('__gevVoiceCommands never initialised — the voice surface did not load');
    // Route through keyGuard like every other key consumer: an 'error' state
    // (status endpoint unhealthy) must FAIL, not slip into an owner-run skip.
    const guard = keyGuard('OPENAI', env.keys.OPENAI);
    if (guard) return guard;
    if (env.keys.OPENAI === true) {
      // Never start a session against a keyed server: that is a real Realtime
      // connection and it costs money. The keyless claim needs a thin server.
      return skip(`voice surface present (status=${v.status}); the keyless-degradation claim needs an UNKEYED server, and a real mic round trip is owner-run — see runbook M1-M3`, 'OWNER-RUN');
    }
    if (!v.hasRunner) return fail('voice controller present but exposes no runner');

    // Actually exercise the failure: with no key the token mint 503s, and the
    // product's job is to SAY SO. "A runner function exists" proved nothing.
    // (Free: the 503 happens before any session is created.)
    const beforeR = await mustEval(() => document.querySelectorAll('#gev-voice-control').length, null, 45000);
    if (!beforeR.ok) return crash(`could not look for the voice control: ${beforeR.reason}`);
    if (!beforeR.value) return fail('#gev-voice-control is absent — the voice surface never rendered');
    const surfacedR = await mustEval(async () => {
      const vc = window.__gevVoiceCommands;
      try { await vc.start?.(); } catch { /* the rejection is the point */ }
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        const status = document.getElementById('gev-voice-status')?.textContent?.trim() || '';
        if (status && status !== 'CONNECTING') break;
      }
      let diag = null;
      try { diag = vc.getDiagnostics?.(); } catch { /* not started */ }
      return {
        status: document.getElementById('gev-voice-status')?.textContent?.trim() || null,
        detail: document.getElementById('gev-voice-detail')?.textContent?.trim() || null,
        errorDetail: document.getElementById('gev-voice-error-detail')?.textContent?.trim() || null,
        dataStatus: document.getElementById('gev-voice-control')?.dataset?.status || null,
        recentError: diag?.recentErrors?.[0] ? { source: diag.recentErrors[0].source, message: diag.recentErrors[0].message } : null,
        appAlive: !!window.__godsEyeView?.viewer,
      };
    }, null, 60000);
    if (!surfacedR.ok) return crash(`could not drive the keyless voice path: ${surfacedR.reason}`);
    const surfaced = surfacedR.value;
    const saysKey = /OPENAI_API_KEY is not set/i.test(`${surfaced.errorDetail || ''} ${surfaced.recentError?.message || ''}`);
    const saysUnavailable = surfaced.dataStatus === 'error' || /ERROR|UNAVAILABLE/i.test(`${surfaced.status || ''} ${surfaced.detail || ''}`);
    if (!surfaced.appAlive) return fail('the app died when voice was started without a key — a missing optional key must never take the globe down');
    if (!saysUnavailable) {
      return fail(`voice start without a key left the UI at status="${surfaced.status}" detail="${surfaced.detail}" (data-status=${surfaced.dataStatus}) — the 503 never surfaced to the user`);
    }
    if (!saysKey) {
      return fail(`voice surfaced an error state (${surfaced.status}) but never named the cause: errorDetail="${surfaced.errorDetail}" recentError=${JSON.stringify(surfaced.recentError)} — expected the OPENAI_API_KEY reason`);
    }
    return pass(`keyless voice degrades honestly: status="${surfaced.status}", detail="${surfaced.detail}", reason "${surfaced.recentError?.message}"; globe still alive`);
  });

  await browser.close();
}

// ── preflight ─────────────────────────────────────────────────────────────
async function preflight() {
  // "Reachable" means the target answered AT ALL. An HTTP 500 is a responsive
  // app returning an error — a PRODUCT failure for B1 to report, never a
  // reason to skip the matrix as an environment problem. Only a refused/failed
  // connection is ENV.
  try {
    const r = await fetch(APP_URL, { signal: AbortSignal.timeout(15000) });
    env.reachable = true;
    env.shellStatus = r.status;
  } catch (e) {
    env.reachable = false;
    env.shellStatus = null;
    env.unreachableReason = String(e?.message || e).slice(0, 120);
  }
  if (!env.reachable) return;

  // Key presence is read from the server's own honest self-report — never by
  // reading a key value. "Absent" must be POSITIVELY stated by the endpoint in
  // its documented shape; an HTTP error or a malformed payload means the key
  // state is UNKNOWN ('error'), and every check that depends on it FAILS
  // rather than quietly skipping as OWNER-RUN.
  const statusKey = async (path) => {
    let r;
    try { r = await jget(path); } catch (e) {
      return CONNECTION_REFUSED_RE.test(String(e?.message || e)) ? 'error' : 'error';
    }
    if (r.status !== 200) return 'error';
    if (typeof r.json?.hasKey !== 'boolean') return 'error';
    return r.json.hasKey;
  };
  env.keys.FIRMS = await statusKey('/api/firms/status');
  env.keys.TOMTOM = await statusKey('/api/tomtom/status');
  try {
    const ais = await jget('/api/ais-live');
    if (ais.status === 503 && ais.json?.status === 'missing-key') env.keys.AIS = false;
    else if (ais.status === 200 && ais.json && Array.isArray(ais.json.rows)) env.keys.AIS = true;
    else env.keys.AIS = 'error';
  } catch { env.keys.AIS = 'error'; }
  try {
    const os = await jget('/api/opensky?lamin=29&lomin=-99&lamax=31&lomax=-97', { timeoutMs: 40000 });
    const reason = os.headers.get('X-OpenSky-Auth-Reason') || '';
    const used = os.headers.get('X-OpenSky-Auth-Mode-Used') || os.headers.get('X-OpenSky-Auth') || '';
    if (!os.ok) env.keys.OPENSKY = 'error';
    else if (/missing_.*creds|invalid_or_missing/.test(reason)) env.keys.OPENSKY = false;
    else if (/^(oauth|basic)$/.test(used)) env.keys.OPENSKY = true;
    else if (used === 'anon') env.keys.OPENSKY = false;
    else env.keys.OPENSKY = 'error';
  } catch { env.keys.OPENSKY = 'error'; }
  if (CHEAP) {
    // Minting a Realtime token is free, but --cheap promises to touch nothing
    // cost-bearing; leave OpenAI presence unknown and let its checks skip.
    env.keys.OPENAI = null;
  } else {
    try {
      const t = await jget('/api/realtime/token', { method: 'POST' });
      if (t.status === 503 && /OPENAI_API_KEY is not set/.test(t.text)) env.keys.OPENAI = false;
      else if (t.ok) env.keys.OPENAI = true;
      else env.keys.OPENAI = 'error';
    } catch { env.keys.OPENAI = 'error'; }
  }

  // A Node 24 runtime for the allocation gate (mise/nvm), if one exists.
  const mise = await sh('mise', ['ls', 'node'], { timeoutMs: 20000 });
  const m24 = /node\s+(24\.[0-9.]+)/.exec(mise.out || '');
  if (m24) {
    const where = await sh('mise', ['where', `node@${m24[1]}`], { timeoutMs: 20000 });
    const bin = resolve((where.out || '').trim(), 'bin', 'node');
    if (existsSync(bin)) env.node24 = { bin, label: `mise node@${m24[1]}` };
  }
  if (!env.node24) {
    const nvmBin = resolve(process.env.HOME || '', '.nvm/versions/node');
    if (existsSync(nvmBin)) {
      const listed = await sh('ls', [nvmBin], { timeoutMs: 20000 });
      const v24 = (listed.out || '').split('\n').map((s) => s.trim()).find((s) => /^v?24\./.test(s));
      const bin = v24 ? resolve(nvmBin, v24, 'bin', 'node') : null;
      if (bin && existsSync(bin)) env.node24 = { bin, label: `nvm ${v24}` };
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────
function keyLabel(v) { return v === true ? 'present' : v === false ? 'absent' : 'unknown'; }

async function main() {
  const started = Date.now();
  console.log(`\n${C.b('  L9 RELEASE-CANDIDATE QA MATRIX')}`);
  console.log(`  target : ${APP_URL}${CHEAP ? C.y('   [--cheap: read-only subset]') : ''}`);

  if (LIST_ONLY) {
    for (const c of CHECKS.filter(selected)) {
      console.log(`  ${c.id.padEnd(4)} ${c.group}  ${c.desc}${c.heavy ? C.d(' [heavy]') : ''}${c.needsKey ? C.d(` [needs ${c.needsKey}]`) : ''}`);
    }
    console.log(`\n  ${CHECKS.filter(selected).length} checks (${CHECKS.filter((c) => selected(c) && !c.manual).length} automated, ${CHECKS.filter((c) => selected(c) && c.manual).length} owner-run)\n`);
    return;
  }

  await preflight();
  if (!env.reachable) {
    // Positively identified as "nothing is listening" — the only case that
    // justifies aborting as an environment problem.
    console.error(C.r(`\n  Target not reachable at ${APP_URL} (${env.unreachableReason}) — start the keyed dev server first (./scripts/dev-fresh.sh).\n`));
    process.exit(2);
  }
  if (env.shellStatus >= 400) {
    console.log(C.r(`  shell  : HTTP ${env.shellStatus} — the target is RESPONDING but erroring. Running the matrix anyway; this is a product failure, not an environment one.`));
  }
  console.log(`  node   : ${process.versions.node}${env.node24 ? C.d(` (Node 24 available: ${env.node24.label})`) : ''}`);
  console.log(`  keys   : OpenSky ${keyLabel(env.keys.OPENSKY)} · FIRMS ${keyLabel(env.keys.FIRMS)} · TomTom ${keyLabel(env.keys.TOMTOM)} · AISStream ${keyLabel(env.keys.AIS)} · OpenAI ${keyLabel(env.keys.OPENAI)}`);
  console.log(C.d('  (key presence is read from each proxy\'s own status report; no key value is ever read or logged)\n'));

  const record = (c, rawRes, ms) => {
    // Validate before counting: an unrecognised verdict is a runner bug, and a
    // runner bug must never be able to leave the scoreboard green.
    const res = normalizeVerdict(rawRes);
    const row = { id: c.id, group: c.group, desc: c.desc, ...res, ms };
    results.push(row);
    const tagStr = {
      [PASS]: C.g('PASS       '),
      [PASS_SKIPS]: C.m('PASS*      '),
      [FAIL]: C.r('FAIL       '),
      [CRASH]: C.m('CRASH      '),
      [SKIP]: C.y(`SKIPPED[${res.tag}]`),
    }[res.status];
    console.log(`  ${c.id.padEnd(4)} ${tagStr} ${c.desc}`);
    if (res.detail) console.log(`       ${C.d(String(res.detail).slice(0, 300))}`);
    if (res.note) console.log(`       ${C.m(`KNOWN CONDITION: ${String(res.note).slice(0, 260)}`)}`);
  };

  const runList = CHECKS.filter(selected);

  const runSerial = async (c) => {
    if (c.manual) { record(c, skip('manual step — run with --list for its description', 'OWNER-RUN'), 0); return; }
    if (CHEAP && (c.heavy || c.costly)) { record(c, skip('heavy/cost-bearing check omitted by --cheap', 'CHEAP'), 0); return; }
    if (c.needsKey && env.keys[c.needsKey] !== true) {
      const state = env.keys[c.needsKey];
      if (state === 'error') {
        // The key-status endpoint is unhealthy on a responsive app. That is a
        // product failure, not a reason to mark the row owner-run.
        record(c, fail(`${c.needsKey} key state UNKNOWN: its status endpoint returned an error or a malformed payload on a responsive server — cannot claim the key is merely absent`), 0);
        return;
      }
      record(c, skip(`server reports no ${c.needsKey} key (${keyLabel(state)}) — run on the fully keyed server`, 'OWNER-RUN'), 0);
      return;
    }
    const t0 = Date.now();
    try {
      const res = await c.run();
      record(c, res, Date.now() - t0);
    } catch (e) {
      record(c, crash(`the check itself threw, so it verified nothing: ${String(e?.message || e).slice(0, 200)}`), Date.now() - t0);
    }
  };

  // A target that dies mid-run (a crashed dev server) otherwise turns every
  // later check into a bogus product FAIL — empty layers, "no RESULT line".
  // Re-check liveness at each group boundary and degrade honestly instead.
  // Liveness = "something answered", NOT "answered 200". A 500 keeps the run
  // going so the responsible check reports a product FAIL.
  let targetAlive = true;
  const recheckTarget = async () => {
    if (!targetAlive) return false;
    try {
      await fetch(APP_URL, { signal: AbortSignal.timeout(15000) });
      targetAlive = true;
    } catch { targetAlive = false; }
    return targetAlive;
  };
  const wrapRun = runSerial;
  const runGuarded = async (c) => {
    if (!targetAlive && c.group !== 'A' && c.group !== 'M') {
      record(c, skip(`target ${APP_URL} stopped responding mid-run — restart the dev server and re-run this group`, 'ENV'), 0);
      return;
    }
    await wrapRun(c);
  };

  // Groups run in order. Every puppeteer surface is sequential by design:
  // concurrent SwiftShader contexts produce fake failures across this fleet.
  for (const g of ['A', 'B']) {
    for (const c of runList.filter((x) => x.group === g)) await runGuarded(c);
  }

  if (runList.some((c) => c.browser)) {
    if (!(await recheckTarget())) {
      for (const c of runList.filter((x) => x.browser)) {
        record(c, skip(`target ${APP_URL} stopped responding before the browser group`, 'ENV'), 0);
      }
    } else {
      const emitted = new Set();
      const recordBrowser = (c, res, ms) => { emitted.add(c.id); record(c, res, ms); };
      try {
        await runBrowserGroup(recordBrowser);
      } catch (e) {
        // Every selected browser check must appear in the scoreboard. Recording
        // only the first one left the rest silently absent, and the totals then
        // matched results.length tautologically instead of the selected matrix.
        const why = String(e?.message || e).slice(0, 180);
        for (const c of runList.filter((x) => x.browser && !emitted.has(x.id))) {
          record(c, crash(`browser group aborted before this check could run: ${why}`), 0);
        }
      }
      for (const c of runList.filter((x) => x.browser && !emitted.has(x.id))) {
        record(c, crash('browser group finished without reporting this check'), 0);
      }
    }
  }

  await recheckTarget();
  for (const g of ['D', 'M']) {
    for (const c of runList.filter((x) => x.group === g)) await runGuarded(c);
  }

  // Any selected check that never produced a row is itself a hole.
  for (const c of runList.filter((x) => !results.some((r) => r.id === x.id))) {
    record(c, crash('the runner never executed this selected check'), 0);
  }

  // ── scoreboard ──────────────────────────────────────────────────────────
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  const byStatus = (st) => results.filter((r) => r.status === st);
  const p = byStatus(PASS).length;
  const ps = byStatus(PASS_SKIPS).length;
  const f = byStatus(FAIL).length;
  const x = byStatus(CRASH).length;
  const s = byStatus(SKIP).length;

  console.log(`\n${C.b('  ── L9 SCOREBOARD ' + '─'.repeat(52))}`);
  for (const g of ['A', 'B', 'C', 'D', 'M']) {
    const rows = results.filter((r) => r.group === g);
    if (!rows.length) continue;
    const n = (st) => rows.filter((r) => r.status === st).length;
    const name = { A: 'REPO GATES', B: 'FEED PROBES', C: 'IN-BROWSER', D: 'HARNESS FLEET', M: 'OWNER-EYES' }[g];
    console.log(`  ${g} ${name.padEnd(15)} ${C.g(`${n(PASS)} pass`)}  ${n(PASS_SKIPS) ? C.m(`${n(PASS_SKIPS)} pass*`) : '0 pass*'}  ${n(FAIL) ? C.r(`${n(FAIL)} fail`) : '0 fail'}  ${n(CRASH) ? C.m(`${n(CRASH)} crash`) : '0 crash'}  ${C.y(`${n(SKIP)} skipped`)}   (${rows.length})`);
  }
  console.log(`  ${'─'.repeat(68)}`);
  console.log(`  ${C.b('TOTAL')}  ${C.g(`${p} PASS`)}  ${ps ? C.m(`${ps} PASS-WITH-SKIPS`) : '0 PASS-WITH-SKIPS'}  ${f ? C.r(`${f} FAIL`) : '0 FAIL'}  ${x ? C.m(`${x} HARNESS-CRASH`) : '0 HARNESS-CRASH'}  ${C.y(`${s} SKIPPED`)}  of ${runList.length} selected   ${C.d(`${mins} min wall clock`)}`);
  const green = f === 0 && x === 0 && ps === 0;
  console.log(`  ${green ? C.g('GREEN — every selected check either verified its claim or honestly skipped.')
    : C.r('NOT GREEN — a fully green L9 run requires 0 FAIL, 0 HARNESS-CRASH and 0 PASS-WITH-SKIPS.')}`);

  if (f) {
    console.log(`\n  ${C.r('FAILURES — the product is wrong')}`);
    for (const r of byStatus(FAIL)) console.log(`   ${r.id}  ${r.desc}\n        ${C.d(String(r.detail).slice(0, 300))}`);
  }
  if (x) {
    console.log(`\n  ${C.m('HARNESS-CRASH — the check itself broke; it verified NOTHING')}`);
    for (const r of byStatus(CRASH)) console.log(`   ${r.id}  ${r.desc}\n        ${C.d(String(r.detail).slice(0, 300))}`);
  }
  if (ps) {
    console.log(`\n  ${C.m('PASS-WITH-SKIPS — green, but assertions were left unrun')}`);
    for (const r of byStatus(PASS_SKIPS)) console.log(`   ${r.id}  ${r.desc}\n        ${C.d(String(r.detail).slice(0, 300))}`);
  }
  const ownerRun = byStatus(SKIP).filter((r) => r.tag === 'OWNER-RUN');
  if (ownerRun.length) {
    console.log(`\n  ${C.y('STILL OWED BY THE OWNER RUN')} (${ownerRun.length})`);
    for (const r of ownerRun) console.log(`   ${r.id}  ${r.desc}`);
  }
  const envSkips = byStatus(SKIP).filter((r) => r.tag !== 'OWNER-RUN');
  if (envSkips.length) {
    console.log(`\n  ${C.d(`environment/N-A/cheap skips (${envSkips.length}): ${envSkips.map((r) => r.id).join(', ')}`)}`);
  }
  console.log('');

  if (JSON_OUT) {
    writeFileSync(resolve(process.cwd(), JSON_OUT), JSON.stringify({
      target: APP_URL, startedAt: new Date(started).toISOString(), minutes: Number(mins),
      node: process.versions.node, browser: env.browserVersion, keys: env.keys,
      shellStatus: env.shellStatus, green,
      totals: { pass: p, passWithSkips: ps, fail: f, harnessCrash: x, skipped: s, selected: runList.length },
      results,
    }, null, 2));
    console.log(`  JSON: ${resolve(process.cwd(), JSON_OUT)}\n`);
  }

  // A crashed check verified nothing — it must not exit green.
  process.exit(f > 0 || x > 0 ? 1 : 0);
}

// Run only when invoked directly, so the pure verdict logic above can be
// imported and pinned by the unit suite (mirrors scripts/run-unit-tests.mjs).
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((e) => {
    console.error(C.r(`\n  qa-l9-matrix crashed: ${e?.stack || e}\n`));
    process.exit(1);
  });
}

export {
  PASS, PASS_SKIPS, FAIL, CRASH, SKIP, OUTCOMES,
  normalizeVerdict, classifyNoScoreboard, readResultLine, readCockpit, satisfiesEngines,
  isCalibratedAllocationRuntime, trafficFlowInconclusive,
  soleVerdict, RESULT_RE, COCKPIT_RE, FLOOR_RE,
  readFloorVerdict, keyGuard, applyKnownConditions, requiredCreditFor,
  CREDIT_EXPECTATIONS, CREDIT_EXEMPT_LAYERS,
};
