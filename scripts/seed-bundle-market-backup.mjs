#!/usr/bin/env node
import { runBundle, MIN } from './_bundle-runner.mjs';

await runBundle('market-backup', [
  { label: 'Crypto-Quotes', script: 'seed-crypto-quotes.mjs', seedMetaKey: 'market:crypto', canonicalKey: 'market:crypto:v1', intervalMs: 5 * MIN, timeoutMs: 120_000 },
  { label: 'Hyperliquid-Flow', script: 'seed-hyperliquid-flow.mjs', seedMetaKey: 'market:hyperliquid-flow', canonicalKey: 'market:hyperliquid:flow:v1', intervalMs: 5 * MIN, timeoutMs: 60_000 },
  { label: 'Stablecoin-Markets', script: 'seed-stablecoin-markets.mjs', seedMetaKey: 'market:stablecoins', canonicalKey: 'market:stablecoins:v1', intervalMs: 10 * MIN, timeoutMs: 120_000 },
  { label: 'ETF-Flows', script: 'seed-etf-flows.mjs', seedMetaKey: 'market:etf-flows', canonicalKey: 'market:etf-flows:v1', intervalMs: 15 * MIN, timeoutMs: 120_000 },
  { label: 'Gulf-Quotes', script: 'seed-gulf-quotes.mjs', seedMetaKey: 'market:gulf-quotes', canonicalKey: 'market:gulf-quotes:v1', intervalMs: 10 * MIN, timeoutMs: 120_000 },
  { label: 'Token-Panels', script: 'seed-token-panels.mjs', seedMetaKey: 'market:token-panels', canonicalKey: 'market:defi-tokens:v1', intervalMs: 30 * MIN, timeoutMs: 120_000 },
  // SPDR GLD publishes holdings once daily (~16:30 ET). 2h cadence = retries on Cloudflare blocks + catches late publish.
  { label: 'Gold-ETF-Flows', script: 'seed-gold-etf-flows.mjs', seedMetaKey: 'market:gold-etf-flows', canonicalKey: 'market:gold-etf-flows:v1', intervalMs: 120 * MIN, timeoutMs: 60_000 },
  // IMF IFS publishes monthly with ~2-3 month lag. Daily cadence is plenty.
  { label: 'Gold-CB-Reserves', script: 'seed-gold-cb-reserves.mjs', seedMetaKey: 'market:gold-cb-reserves', canonicalKey: 'market:gold-cb-reserves:v1', intervalMs: 24 * 60 * MIN, timeoutMs: 180_000 },
]);
