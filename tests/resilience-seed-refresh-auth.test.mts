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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('resilience seed-refresh auth', () => {
  it('uses timingSafeEqual for X-WorldMonitor-Key and WORLDMONITOR_SEED_REFRESH_KEY comparisons', async () => {
    const headerGetter = String.raw`(?:ctx\.request\.headers|request\.headers)\.get\(\s*['"]X-WorldMonitor-Key['"]\s*\)`;
    const identifier = String.raw`[A-Za-z_$][\w$]*`;
    const seedRefreshKeyBinding = new RegExp(
      String.raw`\b(?:const|let|var)\s+(${identifier})\s*=\s*[\s\S]{0,160}?process\.env\.WORLDMONITOR_SEED_REFRESH_KEY\b`,
      'g',
    );
    const headerBinding = new RegExp(
      String.raw`\b(?:const|let|var)\s+(${identifier})\s*=\s*${headerGetter}\b`,
      'g',
    );
    const violations: string[] = [];

    for (const path of SEED_REFRESH_AUTH_FILES) {
      const source = stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));
      if (!source.includes('WORLDMONITOR_SEED_REFRESH_KEY')) continue;

      assert.match(
        source,
        /\btimingSafeEqual\s*\(/,
        `${path} must keep using timingSafeEqual for seed-refresh auth`,
      );

      const seedRefreshKeyNames = Array.from(
        source.matchAll(seedRefreshKeyBinding),
        (match) => String.raw`\b${escapeRegExp(match[1] ?? '')}\b`,
      );
      const headerNames = Array.from(
        source.matchAll(headerBinding),
        (match) => String.raw`\b${escapeRegExp(match[1] ?? '')}\b`,
      );
      const seedRefreshKeyOperands = [
        String.raw`process\.env\.WORLDMONITOR_SEED_REFRESH_KEY\b`,
        ...seedRefreshKeyNames,
      ].filter(Boolean);
      const headerOperands = [headerGetter, ...headerNames].filter(Boolean);
      const directHeaderCompare = new RegExp(
        String.raw`(?:${headerOperands.join('|')})\s*={2,3}\s*(?:${seedRefreshKeyOperands.join('|')})|(?:${seedRefreshKeyOperands.join('|')})\s*={2,3}\s*(?:${headerOperands.join('|')})`,
      );

      if (directHeaderCompare.test(source)) violations.push(path);
    }

    assert.deepEqual(
      violations,
      [],
      `Seed refresh auth must use timingSafeEqual from server/_shared/internal-auth.ts, not direct equality: ${violations.join(', ')}`,
    );
  });
});
