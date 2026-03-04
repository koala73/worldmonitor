# Omni Sentinel -- Legal & Terms of Service Compliance

**Last Updated:** 2026-03-03
**Status:** Living document -- must be reviewed before each data source integration
**Scope:** All external data sources, APIs, and AI providers used by Omni Sentinel

---

## Overview

Omni Sentinel aggregates data from social media platforms, government agencies, aviation and maritime tracking networks, prediction markets, and AI providers. Each data source has its own Terms of Service (ToS), licensing terms, and legal framework governing how data may be accessed, processed, stored, and displayed.

This document catalogs the legal posture of every data source in the system. It is intended as a practical compliance reference for contributors, not as legal advice. Where a source presents legal risk, this document identifies the risk and proposes mitigation. Contributors should consult qualified legal counsel before deploying features that interact with sources marked as HIGH or CRITICAL risk.

**Governing principle:** Omni Sentinel accesses only publicly available data through documented APIs or open protocols. It does not scrape behind authentication walls, does not store bulk datasets for redistribution, and does not train machine learning models on third-party data.

---

## Data Source Compliance Matrix

| Source | Access Method | ToS Status | Key Restrictions | Risk Level |
|--------|--------------|------------|------------------|------------|
| **Twitter/X** | TwitterAPI.io (third-party) | ToS prohibits scraping; third-party access is a gray area | No scraping; display requirements for tweets; no AI training on tweet content | HIGH |
| **Reddit** | OAuth2 API (official) | Compliant if OAuth2 used; AI ingestion clause is a concern | Prohibits using Reddit data to train/improve AI models; requires OAuth2 | MEDIUM-HIGH |
| **Telegram** | MTProto API / Bot API (official) | Generally permissive for public channels; ToS prohibits bulk scraping for datasets/AI | No bulk scraping for datasets or AI training; must support sponsored messages | LOW-MEDIUM |
| **Bluesky** | AT Protocol (public, open) | Designed for open access; minimal restrictions | Standard acceptable use; respect user deletion requests | LOW |
| **YouTube** | YouTube Data API v3 (official) | Compliant with quota limits | 10,000 units/day default quota; no storing data beyond 30 days without refresh; must comply with display requirements | LOW |
| **TikTok** | Apify scraper (third-party) | ToS explicitly prohibits scraping | All automated extraction violates TikTok ToS | HIGH |
| **VK** | VK API v5 (official) | API access is permissible; Russian data law applies | Russian Federal Law 152-FZ requires personal data of Russian citizens stored on Russian servers | HIGH |
| **Facebook/Meta** | Meta Content Library API | Restricted to qualified researchers at non-profit institutions | Requires academic/non-profit affiliation; not available for commercial or general-purpose use | MEDIUM (access barrier) |
| **FAA NOTAM** | FAA SWIM / NOTAM API (government) | Public government data; unrestricted | Standard government data terms; attribution appreciated | NEGLIGIBLE |
| **NGA Maritime** | NGA MSI REST API (government) | Public government data; unrestricted | Standard government data terms | NEGLIGIBLE |
| **OpenSanctions** | OpenSanctions API | Free for non-commercial use (CC BY-NC) | Commercial use requires paid license; free for journalists and activists | LOW (non-commercial) |
| **ACLED** | ACLED API | Restrictive; commercial and government use require licenses | Prohibits AI/ML training that creates substitute for ACLED; commercial license required | MEDIUM-HIGH |
| **GDELT** | GDELT API / BigQuery | Fully open; no restrictions | Unlimited use for any purpose without fee | NEGLIGIBLE |
| **OpenSky Network** | OpenSky REST API / Impala DB | Free for non-commercial/academic use | Commercial use requires written permission; attribution required | LOW (non-commercial) |
| **AISHub** | AISHub API (community data sharing) | Requires contributing an AIS feed to receive data | Must contribute data to access aggregated feed | LOW |
| **AISStream** | AISStream WebSocket API | Free API for real-time AIS data | Terms not extensively documented; standard acceptable use | LOW |
| **ADS-B Exchange** | ADS-B Exchange API | Commercial license required for commercial use | No bulk resale/redistribution without consent; commercial terms apply | MEDIUM |
| **Polymarket** | Gamma API (public, read-only) | Public read access; no authentication required for market data | Trading restricted for US persons (data viewing is global); generous rate limits | LOW |
| **Kalshi** | Kalshi REST API | CFTC-regulated; public market data accessible | RSA key-pair authentication required; rate limits apply | LOW |
| **Metaculus** | Metaculus REST API | API access permitted under terms | Prohibits AI/ML training without prior written permission; no automated scraping outside API | MEDIUM |
| **Anthropic/Claude** | Anthropic API | Compliant under standard API terms | API data retained 30 days (7 days after Sept 2025); not used for training without opt-in; zero-data-retention available | LOW |
| **OpenRouter** | OpenRouter API | Compliant under standard API terms | Prompts not logged by default; does not control downstream LLM data handling | LOW |

---

## Detailed Analysis Per Source

### Social Media

---

#### 1. Twitter/X

**Risk Level: HIGH**

**How We Access Data:**
Omni Sentinel uses [TwitterAPI.io](https://twitterapi.io/), a third-party service that provides access to Twitter/X data through its own REST API. This avoids the cost of X's official API tiers ($200/month for Basic with only 15,000 reads; $5,000/month for Pro with full archive access). TwitterAPI.io charges approximately $0.15 per 1,000 tweets.

**What the ToS Says:**
X's Terms of Service, [updated in 2023 and revised through 2025](https://cdn.cms-twdigitalassets.com/content/dam/legal-twitter/site-assets/terms-of-service-2025-05-08/en/x-terms-of-service-2025-05-08.pdf), explicitly prohibit:
- Scraping, crawling, or otherwise extracting data without authorization
- Accessing the platform through automated means outside the official API
- Using X data to train AI/ML models (policy pivot in 2025)

X has [aggressively enforced these terms](https://techcrunch.com/2023/09/08/x-updates-its-terms-to-ban-crawling-and-scraping/) since 2023, implementing browser fingerprinting, datacenter IP bans, and filing lawsuits against scrapers.

**Key Legal Precedent -- X Corp v. Bright Data (2024-2025):**
In May 2024, a [federal judge in the Northern District of California dismissed X's claims](https://www.skadden.com/insights/publications/2024/05/district-court-adopts-broad-view) against Bright Data, ruling that:
- X's breach-of-contract and state law claims were preempted by the Copyright Act
- Scraping publicly available data does not violate the CFAA (consistent with [hiQ v. LinkedIn](https://calawyers.org/privacy-law/ninth-circuit-holds-data-scraping-is-legal-in-hiq-v-linkedin/))
- X cannot claim de facto copyright ownership over user-generated content

However, in November 2024, a judge allowed X to amend some claims, and by mid-2025 the parties [reached a settlement in principle](https://news.bloomberglaw.com/ip-law/musks-x-settles-data-scraping-dispute-against-israeli-data-firm). The settlement terms are undisclosed, so the precedent is somewhat uncertain.

**What's Allowed / Prohibited:**
- Accessing public tweets via third-party services: Legally gray. Court rulings favor scrapers of public data, but X's ToS prohibits it, creating civil contract risk.
- Using the official API at paid tiers: Fully compliant.
- Feeding tweet content into Claude for AI analysis: May violate X's prohibition on using data for AI purposes.

**Risk Assessment:**
- Legal risk of CFAA violation: LOW (per hiQ, Van Buren, and Bright Data rulings)
- Civil contract risk via ToS violation: MEDIUM (X could pursue civil breach-of-contract claims)
- Third-party service risk: MEDIUM (TwitterAPI.io could be shut down by X enforcement)
- AI ingestion risk: MEDIUM-HIGH (X's 2025 policy explicitly prohibits AI use of platform data)

**Mitigation:**
- Twitter/X is deferred from MVP scope (per synthesis review decision)
- When implemented, prefer X's official Pay-Per-Use API (launched February 2026) for compliance
- Do not store tweet data beyond cache TTL
- Display tweets in compliance with X's display requirements
- Add explicit disclaimer that Twitter data analysis is performed on ephemeral, cached data
- Monitor the Bright Data settlement outcome for precedent changes

---

#### 2. Reddit

**Risk Level: MEDIUM-HIGH**

**How We Access Data:**
Official Reddit OAuth2 API using client credentials flow. Monitors subreddits: r/OSINT, r/geopolitics, r/CombatFootage, r/worldnews. Rate limit: 100 requests/minute (authenticated).

**What the ToS Says:**
Reddit's [Data API Terms](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki) and [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy) state:
- OAuth2 is required for all programmatic access
- The unauthenticated `.json` endpoint is undocumented and Reddit has sent cease-and-desist letters to projects using it at scale
- Section 2.4 of the Data API Terms prohibits using Reddit data to "create, train, or improve (directly or indirectly) any artificial intelligence or machine learning models"
- [Reddit locks down public data](https://techcrunch.com/2024/05/09/reddit-locks-down-its-public-data-in-new-content-policy-says-use-now-requires-a-contract/) -- commercial use now requires a contract
- Reddit has [sued Anthropic and Perplexity](https://replydaddy.com/blog/reddit-api-pre-approval-2025-personal-projects-crackdown) over unauthorized AI use of Reddit data

**What's Allowed / Prohibited:**
- Reading posts via OAuth2 for display: ALLOWED (non-commercial, within rate limits)
- Feeding Reddit posts into Claude for AI summarization/analysis: LIKELY PROHIBITED under Section 2.4
- Bulk data collection for storage: PROHIBITED without contract
- Commercial use of Reddit data: REQUIRES paid license agreement

**Risk Assessment:**
The primary risk is the AI ingestion clause. Omni Sentinel reads Reddit posts and feeds them into Claude for AI-powered analysis (threat classification, sentiment analysis, summarization). This workflow arguably "uses Reddit Data to improve an artificial intelligence model" even if it is inference, not training. Reddit's enforcement actions against Anthropic and Perplexity demonstrate they interpret this clause broadly.

**Mitigation:**
- Use OAuth2 (never the unauthenticated endpoint)
- Minimize data retention: cache posts for display only, with short TTLs (5 minutes)
- Do not store Reddit content in any persistent database
- The AI analysis operates on ephemeral cached data and does not train any model
- Frame AI usage as "analysis of user-facing content for summarization" rather than "AI training"
- Monitor Reddit's enforcement actions and adjust if their interpretation extends to inference-time use
- If Omni Sentinel is ever commercialized, obtain a Reddit data license

---

#### 3. Telegram

**Risk Level: LOW-MEDIUM**

**How We Access Data:**
Telegram's official MTProto API via Telethon (Python) on the backend, polling public channels. Monitors 26+ curated public channels across tiers (breaking news, OSINT, conflict reporting). The existing integration is described in the upstream World Monitor codebase.

**What the ToS Says:**
[Telegram's API Terms of Service](https://core.telegram.org/api/terms) and [Bot Developer Terms](https://telegram.org/tos/bot-developers) state:
- Applications using the Telegram API must not be used for data collection aimed at creating large datasets, machine learning models, or AI products
- Applications must support official sponsored messages in Telegram channels
- The general [Telegram ToS](https://telegram.org/tos) prohibit using the service for illegal purposes

However, Telegram's design philosophy is fundamentally open:
- Public channels are readable by anyone without an account
- The MTProto API provides free, programmatic access to all public channel content
- Rate limits are generous (~30 requests/second)
- Full message history is accessible for any public channel

**What's Allowed / Prohibited:**
- Reading public channel messages via the API: ALLOWED (core platform functionality)
- Monitoring channels for new messages in real-time: ALLOWED
- Downloading media from public channels: ALLOWED
- Creating bulk datasets from channel content: PROHIBITED
- Using channel data for AI/ML training: PROHIBITED
- Scraping private channels/groups without consent: PROHIBITED

**Risk Assessment:**
Telegram's enforcement of data scraping rules on public channels is minimal in practice. The platform's architecture is designed for open access to public content. The main risks are:
- Telegram blocking OSINT-focused channels (occurred June 2025 and February 2026)
- Regional availability issues (Russia throttling in 2026)
- The AI clause technically applies to feeding messages into Claude, but Telegram has not enforced this against OSINT tools processing public channel data

**Mitigation:**
- Access only public channels (never private groups without explicit authorization)
- Do not build or export bulk datasets from Telegram content
- Frame Claude integration as "real-time analysis" not "AI training"
- Maintain channel list in configuration for easy updates if channels are blocked
- Implement graceful degradation if Telegram access is disrupted in specific regions

---

#### 4. Bluesky

**Risk Level: LOW**

**How We Access Data:**
AT Protocol public API. No authentication required for reading public posts. The protocol is intentionally designed for open, decentralized data access.

**What the ToS Says:**
[Bluesky's Terms of Service](https://bsky.social/about/support/tos) and the AT Protocol design principles:
- Users retain ownership of their content
- Bluesky uses content to operate and enhance the platform and AT Protocol
- The [decentralized nature of AT Protocol](https://docs.bsky.app/blog/2025-protocol-roadmap-spring) means Bluesky cannot force other services to treat content in a particular way
- [Updated terms (August 2025)](https://bsky.social/about/blog/08-14-2025-updated-terms-and-policies) added GDPR transparency and clarified deletion limitations due to decentralized architecture
- OAuth is being updated for granular permissions (read posts vs. DMs vs. other data)

**What's Allowed / Prohibited:**
- Reading public posts via AT Protocol: ALLOWED (the protocol is designed for this)
- Keyword search across public posts: ALLOWED
- Building applications that display Bluesky content: ALLOWED
- Respecting user deletion requests: REQUIRED (but acknowledged as imperfect in decentralized systems)

**Risk Assessment:**
Bluesky and the AT Protocol present the lowest legal risk of any social media source. The protocol was designed from the ground up for open, interoperable access. There are no known enforcement actions against third-party applications reading public data.

**Mitigation:**
- Respect the API limit of 25 results per request (not 100 as originally planned)
- Honor user deletion requests when content is removed
- Standard caching with short TTLs (2 minutes)

---

#### 5. YouTube

**Risk Level: LOW (if using official API)**

**How We Access Data:**
YouTube Data API v3, accessed through a Google Cloud project API key. Used for monitoring video metadata, titles, and descriptions from news channels -- not downloading or hosting video content.

**What the ToS Says:**
[YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service) and [Developer Policies](https://developers.google.com/youtube/terms/developer-policies):
- Must comply with YouTube's branding and display requirements
- Default quota of 10,000 units per day per project
- Cannot store API data for more than 30 days without refreshing from the API
- Must have a privacy policy for any application using the YouTube API
- Cannot modify YouTube's features or branding
- Must use the latest API version
- Google can modify services, monitor usage, and enforce compliance at any time

**What's Allowed / Prohibited:**
- Searching and displaying video metadata (titles, descriptions, thumbnails): ALLOWED
- Embedding YouTube players: ALLOWED (required method for video display)
- Downloading or hosting video content outside YouTube: PROHIBITED
- Scraping YouTube outside the official API: PROHIBITED
- Exceeding quota without requesting extension: PROHIBITED

**Risk Assessment:**
YouTube Data API is well-documented and Google provides clear compliance guidelines. Risk is low as long as the application stays within quota limits and follows display requirements.

**Mitigation:**
- Monitor quota usage; request extension if needed
- Refresh cached data within 30-day window
- Display videos using YouTube's official embed player only
- Maintain a privacy policy that covers YouTube API data usage

---

#### 6. TikTok

**Risk Level: HIGH**

**How We Access Data:**
Apify scraper actors (third-party scraping platform). No official TikTok API access for general-purpose data collection.

**What the ToS Says:**
[TikTok's Terms of Service](https://www.tiktok.com/legal/page/us/terms-of-service/en) explicitly prohibit:
- "Scraping, crawling, exporting or otherwise extracting any data or content in any form, for any purpose, from the Platform using any automated system or software"
- TikTok actively [combats unauthorized data scraping](https://www.tiktok.com/privacy/blog/how-we-combat-scraping/en) with technical measures

TikTok's [Research Tools Terms](https://www.tiktok.com/legal/page/global/terms-of-service-research-api/en) provide a separate Research API, but it requires institutional affiliation and approval.

**What's Allowed / Prohibited:**
- Automated scraping via Apify or any third-party tool: PROHIBITED by ToS
- Using the Research API with institutional approval: ALLOWED (but requires application)
- Manual browsing and note-taking: ALLOWED

**Risk Assessment:**
Using Apify scrapers to extract TikTok data violates TikTok's Terms of Service. While [Apify argues](https://blog.apify.com/how-to-scrape-tiktok-tutorial/) that scraping publicly available data is legal (citing hiQ v. LinkedIn), TikTok's ToS creates civil liability. Additionally, TikTok's ongoing regulatory challenges in the US add uncertainty.

**Mitigation:**
- TikTok is deferred from MVP scope (per synthesis review decision)
- When implemented, explore TikTok's Research API for legitimate access
- If using Apify, understand the ToS violation risk
- Do not store TikTok content beyond ephemeral cache
- Consider TikTok integration as optional/community-contributed

---

#### 7. VK (VKontakte)

**Risk Level: HIGH**

**How We Access Data:**
VK API v5 with service token authentication. Monitors military-related public groups.

**What the ToS Says:**
VK API access is generally permissible for reading public content. However, the critical issue is not VK's own ToS but Russian data protection law:

[Russian Federal Law No. 152-FZ](https://secureprivacy.ai/blog/comprehensive-guide-russian-data-protection-law-152-fz) ("On Personal Data"):
- Personal data of Russian citizens must be stored and processed on servers physically located within Russia (data localization requirement)
- [As of September 2025](https://konsugroup.com/en/news/new-requirements-personal-data-protection-russia-2025-07/), consent for data processing must be obtained separately from any other documents
- [As of May 2025](https://securiti.ai/russian-federal-law-no-152-fz/), fines for violations increased to up to 18 million RUB (~$200,000 USD)
- Cross-border transfer of personal data requires compliance with adequacy determinations or specific safeguards

**What's Allowed / Prohibited:**
- Reading public VK posts via the API: ALLOWED by VK's terms
- Processing personal data of Russian citizens outside Russia: PROHIBITED by 152-FZ
- Storing VK user data on non-Russian servers: PROHIBITED by 152-FZ

**Risk Assessment:**
Processing VK data on Vercel/Railway infrastructure (US-based) likely violates Russian data localization requirements. While enforcement against foreign OSINT tools is unlikely, any presence or operations in Russia would create legal exposure. The practical risk depends on whether the tool processes personally identifiable information (names, profile URLs) or only aggregated content.

**Mitigation:**
- VK is deferred from MVP scope (per synthesis review decision)
- When implemented, strip personally identifiable information before processing
- Process only aggregated content and sentiment, not individual user data
- Document the 152-FZ compliance gap and accept the risk for a non-commercial OSINT tool
- Do not operate servers or maintain a legal entity in Russia

---

#### 8. Facebook/Meta

**Risk Level: MEDIUM (access barrier)**

**How We Access Data:**
Meta Content Library API (for research purposes).

**What the ToS Says:**
[Meta Research Tools Terms and Conditions](https://transparency.meta.com/researchtools/product-terms-meta-research/) (updated December 2025):
- Access is restricted to researchers affiliated with academic institutions or non-profit organizations that hold scientific or public interest research as a primary purpose
- Researchers and their institutions must not be in sanctioned jurisdictions
- Researchers may publish findings without Meta's prior approval
- Free access to the Content Library UI and API, but [SOMAR Virtual Data Enclave costs $371/month per team](https://transparency.meta.com/researchtools/meta-content-library/) starting January 2026
- Cannot disclose Confidential Information or Personal Data beyond approved research purposes

**What's Allowed / Prohibited:**
- General-purpose OSINT tool accessing Meta Content Library: LIKELY NOT ALLOWED (requires academic/non-profit affiliation)
- Using CrowdTangle (legacy tool): DEPRECATED
- Accessing public Facebook pages via Graph API: LIMITED (most public page data requires app review)

**Risk Assessment:**
The Meta Content Library is not accessible to general-purpose open-source projects. Omni Sentinel would need an institutional research partner to access this data legitimately. The practical impact is low because Facebook/Meta is not a primary data source in the current design.

**Mitigation:**
- Facebook/Meta is not in the current implementation plan
- If needed in the future, partner with an academic institution for Content Library access
- Consider the Facebook Ads Library (public, no restrictions) as an alternative for limited political advertising data

---

### Government & Public Data

---

#### 9. FAA NOTAM

**Risk Level: NEGLIGIBLE**

**How We Access Data:**
[FAA NOTAM API](https://api.faa.gov/s/) via the System-Wide Information Management (SWIM) feed, and/or the [NASA Digital Information Platform](https://ntrs.nasa.gov/citations/20250003355) redistribution.

**What the ToS Says:**
FAA data is US government public information. Federal policy directs agencies to increase public access to government data. No licensing restrictions apply to the use of NOTAM data for any purpose, including commercial applications.

**What's Allowed / Prohibited:**
- Reading, caching, displaying, and analyzing NOTAM data: UNRESTRICTED
- Building applications on top of FAA data: UNRESTRICTED
- Redistribution of FAA data: UNRESTRICTED

**Risk Assessment:** None. Government data is in the public domain.

**Mitigation:** None required. Standard attribution is courteous but not legally required.

---

#### 10. NGA Maritime Safety Information

**Risk Level: NEGLIGIBLE**

**How We Access Data:**
[NGA Maritime Safety Information REST API](https://msi.nga.mil/home) for NAVTEX warnings, navigational warnings, and maritime safety products.

**What the ToS Says:**
NGA data is US government public information, classified as UNCLASSIFIED. The MSI portal provides open access to maritime safety products and services.

**What's Allowed / Prohibited:**
- All uses of unclassified NGA maritime data: UNRESTRICTED

**Risk Assessment:** None. Government data is in the public domain.

**Mitigation:** None required.

---

#### 11. OpenSanctions

**Risk Level: LOW (non-commercial)**

**How We Access Data:**
[OpenSanctions API](https://www.opensanctions.org/) for sanctions entity lookups and screening.

**What the ToS Says:**
[OpenSanctions licensing](https://www.opensanctions.org/licensing/):
- Data is released under Creative Commons Attribution-NonCommercial (CC BY-NC)
- Free for non-commercial use: academic research, journalism, activism, hobbyist analysis
- [Commercial use requires a paid license](https://www.opensanctions.org/docs/commercial/faq/), with tiers for internal use, financial services, and reseller/OEM
- [Exemptions](https://www.opensanctions.org/faq/32/exemptions/) granted to journalists, advocacy groups, and public institutions of countries invaded by Russia
- API pricing: EUR 0.10 per successful call (commercial); free for non-commercial

**What's Allowed / Prohibited:**
- Non-commercial OSINT analysis: ALLOWED (free)
- Displaying sanctions data in an open-source tool: ALLOWED under CC BY-NC
- Commercial use (if Omni Sentinel is monetized): REQUIRES paid license
- Attribution: REQUIRED

**Risk Assessment:** Low for the current non-commercial project. Risk increases if the project is ever monetized.

**Mitigation:**
- Maintain non-commercial status or budget for a commercial license
- Include attribution as required by CC BY-NC
- OpenSanctions is deferred from MVP scope

---

#### 12. ACLED (Armed Conflict Location & Event Data)

**Risk Level: MEDIUM-HIGH**

**How We Access Data:**
ACLED is integrated in the upstream World Monitor codebase. Accessed via the ACLED API.

**What the ToS Says:**
[ACLED End User License Agreement](https://acleddata.com/eula) and [Content Usage Terms](https://acleddata.com/contentusage):
- Government and multilateral organizations require a public-sector license
- Commercial entities require a [corporate license](https://acleddata.com/taxonomy/term/114)
- Users are prohibited from using ACLED data to "train, test, develop, or improve any machine learning (ML) models, large language models (LLMs), artificial intelligence (AI) systems" that create a substitute for ACLED or violate the terms
- Users cannot create datasets that compete with or substitute for ACLED products
- Published materials incorporating ACLED data must be "transformative in nature" and must not allow reverse engineering of the underlying dataset
- Attribution is mandatory

**What's Allowed / Prohibited:**
- Displaying ACLED data with attribution in a non-commercial dashboard: LIKELY ALLOWED (transformative use)
- Feeding ACLED data into Claude for AI analysis: POTENTIALLY PROBLEMATIC under the AI/ML clause (depends on interpretation -- inference is arguably not "training")
- Redistributing raw ACLED data: PROHIBITED
- Commercial use without license: PROHIBITED

**Risk Assessment:**
The AI/ML restriction is broadly worded. ACLED's enforcement posture on inference-time AI use is unclear. The upstream World Monitor already integrates ACLED, so this risk is inherited rather than introduced by Omni Sentinel.

**Mitigation:**
- ACLED integration is inherited from upstream; no new ACLED integration planned
- Ensure ACLED data is displayed with proper attribution
- AI analysis should produce transformative output (structured analysis reports), not reproduce raw ACLED data
- If commercializing, obtain appropriate ACLED license

---

#### 13. GDELT

**Risk Level: NEGLIGIBLE**

**How We Access Data:**
GDELT API and/or Google BigQuery public dataset.

**What the ToS Says:**
[The GDELT Project](https://www.gdeltproject.org/data.html) makes all datasets available for "unlimited and unrestricted use for any academic, commercial, or governmental use of any kind without fee." Users may "redistribute, rehost, republish, and mirror any of the GDELT datasets in any form."

**What's Allowed / Prohibited:**
- All uses: UNRESTRICTED (academic, commercial, governmental)
- Redistribution: ALLOWED
- AI training: ALLOWED

**Risk Assessment:** None. GDELT is one of the most permissively licensed large-scale datasets available.

**Mitigation:** None required.

---

### Tracking Data

---

#### 14. OpenSky Network

**Risk Level: LOW (non-commercial)**

**How We Access Data:**
[OpenSky Network REST API](https://openskynetwork.github.io/opensky-api/) and Impala database for historical flight data. OAuth2 authentication required for new accounts (post-March 2025).

**What the ToS Says:**
[OpenSky Network General Terms of Use & Data License Agreement](https://opensky-network.org/about/terms-of-use):
- Grants a "limited, non-exclusive, non-transferable, non-assignable, and terminable license to copy, modify, and use the data solely for the purpose of non-profit research, non-profit education, or for government purposes"
- Any use by a for-profit entity requires written permission
- Free access to the full dataset only for research institutions, aviation authorities, governmental organizations, and non-profit organizations
- Attribution is required (cite OpenSky as data source)

**What's Allowed / Prohibited:**
- Non-commercial OSINT research: ALLOWED (free)
- Academic/government use: ALLOWED (free with registration)
- Commercial use: REQUIRES written permission and likely a paid license
- Attribution: REQUIRED

**Risk Assessment:** Low for non-commercial use. The project's open-source, non-commercial nature aligns with OpenSky's license terms.

**Mitigation:**
- Register for an OpenSky account for authenticated API access (higher rate limits)
- Include OpenSky attribution in the application
- If commercializing, obtain written permission from OpenSky Network

---

#### 15. AISHub

**Risk Level: LOW**

**How We Access Data:**
[AISHub API](https://www.aishub.net/api) providing real-time AIS vessel data in XML/JSON/CSV format.

**What the ToS Says:**
AISHub operates as a community data-sharing cooperative:
- Members contribute at least one raw AIS feed from their own receiver
- In exchange, members receive access to the aggregated AIS feed from all stations
- API access is available to contributing members

**What's Allowed / Prohibited:**
- Contributing an AIS feed and using aggregated data: ALLOWED
- Using data without contributing: NOT SUPPORTED (the model requires contribution)
- Redistributing bulk AIS data: Terms unclear; likely requires permission

**Risk Assessment:** Low. The cooperative model is straightforward. The main barrier is the requirement to contribute an AIS feed (which requires AIS receiver hardware).

**Mitigation:**
- AISHub integration is deferred to post-MVP (requires hardware investment)
- When implemented, ensure an AIS feed is contributed as required

---

#### 16. AISStream

**Risk Level: LOW**

**How We Access Data:**
[AISStream.io](https://aisstream.io/) free WebSocket API for real-time global AIS data.

**What the ToS Says:**
AISStream provides a free API for streaming global AIS data. Terms of service are not extensively documented publicly but follow standard acceptable use patterns.

**What's Allowed / Prohibited:**
- Streaming real-time AIS data for display and analysis: ALLOWED
- Standard rate limits and acceptable use apply

**Risk Assessment:** Low. The service is designed for open access to AIS data.

**Mitigation:**
- Standard caching and rate limit compliance
- Monitor for ToS changes

---

#### 17. ADS-B Exchange

**Risk Level: MEDIUM**

**How We Access Data:**
[ADS-B Exchange API](https://www.adsbexchange.com/data/) for unfiltered ADS-B aircraft tracking data. ADS-B Exchange differentiates itself from FlightRadar24 and FlightAware by not filtering out military or government aircraft.

**What the ToS Says:**
[ADS-B Exchange Terms of Use](https://www.adsbexchange.com/terms-of-use/) (updated January 14, 2025):
- Commercial data usage requires a commercial license agreement
- No bulk resale or redistribution without consent
- Customer data is customer's confidential information
- ADS-B Exchange retains rights to use aggregated, anonymous usage data

**What's Allowed / Prohibited:**
- Personal/non-commercial use via API: ALLOWED (via RapidAPI personal tier)
- Commercial use: REQUIRES commercial license
- Redistribution of bulk data: PROHIBITED without consent

**Risk Assessment:** Medium. ADS-B Exchange has shifted toward a more commercial model. Non-commercial OSINT use is likely acceptable, but the terms are more restrictive than community-based alternatives.

**Mitigation:**
- Use the personal/hobbyist API tier for non-commercial use
- Do not redistribute bulk ADS-B Exchange data
- If commercializing, obtain a commercial license
- Consider contributing an ADS-B feeder to support the community network

---

### Financial / Market Data

---

#### 18. Polymarket

**Risk Level: LOW**

**How We Access Data:**
[Polymarket Gamma API](https://docs.polymarket.com) -- a read-only REST API for market metadata. No authentication required for reading market data.

**What the ToS Says:**
[Polymarket Terms of Use](https://polymarket.com/tos):
- Data and information is viewable globally
- Trading is restricted for US persons (but read-only data access is not restricted)
- [Polymarket US](https://www.quantvps.com/blog/polymarket-us-api-available) launched in 2025-2026 under CFTC regulation, making US API access legal
- Basic API access is free with up to 1,000 calls/hour for non-trading queries

**What's Allowed / Prohibited:**
- Reading market data (prices, volumes, market descriptions): ALLOWED globally
- Displaying market data in a dashboard: ALLOWED
- Automated trading from restricted jurisdictions: PROHIBITED
- Premium/WebSocket access: Paid tiers start at $99/month

**Risk Assessment:** Low for read-only data display. Omni Sentinel only reads and displays market data; it does not facilitate trading.

**Mitigation:** Standard rate limit compliance. No special measures needed.

---

#### 19. Kalshi

**Risk Level: LOW**

**How We Access Data:**
[Kalshi REST and WebSocket API](https://docs.kalshi.com/welcome). RSA key-pair authentication. CFTC-regulated prediction market.

**What the ToS Says:**
Kalshi is the first federally regulated prediction market in the US:
- API access requires a Kalshi account and RSA key-pair
- Market data is accessible programmatically
- Tokens expire every 30 minutes (requiring refresh logic)
- Rate limits apply; exponential backoff recommended

**What's Allowed / Prohibited:**
- Reading market data: ALLOWED (with authentication)
- Displaying prices and probabilities: ALLOWED
- Algorithmic trading: ALLOWED (Kalshi actively encourages API trading)

**Risk Assessment:** Low. Kalshi is a regulated US exchange that actively supports developer access.

**Mitigation:** Standard API key security and rate limit compliance.

---

#### 20. Metaculus

**Risk Level: MEDIUM**

**How We Access Data:**
[Metaculus REST API](https://www.metaculus.com/api/) for community forecast data.

**What the ToS Says:**
[Metaculus Terms of Use](https://www.metaculus.com/terms-of-use/):
- Users shall not "view, copy, or procure content or information from the Service by automated means (such as scripts, bots, spiders, crawlers, or scrapers)" except through the provided API
- Users shall not use content "to train or otherwise create or develop any artificial intelligence or machine learning model or algorithm" without Metaculus's prior written permission
- Standard API access for reading forecast data is permitted

**What's Allowed / Prohibited:**
- Reading forecast data via the API: ALLOWED
- Displaying forecasts in a dashboard: ALLOWED (with attribution)
- Training AI/ML models on Metaculus data: PROHIBITED without written permission
- Scraping outside the API: PROHIBITED

**Risk Assessment:** Medium. The AI/ML clause could apply to feeding Metaculus data into Claude for analysis, though Omni Sentinel uses it for display and comparison, not model training. The distinction between "inference-time analysis" and "training" is the key question.

**Mitigation:**
- Use the official API only
- Display Metaculus data with attribution
- Frame AI integration as "comparison and display" rather than model training
- Do not store Metaculus data beyond cache TTL

---

### AI Providers

---

#### 21. Anthropic / Claude

**Risk Level: LOW**

**How We Access Data:**
[Anthropic API](https://www.anthropic.com/) for Claude model access. Claude is the primary AI provider for summarization, analysis, and prediction.

**What the ToS Says:**
[Anthropic's data retention and privacy policies](https://privacy.claude.com/en/articles/10023548-how-long-do-you-store-my-data):
- **API data retention:** 30 days until September 14, 2025; 7 days thereafter. API data is automatically deleted after the retention period.
- **Model training:** API data is NOT used for model training. Anthropic does not train on API inputs/outputs without explicit opt-in consent.
- **Zero-data-retention (ZDR):** Available as an [optional addendum](https://privacy.claude.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to) for organizations with stringent compliance requirements.
- **User queries:** Anthropic logs API requests for abuse prevention and safety purposes during the retention window.
- **Trust & Safety:** Anthropic may review flagged conversations for safety evaluation.

**Privacy Implications for Omni Sentinel Users:**
- User analysis queries (e.g., "Analyze Middle East conflict trajectory") are sent to Anthropic's API and retained for up to 7 days
- This means Anthropic temporarily has visibility into what topics users are analyzing
- For sensitive OSINT work, users should be aware that their queries transit through and are temporarily stored by a US-based AI company

**Mitigation:**
- Document data flow in user-facing privacy notice
- Consider ZDR addendum for sensitive deployments
- Default model: Claude Sonnet 4 (cost-optimized for the use case)
- API key stored server-side only (`process.env.CLAUDE_API_KEY`), never exposed to client

---

#### 22. OpenRouter

**Risk Level: LOW**

**How We Access Data:**
[OpenRouter API](https://openrouter.ai/) as a fallback AI provider when Claude is unavailable.

**What the ToS Says:**
[OpenRouter Privacy Policy](https://openrouter.ai/privacy) and [Terms of Service](https://openrouter.ai/terms):
- [Prompts and completions are not logged by default](https://openrouter.ai/docs/guides/privacy/logging); only basic metadata is stored (timestamps, model, token counts)
- Users can opt in to prompt logging in account settings
- [Zero-data-retention (ZDR)](https://openrouter.ai/docs/guides/features/zdr) available on a per-request basis via the `zdr` parameter
- [EU in-region routing](https://openrouter.ai/docs/guides/privacy/data-collection) available via `https://eu.openrouter.ai` for GDPR compliance
- OpenRouter does NOT control downstream LLM providers' data handling

**Important caveat:** OpenRouter routes requests to various LLM providers. Each downstream provider has its own data retention and training policies. OpenRouter [explicitly states](https://openrouter.ai/docs/guides/privacy/logging) it is not responsible for LLMs' handling of inputs/outputs.

**Mitigation:**
- Enable ZDR on sensitive requests
- Use EU routing endpoint for EU users (GDPR compliance)
- Review data retention policies of specific downstream providers used via OpenRouter
- Prefer Anthropic direct API over OpenRouter for sensitive queries

---

## AGPL-3.0 License Implications

Omni Sentinel is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](https://www.gnu.org/licenses/agpl-3.0.html). This has significant implications for users who modify and deploy the software.

### What AGPL-3.0 Requires

The AGPL-3.0 is the most restrictive widely-used open-source license. Its key provision (Section 13) extends the GPL's copyleft requirement to **network use**:

> If you modify the Program and your modified version interacts with users through a computer network, you must prominently offer all users interacting with it through that network an opportunity to receive the Corresponding Source of your version.

This means:
- Anyone who modifies Omni Sentinel and deploys it as a web service **must make their modified source code publicly available**
- This applies even if the software is never "distributed" in the traditional sense -- merely running it as a network service triggers the requirement
- The source code disclosure obligation applies to the entire modified program, not just the modifications

### Impact on Enterprise and Government Users

AGPL-3.0 is [widely avoided by enterprise organizations](https://opensource.google/documentation/reference/using/agpl-policy). Notable policies:
- **Google:** [AGPL code "MUST NOT be used at Google"](https://opensource.google/documentation/reference/using/agpl-policy) due to network-use source disclosure requirements
- **Many enterprises:** Have blanket policies against AGPL dependencies due to the [viral copyleft effect](https://fossa.com/blog/open-source-software-licenses-101-agpl-license/) -- any product that incorporates AGPL code may itself become subject to AGPL's source disclosure requirements
- **Government agencies:** May face challenges because classified modifications or agency-specific integrations would need to be disclosed

### Consideration for Relicensing

If Omni Sentinel aims to attract enterprise or government contributors/users, consider:
- **Dual licensing:** Offer AGPL for open-source use and a commercial license for proprietary deployments
- **Relicensing to Apache 2.0 or MIT:** More permissive licenses that allow proprietary modifications (but lose the copyleft protection)
- **Contributor License Agreement (CLA):** If relicensing is a future possibility, establish a CLA early so that all contributors grant relicensing rights

The current AGPL-3.0 license is appropriate for an open-source OSINT tool where transparency is valued, but it limits the potential user base in enterprise and government sectors.

---

## GDPR Considerations

### User Queries Sent to Third-Party APIs

When a user interacts with Omni Sentinel, the following data is transmitted to third-party services:

| Data Transmitted | Recipient | Retention | Purpose |
|-----------------|-----------|-----------|---------|
| Analysis queries (free text) | Anthropic (Claude API) | 7 days (post-Sept 2025) | AI analysis and summarization |
| Analysis queries (fallback) | OpenRouter -> downstream LLM | Varies by provider | AI analysis fallback |
| Search terms | Reddit, Bluesky, Twitter APIs | Varies | Content search |
| IP address | All API providers | Varies | Request routing and rate limiting |

### GDPR Implications for EU Users

Under the [General Data Protection Regulation (GDPR)](https://gdpr.eu/), the following considerations apply:

1. **Data Controller vs. Processor:** Omni Sentinel acts as a data controller for user queries. Anthropic, OpenRouter, and social media APIs act as data processors.

2. **Legal Basis for Processing:** User consent (explicit opt-in to use the tool) or legitimate interest (providing the requested analysis service).

3. **International Data Transfers:** User queries are transmitted to US-based services (Anthropic, Vercel, Railway). This requires:
   - Standard Contractual Clauses (SCCs) with each provider
   - Transparency about international transfers in the privacy notice
   - OpenRouter offers [EU in-region routing](https://openrouter.ai/docs/guides/privacy/data-collection) as a mitigation

4. **Right to Erasure:** Users should be able to request deletion of their queries. Since API providers auto-delete after their retention period, this is largely self-resolving, but a formal process should exist.

5. **Data Minimization:** Only transmit the minimum data necessary for each API call. Do not include user identifiers in API requests where not required.

### Recommendations

- Add a privacy notice accessible from the application UI explaining what data is sent to third parties
- Implement a consent flow for EU users before their first API-bound query
- Use OpenRouter's EU endpoint (`eu.openrouter.ai`) for EU users when Claude direct API is unavailable
- Consider Anthropic's ZDR addendum for EU-focused deployments
- Do not log user queries on the Omni Sentinel server beyond operational necessity

---

## Ethical Statement

### Dual-Use Risk Acknowledgment

Omni Sentinel is an open-source intelligence analysis tool that aggregates publicly available data and applies AI-powered analysis frameworks, including the JP 3-60 (Joint Targeting) military analysis doctrine. By its nature, this tool has **dual-use potential**:

- **Intended use:** Empowering journalists, researchers, analysts, and informed citizens to understand geopolitical events through structured analysis of open-source data.
- **Potential misuse:** The same capabilities could theoretically be used to track individuals, monitor protest movements, enable targeting decisions by non-state actors, or support surveillance activities.

The project team acknowledges this tension and takes the following position:

1. **Omni Sentinel accesses only publicly available data.** It does not hack, intercept, or access private communications. Every data source in this document is either a public API, an open dataset, or a government publication.

2. **AI analysis is not intelligence.** The JP 3-60 analysis pipeline and conflict probability scores are generated by a large language model (Claude) based on publicly available information. They are structured analytical frameworks, not intelligence assessments. They carry no more authority than any other LLM output.

3. **Probability scores are estimates, not predictions.** The 6-dimension weighted scoring system produces numerical outputs that may appear precise but are fundamentally LLM-generated estimates based on incomplete public information. They should never be the sole basis for any decision with real-world consequences.

### AI Analysis Disclaimer

The following disclaimer must be displayed prominently on the AnalystPanel and any output that includes AI-generated analysis:

> **DISCLAIMER:** This analysis is generated by an artificial intelligence model (Claude) based on publicly available open-source data. Probability scores and conflict assessments are AI-generated estimates and may be inaccurate, incomplete, or misleading. This tool is not a substitute for professional intelligence analysis, and its outputs should not be used as the sole basis for any decision-making. The developers of Omni Sentinel bear no responsibility for actions taken based on AI-generated analysis.

### Not a Substitute for Professional Analysis

Omni Sentinel is designed as an educational and research tool. It is not:
- A certified intelligence product
- A replacement for professional OSINT analysts or intelligence agencies
- A validated prediction system with calibrated confidence levels
- A tool for operational military or law enforcement use

---

## Disclaimer

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT.

THE LEGAL ANALYSIS IN THIS DOCUMENT IS PROVIDED FOR INFORMATIONAL PURPOSES ONLY AND DOES NOT CONSTITUTE LEGAL ADVICE. Terms of Service, data licensing agreements, and applicable laws change frequently. The information in this document reflects the authors' understanding as of March 2026 and may become outdated. Contributors and users should consult qualified legal counsel for advice on specific legal questions related to their use of Omni Sentinel.

IN NO EVENT SHALL THE AUTHORS, COPYRIGHT HOLDERS, OR CONTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

The developers of Omni Sentinel are not responsible for:
- How third parties use this software
- The accuracy, completeness, or timeliness of data obtained from external sources
- Actions taken by users based on AI-generated analysis or data displayed by the tool
- Changes to third-party Terms of Service that may affect the legality of specific data access methods
- Compliance with local laws in jurisdictions where the software is deployed

Users are solely responsible for ensuring their use of Omni Sentinel complies with all applicable laws, regulations, and third-party Terms of Service in their jurisdiction.

---

*This document should be reviewed and updated whenever a new data source is added, an existing API's terms change, or relevant legal precedent is established.*
