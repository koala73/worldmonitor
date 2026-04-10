#!/usr/bin/env node
import { runBundle, HOUR, DAY } from './_bundle-runner.mjs';

await runBundle('climate', [
  { label: 'Zone-Normals', script: 'seed-climate-zone-normals.mjs', seedMetaKey: 'climate:zone-normals', intervalMs: 30 * DAY, timeoutMs: 600_000 },
  { label: 'Anomalies', script: 'seed-climate-anomalies.mjs', seedMetaKey: 'climate:anomalies', intervalMs: 3 * HOUR, timeoutMs: 300_000 },
  { label: 'Disasters', script: 'seed-climate-disasters.mjs', seedMetaKey: 'climate:disasters', intervalMs: 6 * HOUR, timeoutMs: 180_000 },
  { label: 'Ocean-Ice', script: 'seed-climate-ocean-ice.mjs', seedMetaKey: 'climate:ocean-ice', intervalMs: DAY, timeoutMs: 300_000 },
  { label: 'CO2-Monitoring', script: 'seed-co2-monitoring.mjs', seedMetaKey: 'climate:co2-monitoring', intervalMs: 3 * DAY, timeoutMs: 180_000 },
]);
