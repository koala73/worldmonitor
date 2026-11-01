// #9093 operator review page (public/trust/review/). Reader text is rendered as
// text, never markup; accepting needs a public note; the key travels only in the
// X-Trust-Review-Key header.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(process.cwd(), 'public/trust/review/index.html'), 'utf8');
const script = readFileSync(resolve(process.cwd(), 'public/trust/review/review.js'), 'utf8');

const pending = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'pending',
  message: '<img src=x onerror="window.__pwned=1"> wrong publisher count',
  storyId: 'a'.repeat(64),
  url: 'https://example.com/story',
  contact: 'reader@example.com',
  createdAt: Date.UTC(2026, 9, 11, 9, 0),
  reviewedAt: 0,
  publicNote: '',
};

type Call = { url: string; init: RequestInit };

function mount(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }));
  // Parse the page, then drop its script and stylesheet elements: the script
  // under test runs below, and happy-dom would otherwise try to fetch both.
  const page = new DOMParser().parseFromString(html, 'text/html');
  page.querySelectorAll('script, link[rel="stylesheet"]').forEach((node) => node.remove());
  document.documentElement.innerHTML = page.documentElement.innerHTML;
  new Function(script)();
  return calls;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadWithKey(calls: Call[]) {
  (document.getElementById('key') as HTMLInputElement).value = 'secret';
  document.getElementById('key-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  await flush();
  return calls;
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('trust review page', () => {
  it('lists pending reports with reader text as text, sending the key as a header', async () => {
    const calls = await loadWithKey(mount([{ body: { state: 'ok', reports: [pending] } }]));
    expect(calls[0]!.url).toBe('/api/news/v1/list-error-reports?status=pending');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Trust-Review-Key']).toBe('secret');
    expect(calls[0]!.init.credentials).toBe('omit');
    const message = document.querySelector('.message')!;
    expect(message.textContent).toContain('<img src=x');
    expect(document.querySelector('.report img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(document.getElementById('status')!.textContent).toBe('1 pending, oldest first.');
  });

  it('will not accept without a public note, and sends the decision', async () => {
    const calls = await loadWithKey(mount([
      { body: { state: 'ok', reports: [pending] } },
      { body: { report: { ...pending, status: 'accepted' } } },
    ]));
    const [accept] = [...document.querySelectorAll<HTMLButtonElement>('.actions button')];
    accept!.click();
    await flush();
    expect(calls).toHaveLength(1);
    expect(document.getElementById('status')!.className).toBe('error');

    (document.querySelector('textarea') as HTMLTextAreaElement).value = 'Two mastheads now count once.';
    accept!.click();
    await flush();
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('/api/news/v1/review-error-report');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      reportId: pending.id, decision: 'accept', publicNote: 'Two mastheads now count once.',
    });
    expect(document.querySelector('.report')).toBeNull();
  });

  it('says when the key is refused or the queue is unreadable', async () => {
    await loadWithKey(mount([{ status: 401, body: { message: 'Unauthorized' } }]));
    expect(document.getElementById('status')!.textContent).toBe('The review key was not accepted.');

    await loadWithKey(mount([{ body: { state: 'unavailable', reports: [] } }]));
    expect(document.getElementById('status')!.textContent).toContain('could not be read');
  });
});

describe('trust review page media check (#9096)', () => {
  const jobId = `media:1760616000000:${'a'.repeat(32)}`;
  const statusUrl = `/api/news/v1/get-report-media?job_id=${encodeURIComponent(jobId)}`;

  afterEach(() => vi.useRealTimers());

  it('uses the shared contract wording verbatim', async () => {
    const { MEDIA_WORDING } = await import('../../shared/media-provenance-contract.js');
    for (const line of Object.values(MEDIA_WORDING)) expect(script).toContain(line);
  });

  it('checks the report link and shows the result as text, with the key header', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = await loadWithKey(mount([
      { body: { state: 'ok', reports: [pending] } },
      { status: 200, body: { jobId, status: 'pending', statusUrl } },
      { body: { status: 'pending', error: '' } },
      { body: { status: 'done', error: '', result: {
        credentials: { state: 'found', signer: '<b>Example</b> Newsroom', signerTrust: 'untrusted', contentChangedAfterSigning: true, actions: [{ action: 'c2pa.edited', softwareAgent: 'Editor' }] },
        earliest: { state: 'ok', copies: [{ domain: 'example.org', pageUrl: 'https://example.org/p', crawlDate: '2024-03-03' }] },
        caveats: ['Caveat one.'],
      } } },
    ]));
    const button = document.querySelector<HTMLButtonElement>('button.media-check')!;
    expect(button.textContent).toBe('Check image or video');
    button.click();
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls[1]!.url).toBe('/api/news/v1/check-report-media');
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ reportId: pending.id });
    expect((calls[2]!.init.headers as Record<string, string>)['X-Trust-Review-Key']).toBe('secret');
    expect(calls[2]!.url).toBe(statusUrl);
    const lines = [...document.querySelectorAll('.media-result p')].map((p) => p.textContent);
    expect(lines[0]).toBe('Content credentials found. They name the signer as <b>Example</b> Newsroom.');
    expect(document.querySelector('.media-result b')).toBeNull();
    expect(lines).toContain('Earliest copy TinEye has seen: 2024-03-03, example.org.');
    expect(lines.some((line) => line?.startsWith('The credentials do not match the file'))).toBe(true);
    expect(lines[lines.length - 1]).toBe('Caveat one.');
    expect(button.disabled).toBe(false);
  });

  it('offers no media check for a report without a link', async () => {
    await loadWithKey(mount([{ body: { state: 'ok', reports: [{ ...pending, url: '' }] } }]));
    expect(document.querySelector('button.media-check')).toBeNull();
  });
});
