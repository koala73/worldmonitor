import test from 'node:test';
import assert from 'node:assert/strict';

import { validateSigningConfig } from '../scripts/desktop-package.mjs';

test('unsigned packaging proceeds when signing credentials are missing', () => {
  const logs = [];
  const result = validateSigningConfig({
    os: 'macos',
    sign: true,
    env: {},
    log: (message) => logs.push(message),
  });

  assert.equal(result.signEnabled, false);
  assert.match(logs.join('\n'), /signing is optional/i);
});
