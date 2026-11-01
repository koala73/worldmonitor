---
title: "Localized MCP spoken answers share one data path; only the phrases change"
date: 2026-11-01
category: design-patterns
module: mcp-spoken
problem_type: design_pattern
component: assistant
severity: medium
applies_when:
  - "Adding a second language to a templated, non-LLM narration (MCP response_mode spoken or similar)"
  - "Adding an argument that shapes the response envelope but must never reach the tool or panel schemas"
  - "Speaking data whose own text (headlines, titles) may arrive in a language other than the answer's"
tags: [mcp, spoken-mode, arabic, i18n, plural-rules, voice-agents, response-mode, tts]
---

# Localized MCP spoken answers share one data path; only the phrases change

## Context

Issue #9722 asked for Arabic voice answers. The seven MCP tools with `response_mode: "spoken"` build a 2–3 sentence answer from templates, with no model call (#9971/#9977). PR #9986 added `spoken_language: "ar"`. Four things in that change carry over to any future language or response-shaping argument.

## Guidance

**1. Keep one data path per narrator and swap only the phrase set.** Each narrator in `api/mcp/spoken-narrators.ts` reads the payload once, picks values, caveats and freshness verdicts once, and takes its wording from a per-language object (`COUNTRY_RISK_PHRASES.en` / `.ar` and the other `*_PHRASES` objects). Don't write a second Arabic narrator. Two narrators drift: one gains a stale caveat or a new field, and the other doesn't. The tests in `tests/mcp-spoken-response-mode.test.mjs` enforce the invariant across languages:

- every number in the Arabic answer appears in the English answer;
- `citations`, `stale` and `asOf` are identical.

The English output stayed byte-identical: the existing spoken tests passed unchanged.

**2. Arabic templates avoid number-noun agreement, and where they can't, a CLDR plural picks the form.** Arabic changes the counted noun with the number: dual, a 3–10 plural, an 11–99 singular, and 100+. A template can't inflect for every count. So:

- Most sentences put the number after a "عدد X" construction (`وعدد الكيانات الخاضعة للعقوبات والمرتبطة بالبلد 132`), where agreement doesn't apply.
- Ages, points and hours have to be spoken with their noun. For those, `arabicCount` (`api/mcp/spoken.ts:222`) switches on `new Intl.PluralRules('ar').select(n)`:
  - `one` and `two` return the noun alone (ساعة, ساعتين);
  - `many` and `other` speak the number with the singular;
  - everything else, `few` and zero included, falls to the plural.

- A slip found in review: "من أصل 13 ممرات" (13 takes the singular). The fix was to drop the noun ("من أصل 13"), not to add another inflection.

Digits stay Western (`ar-u-nu-latn` at `api/mcp/spoken.ts:279`), because every Arabic TTS voice reads them. A percent sign is spoken as "في المئة" (`cleanSpeech`, `api/mcp/spoken.ts:165`).

**3. Data text keeps its own language, and its cleanup follows the spoken language.** Headline, market and forecast titles are data. They stay as published, and citations keep the English rendering in both languages. `get_media_perspective` reads a headline published in Arabic (`titleLanguage === 'ar'`) as published (`spoken-narrators.ts:753`). It keeps a separate `spokenTitle` so the citation `title` doesn't change by language. The first version cleaned that Arabic headline with the English rules, so `%` was spoken as "percent" and `٪` passed through unread. Greptile caught it on #9986, and the fix was test-first: `cleanTitle(headline.title, 120, 'ar')`. Rule: text cleanup takes the **answer's** language, not the language the code author expected the data to be in.

**4. A response-shaping argument is stripped before any schema sees it, and rejected wherever it can't apply.** `spoken_language` changes the envelope, not the query:

- It is advertised only on narrator tools (`_validate-args.ts:106`).
- It is removed from `callArguments` alongside `response_mode` and `panel_request` (`dispatch.ts:700`). Without that, strict tool and panel schemas reject it. The prediction-market path is the strict case the tests cover.
- It is rejected with `-32602` on a tool without a narrator, and without `response_mode: "spoken"` (`_validate-args.ts:112-117`).
- The legacy alias dispatch path repeats both checks (`dispatch.ts:672-677`). It bypasses the normal validator, so it needs its own guard and its own test.

## Why This Matters

Voice agents read the answer aloud without checking it. A wrong number, a dropped stale warning or a wrong noun form reaches the listener directly. A single data path makes "the Arabic answer says the same thing" a property of the code that tests can check, rather than a review chore for every change. Each other rule above corresponds to a defect that appeared or nearly shipped in #9986.

## When to Apply

- Adding another `spoken_language` value. Add a phrase set per narrator, extend the label maps, and add the language's speech invariants to the test helper (see `assertSpeakableArabic`).
- Adding any injected universal argument, such as a future `units` or `verbosity`. Copy the strip, advertise and reject pattern, including the legacy alias path.
- Speaking any upstream string. Decide whether it is data (keep it verbatim, clean it in the answer's language) or template (translate it).

## Examples

Pinned output, `get_country_risk {"country_code": "IQ", "response_mode": "spoken", "spoken_language": "ar"}`:

> درجة العراق على مؤشر عدم الاستقرار 62 من 100، والاتجاه تصاعدي. أكبر مساهمة تأتي من النزاع المسلح، بدرجة 72. تحذير السفر الحالي يدعو إلى إعادة النظر في السفر، وعدد الكيانات الخاضعة للعقوبات والمرتبطة بالبلد 132.

Plural selection:

```ts
arabicCount(1, AR_HOURS)   // "ساعة"
arabicCount(2, AR_HOURS)   // "ساعتين"
arabicCount(5, AR_HOURS)   // "5 ساعات"   (few)
arabicCount(15, AR_HOURS)  // "15 ساعة"   (many → singular)
```

Cleanup follows the answer's language:

```ts
// before: Arabic headline through English cleanup → "... 5 percent ..." and "٪" unread
cleanTitle(headline.title)
// after
lang === 'ar' && headline.titleLanguage === 'ar' ? cleanTitle(headline.title, 120, 'ar') : ''
```

## Related

- Issue #9722 (voice and agent consumers); PR #9986 (Arabic spoken answers); spoken mode in #9971 and #9977.
- Arabic country names as arguments: #9970, #9978. Arabic chokepoint names as arguments are not done yet: two of the five arguments are closed enums.
- `docs/solutions/design-patterns/mcp-freshness-check-for-a-new-key-stales-the-whole-tool.md`: the freshness verdicts that both languages must speak the same way.
