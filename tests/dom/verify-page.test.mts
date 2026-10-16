/**
 * #9092: the /verify page. It reads the public digest once, builds the same
 * card the verify_claim MCP tool returns, and never calls a claim true or false.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FACT_CHECK_LABEL, renderClaimCardHtml, renderFactChecksHtml } from '@/components/claim-card';
import { checkClaim, claimDigestFromBody, FACT_CHECKS_URL, VERIFY_DIGEST_URL, type FactCheckResult } from '@/services/verify-claim';
import { FACT_CHECK_CAVEAT, FACT_CHECK_LABEL as SERVER_FACT_CHECK_LABEL } from '../../server/_shared/fact-checks';
import { isPublicSharedRpcRequest } from '@/shared/public-rpc-cache';
import { buildClaimCard } from '../../server/_shared/claim-match';

const NOW = Date.parse('2026-10-09T21:00:00Z');
const T0 = Date.parse('2026-10-09T18:00:00Z');

function proto(source: string, title: string, link: string, publishedAt = T0) {
  return { source, title, link, publishedAt, isAlert: false };
}

const BODY = {
  generatedAt: '2026-10-09T20:55:00.000Z',
  categories: {
    world: {
      items: [
        proto('Reuters', 'Trump strikes diesel deal with Putin', 'https://n.test/1'),
        proto('BBC World', 'Trump says Russia will supply diesel in deal with Putin', 'https://n.test/2', T0 + 3_600_000),
        proto('Reuters World', 'Panama earthquake: 12 dead, toll expected to rise', 'https://n.test/3'),
        proto('Reuters', 'Panama earthquake: 12 dead, toll expected to rise', 'https://n.test/4'),
        proto('RT', 'Kremlin hails <b>diesel</b> deal with Trump as Putin win', 'javascript:alert(1)'),
      ],
    },
    // The same story in a second category must count once.
    europe: { items: [proto('Reuters', 'Trump strikes diesel deal with Putin', 'https://n.test/1')] },
  },
};

// The real page markup, parsed (not regex-stripped), without its entry script.
function pageBody(): string {
  const page = new DOMParser().parseFromString(readFileSync(resolve(import.meta.dirname, '../../verify.html'), 'utf8'), 'text/html');
  for (const script of page.querySelectorAll('script')) script.remove();
  return page.body.innerHTML;
}

describe('claim card on /verify', () => {
  const digest = claimDigestFromBody(BODY);

  it('reads the digest on its public, caller-invariant cache key', () => {
    expect(isPublicSharedRpcRequest(new URL(VERIFY_DIGEST_URL, 'https://www.worldmonitor.app'))).toBe(true);
  });

  it('dedupes digest items across categories', () => {
    expect(digest.items).toHaveLength(5);
    expect(digest.generatedAt).toBe(BODY.generatedAt);
  });

  it('builds exactly the card the MCP tool builds', () => {
    const claim = 'Trump strikes diesel deal with Putin';
    expect(checkClaim(`  ${claim}  `, digest)).toEqual(buildClaimCard(claim, digest.items));
  });

  it('corroborated: names the independent publishers, flags state media, and drops unsafe links', () => {
    const html = renderClaimCardHtml(checkClaim('Trump strikes diesel deal with Putin', digest), NOW);
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
    host.innerHTML = renderClaimCardHtml(checkClaim('Panama earthquake kills 200', digest), NOW);
    expect(host.querySelector('.vc-card')?.classList.contains('vc-single')).toBe(true);
    expect(host.querySelector('.vc-verdict-title')?.textContent).toBe('Only one publisher is reporting this');
    expect(host.querySelector('.fig-ungrounded')?.textContent).toContain('200');
    expect(host.textContent).toContain('via Reuters World, Reuters');
  });

  it('a claim nobody carries is not found, and the page never says false or fake', () => {
    const html = renderClaimCardHtml(checkClaim('Mars colony declares independence from Earth', digest), NOW);
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

// Digest reads get the digest, fact-check lookups get FACT_CHECKS.
async function defaultFetch(input: unknown): Promise<Response> {
  const body = String(input).startsWith(FACT_CHECKS_URL) ? FACT_CHECKS : BODY;
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

  const digestCalls = () => fetchMock.mock.calls.filter(([input]) => String(input) === VERIFY_DIGEST_URL);
  const factCheckCalls = () => fetchMock.mock.calls.filter(([input]) => String(input).startsWith(FACT_CHECKS_URL));

  it('checks the ?claim= link on load with one public digest read', async () => {
    history.replaceState(null, '', '/verify?claim=Trump%20strikes%20diesel%20deal%20with%20Putin');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.querySelector('.vc-card')).not.toBeNull());
    expect((document.getElementById('claimInput') as HTMLTextAreaElement).value).toBe('Trump strikes diesel deal with Putin');
    expect(document.querySelector('.vc-card')?.classList.contains('vc-corroborated')).toBe(true);
    expect(document.getElementById('digestStatus')?.textContent).toMatch(/^Searching 5 live headlines from 4 feeds/);
    expect(digestCalls()).toHaveLength(1);
    expect(digestCalls()[0]![1]).toMatchObject({ credentials: 'omit' });
    // #9094: one fact-check lookup for the claim, rendered below the coverage card.
    expect(factCheckCalls().map(([input]) => String(input))).toEqual([`${FACT_CHECKS_URL}?claim=Trump%20strikes%20diesel%20deal%20with%20Putin`]);
    expect(factCheckCalls()[0]![1]).toMatchObject({ credentials: 'omit' });
    await vi.waitFor(() => expect(document.querySelectorAll('.fc-list li')).toHaveLength(2));
    const card = document.querySelector('.vc-card')!;
    expect(card.compareDocumentPosition(document.querySelector('.vc-factchecks')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a submitted claim updates the shareable URL and reuses the loaded digest', async () => {
    history.replaceState(null, '', '/verify');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.getElementById('digestStatus')?.textContent).toMatch(/^Searching/));
    (document.getElementById('claimInput') as HTMLTextAreaElement).value = 'Panama earthquake kills 200';
    (document.getElementById('verifyForm') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(document.querySelector('.vc-card')).not.toBeNull());
    expect(new URLSearchParams(location.search).get('claim')).toBe('Panama earthquake kills 200');
    expect(document.querySelector('.vc-card')?.classList.contains('vc-single')).toBe(true);
    expect(digestCalls()).toHaveLength(1);
  });

  it('navigating away from a pending check drops its result', async () => {
    let release!: () => void;
    let holdDigest = true;
    fetchMock.mockImplementation((input: unknown) => {
      if (String(input) !== VERIFY_DIGEST_URL || !holdDigest) return defaultFetch(input);
      holdDigest = false;
      return new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify(BODY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
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

  it('shows the claim as it is checked: trimmed, then capped', async () => {
    const long = `   ${'diesel '.repeat(60)}`;
    history.replaceState(null, '', `/verify?claim=${encodeURIComponent(long)}`);
    await import('@/verify-main');
    const value = (document.getElementById('claimInput') as HTMLTextAreaElement).value;
    expect(value).toBe(long.trim().slice(0, 300));
    await vi.waitFor(() => expect(document.querySelector('.vc-claim')?.textContent).toBe(`“${value}”`));
  });

  it('a failed digest read shows an error, not a verdict, and retries on the next check', async () => {
    let failDigest = true;
    fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input) === VERIFY_DIGEST_URL && failDigest) {
        failDigest = false;
        return new Response('{}', { status: 503 });
      }
      return defaultFetch(input);
    });
    history.replaceState(null, '', '/verify?claim=Trump%20strikes%20diesel%20deal');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.querySelector('.vc-error')).not.toBeNull());
    expect(document.querySelector('.vc-card')).toBeNull();
    (document.getElementById('verifyForm') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(document.querySelector('.vc-card')).not.toBeNull());
    expect(digestCalls().length).toBeGreaterThanOrEqual(2);
  });

  it('the coverage card does not wait for fact-checks, and a failed lookup is shown as not checked', async () => {
    let release!: () => void;
    fetchMock.mockImplementation((input: unknown) => String(input).startsWith(FACT_CHECKS_URL)
      ? new Promise<Response>((resolve) => { release = () => resolve(new Response('{}', { status: 503 })); })
      : Promise.resolve(new Response(JSON.stringify(BODY), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    history.replaceState(null, '', '/verify?claim=Trump%20strikes%20diesel%20deal%20with%20Putin');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.querySelector('.vc-card')).not.toBeNull());
    expect(document.querySelector('.vc-factchecks')?.textContent).toContain('Looking for published fact-checks');
    release();
    await vi.waitFor(() => expect(document.querySelector('.vc-factchecks')?.textContent).toContain('could not be checked right now'));
    expect(document.querySelector('.vc-card')?.classList.contains('vc-corroborated')).toBe(true);
  });
});
