// #9093 /trust page (public/trust/). Counts and changes come from the public
// label-history API; every server value renders as text; the report form posts
// to the review queue and never claims a report was applied.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(process.cwd(), 'public/trust/index.html'), 'utf8');
const script = readFileSync(resolve(process.cwd(), 'public/trust/trust.js'), 'utf8');

const HASH = 'a'.repeat(64);
const at = Date.UTC(2026, 9, 11, 9, 30);
const change = {
  storyId: HASH,
  field: 'corroboration',
  previous: 'single-publisher',
  next: 'corroborated',
  previousPublishers: 1,
  nextPublishers: 3,
  at,
  trigger: 'digest',
  reason: '3 publisher families now carry this story (was 1).',
  sources: [{ name: 'Reuters', tier: 1 }, { name: 'BBC', tier: 2 }],
  title: '<img src=x onerror="window.__pwned=1">Panama declares emergency',
  link: 'https://www.reuters.com/world/x',
  credibilityScore: 72,
};
const correction = {
  storyId: '', field: 'correction', previous: '', next: '', previousPublishers: 0, nextPublishers: 0, at,
  trigger: 'report', reason: 'Two mastheads of one owner now count once.', sources: [], title: '',
  link: 'javascript:alert(1)', credibilityScore: -1,
};
const counts = { at, stories: 120, corroborated: 70, singlePublisher: 40, tier4Only: 4, unknown: 6 };

type Reply = { status?: number; body: unknown };
type Call = { url: string; init?: RequestInit };

function mount(replies: Record<string, Reply[]>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(replies).find((prefix) => url.startsWith(prefix))!;
    const next = replies[key]!.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }));
  // Parse the page, then drop its script and stylesheet elements: the script
  // under test runs below, and happy-dom would otherwise try to fetch both.
  const page = new DOMParser().parseFromString(html, 'text/html');
  page.querySelectorAll('script, link[rel="stylesheet"]').forEach((node) => node.remove());
  document.documentElement.innerHTML = page.documentElement.innerHTML;
  Element.prototype.scrollIntoView = () => {};
  new Function(script)();
  return calls;
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };
const text = (id: string) => document.getElementById(id)!.textContent;

afterEach(() => vi.unstubAllGlobals());

describe('/trust page', () => {
  it("shows today's counts and recent changes, with server text as text", async () => {
    mount({ '/api/news/v1/list-label-changes': [{ body: { state: 'ok', retentionDays: 7, counts, changes: [change, correction] } }] });
    await flush();
    expect(text('count-corroborated')).toBe('70');
    expect(text('count-single')).toBe('40');
    expect(text('today-note')).toContain('120 stories');
    const items = document.querySelectorAll('.change');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Single publisher (1)');
    expect(items[0]!.textContent).toContain('Corroborated (3)');
    expect(items[0]!.textContent).toContain('Reuters · T1');
    expect(items[0]!.querySelector('.cred')!.textContent).toBe('CRED 72 (high)');
    expect(items[0]!.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect((items[0]!.querySelector('a.title') as HTMLAnchorElement).href).toBe('https://www.reuters.com/world/x');
    expect(items[1]!.textContent).toContain('Correction from a reader report');
    expect(items[1]!.querySelector('a.title')).toBeNull();
    expect(text('changes-status')).toBe('2 changes.');
  });

  it('says so when the log is unreadable, rather than showing an empty history', async () => {
    mount({ '/api/news/v1/list-label-changes': [{ body: { state: 'unavailable', changes: [] } }] });
    await flush();
    expect(text('changes-status')).toContain('could not be read');
    expect(text('today-note')).toContain('not available');
  });

  it('loads one story\'s history on demand', async () => {
    const calls = mount({
      '/api/news/v1/list-label-changes?limit': [{ body: { state: 'ok', changes: [change] } }],
      '/api/news/v1/list-label-changes?story_id': [{ body: { state: 'ok', changes: [change, { ...change, previous: 'corroborated', next: 'single-publisher' }] } }],
    });
    await flush();
    (document.querySelector('.actions button') as HTMLButtonElement).click();
    await flush();
    expect(calls[1]!.url).toBe(`/api/news/v1/list-label-changes?story_id=${HASH}&limit=20`);
    expect(document.querySelectorAll('.history li')).toHaveLength(2);
  });

  it('an unreadable story history is an error, and the next click retries', async () => {
    const calls = mount({
      '/api/news/v1/list-label-changes?limit': [{ body: { state: 'ok', changes: [change] } }],
      '/api/news/v1/list-label-changes?story_id': [
        { body: { state: 'unavailable', changes: [] } },
        { body: { state: 'ok', changes: [change] } },
      ],
    });
    await flush();
    const button = document.querySelector('.actions button') as HTMLButtonElement;
    button.click();
    await flush();
    expect(document.querySelector('.history-error')!.textContent).toContain('could not be loaded');
    expect(document.body.textContent).not.toContain('No other changes recorded.');
    button.click();
    await flush();
    expect(calls).toHaveLength(3);
    expect(document.querySelector('.history-error')).toBeNull();
    expect(document.querySelectorAll('.history li')).toHaveLength(1);
  });

  it('says when the list is cut at the page limit', async () => {
    mount({ '/api/news/v1/list-label-changes': [{ body: { state: 'ok', changes: Array.from({ length: 200 }, () => change) } }] });
    await flush();
    expect(text('changes-status')).toContain('Showing the latest 200 changes');
  });

  it('reporting another story replaces the link the form filled, but not one the reader typed', async () => {
    const other = { ...change, storyId: 'b'.repeat(64), title: 'Other story', link: 'https://www.bbc.com/news/y' };
    mount({ '/api/news/v1/list-label-changes': [{ body: { state: 'ok', changes: [change, other] } }] });
    await flush();
    const reportButtons = [...document.querySelectorAll<HTMLButtonElement>('.actions button')].filter((b) => b.textContent === 'Report an error');
    const url = document.getElementById('report-url') as HTMLInputElement;
    reportButtons[0]!.click();
    expect(url.value).toBe('https://www.reuters.com/world/x');
    reportButtons[1]!.click();
    expect(url.value).toBe('https://www.bbc.com/news/y');
    url.value = 'https://example.org/my-source';
    reportButtons[0]!.click();
    expect(url.value).toBe('https://example.org/my-source');
  });

  it('reports an error about a change, honeypot included, and never claims it was applied', async () => {
    const calls = mount({
      '/api/news/v1/list-label-changes': [{ body: { state: 'ok', changes: [change] } }],
      '/api/news/v1/submit-error-report': [{ body: { status: 'received', reportId: 'x' } }],
    });
    await flush();
    const reportButton = [...document.querySelectorAll<HTMLButtonElement>('.actions button')].find((b) => b.textContent === 'Report an error')!;
    reportButton.click();
    expect(text('report-story')).toContain('Panama declares emergency');
    const form = document.getElementById('report-form') as HTMLFormElement;
    (document.getElementById('report-message') as HTMLTextAreaElement).value = 'short';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(calls).toHaveLength(1);
    expect(text('report-status')).toContain('at least 10 characters');

    (document.getElementById('report-message') as HTMLTextAreaElement).value = 'Reuters and Reuters Crypto are one publisher.';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(calls[1]!.url).toBe('/api/news/v1/submit-error-report');
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({
      message: 'Reuters and Reuters Crypto are one publisher.',
      storyId: HASH,
      url: 'https://www.reuters.com/world/x',
      contact: '',
      website: '',
    });
    expect(text('report-status')).toBe('Thank you. A person will review your report; nothing changes automatically.');
  });

  it('explains a rate limit and a full queue', async () => {
    mount({
      '/api/news/v1/list-label-changes': [{ body: { state: 'ok', changes: [] } }],
      '/api/news/v1/submit-error-report': [{ status: 429, body: {} }, { body: { status: 'queue-full', reportId: '' } }],
    });
    await flush();
    const form = document.getElementById('report-form') as HTMLFormElement;
    (document.getElementById('report-message') as HTMLTextAreaElement).value = 'The label on the quake story is wrong.';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(text('report-status')).toContain('Too many reports');
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(text('report-status')).toContain('queue is full');
  });

  it('does not thank the reader for a success response it does not recognize', async () => {
    mount({
      '/api/news/v1/list-label-changes': [{ body: { state: 'ok', changes: [] } }],
      '/api/news/v1/submit-error-report': [{ body: {} }],
    });
    await flush();
    const form = document.getElementById('report-form') as HTMLFormElement;
    (document.getElementById('report-message') as HTMLTextAreaElement).value = 'The label on the quake story is wrong.';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(text('report-status')).toContain('could not be sent');
    expect(text('report-status')).not.toContain('Thank you');
  });
});
