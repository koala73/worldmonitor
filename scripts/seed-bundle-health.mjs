#!/usr/bin/env node
import { runBundle, HOUR, DAY } from './_bundle-runner.mjs';

await runBundle('health', [
  { label: 'China-Coverage', script: 'seed-china-coverage-health.mjs', seedMetaKey: 'health:china-coverage', canonicalKey: 'health:china-coverage:v1', completionMetaKey: 'seed-completion:health:china-coverage', intervalMs: HOUR, timeoutMs: 120_000 },
  { label: 'Air-Quality', script: 'seed-health-air-quality.mjs', seedMetaKey: 'health:air-quality', intervalMs: HOUR, timeoutMs: 600_000 },
  { label: 'Disease-Outbreaks', script: 'seed-disease-outbreaks.mjs', seedMetaKey: 'health:disease-outbreaks', canonicalKey: 'health:disease-outbreaks:v1', intervalMs: DAY, timeoutMs: 300_000 },
  { label: 'VPD-Tracker', script: 'seed-vpd-tracker.mjs', seedMetaKey: 'health:vpd-tracker', canonicalKey: 'health:vpd-tracker:realtime:v1', completionMetaKey: 'seed-completion:health:vpd-tracker', intervalMs: DAY, timeoutMs: 300_000 },
  { label: 'Displacement', script: 'seed-displacement-summary.mjs', seedMetaKey: 'displacement:summary', intervalMs: DAY, timeoutMs: 300_000 },
  { label: 'Cross-Border-Arrivals', script: 'seed-cross-border-arrivals.mjs', seedMetaKey: 'displacement:cross-border', canonicalKey: 'displacement:cross-border:v1', completionMetaKey: 'seed-completion:displacement:cross-border', intervalMs: DAY, timeoutMs: 300_000 },
  { label: 'Border-UK', script: 'seed-border-uk.mjs', seedMetaKey: 'displacement:border-uk', canonicalKey: 'displacement:border-uk:v1', completionMetaKey: 'seed-completion:displacement:border-uk', intervalMs: 6 * HOUR, timeoutMs: 180_000 },
  { label: 'Border-CBP', script: 'seed-border-cbp.mjs', seedMetaKey: 'displacement:border-cbp', canonicalKey: 'displacement:border-cbp:v1', completionMetaKey: 'seed-completion:displacement:border-cbp', intervalMs: DAY, timeoutMs: 180_000 },
  { label: 'Border-Frontex', script: 'seed-border-frontex.mjs', seedMetaKey: 'displacement:border-frontex', canonicalKey: 'displacement:border-frontex:v1', completionMetaKey: 'seed-completion:displacement:border-frontex', intervalMs: DAY, timeoutMs: 180_000 },
  { label: 'Border-Panama', script: 'seed-border-panama.mjs', seedMetaKey: 'displacement:border-panama', canonicalKey: 'displacement:border-panama:v1', completionMetaKey: 'seed-completion:displacement:border-panama', intervalMs: DAY, timeoutMs: 180_000 },
  { label: 'DTM-Displacement', script: 'seed-dtm-displacement.mjs', seedMetaKey: 'displacement:dtm', canonicalKey: 'displacement:dtm:v1', completionMetaKey: 'seed-completion:displacement:dtm', intervalMs: DAY, timeoutMs: 180_000 },
  { label: 'IDMC-IDU-Displacement', script: 'seed-idmc-idu-displacement.mjs', seedMetaKey: 'displacement:idmc-idu', canonicalKey: 'displacement:idmc-idu:v1', completionMetaKey: 'seed-completion:displacement:idmc-idu', intervalMs: DAY, timeoutMs: 300_000 },
]);
