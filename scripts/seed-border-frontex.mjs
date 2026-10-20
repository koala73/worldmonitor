#!/usr/bin/env node
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchBorderSource, routeSeedOptions } from './lib/border-route-sources.mjs';
loadEnvFile(import.meta.url);
await runSeed('displacement', 'border-frontex', 'displacement:border-frontex:v1',
  () => fetchBorderSource('frontex'), routeSeedOptions('frontex'));
