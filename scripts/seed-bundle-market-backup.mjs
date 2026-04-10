#!/usr/bin/env node
import { runBundle, MIN } from './_bundle-runner.mjs';

await runBundle('market-backup', [
  { label: 'Crypto-Quotes', script: 'seed-crypto-quotes.mjs', seedMetaKey: 'market:crypto', intervalMs: 5 * MIN, timeoutMs: 120_000 },
  { label: 'Stablecoin-Markets', script: 'seed-stablecoin-markets.mjs', seedMetaKey: 'market:stablecoins', intervalMs: 10 * MIN, timeoutMs: 120_000 },
  { label: 'ETF-Flows', script: 'seed-etf-flows.mjs', seedMetaKey: 'market:etf-flows', intervalMs: 15 * MIN, timeoutMs: 120_000 },
  { label: 'Gulf-Quotes', script: 'seed-gulf-quotes.mjs', seedMetaKey: 'market:gulf-quotes', intervalMs: 10 * MIN, timeoutMs: 120_000 },
  { label: 'Token-Panels', script: 'seed-token-panels.mjs', seedMetaKey: 'market:token-panels', intervalMs: 30 * MIN, timeoutMs: 120_000 },
]);
