import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const tool = CACHE_TOOLS.find((entry) => entry.name === 'get_cyber_threats');
const unknowns = [undefined, null, '', 'unknown', 'CRITICALITY_LEVEL_UNSPECIFIED', 'urgent', 4, {}, 'constructor', '__proto__'];
const payload = (severities) => ({
  'threats-bootstrap': { threats: severities.map((severity, id) => ({ id, severity })) },
});
const threats = (data) => data['threats-bootstrap'].threats;

describe('MCP cyber severity floors', () => {
  for (const [floor, expected] of [
    ['low', ['low', ' Medium ', 'CRITICALITY_LEVEL_HIGH', 'critical']],
    ['medium', [' Medium ', 'CRITICALITY_LEVEL_HIGH', 'critical']],
    ['HIGH', ['CRITICALITY_LEVEL_HIGH', 'critical']],
    [' CRITICALITY_LEVEL_CRITICAL ', ['critical']],
  ]) {
    it(`keeps only known ranks meeting ${floor}`, () => {
      const data = payload([...unknowns, 'low', ' Medium ', 'CRITICALITY_LEVEL_HIGH', 'critical']);
      tool._postFilter(data, { min_severity: floor, limit: 0 });
      assert.deepEqual(threats(data).map((row) => row.severity), expected);
    });
  }

  it('excludes unknowns before applying a requested cap', () => {
    const data = payload([...unknowns, 'high', 'critical']);
    tool._postFilter(data, { min_severity: 'high', limit: 1 });
    assert.deepEqual(threats(data), [{ id: unknowns.length, severity: 'high' }]);
  });

  it('applies the default cap to matching known rows', () => {
    const data = payload([...unknowns, ...Array(40).fill('critical')]);
    tool._postFilter(data, { min_severity: 'high' });
    assert.equal(threats(data).length, 30);
    assert.ok(threats(data).every((row) => row.severity === 'critical'));
  });

  it('preserves uncertainty verbatim when no floor was requested', () => {
    const data = payload(unknowns);
    const before = structuredClone(data);
    tool._postFilter(data, { limit: 0 });
    assert.deepEqual(data, before);
  });

  it('returns no matches for an all-unknown snapshot with a floor', () => {
    const data = payload(unknowns);
    tool._postFilter(data, { min_severity: 'low' });
    assert.deepEqual(threats(data), []);
  });

  it('preserves a missing snapshot as missing', () => {
    const data = { 'threats-bootstrap': null };
    tool._postFilter(data, { min_severity: 'high' });
    assert.equal(data['threats-bootstrap'], null);
  });
});
