import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  declareRecords as declareCorrelationRecords,
  validateFn as validateCorrelationCards,
} from '../scripts/seed-correlation.mjs';
import {
  declareRecords as declareThermalEscalationRecords,
  validateFn as validateThermalEscalation,
} from '../scripts/seed-thermal-escalation.mjs';

describe('seeder validation floors', () => {
  it('seed-correlation requires at least one real correlation card', () => {
    const emptyDeck = { military: [], escalation: [], economic: [], disaster: [] };
    const oneCardDeck = { ...emptyDeck, economic: [{ id: 'economic:oil', title: 'Oil spike', score: 78 }] };

    assert.equal(declareCorrelationRecords(emptyDeck), 0);
    assert.equal(validateCorrelationCards(emptyDeck), false);
    assert.equal(declareCorrelationRecords(oneCardDeck), 1);
    assert.equal(validateCorrelationCards(oneCardDeck), true);
  });

  it('seed-correlation rejects malformed domain buckets instead of counting incidental length', () => {
    assert.equal(validateCorrelationCards(null), false);
    assert.equal(validateCorrelationCards({ military: 'not-an-array', escalation: [], economic: [], disaster: [] }), false);
    assert.equal(declareCorrelationRecords({ military: 'not-an-array', escalation: [], economic: [], disaster: [] }), 0);
  });

  it('seed-thermal-escalation requires a non-empty cluster array', () => {
    assert.equal(validateThermalEscalation(null), false);
    assert.equal(validateThermalEscalation({}), false);
    assert.equal(validateThermalEscalation({ clusters: 'not-an-array' }), false);
    assert.equal(declareThermalEscalationRecords({ clusters: 'not-an-array' }), 0);
    assert.equal(validateThermalEscalation({ clusters: [] }), false);
    assert.equal(declareThermalEscalationRecords({ clusters: [] }), 0);
    assert.equal(validateThermalEscalation({ clusters: [{ id: 'ua:50-5-30-5:20260610' }] }), true);
    assert.equal(declareThermalEscalationRecords({ clusters: [{ id: 'ua:50-5-30-5:20260610' }] }), 1);
  });
});
