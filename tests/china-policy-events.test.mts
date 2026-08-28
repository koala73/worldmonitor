import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { validateDecisionSignalProvenance } from '../shared/decision-signal-provenance';
import {
  __testing__,
  CHINA_POLICY_SOURCES,
  fetchAgencyDocuments,
  fetchAllChinaPolicyDocuments,
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

  it('preserves invalid numeric HTML entities instead of failing or welding text', () => {
    const parsed = parsePolicyDocumentHtml([
      '<html><head>',
      '<meta name="ArticleTitle" content="市场监管公告&#1114112;">',
      '<meta name="PubDate" content="2026-07-24">',
      '</head><body><div class="article-content">正文&#x110000;内容</div></body></html>',
    ].join(''));

    assert.equal(parsed.titleOriginal, '市场监管公告&#1114112;');
    assert.equal(parsed.originalText, '正文&#x110000;内容');
  });

  it('keeps nested article containers intact when extracting policy text', () => {
    const parsed = parsePolicyDocumentHtml([
      '<html><head>',
      '<meta name="ArticleTitle" content="市场监管政策公告">',
      '<meta name="PubDate" content="2026-07-25">',
      '</head><body>',
      '<div class="article-content">',
      '<div>前半正文内容足够长而且超过十个字符</div>',
      '<p>后半正文，自2026年8月1日起施行</p>',
      '</div>',
      '</body></html>',
    ].join(''));

    assert.match(parsed.originalText, /前半正文/);
    assert.match(parsed.originalText, /后半正文/);
    assert.equal(parsed.effectiveDate, '2026-08-01');
  });

  it('parses bounded hostile markup correctly', () => {
    assert.equal(__testing__.stripHtml('<script '.repeat(16_000)), '');
    assert.deepEqual(parseAgencyListing('CAC', '<a >'.repeat(16_000)), []);
    const nested = parsePolicyDocumentHtml(
      `<body>${'<div class="content">'.repeat(12_000)}正文内容足够长且必须保留${'</div>'.repeat(12_000)}</body>`,
    );
    assert.equal(nested.originalText, '正文内容足够长且必须保留');
    assert.equal(
      parsePolicyDocumentHtml(
        `${'<div>'.repeat(12_000)}${'</span>'.repeat(12_000)}`,
      ).originalText,
      '',
    );
  });

  // Scaling, not wall-clock: an absolute millisecond ceiling measures the
  // runner's load as much as the parser and flakes on a busy CI box while
  // passing in isolation. `process.cpuUsage()` is the clock for the same
  // reason — `performance.now()` includes time this process was descheduled
  // under `test:data`'s 16-way oversubscription, which compresses a genuine
  // quadratic toward the linear band (observed 9.5x wall-clock on a loaded
  // GitHub runner) even though the parser's own CPU still scales ~14x.
  // CPU time still counts this process's GC; it just stops charging the
  // parser for a sibling worker's slice.
  //
  // The size step is 4x, not 2x, on purpose. A 2x step puts linear (~2x) and
  // quadratic (~4x) close enough together that GC noise can straddle the
  // gate — the larger input allocates proportionally more string, so
  // collection cost rides along with the measurement and best-of-N does not
  // remove it (GC is allocation-driven, not scheduler-driven). At 4x the
  // bands are ~4x versus ~16x.
  //
  // `test:data` runs this file at concurrency 16. A discarded warmup plus a
  // 12x gate still fail quadratic (~14–16x) and ReDoS, but tolerate the ~10x
  // linear+GC ratios that 16-way CI has produced.
  // Inputs are built once per size, outside every timed call: allocating
  // them is linear bookkeeping, not parser work, and re-allocating on each
  // attempt would add GC noise on top of the measurement — the exact
  // allocation-driven noise this guard is designed to filter out.
  const buildFixtures = (repeat: number) => {
    const openers = '<div class="content">'.repeat(repeat);
    const closers = '</div>'.repeat(repeat);
    return {
      nested: `<body>${openers}正文内容足够长且必须保留${closers}</body>`,
      unbalanced: `${'<div>'.repeat(repeat)}${'</span>'.repeat(repeat)}`,
      script: '<script '.repeat(repeat),
      anchors: '<a >'.repeat(repeat),
    };
  };

  type ScalingFixtures = ReturnType<typeof buildFixtures>;

  const SCALING_ATTEMPTS = 5;

  // One definition of the ceiling, shared by the guard and by the control that
  // proves the guard can still fail. A control carrying its own copy of the
  // threshold stops tracking the guard the moment either one is retuned, which
  // is exactly when a stale control is most reassuring and least true.
  const scalingCeilingMs = (base: number): number => base * 12 + 2;

  const measureScaling = (
    walk: (fixtures: ScalingFixtures) => void,
    baseRepeat: number,
  ): { base: number; quadrupled: number; ratio: number; marginMs: number } => {
    const baseFixtures = buildFixtures(baseRepeat);
    const quadrupledFixtures = buildFixtures(baseRepeat * 4);

    const timeOnce = (fixtures: ScalingFixtures): number => {
      const startedAt = process.cpuUsage();
      walk(fixtures);
      const used = process.cpuUsage(startedAt);
      return (used.user + used.system) / 1000;
    };

    // Discarded warmup, one per size.
    timeOnce(baseFixtures);
    timeOnce(quadrupledFixtures);

    // Interleaved, not sequential: timing all of base then all of quadrupled
    // concentrates any transient runner stall into whichever series happens
    // to be running, which can push the ratio over the gate on a loaded box
    // even though neither size is actually slow. Alternating means a stall
    // lands on both series' running minimum instead of just one (#6985).
    let base = Number.POSITIVE_INFINITY;
    let quadrupled = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < SCALING_ATTEMPTS; attempt += 1) {
      base = Math.min(base, timeOnce(baseFixtures));
      quadrupled = Math.min(quadrupled, timeOnce(quadrupledFixtures));
    }

    return {
      base,
      quadrupled,
      ratio: quadrupled / base,
      marginMs: quadrupled - scalingCeilingMs(base),
    };
  };

  const scalingDetail = (
    scaling: ReturnType<typeof measureScaling>,
  ): string =>
    `${scaling.ratio.toFixed(1)}x — linear is ~4x, catastrophic backtracking ~16x ` +
    `(${scaling.base.toFixed(1)}ms → ${scaling.quadrupled.toFixed(1)}ms, ` +
    `${scaling.marginMs.toFixed(1)}ms against the ceiling)`;

  it('parses hostile markup without superlinear rescans', () => {
    const scaling = measureScaling((fixtures) => {
      __testing__.stripHtml(fixtures.script);
      parseAgencyListing('CAC', fixtures.anchors);
      parsePolicyDocumentHtml(fixtures.nested);
      parsePolicyDocumentHtml(fixtures.unbalanced);
    }, 4_000);

    assert.ok(
      scaling.marginMs <= 0,
      `quadrupling the input scaled cost ${scalingDetail(scaling)}`,
    );
  });

  it('keeps its teeth: a genuinely quadratic scan still trips the gate', () => {
    // Positive control for the guard above. Every change that has made that
    // guard quieter — the 4x step, the discarded warmup, the 12x ceiling, the
    // interleaved best-of-5 (#6985) — traded sensitivity for stability, and
    // nothing in the suite has ever checked how much sensitivity was left. A
    // guard that can no longer fail passes for the same reason a deleted one
    // does.
    //
    // The control walks hostile input with the unbounded prefix rescan that
    // parsePolicyHtmlFields' closing-tag unwind
    // (scripts/china-policy/adapters.mjs) degenerates into once the open-tag
    // count stops bounding it — the regression this suite exists to catch. It
    // uses a test-only probe around that real parser path and runs at a smaller
    // base size because a genuinely quadratic scan at 16k would dominate the
    // file's runtime.
    let stackComparisons = 0;
    const scaling = measureScaling((fixtures) => {
      stackComparisons += __testing__.runPolicyHtmlClosingTagRegressionProbe(
        fixtures.unbalanced,
      );
    }, 2_000);

    assert.ok(
      stackComparisons > 0,
      'the control must actually scan the parser closing-tag stack',
    );
    assert.ok(
      scaling.marginMs > 0,
      `the quadratic control must trip the gate, but scaled only ${scalingDetail(scaling)}`,
    );
  });

  it('starts all independent agency listing requests concurrently', async () => {
    let activeRequests = 0;
    let peakRequests = 0;
    await assert.rejects(
      fetchAllChinaPolicyDocuments({
        fetchImpl: async (input) => {
          const url = String(input);
          activeRequests += 1;
          peakRequests = Math.max(peakRequests, activeRequests);
          await Promise.resolve();
          activeRequests -= 1;
          const source = Object.values(CHINA_POLICY_SOURCES)
            .find((candidate) => candidate.listUrl === url);
          const body = source?.listingFormat === 'samr-json'
            ? '{"data":{"html":""}}'
            : source?.listingFormat === 'miit-json'
              ? '{"data":{"searchResult":{"dataResults":[]}}}'
              : '';
          return officialResponse(url, body);
        },
        sleep: async () => {},
      }),
      /All official China policy sources failed/,
    );
    assert.equal(peakRequests, Object.keys(CHINA_POLICY_SOURCES).length);
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
      if (url.includes('1787000000000000')) {
        return officialResponse(url, [
          '<html><head>',
          '<meta name="ArticleTitle" content="网络数据安全工作通知">',
          '<meta name="PubDate" content="2026-07-25">',
          '</head><body><div class="article-content">',
          '这是另一份独立发布的网络数据安全工作通知。',
          '</div></body></html>',
        ].join(''));
      }
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

    const previousCac = first.events.find((event) => (
      event.agency === 'CAC' && event.supersession.state === 'current'
    ));
    assert.ok(previousCac);
    const failedMirrorUrl = 'https://www.cac.gov.cn/2026-06/18/c_1783525612489999.htm';
    const previousWithMirror = {
      ...first,
      events: first.events.map((event) => (
        event.id === previousCac.id
          ? { ...event, mirrorUrls: [failedMirrorUrl] }
          : event
      )),
    };
    assert.equal(validateChinaPolicyPayload(previousWithMirror), true);
    const mirrorListing = [
      `<a href="${previousCac.canonicalUrl}" title="网络数据安全管理条例（征求意见稿）">网络数据安全管理条例（征求意见稿）</a><span>2026-06-18</span>`,
      `<a href="${failedMirrorUrl}" title="网络数据安全管理条例（征求意见稿）">网络数据安全管理条例（征求意见稿）</a><span>2026-06-18</span>`,
    ].join('');
    const mirrorFailureFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url === cacListUrl) return officialResponse(url, mirrorListing);
      if (url === failedMirrorUrl) return officialResponse(url, 'blocked', 503);
      const listing = listingFixtures.get(url);
      return officialResponse(url, listing ?? detail);
    };
    const mirrorPartial = await buildChinaPolicyEvents({
      fetchImpl: mirrorFailureFetch,
      sleep: async () => {},
      now: Date.parse('2026-07-28T12:00:00.000Z'),
      previousPayload: previousWithMirror,
    });
    assert.equal(mirrorPartial.agencies.CAC.status, 'partial');
    const refreshedCanonical = mirrorPartial.events.find((event) => (
      event.canonicalUrl === previousCac.canonicalUrl
      && event.supersession.state === 'current'
    ));
    assert.equal(
      refreshedCanonical?.provenance.claims.transport_freshness.value.state,
      'fresh',
      'a failed mirror must not stale a canonical URL fetched successfully in the same run',
    );

    const expired = await buildChinaPolicyEvents({
      fetchImpl: partialFetch,
      sleep: async () => {},
      now: Date.parse('2027-02-01T12:00:00.000Z'),
      previousPayload: first,
    });
    assert.equal(
      expired.events.some((event) => event.agency === 'CAC'),
      false,
      'a failed agency must not preserve events beyond the 180-day retention ceiling',
    );
  });

  it('fails closed when every official agency is unavailable', async () => {
    await assert.rejects(
      buildChinaPolicyEvents({
        fetchImpl: async (input) => officialResponse(String(input), 'blocked', 503),
        sleep: async () => {},
        now: Date.parse(RETRIEVED_AT),
        previousPayload: null,
      }),
      /All official China policy sources failed/,
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

  it('fetches and validates the public bootstrap fallback when hydration misses', async () => {
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
    let requestedUrl = '';
    const service = createChinaPolicyService({
      getHydrated: async () => undefined,
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({
          data: { chinaPolicyEvents: payload },
        }), {
          headers: { 'content-type': 'application/json' },
        });
      },
      persistCache: false,
      breakerName: 'China Policy Bootstrap Fallback Test',
      cacheKey: 'bootstrap-fallback-regression',
      now: () => Date.parse('2026-07-25T13:00:00.000Z'),
    });

    const result = await service.fetch();
    assert.match(requestedUrl, /\/api\/bootstrap\?keys=chinaPolicyEvents&public=1$/);
    assert.equal(result.state, 'live');
    assert.deepEqual(result.data, payload);
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
