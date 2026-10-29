#!/usr/bin/env node
import { runRegionalEnergyFeed } from './_regional-energy-source.mjs';

await runRegionalEnergyFeed('cammesa', import.meta.url).catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
