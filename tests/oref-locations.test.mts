import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeHebrew, translateLocation } from '../src/services/oref-locations.ts';

// OREF pushes siren payloads with Hebrew location names that arrive with bidi
// control marks, presentation-form codepoints, and inconsistent spacing. The
// only property that matters is that a real payload string resolves to the
// English name we render on the alert; assert that by calling the translator.

describe('translateLocation', () => {
  it('translates known locations from the generated table', () => {
    assert.equal(translateLocation('תל אביב - מרכז העיר'), 'Tel Aviv - City Center');
    assert.equal(translateLocation('אשקלון - דרום'), 'Ashkelon - South');
    assert.equal(translateLocation('אבו גוש'), 'Abu Gosh');
  });

  it('resolves names carrying bidi and zero-width marks from the live feed', () => {
    // U+200F RIGHT-TO-LEFT MARK and U+FEFF both appear in real OREF payloads.
    assert.equal(translateLocation('‏אבו גוש‏'), 'Abu Gosh');
    assert.equal(translateLocation('﻿אבו גוש'), 'Abu Gosh');
  });

  it('collapses padded and repeated whitespace before lookup', () => {
    assert.equal(translateLocation('  אבו   גוש  '), 'Abu Gosh');
  });

  it('normalizes dash variants to ASCII hyphen', () => {
    // U+2013 EN DASH in place of the table's ASCII hyphen must still resolve.
    assert.equal(translateLocation('תל אביב – מרכז העיר'), 'Tel Aviv - City Center');
  });

  it('returns the original string when the location is unknown', () => {
    assert.equal(translateLocation('מקום שלא קיים'), 'מקום שלא קיים');
  });

  it('passes empty input straight through', () => {
    assert.equal(translateLocation(''), '');
  });
});

describe('sanitizeHebrew', () => {
  it('strips bidi controls, folds dashes, and collapses whitespace', () => {
    // The stripped bidi mark leaves the spaces that surrounded it, so the
    // collapse pass runs after removal, not before.
    assert.equal(sanitizeHebrew('‎  a—b ⁩ c  '), 'a-b c');
  });
});
