import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../scripts/seed-utils/logger.mjs';
import { parseFreshness, isFresh, buildMeta } from '../scripts/seed-utils/meta.mjs';
import { forkSeeder } from '../scripts/seed-utils/runner.mjs';

describe('logger', () => {
  it('prefixes messages with the given name', () => {
    const lines = [];
    const log = createLogger('earthquakes', { write: (msg) => lines.push(msg) });
    log.info('seeded 847 items');
    assert.match(lines[0], /\[seed:earthquakes\] seeded 847 items/);
  });

  it('formats error messages', () => {
    const lines = [];
    const log = createLogger('webcams', { write: (msg) => lines.push(msg) });
    log.error('HTTP 429');
    assert.match(lines[0], /\[seed:webcams\] error: HTTP 429/);
  });

  it('uses orchestrator prefix for orchestrator name', () => {
    const lines = [];
    const log = createLogger('orchestrator', { write: (msg) => lines.push(msg) });
    log.info('starting...');
    assert.match(lines[0], /\[orchestrator\] starting\.\.\./);
  });
});

describe('meta', () => {
  describe('parseFreshness', () => {
    it('parses valid seed-meta object (from redisGet which returns parsed JSON)', () => {
      const obj = { fetchedAt: 1000, recordCount: 50, sourceVersion: 'v1' };
      const result = parseFreshness(obj);
      assert.equal(result.fetchedAt, 1000);
      assert.equal(result.recordCount, 50);
    });

    it('parses valid seed-meta string', () => {
      const raw = JSON.stringify({ fetchedAt: 1000, recordCount: 50, sourceVersion: 'v1' });
      const result = parseFreshness(raw);
      assert.equal(result.fetchedAt, 1000);
    });

    it('returns null for missing data', () => {
      assert.equal(parseFreshness(null), null);
      assert.equal(parseFreshness(''), null);
      assert.equal(parseFreshness(undefined), null);
    });

    it('returns null for objects without fetchedAt', () => {
      assert.equal(parseFreshness({ recordCount: 5 }), null);
    });
  });

  describe('isFresh', () => {
    it('returns true when data is within interval', () => {
      const meta = { fetchedAt: Date.now() - 60_000 }; // 1 min ago
      assert.equal(isFresh(meta, 5), true);              // 5 min interval
    });

    it('returns false when data is stale', () => {
      const meta = { fetchedAt: Date.now() - 600_000 }; // 10 min ago
      assert.equal(isFresh(meta, 5), false);              // 5 min interval
    });

    it('returns false for null meta', () => {
      assert.equal(isFresh(null, 5), false);
    });
  });

  describe('buildMeta', () => {
    it('builds success meta', () => {
      const meta = buildMeta(2340, 'ok');
      assert.equal(meta.status, 'ok');
      assert.equal(meta.durationMs, 2340);
      assert.ok(meta.fetchedAt > 0);
      assert.equal(meta.error, undefined);
    });

    it('builds error meta with message', () => {
      const meta = buildMeta(5200, 'error', 'HTTP 429');
      assert.equal(meta.status, 'error');
      assert.equal(meta.error, 'HTTP 429');
    });
  });
});

describe('runner', () => {
  it('runs a script that exits 0 and reports success', async () => {
    const result = await forkSeeder('test-ok', {
      scriptPath: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, 'ok');
    assert.equal(result.name, 'test-ok');
    assert.ok(result.durationMs >= 0);
  });

  it('runs a script that exits 1 and reports error', async () => {
    const result = await forkSeeder('test-fail', {
      scriptPath: process.execPath,
      args: ['-e', 'process.exit(1)'],
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.status, 'error');
  });

  it('kills a script that exceeds timeout', async () => {
    const result = await forkSeeder('test-hang', {
      scriptPath: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 500,
    });
    assert.equal(result.status, 'timeout');
    assert.equal(result.exitCode, null);
  });
});
