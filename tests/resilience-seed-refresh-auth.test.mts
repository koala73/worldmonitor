import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SEED_REFRESH_AUTH_FILES = [
  '../server/gateway.ts',
  '../server/worldmonitor/resilience/v1/get-resilience-ranking.ts',
] as const;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('resilience seed-refresh auth', () => {
  it('does not directly compare X-WorldMonitor-Key to WORLDMONITOR_SEED_REFRESH_KEY-derived expected values', async () => {
    const headerGetter = String.raw`(?:ctx\.request\.headers|request\.headers)\.get\(\s*['"]X-WorldMonitor-Key['"]\s*\)`;
    const directHeaderCompare = new RegExp(
      String.raw`${headerGetter}\s*={2,3}\s*\bexpected\b|\bexpected\b\s*={2,3}\s*${headerGetter}`,
    );
    const violations: string[] = [];

    for (const path of SEED_REFRESH_AUTH_FILES) {
      const source = stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));
      if (!source.includes('WORLDMONITOR_SEED_REFRESH_KEY')) continue;
      if (directHeaderCompare.test(source)) violations.push(path);
    }

    assert.deepEqual(
      violations,
      [],
      `Seed refresh auth must use timingSafeEqual from server/_shared/internal-auth.ts, not direct equality: ${violations.join(', ')}`,
    );
  });
});
