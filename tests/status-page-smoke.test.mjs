import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateUptime } from '../scripts/status-page-smoke.mjs';

const labels = ['Last 24 hours', 'Last 7 days', 'Last 30 days', 'Last 90 days'];
const entries = (values) => labels.map((label, i) => ({ label, value: values[i] }));

test('accepts real figures, including zero uptime', () => {
  assert.deepEqual(validateUptime(entries(['99.522%', '0.000%', '92.793%', '100.000%'])), {
    'Last 24 hours': '99.522%', 'Last 7 days': '0.000%', 'Last 30 days': '92.793%', 'Last 90 days': '100.000%',
  });
});
for (const value of ['', '--%', 'NaN%', '-1%', '101%', '99% garbage', undefined]) {
  test(`rejects a missing or invalid window: ${value}`, () => {
    assert.throws(() => validateUptime(entries(['99%', value, '99%', '99%'])), /Last 7 days/);
  });
}
test('requires every label exactly once', () => {
  const valid = entries(['99%', '99%', '99%', '99%']);
  assert.throws(() => validateUptime(valid.slice(1)), /Last 24 hours/);
  assert.throws(() => validateUptime([...valid, valid[0]]), /Last 24 hours/);
});
