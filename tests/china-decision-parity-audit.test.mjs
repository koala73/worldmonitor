import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { CHINA_DECISION_SIGNAL_GROUP_MANIFEST } from '../shared/china-decision-signal-manifest.ts';
import {
  CHINA_DECISION_PARITY_MANIFEST,
  auditChinaDecisionStaticRegistrations,
  probeChinaDecisionParity,
} from '../scripts/audit-china-decision-parity.mjs';

describe('China decision-signal static and staging audit (#5580)', () => {
  it('pins all six domains across API, MCP, bootstrap, health, alerts, Railway, and docs', () => {
    const result = auditChinaDecisionStaticRegistrations(resolve(import.meta.dirname, '..'));
    assert.deepEqual(result.groupIds, [
      'macro',
      'policy-enforcement',
      'cross-strait-activity',
      'corporate-disclosures',
      'corridor-conditions',
      'activity-nowcast',
    ]);
    assert.equal(result.canonicalKey, 'intelligence:china-decision-signals:v1');
    assert.equal(result.seedMetaKey, 'seed-meta:intelligence:china-decision-signals');
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
    assert.deepEqual(
      CHINA_DECISION_PARITY_MANIFEST,
      CHINA_DECISION_SIGNAL_GROUP_MANIFEST,
    );
  });

  it('returns a sanitized live probe without source payloads or credentials', async () => {
    const groups = CHINA_DECISION_PARITY_MANIFEST.map(({ groupId }) => ({
      id: groupId,
      state: 'unavailable',
      reason: 'No reviewed source observation is available.',
      items: [],
      metadata: {},
    }));
    const canonical = {
      schemaVersion: 1,
      generatedAt: '2026-07-26T12:00:00Z',
      groups,
      access: {
        anonymous: 'bounded_public_summary',
        pro: 'same_provenance_via_mcp',
        operator: 'source_health_only',
      },
    };
    let tick = Date.parse('2026-07-26T12:00:00Z');
    const result = await probeChinaDecisionParity('https://staging.example', {
      now: () => ++tick,
      fetchImpl: async (url) => {
        if (String(url).includes('/api/bootstrap?')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                chinaDecisionSignals: canonical,
              },
              missing: [],
            }),
          };
        }
        assert.equal(String(url), 'https://staging.example/api/intelligence/v1/get-china-decision-signals');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            payloadJson: JSON.stringify({
              ...canonical,
              apiKey: 'must-not-leak',
            }),
          }),
        };
      },
    });
    assert.deepEqual(result, {
      ok: true,
      route: '/api/intelligence/v1/get-china-decision-signals',
      bootstrapRoute: '/api/bootstrap?keys=chinaDecisionSignals&public=1',
      httpStatus: 200,
      bootstrapHttpStatus: 200,
      latencyMs: 1,
      bootstrapLatencyMs: 1,
      generatedAt: '2026-07-26T12:00:00Z',
      bootstrapGeneratedAt: '2026-07-26T12:00:00Z',
      groupStates: {
        macro: 'unavailable',
        'policy-enforcement': 'unavailable',
        'cross-strait-activity': 'unavailable',
        'corporate-disclosures': 'unavailable',
        'corridor-conditions': 'unavailable',
        'activity-nowcast': 'unavailable',
      },
      bootstrapGroupStates: {
        macro: 'unavailable',
        'policy-enforcement': 'unavailable',
        'cross-strait-activity': 'unavailable',
        'corporate-disclosures': 'unavailable',
        'corridor-conditions': 'unavailable',
        'activity-nowcast': 'unavailable',
      },
    });
    assert.doesNotMatch(JSON.stringify(result), /apiKey|private-document|must-not-leak/);
  });

  it('fails closed when staging returns malformed group states', async () => {
    const groups = CHINA_DECISION_PARITY_MANIFEST.map(({ groupId }) => ({
      id: groupId,
      state: groupId === 'macro' ? 'healthy' : 'unavailable',
      reason: null,
      items: [],
      metadata: {},
    }));
    const result = await probeChinaDecisionParity('https://staging.example', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          payloadJson: JSON.stringify({
            schemaVersion: 1,
            generatedAt: '2026-07-26T12:00:00Z',
            groups,
            access: {
              anonymous: 'bounded_public_summary',
              pro: 'same_provenance_via_mcp',
              operator: 'source_health_only',
            },
          }),
        }),
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_contract');
    assert.equal(result.groupStates, undefined);
  });
});
