import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS,
  validateDecisionSignalProvenance,
} from '../shared/decision-signal-provenance';
import {
  parseNbsIndustrialRelease,
  parseSafeReserveRelease,
} from '../scripts/china-macro/adapters.mjs';

const fixture = (name: string) => readFileSync(
  new URL(`fixtures/china-macro/${name}`, import.meta.url),
  'utf8',
);
const retrievalTime = '2026-07-25T14:30:00.000Z';

describe('China macro #5581 provenance boundary', () => {
  it('validates launched NBS and SAFE observations through every contract surface', () => {
    const observations = [
      parseNbsIndustrialRelease(fixture('nbs-industrial.html'), { retrievalTime }),
      parseSafeReserveRelease(fixture('safe-reserves.html'), { retrievalTime }),
    ];
    for (const observation of observations) {
      const result = validateDecisionSignalProvenance(observation.provenance);
      assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors));
      for (const adapter of Object.values(DECISION_SIGNAL_PROVENANCE_SURFACE_ADAPTERS)) {
        assert.deepEqual(
          adapter.deserialize(adapter.serialize(observation.provenance)),
          observation.provenance,
        );
      }
    }
  });

  it('keeps official publishers distinct from state-controlled media', () => {
    const observation = parseNbsIndustrialRelease(fixture('nbs-industrial.html'), { retrievalTime });
    const publisher = observation.provenance.claims.publisher;
    assert.equal(publisher.status, 'known');
    if (publisher.status !== 'known') return;
    assert.equal(publisher.value.type, 'official_government');
    assert.equal(publisher.value.registryReference?.sourceType, 'gov');
    assert.equal(publisher.value.registryReference?.propagandaRisk, 'high');
  });

  it('accepts a sequence-one preliminary vintage without weakening lineage rules', () => {
    const preliminary = parseNbsIndustrialRelease(
      fixture('nbs-industrial.html').replace(
        'Industrial Production Operation in June 2026',
        'Preliminary Industrial Production Operation in June 2026',
      ),
      { retrievalTime },
    );
    assert.equal(preliminary.revisionState, 'preliminary');
    const result = validateDecisionSignalProvenance(preliminary.provenance);
    assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors));

    const invalid = structuredClone(preliminary.provenance);
    invalid.claims.revision.value.sequence = 2;
    const invalidResult = validateDecisionSignalProvenance(invalid);
    assert.equal(invalidResult.ok, false);
    if (invalidResult.ok) return;
    assert.ok(invalidResult.errors.some((error) => error.code === 'INVALID_LINEAGE'));
  });
});
