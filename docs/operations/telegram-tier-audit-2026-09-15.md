# Telegram Tier 1 audit — 15 September 2026

Scope: all 65 entries in the curated Telegram registry, including the newly added SaudiDCD. This is a registry review with live publisher checks for plausible upgrade candidates, not an independent ownership verification of all 65 accounts.

Tier 1 means a wire service or an official government/intergovernmental publisher. It is separate from polling priority and from bias risk. A government statement remains an attributed government statement. Subscriber counts, speed and a state connection alone do not qualify a channel.

| Decision | Account(s) | Evidence and reason |
|---|---|---|
| Add Tier 1 government source | [SaudiDCD](https://t.me/SaudiDCD) | Channel identifies the Saudi Civil Defense directorate; user confirms it is the trusted government account. The [government website](https://998.gov.sa/) documents its emergency-protection remit. Low risk applies to its civil-defense notices, with Saudi state affiliation disclosed. |
| Upgrade Tier 3 to Tier 1 wire | [BNONews](https://t.me/BNONews) | Verified Telegram publisher. Its [publisher history](https://bnonews.es/index.php/about-us/) documents a subscription wire, newsroom staff and media clients. The [publisher support page](https://bnonews.com/index.php/support-bno-news/) describes independent ownership and its reporting mission. The old aggregator description does not reflect that evidence. Update the X overlay and packaged tier mirror too because the platforms share the same source name. |
| No additional government upgrade | kpszsu, IDFofficial, RocketAlert, sepah, defapress_ir, SaberinFa | These six already have Tier 1 in the registry. Retaining an existing value is not fresh ownership validation; see the identity questions below. |
| Retain newsroom tiers | 14 remaining mainstream entries | Being a broadcaster or state-affiliated outlet does not make a publisher a direct government authority. [PressTV](https://t.me/PressTV) describes a television network. [France 24](https://t.me/s/France24_en) describes an international news channel. |
| Retain specialist/aggregator tiers | 41 intel entries and 2 tech entries | No additional wire or direct government publisher identified in the registered source descriptions. Their original reporting, domain knowledge or fast reposting does not by itself meet the Tier 1 definition. |

## Identity questions found during the review

- [TasnimNewsEN](https://t.me/TasnimNewsEN) describes itself as a translated rebroadcast channel whose administrator does not own the content. That is not evidence of an official Tasnim newsroom account and does not justify an upgrade.
- [RocketAlert](https://t.me/RocketAlert) says it is powered by RocketAlert.live. Its current government-source label needs a separate ownership check; relaying official warnings alone does not establish government ownership.
- [SaberinFa](https://t.me/SaberinFa) describes the official channel of Saberin News, not an official government department. Its existing government classification also needs ownership evidence.

These questions are recorded without silently treating the existing Tier 1 labels as verified. This change adds no new alert route for these accounts. BNO's existing X alert path inherits its corrected shared source tier; Telegram alert opt-in in this change is limited to SaudiDCD.

## Saudi alert acceptance boundary

Local fixtures cover ingestion text limits, fresh-post selection, severity classification responses, canonical source links, SA country filtering, classification retries and the existing notification publisher call. No fixture proves actual LLM judgement, Telegram ingestion freshness, production deployment or delivery to a user's device. Merge/deployment and a natural successful delivery must be verified separately.
