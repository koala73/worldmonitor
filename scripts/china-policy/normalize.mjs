import { createHash } from 'node:crypto';

export const CHINA_POLICY_AGENCIES = Object.freeze([
  'CAC',
  'SAMR',
  'MIIT',
  'MOFCOM',
  'NDRC',
  'PBOC',
]);

const PUBLISHERS = Object.freeze({
  CAC: {
    id: 'publisher:cac-cn',
    name: 'Cyberspace Administration of China',
    sourceName: 'CAC (China)',
  },
  SAMR: {
    id: 'publisher:samr-cn',
    name: 'State Administration for Market Regulation',
    sourceName: 'SAMR (China)',
  },
  MIIT: {
    id: 'publisher:miit-cn',
    name: 'Ministry of Industry and Information Technology',
    sourceName: 'MIIT (China)',
  },
  MOFCOM: {
    id: 'publisher:mofcom-cn',
    name: 'Ministry of Commerce',
    sourceName: 'MOFCOM (China)',
  },
  NDRC: {
    id: 'publisher:ndrc-cn',
    name: 'National Development and Reform Commission',
    sourceName: 'NDRC (China)',
  },
  PBOC: {
    id: 'publisher:pboc-cn',
    name: "People's Bank of China",
    sourceName: 'PBoC (China)',
  },
});

const SECTOR_RULES = Object.freeze([
  { id: 'data-security', label: 'Data security', pattern: /数据安全|个人信息|网络数据/ },
  { id: 'digital-platforms', label: 'Digital platforms', pattern: /平台经济|网络平台|互联网平台/ },
  { id: 'telecommunications', label: 'Telecommunications', pattern: /电信|通信|IPv6|互联网协议/ },
  { id: 'industrial-policy', label: 'Industrial policy', pattern: /工业政策|制造业|制造|工厂|产业结构|产业政策/ },
  { id: 'trade-export-controls', label: 'Trade and export controls', pattern: /出口管制|反倾销|进口|出口|外贸/ },
  { id: 'financial-services', label: 'Financial services', pattern: /银行|金融|人民币|反洗钱|支付/ },
  { id: 'consumer-markets', label: 'Consumer markets', pattern: /消费者|产品质量|食品安全|广告/ },
  { id: 'competition', label: 'Competition', pattern: /反垄断|竞争政策|经营者集中/ },
  { id: 'energy-transition', label: 'Energy transition', pattern: /零碳|节能|能源|碳排放/ },
]);

const REVIEWED_ENTITIES = Object.freeze([
  { id: 'org:alibaba-china', name: '阿里巴巴（中国）有限公司' },
  { id: 'org:tencent-technology-shenzhen', name: '腾讯科技（深圳）有限公司' },
]);

const PROVENANCE_DIMENSIONS = Object.freeze([
  'publisher',
  'source_url',
  'original_reference',
  'original_language',
  'translation',
  'observation_time',
  'effective_time',
  'publication_time',
  'retrieval_time',
  'revision',
  'supersession',
  'extraction_confidence',
  'classification_confidence',
  'corroboration',
  'transport_freshness',
  'content_freshness',
  'derivation',
]);
const ACTION_TYPES = Object.freeze([
  'consultation_draft',
  'announcement_guidance',
  'final_rule',
  'administrative_approval_restriction',
  'investigation',
  'enforcement_penalty',
  'effective_date_change',
  'amendment_correction_repeal_supersession',
  'unknown',
]);
const POLICY_STATUSES = Object.freeze([
  'draft',
  'announced',
  'in_force',
  'under_investigation',
  'enforced',
  'amended',
  'corrected',
  'repealed',
  'superseded',
  'unknown',
]);
const TRANSLATION_STATES = Object.freeze([
  'unavailable',
  'not_translated',
  'machine_assisted',
  'human_reviewed',
]);

function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function known(value) {
  return { status: 'known', value };
}

function unknown(reason) {
  return { status: 'unknown', reason };
}

function notApplicable(reason) {
  return { status: 'not_applicable', reason };
}

function matchedTerms(text, terms) {
  return terms.filter((term) => text.includes(term));
}

function classification(actionType, status, confidence, terms) {
  return {
    actionType,
    status,
    confidence,
    matchedTerms: terms,
  };
}

export function classifyPolicyDocument(title, originalText) {
  const titleText = normalizeWhitespace(title);
  const text = normalizeWhitespace(`${title} ${originalText}`);

  const consultationTerms = matchedTerms(titleText, ['征求意见稿', '公开征求意见', '草案']);
  if (consultationTerms.length > 0) {
    return classification('consultation_draft', 'draft', 1, consultationTerms);
  }

  const lineageTerms = matchedTerms(titleText, ['修改', '修订', '更正', '纠正', '废止', '撤销', '取代', '替代']);
  if (lineageTerms.length > 0) {
    let status = 'amended';
    if (lineageTerms.includes('更正') || lineageTerms.includes('纠正')) status = 'corrected';
    else if (lineageTerms.includes('废止') || lineageTerms.includes('撤销')) status = 'repealed';
    else if (lineageTerms.includes('取代') || lineageTerms.includes('替代')) status = 'superseded';
    return classification(
      'amendment_correction_repeal_supersession',
      status,
      0.98,
      lineageTerms,
    );
  }

  const enforcementTerms = matchedTerms(text, [
    '行政处罚决定',
    '处罚决定书',
    '决定罚款',
    '处以罚款',
    '没收违法所得',
    '责令停产',
    '吊销许可证',
  ]);
  if (enforcementTerms.length > 0) {
    return classification('enforcement_penalty', 'enforced', 0.99, enforcementTerms);
  }

  const investigationTerms = matchedTerms(titleText, [
    '立案调查',
    '反倾销调查',
    '反补贴调查',
    '调查的初步裁定',
    '启动调查',
  ]);
  if (investigationTerms.length > 0) {
    return classification('investigation', 'under_investigation', 0.98, investigationTerms);
  }

  const effectiveDateTerms = matchedTerms(titleText, ['调整施行日期', '延期施行', '推迟生效', '提前施行']);
  if (effectiveDateTerms.length > 0) {
    return classification('effective_date_change', 'amended', 0.98, effectiveDateTerms);
  }

  const restrictionTerms = matchedTerms(titleText, [
    '禁止出口',
    '限制出口',
    '列入出口管制管控名单',
    '行政许可',
    '予以批准',
    '批复',
  ]);
  if (restrictionTerms.length > 0) {
    return classification(
      'administrative_approval_restriction',
      'announced',
      0.94,
      restrictionTerms,
    );
  }

  const finalRuleTerms = [];
  if (/令〔?\d{4}〕?第?\d+号/.test(titleText)) finalRuleTerms.push('official_order_number');
  for (const term of ['条例', '规定', '办法', '规章']) {
    if (titleText.includes(term)) finalRuleTerms.push(term);
  }
  if (finalRuleTerms.length > 0) {
    return classification('final_rule', 'unknown', 0.88, [...new Set(finalRuleTerms)]);
  }

  const announcementTerms = matchedTerms(titleText, ['公告', '通知', '指导意见', '意见', '方案', '指南']);
  if (announcementTerms.length > 0) {
    return classification('announcement_guidance', 'announced', 0.86, announcementTerms);
  }

  return classification('unknown', 'unknown', 0.25, []);
}

export function reviewedSectorLinks(text) {
  const normalized = normalizeWhitespace(text);
  return SECTOR_RULES
    .filter((rule) => rule.pattern.test(normalized))
    .map(({ id, label }) => ({ id, label, reviewState: 'reviewed' }));
}

export function reviewedEntityLinks(text) {
  const normalized = normalizeWhitespace(text);
  return REVIEWED_ENTITIES
    .filter((entity) => normalized.includes(entity.name))
    .map((entity) => ({ ...entity, reviewState: 'reviewed' }));
}

export function extractDocumentNumber(text) {
  const normalized = normalizeWhitespace(text);
  return normalized.match(/[\u4e00-\u9fff]{1,20}(?:令|公告|函|发)〔\d{4}〕第?\d+号/)?.[0]
    ?? normalized.match(/(?:令|公告)〔?\d{4}〕?第\d+号/)?.[0]
    ?? normalized.match(/(?:公告|令)\d{4}年第\d+号/)?.[0]
    ?? null;
}

function adjustedStatus(classified, effectiveDate, retrievedAt) {
  if (classified.actionType !== 'final_rule') return classified.status;
  if (!effectiveDate) return 'unknown';
  return effectiveDate <= retrievedAt.slice(0, 10) ? 'in_force' : 'announced';
}

function lineageIdentity(input) {
  return normalizeWhitespace(input.documentNumber)
    || normalizeWhitespace(input.canonicalUrl);
}

function currentMirrorIdentity(event) {
  if (normalizeWhitespace(event.documentNumber)) {
    return `${event.lineageId}:${event.contentHash}`;
  }
  return [
    event.agency,
    normalizeWhitespace(event.titleOriginal),
    event.publicationDate,
    event.contentHash,
  ].join(':');
}

function provenanceFor(event, extractionConfidence) {
  const publisher = PUBLISHERS[event.agency];
  const translationValue = {
    state: event.translation.state,
    ...(event.translation.targetLanguage
      ? { targetLanguage: event.translation.targetLanguage }
      : {}),
  };
  return {
    contractVersion: 'decision-signal-provenance/v1',
    signalId: event.id,
    familyId: 'typed_document_event',
    claims: {
      publisher: known({
        id: publisher.id,
        name: publisher.name,
        type: 'official_government',
        registryReference: {
          sourceName: publisher.sourceName,
          sourceType: 'gov',
          propagandaRisk: 'high',
        },
      }),
      source_url: known(event.canonicalUrl),
      original_reference: known({
        kind: 'document',
        id: event.canonicalUrl,
        contentHash: event.contentHash,
      }),
      original_language: known(event.originalLanguage),
      translation: known(translationValue),
      observation_time: notApplicable('Policy documents are publication events, not observations'),
      effective_time: event.effectiveDate
        ? known({ role: 'effective', value: event.effectiveDate, precision: 'day' })
        : unknown('The official document did not expose an unambiguous effective date'),
      publication_time: known({
        role: 'publication',
        value: event.publicationDate,
        precision: 'day',
      }),
      retrieval_time: known({
        role: 'retrieval',
        value: event.retrievedAt,
        precision: 'instant',
      }),
      revision: known({
        vintageId: event.id,
        sequence: event.revision.sequence,
        state: event.revision.state,
      }),
      supersession: known({
        state: event.supersession.state,
        ...(event.supersession.relatedEventId
          ? { relatedSignalId: event.supersession.relatedEventId }
          : {}),
        ...(event.supersession.reason ? { reason: event.supersession.reason } : {}),
      }),
      extraction_confidence: known({
        score: extractionConfidence,
        method: 'official-html-json-parser/v1',
      }),
      classification_confidence: known({
        score: event.classification.confidence,
        method: 'reviewed-policy-taxonomy-rules/v1',
      }),
      corroboration: unknown('The official publisher is authoritative but independent corroboration was not evaluated'),
      transport_freshness: known({
        state: 'fresh',
        assessedAt: event.retrievedAt,
        lastSuccessAt: event.retrievedAt,
      }),
      content_freshness: known({
        state: 'current',
        assessedAt: event.retrievedAt,
        contentAsOf: event.publicationDate,
      }),
      derivation: notApplicable('Typed policy events are extracted from original documents'),
    },
  };
}

export function normalizePolicyDocument(input) {
  if (!CHINA_POLICY_AGENCIES.includes(input.agency)) {
    throw new TypeError(`Unsupported China policy agency: ${String(input.agency)}`);
  }
  const titleOriginal = normalizeWhitespace(input.titleOriginal);
  const originalText = normalizeWhitespace(input.originalText);
  const canonicalUrl = new URL(input.canonicalUrl).href;
  const documentNumber = normalizeWhitespace(input.documentNumber) || extractDocumentNumber(
    `${titleOriginal} ${originalText}`,
  );
  const contentHashHex = sha256(originalText);
  const lineageKey = `${input.agency}:${lineageIdentity({
    documentNumber,
    titleOriginal,
    canonicalUrl,
  })}`;
  const lineageId = `china-policy-lineage:${sha256(lineageKey).slice(0, 20)}`;
  const id = `china-policy:${input.agency.toLowerCase()}:${sha256(lineageKey).slice(0, 16)}:${contentHashHex.slice(0, 12)}`;
  const classified = classifyPolicyDocument(titleOriginal, originalText);
  const translation = input.translation ?? { state: 'not_translated' };
  const event = {
    id,
    lineageId,
    agency: input.agency,
    actionType: classified.actionType,
    status: adjustedStatus(classified, input.effectiveDate, input.retrievedAt),
    titleOriginal,
    titleTranslated: input.titleTranslated ?? null,
    originalText,
    originalLanguage: 'zh-CN',
    translation,
    canonicalUrl,
    mirrorUrls: [],
    documentNumber,
    publicationDate: input.publicationDate,
    retrievedAt: input.retrievedAt,
    effectiveDate: input.effectiveDate ?? null,
    sectors: reviewedSectorLinks(`${titleOriginal} ${originalText}`),
    entities: reviewedEntityLinks(`${titleOriginal} ${originalText}`),
    classification: {
      confidence: classified.confidence,
      method: 'reviewed-policy-taxonomy-rules/v1',
      matchedTerms: classified.matchedTerms,
      uncertain: classified.actionType === 'unknown',
    },
    contentHash: `sha256:${contentHashHex}`,
    revision: {
      state: 'original',
      sequence: 1,
      previousEventId: null,
    },
    supersession: {
      state: 'current',
      relatedEventId: null,
      reason: null,
    },
  };
  event.provenance = provenanceFor(event, Number.isFinite(input.extractionConfidence)
    ? input.extractionConfidence
    : 0.95);
  return event;
}

function withProvenanceLineage(event) {
  return {
    ...event,
    provenance: provenanceFor(event, event.provenance.claims.extraction_confidence.value.score),
  };
}

export function reconcilePolicyEvents(currentEvents, previousEvents = []) {
  const dedupedByContent = new Map();
  for (const event of currentEvents) {
    const key = currentMirrorIdentity(event);
    const existing = dedupedByContent.get(key);
    if (!existing) {
      dedupedByContent.set(key, {
        ...event,
        mirrorUrls: [...new Set(event.mirrorUrls ?? [])],
      });
      continue;
    }
    existing.mirrorUrls = [...new Set([
      ...existing.mirrorUrls,
      event.canonicalUrl,
      ...(event.mirrorUrls ?? []),
    ])].filter((url) => url !== existing.canonicalUrl);
  }

  const result = [];
  for (const event of dedupedByContent.values()) {
    const lineageHistory = previousEvents
      .filter((previous) => previous.lineageId === event.lineageId)
      .sort((a, b) => (b.revision?.sequence ?? 1) - (a.revision?.sequence ?? 1));
    if (lineageHistory.length === 0) {
      const mirrorIdentity = currentMirrorIdentity(event);
      const previousMirror = previousEvents.find(
        (previous) => currentMirrorIdentity(previous) === mirrorIdentity,
      );
      if (previousMirror) {
        result.push(...previousEvents
          .filter((previous) => previous.lineageId === previousMirror.lineageId)
          .map((previous) => (
            previous.id === previousMirror.id
              ? withProvenanceLineage({
                ...previous,
                mirrorUrls: [...new Set([
                  ...(previous.mirrorUrls ?? []),
                  event.canonicalUrl,
                  ...(event.mirrorUrls ?? []),
                ])].filter((url) => url !== previous.canonicalUrl),
              })
              : previous
          )));
        continue;
      }
    }
    const previous = lineageHistory[0];
    if (previous?.contentHash === event.contentHash) {
      result.push(withProvenanceLineage({
        ...event,
        id: previous.id,
        canonicalUrl: previous.canonicalUrl,
        mirrorUrls: [...new Set([
          ...(previous.mirrorUrls ?? []),
          event.canonicalUrl,
          ...(event.mirrorUrls ?? []),
        ])].filter((url) => url !== previous.canonicalUrl),
        revision: previous.revision,
      }), ...lineageHistory.slice(1));
      continue;
    }

    if (!previous) {
      result.push(withProvenanceLineage(event));
      continue;
    }

    const correction = /更正|纠正/.test(`${event.titleOriginal} ${event.originalText}`);
    const revised = withProvenanceLineage({
      ...event,
      revision: {
        state: correction ? 'corrected' : 'revised',
        sequence: (previous.revision?.sequence ?? 1) + 1,
        previousEventId: previous.id,
      },
    });
    const supersededPrevious = withProvenanceLineage({
      ...previous,
      supersession: {
        state: 'superseded',
        relatedEventId: revised.id,
        reason: 'A newer official document vintage was retrieved',
      },
    });
    result.push(revised, supersededPrevious, ...lineageHistory.slice(1));
  }

  return result.sort((a, b) => {
    const publicationDelta = Date.parse(b.publicationDate) - Date.parse(a.publicationDate);
    if (publicationDelta !== 0) return publicationDelta;
    return (b.revision?.sequence ?? 1) - (a.revision?.sequence ?? 1);
  });
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCalendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isInstant(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function isOfficialUrl(value, agency) {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname === {
        CAC: 'www.cac.gov.cn',
        SAMR: 'www.samr.gov.cn',
        MIIT: 'www.miit.gov.cn',
        MOFCOM: 'www.mofcom.gov.cn',
        NDRC: 'zfxxgk.ndrc.gov.cn',
        PBOC: 'www.pbc.gov.cn',
      }[agency]
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function isReviewedLinks(value) {
  return Array.isArray(value) && value.every((link) => (
    isRecord(link)
    && isNonEmptyString(link.id)
    && link.reviewState === 'reviewed'
    && (link.name === undefined || isNonEmptyString(link.name))
    && (link.label === undefined || isNonEmptyString(link.label))
  ));
}

function isTranslation(value) {
  return isRecord(value)
    && TRANSLATION_STATES.includes(value.state)
    && (value.targetLanguage === undefined || isNonEmptyString(value.targetLanguage))
    && (value.failureReason === undefined || isNonEmptyString(value.failureReason))
    && (value.state !== 'unavailable' || isNonEmptyString(value.failureReason));
}

function isAgencyHealth(value) {
  return isRecord(value)
    && ['ok', 'partial', 'error'].includes(value.status)
    && isInstant(value.retrievedAt)
    && Number.isInteger(value.documentCount)
    && value.documentCount >= 0
    && Number.isInteger(value.requestCount)
    && value.requestCount >= 1
    && Array.isArray(value.failures)
    && value.failures.every((failure) => (
      isRecord(failure)
      && isNonEmptyString(failure.canonicalUrl)
      && isNonEmptyString(failure.reason)
    ));
}

function hasValidProvenance(value) {
  if (!isRecord(value)
    || value.contractVersion !== 'decision-signal-provenance/v1'
    || value.familyId !== 'typed_document_event'
    || typeof value.signalId !== 'string'
    || !isRecord(value.claims)) {
    return false;
  }
  if (!PROVENANCE_DIMENSIONS.every((dimension) => isRecord(value.claims[dimension]))) return false;
  for (const dimension of PROVENANCE_DIMENSIONS) {
    const claim = value.claims[dimension];
    if (!['known', 'unknown', 'not_applicable'].includes(claim.status)) return false;
    if (claim.status === 'known') {
      if (!Object.prototype.hasOwnProperty.call(claim, 'value') || claim.value == null) return false;
    } else if (
      !isNonEmptyString(claim.reason)
      || Object.prototype.hasOwnProperty.call(claim, 'value')
    ) {
      return false;
    }
  }
  for (const required of [
    'publisher',
    'source_url',
    'original_reference',
    'original_language',
    'translation',
    'publication_time',
    'retrieval_time',
    'supersession',
    'extraction_confidence',
    'classification_confidence',
    'transport_freshness',
    'content_freshness',
  ]) {
    if (value.claims[required].status !== 'known') return false;
  }
  return value.claims.observation_time.status === 'not_applicable'
    && value.claims.derivation.status === 'not_applicable';
}

export function validateChinaPolicyPayload(value) {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !isInstant(value.generatedAt)
    || !isRecord(value.agencies)
    || Object.keys(value.agencies).length !== CHINA_POLICY_AGENCIES.length
    || !CHINA_POLICY_AGENCIES.every((agency) => isAgencyHealth(value.agencies[agency]))
    || !Array.isArray(value.events)
    || value.events.length > 120) {
    return false;
  }
  return value.events.every((event) => (
    isRecord(event)
    && CHINA_POLICY_AGENCIES.includes(event.agency)
    && isNonEmptyString(event.id)
    && isNonEmptyString(event.lineageId)
    && ACTION_TYPES.includes(event.actionType)
    && POLICY_STATUSES.includes(event.status)
    && isNonEmptyString(event.titleOriginal)
    && (event.titleTranslated === null || isNonEmptyString(event.titleTranslated))
    && isNonEmptyString(event.originalText)
    && event.originalLanguage === 'zh-CN'
    && isTranslation(event.translation)
    && isOfficialUrl(event.canonicalUrl, event.agency)
    && Array.isArray(event.mirrorUrls)
    && event.mirrorUrls.every((url) => isOfficialUrl(url, event.agency))
    && (event.documentNumber === null || isNonEmptyString(event.documentNumber))
    && isCalendarDay(event.publicationDate)
    && isInstant(event.retrievedAt)
    && (event.effectiveDate === null || isCalendarDay(event.effectiveDate))
    && isReviewedLinks(event.sectors)
    && isReviewedLinks(event.entities)
    && isRecord(event.classification)
    && Number.isFinite(event.classification.confidence)
    && event.classification.confidence >= 0
    && event.classification.confidence <= 1
    && isNonEmptyString(event.classification.method)
    && Array.isArray(event.classification.matchedTerms)
    && event.classification.matchedTerms.every(isNonEmptyString)
    && typeof event.classification.uncertain === 'boolean'
    && /^sha256:[0-9a-f]{64}$/.test(event.contentHash)
    && isRecord(event.revision)
    && ['original', 'revised', 'corrected'].includes(event.revision.state)
    && Number.isInteger(event.revision.sequence)
    && event.revision.sequence >= 1
    && (event.revision.previousEventId === null || isNonEmptyString(event.revision.previousEventId))
    && (event.revision.sequence === 1
      ? event.revision.previousEventId === null
      : isNonEmptyString(event.revision.previousEventId))
    && isRecord(event.supersession)
    && ['current', 'corrected', 'cancelled', 'superseded'].includes(event.supersession.state)
    && (event.supersession.relatedEventId === null || isNonEmptyString(event.supersession.relatedEventId))
    && (event.supersession.reason === null || isNonEmptyString(event.supersession.reason))
    && hasValidProvenance(event.provenance)
    && event.provenance.signalId === event.id
  ));
}

export const __testing__ = Object.freeze({
  PUBLISHERS,
  PROVENANCE_DIMENSIONS,
});
