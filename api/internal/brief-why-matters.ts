/**
 * Internal endpoint — enriches a brief story's `whyMatters` field with
 * live analyst context + LLM.
 *
 * POST /api/internal/brief-why-matters
 *
 * Internal-only. Auth via `Authorization: Bearer $RELAY_SHARED_SECRET`
 * (same secret Railway crons already use). Not Pro-gated, no CORS.
 *
 * Body:
 *   {
 *     story: {
 *       headline:    string, 1..400
 *       source:      string, 1..120
 *       threatLevel: 'critical' | 'high' | 'medium' | 'low'
 *       category:    string, 1..80  (free-form)
 *       country:     string, 0..80  (full name, ISO2, 'Global', or empty)
 *     }
 *   }
 *
 * Response (200):
 *   {
 *     whyMatters: string | null
 *     source:     'cache' | 'analyst' | 'gemini'
 *     producedBy: 'analyst' | 'gemini' | null
 *     shadow?:    { analyst: string | null, gemini: string | null }
 *   }
 *
 * 400 on invalid body, 401 on bad auth, 500 on unexpected.
 *
 * Architecture note: this endpoint calls an LLM from Vercel edge, which
 * is consistent with /api/chat-analyst (both are analyst flows). The
 * "Vercel reads only" convention from memory is for data-seeder flows
 * and does not apply here.
 */

export const config = { runtime: 'edge' };

import { authenticateInternalRequest } from '../../server/_shared/internal-auth';
import { normalizeCountryToIso2 } from '../../server/_shared/country-normalize';
import { assembleBriefStoryContext } from '../../server/worldmonitor/intelligence/v1/brief-story-context';
import {
  buildAnalystWhyMattersPrompt,
  sanitizeStoryFields,
} from '../../server/worldmonitor/intelligence/v1/brief-why-matters-prompt';
import { callLlmReasoning } from '../../server/_shared/llm';
// @ts-expect-error — JS module, no declaration file
import { readRawJsonFromUpstash, setCachedData, redisPipeline } from '../_upstash-json.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from '../_sentry-edge.js';
import {
  buildWhyMattersUserPrompt,
  hashBriefStory,
  parseWhyMatters,
  parseWhyMattersV2,
} from '../../shared/brief-llm-core.js';

// ── Env knobs (read at request entry so Railway/Vercel flips take effect
// on the next invocation without a redeploy) ───────────────────────────

function readConfig(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): {
  primary: 'analyst' | 'gemini';
  invalidPrimaryRaw: string | null;
  shadowEnabled: boolean;
  sampleHardRoll: (hash16: string) => boolean;
  invalidSamplePctRaw: string | null;
} {
  // PRIMARY: default 'analyst'. Unknown value → 'gemini' (stable path) + warn.
  const rawPrimary = (env.BRIEF_WHY_MATTERS_PRIMARY ?? '').trim().toLowerCase();
  let primary: 'analyst' | 'gemini';
  let invalidPrimaryRaw: string | null = null;
  if (rawPrimary === '' || rawPrimary === 'analyst') {
    primary = 'analyst';
  } else if (rawPrimary === 'gemini') {
    primary = 'gemini';
  } else {
    primary = 'gemini';
    invalidPrimaryRaw = rawPrimary;
  }

  // SHADOW: default-on kill switch. Only exactly '0' disables.
  const shadowEnabled = env.BRIEF_WHY_MATTERS_SHADOW !== '0';

  // SAMPLE_PCT: default 100. Invalid/out-of-range → 100 + warn.
  const rawSample = env.BRIEF_WHY_MATTERS_SHADOW_SAMPLE_PCT;
  let samplePct = 100;
  let invalidSamplePctRaw: string | null = null;
  if (rawSample !== undefined && rawSample !== '') {
    const parsed = Number.parseInt(rawSample, 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 && String(parsed) === rawSample.trim()) {
      samplePct = parsed;
    } else {
      invalidSamplePctRaw = rawSample;
    }
  }

  // Deterministic per-hash sampling so the same story takes the same
  // decision across retries inside a rollout window.
  const sampleHardRoll = (hash16: string): boolean => {
    if (samplePct >= 100) return true;
    if (samplePct <= 0) return false;
    const bucket = Number.parseInt(hash16.slice(0, 8), 16) % 100;
    return bucket < samplePct;
  };

  return { primary, invalidPrimaryRaw, shadowEnabled, sampleHardRoll, invalidSamplePctRaw };
}

// ── TTLs ──────────────────────────────────────────────────────────────
const WHY_MATTERS_TTL_SEC = 6 * 60 * 60; // 6h
const SHADOW_TTL_SEC = 7 * 24 * 60 * 60; // 7d

// ── Validation ────────────────────────────────────────────────────────
const VALID_THREAT_LEVELS = new Set(['critical', 'high', 'medium', 'low']);
// Bumped body cap to 8 KB: v2 optionally carries `story.description`
// (up to 1000 chars) in addition to the other fields, which can push
// worst-case payloads past the old 4 KB cap under UTF-8 expansion.
const MAX_BODY_BYTES = 8192;
const CAPS = {
  headline: 400,
  source: 120,
  category: 80,
  country: 80,
  description: 1000,
};

interface StoryPayload {
  headline: string;
  source: string;
  threatLevel: string;
  category: string;
  country: string;
  /** Optional — gives the LLM a sentence of story context beyond the headline. */
  description?: string;
}

type ValidationOk = { ok: true; story: StoryPayload };
type ValidationErr = { ok: false; status: number; error: string };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function validateStoryBody(raw: unknown): ValidationOk | ValidationErr {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, status: 400, error: 'body must be an object' };
  }
  const storyRaw = (raw as { story?: unknown }).story;
  if (!storyRaw || typeof storyRaw !== 'object') {
    return { ok: false, status: 400, error: 'body.story must be an object' };
  }
  const s = storyRaw as Record<string, unknown>;

  // Required non-empty strings with length caps.
  for (const field of ['headline', 'source', 'category'] as const) {
    const v = s[field];
    if (typeof v !== 'string' || v.length === 0) {
      return { ok: false, status: 400, error: `story.${field} must be a non-empty string` };
    }
    if (v.length > CAPS[field]) {
      return { ok: false, status: 400, error: `story.${field} exceeds ${CAPS[field]} chars` };
    }
  }

  // threatLevel — strict enum matching brief-render.js:286 VALID_THREAT_LEVELS.
  if (typeof s.threatLevel !== 'string' || !VALID_THREAT_LEVELS.has(s.threatLevel)) {
    return {
      ok: false,
      status: 400,
      error: `story.threatLevel must be one of critical|high|medium|low`,
    };
  }

  // country — optional; string with cap when provided.
  let country = '';
  if (s.country !== undefined && s.country !== null) {
    if (typeof s.country !== 'string') {
      return { ok: false, status: 400, error: 'story.country must be a string' };
    }
    if (s.country.length > CAPS.country) {
      return { ok: false, status: 400, error: `story.country exceeds ${CAPS.country} chars` };
    }
    country = s.country;
  }

  // description — optional; when present, flows into the analyst prompt
  // so the LLM has grounded story context beyond the headline.
  let description: string | undefined;
  if (s.description !== undefined && s.description !== null) {
    if (typeof s.description !== 'string') {
      return { ok: false, status: 400, error: 'story.description must be a string' };
    }
    if (s.description.length > CAPS.description) {
      return { ok: false, status: 400, error: `story.description exceeds ${CAPS.description} chars` };
    }
    if (s.description.length > 0) description = s.description;
  }

  return {
    ok: true,
    story: {
      headline: s.headline as string,
      source: s.source as string,
      threatLevel: s.threatLevel,
      category: s.category as string,
      country,
      ...(description ? { description } : {}),
    },
  };
}

// ── LLM paths ─────────────────────────────────────────────────────────

async function runAnalystPath(story: StoryPayload, iso2: string | null): Promise<string | null> {
  try {
    const context = await assembleBriefStoryContext({ iso2, category: story.category });
    const { system, user, policyLabel } = buildAnalystWhyMattersPrompt(story, context);
    // One line per call so we can verify in Vercel logs that humanitarian
    // / aviation stories are NOT seeing marketData, without dumping the
    // full prompt (which would include upstream-provided text).
    console.log(
      `[brief-why-matters] analyst gate policy=${policyLabel} category="${story.category}" promptLen=${user.length}`,
    );
    const result = await callLlmReasoning({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // v2 prompt is 2–3 sentences / 40–70 words — roughly 3× v1's
      // single-sentence output, so bump maxTokens proportionally.
      maxTokens: 260,
      temperature: 0.4,
      timeoutMs: 15_000,
      // Provider is pinned via LLM_REASONING_PROVIDER env var (already
      // set to 'openrouter' in prod). `callLlmReasoning` routes through
      // the resolveProviderChain based on that env.
      // Note: no `validate` option. The post-call parseWhyMattersV2
      // check below handles rejection. Using validate inside
      // callLlmReasoning would walk the provider chain on parse-reject,
      // causing duplicate openrouter billings (see todo 245).
    });
    if (!result) return null;
    // v2 parser accepts multi-sentence output + rejects preamble /
    // leaked section labels. Analyst path ONLY — gemini path stays on v1.
    return parseWhyMattersV2(result.content);
  } catch (err) {
    console.warn(`[brief-why-matters] analyst path failed: ${err instanceof Error ? err.message : String(err)}`);
    // Nested helper called outside the request's `ctx.waitUntil` chain
    // (analyst/gemini paths run via Promise.allSettled). Await keeps the
    // helper's own promise pending until Sentry delivery completes,
    // capped by the 2s fetch timeout in `_sentry-common.js`.
    await captureSilentError(err, { tags: { route: 'api/internal/brief-why-matters', step: 'analyst-path', severity: 'warn' } });
    return null;
  }
}

async function runGeminiPath(story: StoryPayload): Promise<string | null> {
  try {
    // Sanitize before the edge-safe prompt builder sees any field —
    // defense-in-depth against prompt injection even under a valid
    // RELAY_SHARED_SECRET caller (consistent with the analyst path).
    const { system, user } = buildWhyMattersUserPrompt(sanitizeStoryFields(story));
    const result = await callLlmReasoning({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      maxTokens: 120,
      temperature: 0.4,
      timeoutMs: 10_000,
      // Note: no `validate` option. The post-call parseWhyMatters check
      // below handles rejection by returning null. Using validate inside
      // callLlmReasoning would walk the provider chain on parse-reject,
      // causing duplicate openrouter billings when only one provider is
      // configured in prod. See todo 245.
    });
    if (!result) return null;
    return parseWhyMatters(result.content);
  } catch (err) {
    console.warn(`[brief-why-matters] gemini path failed: ${err instanceof Error ? err.message : String(err)}`);
    await captureSilentError(err, { tags: { route: 'api/internal/brief-why-matters', step: 'gemini-path', severity: 'warn' } });
    return null;
  }
}

// ── Cache envelope ────────────────────────────────────────────────────
interface WhyMattersEnvelope {
  whyMatters: string;
  producedBy: 'analyst' | 'gemini';
  at: string; // ISO8601
}

function isEnvelope(v: unknown): v is WhyMattersEnvelope {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.whyMatters === 'string' &&
    (e.producedBy === 'analyst' || e.producedBy === 'gemini') &&
    typeof e.at === 'string'
  );
}

// ── Handler ───────────────────────────────────────────────────────────

// Vercel Edge passes an execution context as the 2nd argument with
// `waitUntil(promise)` to keep background work alive past the response
// return. Fire-and-forget without it is unreliable on Edge — the isolate
// can be frozen mid-write. Optional to stay compatible with local/test
// harnesses that don't pass a ctx.
interface EdgeContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export default async function handler(req: Request, ctx?: EdgeContext): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Auth.
  const unauthorized = await authenticateInternalRequest(req, 'RELAY_SHARED_SECRET');
  if (unauthorized) return unauthorized;

  // Body size cap — two layers: Content-Length pre-read, byte-length post-read.
  const contentLengthRaw = req.headers.get('content-length');
  if (contentLengthRaw) {
    const cl = Number.parseInt(contentLengthRaw, 10);
    if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
      return json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 400);
    }
  }

  // Read body as text so we can enforce the post-read cap before JSON.parse.
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return json({ error: 'failed to read body' }, 400);
  }
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, 400);
  }

  let bodyParsed: unknown;
  try {
    bodyParsed = JSON.parse(bodyText);
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const validation = validateStoryBody(bodyParsed);
  if (!validation.ok) {
    console.warn(`[brief-why-matters] validation_reject error=${validation.error}`);
    return json({ error: validation.error }, validation.status);
  }
  const story = validation.story;

  // Normalize country to ISO2 for context lookup; unknown/Global → null
  // (analyst path will skip country-specific fields).
  const iso2 = normalizeCountryToIso2(story.country);

  // Resolve config + runtime flags.
  const cfg = readConfig();
  if (cfg.invalidPrimaryRaw !== null) {
    console.warn(
      `[brief-why-matters] unrecognised BRIEF_WHY_MATTERS_PRIMARY=${cfg.invalidPrimaryRaw} — falling back to gemini (safe path). Valid values: analyst | gemini.`,
    );
  }
  if (cfg.invalidSamplePctRaw !== null) {
    console.warn(
      `[brief-why-matters] unrecognised BRIEF_WHY_MATTERS_SHADOW_SAMPLE_PCT=${cfg.invalidSamplePctRaw} — defaulting to 100. Must be integer 0-100.`,
    );
  }

  // Cache identity.
  const hash = await hashBriefStory(story);
  // v7: RSS-description grounding (2026-04-24). story:track:v1 now carries
  // a cleaned RSS description that rides through buildWhyMattersUserPrompt
  // as the `description` field. Every v6 row was produced either without a
  // description or with the cleaned-headline placeholder; with real article
  // bodies arriving, the editorial voice and named-actor accuracy shift
  // enough that v6 prose must be invalidated. hashBriefStory includes
  // description in its hash material so identity naturally drifts too —
  // this prefix bump is belt-and-braces for a clean cold-start on first
  // tick after deploy.
  //
  // v6 history (kept for reference): category-gated context + prompt-level
  // RELEVANCE RULE (2026-04-22) — those changes remain in v7.
  const cacheKey = `brief:llm:whymatters:v7:${hash}`;
  // Shadow v4→v5 for the same reason — a mid-rollout shadow record
  // comparing v6 pre-grounding vs gemini is not useful once v7 is live.
  const shadowKey = `brief:llm:whymatters:shadow:v5:${hash}`;

  // Cache read. Any infrastructure failure → treat as miss (logged).
  let cached: WhyMattersEnvelope | null = null;
  try {
    const raw = await readRawJsonFromUpstash(cacheKey);
    if (raw !== null && isEnvelope(raw)) {
      cached = raw;
    }
  } catch (err) {
    console.warn(`[brief-why-matters] cache read degraded: ${err instanceof Error ? err.message : String(err)}`);
    await captureSilentError(err, { tags: { route: 'api/internal/brief-why-matters', step: 'cache-read', severity: 'warn' } });
  }

  if (cached) {
    return json({
      whyMatters: cached.whyMatters,
      source: 'cache',
      producedBy: cached.producedBy,
      hash,
    }, 200);
  }

  // Cache miss — run paths.
  const runShadow = cfg.shadowEnabled && cfg.sampleHardRoll(hash);

  let analystResult: string | null = null;
  let geminiResult: string | null = null;
  let chosenProducer: 'analyst' | 'gemini';
  let chosenValue: string | null;

  if (runShadow) {
    const [a, g] = await Promise.allSettled([
      runAnalystPath(story, iso2),
      runGeminiPath(story),
    ]);
    analystResult = a.status === 'fulfilled' ? a.value : null;
    geminiResult = g.status === 'fulfilled' ? g.value : null;
    if (cfg.primary === 'analyst') {
      // Fall back to gemini if analyst failed.
      chosenProducer = analystResult !== null ? 'analyst' : 'gemini';
      chosenValue = analystResult ?? geminiResult;
    } else {
      chosenProducer = geminiResult !== null ? 'gemini' : 'analyst';
      chosenValue = geminiResult ?? analystResult;
    }
  } else if (cfg.primary === 'analyst') {
    analystResult = await runAnalystPath(story, iso2);
    chosenProducer = 'analyst';
    chosenValue = analystResult;
  } else {
    geminiResult = await runGeminiPath(story);
    chosenProducer = 'gemini';
    chosenValue = geminiResult;
  }

  // Cache write — only when we actually have a value, so cache-miss
  // retries on the next tick can try again.
  const now = new Date().toISOString();
  if (chosenValue !== null) {
    const envelope: WhyMattersEnvelope = {
      whyMatters: chosenValue,
      producedBy: chosenProducer,
      at: now,
    };
    try {
      await setCachedData(cacheKey, envelope, WHY_MATTERS_TTL_SEC);
    } catch (err) {
      console.warn(`[brief-why-matters] cache write degraded: ${err instanceof Error ? err.message : String(err)}`);
      await captureSilentError(err, { tags: { route: 'api/internal/brief-why-matters', step: 'cache-write', severity: 'warn' } });
    }
  }

  // Shadow record so offline diff has pairs to sample. Background work on
  // Edge runtimes MUST be registered with `ctx.waitUntil` — plain unawaited
  // promises can be frozen when the isolate terminates after the response.
  // Falls back to fire-and-forget when ctx is absent (local runs / tests).
  if (runShadow) {
    const record = {
      analyst: analystResult,
      gemini: geminiResult,
      chosen: chosenProducer,
      at: now,
    };
    const shadowWrite = redisPipeline([
      ['SET', shadowKey, JSON.stringify(record), 'EX', String(SHADOW_TTL_SEC)],
    ]).then(() => undefined).catch(() => {
      // Silent — shadow is observability, not critical.
    });
    if (typeof ctx?.waitUntil === 'function') {
      ctx.waitUntil(shadowWrite);
    }
    // When ctx is missing (local harness), the promise is still chained above
    // so it runs to completion before the caller's await completes.
  }

  const response: {
    whyMatters: string | null;
    source: 'analyst' | 'gemini';
    producedBy: 'analyst' | 'gemini' | null;
    hash: string;
    shadow?: { analyst: string | null; gemini: string | null };
  } = {
    whyMatters: chosenValue,
    source: chosenProducer,
    producedBy: chosenValue !== null ? chosenProducer : null,
    hash,
  };
  if (runShadow) {
    response.shadow = { analyst: analystResult, gemini: geminiResult };
  }

  return json(response, 200);
}
