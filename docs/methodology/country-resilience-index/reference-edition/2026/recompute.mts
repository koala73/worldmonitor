#!/usr/bin/env -S npx tsx

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareReferenceResults,
  loadReferenceManifest,
  recomputeReferenceManifest,
} from '../../../../../scripts/resilience-reference-recompute.mts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestPath = path.join(__dirname, 'manifest.json');

const manifest = await loadReferenceManifest(manifestPath);
const computed = await recomputeReferenceManifest(manifest);
const mismatches = compareReferenceResults(manifest, computed);

console.log(JSON.stringify({
  manifest: path.relative(process.cwd(), manifestPath),
  formula: manifest.formula,
  countries: manifest.sample.countries.length,
  dimensions: manifest.sample.dimensions.length,
  mismatches,
}, null, 2));

if (mismatches.length > 0) process.exitCode = 1;
