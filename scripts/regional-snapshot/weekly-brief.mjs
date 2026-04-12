// @ts-check
// Weekly regional brief generator. Phase 3 PR2.
//
// One structured-JSON LLM call per region per week. Reads the latest
// snapshot + recent regime transitions and synthesizes a ~500-word brief.
//
// Output shape (persisted to Redis as JSON):
//
//   { region_id, generated_at, period_start, period_end,
//     situation_recap, regime_trajectory, key_developments: string[],
//     risk_outlook, provider, model }
//
// Same provider chain + injectable-callLlm pattern as narrative.mjs.

import { extractFirstJsonObject, cleanJsonText } from '../_llm-json.mjs';

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BRIEF_MAX_TOKENS = 1200;
const BRIEF_TEMPERATURE = 0.3;
const MAX_TRANSITIONS_IN_PROMPT = 10;
const MAX_KEY_DEVELOPMENTS = 5;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_PROVIDERS = [
  {
    name: 'groq',
    envKey: 'GROQ_API_KEY',
    apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    timeout: 25_000,
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
    timeout: 35_000,
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
 * Canonical empty brief. Matches the persisted shape.
 * @param {string} regionId
 * @returns {object}
 */
export function emptyBrief(regionId) {
  return {
    region_id: regionId,
    generated_at: 0,
    period_start: 0,
    period_end: 0,
    situation_recap: '',
    regime_trajectory: '',
    key_developments: [],
    risk_outlook: '',
    provider: '',
    model: '',
  };
}

/**
 * Build the prompt for the weekly brief. Pure.
 *
 * @param {{id: string, label: string}} region
 * @param {object} snapshot - latest RegionalSnapshot
 * @param {object[]} transitions - regime history entries (newest first)
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function buildBriefPrompt(region, snapshot, transitions) {
  const balance = snapshot?.balance ?? {};
  const balanceLine = [
    `coercive=${num(balance.coercive_pressure)}`,
    `fragility=${num(balance.domestic_fragility)}`,
    `capital=${num(balance.capital_stress)}`,
    `energy_vuln=${num(balance.energy_vulnerability)}`,
    `alliance=${num(balance.alliance_cohesion)}`,
    `maritime=${num(balance.maritime_access)}`,
    `energy_lev=${num(balance.energy_leverage)}`,
    `net=${num(balance.net_balance)}`,
  ].join(' ');

  const regimeLabel = snapshot?.regime?.label ?? 'unknown';
  const activeTriggers = (snapshot?.triggers?.active ?? [])
    .map((t) => t.id || t.description)
    .filter(Boolean)
    .join(', ');

  const transitionLines = (transitions ?? [])
    .slice(0, MAX_TRANSITIONS_IN_PROMPT)
    .map((t) => {
      const date = t.transitioned_at
        ? new Date(t.transitioned_at).toISOString().split('T')[0]
        : '?';
      return `- ${date}: ${t.previous_label || 'none'} → ${t.label}${t.transition_driver ? ` (${t.transition_driver})` : ''}`;
    });
  const transitionBlock = transitionLines.length > 0
    ? transitionLines.join('\n')
    : '(no regime transitions in the past 7 days)';

  const narrativeSituation = snapshot?.narrative?.situation?.text ?? '';
  const narrativeOutlook7d = snapshot?.narrative?.outlook_7d?.text ?? '';

  const systemPrompt = [
    `You are a senior geopolitical analyst producing a weekly intelligence brief.`,
    `Today is ${new Date().toISOString().split('T')[0]}.`,
    ``,
    `HARD RULES:`,
    `- Output ONLY a single JSON object matching the schema below.`,
    `- situation_recap: 2-3 sentences summarizing the week's developments.`,
    `- regime_trajectory: 1 sentence describing how the regime label evolved (stable, shifted, oscillated).`,
    `- key_developments: up to ${MAX_KEY_DEVELOPMENTS} bullet strings, each under 100 chars. Most impactful first.`,
    `- risk_outlook: 1-2 sentences on what to watch in the coming week.`,
    `- Neutral, analytical tone. No dramatization, no policy prescriptions.`,
    `- Ground claims in the data provided. Do not speculate beyond it.`,
    ``,
    `SCHEMA:`,
    `{`,
    `  "situation_recap": "...",`,
    `  "regime_trajectory": "...",`,
    `  "key_developments": ["...", "..."],`,
    `  "risk_outlook": "..."`,
    `}`,
  ].join('\n');

  const userPrompt = [
    `REGION: ${region.label} (${region.id})`,
    ``,
    `CURRENT REGIME: ${regimeLabel}`,
    `BALANCE: ${balanceLine}`,
    `ACTIVE TRIGGERS: ${activeTriggers || '(none)'}`,
    ``,
    `REGIME TRANSITIONS (last 7 days):`,
    transitionBlock,
    ``,
    narrativeSituation ? `LATEST SITUATION NARRATIVE: ${narrativeSituation}` : '',
    narrativeOutlook7d ? `LATEST 7d OUTLOOK: ${narrativeOutlook7d}` : '',
    ``,
    `Produce the JSON object now.`,
  ].filter(Boolean).join('\n');

  return { systemPrompt, userPrompt };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

/**
 * Parse the LLM JSON response into the brief fields.
 *
 * @param {string} text
 * @returns {{ brief: { situation_recap: string, regime_trajectory: string, key_developments: string[], risk_outlook: string }, valid: boolean }}
 */
export function parseBriefJson(text) {
  const empty = { situation_recap: '', regime_trajectory: '', key_developments: [], risk_outlook: '' };
  if (!text || typeof text !== 'string') return { brief: empty, valid: false };

  let parsed;
  try {
    parsed = JSON.parse(cleanJsonText(text));
  } catch {
    const extracted = extractFirstJsonObject(text);
    if (!extracted) return { brief: empty, valid: false };
    try {
      parsed = JSON.parse(extracted);
    } catch {
      return { brief: empty, valid: false };
    }
  }

  if (!parsed || typeof parsed !== 'object') return { brief: empty, valid: false };

  const p = /** @type {Record<string, unknown>} */ (parsed);
  const situation_recap = typeof p.situation_recap === 'string' ? p.situation_recap.trim() : '';
  const regime_trajectory = typeof p.regime_trajectory === 'string' ? p.regime_trajectory.trim() : '';
  const key_developments = Array.isArray(p.key_developments)
    ? p.key_developments.filter((d) => typeof d === 'string' && d.trim().length > 0).slice(0, MAX_KEY_DEVELOPMENTS).map((d) => String(d).trim())
    : [];
  const risk_outlook = typeof p.risk_outlook === 'string' ? p.risk_outlook.trim() : '';

  // Require situation_recap to be non-empty — this aligns with the seeder's
  // gate (which checks brief.situation_recap before writing). Without this,
  // a brief with only key_developments would pass parseBriefJson but be
  // silently dropped by the seeder, creating a mismatch. PR #2989 review.
  const valid = situation_recap.length > 0;
  return {
    brief: { situation_recap, regime_trajectory, key_developments, risk_outlook },
    valid,
  };
}

/**
 * Default provider-chain caller. Same pattern as narrative.mjs.
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
          max_tokens: BRIEF_MAX_TOKENS,
          temperature: BRIEF_TEMPERATURE,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(provider.timeout),
      });
      if (!resp.ok) {
        console.warn(`[weekly-brief] ${provider.name}: HTTP ${resp.status}`);
        continue;
      }
      const json = /** @type {any} */ (await resp.json());
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.trim().length === 0) {
        console.warn(`[weekly-brief] ${provider.name}: empty response`);
        continue;
      }
      const trimmed = text.trim();
      if (validate && !validate(trimmed)) {
        console.warn(`[weekly-brief] ${provider.name}: response failed validation, trying next`);
        continue;
      }
      const actualModel = typeof json?.model === 'string' && json.model.length > 0
        ? json.model
        : provider.model;
      return { text: trimmed, provider: provider.name, model: actualModel };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[weekly-brief] ${provider.name}: ${msg}`);
    }
  }
  return null;
}

/**
 * Generate a weekly brief for one region.
 *
 * @param {{id: string, label: string}} region
 * @param {object} snapshot - latest RegionalSnapshot (snake_case persisted shape)
 * @param {object[]} transitions - recent regime history entries (newest first)
 * @param {{ callLlm?: (prompt: { systemPrompt: string, userPrompt: string }, opts?: { validate?: (text: string) => boolean }) => Promise<{ text: string, provider: string, model: string } | null> }} [opts]
 * @returns {Promise<object>} The brief object ready for Redis persist.
 */
export async function generateWeeklyBrief(region, snapshot, transitions, opts = {}) {
  if (!region || region.id === 'global') {
    return emptyBrief(region?.id ?? 'global');
  }

  const callLlm = opts.callLlm ?? callLlmDefault;
  const prompt = buildBriefPrompt(region, snapshot, transitions);
  const validate = (text) => parseBriefJson(text).valid;

  let result;
  try {
    result = await callLlm(prompt, { validate });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[weekly-brief] ${region.id}: callLlm threw: ${msg}`);
    return emptyBrief(region.id);
  }

  if (!result) {
    console.warn(`[weekly-brief] ${region.id}: all providers failed, shipping empty brief`);
    return emptyBrief(region.id);
  }

  const { brief, valid } = parseBriefJson(result.text);
  if (!valid) {
    console.warn(`[weekly-brief] ${region.id}: parse invalid, shipping empty brief`);
    return emptyBrief(region.id);
  }

  const now = Date.now();
  return {
    region_id: region.id,
    generated_at: now,
    period_start: now - SEVEN_DAYS_MS,
    period_end: now,
    ...brief,
    provider: result.provider,
    model: result.model,
  };
}
