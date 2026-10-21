#!/usr/bin/env node
import { run } from '../src/run.mjs';

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`Fatal: ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
