import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseBriefPoints, toBriefViewModel } from '@/components/DailyBrief';

describe('daily-brief helpers', () => {
  it('parses markdown bullets and limits to 5 items', () => {
    const summary = [
      '- item 1',
      '- item 2',
      '- item 3',
      '- item 4',
      '- item 5',
      '- item 6',
    ].join('\n');

    const points = parseBriefPoints(summary);
    assert.equal(points.length, 5);
    assert.equal(points[0], 'item 1');
    assert.equal(points[4], 'item 5');
  });

  it('supports plain text rows', () => {
    const points = parseBriefPoints('row a\nrow b');
    assert.deepEqual(points, ['row a', 'row b']);
  });

  it('normalizes payload to stable view model', () => {
    const vm = toBriefViewModel({
      date: '2026-03-20',
      summary: '- alpha\n- beta',
      sourceCount: 7,
    });

    assert.equal(vm.dateLabel, '2026-03-20');
    assert.equal(vm.sourceCount, 7);
    assert.deepEqual(vm.points, ['alpha', 'beta']);
  });
});
