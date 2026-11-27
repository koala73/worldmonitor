# ChatGPT plugin resubmission

Status: packet prepared for the version after 2.11.8. Submission happens in the OpenAI Platform dashboard and is not part of any pull request.

## Review history

| Version | Submitted (UTC) | Outcome |
|---|---|---|
| 2.10.1 | 2026-11-01 08:30 | Rejected 2026-11-13: commerce in digital services, and summarizing or aggregating third-party news. |
| 2.11.8 | 2026-11-14 05:57 | Approved 2026-11-27 and published. On the published version itself, the dashboard marks the held tools below "This new tool definition needs further review before it can be published." No newer draft was open on 2026-11-27. |

The approval email names no tools. The held tools are `get_market_data`, `get_news_intelligence`, `get_prediction_markets`, `get_sanctions_data`, `get_country_coverage`, `get_intel_timeline`, `get_news_clusters`, `verify_claim`, `get_keyword_spikes` and `open_news_dashboard`.

## What the held tools are not explained by

Checked on 2026-11-27. None of these reproduces the set of 10:

- **Change since submission.** Most held tools have the same definition today as at the submitted commit, and other definitions that did change are not held.
- **Runtime difference.** Production `tools/list` sent with the ChatGPT user agent matches `CHATGPT_TOOL_LIST_RESPONSE` field for field.
- **Wrong policy for the reviewer.** Review traffic used `openai-mcp/1.0.0`, which `isChatGptHost` matches, so the reviewer saw the ChatGPT tool list.
- **Failures.** ChatGPT error rates in `wm_api_usage` from 2026-11-14 to 2026-11-27 do not single these tools out.

Seven held tools return publisher headlines or are built from them, which matches the 2.10.1 news finding. `get_market_data`, `get_prediction_markets` and `get_sanctions_data` carry no headlines, and nothing found explains why they are held. The notes below explain each tool.

## Changes since 2.11.8

Run `npx tsx scripts/chatgpt-tool-diff.mts`. It compares the ChatGPT tool list with `scripts/data/chatgpt-reviewed-tools.json`, the per-field hashes of the approved 2.11.8 list. On 2026-11-27 it reported:

- Added: `get_country_imagery_evidence`, `get_point_satellite_passes`, `get_watched_site_imagery`. These are WorldMonitor's satellite pass predictions and archive image metadata, with the credit line each image owes.
- Changed: `extract_entities`, `get_country_brief_section`, `get_intel_timeline`, `get_military_surge`, `get_news_clusters`, `get_reservoir_levels`, `get_sanctions_data`, `get_similar_events`, `prepare_travel_risk_assessment`, `search_intel_history`.

Both rejection grounds were rechecked on these changes:

- **Commerce.** ChatGPT tool copy has no billing or plan wording (`tests/mcp-chatgpt-commerce-policy.test.mjs`). The payment-failed denial added since 2.11.8 states that access is paused and links no billing page. The consent and grant pages show no plan offer when ChatGPT starts the sign-in.
- **News.** Intel-history records, including the sources added since 2.11.8, reach ChatGPT with their third-party `summary` emptied (`tests/mcp-chatgpt-news-policy.test.mjs`). The `summary` fields in news-cluster and claim results are WorldMonitor's own provenance facts, not publisher text.

After the new version is approved, record it as the baseline from the definitions OpenAI reviewed, not from today's checkout. Either run the script in a worktree checked out at the submitted commit and copy the snapshot back:

```bash
git worktree add /tmp/wm-submitted <commit live at submission>
cd /tmp/wm-submitted && npm ci --ignore-scripts
npx tsx scripts/chatgpt-tool-diff.mts --write --version <approved version>
```

Or pass the `tools/list` reply captured at submission:

```bash
npx tsx scripts/chatgpt-tool-diff.mts --write --source <captured tools/list.json> --version <approved version> --commit <commit live at submission>
```

Without `--source`, the script refuses a `--commit` that differs from the checked-out HEAD.

## Notes for the held tools

Paste into the review information. Each result lists a publisher headline only as the feed's title, the publisher's name, the time and a link. No article text, excerpt or WorldMonitor summary is returned to ChatGPT.

| Tool | What it returns | Test prompt |
|---|---|---|
| `get_market_data` | Quotes, commodity prices, sector performance, ETF flows and the Fear & Greed index. No headlines. | What are gold, Brent and the S&P 500 doing today? |
| `get_prediction_markets` | Prediction-market contracts from the venues' public APIs, with probability, venue and a link to the contract. | What do prediction markets give for the next US Fed rate decision? |
| `get_sanctions_data` | Matches against official OFAC, Canada SEMA and US export-control lists, and per-country designation counts. No headlines. | Is Rosneft on any US sanctions list? |
| `get_news_intelligence` | WorldMonitor threat classification and signal counts over headline clusters, each headline as a pointer. The LLM brief and RSS snippets are removed for ChatGPT. | What are the top security stories in the Middle East right now, with links? |
| `get_news_clusters` | Groups of headlines that report the same event, with how many publishers report it. Headlines are pointers. | Which world stories are the most widely reported right now? |
| `verify_claim` | How many publishers report a claim and which ones, with links. WorldMonitor does not judge the claim from article text. | Is anyone reporting that the Suez Canal has closed? |
| `get_keyword_spikes` | Terms appearing in headlines more often than their baseline, with up to three sample headlines as pointers. | Which security keywords are spiking in the news today? |
| `get_country_coverage` | A country's recent headlines as pointers, merged with WorldMonitor's own incident records. | Show recent coverage for Sudan with links to the sources. |
| `get_intel_timeline` | WorldMonitor's event history for a country or domain. Third-party summaries are emptied for ChatGPT. | Show the recent event timeline for Taiwan. |
| `open_news_dashboard` | The embedded headline dashboard and map. Snippets are removed and the summarize and translate controls are off for ChatGPT. | Open the news map for Ukraine. |

## Packet checklist

- Confirm the review account still signs in and has every tool enabled.
- Replace the 2.10.1 walkthrough video (`public/assets/worldmonitor-plugin-walkthrough-2.10.1.mp4`). It predates the news and commerce changes.
- Use the listing copy in `plugin.json` (`extensions["com.openai"].interface`).
- Ask in the submission notes which held tool raises a concern, if any remain held.
