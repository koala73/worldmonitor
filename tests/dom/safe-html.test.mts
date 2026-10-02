import { describe, expect, it } from 'vitest';

import { safeHtml } from '../../src/utils/dom-utils';

describe('safeHtml', () => {
  it('sanitizes descendants promoted out of nested rejected wrappers', () => {
    const fragment = safeHtml(`
      <marquee>
        <svg>
          <a href="javascript:alert(1)" onclick="alert(1)" style="color: red; background: url(https://evil.example)">
            <strong>Safe text</strong>
          </a>
          <a href="https://example.com" target="_blank" style="color: blue">Valid link</a>
        </svg>
      </marquee>
    `);
    const host = document.createElement('div');
    host.append(fragment);

    expect(host.querySelector('marquee')).toBeNull();
    expect(host.querySelector('svg')).toBeNull();

    const links = Array.from(host.querySelectorAll('a'));
    expect(links).toHaveLength(2);
    expect(links[0]?.hasAttribute('href')).toBe(false);
    expect(links[0]?.hasAttribute('onclick')).toBe(false);
    expect(links[0]?.hasAttribute('style')).toBe(false);
    expect(links[0]?.querySelector('strong')?.textContent).toBe('Safe text');

    expect(links[1]?.getAttribute('href')).toBe('https://example.com');
    expect(links[1]?.getAttribute('style')).toBe('color: blue');
    expect(links[1]?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
