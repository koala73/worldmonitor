import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { hasAcledCredentials } from '../scripts/shared/acled-oauth.mjs';
import { unrestSourceVersion } from '../scripts/seed-unrest-events.mjs';

// worldmonitor.app has no ACLED credentials, so the unrest feed is GDELT only.
// Its seed metadata must say so instead of claiming both sources (#9266).
describe('unrest seed sourceVersion', () => {
  it('names only GDELT when no ACLED credentials are configured', () => {
    assert.equal(unrestSourceVersion({}), 'gdelt');
    assert.equal(unrestSourceVersion({ ACLED_EMAIL: 'a@example.com' }), 'gdelt');
    assert.equal(unrestSourceVersion({ ACLED_PASSWORD: 'x', ACLED_ACCESS_TOKEN: '  ' }), 'gdelt');
  });

  it('names both sources when ACLED credentials are configured', () => {
    assert.equal(unrestSourceVersion({ ACLED_EMAIL: 'a@example.com', ACLED_PASSWORD: 'x' }), 'acled+gdelt');
    assert.equal(unrestSourceVersion({ ACLED_ACCESS_TOKEN: 'token' }), 'acled+gdelt');
  });

  it('applies the same credential rule getAcledToken uses', () => {
    assert.equal(hasAcledCredentials({ ACLED_EMAIL: ' a@example.com ', ACLED_PASSWORD: ' x ' }), true);
    assert.equal(hasAcledCredentials({ ACLED_EMAIL: 'a@example.com', ACLED_PASSWORD: '' }), false);
    assert.equal(hasAcledCredentials({ ACLED_ACCESS_TOKEN: 'token' }), true);
    assert.equal(hasAcledCredentials({}), false);
  });
});
