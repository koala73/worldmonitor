import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createInstallEnvironment } from '../scripts/bootstrap-worktree.mjs';

describe('worktree bootstrap install environment', () => {
  it('does not pass inherited allow-scripts policy to child npm installs', () => {
    const environment = createInstallEnvironment(
      {
        npm_config_allow_scripts: 'local-package',
        PATH: '/usr/bin',
      },
      '/tmp/npm-cache',
    );

    assert.deepEqual(environment, {
      npm_config_cache: '/tmp/npm-cache',
      PATH: '/usr/bin',
    });
  });
});
