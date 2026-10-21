# Validated Telegram additions — 15 September 2026

The channels below are added to the full-variant curated ingestion list. Public trust
is based on the publisher and its remit. The configuration's operational tier
controls polling priority and is distinct from the public editorial tier.

| Handle | Public name | Public tier / type | Ownership evidence |
| --- | --- | --- | --- |
| `InaTEWS_BMKG` | BMKG InaTEWS | 1 / government | [BMKG bulletin names the channel](https://inatews.bmkg.go.id/eng/detail?day=614&name=20251010093608) |
| `dsns_telegram` | Ukraine State Emergency Service | 1 / government | [Ukraine government directory](https://cpd.gov.ua/announcement/spysok-bezpechnyh-kanaliv-otrymannya-informacziyi/) |
| `PikudHaOref_all` | Israel Home Front Command | 1 / government | [IDF social-account disclosure, section 7](https://www.idf.il/media/nqobwibi/מענה-לבקשה-בנושא-נתוני-חשיפה-לאתר-צהל-וחשבונות-הרשתות-החברתיות.pdf) |
| `cnalatest` | CNA | 2 / mainstream | [Mediacorp official channel list](https://www.mediacorp.sg/online-links-policy) |
| `govsg` | Singapore Government | 1 / government | [MDDI public communications](https://www.mddi.gov.sg/what-we-do/public-comms-and-engagement/public-communications/) |
| `wamnews_en` | Emirates News Agency (WAM) | 1 / wire | [WAM English website](https://www.wam.ae/en) |

WAM ownership was checked against its own website, not just the Telegram badge.
On the review date, its homepage loaded `main.1e54e97d20aca874.js`. That bundle's
social-link configuration contained `language:"en", website:"telegram",
link:"https://t.me/wamnews_en"`. Bundle filenames can change with site releases.

BMKG adds earthquake and tsunami bulletins; DSNS adds rescue and emergency
reports; Home Front Command adds civil-defense instructions; CNA adds Asian
news coverage; gov.sg adds official Singapore announcements; WAM adds UAE
state newswire reporting. CNA retains the existing RSS publisher name, so its
Telegram channel is not a separate publisher for corroboration.

State affiliations remain explicit. DSNS, Home Front Command, and WAM retain
medium propaganda risk for conflict-related claims even with Tier 1 provenance.
Government warnings are primary reports within the authority's remit, not
independent confirmation of every incident or military claim.

## Delivery scope

This change enables collection and public provenance in the existing Telegram
panel and source registry. It does not extend the Saudi-only notification
publisher. A Tier 1 entry alone does not enable user notifications. Notification
support for these sources requires a separate scoped change with freshness,
location, severity, update/cancellation, and duplicate-report checks.

Ownership checks and local fixture tests do not prove authenticated live polling,
production freshness, or notification delivery. No live alerts were sent.
