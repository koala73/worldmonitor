// Regression guard for #5554's actual root cause: HDX HAPI case-insensitively
// flags any app_identifier whose `application` field CONTAINS the substring
// "worldmonitor" (confirmed live -- see the HAPI_APP_IDENTIFIER comment in
// scripts/seed-conflict-intel.mjs). Without this test, a future well-intentioned
// "brand consistency" rename of shared/hapi-app-identifier.json's `application`
// field back toward "worldmonitor..." would silently reintroduce the exact
// outage this PR fixes, with no signal until HAPI starts 429ing in production.
//
// The `email` field is NOT part of the trigger (separately confirmed live) and
// is deliberately left containing "worldmonitor" as the real contact address,
// so this only checks `application`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadConfig(relPath) {
  return JSON.parse(readFileSync(resolve(root, relPath), 'utf-8'));
}

for (const relPath of ['shared/hapi-app-identifier.json', 'scripts/shared/hapi-app-identifier.json']) {
  test(`${relPath}: application field does not contain "worldmonitor"`, () => {
    const cfg = loadConfig(relPath);
    assert.equal(typeof cfg.application, 'string');
    assert.doesNotMatch(
      cfg.application.toLowerCase(), /worldmonitor/,
      `${relPath}'s application field ("${cfg.application}") contains "worldmonitor" -- ` +
      'HDX HAPI flags any app_identifier whose application field contains this substring ' +
      '(case-insensitive), which is the confirmed root cause of #5554. Pick a different name.',
    );
  });
}
