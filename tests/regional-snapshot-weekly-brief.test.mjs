// Tests for the Regional Intelligence weekly brief generator (Phase 3 PR2).
// Pure-function + injectable-LLM unit tests; no network. Run via:
//   npm run test:data

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateWeeklyBrief,
  buildBriefPrompt,
  parseBriefJson,
  emptyBrief,
} from '../scripts/regional-snapshot/weekly-brief.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const handlerSrc = readFileSync(resolve(root, 'server/worldmonitor/intelligence/v1/get-regional-brief.ts'), 'utf-8');
const handlerIndexSrc = readFileSync(resolve(root, 'server/worldmonitor/intelligence/v1/handler.ts'), 'utf-8');
const premiumPathsSrc = readFileSync(resolve(root, 'src/shared/premium-paths.ts'), 'utf-8');
const gatewaySrc = readFileSync(resolve(root, 'server/gateway.ts'), 'utf-8');
const protoSrc = readFileSync(resolve(root, 'proto/worldmonitor/intelligence/v1/get_regional_brief.proto'), 'utf-8');
const serviceProtoSrc = readFileSync(resolve(root, 'proto/worldmonitor/intelligence/v1/service.proto'), 'utf-8');

// ── Fixtures ────────────────────────────────────────────────────────────────

const mena = { id: 'mena', label: 'Middle East & North Africa' };
const globalRegion = { id: 'global', label: 'Global' };

const snapshotFixture = {
  regime: { label: 'coercive_stalemate', previous_label: 'calm', transitioned_at: 0, transition_driver: 'regime_shift' },
  balance: { coercive_pressure: 0.72, domestic_fragility: 0.55, capital_stress: 0.40, energy_vulnerability: 0.30, alliance_cohesion: 0.60, maritime_access: 0.70, energy_leverage: 0.80, net_balance: 0.03 },
  triggers: { active: [{ id: 'mena_coercive_high', description: 'Coercive > 0.7' }], watching: [], dormant: [] },
  narrative: { situation: { text: 'Iran flexes near Hormuz.', evidence_ids: [] }, outlook_7d: { text: 'Escalation risk persists.', evidence_ids: [] } },
};

const transitionsFixture = [
  { region_id: 'mena', label: 'coercive_stalemate', previous_label: 'calm', transitioned_at: Date.now() - 3 * 86_400_000, transition_driver: 'regime_shift', snapshot_id: 's1' },
];

const validPayload = JSON.stringify({
  situation_recap: 'Iran increased naval posture near Hormuz.',
  regime_trajectory: 'Shifted from calm to coercive stalemate mid-week.',
  key_developments: ['Hormuz transit volume dropped 15%', 'CII spike for Iran'],
  risk_outlook: 'Escalation risk remains elevated into next week.',
});

// ── buildBriefPrompt ────────────────────────────────────────────────────────

describe('buildBriefPrompt', () => {
  it('includes region label and balance axes in the prompt', () => {
    const { userPrompt } = buildBriefPrompt(mena, snapshotFixture, transitionsFixture);
    assert.match(userPrompt, /Middle East/);
    assert.match(userPrompt, /coercive=0\.72/);
  });

  it('includes regime transitions', () => {
    const { userPrompt } = buildBriefPrompt(mena, snapshotFixture, transitionsFixture);
    assert.match(userPrompt, /calm → coercive_stalemate/);
  });

  it('includes narrative situation when available', () => {
    const { userPrompt } = buildBriefPrompt(mena, snapshotFixture, transitionsFixture);
    assert.match(userPrompt, /Iran flexes near Hormuz/);
  });

  it('handles empty transitions', () => {
    const { userPrompt } = buildBriefPrompt(mena, snapshotFixture, []);
    assert.match(userPrompt, /no regime transitions/i);
  });

  it('tolerates missing snapshot fields', () => {
    assert.doesNotThrow(() => buildBriefPrompt(mena, {}, []));
  });
});

// ── parseBriefJson ──────────────────────────────────────────────────────────

describe('parseBriefJson', () => {
  it('parses a valid JSON brief', () => {
    const { brief, valid } = parseBriefJson(validPayload);
    assert.equal(valid, true);
    assert.equal(brief.situation_recap, 'Iran increased naval posture near Hormuz.');
    assert.equal(brief.key_developments.length, 2);
    assert.ok(brief.risk_outlook.length > 0);
  });

  it('returns valid=false on empty/garbage input', () => {
    assert.equal(parseBriefJson('').valid, false);
    assert.equal(parseBriefJson('not json').valid, false);
    assert.equal(parseBriefJson(null).valid, false);
  });

  it('returns valid=false on all-empty fields', () => {
    const { valid } = parseBriefJson(JSON.stringify({
      situation_recap: '', regime_trajectory: '', key_developments: [], risk_outlook: '',
    }));
    assert.equal(valid, false);
  });

  it('caps key_developments at 5', () => {
    const payload = JSON.stringify({
      situation_recap: 'x',
      key_developments: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    });
    const { brief } = parseBriefJson(payload);
    assert.ok(brief.key_developments.length <= 5);
  });

  it('extracts JSON from prose-wrapped output', () => {
    const text = 'Here is the brief:\n```json\n' + validPayload + '\n```';
    const { valid } = parseBriefJson(text);
    assert.equal(valid, true);
  });
});

// ── generateWeeklyBrief ─────────────────────────────────────────────────────

describe('generateWeeklyBrief', () => {
  function mockCall(text, provider = 'groq', model = 'llama-3.3-70b-versatile') {
    return async () => ({ text, provider, model });
  }

  it('returns a populated brief on LLM success', async () => {
    const brief = await generateWeeklyBrief(mena, snapshotFixture, transitionsFixture, {
      callLlm: mockCall(validPayload),
    });
    assert.equal(brief.region_id, 'mena');
    assert.ok(brief.generated_at > 0);
    assert.ok(brief.period_start > 0);
    assert.equal(brief.situation_recap, 'Iran increased naval posture near Hormuz.');
    assert.equal(brief.provider, 'groq');
  });

  it('skips global region', async () => {
    const brief = await generateWeeklyBrief(globalRegion, snapshotFixture, [], {
      callLlm: mockCall(validPayload),
    });
    assert.equal(brief.region_id, 'global');
    assert.equal(brief.situation_recap, '');
  });

  it('returns empty brief when LLM fails', async () => {
    const brief = await generateWeeklyBrief(mena, snapshotFixture, transitionsFixture, {
      callLlm: async () => null,
    });
    assert.equal(brief.situation_recap, '');
    assert.equal(brief.provider, '');
  });

  it('returns empty brief when LLM returns garbage', async () => {
    const brief = await generateWeeklyBrief(mena, snapshotFixture, transitionsFixture, {
      callLlm: mockCall('not json at all'),
    });
    assert.equal(brief.situation_recap, '');
  });

  it('swallows callLlm exceptions', async () => {
    const brief = await generateWeeklyBrief(mena, snapshotFixture, transitionsFixture, {
      callLlm: async () => { throw new Error('network blown up'); },
    });
    assert.equal(brief.situation_recap, '');
  });

  it('records period_start as 7 days before period_end', async () => {
    const brief = await generateWeeklyBrief(mena, snapshotFixture, transitionsFixture, {
      callLlm: mockCall(validPayload),
    });
    const diff = brief.period_end - brief.period_start;
    assert.ok(Math.abs(diff - 7 * 24 * 60 * 60 * 1000) < 1000);
  });
});

// ── emptyBrief ──────────────────────────────────────────────────────────────

describe('emptyBrief', () => {
  it('carries the region_id', () => {
    assert.equal(emptyBrief('mena').region_id, 'mena');
  });

  it('has empty fields', () => {
    const b = emptyBrief('x');
    assert.equal(b.situation_recap, '');
    assert.deepEqual(b.key_developments, []);
  });
});

// ── Handler structural + registration ───────────────────────────────────────

describe('get-regional-brief handler', () => {
  it('reads from the canonical weekly brief key prefix', () => {
    assert.match(handlerSrc, /intelligence:regional-briefs:v1:weekly:/);
  });

  it('exports adaptBrief for unit testing', () => {
    assert.match(handlerSrc, /export function adaptBrief/);
  });

  it('signals upstreamUnavailable on Redis miss', () => {
    assert.match(handlerSrc, /upstreamUnavailable:\s*true/);
  });

  it('is registered in handler.ts', () => {
    assert.match(handlerIndexSrc, /import \{ getRegionalBrief \} from '\.\/get-regional-brief'/);
    assert.match(handlerIndexSrc, /\s+getRegionalBrief,/);
  });
});

// ── Security wiring ─────────────────────────────────────────────────────────

describe('security wiring', () => {
  it('adds the endpoint to PREMIUM_RPC_PATHS', () => {
    assert.match(premiumPathsSrc, /'\/api\/intelligence\/v1\/get-regional-brief'/);
  });

  it('has a RPC_CACHE_TIER entry for route-parity', () => {
    assert.match(gatewaySrc, /'\/api\/intelligence\/v1\/get-regional-brief':\s*'slow'/);
  });
});

// ── Proto definition ────────────────────────────────────────────────────────

describe('proto definition', () => {
  it('declares GetRegionalBrief RPC in service.proto', () => {
    assert.match(serviceProtoSrc, /rpc GetRegionalBrief\(GetRegionalBriefRequest\) returns \(GetRegionalBriefResponse\)/);
  });

  it('imports the proto file from service.proto', () => {
    assert.match(serviceProtoSrc, /import "worldmonitor\/intelligence\/v1\/get_regional_brief\.proto"/);
  });

  it('defines RegionalBrief with all fields', () => {
    assert.match(protoSrc, /message RegionalBrief/);
    assert.match(protoSrc, /string situation_recap = 5/);
    assert.match(protoSrc, /string regime_trajectory = 6/);
    assert.match(protoSrc, /repeated string key_developments = 7/);
    assert.match(protoSrc, /string risk_outlook = 8/);
    assert.match(protoSrc, /string provider = 9/);
    assert.match(protoSrc, /string model = 10/);
  });
});
