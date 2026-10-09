# Real WorldMonitor snapshots

Files here are **real data**, read through the World Monitor MCP connector. They are not fixtures. The desk loads them with the local `data/archive/` snapshots, keeping the last `DESK_ARCHIVE_DAYS` (7 by default), so these stories stay gradeable on stage after they leave the live digest window.

- `2026-10-09T21-10-10Z.json`: clusters, top stories and GDELT articles from `get_news_clusters` and `get_news_intelligence`, captured 2026-10-09 between 21:00 and 21:15 UTC. Fields the projected calls did not return (most tiers, keywords) are null or empty, never guessed.
- `sources.json`: WorldMonitor's ratings for all 519 outlets (tier, propaganda risk, type, state affiliation) from `get_sources`, captured 2026-10-09 ~21:40 UTC. The desk ranks publishers with it.
- `reveal.json`: the pinned reveal. A local `data/reveal.json` overrides it.

## Stories from 2026-10-09 worth using

| Use | Story | What the data shows |
|---|---|---|
| **Reveal** (pinned) | "Trump Announces Diesel Deal With Russia" | 6 radio station sites (KFBK, KOGO, KFYR, WLTP, WJNO, Big WAAX), identical headline, all `*.iheart.com`. One source. The deal itself is independently reported by BBC, FT, CNBC, NBC, France 24 and others: weight **4.3, strong**. |
| Grade, family collapse | "US imposes sanctions on ICC" | The Reuters exclusive came in on two feeds, Reuters India and Reuters US. They count as **one** publisher. AP, CBC, UN News and the State Department itself followed. |
| Grade, weakly sourced | "31 civilians killed in drone strike on Sudan displacement camp" | Ranked #3 in WorldMonitor's world brief. Two publishers, but they weigh only **1.0 (weak)**: Daily Sabah (tier 2, medium risk, state-affiliated: Turkey) and Dabanga Sudan (tier 3, unrated). **31** is stated only by Daily Sabah. |
| Grade, unproven number | "Panama earthquake kills 200" | The 7.7 earthquake is corroborated by 4 publishers. **200** appears nowhere in the sources, so it is unproven. |
| Grade, single source | "Nvidia's communications chief leaves" | Business Insider only. |

**Before you go on stage**, open each link in `reveal.json` and check that the six pages are still up and identical. Re-run `npm run find-reveal` on the morning of the panel; a fresher story may rank higher. Treat the Sudan story with care on stage: the point is about how a number is sourced. Nobody is saying the attack didn't happen.
