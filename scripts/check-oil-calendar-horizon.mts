import { oilCalendarHorizons } from '../shared/oil-release-calendar.ts';

// Node 24 runs this without dependencies. Optional ISO clock supports replay.
const now = process.argv[2] === undefined ? Date.now() : Date.parse(process.argv[2]);
for (const [name, horizon] of Object.entries(oilCalendarHorizons(now))) {
  const message = `${name}: ${horizon.status}; ${horizon.daysLeft} days left; last date ${horizon.lastDate}`;
  console.log(message);
  if (horizon.status !== 'ok') {
    console.log(`::error::Oil calendar ${message}. Recheck the publisher schedule and update shared/oil-release-calendar.ts.`);
    process.exitCode = 1;
  }
}
