// The anchor's voice. Claude turns the pipeline's findings into speech and
// pulls search terms out of a shouted headline. It never decides a verdict:
// verdict.mjs does that from WorldMonitor's counts. Every call has a template
// fallback, so the desk still talks when the API key or the network is gone.

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-opus-5-5';

const ANCHOR_PERSONA = `You are the anchor of "The Verification Desk", a live segment on a conference stage, powered by WorldMonitor.
You speak to a room, so write for the ear: short sentences, no lists, no markdown, no URLs, no emoji.
You only state facts present in the JSON you are given. You never say a claim is true or false; you say what the sources show: how many independent publisher families carried it, whether its figures appear in the sourced text, and what prediction markets price.
"Unverifiable" is an honest answer, say it plainly and without apology.
Publisher families: several feeds or regional editions of one newsroom count as one.`;

function textOf(message) {
  return (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

export class Anchor {
  constructor({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANCHOR_MODEL || DEFAULT_MODEL, effort = process.env.ANCHOR_EFFORT || 'low' } = {}) {
    this.enabled = Boolean(apiKey);
    this.model = model;
    this.effort = effort;
    this.client = this.enabled ? new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 }) : null;
  }

  async complete({ system, prompt, schema, maxTokens = 2000 }) {
    const params = {
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort: this.effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
    };
    let message;
    try {
      // Server-side refusal fallback: if a safety classifier declines a
      // conflict story, the API re-runs it on another model in the same call.
      message = await this.client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (error) {
      if (!(error instanceof Anthropic.BadRequestError)) throw error;
      message = await this.client.messages.create(params);
    }
    if (message.stop_reason === 'refusal') throw new Error('anchor model declined');
    const text = textOf(message);
    return schema ? JSON.parse(text) : text;
  }

  /** Substring search terms for get_news_clusters, most distinctive first. */
  async searchTerms(headline, fallback) {
    if (!this.enabled) return fallback;
    try {
      const out = await this.complete({
        system: 'You turn a spoken news headline into search terms for a case-insensitive SUBSTRING search over news headlines.',
        prompt: `Headline: ${JSON.stringify(headline)}\n\nReturn 2-4 short terms (1-2 words each) most likely to appear verbatim in other outlets' headlines about the same event: names of people, places, organisations, or the key event noun. Prefer the forms headline writers use (e.g. "Fed", "Gaza", "Tesla"). Fix obvious speech-to-text misspellings.`,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['terms'],
          properties: { terms: { type: 'array', items: { type: 'string' } } },
        },
        maxTokens: 1000,
      });
      const terms = (out.terms ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 4);
      return terms.length ? [...new Set([...terms, ...fallback])].slice(0, 5) : fallback;
    } catch {
      return fallback;
    }
  }

  /** Does the sourced text support or contradict the headline? The quote is gated verbatim afterwards. */
  async judge(headline, evidenceText) {
    if (!this.enabled || !evidenceText) return null;
    try {
      return await this.complete({
        system: 'You compare a headline with source text. You are strict and literal.',
        prompt: `Headline: ${JSON.stringify(headline)}\n\nSource text (headlines and article text from monitored outlets):\n"""\n${evidenceText.slice(0, 12_000)}\n"""\n\nDoes the source text support the headline's central claim, contradict it, or is it insufficient to say? "contradicts" only if the source text states something incompatible with the headline (a different number, the opposite outcome, a denial of the event). Quote the deciding sentence or headline EXACTLY as it appears in the source text (copy, do not paraphrase), or null if insufficient.`,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['stance', 'quote'],
          properties: {
            stance: { type: 'string', enum: ['supports', 'contradicts', 'insufficient'] },
            quote: { type: ['string', 'null'] },
          },
        },
        maxTokens: 1500,
      });
    } catch {
      return null;
    }
  }

  async narrateGrade(result) {
    const fallback = templateGrade(result);
    if (!this.enabled) return fallback;
    try {
      return await this.complete({
        system: ANCHOR_PERSONA,
        prompt: `The audience asked you to check this headline. Here is what the desk found:\n${JSON.stringify(compactForNarration(result))}\n\nSpeak the verdict in 45 to 75 words. Walk the checks in order (who carried it, when it surfaced, whether the figures are in the sources, what money says if there is a market), then land on the verdict word exactly as given. If the verdict is Unverifiable, end on why that is the honest answer.`,
        maxTokens: 1500,
      });
    } catch {
      return fallback;
    }
  }

  async narrateRecap(stories, scope) {
    const fallback = templateRecap(stories, scope);
    if (!this.enabled) return fallback;
    try {
      return await this.complete({
        system: ANCHOR_PERSONA,
        prompt: `Open the segment with a recap of ${scope}. Stories, each with its independent publisher-family count and corroboration state:\n${JSON.stringify(stories)}\n\nWrite about 200 words (90 seconds spoken). Lead with a one-line welcome. For each story give one sentence of what happened, then tag it out loud with its count, e.g. "eleven independent newsrooms" or "one newsroom, so far". Close by inviting the audience to name a headline from the week for the desk to check.`,
        maxTokens: 2000,
      });
    } catch {
      return fallback;
    }
  }

  async narrateReveal(candidate) {
    const fallback = templateReveal(candidate);
    if (!this.enabled) return fallback;
    try {
      return await this.complete({
        system: ANCHOR_PERSONA,
        prompt: `This is the reveal. A story looked big. Here is what WorldMonitor's counts show:\n${JSON.stringify(candidate)}\n\nWrite 90 to 130 words, spoken, building to the point that the number of headlines is not the number of sources. Name the originating newsroom if the data names one. Do not invent outlets or numbers beyond the JSON. End with: "A headline in ${candidate.headlineCount ?? 'many'} places with one source is still one source."`,
        maxTokens: 2000,
      });
    } catch {
      return fallback;
    }
  }
}

function compactForNarration(r) {
  return {
    headline: r.headline,
    verdict: r.verdict?.verdict,
    reasons: r.verdict?.reasons,
    matchedHeadline: r.match?.title ?? null,
    publisherFamilies: r.who?.families ?? null,
    publishers: r.who?.publishers?.map((p) => p.name).slice(0, 6) ?? [],
    headlinesInCluster: r.who?.memberCount ?? null,
    firstSeen: r.when?.firstSeen ?? null,
    spreadHours: r.when?.spreadHours ?? null,
    attributedTo: r.when?.cascade?.origin ?? null,
    figures: r.numbers?.figures ?? [],
    markets: (r.money?.markets ?? []).slice(0, 2).map((m) => ({ title: m.title, yes: m.yesPrice, source: m.source })),
  };
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const say = (n) => (Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n));

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function templateGrade(r) {
  const v = r.verdict?.verdict ?? 'Unverifiable';
  const parts = [];
  if (!r.match && /could not reach/.test(r.verdict?.reasons?.[0] ?? '')) {
    parts.push(`The desk can't reach its sources right now, so I won't pretend to know.`);
  } else if (!r.match) {
    parts.push(`I searched every outlet WorldMonitor monitors for that headline and found no publisher carrying it.`);
  } else {
    const fam = r.who?.families;
    const lead = r.who?.publishers?.[0]?.name;
    parts.push(fam === 1
      ? `Every copy of this story traces back to one newsroom${lead ? `, ${lead}` : ''}.`
      : `${cap(say(fam ?? 0))} independent publisher families carried this story.`);
    const origin = r.when?.cascade?.origin;
    if (origin && r.when.cascade.originCount > 1 && origin !== lead) {
      parts.push(`${cap(say(r.when.cascade.originCount))} of those headlines credit the same origin: ${origin}.`);
    }
    const figures = r.numbers?.figures ?? [];
    const conflicting = figures.find((f) => !f.found && f.sourcesSay);
    const unproven = figures.find((f) => !f.found);
    if (v === 'Contradicted' && conflicting) parts.push(`The headline says ${conflicting.figure}. The sources say ${conflicting.sourcesSay}.`);
    else if (unproven) parts.push(`The figure ${unproven.figure} does not appear in the sourced text, so it is unproven.`);
    else if (figures.length) parts.push(`The figures check out against the sourced text.`);
    const m = r.money?.markets?.[0];
    if (m) parts.push(`On ${m.source ? cap(m.source) : 'prediction markets'}, money prices "${m.title}" at ${Math.round(m.yesPrice)} percent.`);
  }
  parts.push(`Verdict: ${v}.`);
  if (v === 'Unverifiable') parts.push(`That is not a dodge. It is the most honest thing a system can say.`);
  return parts.join(' ');
}

export function templateRecap(stories, scope) {
  const lines = [`Good evening. This is the Verification Desk, and here is ${scope}, with every story tagged by how many independent newsrooms actually carried it.`];
  for (const s of stories.slice(0, 6)) {
    const n = s.publishers ?? 0;
    lines.push(`${s.title}. ${n <= 1 ? 'One newsroom, so far.' : `${cap(say(n))} independent newsrooms.`}`);
  }
  lines.push('Now it is your turn. Name a headline from this week, and the desk will check it, live.');
  return lines.join(' ');
}

export function templateReveal(c) {
  return [
    `Here is a story a lot of you probably saw: "${c.title}".`,
    `WorldMonitor counted ${c.headlineCount ?? 'many'} headlines for it${c.labelCount ? ` across ${c.labelCount} feeds` : ''}.`,
    c.origin ? `Trace them back and they lead to one place: ${c.origin}.` : `Trace them back and they lead to one publisher family.`,
    `No second, independent newsroom has confirmed it in our data.`,
    `A headline in ${c.headlineCount ?? 'many'} places with one source is still one source.`,
  ].join(' ');
}
