import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import YAML from 'yaml';
import * as calendar from '../shared/oil-release-calendar.ts';
import { diffEiaSchedule, parseEiaSchedule } from '../scripts/_eia-schedule.mts';

const DAY = 86_400_000;
const cmeEnd = Math.max(...Object.keys(calendar.CME_ENERGY_CLOSES).map(Date.parse));

it('cme calendar horizon warns at 45 days and expires after its last date', () => {
  for (const [daysLeft, status] of [[60, 'ok'], [45, 'expiring'], [30, 'expiring'], [0, 'expiring'], [-1, 'expired']] as const) {
    const result = calendar.oilCalendarHorizons(cmeEnd - daysLeft * DAY).cme;
    assert.equal(result.status, status);
    assert.equal(result.daysLeft, daysLeft);
    assert.equal(result.lastDate, new Date(cmeEnd).toISOString());
  }
});

it('eia has no horizon because its holiday rule never expires', () => {
  assert.deepEqual(Object.keys(calendar.oilCalendarHorizons(Date.parse('2040-01-01'))), ['cme']);
});

it('calendar monitor exits unsuccessfully and identifies the expiring calendar', () => {
  const run = (days: number) => spawnSync(process.execPath, [
    'scripts/check-oil-calendar-horizon.mts', new Date(cmeEnd - days * DAY).toISOString(),
  ], { encoding: 'utf8' });
  assert.equal(run(60).status, 0);
  const warning = run(30);
  assert.equal(warning.status, 1);
  assert.match(warning.stdout, /cme: expiring.*30 days/);
  assert.match(warning.stdout, /::error::/);
  assert.throws(() => calendar.oilCalendarHorizons(NaN), /Invalid/);
});

const release = (week: string) => new Date(calendar.eiaReleaseFor(Date.parse(`${week}T00:00:00Z`))).toISOString().replace('.000Z', 'Z');

it('eia release rule reproduces every shift published for 2025 through 2028', () => {
  const published: Record<string, string> = {
    '2025-01-17': '2025-01-23T17:00:00Z', '2025-02-14': '2025-02-20T17:00:00Z',
    '2025-05-23': '2025-05-29T16:00:00Z', '2025-08-29': '2025-09-04T16:00:00Z',
    '2025-10-10': '2025-10-16T16:00:00Z', '2025-11-07': '2025-11-13T17:00:00Z',
    '2026-01-16': '2026-01-22T17:00:00Z', '2026-02-13': '2026-02-19T17:00:00Z',
    '2026-05-22': '2026-05-28T16:00:00Z', '2026-09-04': '2026-09-10T16:00:00Z',
    '2026-10-09': '2026-10-15T16:00:00Z', '2026-11-06': '2026-11-12T17:00:00Z',
    '2027-01-15': '2027-01-21T17:00:00Z', '2027-02-12': '2027-02-18T17:00:00Z',
    '2027-05-28': '2027-06-03T16:00:00Z', '2027-07-02': '2027-07-08T16:00:00Z',
    '2027-09-03': '2027-09-09T16:00:00Z', '2027-10-08': '2027-10-14T16:00:00Z',
    '2028-01-14': '2028-01-20T17:00:00Z',
  };
  for (const [week, expected] of Object.entries(published)) assert.equal(release(week), expected, week);
});

it('eia release rule keeps the regular Wednesday 10:30 ET release and the listed overrides', () => {
  assert.equal(release('2026-11-13'), '2026-11-18T15:30:00Z');
  assert.equal(release('2026-06-26'), '2026-07-01T14:30:00Z');
  assert.equal(release('2025-12-19'), '2025-12-29T22:00:00Z');
  assert.equal(release('2024-12-27'), '2025-01-02T16:00:00Z');
});

it('eia release rule keeps shifting holiday weeks beyond the last published row', () => {
  assert.equal(release('2030-05-24'), '2030-05-30T16:00:00Z');
  assert.equal(release('2031-11-07'), '2031-11-13T17:00:00Z');
  assert.equal(release('2035-06-15'), '2035-06-21T16:00:00Z');
});

const FIXTURE = (week: string, alternate: string, time: string) => `<table><tbody><tr class="past-holiday">
  <th scope="row">${week}</th><td>${alternate}</td><td>Thursday</td><td>${time}</td><td>Holiday</td></tr></tbody></table>`;

it('publisher schedule parser and diff agree with the rule and flag a departure', () => {
  const agree = parseEiaSchedule(FIXTURE('May 22, 2026', 'May 28, 2026', '12:00 p.m.')
    + FIXTURE('September 4, 2026', 'September 10, 2026', '12:00 p.m.'));
  assert.equal(agree.length, 2);
  assert.deepEqual(diffEiaSchedule(agree), []);
  const moved = parseEiaSchedule(FIXTURE('May 22, 2026', 'May 28, 2026', '12:00 p.m.')
    + FIXTURE('September 4, 2026', 'September 11, 2026', '12:00 p.m.'));
  const problems = diffEiaSchedule(moved);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /week ending 2026-09-04/);
  const extra = parseEiaSchedule(FIXTURE('May 22, 2026', 'May 28, 2026', '12:00 p.m.')
    + FIXTURE('July 24, 2026', 'July 30, 2026', '12:00 p.m.'));
  assert.match(diffEiaSchedule(extra).join('\n'), /week ending 2026-07-24/);
  assert.deepEqual(parseEiaSchedule('<html>layout changed</html>'), []);
  const marked = FIXTURE('May 22, 2026', 'May 28, 2026', '12:00 p.m.')
    + FIXTURE('July 24, 2026', 'July 30, 2026', '<span>12:00</span> p.m.');
  assert.equal(parseEiaSchedule(marked).length, 2);
  const malformed = FIXTURE('May 22, 2026', 'May 28, 2026', '12:00 p.m.')
    + FIXTURE('July 24, 2026', 'July 30, 2026', 'noon');
  assert.throws(() => parseEiaSchedule(malformed), /Unreadable EIA schedule row.*July 24, 2026/);
  for (const [week, alternate] of [['May 99, 2026', 'May 28, 2026'], ['May 22, 2026', 'May 99, 2026'], ['February 31, 2026', 'March 5, 2026'], ['Smarch 3, 2026', 'March 5, 2026']]) {
    assert.throws(() => parseEiaSchedule(FIXTURE(week, alternate, '12:00 p.m.')), /Unreadable EIA schedule row/, `${week} / ${alternate}`);
  }
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

// US clocks spring forward on the second Sunday of March, so 02:00 to 02:59 ET does not exist.
const springForward = (year: number) => new Date(Date.UTC(year, 2, 1 + (7 - new Date(Date.UTC(year, 2, 1)).getUTCDay()) % 7 + 7)).toISOString().slice(0, 10);

it('easternWallTime returns the requested Eastern wall time on the requested day, including early morning', () => {
  const clock = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
  });
  for (let day = Date.UTC(2026, 0, 1); day < Date.UTC(2031, 0, 1); day += DAY) {
    const date = new Date(day).toISOString().slice(0, 10);
    for (let minutes = 0; minutes < 1440; minutes += 15) {
      if (date === springForward(new Date(day).getUTCFullYear()) && minutes >= 120 && minutes < 180) continue;
      const out = calendar.easternWallTime(day, minutes);
      const parts = Object.fromEntries(clock.formatToParts(out).map(part => [part.type, part.value]));
      assert.equal(`${parts.year}-${parts.month}-${parts.day}`, date, `${date} ${minutes}`);
      assert.equal(Number(parts.hour) * 60 + Number(parts.minute), minutes, `${date} ${minutes}`);
    }
  }
});
