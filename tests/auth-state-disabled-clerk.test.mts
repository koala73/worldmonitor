import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAuthState, initAuthState } from '@/services/auth-state';

describe('auth state without Clerk', () => {
  it('settles immediately as anonymous when auth is not configured', async () => {
    await initAuthState();

    assert.deepEqual(getAuthState(), {
      user: null,
      isPending: false,
    });
  });
});
