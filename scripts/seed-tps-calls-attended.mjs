#!/usr/bin/env node
// On-demand TPS Calls for Service Attended seed. Not a scheduled Canada member.

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { tpsSeedArguments } from './lib/tps-seed-runner.mjs';

loadEnvFile(import.meta.url);

if (process.argv[1]?.endsWith('seed-tps-calls-attended.mjs')) {
  await runSeed(...tpsSeedArguments('calls'));
}
