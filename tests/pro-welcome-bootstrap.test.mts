import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clearWelcomeRoot } from '../pro-test/src/welcome-root.ts';

describe('welcome bootstrap root clearing', () => {
  it('uses replaceChildren when the browser supports it', () => {
    let replaceChildrenCalls = 0;
    const root = {
      textContent: 'prerendered markup',
      replaceChildren: () => {
        replaceChildrenCalls += 1;
      },
    };

    clearWelcomeRoot(root);

    assert.equal(replaceChildrenCalls, 1);
  });

  it('clears the root with textContent when replaceChildren is unavailable', () => {
    const root = { textContent: 'prerendered markup' };

    clearWelcomeRoot(root);

    assert.equal(root.textContent, '');
  });
});
