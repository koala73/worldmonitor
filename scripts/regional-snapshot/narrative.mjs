// @ts-check
// Regional Intelligence narrative generator. Evidence-grounded LLM synthesis
// over a deterministic RegionalSnapshot. One call per region per 6h cycle.
//
// Phase 1 PR2 — fills in the `narrative` field that Phase 0 left as empty
// stubs, and populates SnapshotMeta.narrative_provider/narrative_model.
//
// Design notes:
//   - Single structured-JSON call per region (cheaper + better coherence
//     than 6 per-section calls). Parsed into 6 sections + watch_items[].
//   - Skips the 'global' region entirely (too broad to be useful).
//   - Ship-empty on any LLM failure: the snapshot is still valuable without
//     the narrative, and the diff engine surfaces state changes regardless.
//   - Evidence-grounded: each section's evidence_ids MUST be a subset of
//     the evidence IDs already computed by collectEvidence(). Unknown IDs
//     are silently filtered so a halluci­nated ID never leaks through.
//   - Provider chain mirrors seed-insights.mjs / seed-forecasts.mjs:
//     Groq → OpenRouter (Gemini Flash). Ollama skipped: the narrative call
//     runs on Railway which has no local model.
//   - `callLlm` is dependency-injected so unit tests can exercise the full
//     prompt + parser without network.

import { extractFirstJsonObject, cleanJsonText } from '../_llm-json.mjs';

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const NARRATIVE_MAX_TOKENS = 900;
const NARRATIVE_TEMPERATURE = 0.3;
const MAX_ACTORS_IN_PROMPT = 5;
const MAX_EVIDENCE_IN_PROMPT = 15;
const MAX_TRANSMISSIONS_IN_PROMPT = 5;
const MAX_WATCH_ITEMS = 3;

/**
 * Provider chain. Order matters: first provider with a configured env var wins.
 */
const DEFAULT_PROVIDERS = [
  {
    name: 'groq',
    envKey: 'GROQ_API_KEY',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    timeout: 20_000,
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': CHROME_UA,
    }),
  },
  {
    name: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    apiUrl: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'google/gemini-2.5-flash',
    timeout: 30_000,
    headers: (key) => ({
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://worldmonitor.app',
      'X-Title': 'World Monitor',
      'User-Agent': CHROME_UA,
    }),
  },
];

/**
 * Canonical empty narrative. Matches RegionalNarrative shape.
 * @returns {import('../../shared/regions.types.js').RegionalNarrative}
 */
export function emptyNarrative() {
  return {
    situation: { text: '', evidence_ids: [] },
    balance_assessment: { text: '', evidence_ids: [] },
    outlook_24h: { text: '', evidence_ids: [] },
    outlook_7d: { text: '', evidence_ids: [] },
    outlook_30d: { text: '', evidence_ids: [] },
    watch_items: [],
  };
}

/**
 * Return the evidence subset that is actually rendered into the prompt.
 * Callers should use this same subset when deriving the valid-evidence-ID
 * whitelist for parseNarrativeJson — otherwise the parser could accept
 * citations to IDs the model never saw (P2 review finding on #2960).
 *
 * @param {import('../../shared/regions.types.js').EvidenceItem[]} evidence
 * @returns {import('../../shared/regions.types.js').EvidenceItem[]}
 */
export function selectPromptEvidence(evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.slice(0, MAX_EVIDENCE_IN_PROMPT);
}

/**
 * Build the evidence-grounded prompt. Pure — no network.
 *
 * `evidence` is rendered as-is. Callers that want the prompt-visible
 * cap should call `selectPromptEvidence()` first so the same subset
 * flows into both the prompt and the parser's evidence whitelist.
 *
 * @param {{id: string, label: string, forecastLabel: string}} region
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} snapshot
 * @param {import('../../shared/regions.types.js').EvidenceItem[]} evidence
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildNarrativePrompt(region, snapshot, evidence) {
  const topActors = (snapshot.actors ?? [])
    .slice(0, MAX_ACTORS_IN_PROMPT)
    .map((a) => `${a.name} (${a.role}, leverage=${a.leverage_score.toFixed(2)})`)
    .join(', ');

  const horizonSummary = (snapshot.scenario_sets ?? [])
    .map((set) => {
      const dominant = [...(set.lanes ?? [])].sort((a, b) => b.probability - a.probability)[0];
      return dominant
        ? `${set.horizon}: ${dominant.name} (${Math.round(dominant.probability * 100)}%)`
        : `${set.horizon}: (no lanes)`;
    })
    .join(' | ');

  const topTransmissions = (snapshot.transmission_paths ?? [])
    .slice(0, MAX_TRANSMISSIONS_IN_PROMPT)
    .map((t) => `${t.mechanism} via ${t.corridor_id || t.start} (conf=${t.confidence.toFixed(2)})`)
    .join('; ');

  const activeTriggers = (snapshot.triggers?.active ?? [])
    .map((t) => t.id)
    .join(', ');

  const evidenceLines = (evidence ?? []).map((e) => {
    const summary = (e.summary ?? '').slice(0, 180);
    const conf = typeof e.confidence === 'number' ? e.confidence.toFixed(2) : '0.00';
    return `- ${e.id} [${e.type}, conf=${conf}]: ${summary}`;
  });
  const evidenceBlock = evidenceLines.length > 0
    ? evidenceLines.join('\n')
    : '(no evidence available — reason over the balance vector alone)';

  const balance = snapshot.balance;
  const balanceLine = [
    `coercive=${balance.coercive_pressure.toFixed(2)}`,
    `fragility=${balance.domestic_fragility.toFixed(2)}`,
    `capital=${balance.capital_stress.toFixed(2)}`,
    `energy_vuln=${balance.energy_vulnerability.toFixed(2)}`,
    `alliance=${balance.alliance_cohesion.toFixed(2)}`,
    `maritime=${balance.maritime_access.toFixed(2)}`,
    `energy_lev=${balance.energy_leverage.toFixed(2)}`,
    `net=${balance.net_balance.toFixed(2)}`,
  ].join(' ');

  const systemPrompt = [
    `You are a senior geopolitical analyst producing a regional intelligence brief.`,
    `Today is ${new Date().toISOString().split('T')[0]}.`,
    ``,
    `HARD RULES:`,
    `- Output ONLY a single JSON object matching the schema below. No prose, no markdown, no code fences.`,
    `- Each text field: 1–2 concise sentences, under 280 characters, no bullet points.`,
    `- Every evidence_ids entry MUST be one of the IDs listed in the EVIDENCE block. Never invent IDs.`,
    `- Ground claims in the evidence and the balance vector. Do not speculate beyond them.`,
    `- Use present tense for situation/balance_assessment. Use hedged language for outlooks.`,
    `- Neutral, analytical tone. No dramatization, no policy prescriptions.`,
    ``,
    `SCHEMA:`,
    `{`,
    `  "situation": { "text": "...", "evidence_ids": ["..."] },`,
    `  "balance_assessment": { "text": "...", "evidence_ids": ["..."] },`,
    `  "outlook_24h": { "text": "...", "evidence_ids": ["..."] },`,
    `  "outlook_7d": { "text": "...", "evidence_ids": ["..."] },`,
    `  "outlook_30d": { "text": "...", "evidence_ids": ["..."] },`,
    `  "watch_items": [ { "text": "...", "evidence_ids": ["..."] } ]`,
    `}`,
    ``,
    `watch_items: up to ${MAX_WATCH_ITEMS} specific indicators the analyst should monitor.`,
  ].join('\n');

  const userPrompt = [
    `REGION: ${region.label} (${region.id})`,
    ``,
    `REGIME: ${snapshot.regime?.label ?? 'unknown'}`,
    `BALANCE: ${balanceLine}`,
    `TOP ACTORS: ${topActors || '(none)'}`,
    `SCENARIO LEADS: ${horizonSummary || '(none)'}`,
    `TOP TRANSMISSIONS: ${topTransmissions || '(none)'}`,
    `ACTIVE TRIGGERS: ${activeTriggers || '(none)'}`,
    ``,
    `EVIDENCE:`,
    evidenceBlock,
    ``,
    `Produce the JSON object now.`,
  ].join('\n');

  return { systemPrompt, userPrompt };
}

/**
 * Validate + coerce a single NarrativeSection from raw parsed JSON.
 *
 * @param {unknown} raw
 * @param {Set<string>} validEvidenceIds
 * @returns {import('../../shared/regions.types.js').NarrativeSection}
 */
function coerceSection(raw, validEvidenceIds) {
  if (!raw || typeof raw !== 'object') return { text: '', evidence_ids: [] };
  const r = /** @type {Record<string, unknown>} */ (raw);
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  const evidenceIds = Array.isArray(r.evidence_ids)
    ? r.evidence_ids
        .filter((id) => typeof id === 'string' && validEvidenceIds.has(id))
    : [];
  return { text, evidence_ids: evidenceIds };
}

/**
 * Parse the LLM JSON response into a RegionalNarrative. Filters any
 * hallucinated evidence IDs against the set the caller provided.
 * Returns { narrative, valid: false } on unparseable input so the caller
 * can ship an empty narrative instead.
 *
 * @param {string} text
 * @param {string[]} validEvidenceIds
 * @returns {{ narrative: import('../../shared/regions.types.js').RegionalNarrative, valid: boolean }}
 */
export function parseNarrativeJson(text, validEvidenceIds) {
  const validSet = new Set(validEvidenceIds);
  if (!text || typeof text !== 'string') {
    return { narrative: emptyNarrative(), valid: false };
  }

  let parsed;
  try {
    // Try direct parse first (LLM output is often wrapped in fences).
    parsed = JSON.parse(cleanJsonText(text));
  } catch {
    const extracted = extractFirstJsonObject(text);
    if (!extracted) return { narrative: emptyNarrative(), valid: false };
    try {
      parsed = JSON.parse(extracted);
    } catch {
      return { narrative: emptyNarrative(), valid: false };
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { narrative: emptyNarrative(), valid: false };
  }

  const p = /** @type {Record<string, unknown>} */ (parsed);
  const watch = Array.isArray(p.watch_items)
    ? p.watch_items.slice(0, MAX_WATCH_ITEMS).map((w) => coerceSection(w, validSet))
    : [];

  const narrative = {
    situation: coerceSection(p.situation, validSet),
    balance_assessment: coerceSection(p.balance_assessment, validSet),
    outlook_24h: coerceSection(p.outlook_24h, validSet),
    outlook_7d: coerceSection(p.outlook_7d, validSet),
    outlook_30d: coerceSection(p.outlook_30d, validSet),
    watch_items: watch,
  };

  // Require at least one non-empty section to count as valid. Everything
  // else being empty suggests a garbage LLM response we should discard.
  const hasAnyText =
    narrative.situation.text.length > 0 ||
    narrative.balance_assessment.text.length > 0 ||
    narrative.outlook_24h.text.length > 0 ||
    narrative.outlook_7d.text.length > 0 ||
    narrative.outlook_30d.text.length > 0 ||
    narrative.watch_items.some((w) => w.text.length > 0);

  return { narrative, valid: hasAnyText };
}

/**
 * Real provider-chain caller. Walks DEFAULT_PROVIDERS in order, returning
 * the first response that passes the optional `validate` predicate.
 * Respects per-provider env gating and timeout.
 *
 * Callers should pass a `validate` that checks whether the text parses to
 * a usable output. Without it, a single provider returning prose or
 * truncated JSON would short-circuit the fallback chain — which was the
 * P2 finding on #2960.
 *
 * The returned `model` field reflects what the API actually ran
 * (`json.model`), falling back to the provider's declared default. Some
 * providers resolve aliases or route to a different concrete model, and
 * persisted metadata should report the truth.
 *
 * @param {{ systemPrompt: string, userPrompt: string }} prompt
 * @param {{ validate?: (text: string) => boolean }} [opts]
 * @returns {Promise<{ text: string, provider: string, model: string } | null>}
 */
async function callLlmDefault({ systemPrompt, userPrompt }, opts = {}) {
  const validate = opts.validate;
  for (const provider of DEFAULT_PROVIDERS) {
    const envVal = process.env[provider.envKey];
    if (!envVal) continue;
    try {
      const resp = await fetch(provider.apiUrl, {
        method: 'POST',
        headers: provider.headers(envVal),
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: NARRATIVE_MAX_TOKENS,
          temperature: NARRATIVE_TEMPERATURE,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(provider.timeout),
      });

      if (!resp.ok) {
        console.warn(`[narrative] ${provider.name}: HTTP ${resp.status}`);
        continue;
      }

      const json = /** @type {any} */ (await resp.json());
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.trim().length === 0) {
        console.warn(`[narrative] ${provider.name}: empty response`);
        continue;
      }

      const trimmed = text.trim();
      if (validate && !validate(trimmed)) {
        console.warn(`[narrative] ${provider.name}: response failed validation, trying next provider`);
        continue;
      }

      // Prefer the model the provider actually ran over the requested alias.
      const actualModel = typeof json?.model === 'string' && json.model.length > 0
        ? json.model
        : provider.model;

      return { text: trimmed, provider: provider.name, model: actualModel };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[narrative] ${provider.name}: ${msg}`);
    }
  }
  return null;
}

/**
 * Main entry: generate a narrative for one region. Ship-empty on any failure.
 *
 * Evidence is capped to `MAX_EVIDENCE_IN_PROMPT` BEFORE prompt construction,
 * and the same cap bounds the parser's valid-evidence-ID whitelist, so
 * citations can only reference items the model actually saw.
 *
 * The injected `callLlm` receives a `validate` callback that runs
 * `parseNarrativeJson` on each provider's response; providers returning
 * prose, truncated JSON, or all-empty objects fall through to the next
 * provider instead of short-circuiting the whole chain.
 *
 * @param {{ id: string, label: string, forecastLabel: string }} region
 * @param {import('../../shared/regions.types.js').RegionalSnapshot} snapshot
 * @param {import('../../shared/regions.types.js').EvidenceItem[]} evidence
 * @param {{ callLlm?: (prompt: { systemPrompt: string, userPrompt: string }, opts?: { validate?: (text: string) => boolean }) => Promise<{ text: string, provider: string, model: string } | null> }} [opts]
 * @returns {Promise<{
 *   narrative: import('../../shared/regions.types.js').RegionalNarrative,
 *   provider: string,
 *   model: string,
 * }>}
 */
export async function generateRegionalNarrative(region, snapshot, evidence, opts = {}) {
  // Global region is a catch-all; narratives aren't meaningful there.
  if (region.id === 'global') {
    return { narrative: emptyNarrative(), provider: '', model: '' };
  }

  const callLlm = opts.callLlm ?? callLlmDefault;
  // Slice evidence once so the prompt and the parser's whitelist agree on
  // exactly which IDs are citable. See selectPromptEvidence docstring.
  const promptEvidence = selectPromptEvidence(evidence);
  const prompt = buildNarrativePrompt(region, snapshot, promptEvidence);
  const validEvidenceIds = promptEvidence.map((e) => e.id);

  // Validator for the default provider-chain caller: a response is
  // acceptable iff parseNarrativeJson returns valid=true against the
  // prompt-visible evidence set.
  const validate = (text) => parseNarrativeJson(text, validEvidenceIds).valid;

  let result;
  try {
    result = await callLlm(prompt, { validate });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[narrative] ${region.id}: callLlm threw: ${msg}`);
    return { narrative: emptyNarrative(), provider: '', model: '' };
  }

  if (!result) {
    console.warn(`[narrative] ${region.id}: all providers failed, shipping empty narrative`);
    return { narrative: emptyNarrative(), provider: '', model: '' };
  }

  const { narrative, valid } = parseNarrativeJson(result.text, validEvidenceIds);
  if (!valid) {
    console.warn(`[narrative] ${region.id}: JSON parse invalid, shipping empty narrative`);
    return { narrative: emptyNarrative(), provider: '', model: '' };
  }

  return { narrative, provider: result.provider, model: result.model };
}
