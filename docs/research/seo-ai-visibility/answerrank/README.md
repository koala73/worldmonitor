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
  answerrank config. `inputs/requirements.txt` pins every Python dependency by
  hash, for Linux and Python 3.13. Together these four files produce the
  `inputsDigest`.
- `<date>.json` is the snapshot. It holds counts, not just rates: answers,
  mentions, top picks, web answers, web answers that actually searched, and
  citations, overall and per model
  variant, plus unscored answers, spend and the comparison with the previous
  comparable week.
- `<date>.md` is the human summary: headline counts, the verdict, a table per
  variant, and the whole series that shares the same inputs.

## How a change is called

A snapshot is compared with the newest earlier snapshot that has the same
`inputsDigest`, the same answerrank commit and the same answered variants, and
is not partial. An incomparable week in between is skipped, so a drop that
spans a partial week is still measured against the last good one. Two rates are tested with a
two-proportion z-test: how often World Monitor is named (out of all answers)
and how often worldmonitor.app is cited (out of web-search answers). A rate is
called `improved` or `declined` only at |z| >= 1.96. Anything smaller is `no
measurable change`. If either rate declined, the headline verdict is `declined`.

At about 14 mentions in 195 answers, a real drop has to be roughly from 7% to
2% before it clears that bar. Manual runs from 2026-10-18 to 2026-11-10 stayed
between 6.7% and 7.2%.

A week where more than 5% of planned answers went unscored is `partial` and is
not compared. An answer is unscored when the model call failed or its judgment
failed; answerrank leaves both out of its rates. Changing any input file, or
the answerrank commit in the workflow, starts a new series. Do that on purpose, and expect the
next PR to say "not compared".

When the verdict is `declined`, the workflow opens an issue titled "AI-answer
visibility declined", or comments on the open one, so the drop does not stay
inside a PR that merges itself. Each alert carries a marker with the snapshot
date. Only issues with exactly that title opened by `github-actions[bot]`, and
only that bot's comments, count, so an outside issue or comment cannot absorb
or suppress an alert. A rerun in a week whose PR already exists skips the paid collection but
retries the alert from that week's saved snapshot, and the marker keeps it from
reporting the same week twice.

A run imported with `--from-run` must match the committed config: the same
models, judge, generator, repetitions and search settings as `inputs/config.yaml`.
Otherwise the collector refuses it, because the inputs digest would claim
settings the run did not use. A changed judge model also starts a new series.

## Running it

The run needs `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` and `EXA_API_KEY`. Locally
they are read from `.env.local` through `loadEnvFile()`. In CI they come from
repository secrets. Without all three, the workflow step skips with a notice.
One run takes about 30 minutes and costs about $8.

In CI the run happens in its own `answerrank` job, because answerrank is
third-party code. That job's token can only read, its checkout keeps no
credential, its install step has no secrets (hash-pinned wheels from
`inputs/requirements.txt`, answerrank fetched by commit), and only the collect
step gets the keys. It passes the two snapshot files to the job that opens the
PR as an artifact. That job copies none of it: `--accept` rebuilds the
snapshot from its measured fields (every count type-checked; variant labels,
inputs digest, answerrank commit and judge matched against the committed
inputs), recomputes the comparison against the committed earlier weeks, and
writes its own markdown, so no text from the third-party job reaches the
repository, the PR or the decline issue. Locally, with answerrank on your `PATH` (set
`ANSWERRANK_REVISION` to the commit so the snapshot can be compared with CI
weeks):

```sh
uv tool install "answerrank @ https://github.com/misbahsy/answerrank/archive/7bcc853840cf05a92eed6926a3d012fef371753a.zip" --with tenacity
ANSWERRANK_REVISION=7bcc853840cf05a92eed6926a3d012fef371753a node scripts/seo-answerrank-collect.mjs --live
```

To regenerate the lock after changing a pin:

```sh
uv pip compile requirements.in --generate-hashes --python-version 3.13 \
  --python-platform x86_64-manylinux_2_28 --only-binary :all: \
  --exclude-newer <a date at least two weeks back> -o inputs/requirements.txt
```

where `requirements.in` lists `litellm==1.105.1`, `pyyaml==6.0.3` and
`tenacity==9.2.1`.

To turn an existing answerrank run directory into a snapshot (its
`queries.json` and `profile.json` must match `inputs/`):

```sh
node scripts/seo-answerrank-collect.mjs --from-run <run dir> --date 2026-11-10
```
