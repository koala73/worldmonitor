/**
 * Docs i18n parity: ensures every nav-included English MDX page has a
 * non-empty zh/ counterpart. Fails when English adds a page without a
 * zh translation — forces translators to notice drift.
 *
 * Reads docs.json navigation.languages, extracts the en page paths,
 * and asserts each has a corresponding zh/<path>.mdx that is non-empty
 * and contains Chinese characters (proving it was translated, not just
 * copied as a stub).
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).pathname;
const DOCS_JSON = join(ROOT, 'docs', 'docs.json');
const DOCS_DIR = join(ROOT, 'docs');

function readZhDoc(page) {
  return readFileSync(join(DOCS_DIR, 'zh', `${page}.mdx`), 'utf8');
}

function sectionBetween(content, startHeading, endHeading) {
  const start = content.indexOf(startHeading);
  assert.notEqual(start, -1, `Missing section heading: ${startHeading}`);
  const end = content.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(end, -1, `Missing following section heading: ${endHeading}`);
  return content.slice(start, end);
}

function collectPagePaths(node, pages = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectPagePaths(item, pages);
    return pages;
  }
  if (node && typeof node === 'object') {
    if (typeof node.pages === 'string') pages.push(node.pages);
    if (Array.isArray(node.pages)) {
      for (const p of node.pages) {
        if (typeof p === 'string') pages.push(p);
        else if (p && typeof p === 'object') collectPagePaths(p, pages);
      }
    }
    for (const [key, v] of Object.entries(node)) {
      if (key === 'pages') continue; // already traversed above
      if (v && typeof v === 'object') collectPagePaths(v, pages);
    }
  }
  return pages;
}

const docs = JSON.parse(readFileSync(DOCS_JSON, 'utf8'));
const languages = docs.navigation?.languages ?? [];

const enLang = languages.find(l => l.language === 'en');
const zhLang = languages.find(l => l.language === 'zh-Hans');

if (!enLang) throw new Error('No "en" language in docs.json navigation.languages');
if (!zhLang) throw new Error('No "zh-Hans" language in docs.json navigation.languages');

// Collect English page paths (root-level, no prefix)
const enPagesRaw = collectPagePaths(enLang);
// Filter out OpenAPI spec references and external URLs
const enPages = [...new Set(enPagesRaw)].filter(p =>
  typeof p === 'string' &&
  !p.startsWith('http') &&
  !p.startsWith('api/') &&
  !p.endsWith('.yaml') &&
  !p.endsWith('.json')
);

describe('docs i18n parity', () => {
  it('zh-Hans language is registered in navigation.languages', () => {
    assert.ok(zhLang, 'zh-Hans must be registered in navigation.languages');
  });

  it('en is the default (first) language', () => {
    assert.equal(languages[0].language, 'en', 'en must be first language (default)');
  });

  for (const page of enPages) {
    it(`zh/ counterpart exists for ${page}`, () => {
      const zhPath = join(DOCS_DIR, 'zh', page + '.mdx');
      assert.ok(existsSync(zhPath), `Missing zh/${page}.mdx`);
      const stat = statSync(zhPath);
      assert.ok(stat.size > 100, `zh/${page}.mdx is suspiciously small (${stat.size} bytes)`);
    });

    it(`zh/ counterpart is translated (has Chinese) for ${page}`, () => {
      const zhPath = join(DOCS_DIR, 'zh', page + '.mdx');
      if (!existsSync(zhPath)) return; // covered by existence test above
      const content = readFileSync(zhPath, 'utf8');
      const hasCJK = /[\u4e00-\u9fff]/.test(content);
      assert.ok(hasCJK, `zh/${page}.mdx has no Chinese characters — not translated`);
    });
  }

  it('every zh-Hans nav page path starts with zh/', () => {
    const zhPages = collectPagePaths(zhLang);
    const leaks = zhPages.filter(p =>
      typeof p === 'string' &&
      !p.startsWith('zh/') &&
      !p.startsWith('http') &&
      !p.startsWith('api/') &&
      !p.endsWith('.yaml') &&
      !p.endsWith('.json')
    );
    assert.equal(leaks.length, 0, `zh-Hans nav has non-zh/-prefixed page paths: ${leaks.join(', ')}`);
  });

  it('zh carousel docs preserve the live route, renderer, page map, image size, and token gate', () => {
    const content = readZhDoc('api-brief');
    const carousel = sectionBetween(content, '## 轮播', '## 辅助');

    assert.match(carousel, /\/api\/brief\/carousel\/\{userId\}\/\{issueDate\}\/\{page\}\.png\?t=\{token\}/);
    assert.match(carousel, /`page`[^\n]*\b0\b[^\n]*\b1\b[^\n]*\b2\b/);
    for (const pageName of ['cover', 'threads', 'story']) {
      assert.match(carousel, new RegExp(`\\b${pageName}\\b`));
    }
    assert.match(carousel, /@vercel\/og/);
    assert.match(carousel, /1200×630/);
    assert.match(carousel, /HMAC[^\n]*`\?t=`[^\n]*`403`/);
  });

  it('zh MCP error catalog documents every advertised code in the table and a detail section', () => {
    const content = readZhDoc('mcp-error-catalog');
    const codeTable = sectionBetween(content, '## JSON-RPC 错误代码', '下面的小节');
    const expectedCodes = ['-32001', '-32002', '-32003', '-32004', '-32029', '-32600', '-32601', '-32602', '-32603'];

    for (const code of expectedCodes) {
      assert.ok(codeTable.includes(`| \`${code}\``), `${code} must appear in the summary table`);
      assert.ok(content.includes(`### \`${code}\``), `${code} must have a recovery-detail section`);
    }
  });

  it('zh MCP error catalog distinguishes pre-check lapse admission from in-flight denial', () => {
    const content = readZhDoc('mcp-error-catalog');
    const denial = sectionBetween(content, '### `-32002`', '### `-32003`');
    const httpStatuses = sectionBetween(content, '## HTTP 状态码', '有一个 HTTP 状态码');

    assert.match(denial, /权益预检查[^\n]*免费账户[^\n]*不[^\n]*拒绝/);
    assert.match(denial, /`lapsed-subscription`[^\n]*罕见[^\n]*执行中[^\n]*下游/);
    assert.match(denial, /`upgrade-required`[^\n]*免费[^\n]*`subscription`[^\n]*非免费权益不足/);
    assert.match(httpStatuses, /\| \*\*403\*\*[^\n]*`lapsed-subscription`[^\n]*执行中[^\n]*免费账户/);
  });

  it('zh MCP overview distinguishes confirmed lapse, retryable verification, and insufficient tier', () => {
    const content = readZhDoc('mcp-overview');
    const signInNote = sectionBetween(content, '<Note>\n如果登录步骤', '</Note>');

    assert.match(signInNote, /服务方确认[^\n]*失效[^\n]*免费账户[^\n]*免费额度/);
    assert.match(signInNote, /重试[^\n]*503|503[^\n]*重试/);
    assert.match(signInNote, /权益[^\n]*(?:不足|停用)[^\n]*`403 INSUFFICIENT_TIER`/);
  });

  it('zh OAuth docs retain identity but remove paid capability after a confirmed lapse', () => {
    const apiOauth = readZhDoc('api-oauth');
    const mcpOverview = readZhDoc('mcp-overview');
    const usageErrors = readZhDoc('usage-errors');
    const overviewAuth = sectionBetween(mcpOverview, '## 认证', '### Redirect URI');
    const billingErrors = sectionBetween(usageErrors, '### 读取 `X-Billing-Verification`', '### 生成式 RPC');

    assert.match(apiOauth, /服务方确认[^\n]*覆盖期[^\n]*结束[^\n]*保留 OAuth 身份[^\n]*`free-account`/);
    assert.match(apiOauth, /非免费权益不足[^\n]*已停用权益[^\n]*仍会被拒绝/);
    assert.doesNotMatch(apiOauth, /降级后下一次请求即撤销访问/);

    assert.match(overviewAuth, /不会无条件撤销 OAuth 身份/);
    assert.match(overviewAuth, /覆盖期[^\n]*结束[^\n]*受限[^\n]*免费账户[^\n]*`free-account`/);
    assert.match(overviewAuth, /非免费权益不足[^\n]*已停用权益[^\n]*仍会被拒绝/);
    assert.doesNotMatch(overviewAuth, /订阅降级[^\n]*撤销 OAuth MCP 访问权限/);

    assert.match(billingErrors, /OAuth 预检查[^\n]*保留 OAuth 身份[^\n]*受限[^\n]*免费账户/);
    assert.match(billingErrors, /执行中途[^\n]*终态[^\n]*不携带 `Retry-After`/);
    assert.doesNotMatch(usageErrors, /`INSUFFICIENT_TIER`[^\n]*包括[^\n]*确认[^\n]*失效/);
  });

  it('zh MCP transport docs preserve discovery, replay, and 503 status distinctions', () => {
    const errorCatalog = readZhDoc('mcp-error-catalog');
    const mcpOverview = readZhDoc('mcp-overview');
    const internalError = sectionBetween(errorCatalog, '### `-32603`', '## HTTP 状态码');
    const httpStatuses = sectionBetween(errorCatalog, '## HTTP 状态码', '有一个 HTTP 状态码');
    const streamableHttp = sectionBetween(mcpOverview, '### Streamable HTTP 响应', '## 认证');

    assert.match(httpStatuses, /\| \*\*200\*\*[^\n]*普通 `GET`\/?`HEAD \/mcp`[^\n]*markdown 指南/);
    assert.match(httpStatuses, /\| \*\*400\*\*[^\n]*`-32600`[^\n]*`Mcp-Session-Id`/);
    assert.match(httpStatuses, /\| \*\*405\*\*[^\n]*SSE `Accept`[^\n]*`Last-Event-ID`/);
    assert.match(httpStatuses, /\| \*\*406\*\*[^\n]*`-32600`[^\n]*`text\/event-stream`/);
    assert.match(httpStatuses, /\| \*\*503\*\*[^\n]*`X-Billing-Verification`[^\n]*1[–-]60[^\n]*固定[^\n]*5 秒/);
    assert.doesNotMatch(errorCatalog, /无 `Last-Event-ID` 的裸 `GET`[^\n]*返回 405/);

    assert.match(internalError, /`renewal_verification_pending` \/ `renewal_verification_failed`[^\n]*动态 `Retry-After`（1[–-]60 秒）/);
    assert.match(internalError, /`entitlement_verification_unavailable`[^\n]*固定使用 `Retry-After: 5`/);
    assert.match(internalError, /`X-Billing-Verification`/);

    assert.match(streamableHttp, /`Accept: text\/event-stream`[^\n]*不带 `Last-Event-ID`[^\n]*`GET \/mcp`[^\n]*`405 Method Not Allowed`/);
    assert.match(streamableHttp, /普通 `GET \/mcp`[^\n]*无 SSE `Accept`[^\n]*`Last-Event-ID`[^\n]*`200`[^\n]*markdown/);
    assert.match(streamableHttp, /普通 `HEAD \/mcp`[^\n]*同一路由[^\n]*省略响应体/);
  });

  it('zh MCP overview limits -32002 lapses to the in-flight race', () => {
    const content = readZhDoc('mcp-overview');
    const errors = sectionBetween(content, '## 错误', '## 相关');

    assert.match(errors, /`lapsed-subscription`[^\n]*罕见竞态[^\n]*预检查通过[^\n]*执行中途/);
    assert.match(errors, /预检查时[^\n]*覆盖期结束[^\n]*OAuth 身份[^\n]*`free_account`/);
    assert.match(errors, /`upgrade-required`[^\n]*免费账户[^\n]*订阅工具[^\n]*非免费权益不足/);
    assert.doesNotMatch(errors, /`-32002`[^\n]*例如订阅已失效/);
  });
});
