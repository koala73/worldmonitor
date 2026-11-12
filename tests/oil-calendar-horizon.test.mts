import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import YAML from 'yaml';
import * as calendar from '../shared/oil-release-calendar.ts';

const DAY = 86_400_000;
for (const [name, end] of Object.entries({
  eia: Math.max(...Object.values(calendar.EIA_RELEASE_SHIFTS).map(Date.parse)),
  cme: Math.max(...Object.keys(calendar.CME_ENERGY_CLOSES).map(Date.parse)),
})) {
  it(`${name} calendar horizon warns at 45 days and expires after its last date`, () => {
    for (const [daysLeft, status] of [[60, 'ok'], [45, 'expiring'], [30, 'expiring'], [0, 'expiring'], [-1, 'expired']] as const) {
      const result = calendar.oilCalendarHorizons(end - daysLeft * DAY)[name];
      assert.equal(result.status, status);
      assert.equal(result.daysLeft, daysLeft);
      assert.equal(result.lastDate, new Date(end).toISOString());
    }
  });
}

it('calendar monitor exits unsuccessfully and identifies the expiring calendar', () => {
  const end = Math.max(...Object.values(calendar.EIA_RELEASE_SHIFTS).map(Date.parse));
  const run = (days: number) => spawnSync(process.execPath, [
    'scripts/check-oil-calendar-horizon.mts', new Date(end - days * DAY).toISOString(),
  ], { encoding: 'utf8' });
  assert.equal(run(60).status, 0);
  const warning = run(30);
  assert.equal(warning.status, 1);
  assert.match(warning.stdout, /eia: expiring.*30 days/);
  assert.match(warning.stdout, /::error::/);
  const cmeEnd = Math.max(...Object.keys(calendar.CME_ENERGY_CLOSES).map(Date.parse));
  const cme = spawnSync(process.execPath, [
    'scripts/check-oil-calendar-horizon.mts', new Date(cmeEnd - 30 * DAY).toISOString(),
  ], { encoding: 'utf8' });
  assert.equal(cme.status, 1);
  assert.match(cme.stdout, /cme: expiring.*30 days/);
  assert.throws(() => calendar.oilCalendarHorizons(NaN), /Invalid/);
});

it('calendar warning runs daily in CI without suppressing failure', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/oil-calendar-horizon.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.schedule, [{ cron: '43 7 * * *' }]);
  const job = workflow.jobs.horizon;
  assert.ok(!job['continue-on-error']);
  const step = job.steps.find((step: { run?: string }) => step.run?.includes('check-oil-calendar-horizon'));
  assert.equal(step.run, 'node scripts/check-oil-calendar-horizon.mts');
  assert.ok(!step['continue-on-error']);
});

it('market documentation and tool description acknowledge modeled CME holidays', () => {
  assert.ok(Object.keys(calendar.CME_ENERGY_CLOSES).length > 0);
  const docs = readFileSync(new URL('../docs/mcp-tools/markets.mdx', import.meta.url), 'utf8');
  assert.doesNotMatch(docs, /holidays[^.]*not model(?:l)?ed/i);
  assert.match(docs, /CME energy holiday sessions for 2026–2027/);
  const source = readFileSync(new URL('../api/mcp/registry/cache-tools.ts', import.meta.url), 'utf8');
  assert.match(source, /futures NYMEX breaks and CME energy holidays \(2026–2027\) plus 30m restart grace/);
});
