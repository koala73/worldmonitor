import {
  landingHreflangCluster,
  type IndexableLandingLocale,
} from '../../shared/indexable-landing-locales';

const ESCAPE_ATTR_RE = /&/g;
const ESCAPE_ATTR_RE_2 = /"/g;
const ESCAPE_ATTR_RE_3 = /</g;
const ESCAPE_HTML_RE = />/g;
const REPLACE_HTML_LANG_RE = /<html\b[^>]*\blang="/i;
const REPLACE_HTML_LANG_RE_2 = /(<html\b[^>]*\blang=")[^"]*(")/i;
const REPLACE_HTML_LANG_RE_3 = /<html\b/i;
const BODY_RE = /<body\b/i;
const STRIP_BODY_NOSCRIPT_RE = /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi;
const HTML_TAG_RE = /<html\b[^>]*>/i;
const NEXT_TAG_RE = /\sdir="[^"]*"/i;
const REL_RE = /\brel="([^"]*)"/i;
const WHITESPACE_RE = /\s+/;
const IS_CANONICAL_OR_HREFLANG_LINK_RE = /\bhreflang="/i;
const OPEN_RE = /<head\b[^>]*>/i;
const CLOSE_OFFSET_RE = /<\/head\b/i;
const LINK_RE_RE = /<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const SET_PRERENDER_LANG_RE = /\bdata-wm-prerender-lang="/i;
const SET_PRERENDER_LANG_RE_2 = /(\bdata-wm-prerender-lang=")[^"]*(")/i;
const SET_PRERENDER_LANG_RE_3 = /<div id="root"/i;
const LOCALIZE_WELCOME_DOCUMENT_RE = /<title>[^<]*<\/title>/i;


export interface WelcomeLandingCopy {
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  faqs: readonly { q: string; a: string }[];
}

const JSON_LD_SCRIPT_RE =
  /<script\b(?=[^>]*\btype\s*=\s*["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi;

function escapeAttr(value: string): string {
  return value
    .replace(ESCAPE_ATTR_RE, '&amp;')
    .replace(ESCAPE_ATTR_RE_2, '&quot;')
    .replace(ESCAPE_ATTR_RE_3, '&lt;');
}

function escapeHtml(value: string): string {
  return value
    .replace(ESCAPE_ATTR_RE, '&amp;')
    .replace(ESCAPE_ATTR_RE_3, '&lt;')
    .replace(ESCAPE_HTML_RE, '&gt;');
}

// Every rewrite below uses a replacer FUNCTION. A replacement string expands
// `$1`, `$&`, `` $` `` and `$'`, and translated copy is not ours to rule out
// (see the #root injection note in prerender.mjs).
function replaceHtmlLang(html: string, lang: string): string {
  if (REPLACE_HTML_LANG_RE.test(html)) {
    return html.replace(REPLACE_HTML_LANG_RE_2, (_m, open: string, close: string) => `${open}${lang}${close}`);
  }
  return html.replace(REPLACE_HTML_LANG_RE_3, () => `<html lang="${lang}"`);
}

// Body-only: the <head> keeps its <noscript><link rel="stylesheet"> fallback
// that the critical-CSS inliner emits.
function stripBodyNoscript(html: string): string {
  const body = html.search(BODY_RE);
  if (body < 0) return html;
  return html.slice(0, body) + html.slice(body).replace(STRIP_BODY_NOSCRIPT_RE, '');
}

function setDocumentDir(html: string, dir: 'ltr' | 'rtl'): string {
  const htmlTag = html.match(HTML_TAG_RE)?.[0];
  if (!htmlTag) return html;
  let nextTag = htmlTag.replace(NEXT_TAG_RE, '');
  if (dir === 'rtl') {
    nextTag = nextTag.replace(REPLACE_HTML_LANG_RE_3, '<html dir="rtl"');
  }
  return html.replace(htmlTag, nextTag);
}

function setMeta(
  html: string,
  attr: 'name' | 'property',
  key: string,
  content: string,
): string {
  const escaped = escapeAttr(content);
  const named = new RegExp(
    `(<meta\\b[^>]*\\b${attr}="${key}"[^>]*\\bcontent=")[^"]*(")`,
    'i',
  );
  const splice = (_m: string, open: string, close: string) => `${open}${escaped}${close}`;
  if (named.test(html)) return html.replace(named, splice);
  const reversed = new RegExp(
    `(<meta\\b[^>]*\\bcontent=")[^"]*("[^>]*\\b${attr}="${key}")`,
    'i',
  );
  if (reversed.test(html)) return html.replace(reversed, splice);
  return html;
}

function clusterLinkTags(): string {
  const cluster = landingHreflangCluster();
  return cluster
    .map((entry) => `    <link rel="alternate" hreflang="${entry.hreflang}" href="${entry.href}" />`)
    .join('\n');
}

function linkRelations(tag: string): string[] {
  const rel = tag.match(REL_RE)?.[1]?.toLowerCase() ?? '';
  return rel.split(WHITESPACE_RE).filter(Boolean);
}

function isCanonicalOrHreflangLink(tag: string): boolean {
  const relations = linkRelations(tag);
  return relations.includes('canonical')
    || (relations.includes('alternate') && IS_CANONICAL_OR_HREFLANG_LINK_RE.test(tag));
}

function rewriteCanonicalAndHreflang(html: string, canonical: string): string {
  const canonicalTag = `    <link rel="canonical" href="${canonical}" />`;
  const block = `${canonicalTag}\n${clusterLinkTags()}\n`;
  const open = html.match(OPEN_RE);
  if (!open || open.index === undefined) return `${html}${block}`;
  const innerStart = open.index + open[0].length;
  const closeOffset = html.slice(innerStart).search(CLOSE_OFFSET_RE);
  if (closeOffset < 0) return `${html}${block}`;
  const inner = html.slice(innerStart, innerStart + closeOffset);
  const kept: string[] = [];
  const linkRe = LINK_RE_RE;
  let cursor = 0;
  for (const match of inner.matchAll(linkRe)) {
    const index = match.index ?? 0;
    kept.push(inner.slice(cursor, index));
    if (!isCanonicalOrHreflangLink(match[0])) kept.push(match[0]);
    cursor = index + match[0].length;
  }
  kept.push(inner.slice(cursor));
  return `${html.slice(0, innerStart)}${kept.join('')}${block}${html.slice(innerStart + closeOffset)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasType(node: Record<string, unknown>, type: string): boolean {
  const declared = node['@type'];
  if (Array.isArray(declared)) return declared.includes(type);
  return declared === type;
}

function rewriteJsonLdValue(
  value: unknown,
  locale: IndexableLandingLocale,
  copy: WelcomeLandingCopy,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteJsonLdValue(entry, locale, copy));
  }
  if (!isRecord(value)) return value;
  if (Array.isArray(value['@graph'])) {
    return {
      ...value,
      '@graph': value['@graph'].map((entry) => rewriteJsonLdValue(entry, locale, copy)),
    };
  }
  if (hasType(value, 'WebPage')) {
    const webpageId = `${locale.canonicalUrl}#webpage`;
    const breadcrumbId = `${locale.canonicalUrl}#breadcrumb`;
    const next: Record<string, unknown> = {
      ...value,
      '@id': webpageId,
      url: locale.canonicalUrl,
      name: copy.ogTitle,
      description: copy.description,
      inLanguage: locale.htmlLang,
    };
    if (isRecord(next.breadcrumb)) {
      next.breadcrumb = { ...next.breadcrumb, '@id': breadcrumbId };
    }
    return next;
  }
  if (hasType(value, 'BreadcrumbList')) {
    const items = Array.isArray(value.itemListElement)
      ? value.itemListElement.map((item, index) => {
        if (!isRecord(item) || index !== 0) return item;
        return { ...item, item: locale.canonicalUrl };
      })
      : value.itemListElement;
    return {
      ...value,
      '@id': `${locale.canonicalUrl}#breadcrumb`,
      itemListElement: items,
    };
  }
  if (hasType(value, 'FAQPage')) {
    return {
      ...value,
      mainEntity: copy.faqs.map((faq) => ({
        '@type': 'Question',
        name: faq.q,
        acceptedAnswer: { '@type': 'Answer', text: faq.a },
      })),
    };
  }
  return value;
}

function rewriteJsonLd(
  html: string,
  locale: IndexableLandingLocale,
  copy: WelcomeLandingCopy,
): string {
  return html.replace(JSON_LD_SCRIPT_RE, (_script, body: string) => {
    const next = rewriteJsonLdValue(JSON.parse(body), locale, copy);
    const serialized = JSON.stringify(next).replace(ESCAPE_ATTR_RE_3, '\\u003c');
    return `<script type="application/ld+json">${serialized}</script>`;
  });
}

function setPrerenderLang(html: string, localeId: string): string {
  if (SET_PRERENDER_LANG_RE.test(html)) {
    return html.replace(
      SET_PRERENDER_LANG_RE_2,
      (_m, open: string, close: string) => `${open}${localeId}${close}`,
    );
  }
  return html.replace(
    SET_PRERENDER_LANG_RE_3,
    () => `<div id="root" data-wm-prerendered="welcome" data-wm-prerender-lang="${localeId}"`,
  );
}

/**
 * Rewrite a cloned English welcome document into one indexable locale.
 * Leaves `#website` / `#organization` / `#software` node values untouched so
 * the product graph stays one body per `@id`.
 *
 * The English default only gains the canonical + hreflang cluster. Its title,
 * meta, JSON-LD (and the CSP hashes over it) and noscript fallback stay as the
 * template authored them.
 */
export function localizeWelcomeDocument(
  html: string,
  locale: IndexableLandingLocale,
  copy: WelcomeLandingCopy,
): string {
  let next = replaceHtmlLang(html, locale.htmlLang);
  next = setDocumentDir(next, locale.dir);
  if (!locale.isDefault) {
    next = next.replace(LOCALIZE_WELCOME_DOCUMENT_RE, () => `<title>${escapeHtml(copy.title)}</title>`);
    next = setMeta(next, 'name', 'description', copy.description);
    next = setMeta(next, 'property', 'og:title', copy.ogTitle);
    next = setMeta(next, 'property', 'og:description', copy.ogDescription);
    next = setMeta(next, 'property', 'og:url', locale.canonicalUrl);
    next = setMeta(next, 'property', 'og:locale', locale.ogLocale);
    next = setMeta(next, 'name', 'twitter:title', copy.ogTitle);
    next = setMeta(next, 'name', 'twitter:description', copy.ogDescription);
  }
  next = rewriteCanonicalAndHreflang(next, locale.canonicalUrl);
  if (!locale.isDefault) {
    next = rewriteJsonLd(next, locale, copy);
    // The template's <noscript> body is English marketing copy; the prerendered
    // #root already gives no-JS clients the translated document.
    next = stripBodyNoscript(next);
  }
  next = setPrerenderLang(next, locale.id);
  return next;
}
