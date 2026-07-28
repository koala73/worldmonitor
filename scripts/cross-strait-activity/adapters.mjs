import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const {
  parseProxyConfig,
  proxyFetch,
} = createRequire(import.meta.url)('../_proxy-utils.cjs');

export const CROSS_STRAIT_ACTIVITY_KEY = 'military:cross-strait-activity:v1';
export const MND_MAX_LIST_PAGES_PER_BACKFILL_RUN = 11;
export const MND_MAX_DETAIL_REQUESTS_PER_RUN = 20;
export const MND_REFRESH_DETAIL_REQUESTS_PER_RUN = 3;
export const MND_REQUIRED_REPORTING_DAYS = 91;
export const MND_RETENTION_REPORTING_DAYS = 365;
export const MND_MAX_REVISION_VINTAGES_PER_DAY = 20;
export const CROSS_STRAIT_ACTIVITY_MAX_SERIALIZED_BYTES = 4 * 1024 * 1024;

const USER_AGENT = 'WorldMonitor/2.10 (+https://worldmonitor.app)';
const MND_LIST_URL = 'https://www.mnd.gov.tw/en/news/plaactlist';
const JMOD_INDEX_URL = 'https://www.mod.go.jp/js/press/index-en.html';
const MND_MAX_RESPONSE_BYTES = 131_072;
const JMOD_MAX_RESPONSE_BYTES = 524_288;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_CADENCE_MS = 200;
const MND_SEED_FETCH_DEADLINE_MS = 240_000;
const MND_PERSISTENCE_HEADROOM_MS = 40_000;
export const MND_OUTBOUND_BUDGET_MS = MND_SEED_FETCH_DEADLINE_MS - MND_PERSISTENCE_HEADROOM_MS;
const MND_REFRESH_ROTATION_INTERVAL_MS = 3 * 60 * 60 * 1_000;
const DAY_MS = 86_400_000;
const MAX_PERSISTED_STRING_LENGTH = 2_048;
const MAX_SOURCE_URL_LENGTH = 512;
const PROXY_DIAGNOSTIC_MAX_CHARS = 256;

function monotonicNow() {
  return globalThis.performance.now();
}

export const CROSS_STRAIT_SOURCE_CONTRACTS = Object.freeze({
  taiwanMnd: Object.freeze({
    id: 'taiwan-mnd',
    publisher: 'Taiwan Ministry of National Defense',
    publisherType: 'official_government',
    publisherReference: Object.freeze({
      id: 'publisher:taiwan-mnd',
      registrySourceType: 'gov',
      propagandaRisk: 'high',
    }),
    launchStatus: 'launched',
    listUrl: MND_LIST_URL,
    allowedHosts: ['www.mnd.gov.tw'],
    redirectPolicy: 'error',
    maxResponseBytes: MND_MAX_RESPONSE_BYTES,
    maxListPagesPerBackfillRun: MND_MAX_LIST_PAGES_PER_BACKFILL_RUN,
    maxDetailRequestsPerRun: MND_MAX_DETAIL_REQUESTS_PER_RUN,
    requestCadenceMs: REQUEST_CADENCE_MS,
    preflight: Object.freeze({
      environment: 'railway-production',
      checkedAt: '2026-07-25',
      reachable: true,
      redirectCount: 0,
      observedListStatus: 200,
      observedDetailStatus: 206,
      largestObservedBytes: 39_046,
    }),
  }),
  japanMod: Object.freeze({
    id: 'japan-mod',
    publisher: 'Japan Joint Staff',
    publisherType: 'official_government',
    publisherReference: Object.freeze({
      id: 'publisher:japan-joint-staff',
      registrySourceType: 'gov',
      propagandaRisk: 'high',
    }),
    launchStatus: 'launched_reviewed_only',
    indexUrl: JMOD_INDEX_URL,
    allowedHosts: ['www.mod.go.jp'],
    redirectPolicy: 'error',
    maxResponseBytes: JMOD_MAX_RESPONSE_BYTES,
    requestCadenceMs: REQUEST_CADENCE_MS,
    // Documents the fixed one-direct-then-one-proxy flow hard-coded in
    // fetchJapanIndexOutcome; these bounds are not read back to drive it.
    maxRequestsPerRun: 2,
    maxDirectRequestsPerRun: 1,
    maxProxyRequestsPerRun: 1,
    fallbackPolicy: 'direct_then_proxy_on_transport_failure',
    documentAdmission: 'manual_review_required',
    runtimePdfRequestsPerRun: 0,
    preflight: Object.freeze({
      environment: 'railway-production',
      checkedAt: '2026-07-26',
      reachable: false,
      redirectCount: 0,
      observedIndexStatus: 403,
    }),
  }),
});

function known(value) {
  return { status: 'known', value };
}

function unknown(reason) {
  return { status: 'unknown', reason };
}

function notApplicable(reason) {
  return { status: 'not_applicable', reason };
}

function publisherReference(sourceId) {
  const source = Object.values(CROSS_STRAIT_SOURCE_CONTRACTS)
    .find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error('UNKNOWN_CROSS_STRAIT_SOURCE');
  return {
    id: source.publisherReference.id,
    name: source.publisher,
    type: source.publisherType,
    registryReference: {
      sourceName: source.publisher,
      sourceType: source.publisherReference.registrySourceType,
      propagandaRisk: source.publisherReference.propagandaRisk,
    },
  };
}

function buildProvenance({
  signalId,
  sourceId,
  sourceUrl,
  referenceId,
  reportingTime,
  publicationTime,
  retrievalTime,
  revision,
  supersession = { state: 'current' },
  extractionConfidence,
  classificationConfidence,
}) {
  const observationPrecision = /^\d{4}-\d{2}-\d{2}$/.test(reportingTime) ? 'day' : 'instant';
  const publicationPrecision = /^\d{4}-\d{2}-\d{2}$/.test(publicationTime) ? 'day' : 'instant';
  return {
    contractVersion: 'decision-signal-provenance/v1',
    signalId,
    familyId: 'operational_activity_record',
    claims: {
      publisher: known(publisherReference(sourceId)),
      source_url: known(sourceUrl),
      original_reference: known({
        kind: 'document',
        id: referenceId,
      }),
      original_language: known('en'),
      translation: known({ state: 'not_translated' }),
      observation_time: known({
        role: 'observation',
        value: reportingTime,
        precision: observationPrecision,
      }),
      effective_time: unknown('Publisher reports an observation window, not a separate effective time'),
      publication_time: known({
        role: 'publication',
        value: publicationTime,
        precision: publicationPrecision,
      }),
      retrieval_time: known({
        role: 'retrieval',
        value: retrievalTime,
        precision: 'instant',
      }),
      revision: known(revision),
      supersession: known(supersession),
      extraction_confidence: known(extractionConfidence),
      classification_confidence: known(classificationConfidence),
      corroboration: known({
        state: 'single_source',
        sourceSignalIds: [signalId],
      }),
      transport_freshness: known({
        state: 'fresh',
        assessedAt: retrievalTime,
        lastSuccessAt: retrievalTime,
      }),
      content_freshness: known({
        state: 'current',
        assessedAt: retrievalTime,
        contentAsOf: reportingTime,
      }),
      derivation: notApplicable('Publisher activity records are not derived WorldMonitor outputs'),
    },
  };
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sourceReferenceId(sourceUrl) {
  const parsed = new URL(sourceUrl);
  return parsed.pathname.split('/').filter(Boolean).at(-1) ?? parsed.pathname;
}

function buildReviewedJapanObservation({
  documentId,
  sourceUrl,
  reportingDay,
  reportingTime,
  reportingPeriod,
  publicationTime,
  categories,
  originalTerminology,
  summary,
}) {
  const id = `japan-mod:${documentId}`;
  const vintageId = stableHash({ sourceUrl, reportingTime, categories, originalTerminology });
  const signalId = `cross-strait:${id}:v1`;
  const retrievalTime = '2026-07-25T08:30:00.000Z';
  const revision = { vintageId, sequence: 1, state: 'original' };
  return Object.freeze({
    id,
    sourceId: 'japan-mod',
    observationKind: 'reviewed_regional_augmentation',
    reportingDay,
    reportingPeriod,
    publicationTime,
    retrievalTime,
    categories,
    originalTerminology,
    summary,
    sourceUrl,
    originalLanguage: 'en',
    translation: { state: 'not_translated' },
    revision,
    contentHash: vintageId,
    history: [],
    provenance: buildProvenance({
      signalId,
      sourceId: 'japan-mod',
      sourceUrl,
      referenceId: documentId,
      reportingTime,
      publicationTime,
      retrievalTime,
      revision,
      extractionConfidence: { score: 1, method: 'human-reviewed-official-document-v1' },
      classificationConfidence: { score: 1, method: 'human-reviewed-activity-category-v1' },
    }),
  });
}

export const REVIEWED_JAPAN_MOD_OBSERVATIONS = Object.freeze([
  buildReviewedJapanObservation({
    documentId: 'p20260724_05e',
    sourceUrl: 'https://www.mod.go.jp/js/pdf/2026/p20260724_05e.pdf',
    reportingDay: '2026-07-21',
    reportingTime: '2026-07-20T21:00:00.000Z',
    reportingPeriod: {
      start: '2026-07-20T21:00:00.000Z',
      end: '2026-07-20T21:00:00.000Z',
      timezone: 'Asia/Tokyo',
      utcOffset: '+09:00',
      semantics: 'publisher-stated-observation-time',
    },
    publicationTime: '2026-07-24',
    categories: {
      plaAircraft: null,
      planShips: 3,
      russianNavyShips: 1,
    },
    originalTerminology: {
      planShips: 'PLAN Renhai-class DDG x 1; PLAN Luyang-III-class DDG x 1; PLAN Fuchi-class AOR x 1',
      russianNavyShips: 'RFN Steregushchiy-class FFG x 1',
    },
    summary: 'JMSDF reported three PLAN vessels and one Russian Navy vessel southeast of Minami-iwo-to.',
  }),
  buildReviewedJapanObservation({
    documentId: 'p20260708_01e',
    sourceUrl: 'https://www.mod.go.jp/js/pdf/2026/p20260708_01e.pdf',
    reportingDay: '2026-07-06',
    reportingTime: '2026-07-06',
    reportingPeriod: {
      start: '2026-07-06',
      end: '2026-07-06',
      timezone: 'Asia/Tokyo',
      utcOffset: '+09:00',
      semantics: 'publisher-stated-afternoon-observation',
    },
    publicationTime: '2026-07-08',
    categories: {
      plaAircraft: 1,
      planShips: null,
      russianNavyShips: null,
    },
    originalTerminology: {
      plaAircraft: 'Y-9 intelligence-gathering aircraft x 1',
    },
    summary: 'JASDF reported one Chinese Y-9 intelligence-gathering aircraft over the East China Sea.',
  }),
]);

const HTML_HIDDEN_CONTENT_ELEMENTS = new Set([
  'audio',
  'canvas',
  'datalist',
  'iframe',
  'meter',
  'noembed',
  'noframes',
  'noscript',
  'progress',
  'rp',
  'script',
  'style',
  'template',
  'title',
  'video',
]);
const HTML_RAW_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);
const HTML_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const HTML_P_IMPLICIT_CLOSE_STARTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'center',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'search',
  'section',
  'summary',
  'table',
  'ul',
]);
const HTML_ELEMENT_SCOPE_BOUNDARIES = new Set([
  'annotation-xml',
  'applet',
  'caption',
  'desc',
  'foreignobject',
  'html',
  'marquee',
  'mi',
  'mn',
  'mo',
  'ms',
  'mtext',
  'object',
  'table',
  'td',
  'template',
  'th',
  'title',
]);
const HTML_BUTTON_SCOPE_BOUNDARIES = new Set([
  ...HTML_ELEMENT_SCOPE_BOUNDARIES,
  'button',
]);
const HTML_TAG_SPECIFIC_END_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'button',
  'center',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'li',
  'listing',
  'main',
  'menu',
  'nav',
  'ol',
  'pre',
  'search',
  'section',
  'summary',
  'ul',
]);
const HTML_SPECIAL_ELEMENTS = new Set([
  ...HTML_TAG_SPECIFIC_END_ELEMENTS,
  ...HTML_ELEMENT_SCOPE_BOUNDARIES,
  'area',
  'base',
  'basefont',
  'bgsound',
  'body',
  'br',
  'col',
  'colgroup',
  'dd',
  'dt',
  'embed',
  'frame',
  'frameset',
  'head',
  'hr',
  'iframe',
  'img',
  'input',
  'link',
  'meta',
  'noembed',
  'noframes',
  'noscript',
  'param',
  'plaintext',
  'script',
  'select',
  'source',
  'style',
  'tbody',
  'textarea',
  'tfoot',
  'thead',
  'tr',
  'track',
  'wbr',
  'xmp',
]);

function startTagImplicitlyCloses(openElement, tag) {
  // Only recover paragraph omission here. Other optional-end-tag rules are
  // scope-sensitive (for example a nested <li> inside <ul> must not close an
  // outer hidden <li>), so treating them without a full tree builder could
  // expose hidden claims. Conservatively retain those subtrees instead.
  return openElement === 'p' && !tag.isClosing && HTML_P_IMPLICIT_CLOSE_STARTS.has(tag.name);
}

function shouldHideHtmlElement(tag) {
  return !tag.isClosing
    && !HTML_VOID_ELEMENTS.has(tag.name)
    && (
      HTML_HIDDEN_CONTENT_ELEMENTS.has(tag.name)
      || (tag.name === 'dialog' && !hasHtmlAttribute(tag.openingTag, 'open'))
      || hasHtmlAttribute(tag.openingTag, 'hidden')
      || hasHtmlAttribute(tag.openingTag, 'popover')
    );
}

function isHtmlElementTag(tag) {
  return !tag.isComment && !tag.isMalformed && /^[a-z]/i.test(tag.name);
}

function createHtmlStack() {
  return {
    items: [],
    positions: new Map(),
    elementScopeBoundaries: [],
    buttonScopeBoundaries: [],
    specialElements: [],
  };
}

function pushHtmlStack(stack, name) {
  const index = stack.items.length;
  stack.items.push(name);
  const positions = stack.positions.get(name) ?? [];
  positions.push(index);
  stack.positions.set(name, positions);
  if (HTML_ELEMENT_SCOPE_BOUNDARIES.has(name)) {
    stack.elementScopeBoundaries.push(index);
  }
  if (HTML_BUTTON_SCOPE_BOUNDARIES.has(name)) {
    stack.buttonScopeBoundaries.push(index);
  }
  if (HTML_SPECIAL_ELEMENTS.has(name)) {
    stack.specialElements.push(index);
  }
}

function truncateHtmlStack(stack, length) {
  while (stack.items.length > length) {
    const index = stack.items.length - 1;
    const name = stack.items.pop();
    const positions = stack.positions.get(name);
    positions.pop();
    if (positions.length === 0) stack.positions.delete(name);
    if (stack.elementScopeBoundaries.at(-1) === index) {
      stack.elementScopeBoundaries.pop();
    }
    if (stack.buttonScopeBoundaries.at(-1) === index) {
      stack.buttonScopeBoundaries.pop();
    }
    if (stack.specialElements.at(-1) === index) {
      stack.specialElements.pop();
    }
  }
}

function htmlStackLastIndex(stack, name) {
  return stack.positions.get(name)?.at(-1) ?? -1;
}

function hasElementScopeBoundary(stack, startIndex = 0) {
  return (stack.elementScopeBoundaries.at(-1) ?? -1) >= startIndex;
}

function hasButtonScopeBoundary(stack, startIndex = 0) {
  return (stack.buttonScopeBoundaries.at(-1) ?? -1) >= startIndex;
}

function hiddenEndTagHasBarrier(stack, element) {
  if (element === 'p') return hasButtonScopeBoundary(stack);
  if (HTML_TAG_SPECIFIC_END_ELEMENTS.has(element)) {
    return hasElementScopeBoundary(stack);
  }
  return stack.specialElements.length > 0;
}

function recoverRepeatedButtonStart(stack, tag) {
  if (tag.isClosing || tag.name !== 'button') return;
  const buttonIndex = htmlStackLastIndex(stack, 'button');
  if (
    buttonIndex !== -1
    && !hasButtonScopeBoundary(stack, buttonIndex + 1)
  ) {
    truncateHtmlStack(stack, buttonIndex);
  }
}

function stripHtmlTags(value) {
  const input = String(value);
  const output = [];
  let cursor = 0;
  let hiddenElement = null;
  let hiddenDepth = 0;
  let hiddenDescendantStack = createHtmlStack();
  let closedDetailsDepth = 0;
  let closedDetailsSummarySeen = false;
  let closedDetailsSummaryVisible = false;
  let closedDetailsHiddenStack = createHtmlStack();
  let formElementActive = false;
  let templateDepth = 0;
  for (const tag of scanHtmlTags(input)) {
    const insideTemplate = templateDepth > 0;
    if (isHtmlElementTag(tag) && tag.name === 'template') {
      templateDepth = tag.isClosing
        ? Math.max(0, templateDepth - 1)
        : templateDepth + 1;
    }
    const ignoredNestedFormStart = !insideTemplate
      && isHtmlElementTag(tag)
      && tag.name === 'form'
      && !tag.isClosing
      && formElementActive;
    if (
      !insideTemplate
      && isHtmlElementTag(tag)
      && tag.name === 'form'
      && !ignoredNestedFormStart
    ) {
      formElementActive = !tag.isClosing;
    }

    if (hiddenElement) {
      if (
        hiddenDepth === 1
        && !ignoredNestedFormStart
        && startTagImplicitlyCloses(hiddenElement, tag)
        && !hasButtonScopeBoundary(hiddenDescendantStack)
      ) {
        hiddenElement = null;
        hiddenDepth = 0;
        hiddenDescendantStack = createHtmlStack();
        cursor = tag.start;
      } else {
        if (ignoredNestedFormStart) continue;
        if (tag.name === hiddenElement) {
          if (
            tag.isClosing
            && hiddenDepth === 1
            && hiddenEndTagHasBarrier(hiddenDescendantStack, hiddenElement)
          ) {
            continue;
          }
          if (tag.isClosing) hiddenDepth -= 1;
          else hiddenDepth += 1;
          if (hiddenDepth === 0) {
            hiddenElement = null;
            hiddenDescendantStack = createHtmlStack();
            cursor = tag.end + 1;
          }
        } else if (
          isHtmlElementTag(tag)
          && !tag.isClosing
          && !HTML_VOID_ELEMENTS.has(tag.name)
        ) {
          recoverRepeatedButtonStart(hiddenDescendantStack, tag);
          pushHtmlStack(hiddenDescendantStack, tag.name);
        } else if (isHtmlElementTag(tag) && tag.isClosing) {
          const matchingIndex = htmlStackLastIndex(hiddenDescendantStack, tag.name);
          if (matchingIndex !== -1) truncateHtmlStack(hiddenDescendantStack, matchingIndex);
        }
        continue;
      }
    }

    if (closedDetailsDepth > 0) {
      if (closedDetailsSummaryVisible) {
        output.push(input.slice(cursor, tag.start));
        if (ignoredNestedFormStart) {
          cursor = tag.end + 1;
          continue;
        }
        if (tag.name === 'summary' && tag.isClosing && closedDetailsDepth === 1) {
          output.push(' ');
          closedDetailsSummaryVisible = false;
          cursor = tag.end + 1;
          continue;
        }
        if (
          shouldHideHtmlElement(tag)
          || (
            tag.name === 'details'
            && !tag.isClosing
            && !hasHtmlAttribute(tag.openingTag, 'open')
          )
        ) {
          hiddenElement = tag.name;
          hiddenDepth = 1;
          hiddenDescendantStack = createHtmlStack();
          cursor = tag.end + 1;
          continue;
        }
        if (tag.name === 'details') {
          if (tag.isClosing) closedDetailsDepth -= 1;
          else closedDetailsDepth += 1;
          if (closedDetailsDepth === 0) {
            closedDetailsSummarySeen = false;
            closedDetailsSummaryVisible = false;
            closedDetailsHiddenStack = createHtmlStack();
            cursor = tag.end + 1;
            continue;
          }
        }
        if (!tag.isComment) {
          output.push(tag.name === 'br' || (tag.name === 'p' && tag.isClosing) ? '\n' : ' ');
        }
        cursor = tag.end + 1;
        continue;
      }

      if (ignoredNestedFormStart) continue;
      if (tag.name === 'details') {
        if (
          tag.isClosing
          && hasElementScopeBoundary(closedDetailsHiddenStack)
        ) {
          continue;
        }
        if (tag.isClosing) closedDetailsDepth -= 1;
        else closedDetailsDepth += 1;
        if (closedDetailsDepth === 0) {
          closedDetailsSummarySeen = false;
          closedDetailsHiddenStack = createHtmlStack();
          cursor = tag.end + 1;
        }
        continue;
      }
      if (!tag.isClosing && startTagImplicitlyCloses('p', tag)) {
        const paragraphIndex = htmlStackLastIndex(closedDetailsHiddenStack, 'p');
        if (
          paragraphIndex !== -1
          && !hasButtonScopeBoundary(closedDetailsHiddenStack, paragraphIndex + 1)
        ) {
          truncateHtmlStack(closedDetailsHiddenStack, paragraphIndex);
        }
      }
      if (
        closedDetailsDepth === 1
        && !closedDetailsSummarySeen
        && closedDetailsHiddenStack.items.length === 0
        && tag.name === 'summary'
        && !tag.isClosing
      ) {
        closedDetailsSummarySeen = true;
        cursor = tag.end + 1;
        if (shouldHideHtmlElement(tag)) {
          hiddenElement = tag.name;
          hiddenDepth = 1;
          hiddenDescendantStack = createHtmlStack();
        } else {
          closedDetailsSummaryVisible = true;
          output.push(' ');
        }
      } else if (
        isHtmlElementTag(tag)
        && !tag.isClosing
        && !HTML_VOID_ELEMENTS.has(tag.name)
      ) {
        recoverRepeatedButtonStart(closedDetailsHiddenStack, tag);
        pushHtmlStack(closedDetailsHiddenStack, tag.name);
      } else if (isHtmlElementTag(tag) && tag.isClosing) {
        const matchingIndex = htmlStackLastIndex(closedDetailsHiddenStack, tag.name);
        if (matchingIndex !== -1) truncateHtmlStack(closedDetailsHiddenStack, matchingIndex);
      }
      continue;
    }

    output.push(input.slice(cursor, tag.start));
    if (ignoredNestedFormStart) {
      cursor = tag.end + 1;
      continue;
    }
    if (shouldHideHtmlElement(tag)) {
      hiddenElement = tag.name;
      hiddenDepth = 1;
      hiddenDescendantStack = createHtmlStack();
      cursor = tag.end + 1;
      continue;
    }
    if (tag.name === 'details' && !tag.isClosing && !hasHtmlAttribute(tag.openingTag, 'open')) {
      closedDetailsDepth = 1;
      closedDetailsSummarySeen = false;
      closedDetailsSummaryVisible = false;
      closedDetailsHiddenStack = createHtmlStack();
      cursor = tag.end + 1;
      output.push(' ');
      continue;
    }
    if (!tag.isComment) {
      output.push(tag.name === 'br' || (tag.name === 'p' && tag.isClosing) ? '\n' : ' ');
    }
    cursor = tag.end + 1;
  }
  if (
    !hiddenElement
    && (closedDetailsDepth === 0 || closedDetailsSummaryVisible)
  ) {
    output.push(input.slice(cursor));
  }
  return output.join('');
}

function decodeNumericEntity(value, radix) {
  const codePoint = Number.parseInt(value, radix);
  const isScalarValue = Number.isInteger(codePoint)
    && codePoint >= 0
    && codePoint <= 0x10_FFFF
    && (codePoint < 0xD800 || codePoint > 0xDFFF);
  return isScalarValue ? String.fromCodePoint(codePoint) : '\uFFFD';
}

function isPlausibleMalformedTagToken(value) {
  return /^(?:\/?[a-z]|[!?])/i.test(String(value).trimStart());
}

function* scanHtmlTags(value) {
  const source = String(value);
  let tagStart = -1;
  let quote = null;
  let rawTextElement = null;
  let scriptEscaped = false;
  let scriptDoubleEscaped = false;

  for (let tagEnd = 0; tagEnd < source.length; tagEnd += 1) {
    const character = source[tagEnd];
    if (rawTextElement) {
      if (rawTextElement === 'script') {
        if (!scriptDoubleEscaped && source.startsWith('<!--', tagEnd)) {
          scriptEscaped = true;
          tagEnd += 3;
          continue;
        }
        if (scriptEscaped && !scriptDoubleEscaped && source.startsWith('-->', tagEnd)) {
          scriptEscaped = false;
          tagEnd += 2;
          continue;
        }
        if (scriptEscaped && !scriptDoubleEscaped && character === '<') {
          const nestedNameEnd = tagEnd + 1 + rawTextElement.length;
          if (
            source.slice(tagEnd + 1, nestedNameEnd).toLowerCase() === rawTextElement
            && /[\s/>]/.test(source[nestedNameEnd] ?? '')
          ) {
            scriptDoubleEscaped = true;
            continue;
          }
        }
      }
      if (character !== '<' || source[tagEnd + 1] !== '/') continue;
      const nameStart = tagEnd + 2;
      const nameEnd = nameStart + rawTextElement.length;
      if (source.slice(nameStart, nameEnd).toLowerCase() !== rawTextElement) continue;
      if (!/[\s/>]/.test(source[nameEnd] ?? '')) continue;
      if (rawTextElement === 'script' && scriptDoubleEscaped) {
        scriptDoubleEscaped = false;
        continue;
      }
      let closingEnd = nameEnd;
      let closingQuote = null;
      for (; closingEnd < source.length; closingEnd += 1) {
        const closingCharacter = source[closingEnd];
        if (closingQuote) {
          if (closingCharacter === closingQuote) closingQuote = null;
        } else if (closingCharacter === '"' || closingCharacter === "'") {
          closingQuote = closingCharacter;
        } else if (closingCharacter === '>') {
          break;
        }
      }
      if (closingEnd >= source.length) return;
      yield {
        name: rawTextElement,
        isClosing: true,
        isSelfClosing: false,
        isComment: false,
        isMalformed: false,
        start: tagEnd,
        end: closingEnd,
        openingTag: source.slice(tagEnd, closingEnd + 1),
      };
      rawTextElement = null;
      scriptEscaped = false;
      tagEnd = closingEnd;
      continue;
    }
    if (tagStart === -1) {
      if (character !== '<') continue;
      if (source.startsWith('<!--', tagEnd)) {
        const commentEnd = source.indexOf('-->', tagEnd + 4);
        if (commentEnd === -1) break;
        yield {
          name: '!--',
          isClosing: false,
          isSelfClosing: true,
          isComment: true,
          isMalformed: false,
          start: tagEnd,
          end: commentEnd + 2,
          openingTag: source.slice(tagEnd, commentEnd + 3),
        };
        tagEnd = commentEnd + 2;
        continue;
      }
      tagStart = tagEnd;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '<') {
      const abandoned = source.slice(tagStart + 1, tagEnd);
      if (isPlausibleMalformedTagToken(abandoned)) {
        yield {
          name: '',
          isClosing: false,
          isSelfClosing: true,
          isComment: false,
          isMalformed: true,
          start: tagStart,
          end: tagEnd - 1,
          openingTag: source.slice(tagStart, tagEnd),
        };
      }
      tagStart = tagEnd;
      continue;
    }
    if (character !== '>') continue;

    const token = source.slice(tagStart + 1, tagEnd).trim();
    const isClosing = token.startsWith('/');
    const nameStart = isClosing ? 1 : 0;
    let nameEnd = nameStart;
    while (nameEnd < token.length && !/[\s/]/.test(token[nameEnd])) nameEnd += 1;
    const name = token.slice(nameStart, nameEnd).toLowerCase();
    if (name) {
      yield {
        name,
        isClosing,
        isSelfClosing: !isClosing && token.endsWith('/'),
        isComment: false,
        isMalformed: false,
        start: tagStart,
        end: tagEnd,
        openingTag: source.slice(tagStart, tagEnd + 1),
      };
      if (!isClosing && HTML_RAW_TEXT_ELEMENTS.has(name)) {
        rawTextElement = name;
        scriptEscaped = false;
        scriptDoubleEscaped = false;
      }
    }
    tagStart = -1;
  }

  if (tagStart !== -1) {
    const unfinished = source.slice(tagStart + 1);
    if (isPlausibleMalformedTagToken(unfinished)) {
      yield {
        name: '',
        isClosing: false,
        isSelfClosing: true,
        isComment: false,
        isMalformed: true,
        start: tagStart,
        end: source.length - 1,
        openingTag: source.slice(tagStart),
      };
    }
  }
}

function scanHtmlAnchors(value) {
  const source = String(value);
  const anchors = [];
  let current = null;
  let templateDepth = 0;
  for (const tag of scanHtmlTags(source)) {
    const insideTemplate = templateDepth > 0;
    if (isHtmlElementTag(tag) && tag.name === 'template') {
      templateDepth = tag.isClosing
        ? Math.max(0, templateDepth - 1)
        : templateDepth + 1;
      continue;
    }
    if (insideTemplate) continue;
    if (tag.name !== 'a') continue;
    if (tag.isClosing) {
      if (current) {
        anchors.push({
          openingTag: current.openingTag,
          body: source.slice(current.bodyStart, tag.start),
        });
        current = null;
      }
    } else if (!tag.isSelfClosing) {
      // Starting a new anchor also abandons an unterminated prior one, matching
      // browser recovery while keeping malformed repeated tags linear.
      current = {
        openingTag: tag.openingTag,
        bodyStart: tag.end + 1,
      };
    }
  }
  return anchors;
}

function hasHtmlAttribute(openingTag, attribute) {
  const target = attribute.toLowerCase();
  let cursor = 1;
  while (cursor < openingTag.length && !/[\s/>]/.test(openingTag[cursor])) cursor += 1;

  while (cursor < openingTag.length) {
    while (cursor < openingTag.length && /[\s/]/.test(openingTag[cursor])) cursor += 1;
    if (cursor >= openingTag.length || openingTag[cursor] === '>') break;

    const nameStart = cursor;
    while (cursor < openingTag.length && !/[\s=/>]/.test(openingTag[cursor])) cursor += 1;
    const name = openingTag.slice(nameStart, cursor).toLowerCase();
    if (name === target) return true;
    while (cursor < openingTag.length && /\s/.test(openingTag[cursor])) cursor += 1;
    if (openingTag[cursor] !== '=') continue;

    cursor += 1;
    while (cursor < openingTag.length && /\s/.test(openingTag[cursor])) cursor += 1;
    const quote = openingTag[cursor];
    if (quote === '"' || quote === "'") {
      const valueEnd = openingTag.indexOf(quote, cursor + 1);
      if (valueEnd === -1) return false;
      cursor = valueEnd + 1;
    } else {
      while (cursor < openingTag.length && !/[\s>]/.test(openingTag[cursor])) cursor += 1;
    }
  }

  return false;
}

function quotedHtmlAttribute(openingTag, attribute) {
  const target = attribute.toLowerCase();
  let cursor = 1;
  while (cursor < openingTag.length && !/[\s/>]/.test(openingTag[cursor])) cursor += 1;

  while (cursor < openingTag.length) {
    while (cursor < openingTag.length && /[\s/]/.test(openingTag[cursor])) cursor += 1;
    if (cursor >= openingTag.length || openingTag[cursor] === '>') break;

    const nameStart = cursor;
    while (cursor < openingTag.length && !/[\s=/>]/.test(openingTag[cursor])) cursor += 1;
    const name = openingTag.slice(nameStart, cursor).toLowerCase();
    const isTarget = name === target;
    while (cursor < openingTag.length && /\s/.test(openingTag[cursor])) cursor += 1;
    if (openingTag[cursor] !== '=') {
      if (isTarget) return null;
      continue;
    }

    cursor += 1;
    while (cursor < openingTag.length && /\s/.test(openingTag[cursor])) cursor += 1;
    const quote = openingTag[cursor];
    if (quote !== '"' && quote !== "'") {
      while (cursor < openingTag.length && !/[\s>]/.test(openingTag[cursor])) cursor += 1;
      if (isTarget) return null;
      continue;
    }

    const valueStart = cursor + 1;
    const valueEnd = openingTag.indexOf(quote, valueStart);
    if (valueEnd === -1) return null;
    if (isTarget) return openingTag.slice(valueStart, valueEnd);
    cursor = valueEnd + 1;
  }

  return null;
}

function htmlClassNames(openingTag) {
  return new Set(
    (quotedHtmlAttribute(openingTag, 'class') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map(className => className.toLowerCase()),
  );
}

function extractHtmlElementBodies(value, tagNames, className, maxMatches = 1) {
  const source = String(value);
  const allowedTags = new Set(tagNames);
  const bodies = [];
  let current = null;
  let depth = 0;
  let templateDepth = 0;

  for (const tag of scanHtmlTags(source)) {
    const insideTemplate = templateDepth > 0;
    if (isHtmlElementTag(tag) && tag.name === 'template') {
      templateDepth = tag.isClosing
        ? Math.max(0, templateDepth - 1)
        : templateDepth + 1;
      continue;
    }
    if (insideTemplate) continue;
    if (current) {
      if (tag.name !== current.name) continue;
      if (tag.isClosing) depth -= 1;
      else if (!tag.isSelfClosing) depth += 1;
      if (depth === 0) {
        bodies.push(source.slice(current.end + 1, tag.start));
        if (bodies.length >= maxMatches) return bodies;
        current = null;
      }
      continue;
    }
    if (
      !tag.isClosing
      && !tag.isSelfClosing
      && allowedTags.has(tag.name)
      && htmlClassNames(tag.openingTag).has(className)
    ) {
      current = tag;
      depth = 1;
    }
  }

  return bodies;
}

function decodeHtml(value) {
  return stripHtmlTags(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => decodeNumericEntity(hex, 16))
    .replace(/&#(\d+);/g, (_, digits) => decodeNumericEntity(digits, 10))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function dottedDate(value) {
  const match = String(value).trim().match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (!match) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day
    ? day
    : null;
}

export function parseTaiwanMndList(html) {
  const rows = [];
  for (const anchor of scanHtmlAnchors(html)) {
    const href = quotedHtmlAttribute(anchor.openingTag, 'href');
    if (!href || !/\/News\/PLAAct\/\d+$/i.test(href)) continue;
    const dateBody = extractHtmlElementBodies(anchor.body, ['h5'], 'date')[0];
    const publicationDay = dateBody?.includes('<') ? null : dottedDate(dateBody);
    if (!publicationDay) continue;
    let sourceUrl;
    try {
      sourceUrl = new URL(href, 'https://www.mnd.gov.tw').href;
    } catch {
      continue;
    }
    if (!isAllowedSourceUrl(sourceUrl, CROSS_STRAIT_SOURCE_CONTRACTS.taiwanMnd)) continue;
    rows.push({ publicationDay, sourceUrl });
  }
  return [...new Map(rows.map((row) => [row.sourceUrl, row])).values()];
}

function isAllowedSourceUrl(url, sourceContract) {
  try {
    if (typeof url !== 'string' || url.length > MAX_SOURCE_URL_LENGTH) return false;
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && sourceContract.allowedHosts.includes(parsed.hostname)
      && !parsed.port
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

const MONTHS = Object.freeze({
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
});

function localSixAmToUtc(year, monthName, day, publicationDay) {
  const month = MONTHS[String(monthName).slice(0, 3).toLowerCase()];
  if (month == null) throw new Error(`MND_UNSUPPORTED_MONTH:${monthName}`);
  const publication = new Date(`${publicationDay}T00:00:00.000Z`);
  let resolvedYear = year;
  if (publication.getUTCMonth() === 0 && month === 11) resolvedYear -= 1;
  if (publication.getUTCMonth() === 11 && month === 0) resolvedYear += 1;
  const numericDay = Number(day);
  const calendarDate = new Date(Date.UTC(resolvedYear, month, numericDay));
  if (
    !Number.isInteger(numericDay)
    || numericDay < 1
    || calendarDate.getUTCFullYear() !== resolvedYear
    || calendarDate.getUTCMonth() !== month
    || calendarDate.getUTCDate() !== numericDay
  ) {
    throw new Error('MND_REPORTING_WINDOW_INVALID');
  }
  return new Date(Date.UTC(resolvedYear, month, numericDay, -2)).toISOString();
}

function reportedCount(text, pattern, zeroPattern) {
  const match = text.match(pattern);
  if (match) return Number(match[1]);
  if (zeroPattern?.test(text)) return 0;
  return null;
}

function mndCounts(text) {
  const plaAircraftSorties = reportedCount(
    text,
    /(\d+)\s+sorties?\s+of\s+PLA\s+aircraft/i,
    /\bno\s+PLA\s+aircraft\b/i,
  );
  const planShips = reportedCount(
    text,
    /(\d+)\s+PLAN\s+(?:ships?|vessels?)/i,
    /\bno\s+PLAN\s+(?:ships?|vessels?)\b/i,
  );
  const officialShips = reportedCount(
    text,
    /(\d+)\s+official\s+ships?/i,
    /\bno\s+official\s+ships?\b/i,
  );
  const movementCount = text.match(/(\d+)\s+out\s+of\s+\d+\s+sorties?/i);
  const movementText = movementCount
    ? text.slice(movementCount.index ?? 0, (movementCount.index ?? 0) + 300)
    : '';
  const medianLineCrossings = /median\s+line/i.test(movementText)
    ? Number(movementCount?.[1])
    : null;
  const adizEntries = /\bADIZ\b/i.test(movementText)
    ? Number(movementCount?.[1])
    : null;
  return {
    plaAircraftSorties,
    planShips,
    officialShips,
    medianLineCrossings,
    adizEntries,
  };
}

function extractMndReportBody(html) {
  const body = extractHtmlElementBodies(html, ['div', 'article', 'section'], 'maincontent')[0];
  if (body == null) throw new Error('MND_REPORT_BODY_MISSING');
  return body;
}

function extractMndPublicationDay(html) {
  const container = extractHtmlElementBodies(html, ['div', 'section'], 'pageinfo')[0]
    ?? extractHtmlElementBodies(html, ['div', 'section'], 'newsinfo')[0];
  if (container == null) throw new Error('MND_PUBLICATION_METADATA_MISSING');
  const dateBodies = extractHtmlElementBodies(container, ['span'], 'body-2', 2);
  const publicationDay = dateBodies[0]?.includes('<') ? null : dottedDate(dateBodies[0]);
  if (!publicationDay || dateBodies.length !== 1) throw new Error('MND_PUBLICATION_DATE_MISSING');
  return publicationDay;
}

function isImplausiblyFuture(dayOrInstant, retrievedAt) {
  const value = Date.parse(dayOrInstant);
  const retrieval = Date.parse(retrievedAt);
  return !Number.isFinite(value)
    || !Number.isFinite(retrieval)
    || value > retrieval + DAY_MS;
}

export function parseTaiwanMndDetail(
  html,
  {
    sourceUrl,
    retrievedAt,
    expectedPublicationDay,
    allowPublicationAdvance = false,
    expectedReportingDay = null,
  },
) {
  if (!isAllowedSourceUrl(sourceUrl, CROSS_STRAIT_SOURCE_CONTRACTS.taiwanMnd)) {
    throw new Error('MND_UNSAFE_SOURCE_URL');
  }
  const publicationTime = extractMndPublicationDay(html);
  const publicationMatches = allowPublicationAdvance
    ? publicationTime >= expectedPublicationDay
    : publicationTime === expectedPublicationDay;
  if (!publicationMatches || isImplausiblyFuture(publicationTime, retrievedAt)) {
    throw new Error('MND_PUBLICATION_DATE_MISMATCH');
  }

  const text = decodeHtml(extractMndReportBody(html));
  const windowMatch = text.match(
    /6\s*a\.m\.\s*([A-Za-z]{3})\.?\s*(\d{1,2})[\s\S]*?to\s*6\s*a\.m\.\s*([A-Za-z]{3})\.?\s*(\d{1,2})[\s\S]*?\(UTC\+8\)/i,
  );
  if (!windowMatch) throw new Error('MND_REPORTING_WINDOW_MISSING');
  const publicationYear = Number(publicationTime.slice(0, 4));
  const start = localSixAmToUtc(
    publicationYear,
    windowMatch[1],
    windowMatch[2],
    publicationTime,
  );
  const end = localSixAmToUtc(
    publicationYear,
    windowMatch[3],
    windowMatch[4],
    publicationTime,
  );
  if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 2 * DAY_MS) {
    throw new Error('MND_REPORTING_WINDOW_INVALID');
  }
  if (isImplausiblyFuture(end, retrievedAt)) throw new Error('MND_REPORTING_WINDOW_FUTURE');
  const reportingDay = new Date(Date.parse(end) + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  if (expectedReportingDay != null && reportingDay !== expectedReportingDay) {
    throw new Error('MND_REPORTING_DAY_MISMATCH');
  }
  const categories = mndCounts(text);
  if (Object.values(categories).every((value) => value == null)) {
    throw new Error('MND_ACTIVITY_COUNTS_MISSING');
  }

  const originalTerminology = {
    ...(categories.plaAircraftSorties != null ? { plaAircraftSorties: 'sorties of PLA aircraft' } : {}),
    ...(categories.planShips != null ? { planShips: 'PLAN ships' } : {}),
    ...(categories.officialShips != null ? { officialShips: 'official ships' } : {}),
    ...(categories.medianLineCrossings != null ? { medianLineCrossings: 'crossed the median line' } : {}),
    ...(categories.adizEntries != null ? { adizEntries: 'entered Taiwan ADIZ' } : {}),
  };
  const contentHash = stableHash({
    reportingDay,
    start,
    end,
    categories,
    originalTerminology,
  });
  const id = `taiwan-mnd:${reportingDay}`;
  const signalId = `cross-strait:${id}:v1`;
  const revision = { vintageId: contentHash, sequence: 1, state: 'original' };
  return {
    id,
    sourceId: 'taiwan-mnd',
    observationKind: 'official_daily_claim',
    reportingDay,
    reportingPeriod: {
      start,
      end,
      timezone: 'Asia/Taipei',
      utcOffset: '+08:00',
      semantics: 'publisher-defined-06:00-to-06:00',
    },
    publicationTime,
    retrievalTime: retrievedAt,
    categories,
    originalTerminology,
    sourceUrl,
    originalLanguage: 'en',
    translation: { state: 'not_translated' },
    revision,
    contentHash,
    history: [],
    provenance: buildProvenance({
      signalId,
      sourceId: 'taiwan-mnd',
      sourceUrl,
      referenceId: sourceReferenceId(sourceUrl),
      reportingTime: end,
      publicationTime,
      retrievalTime: retrievedAt,
      revision,
      extractionConfidence: { score: 0.98, method: 'taiwan-mnd-english-html-parser-v1' },
      classificationConfidence: { score: 0.99, method: 'publisher-terminology-category-map-v1' },
    }),
  };
}

export function parseJapanModIndex(html) {
  const rows = [];
  for (const anchor of scanHtmlAnchors(html)) {
    const href = quotedHtmlAttribute(anchor.openingTag, 'href');
    if (!href || !/\.pdf$/i.test(href)) continue;
    let sourceUrl;
    try {
      sourceUrl = new URL(href, JMOD_INDEX_URL).href;
    } catch {
      continue;
    }
    if (!isAllowedSourceUrl(sourceUrl, CROSS_STRAIT_SOURCE_CONTRACTS.japanMod)) continue;
    rows.push({
      sourceUrl,
      title: decodeHtml(anchor.body),
    });
  }
  return [...new Map(rows.map((row) => [row.sourceUrl, row])).values()];
}

export async function readBoundedTextResponse(response, maxBytes) {
  if (!response?.ok) throw new Error(`HTTP_${response?.status ?? 'UNKNOWN'}`);
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
  if (!response.body) {
    const value = await response.text();
    if (Buffer.byteLength(value) > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    return value;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function boundedHtmlRequestInit(sourceContract) {
  return {
    headers: {
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      'Accept-Language': 'en',
      'User-Agent': USER_AGENT,
    },
    redirect: sourceContract.redirectPolicy,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
}

async function fetchBoundedText(fetchFn, url, sourceContract) {
  if (!isAllowedSourceUrl(url, sourceContract)) {
    throw new Error('UNSAFE_SOURCE_URL');
  }
  const response = await fetchFn(url, boundedHtmlRequestInit(sourceContract));
  return readBoundedTextResponse(response, sourceContract.maxResponseBytes);
}

function shouldProxyJapanModFailure(error) {
  const code = errorCode(error);
  if (code === 'SOURCE_ERROR' || code === 'TIMEOUT') return true;
  const status = Number(/^HTTP_(\d{3})$/u.exec(code)?.[1]);
  return status === 403
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

async function fetchJapanModViaConfiguredProxy(input, init, {
  proxyUrl,
  proxyRequestFn,
}) {
  const maxResponseBytes = CROSS_STRAIT_SOURCE_CONTRACTS.japanMod.maxResponseBytes;
  const proxyConfig = parseProxyConfig(proxyUrl);
  if (!proxyConfig) throw new Error('PROXY_CONFIG_INVALID');
  const result = await proxyRequestFn(String(input), proxyConfig, {
    // init.headers (from boundedHtmlRequestInit) always carries an Accept
    // header, which proxyFetch's header spread applies after its own
    // `accept` default — so headers.Accept is the actual source of truth.
    headers: init?.headers,
    method: init?.method ?? 'GET',
    maxResponseBytes,
    timeoutMs: REQUEST_TIMEOUT_MS,
    signal: init?.signal,
  });
  const status = Number(result.status);
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw Object.assign(
      new Error(`HTTP_${Number.isInteger(status) ? status : 'UNKNOWN'}`),
      {
        status: Number.isInteger(status) ? status : null,
        contentType: result?.contentType,
        bodyPrefix: proxyBodyPrefix(result?.buffer),
        proxyStage: 'response',
      },
    );
  }
  if (!Buffer.isBuffer(result?.buffer)) {
    throw Object.assign(new Error('PROXY_RESPONSE_INVALID'), {
      status,
      contentType: result?.contentType,
      proxyStage: 'response',
    });
  }
  if (result.buffer.byteLength > maxResponseBytes) {
    throw Object.assign(new Error('RESPONSE_TOO_LARGE'), {
      status,
      contentType: result.contentType,
      bodyPrefix: proxyBodyPrefix(result.buffer),
      proxyStage: 'response',
    });
  }
  return {
    html: result.buffer.toString('utf8'),
    detail: buildProxyDiagnosticDetail({
      stage: 'response',
      httpStatus: status,
      contentType: result.contentType,
      bodyPrefix: proxyBodyPrefix(result.buffer),
      errorCode: null,
      errorMessage: null,
    }),
  };
}

function withoutNestedHistory(observation) {
  const { history: _history, ...revision } = observation;
  return revision;
}

function supersededRevision(observation, relatedSignalId) {
  const historical = structuredClone(withoutNestedHistory(observation));
  historical.provenance.claims.supersession = known({
    state: 'superseded',
    relatedSignalId,
  });
  return historical;
}

function mergeMndObservation(previous, incoming) {
  if (!previous) return incoming;
  if (previous.contentHash === incoming.contentHash) return previous;
  const sequence = Number(previous.revision?.sequence ?? 1) + 1;
  const signalId = `cross-strait:${incoming.id}:v${sequence}`;
  const revision = {
    vintageId: incoming.contentHash,
    sequence,
    state: 'corrected',
  };
  const history = [
    ...(Array.isArray(previous.history) ? previous.history : []),
    supersededRevision(previous, signalId),
  ];
  return {
    ...incoming,
    revision,
    history,
    provenance: buildProvenance({
      signalId,
      sourceId: 'taiwan-mnd',
      sourceUrl: incoming.sourceUrl,
      referenceId: sourceReferenceId(incoming.sourceUrl),
      reportingTime: incoming.reportingPeriod.end,
      publicationTime: incoming.publicationTime,
      retrievalTime: incoming.retrievalTime,
      revision,
      extractionConfidence: { score: 0.98, method: 'taiwan-mnd-english-html-parser-v1' },
      classificationConfidence: { score: 0.99, method: 'publisher-terminology-category-map-v1' },
    }),
  };
}

function toEpochDay(value) {
  return Math.floor(Date.parse(`${value}T00:00:00.000Z`) / DAY_MS);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function rounded(value) {
  return value == null ? null : Number(value.toFixed(4));
}

const MND_CATEGORY_KEYS = Object.freeze([
  'plaAircraftSorties',
  'planShips',
  'officialShips',
  'medianLineCrossings',
  'adizEntries',
]);

export function calculateActivityBaselines(observations) {
  const mnd = observations
    .filter((row) => row?.sourceId === 'taiwan-mnd')
    .sort((a, b) => Date.parse(a.reportingPeriod.end) - Date.parse(b.reportingPeriod.end));
  const latest = mnd.at(-1) ?? null;
  const categories = {};
  if (!latest) {
    return {
      sourceId: 'taiwan-mnd',
      semantics: 'prior-usable-reporting-days-excluding-current',
      categories,
    };
  }

  for (const category of MND_CATEGORY_KEYS) {
    const currentValue = latest.categories?.[category];
    const prior = mnd
      .slice(0, -1)
      .filter((row) => Number.isFinite(row.categories?.[category]));
    const windows = {};
    for (const windowDays of [30, 90]) {
      const sample = prior.slice(-windowDays);
      const values = sample.map((row) => Number(row.categories[category]));
      const firstDay = sample[0]?.reportingDay;
      const lastDay = sample.at(-1)?.reportingDay;
      const calendarSpanDays = firstDay && lastDay
        ? toEpochDay(lastDay) - toEpochDay(firstDay) + 1
        : 0;
      const enoughPriorData = sample.length >= windowDays;
      const currentAvailable = Number.isFinite(currentValue);
      const baseline = enoughPriorData ? median(values) : null;
      windows[windowDays] = {
        windowDays,
        state: enoughPriorData ? 'sufficient' : 'insufficient_data',
        statistic: 'median',
        value: baseline,
        sampleSize: sample.length,
        requiredSampleSize: windowDays,
        calendarSpanDays,
        missingCalendarDays: Math.max(0, calendarSpanDays - sample.length),
        sourceIds: ['taiwan-mnd'],
        difference: currentAvailable && baseline != null ? rounded(Number(currentValue) - baseline) : null,
        ratio: currentAvailable && baseline != null && baseline !== 0
          ? rounded(Number(currentValue) / baseline)
          : null,
        ...(!enoughPriorData ? {
          reason: 'insufficient_prior_reporting_days',
        } : {}),
      };
    }
    categories[category] = {
      current: {
        value: currentValue ?? null,
        reportingDay: latest.reportingDay,
        sourceId: 'taiwan-mnd',
      },
      windows,
    };
  }
  return {
    sourceId: 'taiwan-mnd',
    semantics: 'prior-usable-reporting-days-excluding-current',
    categories,
  };
}

function latestSourceSuccess(previousSnapshot, sourceId) {
  return previousSnapshot?.sources?.find((source) => source.id === sourceId)?.lastSuccessAt ?? null;
}

function crossStraitSnapshotStatus(hasMnd, anyError, usableMndReportingDays) {
  if (!hasMnd) return 'unavailable';
  if (anyError) return 'degraded';
  if (usableMndReportingDays < MND_REQUIRED_REPORTING_DAYS) return 'backfilling';
  return 'healthy';
}

function persistedStringsWithinLimit(value) {
  if (typeof value === 'string') return value.length <= MAX_PERSISTED_STRING_LENGTH;
  if (Array.isArray(value)) return value.every(persistedStringsWithinLimit);
  if (value && typeof value === 'object') {
    return Object.entries(value).every(([key, nested]) => (
      key.length <= MAX_PERSISTED_STRING_LENGTH
      && persistedStringsWithinLimit(nested)
    ));
  }
  return true;
}

function safePreviousMndObservation(row) {
  return row?.sourceId === 'taiwan-mnd'
    && /^\d{4}-\d{2}-\d{2}$/.test(row.reportingDay)
    && Number.isFinite(Date.parse(row.reportingPeriod?.start))
    && Number.isFinite(Date.parse(row.reportingPeriod?.end))
    && isAllowedSourceUrl(row.sourceUrl, CROSS_STRAIT_SOURCE_CONTRACTS.taiwanMnd)
    && persistedStringsWithinLimit(row);
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function vintageEpoch(history, reportingDay) {
  const value = Date.parse(history?.retrievalTime ?? history?.publicationTime ?? '');
  if (Number.isFinite(value)) return value;
  return Date.parse(`${reportingDay}T00:00:00.000Z`);
}

/**
 * Retain current rows first and prune the oldest correction vintages until the
 * complete durable snapshot has at least 1 MiB of headroom under runSeed's
 * 5 MiB Redis ceiling. Current observations are never removed here.
 */
export function constrainCrossStraitActivitySnapshotSize(snapshot) {
  if (serializedBytes(snapshot) <= CROSS_STRAIT_ACTIVITY_MAX_SERIALIZED_BYTES) return snapshot;

  const constrained = structuredClone(snapshot);
  const historyCandidates = constrained.observations
    .filter((row) => row?.sourceId === 'taiwan-mnd' && Array.isArray(row.history))
    .flatMap((row) => row.history.map((history, index) => ({
      row,
      index,
      reportingDay: row.reportingDay,
      vintageAt: vintageEpoch(history, row.reportingDay),
      bytes: serializedBytes(history) + 1,
    })))
    .sort((a, b) => (
      a.vintageAt - b.vintageAt
      || a.reportingDay.localeCompare(b.reportingDay)
      || a.index - b.index
    ));

  let projectedBytes = serializedBytes(constrained);
  const targetBytes = CROSS_STRAIT_ACTIVITY_MAX_SERIALIZED_BYTES - 64 * 1024;
  const removals = new Map();
  for (const candidate of historyCandidates) {
    if (projectedBytes <= targetBytes) break;
    const rowRemovals = removals.get(candidate.row) ?? new Set();
    rowRemovals.add(candidate.index);
    removals.set(candidate.row, rowRemovals);
    projectedBytes -= candidate.bytes;
  }
  for (const [row, indexes] of removals) {
    row.history = row.history.filter((_, index) => !indexes.has(index));
  }

  if (serializedBytes(constrained) > CROSS_STRAIT_ACTIVITY_MAX_SERIALIZED_BYTES) {
    throw new Error('MND_CANONICAL_PAYLOAD_TOO_LARGE');
  }
  return constrained;
}

export function buildCrossStraitActivitySnapshot({
  generatedAt,
  previousSnapshot,
  mndOutcome,
  japanOutcome,
}) {
  const byId = new Map(
    (previousSnapshot?.observations ?? [])
      .filter(safePreviousMndObservation)
      .map((row) => [row.id, row]),
  );
  for (const incoming of mndOutcome?.observations ?? []) {
    byId.set(incoming.id, mergeMndObservation(byId.get(incoming.id), incoming));
  }
  const mnd = [...byId.values()]
    .sort((a, b) => Date.parse(b.reportingPeriod.end) - Date.parse(a.reportingPeriod.end))
    .slice(0, MND_RETENTION_REPORTING_DAYS)
    .map((row) => ({
      ...row,
      history: (Array.isArray(row.history) ? row.history : [])
        .slice(-MND_MAX_REVISION_VINTAGES_PER_DAY),
    }));

  const previousJapanById = new Map(
    (previousSnapshot?.observations ?? [])
      .filter((row) => row?.sourceId === 'japan-mod')
      .map((row) => [row.id, row]),
  );
  const hasCurrentJapanIndex = japanOutcome?.ok === true;
  const availableJapanUrls = new Set(japanOutcome?.availableDocumentUrls ?? []);
  const japan = REVIEWED_JAPAN_MOD_OBSERVATIONS.map((row) => ({
    ...structuredClone(row),
    indexPresence: hasCurrentJapanIndex
      ? (availableJapanUrls.has(row.sourceUrl) ? 'present' : 'not_observed_in_current_index')
      : (previousJapanById.get(row.id)?.indexPresence ?? 'unknown'),
  }));
  const observations = [...mnd, ...japan];
  const usableMndReportingDays = new Set(mnd.map((row) => row.reportingDay)).size;
  const mndContract = CROSS_STRAIT_SOURCE_CONTRACTS.taiwanMnd;
  const japanContract = CROSS_STRAIT_SOURCE_CONTRACTS.japanMod;
  const previousJapanSource = previousSnapshot?.sources
    ?.find((source) => source?.id === japanContract.id);
  const unreviewedCandidateCount = hasCurrentJapanIndex
    ? Math.max(
        0,
        (japanOutcome?.availableDocumentUrls?.length ?? 0)
          - REVIEWED_JAPAN_MOD_OBSERVATIONS.filter((row) => availableJapanUrls.has(row.sourceUrl)).length,
      )
    : previousJapanSource?.unreviewedCandidateCount;
  const sources = [
    {
      id: mndContract.id,
      publisher: mndContract.publisher,
      publisherType: mndContract.publisherType,
      claimSemantics: 'publisher_claim_not_independent_observation',
      transportStatus: mndOutcome?.ok ? 'fresh' : 'error',
      requestCount: mndOutcome?.requestCount ?? 0,
      errorCodes: mndOutcome?.errorCodes ?? [],
      lastSuccessAt: mndOutcome?.ok
        ? generatedAt
        : latestSourceSuccess(previousSnapshot, 'taiwan-mnd'),
    },
    {
      id: japanContract.id,
      publisher: japanContract.publisher,
      publisherType: japanContract.publisherType,
      claimSemantics: 'reviewed_regional_augmentation',
      transportStatus: japanOutcome?.ok ? 'fresh' : 'error',
      requestCount: japanOutcome?.requestCount ?? 0,
      transportPath: japanOutcome?.transportPath ?? 'direct',
      ...(japanOutcome?.blockedReason
        ? { blockedReason: japanOutcome.blockedReason }
        : {}),
      ...(japanOutcome?.fallbackReason
        ? { fallbackReason: japanOutcome.fallbackReason }
        : {}),
      ...(japanOutcome?.proxyFailureReason
        ? { proxyFailureReason: japanOutcome.proxyFailureReason }
        : {}),
      ...(japanOutcome?.proxyFailureDetail
        ? { proxyFailureDetail: japanOutcome.proxyFailureDetail }
        : {}),
      errorCodes: japanOutcome?.errorCodes ?? [],
      lastSuccessAt: japanOutcome?.ok
        ? generatedAt
        : latestSourceSuccess(previousSnapshot, 'japan-mod'),
      admittedDocumentCount: REVIEWED_JAPAN_MOD_OBSERVATIONS.length,
      ...(Number.isInteger(unreviewedCandidateCount)
        ? { unreviewedCandidateCount }
        : {}),
    },
  ];
  const anyError = sources.some(
    (source) => source.transportStatus === 'error' && !source.blockedReason,
  );
  return constrainCrossStraitActivitySnapshotSize({
    schemaVersion: 1,
    generatedAt,
    status: crossStraitSnapshotStatus(mnd.length > 0, anyError, usableMndReportingDays),
    sources,
    coverage: {
      usableMndReportingDays,
      earliestMndReportingDay: mnd.at(-1)?.reportingDay ?? null,
      latestMndReportingDay: mnd[0]?.reportingDay ?? null,
      backfillComplete: usableMndReportingDays >= MND_REQUIRED_REPORTING_DAYS,
      requiredFor30DayComparison: 31,
      requiredFor90DayComparison: MND_REQUIRED_REPORTING_DAYS,
    },
    observations,
    baselines: calculateActivityBaselines(observations),
  });
}

function errorCode(error) {
  const value = String(error?.message ?? error ?? 'UNKNOWN_ERROR');
  if (/timeout/i.test(value)) return 'TIMEOUT';
  if (/RESPONSE_TOO_LARGE/.test(value)) return 'RESPONSE_TOO_LARGE';
  if (/HTTP_/.test(value)) return value.match(/HTTP_[A-Z0-9_]+/)?.[0] ?? 'HTTP_ERROR';
  if (/MND_/.test(value)) return value.match(/MND_[A-Z0-9_]+/)?.[0] ?? 'MND_PARSE_ERROR';
  if (/JMOD_/.test(value)) return value.match(/JMOD_[A-Z0-9_]+/)?.[0] ?? 'JMOD_PARSE_ERROR';
  return 'SOURCE_ERROR';
}

function boundedDiagnosticString(value, maxChars = PROXY_DIAGNOSTIC_MAX_CHARS) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/(https?:\/\/)[^@\s/]+@/giu, '$1[redacted]@')
    .replace(/(Proxy-Authorization:\s*)[^\r\n]+/giu, '$1[redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized ? normalized.slice(0, maxChars) : null;
}

function proxyBodyPrefix(value) {
  if (!Buffer.isBuffer(value)) return null;
  return boundedDiagnosticString(
    value.toString('utf8', 0, 1_024),
  );
}

function buildProxyDiagnosticDetail({
  stage,
  httpStatus = null,
  contentType = null,
  bodyPrefix = null,
  errorCode: detailErrorCode = null,
  errorMessage = null,
}) {
  const status = Number(httpStatus);
  return {
    stage,
    httpStatus: Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : null,
    contentType: boundedDiagnosticString(contentType, 128),
    bodyPrefix: boundedDiagnosticString(bodyPrefix),
    errorCode: boundedDiagnosticString(detailErrorCode, 64),
    errorMessage: boundedDiagnosticString(errorMessage),
  };
}

function proxyFailureDetail(error) {
  const message = String(error?.message ?? '');
  return buildProxyDiagnosticDetail({
    stage: error?.proxyStage === 'response'
      ? 'response'
      : (/Proxy CONNECT:/i.test(message) ? 'connect' : 'request'),
    httpStatus: error?.status,
    contentType: error?.contentType,
    bodyPrefix: error?.bodyPrefix,
    errorCode: error?.code,
    errorMessage: message,
  });
}

function proxyErrorCode(error) {
  const code = errorCode(error);
  if (Number(error?.status) === 407
    || code === 'HTTP_407'
    || /Proxy CONNECT:[^\n]*\b407\b/i.test(String(error?.message ?? ''))) {
    return 'PROXY_AUTH_FAILED';
  }
  if (Number(error?.status) === 403
    && /Proxy CONNECT:[^\n]*\b403\b/i.test(String(error?.message ?? ''))) {
    return 'PROXY_CONNECT_FORBIDDEN';
  }
  return String(error?.message ?? '').match(/PROXY_[A-Z0-9_]+/)?.[0] ?? code;
}

function blockedJapanProxyReason(directFailureCode, proxyFailureCode) {
  if (directFailureCode !== 'HTTP_403') return null;
  // A CONNECT refusal is emitted by the proxy before the TLS tunnel reaches
  // Japan MOD. Only a 403 response received after CONNECT proves that both
  // source-facing transport paths are externally blocked.
  return proxyFailureCode === 'HTTP_403' ? proxyFailureCode : null;
}

function rotatingRefreshCandidates(previousMnd, excludedUrls, now) {
  const eligible = [...new Map(
    previousMnd
      .filter((row) => (
        typeof row?.sourceUrl === 'string'
        && !excludedUrls.has(row.sourceUrl)
        && isAllowedSourceUrl(row.sourceUrl, CROSS_STRAIT_SOURCE_CONTRACTS.taiwanMnd)
      ))
      .sort((a, b) => Date.parse(a.reportingPeriod.end) - Date.parse(b.reportingPeriod.end))
      .map((row) => [row.sourceUrl, {
        publicationDay: row.publicationTime?.slice(0, 10) ?? row.reportingDay,
        expectedReportingDay: row.reportingDay,
        sourceUrl: row.sourceUrl,
        refresh: true,
        allowPublicationAdvance: true,
      }]),
  ).values()];
  if (eligible.length === 0) return [];
  const offset = (Math.floor(now / MND_REFRESH_ROTATION_INTERVAL_MS)
    * MND_REFRESH_DETAIL_REQUESTS_PER_RUN) % eligible.length;
  return Array.from({ length: Math.min(MND_REFRESH_DETAIL_REQUESTS_PER_RUN, eligible.length) },
    (_, index) => eligible[(offset + index) % eligible.length]);
}

function hasMndOutboundBudget({ runStartedAt, nowFn, cadenceMs }) {
  return nowFn() - runStartedAt + cadenceMs + REQUEST_TIMEOUT_MS <= MND_OUTBOUND_BUDGET_MS;
}

async function fetchJapanIndexOutcome(fetchFn, sleepFn, {
  proxyFetchFn = null,
} = {}) {
  const contract = CROSS_STRAIT_SOURCE_CONTRACTS.japanMod;
  let html;
  let requestCount = 1;
  let transportPath = 'direct';
  let fallbackReason = null;
  let proxyResponseDetail = null;
  try {
    await sleepFn(REQUEST_CADENCE_MS);
    html = await fetchBoundedText(fetchFn, contract.indexUrl, contract);
  } catch (directError) {
    if (!proxyFetchFn || !shouldProxyJapanModFailure(directError)) {
      return {
        ok: false,
        requestCount,
        transportPath,
        availableDocumentUrls: [],
        errorCodes: [errorCode(directError)],
      };
    }
    fallbackReason = errorCode(directError);
    requestCount += 1;
    transportPath = 'proxy';
    try {
      await sleepFn(REQUEST_CADENCE_MS);
      const proxyResult = await proxyFetchFn(contract.indexUrl, boundedHtmlRequestInit(contract));
      html = proxyResult.html;
      proxyResponseDetail = proxyResult.detail;
    } catch (proxyError) {
      const failureCode = proxyErrorCode(proxyError);
      const blockedReason = blockedJapanProxyReason(fallbackReason, failureCode);
      return {
        ok: false,
        ...(blockedReason ? { blockedReason } : {}),
        requestCount,
        transportPath,
        fallbackReason,
        proxyFailureReason: failureCode,
        proxyFailureDetail: proxyFailureDetail(proxyError),
        availableDocumentUrls: [],
        errorCodes: [...new Set([fallbackReason, failureCode])],
      };
    }
  }

  try {
    const rows = parseJapanModIndex(html);
    if (rows.length === 0) throw new Error('JMOD_INDEX_EMPTY');
    return {
      ok: true,
      requestCount,
      transportPath,
      ...(fallbackReason ? { fallbackReason } : {}),
      availableDocumentUrls: rows.map((row) => row.sourceUrl),
      errorCodes: [],
    };
  } catch (error) {
    const failureCode = errorCode(error);
    return {
      ok: false,
      requestCount,
      transportPath,
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(transportPath === 'proxy'
        ? { proxyFailureReason: failureCode }
        : {}),
      ...(transportPath === 'proxy'
        ? {
            proxyFailureDetail: buildProxyDiagnosticDetail({
              ...proxyResponseDetail,
              stage: 'parse',
              errorCode: failureCode,
              errorMessage: error?.message,
            }),
          }
        : {}),
      availableDocumentUrls: [],
      errorCodes: fallbackReason
        ? [...new Set([fallbackReason, failureCode])]
        : [failureCode],
    };
  }
}

export async function fetchCrossStraitActivitySnapshot({
  fetchFn = globalThis.fetch,
  now = Date.now(),
  nowFn = monotonicNow,
  previousSnapshot = null,
  mndListUrl = CROSS_STRAIT_SOURCE_CONTRACTS.taiwanMnd.listUrl,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  proxyUrl = process.env.JAPAN_MOD_PROXY_URL || process.env.PROXY_URL || '',
  proxyRequestFn = proxyFetch,
} = {}) {
  const generatedAt = new Date(now).toISOString();
  const previousMnd = (previousSnapshot?.observations ?? [])
    .filter((row) => row?.sourceId === 'taiwan-mnd');
  const previousMndByUrl = new Map(previousMnd.map((row) => [row.sourceUrl, row]));
  const needsBackfill = new Set(previousMnd.map((row) => row.reportingDay)).size
    < MND_REQUIRED_REPORTING_DAYS;
  const listPages = needsBackfill ? MND_MAX_LIST_PAGES_PER_BACKFILL_RUN : 1;
  const previousUrls = new Set(previousMnd.map((row) => row.sourceUrl));
  const latestCandidates = new Map();
  const unseenBackfillCandidates = new Map();
  const mndErrors = [];
  const mndContract = CROSS_STRAIT_SOURCE_CONTRACTS.taiwanMnd;
  const resolvedJapanProxyFetchFn = proxyUrl
    ? (input, init) => fetchJapanModViaConfiguredProxy(input, init, {
        proxyUrl,
        proxyRequestFn,
      })
    : null;
  const japanOutcomePromise = fetchJapanIndexOutcome(fetchFn, sleepFn, {
    proxyFetchFn: resolvedJapanProxyFetchFn,
  });
  let discoveredCount = 0;
  let requestCount = 0;
  const runStartedAt = nowFn();

  for (let page = 1; page <= listPages; page += 1) {
    const url = page === 1 ? mndListUrl : `${mndListUrl}/${page}`;
    const cadenceMs = requestCount > 0 ? REQUEST_CADENCE_MS : 0;
    if (!hasMndOutboundBudget({ runStartedAt, nowFn, cadenceMs })) {
      mndErrors.push('OUTBOUND_BUDGET_EXHAUSTED');
      break;
    }
    if (!isAllowedSourceUrl(url, mndContract)) {
      mndErrors.push('UNSAFE_SOURCE_URL');
      break;
    }
    try {
      if (cadenceMs) await sleepFn(cadenceMs);
      const html = await fetchBoundedText(fetchFn, url, mndContract);
      requestCount += 1;
      const rows = parseTaiwanMndList(html).map((row) => {
        const previous = previousMndByUrl.get(row.sourceUrl);
        return {
          ...row,
          page,
          ...(previous ? { expectedReportingDay: previous.reportingDay } : {}),
        };
      });
      discoveredCount += rows.length;
      for (const row of rows) {
        if (page === 1) {
          latestCandidates.set(row.sourceUrl, row);
        } else if (
          !previousUrls.has(row.sourceUrl)
          && !latestCandidates.has(row.sourceUrl)
          && !unseenBackfillCandidates.has(row.sourceUrl)
        ) {
          unseenBackfillCandidates.set(row.sourceUrl, row);
        }
      }
      if (
        latestCandidates.size + unseenBackfillCandidates.size
        >= MND_MAX_DETAIL_REQUESTS_PER_RUN
      ) {
        break;
      }
    } catch (error) {
      requestCount += 1;
      mndErrors.push(errorCode(error));
      if (page === 1) break;
    }
  }

  const primaryPool = [
    ...latestCandidates.values(),
    ...unseenBackfillCandidates.values(),
  ].slice(0, MND_MAX_DETAIL_REQUESTS_PER_RUN);
  const refreshCandidates = rotatingRefreshCandidates(
    previousMnd,
    new Set(primaryPool.map((row) => row.sourceUrl)),
    now,
  );
  const primaryCandidates = primaryPool.slice(
    0,
    MND_MAX_DETAIL_REQUESTS_PER_RUN - refreshCandidates.length,
  );
  const candidates = [...primaryCandidates, ...refreshCandidates]
    .slice(0, MND_MAX_DETAIL_REQUESTS_PER_RUN);
  const parsedMnd = [];
  for (const candidate of candidates) {
    if (!hasMndOutboundBudget({
      runStartedAt,
      nowFn,
      cadenceMs: REQUEST_CADENCE_MS,
    })) {
      mndErrors.push('OUTBOUND_BUDGET_EXHAUSTED');
      break;
    }
    try {
      await sleepFn(REQUEST_CADENCE_MS);
      const html = await fetchBoundedText(fetchFn, candidate.sourceUrl, mndContract);
      requestCount += 1;
      parsedMnd.push(parseTaiwanMndDetail(html, {
        sourceUrl: candidate.sourceUrl,
        retrievedAt: generatedAt,
        expectedPublicationDay: candidate.publicationDay,
        allowPublicationAdvance: candidate.allowPublicationAdvance === true,
        expectedReportingDay: candidate.expectedReportingDay ?? null,
      }));
    } catch (error) {
      requestCount += 1;
      mndErrors.push(errorCode(error));
    }
  }

  const japanOutcome = await japanOutcomePromise;
  const hasHardMndError = mndErrors.some(
    (code) => code !== 'OUTBOUND_BUDGET_EXHAUSTED',
  );
  const mndOutcome = {
    ok: discoveredCount > 0
      && !hasHardMndError
      && (candidates.length === 0 || parsedMnd.length > 0),
    requestCount,
    observations: parsedMnd,
    errorCodes: [...new Set(mndErrors)],
  };
  return buildCrossStraitActivitySnapshot({
    generatedAt,
    previousSnapshot,
    mndOutcome,
    japanOutcome,
  });
}

export function validateCrossStraitActivitySnapshot(snapshot) {
  if (
    !snapshot
    || snapshot.schemaVersion !== 1
    || !Number.isFinite(Date.parse(snapshot.generatedAt))
    || !['healthy', 'backfilling', 'degraded', 'unavailable'].includes(snapshot.status)
    || !Array.isArray(snapshot.sources)
    || !Array.isArray(snapshot.observations)
    || !Number.isInteger(snapshot.coverage?.usableMndReportingDays)
    || snapshot.coverage.usableMndReportingDays < 1
    || snapshot.baselines?.sourceId !== 'taiwan-mnd'
    || snapshot.baselines?.semantics !== 'prior-usable-reporting-days-excluding-current'
    || !persistedStringsWithinLimit(snapshot)
    || serializedBytes(snapshot) > CROSS_STRAIT_ACTIVITY_MAX_SERIALIZED_BYTES
  ) return false;
  const mnd = snapshot.observations.filter((row) => row?.sourceId === 'taiwan-mnd');
  if (mnd.length === 0) return false;
  return mnd.every((row) => (
    /^\d{4}-\d{2}-\d{2}$/.test(row.reportingDay)
    && Number.isFinite(Date.parse(row.reportingPeriod?.start))
    && Number.isFinite(Date.parse(row.reportingPeriod?.end))
    && Date.parse(row.reportingPeriod.end) > Date.parse(row.reportingPeriod.start)
    && isAllowedSourceUrl(row.sourceUrl, CROSS_STRAIT_SOURCE_CONTRACTS.taiwanMnd)
    && Object.values(row.categories ?? {}).length === MND_CATEGORY_KEYS.length
    && Object.values(row.categories).every(
      (value) => value == null || (Number.isInteger(value) && value >= 0),
    )
    && Array.isArray(row.history)
    && row.history.length <= MND_MAX_REVISION_VINTAGES_PER_DAY
    && Number.isInteger(row.revision?.sequence)
    && row.revision.sequence >= 1
    && row.provenance?.contractVersion === 'decision-signal-provenance/v1'
    && row.provenance?.familyId === 'operational_activity_record'
  ));
}
