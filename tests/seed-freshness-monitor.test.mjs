import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  findStaleSeedProblems,
  validateCompactHealthPayload,
} from '../scripts/check-seed-freshness.mjs';

describe('scheduled seed freshness monitor', () => {
  it('alerts only when seed metadata has exceeded maxStaleMin', () => {
    const payload = {
      status: 'UNHEALTHY',
      checkedAt: '2026-07-13T17:45:19.746Z',
      summary: { total: 4, ok: 0, warn: 2, onDemandWarn: 0, staleContent: 0, crit: 2 },
      problems: {
        wildfire: { status: 'STALE_SEED', seedAgeMin: 361, maxStaleMin: 360 },
        frozenFeed: { status: 'STALE_CONTENT', contentAgeMin: 91, maxContentAgeMin: 90 },
        emptyFeed: { status: 'EMPTY', records: 0, maxStaleMin: 180 },
        failedFeed: { status: 'SEED_ERROR', records: 1, maxStaleMin: 120 },
      },
    };

    assert.deepEqual(findStaleSeedProblems(payload), [
      {
        name: 'wildfire',
        seedAgeMin: 361,
        maxStaleMin: 360,
      },
    ]);
  });

  it('rejects payloads that cannot prove compact seed freshness', () => {
    assert.throws(() => validateCompactHealthPayload(null), /object/);
    assert.deepEqual(findStaleSeedProblems({ status: 'HEALTHY' }), []);
    assert.throws(() => validateCompactHealthPayload({ status: 'WARNING' }), /problems/);
    assert.throws(
      () => validateCompactHealthPayload({ status: 'HEALTHY', problems: [] }),
      /problems/,
    );
  });

  it('runs on a schedule, skips non-green main, and invokes the monitor script', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/seed-freshness-monitor.yml', import.meta.url),
      'utf8',
    );

    assert.match(workflow, /schedule:/);
    assert.match(workflow, /cron:\s*['"]\*\/15 \* \* \* \*['"]/);
    assert.match(workflow, /actions\/setup-node@[a-f0-9]+/);
    assert.match(workflow, /node-version:\s*['"]24['"]/);
    assert.match(workflow, /context\s*==\s*"gate"/);
    assert.match(workflow, /gate_state.*success/s);
    assert.match(workflow, /node scripts\/check-seed-freshness\.mjs/);
  });
});
