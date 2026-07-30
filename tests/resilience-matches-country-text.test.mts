import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matchesCountryText } from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

// Issue #3744: AMBIGUOUS_ALIASES previously skipped every alias for
// countries whose only name collides with another token (Niger,
// Georgia, Guinea, Samoa, Sudan, Dominica), permanently zeroing their
// Reddit-velocity signal in informationCognitive. These tests assert
// the disambiguated replacement matches the country only when context
// rules out the collision.

describe('matchesCountryText — disambiguated bare aliases (#3744)', () => {
  describe('Niger (NE)', () => {
    it('matches a bare Niger mention', () => {
      assert.equal(matchesCountryText('Niger coup leaders meet ECOWAS', 'NE'), true);
    });
    it('does not match a Nigeria mention', () => {
      assert.equal(matchesCountryText('Nigeria swears in new president', 'NE'), false);
    });
    it('still matches Niger when Nigeria is also mentioned separately', () => {
      assert.equal(matchesCountryText('Nigeria considers Niger sanctions', 'NE'), true);
    });
    it('does not match Niger River geographic mention', () => {
      assert.equal(matchesCountryText('Niger River floods displace thousands in Benin', 'NE'), false);
    });
    it('does not match Niger Delta geographic mention', () => {
      assert.equal(matchesCountryText('Niger Delta militants attack pipeline', 'NE'), false);
    });
    it('does not match Niger State (Nigerian sub-national)', () => {
      assert.equal(matchesCountryText('Niger State governor announces budget', 'NE'), false);
    });
  });

  describe('Sudan (SD)', () => {
    it('matches a bare Sudan mention', () => {
      assert.equal(matchesCountryText('Sudan war enters second year', 'SD'), true);
    });
    it('does not match South Sudan', () => {
      assert.equal(matchesCountryText('South Sudan oil pipeline shutdown', 'SD'), false);
    });
    it('matches Sudan when South Sudan also appears separately', () => {
      assert.equal(
        matchesCountryText('Sudan refugees crossing into South Sudan', 'SD'),
        true,
      );
    });
  });

  describe('Samoa (WS)', () => {
    it('matches a bare Samoa mention', () => {
      assert.equal(matchesCountryText('Samoa hosts Pacific leaders summit', 'WS'), true);
    });
    it('does not match American Samoa', () => {
      assert.equal(matchesCountryText('American Samoa votes in primary', 'WS'), false);
    });
  });

  describe('Guinea (GN)', () => {
    it('matches a bare Guinea mention', () => {
      assert.equal(matchesCountryText('Guinea junta delays elections', 'GN'), true);
    });
    it('does not match Equatorial Guinea', () => {
      assert.equal(matchesCountryText('Equatorial Guinea oil deal', 'GN'), false);
    });
    it('does not match Papua New Guinea', () => {
      assert.equal(matchesCountryText('Papua New Guinea volcano erupts', 'GN'), false);
    });
    it('does not match Guinea-Bissau', () => {
      assert.equal(matchesCountryText('Guinea-Bissau coup attempt', 'GN'), false);
    });
    it('matches when both bare Guinea and Equatorial Guinea appear', () => {
      assert.equal(
        matchesCountryText('Guinea condemns Equatorial Guinea election', 'GN'),
        true,
      );
    });
  });

  describe('Georgia (GE)', () => {
    it('matches when a country marker is present', () => {
      assert.equal(matchesCountryText('Tbilisi protests grow in Georgia', 'GE'), true);
    });
    it('matches Georgia alongside Abkhazia marker', () => {
      assert.equal(matchesCountryText('Georgia condemns Abkhazia annexation', 'GE'), true);
    });
    it('does not match a bare Georgia mention without country context', () => {
      assert.equal(matchesCountryText('Georgia voters head to polls', 'GE'), false);
    });
  });

  describe('Dominica (DM)', () => {
    it('matches a bare Dominica mention (previously permanently zeroed)', () => {
      assert.equal(matchesCountryText('Dominica climate aid package', 'DM'), true);
    });
    it('does not match Dominican Republic for DM', () => {
      assert.equal(matchesCountryText('Dominican Republic announces deal', 'DM'), false);
    });
  });

  describe('Republic of the Congo (CG) vs DRC (CD)', () => {
    it('CG matches a bare Congo mention without DRC markers', () => {
      assert.equal(matchesCountryText('Congo holds first vote in years', 'CG'), true);
    });
    it('CG does not match DR Congo', () => {
      assert.equal(matchesCountryText('DR Congo M23 advance', 'CG'), false);
    });
    it('CG does not match a Kinshasa-context Congo mention', () => {
      assert.equal(matchesCountryText('Kinshasa Congo curfew lifted', 'CG'), false);
    });
    it('CG does not match the "Congo Kinshasa" DRC alias', () => {
      assert.equal(matchesCountryText('Congo Kinshasa cease-fire collapses', 'CG'), false);
    });
    it('CG does not match the "Congo Dem Rep" DRC alias', () => {
      assert.equal(matchesCountryText('Congo Dem Rep election results', 'CG'), false);
    });
    it('CD still matches via dr congo alias', () => {
      assert.equal(matchesCountryText('DR Congo cease-fire collapses', 'CD'), true);
    });
    it('CD still matches via drc alias', () => {
      assert.equal(matchesCountryText('DRC peacekeepers withdraw', 'CD'), true);
    });
  });

  describe('non-regression for short multi-word countries', () => {
    it('KP still matches North Korea', () => {
      assert.equal(matchesCountryText('North Korea launches missile', 'KP'), true);
    });
    it('KR still matches South Korea', () => {
      assert.equal(matchesCountryText('South Korea president visits Tokyo', 'KR'), true);
    });
    it('VG still matches British Virgin Islands', () => {
      assert.equal(matchesCountryText('British Virgin Islands storm damage', 'VG'), true);
    });
  });
});
