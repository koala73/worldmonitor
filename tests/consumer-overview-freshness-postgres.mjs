import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('../consumer-prices-core/src/snapshots/worldmonitor.ts', import.meta.url), 'utf8');
const queries = [...source.matchAll(/`(SELECT AVG\(EXTRACT\(EPOCH FROM \(NOW\(\) - last_successful_run_at\)\)[^`]+)`/g)];
assert.equal(queries.length, 1, 'exercise the overview builder SQL');
const query = queries[0][1].replace('$1', "'gb'");
const container = `consumer-overview-freshness-${process.pid}`;

test('overview freshness uses only the selected market’s active retailers', async (t) => {
  execFileSync('docker', ['run', '--detach', '--rm', '--pull', 'never', '--network', 'none',
    '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine'], { timeout: 15000 });
  try {
    execFileSync('docker', ['exec', container, 'sh', '-c',
      'for attempt in 1 2 3 4 5 6 7 8 9 10; do pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'], { timeout: 15000 });
    const cases = [
      {
        name: 'disabled old and unknown clocks do not inflate active freshness', expected: '22',
        retailers: "('a','gb',true),('b','gb',true),('c','gb',false),('d','gb',false),('e','us',true)",
        health: "('a',NOW()-INTERVAL '20 minutes'),('b',NOW()-INTERVAL '24 minutes'),('c',NOW()-INTERVAL '77 days'),('d',NULL::timestamptz),('e',NOW()-INTERVAL '500 days')",
      },
      {
        name: 'a genuinely stale active source remains stale', expected: '2880',
        retailers: "('a','gb',true),('b','gb',false)",
        health: "('a',NOW()-INTERVAL '2 days'),('b',NOW()-INTERVAL '20 minutes')",
      },
      {
        name: 'no active source clock remains unknown in the query result', expected: '',
        retailers: "('a','gb',true),('b','gb',false)",
        health: "('a',NULL::timestamptz),('b',NOW()-INTERVAL '77 days')",
      },
    ];
    for (const fixture of cases) {
      await t.test(fixture.name, () => {
        const sql = `WITH retailers(id,market_code,active) AS (VALUES ${fixture.retailers}),
          data_source_health(retailer_id,last_successful_run_at) AS (VALUES ${fixture.health}) ${query};`;
        const actual = execFileSync('docker', ['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'],
          { input: sql, encoding: 'utf8', timeout: 15000 }).trim();
        assert.equal(actual, fixture.expected);
      });
    }
  } finally {
    execFileSync('docker', ['stop', '--time', '3', container], { timeout: 10000 });
  }
});
