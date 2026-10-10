# The Verification Desk

A live stage piece for the *Verified Truth & Trust* panel. It opens on **today's news as WorldMonitor sees it**, split into what is corroborated and what is thin, read out by an AI anchor (a HeyGen talking head, or a glowing globe with a voice). Then the room picks stories, or shouts their own, and the desk checks each one live. It ends on a reveal: a headline that ran in six places but traces to one source.

The desk has no idea of truth of its own. Every judgment on screen is WorldMonitor's own code, the same modules the dashboard, MCP tools and brief seeders use (`lib/wm.mjs`). Claude only finds search terms and writes the spoken lines, and a line is spoken only if it passes WorldMonitor's brief hallucination validators.

> We don't tell you what's true. We show you what stands behind it.

## The show: the deck with live WorldMonitor scenes

`/` serves the stage deck (`deck/verified-truth-stage.html`, installed to `public/deck.html` by `npm install` or `npm run deck`) with two live scenes added in place of its illustrative engine. The standalone desk is still at `/desk`.

- **Live board** (after the Nobel slide): today's stories as WorldMonitor grades them. The left column is corroborated stories, with publisher count, CRED and best-tier sources. The right column is in-circulation, single-publisher stories, each with a stamp. Press **1–7**, or click a story, to check it live.
- **Live check**: the deck's pipeline, lanes, dial and stamp, filled by WorldMonitor's grading. Press **T** to type an audience headline and **Enter** to run it, **Backspace** to go back to the picker.
- **G** switches the HeyGen avatar on and off in the deck's avatar slot. When it is off, the deck's recorded voice plays (ElevenLabs for the live lines when the key is set).
- **Shift+U** refreshes the board (plain U stays the deck's mute key). **Enter** re-runs the last headline, including after a failed check. Every other key is the deck's own; press **?** for the full list.
- **The control bar has the live keys as buttons** (after a divider, right of ⛶): **G AVATAR** and **L AUTO** are always there and light up when on; **⇧U REFRESH** appears on the live board; **T TYPE**, **RE-RUN** and **PICKS** appear on the live check. A button fires exactly the key it names.

The deck's own slides are frozen as of Fri 9 Oct 19:30 GST. Its "How WorldMonitor does it" slide shows WorldMonitor's source tiers 1–4, the propaganda-risk rating and the CRED bands; the live scenes compute them on today's news.

## What happens on stage (standalone desk, `/desk`)

1. **Open the laptop page.** Today's board is already on screen, blurred behind "Press Space to go live". It is built from live WorldMonitor data, or the committed snapshot offline.
2. **Space: go live.** The avatar connects (if configured) and the anchor narrates the board by itself: how many stories WorldMonitor is tracking, how many are corroborated, the best-supported one, the thinnest ones.
3. **Click any story** on the board, or type or speak an audience headline. The checks fill in one by one: who reported it and how credible each source is, when it appeared, whether its figures are grounded, what prediction markets say. Then the verdict, in WorldMonitor's words.
4. **S: the reveal.** "Trump Announces Diesel Deal With Russia": six radio station sites, one publisher (iHeart).
5. **B** brings the board back at any time. It refreshes itself every 15 minutes while it is on screen.

| Key | Action |
|---|---|
| Space | Go live (first press), then re-read the board |
| B | Board |
| / or M | Type or speak a headline (mic: Chrome or Edge; speak it yourself, don't point it at the room) |
| S | Reveal |
| R | Recap of the week |
| **A** | **Switch between the HeyGen avatar and the globe + voice** |
| U | Refresh the board now |
| Esc | Stop talking, back to the board |
| F / H | Fullscreen / hide the console |

## Setup

```bash
cd demos/verification-desk
npm install          # installs tsx (loads WorldMonitor's TypeScript) and bundles the LiveAvatar SDK
npm run offline      # no keys, no network: http://localhost:4317 on the committed real snapshot
```

The desk listens on localhost only, because its routes spend your keys and WorldMonitor allowance (`DESK_HOST` changes that, and then it requires `DESK_PASSWORD`). Offline mode makes no network calls at all: no Claude, no article fetches, no live backdrop.

### Run it from any computer (hosted, with a login)

No laptop at the venue: host the desk and open its URL on the venue computer.

1. Create a service from this repository with the Dockerfile `demos/verification-desk/Dockerfile` (on Railway: set the variable `RAILWAY_DOCKERFILE_PATH=demos/verification-desk/Dockerfile`). The image already listens on `0.0.0.0` and the host's `PORT`.
2. Set the variables on the service, never in the repo: `DESK_PASSWORD` (required), `WORLDMONITOR_API_KEY`, `ANTHROPIC_API_KEY`, `LIVEAVATAR_API_KEY`, `LIVEAVATAR_AVATAR_ID`, and ElevenLabs if used. Leave `LIVEAVATAR_VOICE_ID` unset for a video avatar such as Graham. Set `LIVEAVATAR_CONTEXT_ID` and `LIVEAVATAR_SILENT_CONTEXT_ID` to the ids in your local `data/liveavatar-context*.json` so redeploys reuse them.
3. At the venue: open the URL in Chrome, enter the password, click once anywhere (browsers need a click before audio plays), press **F** for fullscreen.

Every page and route sits behind the login, which lasts 12 hours. Without `DESK_PASSWORD` the server refuses to listen beyond localhost (`DESK_ALLOW_OPEN=1` overrides, for a private network only).

The desk reads `demos/verification-desk/.env` first, then the repository's own `.env.local` and `.env` two levels up, so keys that already live there (WorldMonitor, Anthropic, LiveAvatar) need no copying; an empty line in the demo `.env` never hides them. The shell wins over every file. For the live show, `cp .env.example .env`, fill in what you have (or nothing, if the repo's `.env.local` already has it), then:

```bash
npm run check        # every line PASS, or a WARN you accept
npm start            # live WorldMonitor data
```

| Key in `.env` | What it adds | Without it |
|---|---|---|
| `WORLDMONITOR_API_KEY` | Live data | The committed 2026-10-09 snapshot |
| `ANTHROPIC_API_KEY` | Natural spoken lines (still gated by WorldMonitor's validators) | Template sentences from WorldMonitor's data |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | Human voice for the globe | The browser's built-in voice |
| `LIVEAVATAR_API_KEY` + `LIVEAVATAR_AVATAR_ID` + `LIVEAVATAR_VOICE_ID` | HeyGen talking head that says the anchor's exact lines | The globe |

**HeyGen LiveAvatar.** HeyGen's real-time avatars are a separate product, [LiveAvatar](https://www.liveavatar.com), with its own key from app.liveavatar.com/developers and its own credits (FULL mode: 2 credits a minute). A HeyGen video API key (`sk_V2_hgu…`) is a different product and may be refused. The integration follows LiveAvatar's own guide ([liveavatar-agent-skills](https://github.com/heygen-com/liveavatar-agent-skills), FULL mode):

1. Put the key in `.env` and run `npm run check`. It lists your avatar and voice ids.
2. Set `LIVEAVATAR_AVATAR_ID`, plus `LIVEAVATAR_VOICE_ID` for an image avatar, and run `npm run check` again. It creates the session context (cached in `data/liveavatar-context.json`; without a context LiveAvatar's avatar is silent) and a session token, and prints LiveAvatar's exact answer. For a **video** avatar the voice id is deliberately not sent: a video avatar carries its own voice agent, and an explicit `voice_id` makes the FULL-mode agent silent (the face streams, every line is ignored, no error, no `speak_started`). That is what happened on 2026-10-10 with "Graham Sitting" and its own preset voice; the sandbox avatar and the same avatar without a voice both spoke. `LIVEAVATAR_FORCE_VOICE=1` sends it anyway. The browser console logs every agent event as `[avatar:live] …`; a sent line with no `avatar.speak_started` after it is the server declining it.
3. `LIVEAVATAR_SANDBOX=1` tries LiveAvatar's free sandbox avatar (about one-minute sessions) without spending credits.

The avatar says "WorldMonitor desk. Live." when it connects, then only the desk's lines, word for word (`repeat`). The warm standby session uses a second context with no opening line, so a hand-over never replays the greeting. The stream is requested at `MEDIUM` quality (`LIVEAVATAR_VIDEO_QUALITY`): at 1080p a weak venue link freezes the face while the voice carries on, which looks like an avatar that "doesn't move". The microphone stays muted, so it never improvises. LiveAvatar caps session length by plan (120 seconds on the current plan; `npm run check` can't raise it). So at about 70 seconds the desk opens a second session, muted and hidden, and hands over to it between sentences: the audience sees one avatar. If a session drops anyway, the desk reconnects; if it can't, it falls back to the globe. The avatar costs credits (2 a minute, slightly more during hand-overs) the whole time it is switched on. The video runs over WebRTC (LiveKit, `*.livekit.cloud`), so test it on the venue network. Press **G** in the deck (**A** on `/desk`) to switch by hand; switching to the globe closes the session so it stops using credits.

**WorldMonitor allowance.** The plan this was built on has 50 MCP calls a day. A show uses roughly 2 per board refresh and up to 3 per checked headline. `npm run check` prints what's left. `npm run snapshot:loop` takes a snapshot every 2 hours (3 calls each); stop it before the show if the allowance is tight.

**The reveal.** `snapshots/reveal.json` is pinned (the iHeart story, real data from 2026-10-09). Open its six links before the panel. `npm run find-reveal` lists fresher candidates; `npm run find-reveal -- --pick N` pins one to `data/reveal.json`, which takes priority. The finder groups candidates, and WorldMonitor counts the publishers behind each one:

| Pattern | WorldMonitor function |
|---|---|
| `syndication`: one headline on several open-web sites | `briefGroundingPublisherCount` = 1 |
| `echo`: many headlines, one publisher | `assessCorroboration` = single-publisher |
| `ungated`: several outlets, entity gate did not fire | the insights seeder's `entityCorroboration` |

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

- **Venue Wi-Fi drops:** the board, recap and reveal replay from `data/cache/` (last good copy) and the snapshot, labelled *LAST SNAPSHOT* with its date, and the anchor says so instead of "right now". A new headline needs the network; the desk then says *Sources unreachable*, never "nobody carried it". Every WorldMonitor call gives up after 10 s. Claude calls time out after 12 s with SDK retries off (a `BadRequestError` still makes one explicit fallback call). A failed snapshot is retried automatically after a minute, or sooner when you force a refresh (U); meanwhile the last good one stands in, keeps its own time and is labelled a snapshot, not live. The scene starts playing at WorldMonitor's verdict while the anchor's line is still being written, so a slow network costs seconds, not minutes.
- **HeyGen fails or freezes:** press **G** in the deck (**A** on `/desk`). The globe and voice take over mid-sentence.
- **No Anthropic key, or the API is slow:** the template voice speaks the same facts.
- **The live map backdrop is slow:** set `DESK_BACKDROP_URL=off` in `.env` (a blank value is treated as an unfilled placeholder). Offline mode never loads it.
- **Safest fallback:** screen-record a full run tonight.

## Stage script (~7 minutes)

**Open (Space).** "We don't tell you what's true. We show you what stands behind it: how many independent sources, how credible each one is, and whether the facts hold up." The anchor reads today's board.

Say *validates the evidence*, never *validates the truth*. WorldMonitor's own wording is "This describes coverage, not accuracy."

1. **The board (90 s).** Point at the two columns. WorldMonitor's #1 story of 2026-10-09, Ukraine striking Yandex's data centres, sat in the thin column: one publisher. *Message: verification can be the default, not an afterthought.*
2. **Check stories (3 min).** Click one from each column, then take one from the room. If it isn't in the data, let it land on *Not in WorldMonitor's sources*. *Message: trust is auditable, step by step.*
3. **The reveal (90 s, S).** Six station sites, one publisher. Pause. *Message: virality is not corroboration.*

Soundbites:

- "A headline in 40 outlets with one source is still one source."
- "We don't ask the model if it's true. We ask the data where it came from."
- "The most honest output a system can give is: I can't verify this."
- "Prediction markets are the only news readers who lose money for being wrong."

## Layout

```
server.mjs            HTTP + SSE server, last-good cache, ElevenLabs proxy
lib/wm.mjs            the only bridge to WorldMonitor's grading code (see the table above)
lib/board.mjs         today's board: groups one event's clusters, WorldMonitor grades them
lib/grade.mjs         retrieval + the checks, emitted one at a time
lib/verdict.mjs       arranges WorldMonitor's judgments into the verdict card
lib/reveal.mjs        single-publisher reveal finder, counted by WorldMonitor
lib/text.mjs          retrieval only: matching a spoken headline to clusters
lib/anchor.mjs        Claude voice, gated by WorldMonitor's brief validators, with template fallbacks
lib/mcp-client.mjs    streamable-HTTP MCP client (X-WorldMonitor-Key or bearer)
lib/sources.mjs       live MCP and archive snapshots
scripts/              snapshot, find-reveal, grade (CLI), check
snapshots/            real WorldMonitor data, committed
deck/                 the stage deck (source); scripts/install-deck.mjs injects the live scenes
public/deck-live.*    live WorldMonitor scenes and the HeyGen switch inside the deck
public/               the standalone desk (no build step); public/avatar.js drives HeyGen LiveAvatar
scripts/build-avatar.mjs  bundles the LiveAvatar SDK locally on npm install (public/vendor/)
```

`npm test` checks that the bridge matches WorldMonitor's functions and runs the pipeline against the real snapshot. Everything runs under `node --import tsx`; the npm scripts already do this.
