import { oilCalendarHorizons } from '../shared/oil-release-calendar.ts';
import { diffEiaSchedule, parseEiaSchedule } from './_eia-schedule.mts';

const EIA_SCHEDULE_URL = 'https://www.eia.gov/petroleum/supply/weekly/schedule.php';

// Node 24 runs this without dependencies. Optional ISO clock supports replay and
// skips the live EIA fetch so replays stay offline.
const replay = process.argv[2] !== undefined;
const now = replay ? Date.parse(process.argv[2]) : Date.now();
for (const [name, horizon] of Object.entries(oilCalendarHorizons(now))) {
  const message = `${name}: ${horizon.status}; ${horizon.daysLeft} days left; last date ${horizon.lastDate}`;
  console.log(message);
  if (horizon.status !== 'ok') {
    console.log(`::error::Oil calendar ${message}. Recheck the publisher schedule and update shared/oil-release-calendar.ts.`);
    process.exitCode = 1;
  }
}

if (!replay) {
  let html: string | undefined;
  try {
    const response = await fetch(EIA_SCHEDULE_URL, {
      headers: { 'User-Agent': 'worldmonitor-oil-calendar-check/1.0 (+https://www.worldmonitor.app)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) html = await response.text();
    else console.log(`::warning::EIA schedule fetch returned HTTP ${response.status}; publisher conformance not checked.`);
  } catch (error) {
    console.log(`::warning::EIA schedule fetch failed (${(error as Error).message}); publisher conformance not checked.`);
  }
  if (html !== undefined) {
    const rows = parseEiaSchedule(html);
    if (rows.length === 0) {
      console.log('::error::EIA schedule page has no parseable rows. The page layout changed; update scripts/_eia-schedule.mts.');
      process.exitCode = 1;
    }
    const problems = diffEiaSchedule(rows);
    console.log(`eia: ${rows.length} published shifts checked, ${problems.length} mismatches`);
    for (const problem of problems) console.log(`::error::EIA release rule disagrees with the publisher, ${problem}. Fix shared/oil-release-calendar.ts.`);
    if (problems.length > 0) process.exitCode = 1;
  }
}
