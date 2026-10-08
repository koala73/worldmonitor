---
module: Dashboard presentation
component: China country snapshot and English UI copy
problem_type: conventions
tags: [ui, copy, acronyms, china, accessibility]
---

# Plain language for dashboard labels

The China country snapshot rendered internal category keys such as `plaAircraftSorties` and source IDs such as `taiwan-mnd`. Other dashboard labels assumed that readers knew military, market, and trade abbreviations.

The presentation layer now names the measurement. Chinese military aircraft flights, Chinese navy ships, other official vessels, and air defense identification zone entries remain separate counts. `formatChinaSignalText` translates known display tokens without changing numeric values, source links, source attribution, or the stored contract. Policy and disclosure titles remain as published. The same formatter handles China macro tile labels.

The English copy sweep covers panel names, headings, descriptions, map labels, search results, military popups, chart labels, economic comparisons, trade terms, and resilience help. The first-paint English dictionary uses the same wording and keeps its existing size limit. Changed English keys are retranslated in every shipped language catalog. The provenance baseline advances only after the translation pass completes; Traditional Chinese is regenerated from Simplified Chinese.

Currency codes, tickers, exchange identifiers, aircraft identifiers, product brands, settings keys, and quoted source titles keep their identity. Standard units stay compact where the label or help text explains them. A label should name the measurement; a description should explain a technical method. Do not replace arbitrary text across the document or rewrite external news headlines.

Manual review must check translated meaning as well as structure. This pass corrects region names, aircraft types, fund categories, and mixed-language fragments. Vietnamese most-favoured-nation wording can legitimately use the local term for preferential tariffs; the [Vietnam Trade Portal](https://www.vietnamtradeportal.gov.vn/?r=tradeInfo%2Findex) names it explicitly. Use the full local term rather than assume the English distinction maps word for word.

## Verification

The China renderer test covers the raw screenshot labels, separate counts, explicit zero, agency expansion, source attribution, escaping, and safe links. The country brief browser test opens China through its dashboard link on desktop and mobile, checks exact text and a source link, and checks for horizontal overflow with controlled source data. The existing worksheet tests cover the changed gas wording. The full DOM suite and locale freshness, markup, shell-budget, and search-description checks also run. Preserve the approved 150–160 character Chinese dashboard search description when refreshing translations. Delivery includes monitoring CI to completion and reviewing every PR comment. These checks do not verify production freshness or deployment.

The official definitions used for the copy include [Taiwan's military activity reports](https://www.mnd.gov.tw/en/news/plaact/86895), [the World Trade Organization tariff glossary](https://www.wto.org/english/thewto_e/glossary_e/mfn_tariff_e.htm), and [the Bank for International Settlements exchange-rate definitions](https://data.bis.org/topics/EER?lang=en).
