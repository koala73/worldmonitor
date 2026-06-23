import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_SHARED_PATH = resolve(here, '../server/worldmonitor/resilience/v1/_shared.ts');
const WIDGET_UTILS_PATH = resolve(here, '../src/components/resilience-widget-utils.ts');

function parseFactorTable(path: string): Record<string, number> {
  const source = readFileSync(path, 'utf8');
  const match = source.match(/const\s+STALENESS_CONFIDENCE_COVERAGE_FACTOR:[^=]+=\s*\{([\s\S]*?)\};/);
  if (!match) {
    throw new Error(`Could not locate STALENESS_CONFIDENCE_COVERAGE_FACTOR in ${path}`);
  }

  const body = match[1]!.replace(/\/\/[^\n]*/g, '');
  const entries: Record<string, number> = {};
  for (const rawEntry of body.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const parsed = entry.match(/^(?:(['"])(.*?)\1|([A-Za-z_$][\w$]*))\s*:\s*([0-9.]+)$/);
    if (!parsed) {
      throw new Error(`Could not parse staleness confidence factor entry "${entry}" in ${path}`);
    }
    const key = parsed[2] ?? parsed[3] ?? '';
    const value = Number(parsed[4]);
    assert.ok(Number.isFinite(value), `Non-finite staleness factor for "${key}" in ${path}`);
    entries[key] = value;
  }
  return entries;
}

describe('staleness confidence coverage factor parity', () => {
  it('server and widget use the same staleness derate table', () => {
    const serverFactors = parseFactorTable(SERVER_SHARED_PATH);
    const widgetFactors = parseFactorTable(WIDGET_UTILS_PATH);

    assert.deepEqual(widgetFactors, serverFactors,
      'Update STALENESS_CONFIDENCE_COVERAGE_FACTOR in src/components/resilience-widget-utils.ts when the server table changes.');
  });
});
