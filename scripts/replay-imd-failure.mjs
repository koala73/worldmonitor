#!/usr/bin/env node
import { readImdFailure, replayImdFailure } from './lib/imd-failure-evidence.mjs';

const [path, option, ...extra] = process.argv.slice(2);
if (!path || extra.length || (option && option !== '--allow-revision-mismatch')) {
  console.error('Usage: node scripts/replay-imd-failure.mjs <bundle.json> [--allow-revision-mismatch]');
  process.exitCode = 1;
} else {
  try {
    const result = await replayImdFailure(await readImdFailure(path), { allowRevisionMismatch: Boolean(option) });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`IMD replay failed: ${err.message}`);
    process.exitCode = 1;
  }
}
