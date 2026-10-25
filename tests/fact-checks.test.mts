// #9094: published fact-checks are cited, never restated. Only IFCN-verified
// fact-checkers, only strong matches, every rating with its fact-checker, date
// and link, and rules that apply the same whoever made the claim.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  FACT_CHECKER_DOMAINS,
  FACT_CHECK_API_KEY_ENV,
  FACT_CHECK_CAVEAT,
  FACT_CHECK_MAX_RESULTS,
  claimCanMatchFactChecks,
  compactApiClaims,
  factCheckSearchUrl,
  factCheckerDomainFor,
  isStrongFactCheckMatch,
  selectFactChecks,
  type FactCheckApiClaim,
} from '../server/_shared/fact-checks.ts';
import { searchFactChecks } from '../server/worldmonitor/news/v1/search-fact-checks.ts';
import { factCheckCacheKey, factCheckQuery } from '../server/_shared/fact-check-search.ts';

const CLAIM = 'Russia agreed to supply diesel fuel to the United States';

function review(overrides: Record<string, string> = {}) {
  return {
    publisher: { name: 'PolitiFact', site: 'politifact.com' },
    url: 'https://www.politifact.com/factchecks/2026/oct/03/x/',
    title: 'No, Russia did not agree to that',
    reviewDate: '2026-10-03T00:00:00Z',
    textualRating: 'False',
    languageCode: 'en',
    ...overrides,
  };
}

function apiClaim(text: string, reviews: ReturnType<typeof review>[]): FactCheckApiClaim {
  return { text, claimReview: reviews };
}

describe('IFCN allowlist', () => {
  it('is the IFCN verified-signatories list, normalized, with its source recorded', () => {
    const file = JSON.parse(readFileSync(new URL('../shared/fact-checkers.json', import.meta.url), 'utf8'));
    assert.match(file.source, /github\.com\/IFCN\/verified-signatories/);
    assert.match(file.sourceCommit, /^[0-9a-f]{40}$/);
    assert.ok(file.domains.length >= 100, 'the full signatory list, not a hand-picked subset');
    assert.deepEqual(file.domains, [...file.domains].sort(), 'sorted, so a refresh diff is reviewable');
    for (const domain of file.domains) {
      assert.equal(domain, domain.toLowerCase().replace(/^www\./, ''), domain);
      assert.ok(FACT_CHECKER_DOMAINS.has(domain));
    }
  });

  it('accepts a signatory\'s own links and subdomains, nothing else', () => {
    assert.equal(factCheckerDomainFor('https://www.politifact.com/factchecks/x'), 'politifact.com');
    assert.equal(factCheckerDomainFor('https://fullfact.org/online/x'), 'fullfact.org');
    assert.equal(factCheckerDomainFor('https://factcheck.afp.com/doc.afp.com.1'), 'factcheck.afp.com');
    assert.equal(factCheckerDomainFor('https://es.factcheck.afp.com/x'), 'factcheck.afp.com');
    for (const url of [
      'https://politifact.com.evil.example/x',
      'https://notpolitifact.com/x',
      'https://example.com/?u=politifact.com',
      'javascript:alert(1)',
      'ftp://politifact.com/x',
      'not a url',
      '',
    ]) assert.equal(factCheckerDomainFor(url), null, url);
  });
});

describe('strong matching', () => {
  it('matches a fact-check of the same claim in other words', () => {
    assert.equal(isStrongFactCheckMatch(CLAIM, 'Russia will supply diesel fuel to the United States'), true);
  });

  it('rejects a related but different claim, in either direction', () => {
    assert.equal(isStrongFactCheckMatch(CLAIM, 'Russia raises diesel export tax'), false);
    assert.equal(isStrongFactCheckMatch('Russia diesel', CLAIM), false);
    assert.equal(
      isStrongFactCheckMatch(CLAIM, 'Russia agreed to supply diesel fuel to the United States, China, India, Brazil, Turkey and the European Union at a discount'),
      false,
      'a much longer reviewed claim carries far more than the claim checked',
    );
  });

  it('a claim with fewer than three content words never reaches the API', () => {
    assert.equal(claimCanMatchFactChecks('diesel deal'), false);
    assert.equal(claimCanMatchFactChecks(CLAIM), true);
  });
});

describe('selectFactChecks', () => {
  it('keeps every rating with fact-checker, date and link, newest first, disagreements included', () => {
    const selected = selectFactChecks(CLAIM, [
      apiClaim('Russia will supply diesel fuel to the United States', [
        review(),
        review({ url: 'https://fullfact.org/x', publisher: { name: 'Full Fact', site: 'fullfact.org' } as never, textualRating: 'Missing context', reviewDate: '2026-10-05T12:00:00Z' }),
      ]),
    ]);
    assert.deepEqual(selected.map((c) => [c.publisher, c.rating, c.reviewedAt]), [
      ['Full Fact', 'Missing context', '2026-10-05T12:00:00.000Z'],
      ['PolitiFact', 'False', '2026-10-03T00:00:00.000Z'],
    ]);
    assert.equal(selected[1]!.url, 'https://www.politifact.com/factchecks/2026/oct/03/x/');
    assert.equal(selected[1]!.site, 'politifact.com');
    assert.equal(selected[1]!.claimReviewed, 'Russia will supply diesel fuel to the United States');
  });

  it('passes the rating through verbatim, never mapped onto a scale', () => {
    const [check] = selectFactChecks(CLAIM, [apiClaim(CLAIM, [review({ textualRating: 'Four Pinocchios' })])]);
    assert.equal(check!.rating, 'Four Pinocchios');
  });

  it('drops non-allowlisted links, non-English reviews, and reviews without a rating or date', () => {
    const selected = selectFactChecks(CLAIM, [apiClaim(CLAIM, [
      review({ url: 'https://random-blog.example/x' }),
      review({ url: 'https://www.politifact.com/es/x', languageCode: 'es' }),
      review({ url: 'https://www.politifact.com/a', textualRating: '' }),
      review({ url: 'https://www.politifact.com/b', reviewDate: '' }),
      review({ url: 'https://www.politifact.com/c', languageCode: 'en-US' }),
    ])]);
    assert.deepEqual(selected.map((c) => c.url), ['https://www.politifact.com/c']);
  });

  it('the link decides the fact-checker, not the name the feed reports', () => {
    const selected = selectFactChecks(CLAIM, [apiClaim(CLAIM, [
      review({ url: 'https://impostor.example/x', publisher: { name: 'PolitiFact', site: 'politifact.com' } as never }),
    ])]);
    assert.equal(selected.length, 0);
  });

  it('shows nothing for a weak match', () => {
    assert.deepEqual(selectFactChecks(CLAIM, [apiClaim('Diesel prices rise in Texas', [review()])]), []);
  });

  it('keeps old ratings (dated) and caps the list', () => {
    const reviews = Array.from({ length: FACT_CHECK_MAX_RESULTS + 3 }, (_, i) =>
      review({ url: `https://www.politifact.com/${i}`, reviewDate: new Date(Date.UTC(2015 + i, 0, 1)).toISOString() }));
    const selected = selectFactChecks(CLAIM, [apiClaim(CLAIM, reviews)]);
    assert.equal(selected.length, FACT_CHECK_MAX_RESULTS);
    assert.equal(selected[0]!.reviewedAt.slice(0, 4), String(2015 + FACT_CHECK_MAX_RESULTS + 2));
    assert.ok(selected.at(-1)!.reviewedAt < selected[0]!.reviewedAt);
  });

  it('quotes a rating whole, and drops one too long to quote whole rather than cutting it', () => {
    const sentence = 'Misleading: the deal covers diesel only for military use and was never signed by either government';
    const [kept] = selectFactChecks(CLAIM, [apiClaim(CLAIM, [review({ textualRating: sentence })])]);
    assert.equal(kept!.rating, sentence);
    const essay = 'Mostly false. '.repeat(20);
    assert.deepEqual(selectFactChecks(CLAIM, [apiClaim(CLAIM, [review({ textualRating: essay })])]), []);
    assert.deepEqual(compactApiClaims({ claims: [apiClaim(CLAIM, [review({ textualRating: essay })])] })[0]!.claimReview![0]!.textualRating, '');
  });

  it('matches the whole rated claim: a long one is never matched on its opening alone', () => {
    const longer = `${CLAIM} ${'and other unrelated statements about trade policy and shipping routes '.repeat(4)}`;
    assert.ok(longer.length > 300 && longer.length < 1000);
    assert.deepEqual(selectFactChecks(CLAIM, [apiClaim(longer, [review()])]), [], 'the full claim fails the reverse overlap');
    const huge = `${CLAIM} ${'x'.repeat(1000)}`;
    assert.deepEqual(selectFactChecks(CLAIM, [apiClaim(huge, [review()])]), [], 'too long to match whole: dropped, not cut');
  });

  it('dedupes one fact-check listed under two claims', () => {
    const selected = selectFactChecks(CLAIM, [apiClaim(CLAIM, [review()]), apiClaim(CLAIM, [review()])]);
    assert.equal(selected.length, 1);
  });

  it('selects nothing from a malformed cache entry instead of throwing', () => {
    const malformed = [null, { text: CLAIM, claimReview: 'not a list' }, { text: CLAIM, claimReview: [null] }];
    assert.deepEqual(selectFactChecks(CLAIM, malformed as never), []);
    assert.deepEqual(selectFactChecks(CLAIM, undefined as never), []);
    assert.deepEqual(selectFactChecks(CLAIM, { claims: [] } as never), []);
  });
});

describe('uniform application (#9094)', () => {
  // Same claim shape, different people, parties, countries and sides. The
  // decision to show a fact-check and what it shows must not depend on which.
  const SUBJECTS = [
    'Trump', 'Biden', 'Harris', 'Obama', 'Republicans', 'Democrats', 'Labour', 'Conservatives',
    'Putin', 'Zelensky', 'Netanyahu', 'Hamas', 'Israel', 'Palestinians', 'Modi', 'Xi',
    'Macron', 'Orban', 'Lula', 'Milei', 'Erdogan', 'Iran', 'Ukraine', 'Russia',
  ];
  // [claim, reviewed claim, expected matches]: both outcomes are exercised.
  const TEMPLATES: Array<[claim: string, reviewed: string, matches: number]> = [
    ['SUBJECT said the election was stolen by millions of fake ballots', 'SUBJECT claimed the election was stolen with millions of fake ballots', 1],
    ['SUBJECT cut pension payments for retired teachers last year', 'SUBJECT cut pensions for retired teachers', 1],
    ['Video shows SUBJECT supporters burning flags outside parliament', 'Old video falsely shared as SUBJECT supporters burning flags', 1],
    ['SUBJECT banned imports of wheat', 'Weather report for coastal regions', 0],
  ];

  it('makes the same decision and output for every subject', () => {
    for (const [claimTemplate, reviewedTemplate, matches] of TEMPLATES) {
      const outcomes = new Set<string>();
      for (const subject of SUBJECTS) {
        const claim = claimTemplate.replace('SUBJECT', subject);
        const reviewed = reviewedTemplate.replace('SUBJECT', subject);
        const selected = selectFactChecks(claim, [apiClaim(reviewed, [review({ textualRating: 'Rating as published' })])]);
        assert.equal(selected.length, matches, `${claim} / ${reviewed}`);
        outcomes.add(JSON.stringify(selected.map((c) => ({ ...c, claimReviewed: c.claimReviewed.replace(subject, 'SUBJECT') }))));
      }
      assert.equal(outcomes.size, 1, `"${claimTemplate}" was treated differently for some subjects: ${[...outcomes].join(' | ')}`);
    }
  });

  it('has no per-person, per-party, per-topic or per-country rule in the matching code', () => {
    const source = readFileSync(new URL('../server/_shared/fact-checks.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const subject of SUBJECTS) {
      assert.doesNotMatch(source, new RegExp(`\\b${subject}\\b`, 'i'), `fact-checks.ts names ${subject}`);
    }
  });
});

describe('SearchFactChecks handler', () => {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  let calls: Array<{ url: string; init?: RequestInit }>;
  let upstream: () => Promise<Response>;

  beforeEach(() => {
    calls = [];
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env[FACT_CHECK_API_KEY_ENV] = 'test-key';
    upstream = async () => Response.json({ claims: [apiClaim('Russia will supply diesel fuel to the United States', [review()])] });
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return upstream();
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  const ctx = () => ({ request: new Request('https://example.test/api/news/v1/search-fact-checks'), pathParams: {}, headers: {} });

  it('searches English fact-checks server-side and returns strong allowlisted matches', async () => {
    const response = await searchFactChecks(ctx(), { claim: `  ${CLAIM}  ` });
    assert.equal(response.state, 'ok');
    assert.equal(response.caveat, FACT_CHECK_CAVEAT);
    assert.deepEqual(response.factChecks.map((c) => [c.publisher, c.rating]), [['PolitiFact', 'False']]);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!.url);
    assert.equal(url.origin + url.pathname, 'https://factchecktools.googleapis.com/v1alpha1/claims:search');
    assert.equal(url.searchParams.get('query'), CLAIM);
    assert.equal(url.searchParams.get('languageCode'), 'en');
    assert.equal(url.searchParams.get('key'), 'test-key');
    assert.match(String((calls[0]!.init?.headers as Record<string, string>)['User-Agent']), /worldmonitor/);
  });

  it('without a key it says not-configured and calls nothing', async () => {
    delete process.env[FACT_CHECK_API_KEY_ENV];
    const response = await searchFactChecks(ctx(), { claim: CLAIM });
    assert.deepEqual({ state: response.state, n: response.factChecks.length, calls: calls.length }, { state: 'not-configured', n: 0, calls: 0 });
  });

  it('caches under the exact query sent: a dropped word like "not" is a different search', async () => {
    const safe = factCheckQuery('Scientists say the vaccine is safe');
    const notSafe = factCheckQuery('Scientists say the vaccine is not safe');
    assert.notEqual(await factCheckCacheKey(safe), await factCheckCacheKey(notSafe));
    assert.notEqual(await factCheckCacheKey(factCheckQuery('Strike kills 9')), await factCheckCacheKey(factCheckQuery('Strike kills 90')));
    assert.equal(factCheckQuery('  Kyiv   struck\n overnight '), 'Kyiv struck overnight');
    assert.equal(await factCheckCacheKey('a b'), await factCheckCacheKey(factCheckQuery(' a  b ')), 'whitespace alone does not split the cache');
    await searchFactChecks(ctx(), { claim: `  ${CLAIM}  ` });
    assert.equal(new URL(calls[0]!.url).searchParams.get('query'), factCheckQuery(CLAIM), 'the key is built from the query actually sent');
  });

  it('a claim too short to match strongly is ok with nothing, without spending quota', async () => {
    const response = await searchFactChecks(ctx(), { claim: 'diesel deal' });
    assert.deepEqual({ state: response.state, n: response.factChecks.length, calls: calls.length }, { state: 'ok', n: 0, calls: 0 });
  });

  it('an upstream error or timeout is unavailable, never an empty ok', async () => {
    upstream = async () => new Response('quota', { status: 429 });
    assert.equal((await searchFactChecks(ctx(), { claim: CLAIM })).state, 'unavailable');
    upstream = async () => { throw new Error('timeout'); };
    assert.equal((await searchFactChecks(ctx(), { claim: CLAIM })).state, 'unavailable');
  });

  it('caches only the fields matching reads', () => {
    const [compact] = compactApiClaims({ claims: [{ text: 'x', claimant: 'Someone', claimDate: '2026-01-01', claimReview: [{ ...review(), extra: 'y' }] }] });
    assert.deepEqual(Object.keys(compact!).sort(), ['claimReview', 'text']);
    assert.deepEqual(Object.keys(compact!.claimReview![0]!).sort(), ['languageCode', 'publisher', 'reviewDate', 'textualRating', 'title', 'url']);
    assert.deepEqual(compactApiClaims({}), []);
  });

  it('documents the real caveat and a real state in the OpenAPI 200 example', () => {
    const spec = JSON.parse(readFileSync(new URL('../docs/api/NewsService.openapi.json', import.meta.url), 'utf8'));
    const example = spec.paths['/api/news/v1/search-fact-checks'].get.responses['200'].content['application/json'].example;
    assert.equal(example.caveat, FACT_CHECK_CAVEAT);
    assert.ok(['ok', 'unavailable', 'not-configured'].includes(example.state));
  });

  it('builds the documented request', () => {
    const url = new URL(factCheckSearchUrl('a b c', 'k'));
    assert.deepEqual(Object.fromEntries(url.searchParams), { query: 'a b c', languageCode: 'en', pageSize: '20', key: 'k' });
  });
});
