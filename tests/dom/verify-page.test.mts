/**
 * #9092: the /verify page. It searches the fresh headlines for the claim,
 * builds the same card the verify_claim MCP tool returns, and never calls a
 * claim true or false.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FACT_CHECK_LABEL, renderClaimCardHtml, renderFactChecksHtml } from '@/components/claim-card';
import { checkClaim, claimSearchFromBody, CLAIM_HEADLINES_URL, FACT_CHECKS_URL, type ClaimSearch, type FactCheckResult } from '@/services/verify-claim';
import { FACT_CHECK_CAVEAT, FACT_CHECK_LABEL as SERVER_FACT_CHECK_LABEL } from '../../server/_shared/fact-checks';
import { buildClaimCard, claimCandidates } from '../../server/_shared/claim-match';

const NOW = Date.parse('2026-10-09T21:00:00Z');
const T0 = Date.parse('2026-10-09T18:00:00Z');

function row(source: string, title: string, link: string, publishedAt = T0) {
  return { source, title, link, publishedAt };
}

// The fresh headlines the fake server searches.
const POOL = [
  row('Reuters', 'Trump strikes diesel deal with Putin', 'https://n.test/1'),
  row('BBC World', 'Trump says Russia will supply diesel in deal with Putin', 'https://n.test/2', T0 + 3_600_000),
  row('Reuters World', 'Panama earthquake: 12 dead, toll expected to rise', 'https://n.test/3'),
  row('Reuters', 'Panama earthquake: 12 dead, toll expected to rise', 'https://n.test/4'),
  row('RT', 'Kremlin hails <b>diesel</b> deal with Trump as Putin win', 'javascript:alert(1)'),
  row('Al Jazeera', 'Floods close schools across Kerala', 'https://n.test/6'),
];
const POOL_CORE = POOL.map((item) => ({ ...item, pubDate: new Date(item.publishedAt), isAlert: false }));

// What the server answers for a claim: its candidates, ranked by the real claimCandidates.
function searchBody(claim: string) {
  return {
    headlines: claim ? claimCandidates(claim, POOL_CORE).map(({ source, title, link, publishedAt }) => ({ source, title, link, publishedAt })) : [],
    searchedHeadlines: POOL.length,
    searchedFeeds: 5,
    feedTotal: 5,
    feedCached: 5,
    state: 'complete',
    readAt: '2026-10-09T20:55:00.000Z',
  };
}

function search(claim: string): ClaimSearch {
  return claimSearchFromBody(searchBody(claim))!;
}

// The real page markup, parsed (not regex-stripped), without its entry script.
function pageBody(): string {
  const page = new DOMParser().parseFromString(readFileSync(resolve(import.meta.dirname, '../../verify.html'), 'utf8'), 'text/html');
  for (const script of page.querySelectorAll('script')) script.remove();
  return page.body.innerHTML;
}

describe('claim card on /verify', () => {
  it('a search that did not run is no search, never an empty one', () => {
    expect(claimSearchFromBody({ ...searchBody('x'), state: 'unavailable' })).toBeNull();
    expect(claimSearchFromBody({ ...searchBody('x'), searchedHeadlines: 0 })).toBeNull();
    expect(search('Trump strikes diesel deal with Putin')).toMatchObject({ searched: 6, feeds: 5, readAt: '2026-10-09T20:55:00.000Z' });
  });

  it('builds exactly the card the MCP tool builds', () => {
    const claim = 'Trump strikes diesel deal with Putin';
    const found = search(claim);
    expect(found.items.map((item) => item.link)).not.toContain('https://n.test/6');
    expect(checkClaim(`  ${claim}  `, found)).toEqual(buildClaimCard(claim, found.items, found.searched));
    // The candidates give the same card as the whole pool.
    expect(checkClaim(claim, found)).toEqual(buildClaimCard(claim, POOL_CORE));
  });

  it('corroborated: names the independent publishers, flags state media, and drops unsafe links', () => {
    const html = renderClaimCardHtml(checkClaim('Trump strikes diesel deal with Putin', search('Trump strikes diesel deal with Putin')), NOW);
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('.vc-card')?.classList.contains('vc-corroborated')).toBe(true);
    expect(host.querySelector('.vc-verdict-title')?.textContent).toMatch(/^Reported by \d+ independent publishers$/);
    expect(host.textContent).toContain('BBC');
    expect(host.textContent).toContain('State media');
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toContain('Kremlin hails <b>diesel</b> deal');
  });

  it('one publisher on two feeds is single-publisher, and an unstated figure is listed as not stated', () => {
    const host = document.createElement('div');
    host.innerHTML = renderClaimCardHtml(checkClaim('Panama earthquake kills 200', search('Panama earthquake kills 200')), NOW);
    expect(host.querySelector('.vc-card')?.classList.contains('vc-single')).toBe(true);
    expect(host.querySelector('.vc-verdict-title')?.textContent).toBe('Only one publisher is reporting this');
    expect(host.querySelector('.fig-ungrounded')?.textContent).toContain('200');
    expect(host.textContent).toContain('via Reuters World, Reuters');
  });

  it('a claim nobody carries is not found, and the page never says false or fake', () => {
    const html = renderClaimCardHtml(checkClaim('Mars colony declares independence from Earth', search('Mars colony declares independence from Earth')), NOW);
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('.vc-verdict-title')?.textContent).toBe('Not in WorldMonitor\'s current sources');
    expect(host.textContent).toContain('does not make it false');
    expect(host.textContent).not.toMatch(/\bfake\b|\bdebunked\b|\bis false\b|\bverified true\b/i);
    expect(host.querySelector('.hl-list')).toBeNull();
  });
});

const FACT_CHECKS: FactCheckResult = {
  state: 'ok',
  caveat: FACT_CHECK_CAVEAT,
  factChecks: [
    {
      publisher: 'PolitiFact', site: 'politifact.com', rating: 'False', reviewedAt: '2026-10-03T00:00:00.000Z',
      url: 'https://www.politifact.com/factchecks/2026/oct/03/x/', title: 'No, Russia did not agree to that',
      claimReviewed: 'Russia agreed to supply diesel to the US',
    },
    {
      publisher: 'Full Fact <script>', site: 'fullfact.org', rating: 'Missing context', reviewedAt: '2026-09-28T00:00:00.000Z',
      url: 'javascript:alert(1)', title: '', claimReviewed: 'Russia will <b>supply</b> US diesel',
    },
  ],
};

describe('published fact-checks on /verify (#9094)', () => {
  const render = (result: FactCheckResult | null) => {
    const host = document.createElement('div');
    host.innerHTML = renderFactChecksHtml(result);
    return host;
  };

  it('uses the server wording for the similar-claim label', () => {
    expect(FACT_CHECK_LABEL).toBe(SERVER_FACT_CHECK_LABEL);
  });

  it('quotes each rating with the fact-checker, date and link, as a similar claim', () => {
    const host = render(FACT_CHECKS);
    const items = host.querySelectorAll('.fc-list li');
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector('.fc-label')?.textContent).toBe('A published fact-check of a similar claim');
    expect(items[0]!.querySelector('.fc-rating')?.textContent).toBe('Rated “False” by PolitiFact on 3 Oct 2026');
    expect((items[0]!.querySelector('.fc-rating a') as HTMLAnchorElement).href).toBe('https://www.politifact.com/factchecks/2026/oct/03/x/');
    expect(items[0]!.textContent).toContain('Claim they rated: “Russia agreed to supply diesel to the US”');
    expect(host.querySelector('.vc-caveat')?.textContent).toBe(FACT_CHECK_CAVEAT);
  });

  it('keeps disagreeing ratings side by side, escapes every string, and drops unsafe links', () => {
    const host = render(FACT_CHECKS);
    expect(host.querySelectorAll('.fc-rating strong')[1]?.textContent).toBe('“Missing context”');
    expect(host.querySelector('script, b')).toBeNull();
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host.textContent).toContain('Full Fact <script>');
  });

  it('says when the lookup did not run, and never reads that as none found', () => {
    expect(render({ state: 'unavailable', factChecks: [], caveat: '' }).textContent).toContain('could not be checked right now');
    expect(render({ state: 'not-configured', factChecks: [], caveat: '' }).textContent).toContain('could not be checked right now');
    expect(render({ state: 'ok', factChecks: [], caveat: FACT_CHECK_CAVEAT }).textContent).toContain('No published fact-check of a similar claim was found');
    expect(render(null).textContent).toContain('Looking for published fact-checks');
  });

  it('never grades the claim in WorldMonitor\'s own words', () => {
    for (const result of [FACT_CHECKS, { state: 'ok' as const, factChecks: [], caveat: FACT_CHECK_CAVEAT }]) {
      const text = render(result).textContent ?? '';
      expect(text.replace(/Rated “[^”]*”/g, '')).not.toMatch(/\bfalse\b|\bfake\b|\bdebunked\b|\btrue\b/i);
    }
  });
});


const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const isSearch = (input: unknown) => String(input).startsWith(`${CLAIM_HEADLINES_URL}?`);
const claimOf = (input: unknown) => new URL(String(input), 'https://www.worldmonitor.app').searchParams.get('claim') ?? '';

// Claim searches get the fake server's answer, fact-check lookups get FACT_CHECKS.
async function defaultFetch(input: unknown): Promise<Response> {
  return json(String(input).startsWith(FACT_CHECKS_URL) ? FACT_CHECKS : searchBody(claimOf(input)));
}

describe('/verify page bootstrap', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = pageBody();
    fetchMock = vi.fn(defaultFetch);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
    document.body.innerHTML = '';
  });

  const searchCalls = () => fetchMock.mock.calls.filter(([input]) => isSearch(input));
  const factCheckCalls = () => fetchMock.mock.calls.filter(([input]) => String(input).startsWith(FACT_CHECKS_URL));

  it('checks the ?claim= link on load with one public claim search', async () => {
    history.replaceState(null, '', '/verify?claim=Trump%20strikes%20diesel%20deal%20with%20Putin');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.querySelector('.vc-card')).not.toBeNull());
    expect((document.getElementById('claimInput') as HTMLTextAreaElement).value).toBe('Trump strikes diesel deal with Putin');
    expect(document.querySelector('.vc-card')?.classList.contains('vc-corroborated')).toBe(true);
    expect(document.getElementById('digestStatus')?.textContent).toMatch(/^Searching 6 live headlines from 5 feeds/);
    expect(searchCalls().map(([input]) => String(input))).toEqual([`${CLAIM_HEADLINES_URL}?claim=Trump%20strikes%20diesel%20deal%20with%20Putin`]);
    expect(searchCalls()[0]![1]).toMatchObject({ credentials: 'omit' });
    // #9094: one fact-check lookup for the claim, rendered below the coverage card.
    expect(factCheckCalls().map(([input]) => String(input))).toEqual([`${FACT_CHECKS_URL}?claim=Trump%20strikes%20diesel%20deal%20with%20Putin`]);
    expect(factCheckCalls()[0]![1]).toMatchObject({ credentials: 'omit' });
    await vi.waitFor(() => expect(document.querySelectorAll('.fc-list li')).toHaveLength(2));
    const card = document.querySelector('.vc-card')!;
    expect(card.compareDocumentPosition(document.querySelector('.vc-factchecks')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('without a claim it shows the counts; a submitted claim searches for it and updates the shareable URL', async () => {
    history.replaceState(null, '', '/verify');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.getElementById('digestStatus')?.textContent).toMatch(/^Searching 6 live headlines/));
    expect(searchCalls().map(([input]) => claimOf(input))).toEqual(['']);
    (document.getElementById('claimInput') as HTMLTextAreaElement).value = 'Panama earthquake kills 200';
    (document.getElementById('verifyForm') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(document.querySelector('.vc-card')).not.toBeNull());
    expect(new URLSearchParams(location.search).get('claim')).toBe('Panama earthquake kills 200');
    expect(document.querySelector('.vc-card')?.classList.contains('vc-single')).toBe(true);
    expect(searchCalls().map(([input]) => claimOf(input))).toEqual(['', 'Panama earthquake kills 200']);
  });

  it('a claim the search finds nothing for is not found, not unknown', async () => {
    history.replaceState(null, '', '/verify?claim=Mars%20colony%20declares%20independence');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.querySelector('.vc-verdict-title')).not.toBeNull());
    expect(document.querySelector('.vc-verdict-title')?.textContent).toBe('Not in WorldMonitor\'s current sources');
  });

  it('navigating away from a pending check drops its result', async () => {
    let release!: () => void;
    let hold = true;
    fetchMock.mockImplementation((input: unknown) => {
      if (!isSearch(input) || !hold) return defaultFetch(input);
      hold = false;
      return new Promise<Response>((resolve) => {
        release = () => resolve(json(searchBody(claimOf(input))));
      });
    });
    history.replaceState(null, '', '/verify?claim=Trump%20strikes%20diesel%20deal%20with%20Putin');
    await import('@/verify-main');
    history.replaceState(null, '', '/verify');
    window.dispatchEvent(new PopStateEvent('popstate'));
    release();
    await vi.waitFor(() => expect(document.getElementById('digestStatus')?.textContent).toMatch(/^Searching/));
    expect(document.querySelector('.vc-card')).toBeNull();
    expect(document.querySelector('.vc-factchecks')).toBeNull();
    expect((document.getElementById('claimInput') as HTMLTextAreaElement).value).toBe('');
    expect((document.getElementById('verifySubmit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('an older search that finishes after a newer one failed does not overwrite the status', async () => {
    let release!: () => void;
    fetchMock.mockImplementation((input: unknown) => {
      if (!isSearch(input)) return defaultFetch(input);
      const claim = claimOf(input);
      if (claim === 'Trump strikes diesel deal with Putin') {
        return new Promise<Response>((resolve) => { release = () => resolve(json(searchBody(claim))); });
      }
      return Promise.resolve(json({}, 503));
    });
    history.replaceState(null, '', '/verify?claim=Trump%20strikes%20diesel%20deal%20with%20Putin');
    await import('@/verify-main');
    (document.getElementById('claimInput') as HTMLTextAreaElement).value = 'Panama earthquake kills 200';
    (document.getElementById('verifyForm') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(document.querySelector('.vc-error')).not.toBeNull());
    expect(document.getElementById('digestStatus')?.textContent).toBe('The live headlines are unavailable right now.');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.getElementById('digestStatus')?.textContent).toBe('The live headlines are unavailable right now.');
    expect(document.querySelector('.vc-card')).toBeNull();
  });

  it('shows the claim as it is checked: trimmed, then capped', async () => {
    const long = `   ${'diesel '.repeat(60)}`;
    history.replaceState(null, '', `/verify?claim=${encodeURIComponent(long)}`);
    await import('@/verify-main');
    const value = (document.getElementById('claimInput') as HTMLTextAreaElement).value;
    expect(value).toBe(long.trim().slice(0, 300));
    await vi.waitFor(() => expect(document.querySelector('.vc-claim')?.textContent).toBe(`“${value}”`));
  });

  it('a failed or unavailable search shows an error, not a verdict, and the next check searches again', async () => {
    const failures = [json({}, 503), json({ ...searchBody(''), state: 'unavailable', searchedHeadlines: 0 })];
    fetchMock.mockImplementation(async (input: unknown) => (isSearch(input) && failures.length ? failures.shift()! : defaultFetch(input)));
    history.replaceState(null, '', '/verify?claim=Trump%20strikes%20diesel%20deal');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.querySelector('.vc-error')).not.toBeNull());
    expect(document.querySelector('.vc-card')).toBeNull();
    expect(document.getElementById('digestStatus')?.textContent).toBe('The live headlines are unavailable right now.');
    (document.getElementById('verifyForm') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(searchCalls()).toHaveLength(2));
    await vi.waitFor(() => expect(document.querySelector('.vc-error')).not.toBeNull());
    expect(document.querySelector('.vc-verdict-title')).toBeNull();
    (document.getElementById('verifyForm') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(document.querySelector('.vc-card')).not.toBeNull());
    expect(searchCalls()).toHaveLength(3);
  });

  it('the coverage card does not wait for fact-checks, and a failed lookup is shown as not checked', async () => {
    let release!: () => void;
    fetchMock.mockImplementation((input: unknown) => String(input).startsWith(FACT_CHECKS_URL)
      ? new Promise<Response>((resolve) => { release = () => resolve(new Response('{}', { status: 503 })); })
      : defaultFetch(input));
    history.replaceState(null, '', '/verify?claim=Trump%20strikes%20diesel%20deal%20with%20Putin');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.querySelector('.vc-card')).not.toBeNull());
    expect(document.querySelector('.vc-factchecks')?.textContent).toContain('Looking for published fact-checks');
    release();
    await vi.waitFor(() => expect(document.querySelector('.vc-factchecks')?.textContent).toContain('could not be checked right now'));
    expect(document.querySelector('.vc-card')?.classList.contains('vc-corroborated')).toBe(true);
  });
});

describe('/verify media check (#9096)', () => {
  const doneResult = {
    url: 'https://example.com/a.jpg',
    mediaType: 'image/jpeg',
    bytes: 204_800,
    sha256: 'a'.repeat(64),
    fetchedAt: '2026-10-16T12:00:00.000Z',
    credentials: {
      state: 'found', signer: '<img src=x onerror="window.__pwned=1">Newsroom', signerCommonName: 'CN', signerTrust: 'trusted',
      claimGenerator: 'Camera <b>App</b>', signedAt: '2026-10-15T08:30:00Z',
      actions: [{ action: 'c2pa.created', softwareAgent: 'Model', digitalSourceType: '' }, { action: 'c2pa.cropped', softwareAgent: '', digitalSourceType: '' }],
      declaresAiGeneration: true, ingredientCount: 1, validationState: 'trusted', contentChangedAfterSigning: false, failureCodes: [],
    },
    earliest: {
      state: 'ok', provider: 'TinEye', totalMatches: 4, searchedAt: '2026-10-16T12:00:01.000Z',
      copies: [
        { domain: 'example.org', pageUrl: 'https://example.org/first', crawlDate: '2024-03-03' },
        { domain: 'evil.example', pageUrl: 'javascript:alert(1)', crawlDate: '2025-01-01' },
      ],
    },
    caveats: ['Caveat A.', 'Caveat B.'],
  };

  it('recognises a pasted media link, not a claim that mentions one', async () => {
    const { isMediaCheckInput } = await import('@/services/media-provenance');
    expect(isMediaCheckInput('  https://example.com/a.jpg ')).toBe(true);
    expect(isMediaCheckInput('Is https://example.com/a.jpg real?')).toBe(false);
    expect(isMediaCheckInput('ftp://example.com/a.jpg')).toBe(false);
    expect(isMediaCheckInput('Panama earthquake kills 200')).toBe(false);
  });

  it('renders the result escaped, oldest copy first, with no verdict wording', async () => {
    const { renderMediaCheckHtml } = await import('@/components/media-card');
    const host = document.createElement('div');
    host.innerHTML = renderMediaCheckHtml({ kind: 'done', result: doneResult as never });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.mc-headline strong')?.textContent).toBe('<img src=x onerror="window.__pwned=1">Newsroom');
    expect(host.textContent).toContain('The credentials say this was made with a generative AI model.');
    expect(host.textContent).toContain('Earliest copy TinEye has seen: 2024-03-03, example.org');
    expect(host.querySelector('a[href^="javascript"]')).toBeNull();
    expect(host.querySelectorAll('.mc-copies li')).toHaveLength(2);
    expect([...host.querySelectorAll('.vc-caveat')].map((n) => n.textContent)).toEqual(['Caveat A.', 'Caveat B.']);
    expect(host.textContent).not.toMatch(/\b(authentic|fake|verified|original)\b/i);
  });

  it('treats missing credentials as ordinary and names every unavailable state', async () => {
    const { renderMediaCheckHtml } = await import('@/components/media-card');
    const { MEDIA_WORDING } = await import('../../shared/media-provenance-contract.js');
    const host = document.createElement('div');
    const none = { ...doneResult, credentials: { ...doneResult.credentials, state: 'none' }, earliest: { ...doneResult.earliest, state: 'cap-reached', copies: [] } };
    host.innerHTML = renderMediaCheckHtml({ kind: 'done', result: none as never });
    expect(host.textContent).toContain(MEDIA_WORDING.noCredentials);
    expect(host.textContent).toContain(MEDIA_WORDING.earliestCapReached);
    const unverified = { ...doneResult, credentials: { ...doneResult.credentials, signer: 'Reuters', signerTrust: 'unknown' } };
    host.innerHTML = renderMediaCheckHtml({ kind: 'done', result: unverified as never });
    expect(host.querySelector('.mc-headline')?.textContent).toBe('Content credentials found. They name the signer as Reuters.');
    const invalid = { ...doneResult, credentials: { ...doneResult.credentials, validationState: 'invalid', failureCodes: ['claimSignature.mismatch'] } };
    host.innerHTML = renderMediaCheckHtml({ kind: 'done', result: invalid as never });
    expect(host.querySelector('.mc-warning')?.textContent).toBe(MEDIA_WORDING.failedValidation);
    host.innerHTML = renderMediaCheckHtml({ kind: 'done', result: { ...invalid, credentials: { ...invalid.credentials, contentChangedAfterSigning: true } } as never });
    expect([...host.querySelectorAll('.mc-warning')].map((n) => n.textContent)).toEqual([MEDIA_WORDING.changedAfterSigning]);
    host.innerHTML = renderMediaCheckHtml({ kind: 'needs-sign-in' });
    expect(host.querySelector('[data-media-signin]')).not.toBeNull();
    host.innerHTML = renderMediaCheckHtml({ kind: 'needs-pro' });
    expect(host.querySelector('a.mc-upgrade')?.getAttribute('href')).toBe('/pro');
  });

  it('queues the check, polls its status URL and maps the access answers', async () => {
    const { checkMediaUrl } = await import('@/services/media-provenance');
    const statusUrl = '/api/news/v1/get-media-provenance?job_id=media%3A1%3Aabc';
    const replies = [
      new Response(JSON.stringify({ jobId: 'media:1:abc', status: 'pending', statusUrl }), { status: 200 }),
      new Response(JSON.stringify({ status: 'pending', error: '' })),
      new Response(JSON.stringify({ status: 'done', error: '', result: doneResult })),
    ];
    const seen: Array<[string, RequestInit | undefined]> = [];
    const outcome = await checkMediaUrl(' https://example.com/a.jpg ', {
      fetch: async (input, init) => { seen.push([input, init]); return replies.shift()!; },
      sleep: async () => {},
    });
    expect(outcome.kind).toBe('done');
    expect(seen[0]![0]).toBe('/api/news/v1/check-media-provenance');
    expect(JSON.parse(String(seen[0]![1]!.body))).toEqual({ url: 'https://example.com/a.jpg' });
    expect(seen.slice(1).map(([url]) => url)).toEqual([statusUrl, statusUrl]);

    const once = (status: number, body: unknown = {}) => ({ fetch: async () => new Response(JSON.stringify(body), { status }), sleep: async () => {} });
    expect(await checkMediaUrl('https://example.com/a.jpg', once(401))).toEqual({ kind: 'needs-sign-in' });
    expect(await checkMediaUrl('https://example.com/a.jpg', once(403))).toEqual({ kind: 'needs-pro' });
    expect(await checkMediaUrl('https://example.com/a.jpg', once(400, { violations: [{ field: 'url', description: 'url must use http or https' }] })))
      .toEqual({ kind: 'failed', error: 'Url must use http or https.' });
    expect(await checkMediaUrl('https://example.com/a.jpg', once(200, { statusUrl: 'https://evil.example/poll' }))).toEqual({ kind: 'unavailable' });
  });
});

function submitForm(): void {
  (document.getElementById('verifyForm') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
}

describe('/verify page media flow (#9096)', () => {
  it('fills in a media link from a shared URL but checks it only on a click', async () => {
    const check = vi.fn(async () => ({ kind: 'unavailable' as const }));
    vi.doMock('@/services/media-provenance', async (original) => ({
      ...(await original<typeof import('@/services/media-provenance')>()),
      ensureSignedInState: async () => true,
      checkMediaUrl: check,
    }));
    history.replaceState(null, '', `/verify?claim=${encodeURIComponent('https://example.com/a.jpg')}`);
    await import('@/verify-main');
    expect((document.getElementById('claimInput') as HTMLTextAreaElement).value).toBe('https://example.com/a.jpg');
    expect(document.getElementById('digestStatus')?.textContent).toContain('Check image or video');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(check).not.toHaveBeenCalled();
    submitForm();
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
  });

  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = pageBody();
    vi.stubGlobal('fetch', vi.fn(defaultFetch));
  });

  afterEach(() => {
    vi.doUnmock('@/services/media-provenance');
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
    document.body.innerHTML = '';
  });

  it('asks a signed-out visitor to sign in, and runs no coverage or fact-check lookup', async () => {
    const openSignIn = vi.fn(async () => {});
    vi.doMock('@/services/media-provenance', async (original) => ({
      ...(await original<typeof import('@/services/media-provenance')>()),
      ensureSignedInState: async () => false,
      openMediaSignIn: openSignIn,
    }));
    history.replaceState(null, '', `/verify?claim=${encodeURIComponent('https://example.com/a.jpg')}`);
    await import('@/verify-main');
    submitForm();
    await vi.waitFor(() => expect(document.querySelector('[data-media-signin]')).not.toBeNull());
    expect(document.querySelector('.vc-card')).toBeNull();
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([input]) => String(input).startsWith(FACT_CHECKS_URL))).toBe(false);
    (document.querySelector('[data-media-signin]') as HTMLButtonElement).click();
    expect(openSignIn).toHaveBeenCalledOnce();
    expect((document.getElementById('claimInput') as HTMLTextAreaElement).value).toBe('https://example.com/a.jpg');
    expect(document.getElementById('verifySubmit')?.textContent).toBe('Check image or video');
  });

  it('shows the result for a signed-in caller', async () => {
    vi.doMock('@/services/media-provenance', async (original) => {
      const actual = await original<typeof import('@/services/media-provenance')>();
      return {
        ...actual,
        ensureSignedInState: async () => true,
        premiumMediaFetch: async () => async () => new Response('{}', { status: 403 }),
      };
    });
    history.replaceState(null, '', `/verify?claim=${encodeURIComponent('https://example.com/a.jpg')}`);
    await import('@/verify-main');
    submitForm();
    await vi.waitFor(() => expect(document.querySelector('a.mc-upgrade')).not.toBeNull());
    expect((document.getElementById('verifySubmit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('reports the check as unavailable when the signed-in client fails to load', async () => {
    vi.doMock('@/services/media-provenance', async (original) => ({
      ...(await original<typeof import('@/services/media-provenance')>()),
      ensureSignedInState: async () => true,
      premiumMediaFetch: async () => { throw new Error('chunk load failed'); },
    }));
    history.replaceState(null, '', `/verify?claim=${encodeURIComponent('https://example.com/a.jpg')}`);
    await import('@/verify-main');
    submitForm();
    await vi.waitFor(() => expect(document.getElementById('result')?.textContent).toContain('could not run right now'));
  });

  it('raises the length limit before a long link is pasted, so it is not cut', async () => {
    await import('@/verify-main');
    const input = document.getElementById('claimInput') as HTMLTextAreaElement;
    expect(input.maxLength).toBeLessThan(2048);
    const paste = new Event('paste', { cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { getData: () => `https://cdn.example.com/a.jpg?sig=${'x'.repeat(900)}` };
    input.dispatchEvent(paste);
    expect(input.maxLength).toBe(2048);
  });
});
