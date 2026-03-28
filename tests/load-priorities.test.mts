import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LoadPriority,
  TASK_PRIORITIES,
  DEFAULT_PRIORITY,
  PRIORITY_DELAYS,
  getTaskPriority,
  groupTasksByPriority,
} from '../src/config/load-priorities.js';

describe('load-priorities', () => {
  describe('LoadPriority enum', () => {
    it('has correct priority order (lower number = higher priority)', () => {
      assert.ok(LoadPriority.CRITICAL < LoadPriority.HIGH);
      assert.ok(LoadPriority.HIGH < LoadPriority.NORMAL);
      assert.ok(LoadPriority.NORMAL < LoadPriority.LOW);
    });

    it('CRITICAL is 0', () => {
      assert.equal(LoadPriority.CRITICAL, 0);
    });
  });

  describe('TASK_PRIORITIES', () => {
    it('news is CRITICAL priority', () => {
      assert.equal(TASK_PRIORITIES.news, LoadPriority.CRITICAL);
    });

    it('markets is HIGH priority', () => {
      assert.equal(TASK_PRIORITIES.markets, LoadPriority.HIGH);
    });

    it('satellites is LOW priority', () => {
      assert.equal(TASK_PRIORITIES.satellites, LoadPriority.LOW);
    });
  });

  describe('PRIORITY_DELAYS', () => {
    it('CRITICAL has 0 delay', () => {
      assert.equal(PRIORITY_DELAYS[LoadPriority.CRITICAL], 0);
    });

    it('HIGH has 100ms delay', () => {
      assert.equal(PRIORITY_DELAYS[LoadPriority.HIGH], 100);
    });

    it('delays increase with lower priority', () => {
      assert.ok(PRIORITY_DELAYS[LoadPriority.CRITICAL] < PRIORITY_DELAYS[LoadPriority.HIGH]);
      assert.ok(PRIORITY_DELAYS[LoadPriority.HIGH] < PRIORITY_DELAYS[LoadPriority.NORMAL]);
      assert.ok(PRIORITY_DELAYS[LoadPriority.NORMAL] < PRIORITY_DELAYS[LoadPriority.LOW]);
    });
  });

  describe('getTaskPriority', () => {
    it('returns configured priority for known tasks', () => {
      assert.equal(getTaskPriority('news'), LoadPriority.CRITICAL);
      assert.equal(getTaskPriority('markets'), LoadPriority.HIGH);
    });

    it('returns DEFAULT_PRIORITY for unknown tasks', () => {
      assert.equal(getTaskPriority('unknown-task'), DEFAULT_PRIORITY);
      assert.equal(getTaskPriority(''), DEFAULT_PRIORITY);
    });
  });

  describe('groupTasksByPriority', () => {
    it('groups tasks by their priority', () => {
      const tasks = [
        { name: 'news', task: Promise.resolve() },
        { name: 'markets', task: Promise.resolve() },
        { name: 'satellites', task: Promise.resolve() },
        { name: 'unknown', task: Promise.resolve() },
      ];

      const groups = groupTasksByPriority(tasks);

      // news is CRITICAL
      assert.equal(groups.get(LoadPriority.CRITICAL)?.length, 1);
      assert.equal(groups.get(LoadPriority.CRITICAL)?.[0]?.name, 'news');

      // markets is HIGH
      assert.equal(groups.get(LoadPriority.HIGH)?.length, 1);
      assert.equal(groups.get(LoadPriority.HIGH)?.[0]?.name, 'markets');

      // unknown defaults to NORMAL
      assert.ok(groups.get(LoadPriority.NORMAL)?.some(t => t.name === 'unknown'));

      // satellites is LOW
      assert.equal(groups.get(LoadPriority.LOW)?.length, 1);
      assert.equal(groups.get(LoadPriority.LOW)?.[0]?.name, 'satellites');
    });

    it('returns empty arrays for priorities with no tasks', () => {
      const tasks = [{ name: 'news', task: Promise.resolve() }];
      const groups = groupTasksByPriority(tasks);

      assert.equal(groups.get(LoadPriority.CRITICAL)?.length, 1);
      assert.equal(groups.get(LoadPriority.HIGH)?.length, 0);
      assert.equal(groups.get(LoadPriority.NORMAL)?.length, 0);
      assert.equal(groups.get(LoadPriority.LOW)?.length, 0);
    });

    it('handles empty task list', () => {
      const groups = groupTasksByPriority([]);

      assert.equal(groups.get(LoadPriority.CRITICAL)?.length, 0);
      assert.equal(groups.get(LoadPriority.HIGH)?.length, 0);
      assert.equal(groups.get(LoadPriority.NORMAL)?.length, 0);
      assert.equal(groups.get(LoadPriority.LOW)?.length, 0);
    });
  });
});
