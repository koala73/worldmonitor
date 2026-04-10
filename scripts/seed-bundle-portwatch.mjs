#!/usr/bin/env node
import { runBundle } from './_bundle-runner.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

await runBundle('portwatch', [
  { label: 'PW-Disruptions', script: 'seed-portwatch-disruptions.mjs', seedMetaKey: 'portwatch:disruptions', intervalMs: HOUR, timeoutMs: 120_000 },
  { label: 'PW-Main', script: 'seed-portwatch.mjs', seedMetaKey: 'supply_chain:portwatch', intervalMs: 6 * HOUR, timeoutMs: 300_000 },
  { label: 'PW-Port-Activity', script: 'seed-portwatch-port-activity.mjs', seedMetaKey: 'supply_chain:portwatch-ports', intervalMs: 12 * HOUR, timeoutMs: 600_000 },
  { label: 'PW-Chokepoints-Ref', script: 'seed-portwatch-chokepoints-ref.mjs', seedMetaKey: 'portwatch:chokepoints-ref', intervalMs: WEEK, timeoutMs: 120_000 },
]);
