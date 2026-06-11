#!/usr/bin/env node
/**
 * 🛰️ US Edge Probe — sees what US users actually receive from the CDN edge,
 * and reports to Slack. (Its sibling, "⚡ Origin Monitor" in api/_slack.js,
 * watches from inside the API; this one watches from outside, from the US.)
 *
 * Vercel's cache is per-PoP (iad1/cle1/sfo1/pdx1 in the US), so the only way
 * to see the payload a US user gets — including region-local stale/degraded
 * copies — is to request from US vantage points. Uses the Globalping API
 * (real probes in US cities) replicating an iOS client byte-for-byte (no
 * Origin header + the bundled X-WorldMonitor-Key), plus one direct full-body
 * fetch for exact item counts and the bootstrap `missing:[]` list
 * (Globalping truncates bodies at ~10 KB).
 *
 * US verification — every Globalping result is only counted as "US-verified"
 * when BOTH are true:
 *   1. the probe's own geo is country=US (Globalping metadata), AND
 *   2. the response's `x-vercel-id` names a US PoP (iad1/cle1/sfo1/pdx1) —
 *      i.e. the answer really came out of a US edge cache.
 * If fewer than MIN_US_VERIFIED results pass both checks, the run flags
 * "US coverage not assured" — so a green run always means "verified from
 * the US", never "probes landed somewhere convenient".
 *
 * Usage:
 *   WM_PROBE_KEY=<key> node scripts/probe-us-edge.mjs [av] [--summary]
 *
 * Modes:
 *   default    — alert mode: posts to Slack ONLY when something is wrong
 *                (5xx, 401/403, EMPTY items, no-store partial, US coverage
 *                not assured) and exits 1.
 *   --summary  — posts the full live-situation report to Slack regardless
 *                (the daily heartbeat, scheduled at 17:00 UTC =
 *                13:00 ET / 10:00 PT — busy US daytime — = 20:00 TRT).
 *
 * Env:
 *   WM_PROBE_KEY               required — the iOS-bundled key (APIConfig.swift)
 *   WM_SLACK_ALERT_WEBHOOK     optional — Slack incoming webhook; absent = stdout only
 *   GLOBALPING_TOKEN           optional — raises Globalping rate limits
 *   UPSTASH_REDIS_REST_URL/_TOKEN  optional — enables the one-time Slack
 *                              self-introduction marker (SET NX, once ever)
 */

const KEY = process.env.WM_PROBE_KEY;
if (!KEY) {
  console.error('Set WM_PROBE_KEY (the iOS-bundled key from APIConfig.swift, or any valid key).');
  process.exit(1);
}
const args = process.argv.slice(2);
const SUMMARY = args.includes('--summary');
const AV = args.find((a) => !a.startsWith('--')) || '2.2';
const WEBHOOK = process.env.WM_SLACK_ALERT_WEBHOOK;
const GP_TOKEN = process.env.GLOBALPING_TOKEN;

const SENDER = '🛰️ *US Edge Probe* (GitHub Actions · Globalping)';
const BASE = 'https://www.worldmonitor.news';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** Vercel US PoPs — a response is only "from the US edge" if served by one. */
const US_POPS = new Set(['iad1', 'cle1', 'sfo1', 'pdx1']);
/** Minimum both-checks-passed results for the run to count as US-assured. */
const MIN_US_VERIFIED = 2;

const targets = [
  { path: '/api/bootstrap', query: 'tier=fast', label: 'bootstrap fast' },
  { path: '/api/bootstrap', query: 'tier=slow', label: 'bootstrap slow' },
  { path: '/api/live-news/v6/list-us-headlines', query: `av=${AV}`, label: 'live-news v6' },
  { path: '/api/intel-news/v6/list', query: `av=${AV}`, label: 'intel-news v6' },
  { path: '/api/conflict-archive/v5/list', query: `av=${AV}`, label: 'conflict v5' },
  { path: '/api/world-brief/v1/get-region', query: 'regionId=levant', label: 'brief levant' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
let usVerifiedCount = 0;
const usPopsSeen = new Set();

function pop(headers) {
  return (headers['x-vercel-id'] || '-').split('::')[0];
}

// ── Direct full-body pass (exact item counts + bootstrap missing[]) ────────
async function directCheck(t) {
  try {
    const resp = await fetch(`${BASE}${t.path}?${t.query}`, {
      headers: { 'User-Agent': UA, 'X-WorldMonitor-Key': KEY },
      signal: AbortSignal.timeout(30_000),
    });
    const cc = resp.headers.get('cache-control') || '-';
    const vc = resp.headers.get('x-vercel-cache') || '-';
    const servedBy = (resp.headers.get('x-vercel-id') || '-').split('::')[0];
    let detail = '';
    let ok = resp.ok;
    if (resp.ok) {
      const body = await resp.json().catch(() => null);
      if (body?.items) {
        detail = `${body.items.length} items`;
        if (body.items.length === 0) { problems.push(`${t.label}: EMPTY items[]`); ok = false; }
      } else if (body?.data) {
        const present = Object.keys(body.data).length;
        const missing = body.missing || [];
        detail = `${present}/${present + missing.length} sections${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`;
        // The origin is the single source of truth on which keys matter to
        // mobile: it returns no-store ONLY when mobile-relevant keys are
        // missing (web-only gaps stay cacheable). So bootstrap health is
        // judged by Cache-Control below; the missing list here is info.
      } else if (body?.generatedAt) {
        const ageMin = Math.round((Date.now() - body.generatedAt) / 60_000);
        detail = `brief ${ageMin} min old`;
        if (ageMin > 180) { problems.push(`${t.label}: brief is ${ageMin} min old (cron stalled?)`); ok = false; }
      }
      // no-store is always alert-worthy: on a feed it means empty/failed,
      // on bootstrap the origin only emits it for MOBILE-relevant gaps
      // (web-only gaps stay cacheable and never reach this branch).
      if (cc.includes('no-store')) {
        ok = false;
        problems.push(`${t.label}: 200 but no-store (mobile-relevant data missing; CDN copy not refreshing)`);
      }
      // Last-known-good fallback active: users get populated-but-stale data
      // (origin's live path is failing). Looks healthy in every other signal
      // — the header is the only tell, so it must alert.
      const ds = resp.headers.get('x-wm-data-source');
      if (ds) {
        ok = false;
        problems.push(`${t.label}: serving LAST-KNOWN-GOOD fallback (${ds}) — live data path is failing`);
      }
    } else {
      problems.push(`${t.label}: HTTP ${resp.status}${resp.status === 401 ? ' — BUNDLED KEY INVALID?' : ''}`);
    }
    console.log(`  [direct ${servedBy}] HTTP ${resp.status} | vc=${vc} | cc="${cc.slice(0, 55)}" | ${detail}`);
    return { kind: 'direct', status: resp.status, cc, vc, pop: servedBy, detail, ok };
  } catch (err) {
    problems.push(`${t.label}: direct fetch failed (${err.message})`);
    console.log(`  [direct] FETCH FAILED: ${err.message}`);
    return { kind: 'direct', status: 0, detail: err.message, ok: false };
  }
}

// ── Globalping multi-PoP US pass ───────────────────────────────────────────
async function gpLaunch(t) {
  const headers = { 'Content-Type': 'application/json' };
  if (GP_TOKEN) headers.Authorization = `Bearer ${GP_TOKEN}`;
  try {
    const resp = await fetch('https://api.globalping.io/v1/measurements', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'http',
        target: 'www.worldmonitor.news',
        locations: [{ city: 'Ashburn', limit: 1 }, { city: 'San Francisco', limit: 1 }, { city: 'Dallas', limit: 1 }],
        measurementOptions: {
          protocol: 'HTTPS',
          request: { method: 'GET', path: t.path, query: t.query, headers: { 'User-Agent': UA, 'X-WorldMonitor-Key': KEY } },
        },
      }),
    });
    const j = await resp.json().catch(() => ({}));
    if (!j.id) console.log(`  [globalping] launch failed: ${JSON.stringify(j).slice(0, 150)}`);
    return j.id || null;
  } catch (err) {
    console.log(`  [globalping] launch error: ${err.message}`);
    return null;
  }
}

async function gpCollect(id) {
  for (let i = 0; i < 20; i++) {
    const r = await (await fetch(`https://api.globalping.io/v1/measurements/${id}`)).json();
    if (r.status === 'finished') return r;
    await sleep(2000);
  }
  return null;
}

function gpDescribe(body) {
  if (!body) return 'empty body';
  if (body.includes('"items":[]')) return 'EMPTY items[]';
  if (/"items":\s*\[\s*\{/.test(body)) return 'items populated';
  if (/^\s*\{"data":/.test(body)) return 'bootstrap data';
  if (/"generatedAt"/.test(body)) return 'brief payload';
  return 'body: ' + body.slice(0, 60).replace(/\s+/g, ' ');
}

async function gpReport(t, id) {
  if (!id) return [];
  const m = await gpCollect(id);
  if (!m) { console.log('  [globalping] timed out'); return []; }
  const rows = [];
  for (const r of m.results) {
    const h = r.result.headers || {};
    const body = r.result.rawBody || '';
    const desc = gpDescribe(body);
    const status = r.result.statusCode;
    const servedBy = pop(h);
    const probeUS = r.probe.country === 'US';
    const popUS = US_POPS.has(servedBy);
    const usVerified = probeUS && popUS;
    if (usVerified) { usVerifiedCount++; usPopsSeen.add(servedBy); }
    if (status >= 500) problems.push(`${t.label}: HTTP ${status} from ${r.probe.city}${usVerified ? ' (US-verified)' : ''}`);
    if (status === 401 || status === 403) problems.push(`${t.label}: HTTP ${status} from ${r.probe.city} — key/UA rejected`);
    if (desc === 'EMPTY items[]') problems.push(`${t.label}: EMPTY items[] seen from ${r.probe.city}${usVerified ? ' (US-verified)' : ''}`);
    console.log(
      `  ${r.probe.city.padEnd(14)} ${usVerified ? '🇺🇸' : `(${r.probe.country}→${servedBy})`} ` +
      `HTTP ${status} | vc=${h['x-vercel-cache'] || '-'} age=${h['age'] || '-'} pop=${servedBy} | ` +
      `cc="${(h['cache-control'] || '-').slice(0, 45)}" | ${desc}`,
    );
    rows.push({ city: r.probe.city, status, vc: h['x-vercel-cache'] || '-', age: h['age'] || '-', pop: servedBy, usVerified, desc });
  }
  return rows;
}

// ── Slack ──────────────────────────────────────────────────────────────────
async function postSlack(text) {
  if (!WEBHOOK) { console.log('\n(no WM_SLACK_ALERT_WEBHOOK — skipping Slack post)'); return; }
  try {
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error('slack post failed:', err.message);
  }
}

/** One-time self-introduction (Redis SET NX marker — once ever). */
async function introduceOnce() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!WEBHOOK || !url || !token) return;
  try {
    const resp = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', 'slack:intro:us-edge-probe:v1', '1', 'NX']]),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data?.[0]?.result === null) return; // already introduced
  } catch { return; }
  await postSlack(
    `${SENDER} is now live. 👋\n` +
    `I run from GitHub Actions every 15 min and check the app's backbone endpoints *from real US vantage points* (Ashburn, San Francisco, Dallas via Globalping) — replicating an iOS user byte-for-byte, bundled key included.\n` +
    `• Alert mode (every 15 min): I post here ONLY when something is wrong — 5xx, 401, empty items, partial \`no-store\` bootstrap, or when I can't verify US coverage.\n` +
    `• Summary mode (daily at 13:00 ET / 10:00 PT = 20:00 TRT): full live-situation report even when everything is green, captured while both US coasts are active.\n` +
    `Every result is *US-verified* only when the probe is geo-located in the US AND the response came from a US Vercel PoP (iad1/cle1/sfo1/pdx1) — check the 🇺🇸 marks.\n` +
    `My sibling ⚡ *Origin Monitor* watches the same endpoints from inside the API and fires the instant a non-cacheable response is emitted.`,
  );
}

// ── Run ────────────────────────────────────────────────────────────────────
await introduceOnce();

const launched = [];
for (const t of targets) {
  launched.push({ t, id: await gpLaunch(t) });
  await sleep(500);
}

const report = [];
for (const { t, id } of launched) {
  console.log(`\n### ${t.label} — ${t.path}?${t.query}`);
  const direct = await directCheck(t);
  const gp = await gpReport(t, id);
  report.push({ t, direct, gp });
}

if (usVerifiedCount < MIN_US_VERIFIED) {
  problems.push(`US coverage NOT assured — only ${usVerifiedCount} US-verified result(s) this run (need ≥${MIN_US_VERIFIED}); results may not reflect US users`);
}

const dedupedProblems = [...new Set(problems)];

// Pretty per-endpoint summary lines for Slack.
function endpointLine({ t, direct, gp }) {
  const gpUS = gp.filter((r) => r.usVerified);
  const worst = Math.max(direct.status, ...gp.map((r) => r.status), 0);
  const anyEmpty = gp.some((r) => r.desc === 'EMPTY items[]');
  const emoji = worst >= 400 || anyEmpty ? '🔴' : direct.ok === false ? '🟠' : '✅';
  const cache = direct.cc?.includes('no-store') ? 'no-store ⚠️' : direct.vc || '-';
  const usBit = gpUS.length
    ? `🇺🇸 ${gpUS.length}/${gp.length} US-verified (${[...new Set(gpUS.map((r) => r.pop))].join(', ')})`
    : gp.length ? '⚠️ no US-verified result' : 'no probe data';
  return `${emoji} *${t.label}* — HTTP ${direct.status} · ${direct.detail || '-'} · cache: ${cache} · ${usBit}`;
}

const coverage = `*US coverage:* ${usVerifiedCount} US-verified results across ${usPopsSeen.size} US PoP(s)${usPopsSeen.size ? ` (${[...usPopsSeen].join(', ')})` : ''}`;
const stamp = `_av=${AV} · ${new Date().toISOString().slice(0, 16)}Z_`;

if (SUMMARY) {
  const headline = dedupedProblems.length === 0
    ? `${SENDER}\n*Daily edge report — ✅ all healthy from the US*`
    : `${SENDER}\n*Daily edge report — ⚠️ ${dedupedProblems.length} issue(s)*`;
  const body = report.map(endpointLine).join('\n');
  const issueBlock = dedupedProblems.length ? `\n*Issues:*\n• ${dedupedProblems.join('\n• ')}` : '';
  await postSlack(`${headline}\n\n${body}\n\n${coverage}${issueBlock}\n${stamp}`);
} else if (dedupedProblems.length > 0) {
  const body = report.map(endpointLine).join('\n');
  await postSlack(
    `${SENDER}\n*🔴 ${dedupedProblems.length} issue(s) detected from US vantage:*\n• ${dedupedProblems.join('\n• ')}\n\n${body}\n\n${coverage}\n${stamp}`,
  );
}

if (dedupedProblems.length > 0) {
  console.error(`\n${dedupedProblems.length} problem(s) detected.`);
  process.exit(SUMMARY ? 0 : 1);
}
console.log(`\nAll healthy. ${usVerifiedCount} US-verified results (${[...usPopsSeen].join(', ')}).`);
