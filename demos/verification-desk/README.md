# The Verification Desk

A live stage piece for the *Verified Truth & Trust* panel. An AI anchor recaps the week, grades headlines the audience shouts out, and reveals a story that "everyone saw" but that traces back to one newsroom.

The desk does not have its own idea of truth. It finds which WorldMonitor story the audience means, then every judgment on screen is a call into WorldMonitor's own code: the same modules the dashboard, the MCP tools and the brief seeders use (`lib/wm.mjs`). Claude only extracts search terms and writes the spoken lines, and a line is spoken only if it passes WorldMonitor's own brief hallucination validators. Every model call has a template fallback built only from WorldMonitor's data.

> We don't ask the model if it's true. We ask the data where it came from.

## Already in the repo: real data from 2026-10-09

`snapshots/` holds real WorldMonitor data, captured through the MCP connector on 2026-10-09 around 21:10 UTC, and a **pinned reveal**: "Trump Announces Diesel Deal With Russia", the same headline on six iHeart radio station sites, so one source. `npm start` works on this data with no keys at all. See [snapshots/README.md](snapshots/README.md) for the headlines to try and what each one shows. Open the six links in `snapshots/reveal.json` before the panel.

## Prepare tonight (about 20 minutes, then it runs by itself)

```bash
cd demos/verification-desk
npm install          # also installs tsx, which loads WorldMonitor's TypeScript modules
cp .env.example .env          # add WORLDMONITOR_API_KEY, ANTHROPIC_API_KEY (+ ElevenLabs if you have it)
npm run check                 # every line should be PASS, or a WARN you accept
npm run snapshot:loop         # leave running overnight: archives the digest every 30 min
```

**Why snapshots matter.** WorldMonitor's news tools only see the live digest window. That window is not a 7-day history. Each snapshot adds the current clusters, member headlines and world brief to `data/archive/`. The desk then matches headlines against live data plus the archive, and the recap switches to "the last seven days" once at least 5 archived stories exist. Start the loop as early as you can.

**Pick the reveal story (do this in the morning, once the archive has some depth):**

```bash
npm run find-reveal                 # ranked candidates, with every member headline and link
npm run find-reveal -- --pick 2     # pin #2 to data/reveal.json and draft the anchor script
```

The finder looks for four patterns, all read straight from WorldMonitor's data:

| Pattern | What it means | How it's detected |
|---|---|---|
| `cascade` | Several outlets ran it, and their headlines all credit the same origin ("…, Reuters reports") | At least 3 headlines and 60% or more of attributed headlines name one origin |
| `echo` | One publisher filed it under many feeds or regional editions, and no one else carried it | `corroboration.state === "single-publisher"` and 3 or more headlines |
| `syndication` | The same headline on several sites that share one owner (iHeart stations, one content network's mastheads) | GDELT articles in `get_news_intelligence`: 3 or more hosts with one owner domain, or the same article id |
| `ungated` | Many outlets carried it, but the insights seeder's independent entity-corroboration gate never fired | `uniqueSourceCount >= 4`, `entityCorroboration === false` |

**Open every link before you pin a story.** The data says "one publisher family in what WorldMonitor monitors." On stage, you are the one telling a room that a newsroom was the only source. If you want different wording, edit `script` in `data/reveal.json`.

## Practise without any keys

```bash
npm run offline      # http://localhost:4317, the committed real snapshots, no network
```

Try the headlines in the table below, then press **S** for the iHeart reveal.

## On stage

```bash
npm start            # http://localhost:4317 → press F for fullscreen, H to hide the console
```

| Key | Action |
|---|---|
| R | Recap: the anchor reads the week, and every story is tagged with its source count |
| / | Type a headline (Enter grades it) |
| M | Microphone: speak the shouted headline (Chrome or Edge). Speak it yourself; don't point the mic at the room. |
| S | Reveal: the pinned single-source story with the cascade animation |
| Esc | Stop speaking and reset |

Each grade streams the checks one at a time: **who** (publisher families, with collapsed feed labels struck through), **when** (first seen, spread, stated origin), **numbers** (every figure in the headline looked up in the article text and member headlines), **money** (Polymarket and Kalshi odds that match), then the **verdict** card, and then the anchor speaks. Every live grade is logged to `data/grades/` for your write-up after the panel.

### How a headline is graded: WorldMonitor's chain, end to end

| Check on screen | WorldMonitor code it calls |
|---|---|
| Who said it: publishers, not feed labels (Reuters India + Reuters US = one) | `assessCorroboration`, `publisherRoster` in `server/_shared/corroboration.ts`; families in `shared/publisher-families.js` |
| How good are they: tier T1–T4 | `declaredSourceTier`, `getSourceTier`, `TIER_MEANING` in `server/_shared/source-tiers.ts` |
| Propaganda risk, state affiliation, provenance note | `getSourcePropagandaRisk`, `getSourceProvenanceState` in `shared/source-provenance.ts` |
| CRED n per source and for the story, low/medium/high | `computeCredibilityScore` in `shared/news-credibility.js`, composed and banded as the dashboard's `resolveCredibilityScore` / `renderCredibilityBadge` (`src/components/news/source-provenance.ts`) |
| Clears the corroboration bar? | `MIN_CORROBORATING_PUBLISHERS` (2), the same constant the brief and digest gates use |
| Entity-corroboration gate | the insights seeder's `entityCorroboration` / `corroborationSourceCount`, read from `get_news_intelligence` |
| Is every figure grounded? | `extractNumericFacts`, `validateNoHallucinatedFacts` in `shared/brief-llm-core.js`, the brief seeders' fact gate |
| Is the anchor's script grounded? | `validateNoHallucinatedProperNouns`, `validateNoHallucinatedStatusQualifiers`, `validateNoHallucinatedFacts` |
| Reveal: N sites, one publisher | `briefGroundingPublisherCount`, `briefGroundingGap` in `scripts/crawlable-developments.mjs` |
| Wording ("Single publisher", "Low-tier sources only", "Reported by N publishers, including N tier-1") | `components.corroboration` in `src/locales/en.json` |

The desk's own logic is limited to **retrieval**: matching a spoken headline to WorldMonitor clusters, and gathering every cluster of one event. On 2026-10-09 the diesel deal sat in 8 one-outlet clusters; all their feed labels go to `assessCorroboration` together. Change a rule in WorldMonitor and the desk changes with it.

**The verdict card** puts WorldMonitor's coverage state in its own words (*Corroborated*, *Single publisher*, *Low-tier sources only*, *Unverifiable*, or *Not in WorldMonitor's sources*). The colour follows the CRED band, and the card lists the gates above with WorldMonitor's caveat: *tiers rank sources; they do not judge this claim. Coverage, not accuracy.* There is no "Contradicted": WorldMonitor has no contradiction judgment, so the desk doesn't invent one.

Real results (2026-10-09 snapshot):

| Headline | WorldMonitor says |
|---|---|
| Trump strikes diesel deal with Putin | Corroborated · 6 publishers · CRED 93 (BBC) · France 24 state-affiliated |
| 31 civilians killed in drone strike on Sudan displacement camp | Corroborated · 2 publishers · CRED 56 (medium) · Daily Sabah state-affiliated (Turkey) · 31 stated by Daily Sabah only |
| US imposes sanctions on ICC | Corroborated · 7 publishers incl. 1 tier-1 · CRED 68 |
| Panama earthquake kills 200 | Corroborated · CRED 89 · **200 not grounded in any source** |
| Nvidia's communications chief leaves | **Single publisher** · Business Insider, CRED 77 |
| Trump Announces Diesel Deal With Russia (reveal) | 6 iHeart station sites → **1 publisher**, `thin-grounding` |

**WorldMonitor data gaps the desk shows as-is** (fix them in WorldMonitor, not here):

- "Reuters US" and "Reuters India" have no reviewed propaganda risk, so Reuters stories score CRED 68 while "Reuters" itself is reviewed low-risk.
- CNA is state-affiliated (Singapore) *and* low risk, so it scores 93.

WorldMonitor's corroboration states describe coverage, not accuracy. The anchor is prompted never to call a claim true or false, only to say what the sources show.

### If things break

- **Venue Wi-Fi drops:** the recap and reveal replay from `data/cache/` (last good copy), and the reveal is pinned on disk. Grading a new headline needs the network. The fallback line is "the desk can't reach its sources, so the honest answer is: unverifiable."
- **No Anthropic key, or the API is slow:** the template voice speaks the same facts.
- **No ElevenLabs:** the browser voice speaks. Chrome on macOS has the best built-in voices.
- **The live map backdrop is slow:** set `DESK_BACKDROP_URL=` (empty) in `.env` for a plain dark background.
- **Talking-head avatar:** set `DESK_AVATAR_EMBED_URL` to a HeyGen or Tavus conversation page and it replaces the animated globe. Faces fail on conference Wi-Fi; voices don't. Keep the globe unless you've tested the avatar at the venue.
- **Safest fallback:** screen-record the recap and the reveal tonight, and run only the audience grading live.

## Stage script (~7 minutes)

**Open.** "Truth online isn't a vibe, it's a count. I'm going to let an AI anchor re-read last week's news to you, and tell you, claim by claim, what was actually verified and what the whole internet just repeated."

1. **Recap (90 s, press R).** The anchor reads the week, and every story carries its count. *Message: verification can be the default, not an afterthought.*
2. **Grade a headline (3 min, two or three from the room).** Each check lands on screen as the anchor reaches it. If someone names something that isn't in the data, let it land on **Unverifiable**. That's the most powerful answer to show. *Message: trust is auditable, step by step.*
3. **The reveal (90 s, press S).** One story, the headlines flying in, all lines converging on one newsroom. Pause. *Message: virality is not corroboration.*

Soundbites:
- "A headline in 40 outlets with one source is still one source."
- "We don't ask the model if it's true. We ask the data where it came from."
- "The most honest output a system can give is: I can't verify this."
- "Prediction markets are the only news readers who lose money for being wrong."

## Layout

```
server.mjs            HTTP + SSE server, last-good cache, ElevenLabs proxy
lib/wm.mjs            the only bridge to WorldMonitor's grading code (see the table above)
lib/grade.mjs         retrieval + the checks, emitted one at a time
lib/verdict.mjs       arranges WorldMonitor's judgments into the verdict card
lib/reveal.mjs        single-publisher reveal finder, counted by WorldMonitor
lib/text.mjs          retrieval only: matching a spoken headline to clusters
lib/anchor.mjs        Claude voice, gated by WorldMonitor's brief validators, with template fallbacks
lib/mcp-client.mjs    streamable-HTTP MCP client (X-WorldMonitor-Key or bearer)
lib/sources.mjs       live MCP and archive snapshots
scripts/              snapshot, find-reveal, grade (CLI), check
snapshots/            real WorldMonitor data, committed
public/               the stage UI (no build step)
```

`npm test` checks that the bridge matches WorldMonitor's functions and runs the pipeline against the real snapshot. Everything runs under `node --import tsx`; the npm scripts already do this.
