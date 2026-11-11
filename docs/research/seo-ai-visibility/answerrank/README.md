# AI-answer snapshots

Dated output of `scripts/seo-answerrank-collect.mjs`. The weekly Search Console
workflow (`seo-gsc-weekly.yml`) writes them, and they ship in the same review PR
as the Search Console, Bing and Umami snapshots.

Each run asks AI models the same 13 buyer questions and records how often the
answers name or cite World Monitor. The questions are in third-party wording,
copied from HN, Reddit and Search Console. The run uses
[answerrank](https://github.com/misbahsy/answerrank), pinned to a commit in the
workflow. GPT and Claude answer with and without a web search tool, Perplexity
Sonar answers with its own search, and each question is asked three times per
variant: 195 answers a week. A judge model reads every answer.

These are model API answers. They are not observations of the ChatGPT,
Perplexity or Google AI products a person uses, so they never fill the
baseline's `aiSurfaces`. Treat them as a proxy that moves when those products
are likely to move.

## Files

- `inputs/queries.json`, `inputs/profile.json` and `inputs/config.yaml` are the
  fixed questions, the product profile (brand, aliases, competitors) and the
  answerrank config. Together they produce the `inputsDigest`.
- `<date>.json` is the snapshot. It holds counts, not just rates: answers,
  mentions, top picks, web answers and citations, overall and per model
  variant, plus failed answers, spend and the comparison with the previous
  week.
- `<date>.md` is the human summary: headline counts, the verdict, a table per
  variant, and the whole series that shares the same inputs.

## How a change is called

A snapshot is compared with the newest earlier snapshot that has the same
`inputsDigest` and the same answered variants. Two rates are tested with a
two-proportion z-test: how often World Monitor is named (out of all answers)
and how often worldmonitor.app is cited (out of web-search answers). A rate is
called `improved` or `declined` only at |z| >= 1.96. Anything smaller is `no
measurable change`. If either rate declined, the headline verdict is `declined`.

At about 14 mentions in 195 answers, a real drop has to be roughly from 7% to
2% before it clears that bar. Manual runs from 2026-10-18 to 2026-11-10 stayed
between 6.7% and 7.2%.

A week where more than 5% of answers failed is `partial` and is not compared.
Changing any input file starts a new series. Do that on purpose, and expect the
next PR to say "not compared".

When the verdict is `declined`, the workflow opens an issue titled "AI-answer
visibility declined", or comments on the open one, so the drop does not stay
inside a PR that merges itself.

## Running it

The run needs `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` and `EXA_API_KEY`. Locally
they are read from `.env.local` through `loadEnvFile()`. In CI they come from
repository secrets. Without all three, the workflow step skips with a notice.
One run takes about 30 minutes and costs about $8.

```sh
uv tool install "answerrank @ https://github.com/misbahsy/answerrank/archive/7bcc853840cf05a92eed6926a3d012fef371753a.zip" --with tenacity
node scripts/seo-answerrank-collect.mjs --live
```

To turn an existing answerrank run directory into a snapshot (its
`queries.json` and `profile.json` must match `inputs/`):

```sh
node scripts/seo-answerrank-collect.mjs --from-run <run dir> --date 2026-11-10
```
