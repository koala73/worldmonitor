import { describe, expect, it, vi } from 'vitest';
import { freezeBriefContent, createCountryBriefOutput } from '@/components/CountryBriefOutput';
import { createHostCountryDownload, type CountryTextArtifact, type CountryTextDownload } from '@/utils/country-text-download';
import { WEB_APP_ORIGIN } from '@/config/web-origin';

function link(href: string, text = 'Source'): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.setAttribute('href', href); anchor.textContent = text;
  return anchor;
}

describe('Country Brief export URL policy', () => {
  it.each([true, false])('omits section help from frozen output when hidden=%s without changing the source', hidden => {
    const source = document.createElement('section');
    const button = document.createElement('button'); button.className = 'cdp-card-help';
    button.setAttribute('aria-controls', 'fixture-help');
    button.setAttribute('aria-describedby', 'fixture-help');
    button.setAttribute('aria-expanded', String(!hidden));
    const explanation = document.createElement('p');
    explanation.className = 'cdp-card-help-text'; explanation.id = 'fixture-help';
    explanation.hidden = hidden; explanation.textContent = 'Synthetic section explanation.';
    const body = document.createElement('div'); body.textContent = 'Retained synthetic data.';
    body.append(link('/source'));
    source.append(button, explanation, body);
    const original = source.outerHTML;
    const frozen = freezeBriefContent(source);
    expect(frozen.textContent).not.toContain(explanation.textContent);
    expect(frozen.querySelector('.cdp-card-help, .cdp-card-help-text, [aria-controls], [aria-describedby]')).toBeNull();
    expect(frozen.textContent).toContain('Retained synthetic data.');
    expect(frozen.querySelector('a')?.getAttribute('href')).toBe(`${WEB_APP_ORIGIN}/source`);
    expect(source.outerHTML).toBe(original);
  });

  it.each(['report', 'story'] as const)('uses the injected %s delivery with a bound snapshot and retained source HTML', async kind => {
    const content = document.createElement('section');
    content.textContent = 'USGS · observed unknown · retained 2026-10-06T05:57:35Z';
    const articles: CountryTextArtifact[] = [];
    const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const output = createCountryBriefOutput({ country: 'Canada', code: 'CA', capturedAt: '2026-10-06T05:59:29Z', sections: [{ id: 'signals', title: 'Signals', topics: ['all'], state: 'unavailable', content }], story: [{ title: 'Evidence', content }] }, kind, () => {}, async artifact => { articles.push(artifact); return { state: 'host-accepted' }; });
    document.body.append(output);
    output.querySelector<HTMLButtonElement>('.cdp-export-primary')!.click();
    await Promise.resolve();
    expect(anchor).not.toHaveBeenCalled();
    expect(articles[0]?.filename).toBe(`ca-${kind}-2026-10-06.html`);
    expect(articles[0]?.content).toContain('USGS · observed unknown · retained 2026-10-06T05:57:35Z');
    expect(articles[0]?.content).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'");
    expect(articles[0]?.content).toContain('Canada');
    expect(output.querySelector('[role=status]')?.textContent).toContain('File completion is not confirmed');
    output.remove();
  });
  it('unsupported native output sends no request or Blob anchor and keeps its preview', async () => {
    const call = vi.fn(); const anchor = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const output = createCountryBriefOutput({ country: 'Canada', code: 'CA', capturedAt: '2026-10-06T05:57:35Z', sections: [], story: [] }, 'report', () => {}, createHostCountryDownload(() => ({}), call));
    document.body.append(output); output.querySelector<HTMLButtonElement>('.cdp-export-primary')!.click(); await Promise.resolve(); await Promise.resolve();
    expect(call).not.toHaveBeenCalled(); expect(anchor).not.toHaveBeenCalled();
    expect(output.querySelector('[role=status]')?.textContent).toContain('does not support');
    expect(output.querySelector('article')?.textContent).toContain('Canada'); output.remove();
  });
  it('blocks duplicate clicks and discards a reply after close', async () => {
    let settle!: (value: { state: 'host-accepted' }) => void;
    const deliver = vi.fn<CountryTextDownload>(() => new Promise<{ state: 'host-accepted' }>(resolve => { settle = resolve; }));
    const output = createCountryBriefOutput({ country: 'Canada', code: 'CA', capturedAt: '2026-10-06T05:57:35Z', sections: [], story: [] }, 'report', () => output.remove(), deliver);
    document.body.append(output); const button = output.querySelector<HTMLButtonElement>('.cdp-export-primary')!;
    button.click(); button.click(); expect(deliver).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(true);
    output.querySelector<HTMLButtonElement>('.cdp-output-header button')!.click();
    expect(deliver.mock.calls[0]![1].aborted).toBe(true);
    settle({ state: 'host-accepted' }); await Promise.resolve();
    expect(output.querySelector('[role=status]')?.textContent).not.toContain('Host accepted');
  });
  it('does not update a newer country view when its parent signal aborts', async () => {
    let settle!: (value: { state: 'host-accepted' }) => void;
    const parent = new AbortController();
    const output = createCountryBriefOutput({ country: 'Canada', code: 'CA', capturedAt: '2026-10-06T05:57:35Z', sections: [], story: [] }, 'report', () => {}, () => new Promise(resolve => { settle = resolve; }), parent.signal);
    document.body.append(output); output.querySelector<HTMLButtonElement>('.cdp-export-primary')!.click();
    parent.abort(); settle({ state: 'host-accepted' }); await Promise.resolve();
    expect(output.querySelector('[role=status]')?.textContent).not.toContain('Host accepted'); output.remove();
  });
  it('does not describe an unconfirmed report attempt as a downloaded file', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:fixture', revokeObjectURL: () => {} }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const output = createCountryBriefOutput({ country: 'Canada', code: 'CA', capturedAt: '2026-10-06T05:57:35Z', sections: [], story: [] }, 'report', () => {});
    document.body.append(output);
    output.querySelector<HTMLButtonElement>('.cdp-export-primary')!.click();
    await Promise.resolve();
    expect(output.querySelector('[role=status]')?.textContent).not.toContain('Downloaded');
    output.remove();
  });
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
