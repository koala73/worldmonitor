import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hardenServerErrors } from '../scripts/harden-generated-server-errors.mjs';

test('server error hardening survives regeneration and repeated runs', () => {
  const generated = readFileSync(new URL('../src/generated/server/worldmonitor/news/v1/service_server.ts', import.meta.url), 'utf8');
  const original = generated.replaceAll(
    'const message = "Internal server error";',
    'const message = err instanceof Error ? err.message : String(err);',
  );
  const hardened = hardenServerErrors(original);
  assert.ok(!hardened.includes('err.message'));
  assert.equal(hardenServerErrors(hardened), hardened);
  assert.throws(() => hardenServerErrors(original.replace(
    'const message = err instanceof Error ? err.message : String(err);',
    'const message = String(err);',
  )), /Unrecognized sebuf error template/);
});

test('the codegen CLI checks the committed generated servers', () => {
  const output = execFileSync(process.execPath, [
    fileURLToPath(new URL('../scripts/harden-generated-server-errors.mjs', import.meta.url)),
    '--check',
  ], { encoding: 'utf8' });
  assert.match(output, /Validated error fallbacks in \d+ generated services/);
});
