import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { validateDecisionSignalProvenance } from '../shared/decision-signal-provenance';
import {
  CHINA_POLICY_SOURCES,
  fetchAgencyDocuments,
  parseAgencyListing,
  parsePolicyDocumentHtml,
} from '../scripts/china-policy/adapters.mjs';
import {
  classifyPolicyDocument,
  normalizePolicyDocument,
  reconcilePolicyEvents,
  reviewedEntityLinks,
  validateChinaPolicyPayload,
} from '../scripts/china-policy/normalize.mjs';
import {
  buildChinaPolicyEvents,
  capEventsByLineage,
  chinaPolicyContentMeta,
} from '../scripts/seed-china-policy-events.mjs';
import {
  createChinaPolicyService,
  isChinaPolicyPayload,
} from '../src/services/china-policy-events';

const fixtures = resolve(import.meta.dirname, 'fixtures/china-policy');
const RETRIEVED_AT = '2026-07-25T12:00:00.000Z';

async function fixture(name: string): Promise<string> {
  return readFile(resolve(fixtures, name), 'utf8');
}

function healthyAgencies(retrievedAt = RETRIEVED_AT, activeAgency = 'CAC') {
  return Object.fromEntries(Object.keys(CHINA_POLICY_SOURCES).map((agency) => [
    agency,
    {
      status: 'ok',
      retrievedAt,
      documentCount: agency === activeAgency ? 1 : 0,
      failures: [],
      requestCount: 1,
    },
  ]));
}

function officialResponse(url: string, body: string, status = 200): Response {
  const source = Object.values(CHINA_POLICY_SOURCES).find((candidate) => candidate.listUrl === url);
  const contentType = source?.listingFormat.endsWith('json')
    ? 'application/json'
    : 'text/html';
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

describe('China official policy adapters (#5576)', () => {
  it('keeps every enabled agency on one fixed HTTPS host with bounded retrieval', () => {
    assert.deepEqual(Object.keys(CHINA_POLICY_SOURCES), ['CAC', 'SAMR', 'MIIT', 'MOFCOM', 'NDRC', 'PBOC']);
    for (const source of Object.values(CHINA_POLICY_SOURCES)) {
      const listUrl = new URL(source.listUrl);
      assert.equal(listUrl.protocol, 'https:');
      assert.equal(listUrl.hostname, source.allowedHost);
      assert.ok(source.maxListBytes > 0 && source.maxListBytes <= 1_000_000);
      assert.ok(source.maxDocumentBytes > 0 && source.maxDocumentBytes <= 2_000_000);
      assert.ok(source.maxDocumentsPerRun > 0 && source.maxDocumentsPerRun <= 4);
      assert.ok(source.requestCadenceMs >= 250);
    }

    const miitQuery = new URL(CHINA_POLICY_SOURCES.MIIT.listUrl).searchParams;
    assert.equal(miitQuery.get('cateid'), '58');
    assert.equal(miitQuery.get('scope'), 'basic');
    assert.equal(miitQuery.get('p'), '1');
    assert.equal(miitQuery.get('sortFields'), '[{"name":"deploytime","type":"desc"}]');
    assert.match(miitQuery.get('selectFields') ?? '', /infocontentattribute/);
  });

  it('parses a representative official fixture for all six agencies', async () => {
    for (const [agency, extension] of [
      ['CAC', 'html'],
      ['SAMR', 'json'],
      ['MIIT', 'json'],
      ['MOFCOM', 'html'],
      ['NDRC', 'html'],
      ['PBOC', 'html'],
    ] as const) {
      const rows = parseAgencyListing(agency, await fixture(`${agency.toLowerCase()}.${extension}`));
      assert.equal(rows.length, 1, `${agency} fixture should produce one document`);
      assert.equal(rows[0].agency, agency);
      assert.match(rows[0].canonicalUrl, /^https:\/\//);
      assert.match(rows[0].publicationDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(rows[0].titleOriginal.length > 5);
    }
  });

  it('preserves original text and extracts a day-precision effective date without translating it', async () => {
    const parsed = parsePolicyDocumentHtml(await fixture('detail.html'));
    assert.equal(parsed.titleOriginal, '小型个人信息处理者个人信息保护简化措施规定');
    assert.match(parsed.originalText, /依法保护个人信息/);
    assert.equal(parsed.publicationDate, '2026-07-24');
    assert.equal(parsed.effectiveDate, '2026-08-01');
  });

  it('fetches the MIIT detail document instead of publishing its listing snippet', async () => {
    const listing = await fixture('miit.json');
    const detail = await fixture('detail.html');
    const requested: string[] = [];
    const result = await fetchAgencyDocuments('MIIT', {
      fetchImpl: async (input) => {
        const url = String(input);
        requested.push(url);
        return officialResponse(
          url,
          url === CHINA_POLICY_SOURCES.MIIT.listUrl ? listing : detail,
        );
      },
      sleep: async () => {},
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.requestCount, 2);
    assert.deepEqual(requested, [
      CHINA_POLICY_SOURCES.MIIT.listUrl,
      result.documents[0].canonicalUrl,
    ]);
    assert.match(result.documents[0].originalText, /依法保护个人信息/);
  });

  it('substitutes invalid numeric HTML entities instead of failing an agency parse', () => {
    const parsed = parsePolicyDocumentHtml([
      '<html><head>',
      '<meta name="ArticleTitle" content="市场监管公告&#1114112;">',
      '<meta name="PubDate" content="2026-07-24">',
      '</head><body><div class="article-content">正文&#x110000;内容</div></body></html>',
    ].join(''));

    assert.equal(parsed.titleOriginal, '市场监管公告�');
    assert.equal(parsed.originalText, '正文�内容');
  });

  it('rejects an oversized source response before parsing or following any redirect', async () => {
    await assert.rejects(
      fetchAgencyDocuments('CAC', {
        fetchImpl: async () => new Response('oversized', {
          status: 200,
          headers: {
            'content-length': '1000001',
            'content-type': 'text/html',
          },
        }),
        sleep: async () => {},
      }),
      /response exceeded 750000 bytes/,
    );
  });

  it('cancels an oversized streaming response instead of leaving the upstream body open', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(750_001));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      fetchAgencyDocuments('CAC', {
        fetchImpl: async () => new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
        sleep: async () => {},
      }),
      /response exceeded 750000 bytes/,
    );
    assert.equal(cancelled, true);
  });

  it('rejects redirects, PDF drift, and an empty eligible listing independently', async () => {
    let requestOptions: RequestInit | undefined;
    const empty = await fetchAgencyDocuments('CAC', {
      fetchImpl: async (_url, options) => {
        requestOptions = options;
        return officialResponse(CHINA_POLICY_SOURCES.CAC.listUrl, '<html></html>');
      },
      sleep: async () => {},
    });
    assert.equal(requestOptions?.redirect, 'error');
    assert.equal(empty.status, 'error');
    assert.match(empty.failures[0]?.reason ?? '', /no eligible policy documents/);

    const listing = await fixture('cac.html');
    const pdf = await fetchAgencyDocuments('CAC', {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === CHINA_POLICY_SOURCES.CAC.listUrl) return officialResponse(url, listing);
        return new Response('%PDF-1.7', {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      },
      sleep: async () => {},
    });
    assert.equal(pdf.status, 'error');
    assert.match(pdf.failures[0]?.reason ?? '', /unexpected content type application\/pdf/);

    const softBlock = await fetchAgencyDocuments('CAC', {
      fetchImpl: async (input) => {
        const url = String(input);
        return url === CHINA_POLICY_SOURCES.CAC.listUrl
          ? officialResponse(url, listing)
          : officialResponse(url, '<html><body>Access Denied - 安全验证</body></html>');
      },
      sleep: async () => {},
    });
    assert.equal(softBlock.status, 'error');
    assert.match(softBlock.failures[0]?.reason ?? '', /document body or date missing/);
  });
});

describe('China policy taxonomy and reviewed links (#5576)', () => {
  it('never turns a consultation or announcement into an enacted rule or enforcement action', () => {
    assert.deepEqual(
      classifyPolicyDocument('网络数据安全管理条例（征求意见稿）', ''),
      {
        actionType: 'consultation_draft',
        status: 'draft',
        confidence: 1,
        matchedTerms: ['征求意见稿'],
      },
    );
    const announcement = classifyPolicyDocument(
      '市场监管总局关于发布《广告引证内容执法指南》的公告',
      '本指南用于规范执法活动。',
    );
    assert.equal(announcement.actionType, 'announcement_guidance');
    assert.equal(announcement.status, 'announced');
    assert.notEqual(announcement.actionType, 'enforcement_penalty');
    assert.equal(
      classifyPolicyDocument(
        '工业和信息化部关于开展申报工作的通知',
        '申报工作依据现行管理办法组织开展。',
      ).actionType,
      'announcement_guidance',
      'a body reference to an existing rule must not turn a notice into a final rule',
    );
  });

  it('distinguishes investigation, explicit penalties, final rules, and lineage actions', () => {
    assert.equal(
      classifyPolicyDocument('商务部公布反倾销调查的初步裁定', '').actionType,
      'investigation',
    );
    assert.equal(
      classifyPolicyDocument('市场监管总局行政处罚决定书', '决定罚款人民币十万元').actionType,
      'enforcement_penalty',
    );
    assert.equal(
      classifyPolicyDocument('中国人民银行令〔2026〕第3号（行政复议办法）', '').actionType,
      'final_rule',
    );
    assert.equal(
      classifyPolicyDocument('关于修改和废止部分规章的决定', '').actionType,
      'amendment_correction_repeal_supersession',
    );
    assert.equal(classifyPolicyDocument('工作动态', '').actionType, 'unknown');
  });

  it('links only reviewed exact entity names and rejects collisions or fuzzy mentions', () => {
    assert.deepEqual(reviewedEntityLinks('阿里巴巴（中国）有限公司被依法处罚'), [{
      id: 'org:alibaba-china',
      name: '阿里巴巴（中国）有限公司',
      reviewState: 'reviewed',
    }]);
    assert.deepEqual(reviewedEntityLinks('阿里巴巴平台经营者应当加强治理'), []);
    assert.deepEqual(reviewedEntityLinks('腾讯生态合作伙伴名单'), []);
  });

  it('does not infer industrial policy solely from the MIIT agency name', () => {
    const event = normalizePolicyDocument({
      agency: 'MIIT',
      canonicalUrl: 'https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2026/art_11111111111111111111111111111111.html',
      titleOriginal: '工业和信息化部关于电信业务服务规范的通知',
      originalText: '电信业务经营者应当提升通信服务质量。',
      publicationDate: '2026-07-20',
      effectiveDate: null,
      documentNumber: null,
      retrievedAt: RETRIEVED_AT,
    });
    assert.deepEqual(
      event.sectors.map((sector) => sector.id),
      ['telecommunications'],
    );
  });
});

describe('China policy event provenance, reconciliation, and degradation (#5576)', () => {
  it('builds a typed-document event that passes the shared #5581 runtime validator', () => {
    const event = normalizePolicyDocument({
      agency: 'PBOC',
      canonicalUrl: 'https://www.pbc.gov.cn/tiaofasi/144941/144957/2026052217462526593/index.html',
      titleOriginal: '中国人民银行令〔2026〕第4号（中国人民银行关于修改部分规章的决定）',
      originalText: '中国人民银行决定修改部分规章。本决定自2026年8月1日起施行。',
      publicationDate: '2026-05-22',
      effectiveDate: '2026-08-01',
      documentNumber: '中国人民银行令〔2026〕第4号',
      retrievedAt: RETRIEVED_AT,
    });

    assert.equal(event.translation.state, 'not_translated');
    assert.equal(event.titleTranslated, null);
    assert.equal(event.actionType, 'amendment_correction_repeal_supersession');
    assert.equal(event.status, 'amended');
    assert.match(event.originalText, /修改部分规章/);
    assert.equal(event.provenance.familyId, 'typed_document_event');
    assert.deepEqual(validateDecisionSignalProvenance(event.provenance), {
      ok: true,
      value: event.provenance,
    });
  });

  it('deduplicates mirrors while retaining their URLs and advances real content revisions', () => {
    const base = normalizePolicyDocument({
      agency: 'PBOC',
      canonicalUrl: 'https://www.pbc.gov.cn/rule/original.html',
      titleOriginal: '中国人民银行令〔2026〕第4号',
      originalText: '第一版原文',
      publicationDate: '2026-05-22',
      effectiveDate: null,
      documentNumber: '中国人民银行令〔2026〕第4号',
      retrievedAt: RETRIEVED_AT,
    });
    const mirror = normalizePolicyDocument({
      agency: 'PBOC',
      canonicalUrl: 'https://www.pbc.gov.cn/rule/mirror.html',
      titleOriginal: base.titleOriginal,
      originalText: base.originalText,
      publicationDate: base.publicationDate,
      effectiveDate: null,
      documentNumber: base.documentNumber,
      retrievedAt: RETRIEVED_AT,
    });
    const deduped = reconcilePolicyEvents([base, mirror], []);
    assert.equal(deduped.length, 1);
    assert.deepEqual(deduped[0].mirrorUrls, [mirror.canonicalUrl]);

    const noNumberBase = normalizePolicyDocument({
      agency: 'CAC',
      canonicalUrl: 'https://www.cac.gov.cn/2026-07/24/c_1786638889704872.htm',
      titleOriginal: '小型个人信息处理者个人信息保护简化措施规定',
      originalText: '依法保护个人信息。',
      publicationDate: '2026-07-24',
      effectiveDate: null,
      documentNumber: null,
      retrievedAt: RETRIEVED_AT,
    });
    const noNumberMirror = normalizePolicyDocument({
      ...noNumberBase,
      id: undefined,
      lineageId: undefined,
      canonicalUrl: 'https://www.cac.gov.cn/2026-07/24/c_1786638889704999.htm',
      documentNumber: null,
      provenance: undefined,
    });
    const noNumberDeduped = reconcilePolicyEvents([noNumberBase, noNumberMirror], []);
    assert.equal(noNumberDeduped.length, 1);
    assert.deepEqual(noNumberDeduped[0].mirrorUrls, [noNumberMirror.canonicalUrl]);

    const laterMirror = reconcilePolicyEvents([noNumberMirror], [noNumberBase]);
    assert.equal(laterMirror.length, 1);
    assert.equal(laterMirror[0].id, noNumberBase.id);
    assert.equal(laterMirror[0].lineageId, noNumberBase.lineageId);
    assert.equal(laterMirror[0].canonicalUrl, noNumberBase.canonicalUrl);
    assert.deepEqual(laterMirror[0].mirrorUrls, [noNumberMirror.canonicalUrl]);

    const sameTitleDifferentDocument = normalizePolicyDocument({
      agency: 'CAC',
      canonicalUrl: 'https://www.cac.gov.cn/2026-07/25/c_1787000000000000.htm',
      titleOriginal: noNumberBase.titleOriginal,
      originalText: '这是另一份没有文号的独立规定。',
      publicationDate: '2026-07-25',
      effectiveDate: null,
      documentNumber: null,
      retrievedAt: RETRIEVED_AT,
    });
    assert.notEqual(
      noNumberBase.lineageId,
      sameTitleDifferentDocument.lineageId,
      'un-numbered documents with a shared title must retain URL-scoped lineages',
    );
    const independent = reconcilePolicyEvents([noNumberBase, sameTitleDifferentDocument], []);
    assert.equal(independent.length, 2);
    assert.ok(independent.every((event) => event.supersession.state === 'current'));

    const revision = normalizePolicyDocument({
      agency: 'PBOC',
      canonicalUrl: base.canonicalUrl,
      titleOriginal: base.titleOriginal,
      originalText: '第二版经更正的原文',
      publicationDate: '2026-05-23',
      effectiveDate: null,
      documentNumber: base.documentNumber,
      retrievedAt: '2026-07-26T12:00:00.000Z',
    });
    const reconciled = reconcilePolicyEvents([revision], [base]);
    assert.equal(reconciled[0].revision.sequence, 2);
    assert.equal(reconciled[0].revision.previousEventId, base.id);
    assert.equal(reconciled[0].provenance.claims.revision.status, 'known');

    const third = normalizePolicyDocument({
      agency: 'PBOC',
      canonicalUrl: base.canonicalUrl,
      titleOriginal: base.titleOriginal,
      originalText: '第三版经再次修订的原文',
      publicationDate: '2026-05-24',
      effectiveDate: null,
      documentNumber: base.documentNumber,
      retrievedAt: '2026-07-27T12:00:00.000Z',
    });
    const thirdPass = reconcilePolicyEvents([third], reconciled);
    assert.equal(thirdPass[0].revision.sequence, 3);
    assert.equal(thirdPass.length, 3, 'every prior vintage remains in the revision lineage');
    assert.deepEqual(
      thirdPass.map((event) => event.revision.sequence).sort(),
      [1, 2, 3],
    );
  });

  it('labels translation failure independently and rejects malformed cache payloads', () => {
    const event = normalizePolicyDocument({
      agency: 'CAC',
      canonicalUrl: 'https://www.cac.gov.cn/2026-06/18/c_1783525612489633.htm',
      titleOriginal: '网络数据安全管理条例（征求意见稿）',
      originalText: '公开征求意见。',
      publicationDate: '2026-06-18',
      effectiveDate: null,
      documentNumber: null,
      retrievedAt: RETRIEVED_AT,
      translation: { state: 'unavailable', failureReason: 'translator_timeout' },
    });
    assert.equal(event.translation.state, 'unavailable');
    assert.equal(event.translation.failureReason, 'translator_timeout');

    const payload = {
      schemaVersion: 1,
      generatedAt: RETRIEVED_AT,
      agencies: healthyAgencies(),
      events: [event],
    };
    assert.equal(validateChinaPolicyPayload(payload), true);
    assert.equal(validateChinaPolicyPayload({ ...payload, events: [{ ...event, provenance: {} }] }), false);
    assert.equal(validateChinaPolicyPayload({
      ...payload,
      events: [{
        ...event,
        provenance: {
          ...event.provenance,
          claims: {
            ...event.provenance.claims,
            extraction_confidence: { status: 'known' },
          },
        },
      }],
    }), false);
    assert.equal(validateChinaPolicyPayload({ ...payload, agencies: {} }), false);
    assert.equal(validateChinaPolicyPayload({
      ...payload,
      events: [{ ...event, classification: { ...event.classification, confidence: 2 } }],
    }), false);
    assert.equal(isChinaPolicyPayload({
      ...payload,
      events: [{ ...event, canonicalUrl: 'https://example.com/policy.html' }],
    }), false);
  });

  it('preserves a failed agency last-good set while healthy agencies continue updating', async () => {
    const listingFixtures = new Map<string, string>();
    for (const [agency, extension] of [
      ['CAC', 'html'],
      ['SAMR', 'json'],
      ['MIIT', 'json'],
      ['MOFCOM', 'html'],
      ['NDRC', 'html'],
      ['PBOC', 'html'],
    ] as const) {
      listingFixtures.set(
        CHINA_POLICY_SOURCES[agency].listUrl,
        await fixture(`${agency.toLowerCase()}.${extension}`),
      );
    }
    const detail = await fixture('detail.html');
    const healthyFetch = async (input: string | URL | Request) => {
      const url = String(input);
      const listing = listingFixtures.get(url);
      return officialResponse(url, listing ?? detail);
    };
    const first = await buildChinaPolicyEvents({
      fetchImpl: healthyFetch,
      sleep: async () => {},
      now: Date.parse(RETRIEVED_AT),
      previousPayload: null,
    });
    assert.equal(first.events.filter((event) => event.supersession.state === 'current').length, 6);
    assert.equal(isChinaPolicyPayload(first), true);
    const contentMeta = chinaPolicyContentMeta(first);
    assert.ok(contentMeta);
    assert.ok(contentMeta.newestItemAt >= contentMeta.oldestItemAt);
    assert.deepEqual(chinaPolicyContentMeta({
      events: [
        { publicationDate: '2026-05-22' },
        { publicationDate: '2026-07-22' },
      ],
    }), {
      newestItemAt: Date.parse('2026-07-22T00:00:00.000Z'),
      oldestItemAt: Date.parse('2026-05-22T00:00:00.000Z'),
    });

    const cacListUrl = CHINA_POLICY_SOURCES.CAC.listUrl;
    const partialFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url === cacListUrl) return officialResponse(url, 'blocked', 503);
      const listing = listingFixtures.get(url);
      return officialResponse(url, listing ?? detail);
    };
    const second = await buildChinaPolicyEvents({
      fetchImpl: partialFetch,
      sleep: async () => {},
      now: Date.parse('2026-07-26T12:00:00.000Z'),
      previousPayload: first,
    });
    assert.equal(second.agencies.CAC.status, 'error');
    const carried = second.events.find((event) => event.agency === 'CAC');
    assert.ok(carried, 'CAC last-good event should survive its independent transport failure');
    assert.deepEqual(carried.provenance.claims.transport_freshness, {
      status: 'known',
      value: {
        state: 'error',
        assessedAt: '2026-07-26T12:00:00.000Z',
        lastSuccessAt: carried.retrievedAt,
      },
    });
    assert.ok(second.events.some((event) => event.agency === 'PBOC'));

    const cacListing = [
      '<a href="//www.cac.gov.cn/2026-06/18/c_1783525612489633.htm" title="网络数据安全管理条例（征求意见稿）">网络数据安全管理条例（征求意见稿）</a><span>2026-06-18</span>',
      '<a href="//www.cac.gov.cn/2026-07/25/c_1787000000000000.htm" title="网络数据安全工作通知">网络数据安全工作通知</a><span>2026-07-25</span>',
    ].join('');
    const partialDetailFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url === cacListUrl) return officialResponse(url, cacListing);
      if (url.includes('1783525612489633')) return officialResponse(url, 'blocked', 503);
      const listing = listingFixtures.get(url);
      return officialResponse(url, listing ?? detail);
    };
    const partial = await buildChinaPolicyEvents({
      fetchImpl: partialDetailFetch,
      sleep: async () => {},
      now: Date.parse('2026-07-27T12:00:00.000Z'),
      previousPayload: first,
    });
    assert.equal(partial.agencies.CAC.status, 'partial');
    const detailFailureLastGood = partial.events.find((event) => (
      event.canonicalUrl.includes('1783525612489633')
    ));
    assert.equal(
      detailFailureLastGood?.provenance.claims.transport_freshness.status,
      'known',
    );
    assert.equal(
      detailFailureLastGood?.provenance.claims.transport_freshness.value.state,
      'error',
    );
  });

  it('does not backfill older lineages after the next-newest lineage exceeds the cap', () => {
    const event = (
      id: string,
      lineageId: string,
      publicationDate: string,
      sequence: number,
    ) => ({
      id,
      lineageId,
      publicationDate,
      revision: { sequence },
    });
    const retained = capEventsByLineage([
      event('new-2', 'new', '2026-07-25', 2),
      event('new-1', 'new', '2026-07-24', 1),
      event('middle-2', 'middle', '2026-07-23', 2),
      event('middle-1', 'middle', '2026-07-22', 1),
      event('old-1', 'old', '2026-07-01', 1),
    ], 3);

    assert.deepEqual(retained.map(({ id }) => id), ['new-2', 'new-1']);
  });

  it('validates at the client boundary and falls back to a bounded cached snapshot', async () => {
    const event = normalizePolicyDocument({
      agency: 'CAC',
      canonicalUrl: 'https://www.cac.gov.cn/2026-06/18/c_1783525612489633.htm',
      titleOriginal: '网络数据安全管理条例（征求意见稿）',
      originalText: '公开征求意见。',
      publicationDate: '2026-06-18',
      effectiveDate: null,
      documentNumber: null,
      retrievedAt: RETRIEVED_AT,
    });
    const payload = {
      schemaVersion: 1,
      generatedAt: RETRIEVED_AT,
      agencies: healthyAgencies(),
      events: [event],
    };
    assert.equal(isChinaPolicyPayload(payload), true);

    let hydrated: unknown = payload;
    const service = createChinaPolicyService({
      getHydrated: async () => hydrated,
      fetchImpl: async () => {
        throw new Error('network unavailable');
      },
      persistCache: false,
      breakerName: 'China Policy Events Test',
      cacheKey: 'last-good-regression',
      now: () => Date.parse('2026-07-25T13:00:00.000Z'),
    });
    const live = await service.fetch();
    assert.equal(live.state, 'live');
    hydrated = undefined;
    const cached = await service.fetch();
    assert.equal(cached.state, 'cached');
    assert.deepEqual(cached.data, payload);
  });

  it('grades an old origin payload as cached and enforces the generated-at hard ceiling', async () => {
    const generatedAt = '2026-07-20T12:00:00.000Z';
    const event = normalizePolicyDocument({
      agency: 'CAC',
      canonicalUrl: 'https://www.cac.gov.cn/2026-06/18/c_1783525612489633.htm',
      titleOriginal: '网络数据安全管理条例（征求意见稿）',
      originalText: '公开征求意见。',
      publicationDate: '2026-06-18',
      effectiveDate: null,
      documentNumber: null,
      retrievedAt: generatedAt,
    });
    const payload = {
      schemaVersion: 1,
      generatedAt,
      agencies: healthyAgencies(generatedAt),
      events: [event],
    };
    let now = Date.parse('2026-07-23T12:00:00.000Z');
    const service = createChinaPolicyService({
      getHydrated: async () => payload,
      persistCache: false,
      breakerName: 'China Policy Age Test',
      cacheKey: 'age-regression',
      now: () => now,
    });
    assert.equal((await service.fetch()).state, 'cached');
    now = Date.parse('2026-07-29T12:00:00.001Z');
    assert.deepEqual(await service.fetch(), {
      data: null,
      state: 'unavailable',
      cachedAt: null,
    });
  });

  it('rejects a future-dated origin payload instead of treating it as indefinitely live', async () => {
    const generatedAt = '2026-07-26T12:00:00.000Z';
    const event = normalizePolicyDocument({
      agency: 'CAC',
      canonicalUrl: 'https://www.cac.gov.cn/2026-06/18/c_1783525612489633.htm',
      titleOriginal: '网络数据安全管理条例（征求意见稿）',
      originalText: '公开征求意见。',
      publicationDate: '2026-06-18',
      effectiveDate: null,
      documentNumber: null,
      retrievedAt: generatedAt,
    });
    const payload = {
      schemaVersion: 1,
      generatedAt,
      agencies: healthyAgencies(generatedAt),
      events: [event],
    };
    const service = createChinaPolicyService({
      getHydrated: async () => payload,
      persistCache: false,
      breakerName: 'China Policy Future Date Test',
      cacheKey: 'future-date-regression',
      now: () => Date.parse('2026-07-25T12:00:00.000Z'),
    });
    assert.deepEqual(await service.fetch(), {
      data: null,
      state: 'unavailable',
      cachedAt: null,
    });
  });
});
