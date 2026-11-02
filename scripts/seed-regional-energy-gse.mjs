#!/usr/bin/env node
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchRegionalEnergyFeed, regionalEnergyKey, regionalEnergySeedOptions } from './_regional-energy-source.mjs';

const id = 'gse';
try {
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(await fetchRegionalEnergyFeed(id), null, 2));
  } else {
    loadEnvFile(import.meta.url);
    await runSeed('energy', `regional-${id}`, regionalEnergyKey(id), () => fetchRegionalEnergyFeed(id), regionalEnergySeedOptions(id));
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
