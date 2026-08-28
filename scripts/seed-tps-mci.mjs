#!/usr/bin/env node
// On-demand TPS Major Crime Indicators seed. Not a scheduled Canada member.

import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { tpsSeedArguments } from './lib/tps-seed-runner.mjs';

loadEnvFile(import.meta.url);

if (process.argv[1]?.endsWith('seed-tps-mci.mjs')) {
  await runSeed(...tpsSeedArguments('mci'));
}
