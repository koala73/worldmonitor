import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTACT_MATCH_TIER,
  canonicalizeContactId,
  contactMatchWins,
  rankContactMatch,
} from './contactMatch.js';

/**
 * Voice resolves a spoken or model-supplied identity against the loaded fleet.
 * Ranking callsign and registration together let a registration that happened
 * to equal another contact's callsign win on `Map` insertion order, so the same
 * query could follow a different aircraft between polls. These pin the
 * precedence and the separator-insensitive registration comparison.
 */

test('separators and case fall out of an identity comparison', () => {
  assert.equal(canonicalizeContactId('G-ABCD'), 'GABCD');
  assert.equal(canonicalizeContactId('gabcd'), 'GABCD');
  assert.equal(canonicalizeContactId('05-8152'), '058152');
  assert.equal(canonicalizeContactId('N123AB'), 'N123AB');
  assert.equal(canonicalizeContactId(null), '');
  assert.equal(canonicalizeContactId('  '), '');
});

test('hex outranks every softer match', () => {
  assert.equal(
    rankContactMatch({ query: 'ae7f01', hex: 'ae7f01', callsign: 'RCH451' }),
    CONTACT_MATCH_TIER.HEX_EXACT,
  );
  // A hex query must not be out-competed by a substring hit elsewhere.
  assert.equal(
    rankContactMatch({ query: 'ae7f01', hex: 'bbb999', callsign: 'AE7F01X' }),
    CONTACT_MATCH_TIER.CALLSIGN_PREFIX,
  );
});

test('an exact callsign beats an exact registration, whatever the feed order', () => {
  const asCallsign = rankContactMatch({ query: '6606', hex: 'aaa111', callsign: '6606' });
  const asRegistration = rankContactMatch({ query: '6606', hex: 'bbb222', registration: '6606' });
  assert.equal(asCallsign, CONTACT_MATCH_TIER.CALLSIGN_EXACT);
  assert.equal(asRegistration, CONTACT_MATCH_TIER.REGISTRATION_EXACT);
  assert.ok(
    asCallsign < asRegistration,
    'the callsign contract must not depend on which contact the feed listed first',
  );
});

test('a registration matches in the form the operator says it', () => {
  const hyphenated = { hex: 'aaa111', registration: 'G-ABCD' };
  assert.equal(rankContactMatch({ query: 'GABCD', ...hyphenated }), CONTACT_MATCH_TIER.REGISTRATION_EXACT);
  assert.equal(rankContactMatch({ query: 'g-abcd', ...hyphenated }), CONTACT_MATCH_TIER.REGISTRATION_EXACT);
  const military = { hex: 'ae7f01', registration: '05-8152' };
  assert.equal(rankContactMatch({ query: '058152', ...military }), CONTACT_MATCH_TIER.REGISTRATION_EXACT);
  assert.equal(rankContactMatch({ query: '05-8152', ...military }), CONTACT_MATCH_TIER.REGISTRATION_EXACT);
});

test('a civilian N-number resolves in every form it is written or spoken', () => {
  const civilian = { hex: 'a1b2c3', registration: 'N123AB' };
  assert.equal(rankContactMatch({ query: 'N123AB', ...civilian }), CONTACT_MATCH_TIER.REGISTRATION_EXACT);
  assert.equal(rankContactMatch({ query: 'n-123ab', ...civilian }), CONTACT_MATCH_TIER.REGISTRATION_EXACT);
  assert.equal(rankContactMatch({ query: 'n123', ...civilian }), CONTACT_MATCH_TIER.REGISTRATION_PREFIX);
  assert.equal(rankContactMatch({ query: '123ab', ...civilian }), CONTACT_MATCH_TIER.REGISTRATION_SUBSTRING);
});

test('prefix beats substring, and callsign beats registration at equal strength', () => {
  assert.equal(
    rankContactMatch({ query: 'swa', hex: 'a1', callsign: 'SWA123' }),
    CONTACT_MATCH_TIER.CALLSIGN_PREFIX,
  );
  assert.equal(
    rankContactMatch({ query: '123', hex: 'a1', callsign: 'SWA123' }),
    CONTACT_MATCH_TIER.CALLSIGN_SUBSTRING,
  );
  // Same contact, both fields hit: the callsign tier is the one reported.
  assert.equal(
    rankContactMatch({ query: 'n12', hex: 'a1', callsign: 'N12X', registration: 'N123AB' }),
    CONTACT_MATCH_TIER.CALLSIGN_PREFIX,
  );
});

test('nothing matches an empty or unknown query', () => {
  assert.equal(rankContactMatch({ query: '', hex: 'a1', callsign: 'SWA123' }), CONTACT_MATCH_TIER.NONE);
  assert.equal(rankContactMatch({ query: '   ', hex: 'a1', callsign: 'SWA123' }), CONTACT_MATCH_TIER.NONE);
  assert.equal(rankContactMatch({ query: 'zzz', hex: 'a1', callsign: 'SWA123' }), CONTACT_MATCH_TIER.NONE);
  // A contact with no identity at all cannot be matched by a non-empty query.
  assert.equal(rankContactMatch({ query: 'zzz', hex: '' }), CONTACT_MATCH_TIER.NONE);
});

test('a same-tier tie resolves the same way every time', () => {
  // Two contacts whose registrations both match at the same strength. Without
  // a stable key the winner is upstream Map order, so the same spoken query
  // could follow a different aircraft between polls.
  const a = { tier: CONTACT_MATCH_TIER.REGISTRATION_PREFIX, id: 'bbb222' };
  const b = { tier: CONTACT_MATCH_TIER.REGISTRATION_PREFIX, id: 'aaa111' };
  assert.equal(contactMatchWins(b, a), true, 'the lower hex takes over');
  assert.equal(contactMatchWins(a, b), false, 'and the higher hex never displaces it');
});

test('a stronger tier always beats a weaker one, whichever arrived first', () => {
  const exact = { tier: CONTACT_MATCH_TIER.CALLSIGN_EXACT, id: 'zzz999' };
  const prefix = { tier: CONTACT_MATCH_TIER.REGISTRATION_PREFIX, id: 'aaa111' };
  assert.equal(contactMatchWins(exact, prefix), true, 'tier outranks the tiebreak key');
  assert.equal(contactMatchWins(prefix, exact), false);
});

test('a non-match never becomes the best match', () => {
  assert.equal(contactMatchWins({ tier: CONTACT_MATCH_TIER.NONE, id: 'aaa111' }, null), false);
  assert.equal(
    contactMatchWins(
      { tier: CONTACT_MATCH_TIER.NONE, id: 'aaa111' },
      { tier: CONTACT_MATCH_TIER.CALLSIGN_EXACT, id: 'zzz999' },
    ),
    false,
  );
});
