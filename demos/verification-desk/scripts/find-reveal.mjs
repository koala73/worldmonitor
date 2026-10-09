#!/usr/bin/env node
// Lists single-source candidates for the reveal beat, then pins the one you pick.
//   node scripts/find-reveal.mjs            rank candidates
//   node scripts/find-reveal.mjs --pick 2   pin candidate #2 (writes data/reveal.json)
// Open every link before you pin. The data says "one publisher family";
// you are the one saying it to a room.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDesk, DATA_DIR, loadEnv } from '../lib/config.mjs';
import { findRevealCandidates } from '../lib/reveal.mjs';

loadEnv();
const desk = buildDesk();
const pickArg = process.argv.indexOf('--pick');
const pick = pickArg > -1 ? Number(process.argv[pickArg + 1]) : null;

const candidates = await findRevealCandidates(desk.source, { limit: 10 });
if (!candidates.length) {
  console.log('No candidates yet. Let scripts/snapshot.mjs collect for a few hours and re-run.');
  process.exit(1);
}

candidates.forEach((c, i) => {
  console.log(`\n#${i + 1}  [${c.pattern}]  score ${c.score}  (${c.seenIn ?? 'live'})`);
  console.log(`    ${c.title}`);
  console.log(`    ${c.why}`);
  if (c.origin) console.log(`    origin: ${c.origin}`);
  if (c.firstSeen) console.log(`    first seen: ${c.firstSeen}${c.lastUpdated ? `   last: ${c.lastUpdated}` : ''}`);
  if (c.link) console.log(`    ${c.link}`);
  for (const t of (c.memberTitles ?? []).slice(0, 6)) console.log(`      - ${t}`);
});

if (pick) {
  const chosen = candidates[pick - 1];
  if (!chosen) throw new Error(`No candidate #${pick}`);
  const script = await desk.anchor.narrateReveal(chosen);
  await mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, desk.rehearsal ? 'reveal-rehearsal.json' : 'reveal.json');
  await writeFile(file, JSON.stringify({ candidate: chosen, script, pinnedAt: new Date().toISOString() }, null, 2));
  console.log(`\nPinned #${pick} -> ${path.relative(process.cwd(), file)}\n\nAnchor script:\n${script}\n\nEdit the script in that file if you want different words on stage.`);
}
