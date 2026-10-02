import { describe, expect, it } from 'vitest';
import { freezeBriefContent } from '@/components/CountryBriefOutput';
import { WEB_APP_ORIGIN } from '@/config/web-origin';

function link(href: string, text = 'Source'): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.setAttribute('href', href); anchor.textContent = text;
  return anchor;
}

describe('Country Brief export URL policy', () => {
  it('keeps web URLs and remaps local fragments without changing the source', () => {
    const source = document.createElement('section');
    source.id = 'section';
    const heading = document.createElement('h2'); heading.id = 'evidence';
    source.append(heading, ...['#evidence', '#unknown', '  #section  ', '/report?a=1&b=2', 'reports/today',
      'https://example.com/source?a=1&b=2', 'http://example.com/', '//example.com/path'].map(href => link(href)));
    const frozen = freezeBriefContent(source);
    expect(Array.from(frozen.querySelectorAll('a'), a => a.getAttribute('href'))).toEqual([
      '#export-evidence', '#unknown', '#export-section', `${WEB_APP_ORIGIN}/report?a=1&b=2`, `${WEB_APP_ORIGIN}/reports/today`,
      'https://example.com/source?a=1&b=2', 'http://example.com/', 'https://example.com/path',
    ]);
    expect(source.id).toBe('section');
    expect(source.querySelector('a')?.getAttribute('href')).toBe('#evidence');
  });

  it('removes unsafe and malformed hrefs, retains labels, and processes later links', () => {
    const source = document.createElement('section');
    source.append(...['javascript:void(0)', ' JaVaScRiPt:void(0) ', 'java\nscript:void(0)',
      'data:text/html,example', 'mailto:test@example.com', 'http://[', 'https://example.com:bad', '/valid'].map(href => link(href)));
    const anchors = Array.from(freezeBriefContent(source).querySelectorAll('a'));
    expect(anchors.slice(0, -1).every(a => !a.hasAttribute('href') && a.textContent === 'Source')).toBe(true);
    expect(anchors[anchors.length - 1]?.getAttribute('href')).toBe(`${WEB_APP_ORIGIN}/valid`);
  });

  it('applies the same policy to a root anchor', () => {
    expect(freezeBriefContent(link('javascript:void(0)')).hasAttribute('href')).toBe(false);
    expect(freezeBriefContent(link('http://[')).textContent).toBe('Source');
    expect(freezeBriefContent(link('/report')).getAttribute('href')).toBe(`${WEB_APP_ORIGIN}/report`);
  });

  it('retains frozen details and selected control values', () => {
    const source = document.createElement('section');
    const details = document.createElement('details'); details.append(link('/evidence'));
    const input = document.createElement('input'); input.value = 'Selected amount';
    source.append(details, input);
    const frozen = freezeBriefContent(source);
    expect(frozen.querySelector('details')?.open).toBe(true);
    expect(frozen.querySelector('.cdp-export-control-value')?.textContent).toBe('Selected amount');
    expect(frozen.querySelector('input')).toBeNull();
  });
});
