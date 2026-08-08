import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

function assertGuardBefore(source: string, methodName: string, guardedWork: RegExp): void {
  const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const methodStart = source.search(new RegExp(`^\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:async\\s+)?${escaped}\\s*\\(`, 'm'));
  assert.ok(methodStart >= 0, `${methodName} not found`);
  const guardAt = source.indexOf('runWhenConnected', methodStart);
  const workAt = source.slice(methodStart).search(guardedWork);
  assert.ok(workAt >= 0, `${methodName} guarded work not found`);
  assert.ok(
    guardAt >= 0 && guardAt < methodStart + workAt,
    `${methodName} must call runWhenConnected before starting detached network work`,
  );
}

describe('self-starting panel fetches wait for attachment', () => {
  it('TechReadinessPanel refresh waits for connection before bootstrap fetch', () => {
    assertGuardBefore(
      read('src/components/TechReadinessPanel.ts'),
      'refresh',
      /getTechReadinessRankings\(/,
    );
  });

  it('LatestBriefPanel refresh waits for connection before /api/latest-brief fetch', () => {
    assertGuardBefore(
      read('src/components/LatestBriefPanel.ts'),
      'refresh',
      /fetchLatest\(/,
    );
  });

  it('AirlineIntelPanel refresh waits for connection before aviation fetches', () => {
    assertGuardBefore(
      read('src/components/AirlineIntelPanel.ts'),
      'refresh',
      /loadOps\(\)|loadTab\(/,
    );
  });

  it('McpDataPanel fetchData waits for connection before proxy fetch', () => {
    assertGuardBefore(
      read('src/components/McpDataPanel.ts'),
      'fetchData',
      /premiumFetch\(/,
    );
  });

  it('RegionalIntelligenceBoard loadCurrent waits for connection before premium RPCs', () => {
    assertGuardBefore(
      read('src/components/RegionalIntelligenceBoard.ts'),
      'loadCurrent',
      /getRegionalSnapshot\(/,
    );
  });
});
