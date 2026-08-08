import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TECH_EVENTS_CACHE_KEY,
  parseArgs,
  runPurge,
} from '../scripts/purge-tech-events-cache.mjs';

// Importing this module must not purge anything: the entrypoint is guarded by
// isDirectInvocation(). If that guard ever inverts, these tests would issue a
// real DEL against whatever Upstash creds happen to be in the environment.
// Every case below injects a fake pipeline, so a real one is never reachable.

function collect() {
  const lines = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe('purge-tech-events-cache argument parsing', () => {
  it('defaults to a live run with no flags', () => {
    assert.deepEqual(parseArgs([]), { kind: 'ok', dryRun: false });
  });

  it('accepts --dry-run', () => {
    assert.deepEqual(parseArgs(['--dry-run']), { kind: 'ok', dryRun: true });
  });

  it('rejects an unknown flag rather than silently doing nothing', () => {
    const result = parseArgs(['--force']);
    assert.equal(result.kind, 'err');
    assert.match(result.message, /unknown flag/);
  });

  // A typo'd --dry-run must not fall through to a live DEL.
  it('rejects a misspelled dry-run flag instead of purging for real', () => {
    assert.equal(parseArgs(['--dryrun']).kind, 'err');
  });
});

describe('purge-tech-events-cache purge behaviour', () => {
  it('purges exactly the RPC key and not the bootstrap key', async () => {
    const sent = [];
    const { lines, sink } = collect();
    const result = await runPurge({
      dryRun: false,
      deps: {
        redisPipeline: async (commands) => {
          sent.push(commands);
          return [{ result: 1 }];
        },
        log: sink,
        warn: sink,
      },
    });

    assert.deepEqual(sent, [[['DEL', TECH_EVENTS_CACHE_KEY]]]);
    assert.equal(TECH_EVENTS_CACHE_KEY, 'research:tech-events:v1');
    assert.ok(
      !JSON.stringify(sent).includes('bootstrap'),
      'the bootstrap key is seeder-owned and was never poisoned; it must not be purged',
    );
    assert.deepEqual(result, { code: 0, deleted: true });
    assert.ok(lines.some((l) => l.includes('DELETED')));
  });

  it('treats an already-absent key as success, not failure', async () => {
    const { lines, sink } = collect();
    const result = await runPurge({
      dryRun: false,
      deps: { redisPipeline: async () => [{ result: 0 }], log: sink, warn: sink },
    });

    assert.deepEqual(result, { code: 0, deleted: false });
    assert.ok(lines.some((l) => l.includes('already absent')));
  });

  // The load-bearing case. The pipeline helper collapses every failure mode
  // (non-2xx, timeout, throw) into `null`. If that were read as "nothing to
  // purge", an operator would believe a dead connection had cleared the key
  // and the stale payload would keep serving for the rest of its TTL.
  it('reports a transport failure as retryable, never as a completed purge', async () => {
    const { lines, sink } = collect();
    const result = await runPurge({
      dryRun: false,
      deps: { redisPipeline: async () => null, log: sink, warn: sink },
    });

    assert.deepEqual(result, { code: 2, deleted: false });
    assert.notEqual(result.code, 0, 'a null pipeline result must not exit 0');
    assert.ok(lines.some((l) => l.includes('NOT purged')));
  });

  it('reports an upstream command error as retryable', async () => {
    const { lines, sink } = collect();
    const result = await runPurge({
      dryRun: false,
      deps: {
        redisPipeline: async () => [{ error: 'ERR max requests limit exceeded' }],
        log: sink,
        warn: sink,
      },
    });

    assert.deepEqual(result, { code: 2, deleted: false });
    assert.ok(lines.some((l) => l.includes('upstream error')));
  });

  it('issues no command at all under --dry-run', async () => {
    let called = false;
    const { lines, sink } = collect();
    const result = await runPurge({
      dryRun: true,
      deps: {
        redisPipeline: async () => {
          called = true;
          return [{ result: 1 }];
        },
        log: sink,
        warn: sink,
      },
    });

    assert.equal(called, false, '--dry-run must not reach Redis');
    assert.deepEqual(result, { code: 0, deleted: false });
    assert.ok(lines.some((l) => l.includes('DRY RUN')));
  });
});
