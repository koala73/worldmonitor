import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDeskOverlay, parseDeskOverlay } from '../src/services/desk-overlay';

const SAFE_FLAGS = {
  context_only: true,
  research_only: true,
  use_as_execution_signal: false,
  paper_live_approval_signal: false,
  no_broker_connection: true,
  no_order_submission: true,
  no_live_orders: true,
  no_actual_trades: true,
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'desk-world-case-files/v1',
    source: 'desk_worldmonitor_context_hub',
    generated_at: '2026-07-27T06:00:00.000Z',
    data_quality: { status: 'ok', caveats: [] },
    safety: SAFE_FLAGS,
    case_files: [
      {
        id: 'energy:hormuz-supply-risk',
        category: 'energy',
        severity: 'elevated',
        title: 'Hormuz supply risk',
        summary: 'Energy disruption context changed.',
        impact_areas: ['energy', 'krw'],
        observed_at: '2026-07-27T05:59:00.000Z',
        evidence_url: 'https://evidence.example.test/hormuz',
        desk_url: 'https://dev.westkite.dev/desk/cockpit#worldmonitor-context',
        map_location: { label: 'Strait of Hormuz', lat: 26.566, lon: 56.25 },
        ...SAFE_FLAGS,
      },
    ],
    ...overrides,
  };
}

describe('Desk Overlay public contract', () => {
  it('keeps only safe context-only geographic pins and trusted Desk drill-down URLs', () => {
    const result = parseDeskOverlay(payload());

    assert.equal(result.status, 'ok');
    assert.equal(result.caseFiles.length, 1);
    assert.deepEqual(result.caseFiles[0]?.mapLocation, { label: 'Strait of Hormuz', lat: 26.566, lon: 56.25 });
    assert.equal(result.caseFiles[0]?.deskUrl, 'https://dev.westkite.dev/desk/cockpit#worldmonitor-context');
  });

  it('fails closed on unsafe safety flags and strips untrusted external links', () => {
    const unsafe = parseDeskOverlay(payload({ safety: { ...SAFE_FLAGS, no_order_submission: false } }));
    const sanitized = parseDeskOverlay(payload({ case_files: [{ ...payload().case_files[0], evidence_url: 'javascript:alert(1)', desk_url: 'https://evil.example.test/' }] }));

    assert.equal(unsafe.status, 'data_check');
    assert.deepEqual(unsafe.caseFiles, []);
    assert.equal(sanitized.caseFiles[0]?.evidenceUrl, null);
    assert.equal(sanitized.caseFiles[0]?.deskUrl, null);
  });

  it('fetches the public artifact without ambient credentials', async () => {
    let init: RequestInit | undefined;
    const result = await loadDeskOverlay({
      fetchImpl: async (_url, requestInit) => {
        init = requestInit;
        return new Response(JSON.stringify(payload()), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    assert.equal(result.status, 'ok');
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.cache, 'no-store');
  });
});
