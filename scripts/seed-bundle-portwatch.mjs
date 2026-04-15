#!/usr/bin/env node
import { runBundle, HOUR, WEEK } from './_bundle-runner.mjs';

await runBundle('portwatch', [
  { label: 'PW-Disruptions', script: 'seed-portwatch-disruptions.mjs', seedMetaKey: 'portwatch:disruptions', canonicalKey: 'portwatch:disruptions:active:v1', intervalMs: HOUR, timeoutMs: 120_000 },
  { label: 'PW-Main', script: 'seed-portwatch.mjs', seedMetaKey: 'supply_chain:portwatch', canonicalKey: 'supply_chain:portwatch:v1', intervalMs: 6 * HOUR, timeoutMs: 300_000 },
  { label: 'PW-Port-Activity', script: 'seed-portwatch-port-activity.mjs', seedMetaKey: 'supply_chain:portwatch-ports', canonicalKey: 'supply_chain:portwatch-ports:v1:_countries', intervalMs: 12 * HOUR, timeoutMs: 420_000 },
  { label: 'PW-Chokepoints-Ref', script: 'seed-portwatch-chokepoints-ref.mjs', seedMetaKey: 'portwatch:chokepoints-ref', canonicalKey: 'portwatch:chokepoints:ref:v1', intervalMs: WEEK, timeoutMs: 120_000 },
], { maxBundleMs: 540_000 });
