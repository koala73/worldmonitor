import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// No jsdom in the suite, so lock the country deep-dive yield (#4617) structurally:
// openCountryBriefByCode must yield to the main thread AFTER the panel paint
// (page.show) and BEFORE the map catch-up (highlightCountry / fitCountry), so the
// deep-dive panel paint isn't blocked by the deck rebuild + fitBounds animation —
// country click is the field #1 INP offender, presentation-delay-dominated. The
// staleness guard (briefRequestToken) is re-checked after the new async gap so a
// newer country open can't be painted over by this one.
const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/app/country-intel.ts'),
  'utf8',
);

test('country-intel imports the shared yield primitive (#4617)', () => {
  assert.match(src, /import \{[^}]*yieldToMain[^}]*\} from '@\/utils\/after-paint'/);
});

test('openCountryBriefByCode yields after the panel paint, before the map catch-up (#4617)', () => {
  const showIdx = src.indexOf('page.show(country, code, score, signals)');
  const yieldIdx = src.indexOf('await yieldToMain()', showIdx);
  const highlightIdx = src.indexOf('highlightCountry(code)', showIdx);
  const fitIdx = src.indexOf('fitCountry(code)', showIdx);
  assert.ok(showIdx >= 0, 'page.show present');
  assert.ok(yieldIdx > showIdx, 'yieldToMain runs after the panel paint');
  assert.ok(highlightIdx > yieldIdx, 'map highlightCountry runs after the yield');
  assert.ok(fitIdx > yieldIdx, 'map fitCountry runs after the yield');
});

test('openCountryBriefByCode re-checks the staleness guard after the new yield (#4617)', () => {
  const showIdx = src.indexOf('page.show(country, code, score, signals)');
  const yieldIdx = src.indexOf('await yieldToMain()', showIdx);
  const highlightIdx = src.indexOf('highlightCountry(code)', yieldIdx);
  const between = src.slice(yieldIdx, highlightIdx);
  assert.match(
    between,
    /token !== this\.briefRequestToken/,
    'briefRequestToken guard re-checked after the async yield, before the map catch-up',
  );
});
