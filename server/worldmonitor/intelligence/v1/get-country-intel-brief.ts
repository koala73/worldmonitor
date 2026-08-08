import type {
  ServerContext,
  BriefSource as CountryIntelBriefSource,
  GetCountryIntelBriefRequest,
  GetCountryIntelBriefResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { UPSTREAM_TIMEOUT_MS, TIER1_COUNTRIES, sha256Hex } from './_shared';
import { callLlm } from '../../../_shared/llm';
import { verifyCitationIndexes, checkLeadGrounding } from '../../../../shared/brief-llm-core.js';
import { isCallerPremium } from '../../../_shared/premium-check';
import { sanitizeForPrompt } from '../../../_shared/llm-sanitize.js';
import { ENERGY_SPINE_KEY_PREFIX } from '../../../_shared/cache-keys';
import { deriveCountryIntelCacheKey, fetchSharedCountryContext } from './_country-brief-context';

const INTEL_CACHE_TTL = 21600;

// Anonymous cache keys are minted from caller-controlled inputs, so both
// dimensions must be bounded: ISO-2 country code and a well-formed BCP-47-ish
// lang tag. Anything else gets the empty response / the 'en' brief.
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;
const LANG_RE = /^[a-z]{2}(-[a-z]{2})?$/;

function cleanSourceText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? `${text.slice(0, maxLen - 1).trim()}...` : text;
}

function normalizeSourceUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function normalizePublishedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = new Date(value.trim()).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function parseCountryBriefSources(contextSnapshot: string): CountryIntelBriefSource[] {
  const out: CountryIntelBriefSource[] = [];
  const seen = new Set<string>();
  const sourceLine = /^Source \[(\d{1,2})\]:\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = sourceLine.exec(contextSnapshot)) && out.length < 6) {
    const rawPayload = match[2]?.trim() ?? '';
    let candidate: { title?: unknown; source?: unknown; url?: unknown; publishedAt?: unknown } | null = null;

    if (rawPayload.startsWith('{')) {
      try {
        candidate = JSON.parse(rawPayload) as { title?: unknown; source?: unknown; url?: unknown; publishedAt?: unknown };
      } catch {
        candidate = null;
      }
    }

    if (!candidate) {
      const legacy = rawPayload.match(/^(.+?)\s*\|\s*(.+?)\s*\|\s*(https?:\/\/\S+)(?:\s*\|\s*published=([^\n|]+))?$/);
      if (legacy) {
        candidate = {
          title: legacy[1],
          source: legacy[2],
          url: legacy[3],
          publishedAt: legacy[4],
        };
      }
    }

    if (!candidate) continue;
    const title = cleanSourceText(candidate.title, 160);
    const source = cleanSourceText(candidate.source, 80);
    const url = normalizeSourceUrl(candidate.url);
    if (!title || !source || !url || seen.has(url)) continue;
    const publishedAt = normalizePublishedAt(candidate.publishedAt);
    out.push({ title, source, url, publishedAt: publishedAt ?? '' });
    seen.add(url);
  }
  return out;
}

export async function getCountryIntelBrief(
  ctx: ServerContext,
  req: GetCountryIntelBriefRequest,
): Promise<GetCountryIntelBriefResponse> {
  let sources: CountryIntelBriefSource[] = [];
  const empty: GetCountryIntelBriefResponse = {
    countryCode: req.countryCode,
    countryName: '',
    brief: '',
    model: '',
    generatedAt: Date.now(),
    sources,
  };

  if (!req.countryCode || !COUNTRY_CODE_RE.test(req.countryCode)) return empty;

  const isPremium = await isCallerPremium(ctx.request);

  // Caller-supplied context only personalizes premium requests. Anonymous
  // briefs are grounded server-side (news digest) and share one cache entry
  // per country+lang — hashing anon caller context into the key was the #4892
  // cost bug (every dashboard visitor minted a fresh key), and folding anon
  // caller text into a shared entry would let one caller shape everyone's brief.
  let contextSnapshot = '';
  let lang = 'en';
  try {
    const url = new URL(ctx.request.url);
    const rawLang = (url.searchParams.get('lang') || 'en').toLowerCase();
    lang = LANG_RE.test(rawLang) ? rawLang : 'en';
    if (isPremium) {
      // MCP sends `context` in the signed POST body; the gateway promotes scalar
      // body fields into query params before this generated GET handler runs.
      const rawContextSnapshot = (url.searchParams.get('context') || '').trim().slice(0, 4000);
      sources = parseCountryBriefSources(rawContextSnapshot);
      contextSnapshot = sanitizeForPrompt(rawContextSnapshot);
    }
  } catch {
    contextSnapshot = '';
    sources = [];
  }
  empty.sources = sources;

  const frameworkRaw = isPremium && typeof req.framework === 'string' ? req.framework.slice(0, 2000) : '';

  // Fetch energy mix early so its data-year can be included in the cache key.
  // This ensures cached briefs are invalidated when OWID publishes updated annual
  // data — without it, energy mix changes are silently ignored in cached briefs.
  // Prefer reading from spine (single key); fall back to direct mix key on miss.
  let energyMixData: Record<string, unknown> | null = null;
  try {
    const spine = await getCachedJson(`${ENERGY_SPINE_KEY_PREFIX}${req.countryCode.toUpperCase()}`, true) as Record<string, unknown> | null;
    if (spine != null && typeof spine === 'object' && spine.mix != null) {
      const src = spine.sources as Record<string, unknown> | undefined;
      energyMixData = {
        ...(spine.mix as Record<string, unknown>),
        year: src?.mixYear ?? null,
      };
    } else {
      const raw = await getCachedJson(`energy:mix:v1:${req.countryCode.toUpperCase()}`, true);
      if (raw && typeof raw === 'object') energyMixData = raw as Record<string, unknown>;
    }
  } catch { /* graceful omit */ }
  const energyYear = typeof energyMixData?.year === 'number' ? String(energyMixData.year) : '';

  const [contextHashFull, frameworkHashFull] = await Promise.all([
    contextSnapshot ? sha256Hex(contextSnapshot) : Promise.resolve('base'),
    frameworkRaw    ? sha256Hex(frameworkRaw)    : Promise.resolve(''),
  ]);
  const cacheKey = deriveCountryIntelCacheKey({
    countryCode: req.countryCode.toUpperCase(),
    lang,
    isPremium,
    contextHash: contextSnapshot ? contextHashFull.slice(0, 16) : 'base',
    frameworkHash: frameworkRaw ? frameworkHashFull.slice(0, 8) : '',
    energyYear,
  });
  const countryName = TIER1_COUNTRIES[req.countryCode.toUpperCase()] || req.countryCode;
  const dateStr = new Date().toISOString().split('T')[0];

  const systemPrompt = `You are a senior intelligence analyst. Current date: ${dateStr}.

Generate a structured intelligence brief using EXACTLY this format:

SITUATION NOW
[2-3 sentences on what is happening and why it matters for this country]

WHAT THIS MEANS FOR ${countryName.toUpperCase()}
• [Named entity from infrastructure context]: [mechanism from active event] — [quantified impact if available]
• [Named entity]: [mechanism] — [impact]
• [Named entity]: [mechanism] — [impact]
• [Named entity]: [mechanism] — [impact]
• [Named entity]: [mechanism] — [impact]

KEY RISKS
• [Risk 1]
• [Risk 2]
• [Risk 3]

OUTLOOK
NEXT 24H: [one sentence]
NEXT 48H: [one sentence]
NEXT 72H: [one sentence]

WATCH ITEMS
[Signal 1] · [Signal 2] · [Signal 3]

Rules:
- In "WHAT THIS MEANS FOR ${countryName.toUpperCase()}": use ONLY named infrastructure entities provided in the context (ports, pipelines, cables, waterways). Include actual numbers where available.
- If no infrastructure context is provided, use named economic sectors or companies instead.
- Be specific. Avoid generic phrases like "supply chain disruption risk".
- If "Brief source articles" are provided, cite supporting claims with bracket markers like [1] or [2]. Do not invent source numbers or URLs.
- No speculation beyond what data supports.${lang === 'fr' ? '\n- IMPORTANT: You MUST respond ENTIRELY in French language.' : ''}`;

  let result: GetCountryIntelBriefResponse | null = null;
  try {
    result = await cachedFetchJson<GetCountryIntelBriefResponse>(cacheKey, INTEL_CACHE_TTL, async () => {
      // Grounding is resolved inside the fetcher so shared-path callers pay
      // the digest read only on a cache miss (once per country+lang per TTL).
      let promptContext = contextSnapshot;
      let entrySources = sources;
      if (!isPremium) {
        const shared = await fetchSharedCountryContext(req.countryCode.toUpperCase());
        promptContext = shared.contextSnapshot;
        entrySources = shared.sources;
      }

      const userPromptParts = [`Country: ${countryName} (${req.countryCode})`];

      if (energyMixData) {
        const yr = energyYear || '';
        userPromptParts.push(
          `Energy generation mix (${yr}): coal ${energyMixData.coalShare ?? '?'}%, ` +
          `gas ${energyMixData.gasShare ?? '?'}%, renewables ${energyMixData.renewShare ?? '?'}%, ` +
          `nuclear ${energyMixData.nuclearShare ?? '?'}%, net import dependency ${energyMixData.importShare ?? '?'}%.`,
        );
      }

      if (promptContext) {
        userPromptParts.push(`Context snapshot:\n${promptContext}`);
      }

      const llmResult = await callLlm({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPromptParts.join('\n\n') },
        ],
        temperature: 0.4,
        maxTokens: 1100,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        systemAppend: frameworkRaw || undefined,
        stage: 'country-intel-brief',
      });

      if (!llmResult) return null;

      // #4921 brief contract: citations are verified mechanically — every
      // [n] must map to a real grounding source; invented indexes are
      // stripped before shipping (ENFORCE). The prompt demands "do not
      // invent source numbers", but demands are not guarantees.
      const citationCheck = verifyCitationIndexes(llmResult.content, entrySources.length);
      if (citationCheck.stripped > 0) {
        console.warn(
          `[country-intel] stripped ${citationCheck.stripped} out-of-range citation(s) ` +
            `for ${req.countryCode} (sources=${entrySources.length})`,
        );
      }
      // Grounding telemetry (measure-only for now — the analyst format
      // legitimately synthesizes across sources, so enforce here needs its
      // own false-positive window first; see #4921).
      const grounded = checkLeadGrounding(
        { lead: citationCheck.text.slice(0, 600) },
        entrySources.map((source) => ({ headline: source.title })),
        entrySources.length || 1,
      );
      if (!grounded) {
        console.warn(`[country-intel] GROUNDING MEASURE: brief for ${req.countryCode} names no source anchor`);
      }

      return {
        countryCode: req.countryCode,
        countryName,
        brief: citationCheck.text,
        model: llmResult.model,
        generatedAt: Date.now(),
        sources: entrySources,
      };
    });
  } catch {
    return empty;
  }

  if (!result) return empty;
  if (!isPremium) {
    // Shared entries carry server-derived sources; never backfill them with
    // this caller's parsed context (the brief text didn't see it).
    return { ...result, sources: Array.isArray(result.sources) ? result.sources : [] };
  }
  return {
    ...result,
    sources: Array.isArray(result.sources) && result.sources.length > 0 ? result.sources : sources,
  };
}
