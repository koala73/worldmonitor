# The Verification Desk

A live stage piece for the *Verified Truth & Trust* panel. An AI anchor recaps the week, grades headlines the audience shouts out, and reveals a story that "everyone saw" but that traces back to one newsroom.

The anchor's facts come from WorldMonitor's MCP tools. Its verdicts come from fixed rules in `lib/verdict.mjs`, applied to WorldMonitor's publisher-family counts. Claude only extracts search terms, quote-checks a possible contradiction, and writes the spoken lines. Every model call has a template fallback, so the desk keeps talking if a key or the network fails.

> We don't ask the model if it's true. We ask the data where it came from.

## Prepare tonight (about 20 minutes, then it runs by itself)

```bash
cd demos/verification-desk
npm install
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

The finder looks for three patterns, all read straight from WorldMonitor's counts:

| Pattern | What it means | How it's detected |
|---|---|---|
| `cascade` | Several outlets ran it, and their headlines all credit the same origin ("…, Reuters reports") | At least 3 headlines and 60% or more of attributed headlines name one origin |
| `echo` | One publisher filed it under many feeds or regional editions, and no one else carried it | `corroboration.state === "single-publisher"` and 3 or more headlines |
| `ungated` | Many outlets carried it, but the insights seeder's independent entity-corroboration gate never fired | `uniqueSourceCount >= 4`, `entityCorroboration === false` |

**Open every link before you pin a story.** The data says "one publisher family in what WorldMonitor monitors." On stage, you are the one telling a room that a newsroom was the only source. If you want different wording, edit `script` in `data/reveal.json`.

## Rehearse without any keys

```bash
npm run rehearse     # http://localhost:4317, fictional data, an orange REHEARSAL banner on screen
```

Every place, outlet and number in `fixtures/rehearsal.json` is invented. Try these headlines to see each verdict:

- "Minister Calloway resigns" → **Single-source** (five regional editions of one paper count as one)
- "Aurelia central bank raises rates by 75 basis points" → **Contradicted** (the sources say 50)
- "Mount Tessaly eruption kills 400" → **Corroborated, figure unproven**
- "Aliens land in Paris" → **Unverifiable**
- Press **S** → the Lumora / Kestrel Wire cascade reveal

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

### Verdict rules (`lib/verdict.mjs`)

| Verdict | When |
|---|---|
| Unverifiable | No monitored cluster matches; or only aggregators/blogs carried it (`tier4-only`); or there is no countable publisher evidence |
| Contradicted | The sources state a different figure, or Claude quotes a contradicting line **that appears verbatim in the evidence**. A quote that isn't verbatim is discarded. |
| Single-source | One publisher family (`single-publisher`) |
| Corroborated | Two or more independent families. A figure the sources don't contain is flagged as unproven on the card. |

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
lib/mcp-client.mjs    streamable-HTTP MCP client (X-WorldMonitor-Key or bearer)
lib/sources.mjs       live MCP, archive snapshots, rehearsal fixtures
lib/grade.mjs         the five checks, emitted one at a time
lib/verdict.mjs       the verdict rule and the quote gate
lib/text.mjs          matching, figure extraction, attribution detection
lib/reveal.mjs        single-source candidate finder
lib/anchor.mjs        Claude voice + template fallbacks
scripts/              snapshot, find-reveal, grade (CLI), check
public/               the stage UI (no build step)
```

`npm test` runs the rule, pipeline and MCP client tests against the fixtures.
