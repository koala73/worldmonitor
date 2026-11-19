#!/usr/bin/env node
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchBorderSource, routeSeedOptions } from './lib/border-route-sources.mjs';
loadEnvFile(import.meta.url);
await runSeed('displacement', 'border-cbp', 'displacement:border-cbp:v1',
  () => fetchBorderSource('cbp'), routeSeedOptions('cbp'));
