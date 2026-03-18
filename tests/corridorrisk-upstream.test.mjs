import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const src = readFileSync(resolve(root, 'server/worldmonitor/supply-chain/v1/_corridorrisk-upstream.ts'), 'utf-8');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf-8');

describe('CorridorRisk type exports', () => {
  it('exports CorridorRiskEntry interface', () => {
    assert.match(src, /export\s+interface\s+CorridorRiskEntry/);
  });

  it('exports CorridorRiskData interface', () => {
    assert.match(src, /export\s+interface\s+CorridorRiskData/);
  });

  it('does not contain fetch logic (moved to relay)', () => {
    assert.doesNotMatch(src, /cachedFetchJson/);
    assert.doesNotMatch(src, /getCorridorRiskData/);
    assert.doesNotMatch(src, /fetchCorridorRiskData/);
  });
});

describe('CorridorRisk relay seed loop', () => {
  it('uses corridorrisk.io open beta API (no auth required)', () => {
    assert.match(relaySrc, /corridorrisk\.io\/api\/corridors/);
  });

  it('does not require API key (open beta)', () => {
    assert.doesNotMatch(relaySrc, /CORRIDOR_RISK_API_KEY/);
  });

  it('writes to supply_chain:corridorrisk:v1 Redis key', () => {
    assert.match(relaySrc, /supply_chain:corridorrisk:v1/);
  });

  it('writes seed-meta for corridorrisk', () => {
    assert.match(relaySrc, /seed-meta:supply_chain:corridorrisk/);
  });

  it('defines startCorridorRiskSeedLoop', () => {
    assert.match(relaySrc, /function startCorridorRiskSeedLoop/);
  });

  it('uses 15s timeout', () => {
    assert.match(relaySrc, /AbortSignal\.timeout\(15000\)/);
  });

  it('logs only status code on HTTP error', () => {
    assert.match(relaySrc, /\[CorridorRisk\] HTTP \$\{resp\.status\}/);
  });

  it('derives riskLevel from score (not from API field)', () => {
    assert.match(relaySrc, /score >= 70.*critical/);
    assert.match(relaySrc, /score >= 50.*high/);
    assert.match(relaySrc, /score >= 30.*elevated/);
  });

  it('stores riskSummary truncated to 200 chars', () => {
    assert.match(relaySrc, /risk_summary.*\.slice\(0,\s*200\)/);
  });

  it('stores riskReportAction truncated to 500 chars', () => {
    assert.match(relaySrc, /risk_report\?\.action.*\.slice\(0,\s*500\)/);
  });

  it('triggers seedTransitSummaries after successful seed', () => {
    assert.match(relaySrc, /seedTransitSummaries\(\).*Post-CorridorRisk/);
  });
});
