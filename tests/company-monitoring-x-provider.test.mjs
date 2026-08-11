import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import {
  COMPANY_MONITORING_LEASE_FINALIZATION_RESERVE_MS,
  assertSafeOfficialUrl,
  compileXRecentSearchPacks,
  createXRecentSearchExecutor,
  evaluateOfficialIdentityState,
  fetchSsrfSafeOfficialPage,
  normalizeXRecentSearchPage,
  verifyOfficialXIdentity,
} from '../scripts/lib/company-monitoring-x-provider.mjs';

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/company-monitoring-x/provider-compliance.json', import.meta.url),
  'utf8',
));

const CHECKED_AT = Date.parse(fixture.capturedAt);
const DAY = 24 * 60 * 60 * 1000;
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function cohortTracer(index, overrides = {}) {
  const marker = ID_ALPHABET[index + 1];
  const suffix = `01K23${marker.repeat(21)}`;
  const name = `Cohort${index}`;
  const currentHandle = `cohort${index}`;
  return {
    companyId: `cm_company_${suffix}`,
    name,
    domicileCountry: 'US',
    officialDomain: `${currentHandle}.example.com`,
    officialPageUrl: `https://${currentHandle}.example.com/`,
    domainClaimId: `cm_claim_01K24${marker.repeat(21)}`,
    xHandleClaimId: `cm_claim_01K25${marker.repeat(21)}`,
    currentHandle,
    accountId: String(3_000_000_000 + index),
    profileName: name,
    officialHtml: `<span>${name} United States</span><a href="https://x.com/${currentHandle}">X</a>`,
    ...overrides,
  };
}

function subjectFor(tracer, overrides = {}) {
  return {
    companyId: tracer.companyId,
    name: tracer.name,
    domicileCountry: tracer.domicileCountry,
    domains: [{ claimId: tracer.domainClaimId, value: tracer.officialDomain }],
    xHandles: [{ claimId: tracer.xHandleClaimId, value: tracer.currentHandle }],
    ...overrides,
  };
}

function workFor(subjects, overrides = {}) {
  return {
    source: 'x',
    workId: 'cm_work_provider_test',
    windowStart: CHECKED_AT - DAY,
    windowEnd: CHECKED_AT,
    resultCap: 100,
    obligations: subjects.map((subject) => ({ companyId: subject.companyId })),
    subjects,
    ...overrides,
  };
}

function profileDomainProof(domain) {
  return {
    url: 'https://t.co/company-profile',
    entities: {
      url: {
        urls: [{
          url: 'https://t.co/company-profile',
          expanded_url: `https://${domain}/`,
        }],
      },
    },
  };
}

function xProfileFor(tracer, overrides = {}) {
  return {
    id: tracer.accountId,
    username: tracer.currentHandle,
    name: tracer.profileName,
    verified: true,
    protected: false,
    ...profileDomainProof(tracer.officialDomain),
    ...overrides,
  };
}

function verifyTracer(tracer, overrides = {}) {
  return verifyOfficialXIdentity({
    subject: {
      companyId: tracer.companyId,
      name: tracer.name,
      domicileCountry: tracer.domicileCountry,
      officialDomain: tracer.officialDomain,
      officialPageUrl: tracer.officialPageUrl,
      domainClaimId: tracer.domainClaimId,
      xHandleClaimId: tracer.xHandleClaimId,
      claimedHandle: tracer.currentHandle,
      ...overrides.subject,
    },
    page: {
      url: tracer.officialPageUrl,
      finalUrl: tracer.officialPageUrl,
      html: tracer.officialHtml,
    },
    profile: xProfileFor(tracer, overrides.profile),
    checkedAt: CHECKED_AT,
    expiresAt: CHECKED_AT + 7 * DAY,
    priorIdentity: overrides.priorIdentity,
  });
}

describe('Company Monitoring official X identity verification', () => {
  test('the five live tracers bind official domains to immutable account IDs', async () => {
    assert.equal(fixture.liveTracers.length, 5);
    for (const tracer of fixture.liveTracers) {
      const result = await verifyTracer(tracer);
      assert.deepEqual(result, {
        state: 'authoritative',
        companyId: tracer.companyId,
        domainClaimId: tracer.domainClaimId,
        xHandleClaimId: tracer.xHandleClaimId,
        officialDomain: tracer.officialDomain,
        officialPageUrl: tracer.officialPageUrl,
        accountId: tracer.accountId,
        currentHandle: tracer.currentHandle.toLowerCase(),
        profileName: tracer.profileName,
        domicileCountry: 'US',
        authorityRole: 'company',
        badgeVerified: true,
        allowedUses: ['primary_evidence', 'recent_search'],
        checkedAt: CHECKED_AT,
        expiresAt: CHECKED_AT + 7 * DAY,
        evidenceHash: result.evidenceHash,
      });
      assert.match(result.evidenceHash, /^[a-f0-9]{64}$/);
    }
  });

  test('a badge alone grants no authority when the official-domain link is absent', async () => {
    const tracer = fixture.liveTracers[0];
    const result = await verifyOfficialXIdentity({
      subject: {
        companyId: tracer.companyId,
        name: tracer.name,
        domicileCountry: tracer.domicileCountry,
        officialDomain: tracer.officialDomain,
        officialPageUrl: tracer.officialPageUrl,
        domainClaimId: tracer.domainClaimId,
        xHandleClaimId: tracer.xHandleClaimId,
        claimedHandle: tracer.currentHandle,
      },
      page: {
        url: tracer.officialPageUrl,
        finalUrl: tracer.officialPageUrl,
        html: '<script type="application/ld+json">{"name":"Stripe","address":{"addressCountry":"US"}}</script>',
      },
      profile: {
        id: tracer.accountId,
        username: tracer.currentHandle,
        name: tracer.profileName,
        verified: true,
        protected: false,
      },
      checkedAt: CHECKED_AT,
      expiresAt: CHECKED_AT + DAY,
    });
    assert.equal(result.state, 'demoted');
    assert.equal(result.demotionReason, 'official_link_lost');
    assert.equal(result.badgeVerified, true);
    assert.deepEqual(result.allowedUses, []);
  });

  test('requires matching official-page and X-profile domain links for authority', async () => {
    const tracer = fixture.liveTracers[0];
    const matching = await verifyTracer(tracer, {
      profile: profileDomainProof(tracer.officialDomain),
    });
    assert.equal(matching.state, 'authoritative');

    const directProfileUrl = await verifyTracer(tracer, {
      profile: { url: `https://${tracer.officialDomain}/`, entities: undefined },
    });
    assert.equal(directProfileUrl.state, 'authoritative');

    const absent = await verifyTracer(tracer, {
      profile: { url: undefined, entities: undefined },
    });
    assert.equal(absent.state, 'demoted');
    assert.equal(absent.demotionReason, 'official_link_lost');

    const lookalikeDomain = 'stripe.customer.example.com';
    const lookalike = await verifyOfficialXIdentity({
      subject: {
        companyId: tracer.companyId,
        name: tracer.name,
        domicileCountry: tracer.domicileCountry,
        officialDomain: lookalikeDomain,
        officialPageUrl: `https://${lookalikeDomain}/`,
        domainClaimId: tracer.domainClaimId,
        xHandleClaimId: tracer.xHandleClaimId,
        claimedHandle: tracer.currentHandle,
      },
      page: {
        url: `https://${lookalikeDomain}/`,
        finalUrl: `https://${lookalikeDomain}/`,
        html: tracer.officialHtml,
      },
      profile: {
        id: tracer.accountId,
        username: tracer.currentHandle,
        name: tracer.profileName,
        ...profileDomainProof(tracer.officialDomain),
      },
      checkedAt: CHECKED_AT,
      expiresAt: CHECKED_AT + 7 * DAY,
    });
    assert.equal(lookalike.state, 'demoted');
    assert.equal(lookalike.demotionReason, 'official_link_lost');
  });

  test('rename revalidates by immutable ID while reassignment and account change demote', async () => {
    const tracer = fixture.liveTracers[1];
    const priorIdentity = {
      accountId: tracer.accountId,
      currentHandle: 'cloudflare_old',
      state: 'authoritative',
      expiresAt: CHECKED_AT + DAY,
    };
    const renamed = await verifyTracer(tracer, { priorIdentity });
    assert.equal(renamed.state, 'authoritative');
    assert.equal(renamed.accountId, tracer.accountId);
    assert.equal(renamed.currentHandle, 'cloudflare');

    const reassigned = await verifyTracer(tracer, {
      priorIdentity,
      profile: { id: '999999999999', username: 'cloudflare_old' },
      subject: { claimedHandle: 'cloudflare_old' },
    });
    assert.equal(reassigned.state, 'demoted');
    assert.equal(reassigned.demotionReason, 'account_reassigned');

    const accountChanged = await verifyTracer(tracer, {
      priorIdentity,
      profile: { id: '999999999999' },
    });
    assert.equal(accountChanged.state, 'demoted');
    assert.equal(accountChanged.demotionReason, 'account_changed');
  });

  test('expiry, name/domicile mismatch, and corporate-family cross-binding demote', async () => {
    const tracer = fixture.liveTracers[2];
    assert.deepEqual(
      evaluateOfficialIdentityState({ state: 'authoritative', expiresAt: CHECKED_AT }, CHECKED_AT),
      { state: 'demoted', demotionReason: 'expired', allowedUses: [] },
    );

    const wrongName = await verifyTracer(tracer, { profile: { name: 'Microsoft' } });
    assert.equal(wrongName.state, 'demoted');
    assert.equal(wrongName.demotionReason, 'name_mismatch');

    const wrongDomicile = await verifyTracer(tracer, {
      subject: { domicileCountry: 'GB' },
    });
    assert.equal(wrongDomicile.state, 'demoted');
    assert.equal(wrongDomicile.demotionReason, 'domicile_mismatch');

    const lookalike = await verifyTracer(tracer, {
      subject: { name: 'GitHub Security Labs' },
    });
    assert.equal(lookalike.state, 'demoted');
    assert.equal(lookalike.demotionReason, 'name_mismatch');
  });

  test('does not treat unrelated Unicode-only names as an authority match', async () => {
    const tracer = cohortTracer(0, {
      name: '東京電力',
      profileName: '任天堂',
      officialHtml: '<span>東京電力 United States</span><a href="https://x.com/cohort0">X</a>',
    });
    const result = await verifyTracer(tracer);
    assert.equal(result.state, 'demoted');
    assert.equal(result.demotionReason, 'name_mismatch');
  });
});

describe('Company Monitoring official-domain SSRF guard', () => {
  test('rejects non-HTTPS, credentials, unsafe ports, metadata, and forbidden literal targets', () => {
    for (const url of [
      'http://example.com/',
      'https://user:pass@example.com/',
      'https://example.com:444/',
      'https://localhost/',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/',
      'https://[::1]/',
      'https://[64:ff9b::7f00:1]/',
    ]) {
      assert.throws(() => assertSafeOfficialUrl(url), /official URL/i, url);
    }
    assert.equal(assertSafeOfficialUrl('https://example.com/about').hostname, 'example.com');
  });

  test('pins every request to a vetted address and revalidates every redirect', async () => {
    const resolutions = [];
    const requests = [];
    const page = await fetchSsrfSafeOfficialPage('https://example.com/', {
      allowedDomains: ['example.com'],
      resolveHostname: async (hostname) => {
        resolutions.push(hostname);
        return ['93.184.216.34'];
      },
      requestPinned: async ({ url, address }) => {
        requests.push({ url: url.href, address });
        if (url.hostname === 'example.com') {
          return { status: 301, headers: { location: 'https://www.example.com/about' }, body: '' };
        }
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: '<html>Example</html>',
        };
      },
    });
    assert.deepEqual(resolutions, ['example.com', 'www.example.com']);
    assert.deepEqual(requests, [
      { url: 'https://example.com/', address: '93.184.216.34' },
      { url: 'https://www.example.com/about', address: '93.184.216.34' },
    ]);
    assert.equal(page.finalUrl, 'https://www.example.com/about');
  });

  test('shares one total deadline across DNS and every redirect request', async () => {
    let clock = 1_000;
    const requestTimeouts = [];
    const page = await fetchSsrfSafeOfficialPage('https://example.com/', {
      allowedDomains: ['example.com'],
      timeoutMs: 100,
      now: () => clock,
      resolveHostname: async () => {
        clock += 20;
        return ['93.184.216.34'];
      },
      requestPinned: async ({ url, timeoutMs }) => {
        requestTimeouts.push(timeoutMs);
        clock += 20;
        if (url.hostname === 'example.com') {
          return { status: 302, headers: { location: 'https://www.example.com/about' }, body: '' };
        }
        return {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html>Example</html>',
        };
      },
    });

    assert.equal(page.finalUrl, 'https://www.example.com/about');
    assert.deepEqual(requestTimeouts, [80, 40]);
  });

  test('bounds a stalled injected DNS resolver by the total deadline', { timeout: 250 }, async () => {
    await assert.rejects(
      () => fetchSsrfSafeOfficialPage('https://example.com/', {
        allowedDomains: ['example.com'],
        timeoutMs: 25,
        resolveHostname: async () => new Promise(() => {}),
        requestPinned: async () => {
          throw new Error('must not request before DNS completes');
        },
      }),
      /timed out/i,
    );
  });

  test('fails closed on mixed DNS answers and redirect rebinding before the unsafe request', async () => {
    let requested = false;
    await assert.rejects(
      () => fetchSsrfSafeOfficialPage('https://example.com/', {
        allowedDomains: ['example.com'],
        resolveHostname: async () => ['93.184.216.34', '10.0.0.1'],
        requestPinned: async () => {
          requested = true;
          throw new Error('must not run');
        },
      }),
      /private|reserved|forbidden/i,
    );
    assert.equal(requested, false);

    let calls = 0;
    await assert.rejects(
      () => fetchSsrfSafeOfficialPage('https://example.com/', {
        allowedDomains: ['example.com'],
        resolveHostname: async (hostname) => hostname === 'example.com'
          ? ['93.184.216.34']
          : ['127.0.0.1'],
        requestPinned: async () => {
          calls += 1;
          return { status: 302, headers: { location: 'https://www.example.com/private' }, body: '' };
        },
      }),
      /private|reserved|forbidden/i,
    );
    assert.equal(calls, 1);
  });

});

describe('Company Monitoring X recent-search packing and compliance normalization', () => {
  test('packs only injection-safe authoritative bindings and records every omission', () => {
    const identities = fixture.liveTracers.map((tracer) => ({
      companyId: tracer.companyId,
      accountId: tracer.accountId,
      currentHandle: tracer.currentHandle,
      state: 'authoritative',
      allowedUses: ['primary_evidence', 'recent_search'],
      expiresAt: CHECKED_AT + DAY,
    }));
    identities.push(
      { companyId: 'expired', accountId: '1', currentHandle: 'expired', state: 'authoritative', allowedUses: ['recent_search'], expiresAt: CHECKED_AT },
      { companyId: 'demoted', accountId: '2', currentHandle: 'demoted', state: 'demoted', allowedUses: [], expiresAt: CHECKED_AT + DAY },
      { companyId: 'injected', accountId: '33', currentHandle: 'good OR from:bad', state: 'authoritative', allowedUses: ['recent_search'], expiresAt: CHECKED_AT + DAY },
    );

    const packed = compileXRecentSearchPacks(identities, {
      now: CHECKED_AT,
      maxAccountsPerPack: 2,
      maxQueryBytes: 80,
    });
    assert.equal(packed.packs.length, 3);
    assert.deepEqual(packed.packs.map((pack) => pack.companyIds.length), [2, 2, 1]);
    for (const pack of packed.packs) {
      assert.match(pack.query, /^\(from:[A-Za-z0-9_]+(?: OR from:[A-Za-z0-9_]+)*\) -is:retweet$/);
      assert.ok(Buffer.byteLength(pack.query) <= 80);
      assert.match(pack.packId, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(packed.omissions, [
      { companyId: 'demoted', reason: 'identity_not_authoritative' },
      { companyId: 'expired', reason: 'identity_expired' },
      { companyId: 'injected', reason: 'invalid_handle' },
    ]);
  });

  test('normalizes active, edited, deleted, protected, and withheld states without retaining forbidden text', () => {
    const bindings = fixture.liveTracers.map((tracer) => ({
      companyId: tracer.companyId,
      accountId: tracer.accountId,
      currentHandle: tracer.currentHandle,
    }));
    const normalized = normalizeXRecentSearchPage(fixture.recentSearchPage, {
      bindings,
      permittedStorage: 'full_text',
      observedAt: CHECKED_AT,
    });
    assert.deepEqual(normalized.posts.map((post) => post.contentState), [
      'active',
      'edited',
      'withheld',
      'deleted',
      'protected',
    ]);
    assert.equal(normalized.posts[0].text, 'A new Stripe product update.');
    assert.deepEqual(normalized.posts[1].editHistoryPostIds, [
      '2000000000000000002',
      '2000000000000000003',
    ]);
    for (const post of normalized.posts.slice(2)) {
      assert.equal(Object.hasOwn(post, 'text'), false, `${post.contentState} must not retain text`);
    }
    assert.deepEqual(normalized.posts[2].withheldCountryCodes, ['DE', 'FR']);
    assert.equal(normalized.posts[3].storageState, 'tombstone');
    assert.equal(normalized.posts[4].storageState, 'metadata_only');
  });

  test('executes verified recent search with immutable-author filtering and deletion tombstones', async () => {
    const tracer = fixture.liveTracers[0];
    const calls = [];
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      storageMode: 'full_text',
      fetchOfficialPage: async () => ({
        url: tracer.officialPageUrl,
        finalUrl: tracer.officialPageUrl,
        html: tracer.officialHtml,
      }),
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        calls.push({ url, init });
        if (url.pathname.includes('/users/by/username/')) {
          return new Response(JSON.stringify({
            data: xProfileFor(tracer),
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.pathname === '/2/tweets/search/recent') {
          return new Response(JSON.stringify({
            data: [fixture.recentSearchPage.data[0]],
            includes: { users: [fixture.recentSearchPage.includes.users[0]] },
            meta: { result_count: 1 },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected X request ${url.pathname}`);
      },
      fetchComplianceEvents: async () => [fixture.recentSearchPage.compliance[0]],
      requestCostUsdMicros: 5,
    });
    const result = await execute({
      source: 'x',
      workId: 'cm_work_test',
      windowStart: CHECKED_AT - DAY,
      windowEnd: CHECKED_AT,
      resultCap: 100,
      obligations: [{ companyId: tracer.companyId }],
      subjects: [{
        companyId: tracer.companyId,
        name: tracer.name,
        domicileCountry: tracer.domicileCountry,
        domains: [{ claimId: tracer.domainClaimId, value: tracer.officialDomain }],
        xHandles: [{ claimId: tracer.xHandleClaimId, value: tracer.currentHandle }],
      }],
    });

    assert.equal(result.type, 'result');
    assert.equal(result.coverage, 'complete');
    assert.equal(result.hasMore, false);
    assert.equal(result.itemCount, 2);
    assert.match(result.checkpoint, /^x:v1:/);
    assert.deepEqual(result.xIngestion.identities.map((row) => row.accountId), [tracer.accountId]);
    assert.deepEqual(result.xIngestion.posts.map((row) => row.contentState), ['deleted', 'active']);
    assert.equal(result.xIngestion.posts[0].storageState, 'tombstone');
    assert.equal(result.xIngestion.packing[0].query, '(from:stripe) -is:retweet');
    assert.deepEqual(result.xIngestion.gaps, []);
    assert.equal(result.xIngestion.complianceEventCount, 1);
    const profileCall = calls.find(({ url }) => url.pathname.includes('/users/by/username/'));
    assert.equal(profileCall.url.searchParams.get('user.fields'), 'id,name,username,verified,protected,url,entities');
    assert.ok(calls.every(({ init }) => init.headers.get('Authorization') === 'Bearer x-test-token'));
    assert.ok(calls.every(({ init }) => init.headers.get('User-Agent') === 'worldmonitor-company-monitoring-x/1.0'));
  });

  test('fails closed as partial when tracked-post compliance reconciliation is unavailable', async () => {
    const tracer = fixture.liveTracers[0];
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async () => ({
        url: tracer.officialPageUrl,
        finalUrl: tracer.officialPageUrl,
        html: tracer.officialHtml,
      }),
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === '/2/tweets') {
          return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
        }
        const body = url.pathname.includes('/users/by/username/')
          ? { data: xProfileFor(tracer) }
          : { data: [], includes: { users: [] }, meta: { result_count: 0 } };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const result = await execute({
      source: 'x',
      workId: 'cm_work_compliance_gap',
      windowStart: CHECKED_AT - DAY,
      windowEnd: CHECKED_AT,
      resultCap: 100,
      obligations: [{ companyId: tracer.companyId, checkpoint: 'checkpoint-before' }],
      subjects: [{
        companyId: tracer.companyId,
        name: tracer.name,
        domicileCountry: tracer.domicileCountry,
        domains: [{ claimId: tracer.domainClaimId, value: tracer.officialDomain }],
        xHandles: [{ claimId: tracer.xHandleClaimId, value: tracer.currentHandle }],
        trackedPosts: [{
          postId: '1999999999999999999',
          authorAccountId: tracer.accountId,
          contentState: 'active',
          observedAt: CHECKED_AT - DAY,
        }],
      }],
    });
    assert.equal(result.type, 'result');
    assert.equal(result.coverage, 'partial');
    assert.deepEqual(result.xIngestion.gaps, [{
      startAt: CHECKED_AT - DAY,
      endAt: CHECKED_AT,
      reason: 'compliance_unavailable',
    }]);
    assert.deepEqual(result.xIngestion.checkpoints, [{
      companyId: tracer.companyId,
      checkpointBefore: 'checkpoint-before',
      checkpointAfter: result.checkpoint,
    }]);
  });

  test('reconciles a missing tracked post into a deletion tombstone', async () => {
    const tracer = fixture.liveTracers[0];
    const deletedPostId = '1999999999999999999';
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async () => ({
        url: tracer.officialPageUrl,
        finalUrl: tracer.officialPageUrl,
        html: tracer.officialHtml,
      }),
      fetchImpl: async (input) => {
        const url = new URL(input);
        let body;
        if (url.pathname.includes('/users/by/username/')) {
          body = { data: xProfileFor(tracer) };
        } else if (url.pathname === '/2/tweets') {
          body = {
            data: [],
            errors: [{ resource_id: deletedPostId, title: 'Resource not found' }],
            includes: { users: [] },
          };
        } else {
          body = { data: [], includes: { users: [] }, meta: { result_count: 0 } };
        }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const result = await execute({
      source: 'x',
      workId: 'cm_work_reconcile_delete',
      windowStart: CHECKED_AT - DAY,
      windowEnd: CHECKED_AT,
      resultCap: 100,
      obligations: [{ companyId: tracer.companyId }],
      subjects: [{
        companyId: tracer.companyId,
        name: tracer.name,
        domicileCountry: tracer.domicileCountry,
        domains: [{ claimId: tracer.domainClaimId, value: tracer.officialDomain }],
        xHandles: [{ claimId: tracer.xHandleClaimId, value: tracer.currentHandle }],
        trackedPosts: [{
          postId: deletedPostId,
          authorAccountId: tracer.accountId,
          contentState: 'active',
          observedAt: CHECKED_AT - DAY,
        }],
      }],
    });
    assert.equal(result.coverage, 'complete');
    assert.deepEqual(result.xIngestion.posts, [{
      companyId: tracer.companyId,
      postId: deletedPostId,
      authorAccountId: tracer.accountId,
      currentHandle: 'stripe',
      createdAt: CHECKED_AT,
      observedAt: CHECKED_AT,
      contentState: 'deleted',
      storageState: 'tombstone',
      editHistoryPostIds: [deletedPostId],
    }]);
  });

  test('records retention and pagination-cap gaps instead of advancing reassuring coverage', async () => {
    const tracer = fixture.liveTracers[0];
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async () => ({
        url: tracer.officialPageUrl,
        finalUrl: tracer.officialPageUrl,
        html: tracer.officialHtml,
      }),
      fetchComplianceEvents: async () => [],
      fetchImpl: async (input) => {
        const url = new URL(input);
        const body = url.pathname.includes('/users/by/username/')
          ? { data: xProfileFor(tracer) }
          : {
            data: [fixture.recentSearchPage.data[0]],
            includes: { users: [fixture.recentSearchPage.includes.users[0]] },
            meta: { result_count: 1 },
          };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const result = await execute({
      source: 'x',
      workId: 'cm_work_capped',
      windowStart: CHECKED_AT - 8 * DAY,
      windowEnd: CHECKED_AT,
      resultCap: 1,
      obligations: [{ companyId: tracer.companyId }],
      subjects: [{
        companyId: tracer.companyId,
        name: tracer.name,
        domicileCountry: tracer.domicileCountry,
        domains: [{ claimId: tracer.domainClaimId, value: tracer.officialDomain }],
        xHandles: [{ claimId: tracer.xHandleClaimId, value: tracer.currentHandle }],
      }],
    });
    assert.equal(result.coverage, 'partial');
    assert.equal(result.hasMore, true);
    assert.deepEqual(result.xIngestion.returnedWindow, {
      startAt: CHECKED_AT - 7 * DAY,
      endAt: CHECKED_AT,
    });
    assert.deepEqual(result.xIngestion.gaps, [
      {
        startAt: CHECKED_AT - 8 * DAY,
        endAt: CHECKED_AT - 7 * DAY,
        reason: 'provider_retention',
      },
      {
        startAt: CHECKED_AT - 7 * DAY,
        endAt: CHECKED_AT,
        reason: 'pagination_cap',
      },
    ]);
  });

  test('keeps the full cohort within 100 X requests and returns provider_partial when the budget is exhausted', async () => {
    const tracers = Array.from({ length: 25 }, (_, index) => cohortTracer(index));
    const subjects = tracers.map((tracer, index) => subjectFor(tracer, {
      xHandles: [0, 1, 2, 3].map((candidate) => ({
        claimId: tracer.xHandleClaimId,
        value: `c${index}alt${candidate}`,
      })).concat({ claimId: tracer.xHandleClaimId, value: tracer.currentHandle }),
    }));
    let xCalls = 0;
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async (url) => {
        const tracer = tracers.find((candidate) => candidate.officialDomain === new URL(url).hostname);
        return { url, finalUrl: url, html: tracer.officialHtml };
      },
      fetchImpl: async (input) => {
        xCalls += 1;
        const url = new URL(input);
        if (url.pathname.includes('/users/by/username/')) {
          const handle = decodeURIComponent(url.pathname.split('/').pop());
          const index = Number(handle.match(/^c(?:ohort)?(\d+)/)?.[1]);
          const tracer = tracers[index];
          return Response.json({
            data: xProfileFor(tracer, { username: handle }),
          });
        }
        return Response.json({ data: [], includes: { users: [] }, meta: { result_count: 0 } });
      },
    });

    const result = await execute(workFor(subjects));
    assert.equal(result.type, 'result');
    assert.equal(result.coverage, 'partial');
    assert.ok(result.xIngestion.gaps.some((gap) => gap.reason === 'provider_partial'));
    assert.ok(result.xIngestion.requestCount <= 100);
    assert.equal(result.xIngestion.requestCount, xCalls);
    assert.ok(xCalls > 0);
  });

  test('marks missing domain or handle claims partial', async () => {
    const tracer = fixture.liveTracers[0];
    const subjects = [
      subjectFor(tracer),
      subjectFor(cohortTracer(0), { domains: [] }),
      subjectFor(cohortTracer(1), { xHandles: [] }),
    ];
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async () => ({
        url: tracer.officialPageUrl,
        finalUrl: tracer.officialPageUrl,
        html: tracer.officialHtml,
      }),
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.includes('/users/by/username/')) {
          return Response.json({ data: xProfileFor(tracer) });
        }
        return Response.json({ data: [], includes: { users: [] }, meta: { result_count: 0 } });
      },
    });

    const result = await execute(workFor(subjects));
    assert.equal(result.coverage, 'partial');
    assert.equal(result.emptyValidated, false);
    assert.ok(result.xIngestion.gaps.some((gap) => gap.reason === 'provider_partial'));
  });

  test('retains the current identity when another claimed domain cannot be verified', async () => {
    const tracer = fixture.liveTracers[0];
    const subject = subjectFor(tracer, {
      currentIdentity: {
        accountId: tracer.accountId,
        currentHandle: tracer.currentHandle,
        state: 'authoritative',
        expiresAt: CHECKED_AT + DAY,
        officialDomain: tracer.officialDomain,
        officialPageUrl: tracer.officialPageUrl,
      },
      domains: [
        { claimId: tracer.domainClaimId, value: tracer.officialDomain },
        { claimId: tracer.domainClaimId, value: `status.${tracer.officialDomain}` },
      ],
    });
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async (url) => {
        if (new URL(url).hostname.startsWith('status.')) throw new Error('temporary DNS failure');
        return {
          url,
          finalUrl: url,
          html: `<html><body>${tracer.name} United States</body></html>`,
        };
      },
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.startsWith('/2/users/')) {
          return Response.json({ data: xProfileFor(tracer) });
        }
        throw new Error(`unexpected X request ${url.pathname}`);
      },
    });

    const result = await execute(workFor([subject]));
    assert.equal(result.coverage, 'partial');
    assert.deepEqual(result.xIngestion.identities, []);
    assert.deepEqual(result.xIngestion.packing, []);
    assert.ok(result.xIngestion.gaps.some((gap) => gap.reason === 'provider_partial'));
  });

  test('keeps a duplicate immutable account with its stored authoritative family owner', async () => {
    const [first, second] = fixture.liveTracers;
    const subjects = [
      subjectFor(first),
      subjectFor(second, {
        currentIdentity: {
          accountId: second.accountId,
          currentHandle: second.currentHandle,
          state: 'authoritative',
          allowedUses: ['primary_evidence', 'recent_search'],
          expiresAt: CHECKED_AT + DAY,
          officialDomain: second.officialDomain,
          officialPageUrl: second.officialPageUrl,
        },
      }),
    ];
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async (url) => {
        const tracer = new URL(url).hostname.includes('cloudflare') ? second : first;
        return { url, finalUrl: tracer.officialPageUrl, html: tracer.officialHtml };
      },
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.includes('/users/by/username/')) {
          const username = decodeURIComponent(url.pathname.split('/').pop());
          const tracer = username.toLowerCase() === second.currentHandle.toLowerCase() ? second : first;
          return Response.json({
            data: xProfileFor(tracer, { id: second.accountId }),
          });
        }
        if (url.pathname.startsWith('/2/users/')) {
          return Response.json({
            data: xProfileFor(second),
          });
        }
        return Response.json({
          data: [{
            id: '5000000000000000001',
            author_id: second.accountId,
            created_at: new Date(CHECKED_AT - 1_000).toISOString(),
            text: 'Owned by the packed family.',
            edit_history_tweet_ids: ['5000000000000000001'],
          }],
          includes: { users: [{ id: second.accountId, username: second.currentHandle, protected: false }] },
          meta: { result_count: 1 },
        });
      },
    });

    const result = await execute(workFor(subjects));
    assert.deepEqual(result.xIngestion.packing.flatMap((pack) => pack.companyIds), [second.companyId]);
    assert.deepEqual(result.xIngestion.posts.map((post) => post.companyId), [second.companyId]);
    assert.deepEqual(
      result.xIngestion.identities.map(({ companyId, state, demotionReason }) => ({ companyId, state, demotionReason })),
      [
        { companyId: first.companyId, state: 'demoted', demotionReason: 'family_conflict' },
        { companyId: second.companyId, state: 'authoritative', demotionReason: undefined },
      ],
    );
  });

  test('returns an unchanged active tracked post so persistence can advance its reconciliation cursor', async () => {
    const tracer = fixture.liveTracers[0];
    const trackedPostId = '5000000000000000006';
    const subject = subjectFor(tracer, {
      currentIdentity: {
        accountId: tracer.accountId,
        currentHandle: tracer.currentHandle,
        state: 'authoritative',
        expiresAt: CHECKED_AT + DAY,
        officialDomain: tracer.officialDomain,
        officialPageUrl: tracer.officialPageUrl,
      },
      trackedPosts: [{
        postId: trackedPostId,
        authorAccountId: tracer.accountId,
        contentState: 'active',
        observedAt: CHECKED_AT - DAY,
      }],
    });
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async () => ({ url: tracer.officialPageUrl, finalUrl: tracer.officialPageUrl, html: tracer.officialHtml }),
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.startsWith('/2/users/')) {
          return Response.json({ data: xProfileFor(tracer) });
        }
        if (url.pathname === '/2/tweets') {
          return Response.json({
            data: [{
              id: trackedPostId,
              author_id: tracer.accountId,
              created_at: new Date(CHECKED_AT - 2 * DAY).toISOString(),
              text: 'unchanged active post',
              edit_history_tweet_ids: [trackedPostId],
            }],
            includes: { users: [{ id: tracer.accountId, username: tracer.currentHandle, protected: false }] },
          });
        }
        return Response.json({ data: [], includes: { users: [] }, meta: { result_count: 0 } });
      },
    });

    const result = await execute(workFor([subject]));
    assert.deepEqual(result.xIngestion.posts, [{
      companyId: tracer.companyId,
      postId: trackedPostId,
      authorAccountId: tracer.accountId,
      currentHandle: tracer.currentHandle,
      createdAt: CHECKED_AT - 2 * DAY,
      observedAt: CHECKED_AT,
      contentState: 'active',
      storageState: 'metadata_only',
      editHistoryPostIds: [trackedPostId],
    }]);
  });

  test('caps full-cohort tracked reconciliation and still calls recent search', async () => {
    const tracers = Array.from({ length: 25 }, (_, index) => cohortTracer(index));
    const subjects = tracers.map((tracer, index) => subjectFor(tracer, {
      currentIdentity: {
        accountId: tracer.accountId,
        currentHandle: tracer.currentHandle,
        state: 'authoritative',
        expiresAt: CHECKED_AT - DAY,
        officialDomain: tracer.officialDomain,
        officialPageUrl: tracer.officialPageUrl,
      },
      trackedPosts: Array.from({ length: 4 }, (_, offset) => ({
        postId: String(4_000_000_000_000_000_000n + BigInt(index * 4 + offset)),
        authorAccountId: tracer.accountId,
        contentState: 'active',
        observedAt: CHECKED_AT - DAY,
      })),
    }));
    let searched = 0;
    let reconciledIds = 0;
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async (url) => {
        const tracer = tracers.find((candidate) => candidate.officialDomain === new URL(url).hostname);
        return { url, finalUrl: url, html: tracer.officialHtml };
      },
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.startsWith('/2/users/')) {
          const value = decodeURIComponent(url.pathname.split('/').pop());
          const tracer = tracers.find((candidate) => candidate.accountId === value || candidate.currentHandle === value);
          return Response.json({ data: xProfileFor(tracer) });
        }
        if (url.pathname === '/2/tweets') {
          const ids = url.searchParams.get('ids').split(',');
          reconciledIds = ids.length;
          const tracked = subjects.flatMap((subject) => subject.trackedPosts).filter((post) => ids.includes(post.postId));
          return Response.json({
            data: tracked.map((post) => ({
              id: post.postId,
              author_id: post.authorAccountId,
              created_at: new Date(post.observedAt).toISOString(),
              text: 'unchanged',
              edit_history_tweet_ids: [post.postId],
            })),
            includes: { users: tracers.map((tracer) => ({ id: tracer.accountId, username: tracer.currentHandle })) },
          });
        }
        if (url.pathname === '/2/tweets/search/recent') searched += 1;
        return Response.json({ data: [], includes: { users: [] }, meta: { result_count: 0 } });
      },
    });

    const result = await execute(workFor(subjects));
    assert.equal(reconciledIds, 99);
    assert.ok(searched > 0);
    assert.ok(result.xIngestion.requestCount <= 100);
    assert.equal(result.xIngestion.posts.length, 99);
    assert.equal(result.coverage, 'partial');
    assert.ok(result.xIngestion.gaps.some((gap) => gap.reason === 'compliance_unavailable'));
  });

  test('keeps a deletion tombstone ahead of recent results at resultCap one', async () => {
    const tracer = fixture.liveTracers[0];
    const deletedPostId = '5000000000000000002';
    const subject = subjectFor(tracer, {
      currentIdentity: {
        accountId: tracer.accountId,
        currentHandle: tracer.currentHandle,
        state: 'demoted',
        expiresAt: CHECKED_AT - DAY,
        officialDomain: tracer.officialDomain,
        officialPageUrl: tracer.officialPageUrl,
      },
      trackedPosts: [{
        postId: deletedPostId,
        authorAccountId: tracer.accountId,
        contentState: 'active',
        observedAt: CHECKED_AT - DAY,
      }],
    });
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async () => ({ url: tracer.officialPageUrl, finalUrl: tracer.officialPageUrl, html: tracer.officialHtml }),
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.startsWith('/2/users/')) {
          return Response.json({ data: xProfileFor(tracer) });
        }
        if (url.pathname === '/2/tweets') {
          return Response.json({ data: [], errors: [{ resource_id: deletedPostId, title: 'Resource not found' }] });
        }
        return Response.json({
          data: [fixture.recentSearchPage.data[0]],
          includes: { users: [fixture.recentSearchPage.includes.users[0]] },
          meta: { result_count: 1 },
        });
      },
    });

    const result = await execute(workFor([subject], { resultCap: 1 }));
    assert.equal(result.hasMore, true);
    assert.deepEqual(result.xIngestion.posts.map((post) => post.contentState), ['deleted']);
    assert.ok(result.xIngestion.gaps.some((gap) => gap.reason === 'pagination_cap'));
  });

  test('coalesces conflicting compliance events with deletion as the terminal state', async () => {
    const tracer = fixture.liveTracers[0];
    const postId = '5000000000000000007';
    const events = [
      { type: 'withheld', postId, authorAccountId: tracer.accountId, observedAt: CHECKED_AT, countryCodes: ['DE'] },
      { type: 'delete', postId, authorAccountId: tracer.accountId, observedAt: CHECKED_AT },
    ];
    for (const complianceEvents of [events, [...events].reverse()]) {
      const execute = createXRecentSearchExecutor({
        bearerToken: 'x-test-token',
        now: () => CHECKED_AT,
        fetchOfficialPage: async () => ({
          url: tracer.officialPageUrl,
          finalUrl: tracer.officialPageUrl,
          html: tracer.officialHtml,
        }),
        fetchComplianceEvents: async () => complianceEvents,
        fetchImpl: async (input) => {
          const url = new URL(input);
          if (url.pathname.includes('/users/by/username/')) {
            return Response.json({ data: xProfileFor(tracer) });
          }
          return Response.json({ data: [], includes: { users: [] }, meta: { result_count: 0 } });
        },
      });
      const result = await execute(workFor([subjectFor(tracer)]));
      assert.deepEqual(result.xIngestion.posts.map((row) => row.contentState), ['deleted']);
      assert.equal(result.xIngestion.complianceEventCount, 1);
    }
  });

  test('stops before the lease safety margin and returns a structurally valid partial result', async () => {
    const tracer = fixture.liveTracers[0];
    const clock = [CHECKED_AT, CHECKED_AT + 100, CHECKED_AT + 600];
    const officialTimeouts = [];
    let xCalls = 0;
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => clock.shift() ?? CHECKED_AT + 600,
      timeoutMs: 10_000,
      fetchOfficialPage: async (url, options) => {
        officialTimeouts.push(options.timeoutMs);
        return { url, finalUrl: tracer.officialPageUrl, html: tracer.officialHtml };
      },
      fetchImpl: async () => {
        xCalls += 1;
        throw new Error('must not run after lease exhaustion');
      },
    });

    const result = await execute(workFor([subjectFor(tracer)], {
      leaseExpiresAt: CHECKED_AT + COMPANY_MONITORING_LEASE_FINALIZATION_RESERVE_MS + 500,
    }));
    assert.equal(result.type, 'result');
    assert.equal(result.coverage, 'partial');
    assert.deepEqual(officialTimeouts, [400]);
    assert.equal(xCalls, 0);
    assert.equal(result.xIngestion.requestCount, 0);
    assert.ok(result.xIngestion.gaps.some((gap) => gap.reason === 'provider_partial'));
  });

  test('does not convert suspended, forbidden, or unknown tracked-post responses into deletions', async () => {
    const tracer = fixture.liveTracers[0];
    const postIds = ['5000000000000000003', '5000000000000000004', '5000000000000000005'];
    const subject = subjectFor(tracer, {
      currentIdentity: {
        accountId: tracer.accountId,
        currentHandle: tracer.currentHandle,
        state: 'demoted',
        expiresAt: CHECKED_AT - DAY,
        officialDomain: tracer.officialDomain,
        officialPageUrl: tracer.officialPageUrl,
      },
      trackedPosts: postIds.map((postId) => ({
        postId,
        authorAccountId: tracer.accountId,
        contentState: 'active',
        observedAt: CHECKED_AT - DAY,
      })),
    });
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async () => ({ url: tracer.officialPageUrl, finalUrl: tracer.officialPageUrl, html: tracer.officialHtml }),
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.startsWith('/2/users/')) {
          return Response.json({ data: xProfileFor(tracer) });
        }
        if (url.pathname === '/2/tweets') {
          return Response.json({
            data: [],
            errors: [
              { resource_id: postIds[0], title: 'Author suspended' },
              { resource_id: postIds[1], title: 'Forbidden', detail: 'Authorization is unavailable' },
            ],
          });
        }
        return Response.json({ data: [], includes: { users: [] }, meta: { result_count: 0 } });
      },
    });

    const result = await execute(workFor([subject]));
    assert.deepEqual(result.xIngestion.posts, []);
    assert.equal(result.xIngestion.complianceEventCount, 0);
    assert.equal(result.coverage, 'partial');
    assert.ok(result.xIngestion.gaps.some((gap) => gap.reason === 'compliance_unavailable'));
  });

  test('does not infer deletion for an author account that was not positively profiled', async () => {
    const tracer = fixture.liveTracers[0];
    const oldAccountId = tracer.accountId;
    const replacementAccountId = '5000000000000000008';
    const postId = '5000000000000000009';
    const subject = subjectFor(tracer, {
      currentIdentity: {
        accountId: oldAccountId,
        currentHandle: tracer.currentHandle,
        state: 'demoted',
        allowedUses: [],
        expiresAt: CHECKED_AT - DAY,
        officialDomain: tracer.officialDomain,
        officialPageUrl: tracer.officialPageUrl,
      },
      trackedPosts: [{ postId, authorAccountId: oldAccountId, contentState: 'active', observedAt: CHECKED_AT - DAY }],
    });
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      fetchOfficialPage: async () => ({ url: tracer.officialPageUrl, finalUrl: tracer.officialPageUrl, html: tracer.officialHtml }),
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === `/2/users/${oldAccountId}`) return Response.json({ errors: [{ title: 'Not found' }] });
        if (url.pathname.includes('/users/by/username/')) {
          return Response.json({ data: { id: replacementAccountId, username: tracer.currentHandle, name: tracer.profileName } });
        }
        if (url.pathname === '/2/tweets') {
          return Response.json({ data: [], errors: [{ resource_id: postId, title: 'Resource not found' }] });
        }
        return Response.json({ data: [], includes: { users: [] }, meta: { result_count: 0 } });
      },
    });
    const result = await execute(workFor([subject]));
    assert.deepEqual(result.xIngestion.posts, []);
    assert.equal(result.xIngestion.complianceEventCount, 0);
    assert.equal(result.coverage, 'partial');
    assert.ok(result.xIngestion.gaps.some((gap) => gap.reason === 'compliance_unavailable'));
  });

  test('never refreshes full post text through a demoted identity binding', async () => {
    const tracer = fixture.liveTracers[0];
    const postId = '5000000000000000010';
    const subject = subjectFor(tracer, {
      currentIdentity: {
        accountId: tracer.accountId,
        currentHandle: tracer.currentHandle,
        state: 'demoted',
        allowedUses: [],
        expiresAt: CHECKED_AT - DAY,
        officialDomain: tracer.officialDomain,
        officialPageUrl: tracer.officialPageUrl,
      },
      trackedPosts: [{ postId, authorAccountId: tracer.accountId, contentState: 'active', observedAt: CHECKED_AT - DAY }],
    });
    const execute = createXRecentSearchExecutor({
      bearerToken: 'x-test-token',
      now: () => CHECKED_AT,
      storageMode: 'full_text',
      fetchOfficialPage: async () => ({
        url: tracer.officialPageUrl,
        finalUrl: tracer.officialPageUrl,
        html: `<span>${tracer.name} United States</span>`,
      }),
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname.startsWith('/2/users/')) {
          return Response.json({ data: { id: tracer.accountId, username: tracer.currentHandle, name: tracer.profileName } });
        }
        if (url.pathname === '/2/tweets') {
          return Response.json({
            data: [{
              id: postId,
              author_id: tracer.accountId,
              created_at: new Date(CHECKED_AT - DAY).toISOString(),
              text: 'must be discarded',
              edit_history_tweet_ids: [postId],
            }],
            includes: { users: [{ id: tracer.accountId, username: tracer.currentHandle }] },
          });
        }
        return Response.json({ data: [], includes: { users: [] }, meta: { result_count: 0 } });
      },
    });
    const result = await execute(workFor([subject]));
    assert.deepEqual(result.xIngestion.posts, [{
      companyId: tracer.companyId,
      postId,
      authorAccountId: tracer.accountId,
      currentHandle: tracer.currentHandle,
      createdAt: CHECKED_AT - DAY,
      observedAt: CHECKED_AT,
      contentState: 'active',
      storageState: 'metadata_only',
      editHistoryPostIds: [postId],
    }]);
  });
});
