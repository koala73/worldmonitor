// The anchor's voice. Claude turns WorldMonitor's findings into speech and
// pulls search terms out of a shouted headline. It never judges: every
// judgment on the card is WorldMonitor's (lib/wm.mjs). Before a generated
// script is spoken it must pass the same hallucination validators
// WorldMonitor runs on its own AI briefs; if it fails, or there is no API
// key, the anchor reads a template built only from WorldMonitor's data.

import Anthropic from '@anthropic-ai/sdk';
import { validateScript, WM_TEXT } from './wm.mjs';

const DEFAULT_MODEL = 'claude-opus-5-5';

const ANCHOR_PERSONA = `You are the anchor of "The Verification Desk", a live segment on a conference stage, powered by WorldMonitor.
You speak to a room, so write for the ear: short sentences, no lists, no markdown, no URLs, no emoji.
You only state facts present in the JSON you are given, using WorldMonitor's own terms: publishers (several feeds or editions of one newsroom are one publisher), source tiers (${[1, 2, 3, 4].map((t) => WM_TEXT[`tierTitle${t}`]).join('; ')}), propaganda risk, state affiliation, and WorldMonitor's credibility score out of 100.
You never say a claim is true or false. WorldMonitor's rule: tiers rank sources; they do not judge the claim, and coverage is not accuracy.
"Not in WorldMonitor's sources" and "Unverifiable" are honest answers; say them plainly and without apology.
Do not introduce any name, title or number that is not in the JSON.`;

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

  /** Generated text is spoken only if WorldMonitor's brief validators find nothing invented. */
  async grounded(prompt, facts, fallback, maxTokens = 1500) {
    if (!this.enabled) return fallback;
    try {
      const text = await this.complete({ system: ANCHOR_PERSONA, prompt, maxTokens });
      const check = validateScript(text, `${JSON.stringify(facts)}\n${FIXED_GROUND}`);
      if (!check.ok) {
        console.warn(`[anchor] generated script failed WorldMonitor's grounding validators (${check.hallucinated.join(', ')}); using template`);
        return fallback;
      }
      return text;
    } catch {
      return fallback;
    }
  }

  narrateGrade(result) {
    const facts = compactForNarration(result);
    return this.grounded(
      `The audience asked you to check this headline. Here is what WorldMonitor found:\n${JSON.stringify(facts)}\n\nSpeak it in 45 to 75 words, in order: who carried it (WorldMonitor's publisher count and the best-rated sources with their tier, propaganda risk and any state affiliation), WorldMonitor's credibility score, whether the headline's figures are grounded in the sources, what money says if there is a market, then the verdict exactly as given, followed by WorldMonitor's caveat that this describes coverage, not accuracy.`,
      facts,
      templateGrade(result),
    );
  }

  narrateRecap(stories, scope) {
    return this.grounded(
      `Open the segment with a recap of ${scope}. Each story carries WorldMonitor's coverage state, publisher count and credibility score:\n${JSON.stringify(stories)}\n\nWrite about 200 words (90 seconds spoken). Lead with a one-line welcome. For each story say the headline in your own words, then tag it out loud with WorldMonitor's numbers, e.g. "six publishers, credibility seventy-nine" or "one publisher so far". Close by inviting the audience to name a headline from the week for the desk to check.`,
      { scope, stories },
      templateRecap(stories, scope),
      2000,
    );
  }

  narrateReveal(candidate) {
    return this.grounded(
      `This is the reveal. A story looked big. Here is what WorldMonitor counts:\n${JSON.stringify(candidate)}\n\nWrite 90 to 130 words, spoken, building to the point that the number of headlines is not the number of publishers. Name the origin if the data names one. End with: "A headline in ${candidate.headlineCount ?? 'many'} places with one source is still one source."`,
      candidate,
      templateReveal(candidate),
      2000,
    );
  }
}

// Words the persona itself may always use without the validators objecting.
const FIXED_GROUND = 'WorldMonitor World Monitor Verification Desk Polymarket Kalshi Corroborated Unverifiable Single publisher Low-tier sources only';

function compactForNarration(r) {
  return {
    headline: r.headline,
    verdict: r.verdict?.word,
    caveat: r.verdict?.hint,
    reasons: r.verdict?.reasons,
    matchedHeadline: r.match?.title ?? null,
    publishers: r.who?.coverage?.publishers ?? null,
    rosterSummary: r.who?.summary ?? null,
    sources: (r.who?.rated ?? []).slice(0, 5).map((p) => ({ name: p.name, tier: p.tier, tierTitle: p.tierTitle, credibility: p.credibility, propagandaRisk: p.risk, stateAffiliated: p.stateAffiliated })),
    credibility: r.who?.credibility ?? null,
    firstSeen: r.when?.firstSeen ?? null,
    spreadHours: r.when?.spreadHours ?? null,
    figures: (r.numbers?.facts ?? []).map((f) => ({ figure: f.label, grounded: f.grounded, statedBy: f.statedBy })),
    markets: (r.money?.markets ?? []).slice(0, 2).map((m) => ({ title: m.title, yes: Math.round(m.yesPrice), source: m.source })),
  };
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const say = (n) => (Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const TIER_WORDS = { 1: 'a wire service or official body', 2: 'a major outlet', 3: 'a specialist or regional source', 4: 'an aggregator or blog' };

function describeSource(x) {
  const bits = [x.tier ? `tier ${x.tier}, ${TIER_WORDS[x.tier]}` : 'a tier WorldMonitor has not declared'];
  if (x.stateAffiliated) bits.push(`state-affiliated, ${x.stateAffiliated}`);
  else if (x.risk && x.risk !== 'unknown') bits.push(`${x.risk} propaganda risk`);
  return `${x.name}: ${bits.join('; ')}`;
}

export function templateGrade(r) {
  const v = r.verdict;
  const parts = [];
  if (v?.key === 'unreachable') {
    parts.push(`The desk can't reach WorldMonitor right now, so I won't pretend to know.`);
  } else if (v?.key === 'not-found') {
    parts.push(`No publisher WorldMonitor monitors carried that headline.`);
  } else {
    const who = r.who;
    if (who?.summary) parts.push(`${who.summary}.`);
    for (const x of (who?.rated ?? []).slice(0, 2)) parts.push(`${describeSource(x)}.`);
    if (who?.credibility) parts.push(`WorldMonitor's credibility score: ${who.credibility.score} out of 100, ${who.credibility.band}.`);
    for (const f of r.numbers?.facts ?? []) {
      if (!f.grounded) parts.push(`The figure ${f.label} is not in any source, so it is not grounded.`);
      else if (f.statedBy?.length === 1) parts.push(`The figure ${f.label} comes from one publisher only: ${f.statedBy[0]}.`);
    }
    const m = r.money?.markets?.[0];
    if (m) parts.push(`On ${m.source ? cap(m.source) : 'prediction markets'}, money prices "${m.title}" at ${Math.round(m.yesPrice)} percent.`);
  }
  parts.push(`Verdict: ${v?.word ?? 'Unverifiable'}.`);
  if (v?.key === 'not-found' || v?.key === 'unknown') parts.push(`That is not a dodge. It is the most honest thing a system can say.`);
  else if (v?.key !== 'unreachable') parts.push(`As WorldMonitor puts it, this describes coverage, not accuracy.`);
  return parts.join(' ');
}

export function templateRecap(stories, scope) {
  const lines = [`Good evening. This is the Verification Desk, and here is ${scope}, with every story graded by WorldMonitor.`];
  for (const s of stories.slice(0, 6)) {
    const n = s.publishers ?? 0;
    const cred = s.credibility != null ? `, credibility ${s.credibility}` : '';
    lines.push(`${s.title}. ${n <= 1 ? `One publisher so far${cred}.` : `${cap(say(n))} publishers${cred}.`}`);
  }
  lines.push('Now it is your turn. Name a headline from this week, and the desk will check it, live.');
  return lines.join(' ');
}

export function templateReveal(c) {
  return [
    `Here is a story a lot of you probably saw: "${c.title}".`,
    `It ran in ${c.headlineCount ?? 'many'} places.`,
    c.origin ? `WorldMonitor traces every one of them to one publisher: ${c.origin}.` : `WorldMonitor traces every one of them to one publisher.`,
    `A headline in ${c.headlineCount ?? 'many'} places with one source is still one source.`,
  ].join(' ');
}
