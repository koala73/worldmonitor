#!/usr/bin/env node
// Installs the pinned Railway CLI for workflow steps, retrying the binary
// download that the npm package's postinstall fetches from GitHub releases.
import { installPinnedRailwayCli } from './trigger-railway-deploys.mjs';

try {
  installPinnedRailwayCli();
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
