import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decorateSearchResultOptions } from '../src/components/search-result-options.ts';
import { createBrowserEnvironment, MiniElement, MiniNode } from './helpers/mini-dom.mts';

function withBrowserDom(fn: () => void): void {
  const saved = (['document', 'Node', 'HTMLElement'] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const browser = createBrowserEnvironment();
  const values: Record<string, unknown> = {
    document: browser.document,
    Node: MiniNode,
    HTMLElement: MiniElement,
  };

  for (const [name] of saved) {
    Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  }

  try {
    fn();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

describe('decorateSearchResultOptions', () => {
  it('stamps listbox options and activedescendant on the selected row', () => {
    withBrowserDom(() => {
      const list = document.createElement('div');
      const input = document.createElement('input');
      const first = document.createElement('div');
      first.className = 'search-result-item selected';
      const second = document.createElement('div');
      second.className = 'search-result-item';
      list.append(first, second);

      decorateSearchResultOptions(list, input);

      assert.equal(list.getAttribute('role'), 'listbox');
      assert.equal(first.getAttribute('role'), 'option');
      assert.equal(first.getAttribute('aria-selected'), 'true');
      assert.equal(second.getAttribute('aria-selected'), 'false');
      assert.equal(input.getAttribute('aria-activedescendant'), first.id);
    });
  });

  it('does not fake options when skipOptions is set (all-commands view)', () => {
    withBrowserDom(() => {
      const list = document.createElement('div');
      list.setAttribute('role', 'listbox');
      const input = document.createElement('input');
      input.setAttribute('aria-activedescendant', 'search-option-0');
      const command = document.createElement('div');
      command.className = 'search-result-item command-item';
      list.append(command);

      decorateSearchResultOptions(list, input, { skipOptions: true });

      assert.equal(command.getAttribute('role'), null);
      assert.equal(list.getAttribute('role'), null);
      assert.equal(input.getAttribute('aria-activedescendant'), null);
    });
  });
});
