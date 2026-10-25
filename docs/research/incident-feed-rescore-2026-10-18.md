# Incident-feed AnswerRank follow-up, October 18, 2026

The unchanged h04 and q015 questions now name WorldMonitor in 7/15 and 3/8
web-enabled answers, respectively. Both baselines were 0. All 39 answer slots
and their judgments completed. This is a two-question follow-up for
[issue #9216](https://github.com/koala73/worldmonitor/issues/9216), not a repeat
of the full AnswerRank study.

## Results

| Question | Web answers naming WorldMonitor: baseline → follow-up | Web top picks: baseline → follow-up | All answers naming WorldMonitor | Follow-up CLI AEO score |
|---|---|---|---|---|
| h04, self-serve crisis alerts | 0/15 → 7/15 | 0/15 → 2/15 | 7/25 | 22.6 |
| q015, incident-data integration | 0/8 → 3/8 | 0/8 → 2/8 | 3/14 | 18.5 |

| Question | GPT + search | Claude + search | Native Sonar | Gemini + search |
|---|---|---|---|---|
| h04, named / answers | 3/5 | 4/5 | 0/5 | Not in the baseline |
| q015, named / answers | 0/2 | 1/2 | 2/2 | 0/2 |

No search-disabled answer named WorldMonitor. The native Sonar answers count
as web-enabled even though their original AnswerRank rows have `web: false`.

The Factal alternatives page appeared in the search results for the seven h04
answers that named WorldMonitor. Both q015 Sonar answers reported
`https://www.worldmonitor.app/docs/incident-feed` in their citations. The q015
Claude mention followed retrieval of the developer API guide. For tool-search
variants, AnswerRank records URLs returned by search as citations; these URLs
alone do not prove that the final answer cited or endorsed each page.

## Method and evidence

- h04: “Is there a crisis-alerting tool like Factal that a small team can sign up
  for without a sales call?” Baseline run: `heldout-baseline`, five repetitions.
- q015: “I need to feed global incidents and risk signals into our internal app
  without manually scraping news sites and social media. What data service
  should I use?” Baseline run: `worldmonitor.app-20261016`, two repetitions.
- Reused each baseline question, intent, persona and brand profile
  without generating new questions. The comparison checked the parsed inputs
  for exact equality. Kept the baseline model IDs:
  `openrouter/openai/gpt-5.5`, `anthropic/claude-sonnet-5-5`, and
  `openrouter/perplexity/sonar-pro`; q015 also uses
  `openrouter/google/gemini-3.7-flash`.
- Kept the original search comparison: Exa tool search, up to five results per
  search and three searches per answer, search not forced. Kept the
  `anthropic/claude-sonnet-5-5` judge. Excluded the Sonar + tool-search variant
  because it failed tool support in both baseline runs. Retained native Sonar.
- Retried seven rate-limited answer slots serially, preserving completed
  answers. Final answer and judgment failure counts are zero. The CLI recorded
  an estimated $1.67 for answers, searches and judging, including retries.
- The [comparison JSON](incident-feed-rescore-2026-10-18.json) contains the model
  counts, each answer's judged role and rank, target URLs, input-file hashes,
  answer hashes, model IDs, search settings and recorded spend. Full raw runs
  remain in the operator's AnswerRank artifacts as `h04-20261018` and
  `q015-20261018`; credentials are not part of these artifacts.

To repeat, use the original baseline profiles and the two exact questions above,
with the recorded model IDs, search settings and repetition counts. Save a new
dated run. Compare successful matching answer slots, count native Sonar as
web-enabled, and report failed slots separately rather than as absent mentions.

## Interpretation and remaining work

The follow-up ran after the incident-feed page merged in PR #9251. It ran before
deployment of the cursor-pagination change. It measures current model answers;
it does not establish that one page caused the change. Search results and model
behavior vary. Two questions, especially q015's two repetitions per variant,
cannot establish a site-wide visibility trend or buyer conversion.

The pagination change enumerates the existing 180-day store. It does not add
country playback from #4276, new domains from #5745, or longer retention. Those
remain separate work. Buyer demand and storage-cost evidence are still needed
before extending retention.
