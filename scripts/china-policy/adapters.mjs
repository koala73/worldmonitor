import { CHROME_UA } from '../_seed-utils.mjs';
import { decodeHtmlEntities } from '../_html-entities.mjs';
import { extractDocumentNumber } from './normalize.mjs';

const DEFAULT_FETCH = (...args) => globalThis.fetch(...args);
const LIST_BYTES = 750_000;
const DOCUMENT_BYTES = 2_000_000;
const MAX_DOCUMENTS = 3;
const REQUEST_CADENCE_MS = 400;
const REQUEST_TIMEOUT_MS = 15_000;

const SAMR_LIST_URL = new URL('https://www.samr.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit');
SAMR_LIST_URL.search = new URLSearchParams({
  webId: '29e9522dc89d4e088a953d8cede72f4c',
  pageId: 'dedefc44460a4338ac649d95f0ed8023',
  parseType: 'bulidstatic',
  pageType: 'column',
  tagId: '内容区域',
  tplSetId: '5c30fb89ae5e48b9aefe3cdf49853830',
  pageNo: '1',
}).toString();

const MIIT_LIST_URL = new URL('https://www.miit.gov.cn/search-front-server/api/search/info');
MIIT_LIST_URL.search = new URLSearchParams({
  websiteid: '110000000000000',
  scope: 'basic',
  q: '',
  pg: '10',
  cateid: '58',
  pos: 'title_text,infocontent,titlepy',
  _cus_eq_typename: '',
  _cus_eq_publishgroupname: '',
  _cus_eq_themename: '',
  begin: '',
  end: '',
  dateField: 'deploytime',
  selectFields: 'title,content,deploytime,_index,url,cdate,infoextends,infocontentattribute,columnname,filenumbername,publishgroupname,publishtime,metaid,bexxgk,columnid,xxgkextend1,xxgkextend2,themename,typename,indexcode,createdate',
  group: 'distinct',
  highlightConfigs: '[{"field":"infocontent","numberOfFragments":2,"fragmentOffset":0,"fragmentSize":30,"noMatchSize":145}]',
  highlightFields: 'title_text,infocontent,webid',
  level: '6',
  sortFields: '[{"name":"deploytime","type":"desc"}]',
  p: '1',
}).toString();

function source(listUrl, allowedHost, listingFormat, documentPathPattern, requiredSearchParam = null) {
  return Object.freeze({
    listUrl,
    allowedHost,
    listingFormat,
    documentPathPattern,
    requiredSearchParam,
    maxListBytes: LIST_BYTES,
    maxDocumentBytes: DOCUMENT_BYTES,
    maxDocumentsPerRun: MAX_DOCUMENTS,
    requestCadenceMs: REQUEST_CADENCE_MS,
  });
}

export const CHINA_POLICY_SOURCES = Object.freeze({
  CAC: source(
    'https://www.cac.gov.cn/wxzw/zcfg/A093703index_1.htm',
    'www.cac.gov.cn',
    'html',
    /^\/\d{4}-\d{2}\/\d{2}\/c_\d+\.htm$/,
  ),
  SAMR: source(
    SAMR_LIST_URL.href,
    'www.samr.gov.cn',
    'samr-json',
    /^\/zw\/zfxxgk\/.+\/art\/\d{4}\/art_[0-9a-f]+\.html$/,
  ),
  MIIT: source(
    MIIT_LIST_URL.href,
    'www.miit.gov.cn',
    'miit-json',
    /^\/zwgk\/zcwj\/.+\/art\/\d{4}\/art_[0-9a-f]+\.html$/,
  ),
  MOFCOM: source(
    'https://www.mofcom.gov.cn/zcfb/index.html',
    'www.mofcom.gov.cn',
    'html',
    /^\/zcfb\/.+\/art\/\d{4}\/art_[0-9a-f]+\.html$/,
  ),
  NDRC: source(
    'https://zfxxgk.ndrc.gov.cn/web/zclist.jsp?dirid=41&pid=39',
    'zfxxgk.ndrc.gov.cn',
    'html',
    /^\/web\/iteminfo\.jsp$/,
    ['id', /^\d+$/],
  ),
  PBOC: source(
    'https://www.pbc.gov.cn/tiaofasi/144941/144957/index.html',
    'www.pbc.gov.cn',
    'html',
    /^\/tiaofasi\/144941\/144957\/\d+\/index\.html$/,
  ),
});

const NON_DOCUMENT_TITLE = /专家解读|答记者问|一图读懂|公开招聘|拟聘|预算|公示|工作动态/;
const POLICY_TITLE_HINT = /条例|规定|办法|规章|决定|公告|通知|意见|方案|指南|规划|批复|裁定|处罚|调查|管控名单|管理措施|禁令|令〔|令\d/;
const BLOCK_PAGE_PATTERN = /Access Denied|访问频繁|安全验证|验证码|请求被拒绝|系统繁忙|页面不存在|404 Not Found|服务异常/i;
const RAW_TEXT_TAGS = new Set(['script', 'style']);
const VOID_TAGS = new Set([
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

function attributeValue(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(attributes ?? '').match(new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    'i',
  ));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function parseTagAt(html, start) {
  if (html.startsWith('<!--', start)) {
    const commentEnd = html.indexOf('-->', start + 4);
    return {
      end: commentEnd === -1 ? html.length : commentEnd + 3,
      name: null,
    };
  }

  let cursor = start + 1;
  if (html[cursor] === '!' || html[cursor] === '?') {
    const specialEnd = html.indexOf('>', cursor + 1);
    return {
      end: specialEnd === -1 ? html.length : specialEnd + 1,
      name: null,
    };
  }
  let closing = false;
  if (html[cursor] === '/') {
    closing = true;
    cursor += 1;
  }
  if (!/[A-Za-z]/.test(html[cursor] ?? '')) return null;
  let nameEnd = cursor + 1;
  while (/[A-Za-z0-9:-]/.test(html[nameEnd] ?? '')) nameEnd += 1;
  const name = html.slice(cursor, nameEnd).toLowerCase();
  const attributesStart = nameEnd;
  let quote = null;
  let end = attributesStart;
  for (; end < html.length; end += 1) {
    const char = html[end];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') break;
  }
  const complete = end < html.length;
  const attributes = html.slice(attributesStart, complete ? end : html.length);
  return {
    attributes,
    closing,
    end: complete ? end + 1 : html.length,
    name,
    selfClosing: /\/\s*$/.test(attributes),
  };
}

function walkHtml(input, { onTag, onText } = {}) {
  const html = String(input ?? '');
  let cursor = 0;
  let suppressedTag = null;
  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart === -1) {
      if (!suppressedTag && cursor < html.length) onText?.(html.slice(cursor));
      break;
    }
    if (!suppressedTag && tagStart > cursor) onText?.(html.slice(cursor, tagStart));
    const tag = parseTagAt(html, tagStart);
    if (!tag) {
      if (!suppressedTag) onText?.('<');
      cursor = tagStart + 1;
      continue;
    }
    cursor = tag.end;
    if (!tag.name) continue;
    if (suppressedTag) {
      if (tag.closing && tag.name === suppressedTag) suppressedTag = null;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && RAW_TEXT_TAGS.has(tag.name)) {
      suppressedTag = tag.name;
      continue;
    }
    onTag?.(tag);
  }
}

function normalizeHtmlText(parts) {
  return decodeHtmlEntities(parts.join(' ')).replace(/\s+/g, ' ').trim();
}

function stripHtml(input) {
  const parts = [];
  walkHtml(input, {
    onText: (text) => parts.push(text),
  });
  return normalizeHtmlText(parts);
}

function validDay(value) {
  const token = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(token)) return null;
  const parsed = Date.parse(`${token}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? token : null;
}

function canonicalizeSourceUrl(value, sourceConfig) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let parsed;
  try {
    if (raw.startsWith('//')) parsed = new URL(`https:${raw}`);
    else parsed = new URL(raw, sourceConfig.listUrl);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  parsed.hash = '';
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== sourceConfig.allowedHost
    || parsed.username
    || parsed.password
    || !sourceConfig.documentPathPattern.test(parsed.pathname)
    || (
      sourceConfig.requiredSearchParam
      && !sourceConfig.requiredSearchParam[1].test(
        parsed.searchParams.get(sourceConfig.requiredSearchParam[0]) ?? '',
      )
    )
  ) {
    return null;
  }
  return parsed.href;
}

function dateNearAnchor(html, anchorEnd) {
  const nearby = html.slice(anchorEnd, anchorEnd + 500);
  return validDay(nearby.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1]);
}

function parseHtmlListing(agency, html, sourceConfig) {
  const rows = [];
  let anchor = null;
  walkHtml(html, {
    onTag: (tag) => {
      if (tag.name !== 'a') return;
      if (!tag.closing) {
        anchor = {
          attributes: tag.attributes,
          parts: [],
        };
        return;
      }
      if (!anchor) return;
      const rawHref = attributeValue(anchor.attributes, 'href') ?? '';
      const titleOriginal = normalizeHtmlText([
        attributeValue(anchor.attributes, 'title') ?? anchor.parts.join(' '),
      ]);
      const canonicalUrl = canonicalizeSourceUrl(rawHref, sourceConfig);
      const publicationDate = dateNearAnchor(html, tag.end);
      if (
        canonicalUrl
        && publicationDate
        && titleOriginal.length >= 5
        && !NON_DOCUMENT_TITLE.test(titleOriginal)
        && POLICY_TITLE_HINT.test(titleOriginal)
      ) {
        rows.push({
          agency,
          canonicalUrl,
          titleOriginal,
          publicationDate,
          originalText: '',
          documentNumber: extractDocumentNumber(titleOriginal),
        });
      }
      anchor = null;
    },
    onText: (text) => {
      if (anchor) anchor.parts.push(text);
    },
  });
  return rows;
}

function parseMiitListing(raw, sourceConfig) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  const groups = payload?.data?.searchResult?.dataResults ?? [];
  const rows = [];
  for (const result of groups) {
    for (const group of result?.groupData ?? []) {
      const data = group?.data;
      if (!data || typeof data !== 'object') continue;
      const canonicalUrl = canonicalizeSourceUrl(data.url, sourceConfig);
      const publicationDate = validDay(data.jsearch_date);
      const titleOriginal = stripHtml(data.title_text || data.title);
      const listingText = stripHtml(data.infocontent);
      if (!canonicalUrl || !publicationDate || titleOriginal.length < 5 || listingText.length < 5) {
        continue;
      }
      rows.push({
        agency: 'MIIT',
        canonicalUrl,
        titleOriginal,
        publicationDate,
        originalText: '',
        documentNumber: stripHtml(data.filenumbername) || extractDocumentNumber(titleOriginal),
      });
    }
  }
  return rows;
}

export function parseAgencyListing(agency, raw) {
  const sourceConfig = CHINA_POLICY_SOURCES[agency];
  if (!sourceConfig) throw new TypeError(`Unknown agency ${String(agency)}`);
  if (sourceConfig.listingFormat === 'miit-json') return parseMiitListing(raw, sourceConfig);
  if (sourceConfig.listingFormat === 'samr-json') {
    try {
      const payload = JSON.parse(raw);
      return parseHtmlListing(agency, String(payload?.data?.html ?? ''), sourceConfig);
    } catch {
      return [];
    }
  }
  return parseHtmlListing(agency, raw, sourceConfig);
}

function createPolicyHtmlState() {
  return {
    stack: [],
    openTagCounts: new Map(),
    captures: new Map(),
    candidates: new Map(),
    allParts: [],
    titleParts: [],
    metadata: {},
    bodyCapture: null,
    titleDepth: 0,
    titleComplete: false,
  };
}

function unwindPolicyHtmlClosingTag(
  tag,
  state,
  { requireKnownTag = true, onStackComparison } = {},
) {
  if (requireKnownTag && !state.openTagCounts.has(tag.name)) return false;
  let stackIndex = state.stack.length - 1;
  while (stackIndex >= 0 && state.stack[stackIndex] !== tag.name) {
    onStackComparison?.();
    stackIndex -= 1;
  }
  if (stackIndex < 0) return false;

  const closingDepth = stackIndex + 1;
  for (const [priority, capture] of state.captures) {
    if (capture.depth !== closingDepth || capture.tagName !== tag.name) continue;
    const text = normalizeHtmlText(capture.parts);
    if (text.length >= 10) state.candidates.set(priority, text);
    state.captures.delete(priority);
  }
  if (
    state.bodyCapture
    && state.bodyCapture.depth === closingDepth
    && state.bodyCapture.tagName === tag.name
  ) {
    state.bodyCapture.text = normalizeHtmlText(state.bodyCapture.parts);
  }
  if (tag.name === 'title' && state.titleDepth > 0) {
    state.titleDepth -= 1;
    if (state.titleDepth === 0) state.titleComplete = true;
  }
  for (let index = state.stack.length - 1; index >= stackIndex; index -= 1) {
    const openName = state.stack[index];
    const remaining = state.openTagCounts.get(openName) - 1;
    if (remaining === 0) state.openTagCounts.delete(openName);
    else state.openTagCounts.set(openName, remaining);
  }
  state.stack.length = stackIndex;
  return true;
}

function parsePolicyHtmlFields(html, options = {}) {
  const classPriority = ['article-content', 'main-content', 'TRS_Editor', 'content'];
  const state = createPolicyHtmlState();
  walkHtml(html, {
    onTag: (tag) => {
      if (tag.closing) {
        unwindPolicyHtmlClosingTag(tag, state, options);
        return;
      }
      if (tag.name === 'meta') {
        const metaName = attributeValue(tag.attributes, 'name')?.toLowerCase();
        if (
          (metaName === 'articletitle' || metaName === 'pubdate')
          && !state.metadata[metaName]
        ) {
          state.metadata[metaName] = normalizeHtmlText([
            attributeValue(tag.attributes, 'content') ?? '',
          ]);
        }
      }
      if (tag.selfClosing || VOID_TAGS.has(tag.name)) return;
      state.stack.push(tag.name);
      state.openTagCounts.set(
        tag.name,
        (state.openTagCounts.get(tag.name) ?? 0) + 1,
      );
      if (tag.name === 'title' && !state.titleComplete) state.titleDepth += 1;
      if (tag.name === 'body' && !state.bodyCapture) {
        state.bodyCapture = {
          depth: state.stack.length,
          parts: [],
          tagName: tag.name,
          text: '',
        };
      }
      if (!['div', 'td', 'article'].includes(tag.name)) return;
      const classes = new Set((attributeValue(tag.attributes, 'class') ?? '').split(/\s+/));
      const priority = classPriority.findIndex((className) => classes.has(className));
      if (
        priority === -1
        || state.candidates.has(priority)
        || state.captures.has(priority)
      ) return;
      state.captures.set(priority, {
        depth: state.stack.length,
        parts: [],
        tagName: tag.name,
      });
    },
    onText: (text) => {
      state.allParts.push(text);
      for (const capture of state.captures.values()) capture.parts.push(text);
      if (state.bodyCapture && !state.bodyCapture.text) state.bodyCapture.parts.push(text);
      if (state.titleDepth > 0 && !state.titleComplete) state.titleParts.push(text);
    },
  });
  let originalText = '';
  for (let priority = 0; priority < classPriority.length; priority += 1) {
    if (state.candidates.has(priority)) {
      originalText = state.candidates.get(priority);
      break;
    }
  }
  return {
    articleTitle: state.metadata.articletitle || normalizeHtmlText(state.titleParts),
    publicationDate: state.metadata.pubdate || '',
    originalText: originalText || state.bodyCapture?.text || normalizeHtmlText(state.allParts),
  };
}

function runPolicyHtmlClosingTagRegressionProbe(html) {
  let stackComparisons = 0;
  parsePolicyHtmlFields(html, {
    requireKnownTag: false,
    onStackComparison: () => {
      stackComparisons += 1;
    },
  });
  return stackComparisons;
}

export function extractEffectiveDate(text) {
  const match = String(text).match(
    /(?:自|于)\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:起)?(?:施行|实施|生效)/,
  );
  if (!match) return null;
  const year = match[1];
  const month = match[2].padStart(2, '0');
  const day = match[3].padStart(2, '0');
  return validDay(`${year}-${month}-${day}`);
}

export function parsePolicyDocumentHtml(html, fallback = {}) {
  const parsed = parsePolicyHtmlFields(html);
  const titleOriginal = parsed.articleTitle
    || fallback.titleOriginal
    || '';
  const publicationDate = validDay(parsed.publicationDate) ?? fallback.publicationDate ?? null;
  const { originalText } = parsed;
  return {
    titleOriginal,
    publicationDate,
    originalText,
    effectiveDate: extractEffectiveDate(originalText),
    documentNumber: extractDocumentNumber(`${titleOriginal} ${originalText}`),
  };
}

async function readBoundedBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`response exceeded ${maxBytes} bytes`);
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`response exceeded ${maxBytes} bytes`);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

async function fetchBounded(url, sourceConfig, maxBytes, fetchImpl, allowedContentTypes) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== sourceConfig.allowedHost) {
    throw new Error(`disallowed source URL ${parsed.href}`);
  }
  const response = await fetchImpl(parsed.href, {
    headers: {
      Accept: 'application/json, text/html;q=0.9, */*;q=0.1',
      'User-Agent': CHROME_UA,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType || !allowedContentTypes.includes(contentType)) {
    throw new Error(`unexpected content type ${contentType || 'missing'}`);
  }
  return readBoundedBody(response, maxBytes);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchAgencyDocuments(agency, {
  fetchImpl = DEFAULT_FETCH,
  sleep = wait,
} = {}) {
  const sourceConfig = CHINA_POLICY_SOURCES[agency];
  if (!sourceConfig) throw new TypeError(`Unknown agency ${String(agency)}`);
  const listedAt = new Date().toISOString();
  const listing = await fetchBounded(
    sourceConfig.listUrl,
    sourceConfig,
    sourceConfig.maxListBytes,
    fetchImpl,
    sourceConfig.listingFormat.endsWith('json')
      ? ['application/json']
      : ['text/html', 'application/xhtml+xml'],
  );
  const candidates = parseAgencyListing(agency, listing)
    .slice(0, sourceConfig.maxDocumentsPerRun);
  const documents = [];
  const failures = [];
  let requestCount = 1;
  if (candidates.length === 0) {
    failures.push({
      canonicalUrl: sourceConfig.listUrl,
      reason: 'listing produced no eligible policy documents',
    });
  }

  for (const candidate of candidates) {
    if (candidate.originalText) {
      documents.push({
        ...candidate,
        effectiveDate: extractEffectiveDate(candidate.originalText),
      });
      continue;
    }
    await sleep(sourceConfig.requestCadenceMs);
    requestCount += 1;
    try {
      const detail = await fetchBounded(
        candidate.canonicalUrl,
        sourceConfig,
        sourceConfig.maxDocumentBytes,
        fetchImpl,
        ['text/html', 'application/xhtml+xml'],
      );
      const parsed = parsePolicyDocumentHtml(detail, candidate);
      if (
        !parsed.originalText
        || !parsed.publicationDate
        || BLOCK_PAGE_PATTERN.test(`${parsed.titleOriginal} ${parsed.originalText.slice(0, 500)}`)
      ) {
        throw new Error('document body or date missing');
      }
      documents.push({
        ...candidate,
        ...parsed,
        documentNumber: parsed.documentNumber ?? candidate.documentNumber,
      });
    } catch (error) {
      failures.push({
        canonicalUrl: candidate.canonicalUrl,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    agency,
    status: documents.length === 0 ? 'error' : failures.length > 0 ? 'partial' : 'ok',
    retrievedAt: listedAt,
    documents,
    failures,
    requestCount,
  };
}

export async function fetchAllChinaPolicyDocuments(options = {}) {
  const results = await Promise.all(Object.keys(CHINA_POLICY_SOURCES).map(async (agency) => {
    try {
      return {
        agency,
        result: await fetchAgencyDocuments(agency, options),
      };
    } catch (error) {
      return {
        agency,
        error,
      };
    }
  }));
  const agencies = {};
  const documents = [];
  let successCount = 0;
  for (const entry of results) {
    const { agency } = entry;
    if (entry.result) {
      const { result } = entry;
      agencies[agency] = {
        status: result.status,
        retrievedAt: result.retrievedAt,
        documentCount: result.documents.length,
        failures: result.failures,
        requestCount: result.requestCount,
      };
      if (result.documents.length > 0) {
        successCount += 1;
        documents.push(...result.documents.map((document) => ({
          ...document,
          retrievedAt: result.retrievedAt,
        })));
      }
    } else {
      const { error } = entry;
      agencies[agency] = {
        status: 'error',
        retrievedAt: new Date().toISOString(),
        documentCount: 0,
        failures: [{
          canonicalUrl: CHINA_POLICY_SOURCES[agency].listUrl,
          reason: error instanceof Error ? error.message : String(error),
        }],
        requestCount: 1,
      };
    }
  }
  if (successCount === 0) throw new Error('All official China policy sources failed');
  return { agencies, documents };
}

export const __testing__ = Object.freeze({
  canonicalizeSourceUrl,
  readBoundedBody,
  runPolicyHtmlClosingTagRegressionProbe,
  stripHtml,
});
