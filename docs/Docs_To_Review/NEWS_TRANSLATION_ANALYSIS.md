# News Translation Analysis

## Dashboard focus translation review queue

[#10561](https://github.com/koala73/worldmonitor/issues/10561): a reviewer
confirmed corrections to the `focus` sentences in Swahili (`sw`), Dutch (`nl`),
Simplified Chinese (`zh`), and Traditional Chinese (`zh-TW`) whose machine
translation changed the meaning or did not parse. Those sentences are pinned in
`tests/locale-completeness.test.mjs`. #10580 already renamed the action to
"Trip assessment", so the button labels were left as they are. Open terminology
choices that this pass did not settle: Swahili `kuzingatia` versus `lengo` where
the current sentence is grammatical, Dutch `buren` versus `buurlanden`, and
Simplified Chinese `疾病爆发` versus `暴发`.

## Current Architecture

The application fetches news via `src/services/rss.ts`.

- **Mechanism**: Direct HTTP requests (via proxy) to RSS/Atom XML feeds.
- **Processing**: `DOMParser` parses XML client-side.
- **Storage**: Items are stored in-memory in `App.ts` (`allNews`, `newsByCategory`).

## The Challenge

Legacy RSS feeds are static XML files in their original language. There is no built-in "negotiation" for language. To display French news, we must either:

1.  Fetch French feeds.
2.  Translate English feeds on the fly.

## Proposed Solutions

### Option 1: Localized Feed Discovery (Recommended for "Major" Support)

Instead of forcing translation, we switch the *source* based on the selected language.

- **Implementation**:
  - In `src/config/feeds.ts`, change the simple URL string to an object: `url: { en: '...', fr: '...' }` or separate constant lists `FEEDS_EN`, `FEEDS_FR`.
  - **Pros**: Zero latency, native content quality, no API costs.
  - **Cons**: Hard to find equivalent feeds for niche topics (e.g., specific mil-tech blogs) in all languages.
  - **Strategy**: Creating a curated list of international feeds for major categories (World, Politics, Finance) is the most robust & scalable approach.

### Option 2: On-Demand Client-Side Translation

Add a "Translate" button to each news card.

- **Implementation**:
  - Click triggers a call to a translation API (Google/DeepL/LLM).
  - Store result in a local cache (Map).
- **Pros**: Low cost (only used when needed), preserves original context.
- **Cons**: User friction (click to read).

### Option 3: Automatic Auto-Translation (Not Recommended)

Translating 500+ headlines on every load.

- **Cons**:
  - **Cost**: Prohibitive for free/low-cost APIs.
  - **Latency**: Massive slowdown on startup.
  - **Quality**: Short headlines often translate poorly without context.

## Recommendation

**Hybrid Approach**:

1.  **Primary**: Source localized feeds where possible (e.g., Le Monde for FR, Spiegel for DE). This requires a community effort to curate `feeds.json` for each locale.
2.  **Fallback**: Keep English feeds for niche tech/intel sources where no alternative exists.
3.  **Feature**: Add a "Summarize & Translate" button using the existing LLM worker. The prompt to the LLM (currently used for summaries) can be adjusted to "Summarize this in [Current Language]".

## Next Steps

1.  Audit `src/config/feeds.ts` to structure it for multi-language support.
2.  Update `rss.ts` to select the correct URL based on `i18n.language`.
