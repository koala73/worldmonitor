import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The homepage and /pro "What's new" list says "New features from the last 30
// days". It is curated by hand, so nothing else notices when nobody rotates it
// (the August list ran until late October). This fails once the recorded
// rotation day is more than 35 days old: pick the most interesting features
// shipped in the last 30 days, update whatsNew.m1-m8 in every pro-test locale
// and the EN baseline, then move LAST_ROTATED.

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPONENT = join(__dirname, '..', 'pro-test', 'src', 'components', 'WhatsNew.tsx');
const MAX_AGE_DAYS = 35;
const DAY_MS = 24 * 60 * 60 * 1000;

function lastRotated(source) {
  const match = source.match(/const LAST_ROTATED = '(\d{4}-\d{2}-\d{2})';/);
  assert.ok(match, `LAST_ROTATED = 'YYYY-MM-DD' not found in ${COMPONENT}`);
  const ms = Date.parse(`${match[1]}T00:00:00Z`);
  assert.ok(Number.isFinite(ms), `LAST_ROTATED is not a valid date: ${match[1]}`);
  return { iso: match[1], ms };
}

describe("What's new list freshness", () => {
  it(`was rotated within the last ${MAX_AGE_DAYS} days`, () => {
    const { iso, ms } = lastRotated(readFileSync(COMPONENT, 'utf8'));
    const ageDays = Math.floor((Date.now() - ms) / DAY_MS);
    assert.ok(ageDays >= -1, `LAST_ROTATED ${iso} is in the future`);
    assert.ok(
      ageDays <= MAX_AGE_DAYS,
      `What's new was last rotated on ${iso} (${ageDays} days ago) but its subtitle says ` +
        `"the last 30 days". Replace whatsNew.m1-m8 with the most interesting features ` +
        `shipped since, in every pro-test locale and scripts/locale-baselines/pro-test.json, ` +
        `set the PRO flags in ITEMS, and move LAST_ROTATED in pro-test/src/components/WhatsNew.tsx.`,
    );
  });
});
