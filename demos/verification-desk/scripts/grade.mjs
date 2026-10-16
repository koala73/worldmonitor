#!/usr/bin/env node
// Grade one headline from the terminal: node scripts/grade.mjs "Headline here"
import { buildDesk, loadEnv } from '../lib/config.mjs';
import { gradeHeadline } from '../lib/grade.mjs';

loadEnv();
const headline = process.argv.slice(2).join(' ').trim();
if (!headline) {
  console.error('usage: node scripts/grade.mjs "<headline>"');
  process.exit(2);
}
const desk = buildDesk();
for await (const ev of gradeHeadline(headline, desk)) {
  if (ev.step === 'done') continue;
  if (ev.step === 'script') console.log(`\nANCHOR: ${ev.data.text}\n`);
  else console.log(`[${ev.step}]`, JSON.stringify(ev.data, null, 0).slice(0, 600));
}
