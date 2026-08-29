#!/usr/bin/env node
//
// AALICE:OpenEYE — USA-vs-CHINA bloc alignment seeder (fork-side, AMD-003).
//
// Scores every country by which bloc's equity market its own market co-moves
// with, and records the recent abnormal-return series used to answer "how did
// this country actually react to that bloc event".
//
// Output is a static JSON artifact under `data-live/`, mounted into the
// container's web root and served same-origin by the SPA catch-all (which sets
// no-cache). That deliberately avoids the proto/RPC path: this is one small
// daily file, not a live query surface, and adding a codegen'd endpoint for it
// would be far more machinery than the data warrants.
//
// Usage:  node scripts/seed-bloc-markets.mjs [--force]

import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile, sleep } from './_seed-utils.mjs';
import { fetchYahooJson } from './_yahoo-fetch.mjs';
import { logReturns, scoreCountry } from './_bloc-math.mjs';

loadEnvFile(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT, 'data-live', 'bloc-lean.json');

const US_LEG = process.env.BLOC_US_LEG || 'XLK';   // US tech sector
const CN_LEG = process.env.BLOC_CN_LEG || 'KWEB';  // China internet/tech
const RANGE = '1y';
const YAHOO_DELAY_MS = 250;
const RESEED_GATE_MS = 20 * 60 * 60 * 1000; // daily data; don't refetch every cron tick
const FORCE = process.argv.includes('--force') || process.env.FORCE_RESEED === 'true';

// The two poles are not scored — they ARE the legs. Everyone else is measured
// against them. ISO2 codes match the `ISO3166-1-Alpha-2` property on the map's
// country geometry.
const POLES = { US: 'us', CN: 'cn' };

const COUNTRIES = [
  ['JP', 'Japan', 'EWJ'], ['KR', 'South Korea', 'EWY'], ['TW', 'Taiwan', 'EWT'],
  ['IN', 'India', 'INDA'], ['HK', 'Hong Kong', 'EWH'], ['SG', 'Singapore', 'EWS'],
  ['MY', 'Malaysia', 'EWM'], ['TH', 'Thailand', 'THD'], ['ID', 'Indonesia', 'EIDO'],
  ['PH', 'Philippines', 'EPHE'], ['VN', 'Vietnam', 'VNM'], ['AU', 'Australia', 'EWA'],
  ['NZ', 'New Zealand', 'ENZL'],
  ['DE', 'Germany', 'EWG'], ['GB', 'United Kingdom', 'EWU'], ['FR', 'France', 'EWQ'],
  ['IT', 'Italy', 'EWI'], ['ES', 'Spain', 'EWP'], ['NL', 'Netherlands', 'EWN'],
  ['CH', 'Switzerland', 'EWL'], ['SE', 'Sweden', 'EWD'], ['BE', 'Belgium', 'EWK'],
  ['AT', 'Austria', 'EWO'], ['IE', 'Ireland', 'EIRL'], ['NO', 'Norway', 'ENOR'],
  ['DK', 'Denmark', 'EDEN'], ['FI', 'Finland', 'EFNL'], ['PL', 'Poland', 'EPOL'],
  ['GR', 'Greece', 'GREK'], ['TR', 'Turkey', 'TUR'],
  ['IL', 'Israel', 'EIS'], ['SA', 'Saudi Arabia', 'KSA'], ['AE', 'United Arab Emirates', 'UAE'],
  ['QA', 'Qatar', 'QAT'], ['ZA', 'South Africa', 'EZA'],
  ['CA', 'Canada', 'EWC'], ['MX', 'Mexico', 'EWW'], ['BR', 'Brazil', 'EWZ'],
  ['CL', 'Chile', 'ECH'], ['PE', 'Peru', 'EPU'], ['CO', 'Colombia', 'GXG'],
  ['AR', 'Argentina', 'ARGT'],
];

async function fetchBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${RANGE}&interval=1d`;
  const chart = await fetchYahooJson(url, { label: symbol });
  const result = chart?.chart?.result?.[0];
  if (!result) throw new Error('no chart result');
  const ts = result.timestamp;
  const ind = result.indicators;
  const closes = ind?.adjclose?.[0]?.adjclose ?? ind?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) throw new Error('no series');
  return logReturns(ts, closes);
}

function isFresh() {
  if (FORCE) return false;
  try {
    return Date.now() - statSync(OUT_FILE).mtimeMs < RESEED_GATE_MS;
  } catch {
    return false;
  }
}

async function main() {
  if (isFresh()) {
    console.log(`  bloc-lean.json is under ${RESEED_GATE_MS / 3600000}h old — skipping (use --force to override)`);
    return;
  }

  console.log(`=== bloc alignment: ${US_LEG} (US) vs ${CN_LEG} (CN) ===`);

  const legs = {};
  for (const sym of [US_LEG, CN_LEG]) {
    legs[sym] = await fetchBars(sym);
    console.log(`  leg ${sym}: ${legs[sym].size} sessions`);
    await sleep(YAHOO_DELAY_MS);
  }
  if (legs[US_LEG].size < 60 || legs[CN_LEG].size < 60) {
    throw new Error('bloc legs returned too little history to fit against');
  }

  const countries = [];
  const skipped = [];
  for (const [iso2, name, symbol] of COUNTRIES) {
    try {
      const returns = await fetchBars(symbol);
      const score = scoreCountry(returns, legs[US_LEG], legs[CN_LEG]);
      if (!score) {
        skipped.push(`${symbol} (unfittable)`);
      } else {
        const last = score.recentAr[score.recentAr.length - 1];
        countries.push({
          iso2, name, symbol,
          betaUs: round(score.betaUs), betaCn: round(score.betaCn),
          lean: round(score.lean), r2: round(score.r2),
          obs: score.obs, arSigma: round(score.arSigma, 6),
          lastAr: round(last?.ar ?? 0, 6), lastArT: last?.t ?? 0,
          recentAr: score.recentAr.map((a) => ({ t: a.t, ar: round(a.ar, 6) })),
        });
        const tilt = score.lean < -0.05 ? 'US' : score.lean > 0.05 ? 'CN' : '--';
        console.log(`  ${iso2} ${symbol.padEnd(5)} lean ${fmt(score.lean)} r2 ${score.r2.toFixed(2)}  ${tilt}`);
      }
    } catch (err) {
      skipped.push(`${symbol} (${err.message})`);
    }
    await sleep(YAHOO_DELAY_MS);
  }

  if (countries.length < 20) {
    throw new Error(`only ${countries.length} countries scored — refusing to publish a half-empty map`);
  }

  const payload = {
    generatedAtMs: Date.now(),
    usLeg: US_LEG,
    cnLeg: CN_LEG,
    range: RANGE,
    windowSessions: legs[US_LEG].size,
    poles: POLES,
    countries: countries.sort((a, b) => a.lean - b.lean),
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(payload));
  console.log(`\n=== Done: ${countries.length} countries scored, ${skipped.length} skipped ===`);
  if (skipped.length) console.log(`  skipped: ${skipped.join(', ')}`);
}

const round = (v, dp = 4) => Number.isFinite(v) ? Number(v.toFixed(dp)) : 0;
const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(3);

main().catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
