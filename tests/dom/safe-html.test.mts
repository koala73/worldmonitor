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

  it('drops protocol-relative hrefs but keeps same-origin paths and fragments', () => {
    const fragment = safeHtml(
      '<a href="//evil.example/x">cross</a>'
      + '<a href="/dashboard">path</a>'
      + '<a href="#top">frag</a>'
      + '<a href="\\\\evil.example">backslash</a>'
      + '<a href="/\\evil.example/x">slash-backslash</a>'
      + '<a href="/\t/evil.example/x">slash-tab-slash</a>'
      + '<a href="/dashboard?next=//evil.example">query</a>',
    );
    const host = document.createElement('div');
    host.append(fragment);

    const [cross, path, frag, backslash, slashBackslash, slashTab, query] = Array.from(host.querySelectorAll('a'));
    expect(cross?.hasAttribute('href')).toBe(false);
    expect(path?.getAttribute('href')).toBe('/dashboard');
    expect(frag?.getAttribute('href')).toBe('#top');
    expect(backslash?.hasAttribute('href')).toBe(false);
    // The URL parser reads "/\" and "/<tab>/" as scheme-relative.
    expect(slashBackslash?.hasAttribute('href')).toBe(false);
    expect(slashTab?.hasAttribute('href')).toBe(false);
    expect(query?.getAttribute('href')).toBe('/dashboard?next=//evil.example');
  });
});
