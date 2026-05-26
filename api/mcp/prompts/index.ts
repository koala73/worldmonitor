// MCP prompts registry. Each entry is a workflow template: it declares the
// arguments the caller passes via `prompts/get`, the sequence of `tools/call`
// invocations the model should execute (with literal JMESPath projections
// pre-baked from the corresponding tool's outputSchema), and the rendered
// user-facing instructions that explain the workflow.
//
// Why a structured `steps` shape (vs. an inline jmespath: marker in a freeform
// template string): a structured shape lets the schema-parity test
// (tests/mcp-prompts.test.mjs) walk every {tool, jmespath} pair directly
// without fragile regex extraction from the rendered text. Same content ends
// up in the rendered message, but the source of truth stays machine-readable.
//
// Load-time validator (validatePromptRegistry, run at module init) guards
// against three classes of authoring mistake:
//   1. A ${token} in any template string that isn't declared in the prompt's
//      arguments[].name — would render as the literal "${unknown}" and
//      silently break the workflow.
//   2. A duplicate prompt name — would shadow the earlier entry in
//      prompts/list and break the prompts/get lookup.
//   3. A duplicate argument name within a single prompt — would let two
//      arguments[] entries collide on substitution.
// Tool-name parity (every step.tool exists in TOOL_REGISTRY) is enforced by
// the test suite at test time, not at module load, to keep this module free
// of an import cycle with the registry.

import type { McpPromptArgument, McpPromptDef } from '../types';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
// JMESPath authoring rule: only reference fields that exist in the targeted
// tool's outputSchema. The Phase-1 schema-parity test (see
// tests/mcp-prompts.test.mjs) compiles every expression below and asserts
// that every field identifier resolves to some property in the matching
// outputSchema. A rename in a future PR (either side) fails this test by
// name with both the prompt and the broken path.
//
// Cache-tool envelopes are wrapped as `{cached_at, stale, data: {...labels}}`
// (see cacheEnvelope in filters.ts). Projections into cache-tool responses
// therefore start at `data.<label>`. RPC tools return the raw payload — no
// `data.` prefix needed.
export const PROMPT_REGISTRY: McpPromptDef[] = [
  {
    name: 'country-briefing',
    description:
      'Multi-tool country brief: quantitative risk score + LLM-synthesised intelligence brief + macro indicators for a single ISO 3166-1 alpha-2 country.',
    arguments: [
      {
        name: 'iso2',
        description: 'ISO 3166-1 alpha-2 country code (e.g. "DE", "US", "CN", "IR"). Case-sensitive — pass uppercase.',
        required: true,
      },
    ],
    steps: [
      {
        tool: 'get_country_risk',
        args: { country_code: '${iso2}' },
        jmespath: '{cii: cii, components: components, travelAdvisory: travelAdvisory, sanctionsExposure: sanctionsExposure}',
        purpose: 'Quantitative Composite Instability Index (CII) + component breakdown + travel advisory + OFAC sanctions exposure.',
      },
      {
        tool: 'get_country_brief',
        args: { country_code: '${iso2}' },
        jmespath: '{country_code: country_code, brief: brief}',
        purpose: 'LLM-synthesised geopolitical + economic narrative grounded on the latest headlines.',
      },
      {
        tool: 'get_country_macro',
        args: { countries: ['${iso2}'] },
        jmespath: '{macro: data.macro.countries, growth: data.growth.countries, labor: data.labor.countries}',
        purpose: 'IMF WEO macro/growth/labor indicators (one-country slice; external excluded — broad WEO retraction 2026-04).',
      },
    ],
    intro:
      'Build a country briefing for ${iso2}. Execute the three steps below in order; combine the results into a single concise brief (CII score and components, travel/sanctions posture, the LLM brief, then the key macro indicators).',
  },
  {
    name: 'energy-shock-watch',
    description:
      'Active energy supply disruptions, fuel shortages, and government crisis policies. Optional country filter narrows the country-keyed slices; omit for a global view.',
    arguments: [
      {
        name: 'country',
        description: 'Optional ISO 3166-1 alpha-2 country code to focus on (e.g. "DE", "IN"). Omit for the global energy bundle.',
        required: false,
      },
    ],
    steps: [
      {
        tool: 'get_energy_intelligence',
        args: { country: '${country}' },
        jmespath: '{disruptions: data.disruptions.events, fuel_shortages: data."fuel-shortages".shortages, crisis_policies: data."crisis-policies".policies}',
        purpose: 'Active disruptions + per-country fuel shortages + government crisis policies. Three slices of the energy bundle most relevant to a near-term shock.',
      },
    ],
    intro:
      'Surface active energy disruptions, fuel shortages, and the government crisis-policy posture${country_suffix}. Call the step below, then summarise: are there active disruptions right now, and which countries / policies are in scope?',
    intro_substitutions: {
      country_suffix: { when_present: ' for ${country}', when_absent: ' (global view)' },
    },
  },
  {
    name: 'market-open-prep',
    description:
      'Pre-market briefing: equity, commodity, and crypto quotes with per-symbol percent changes. Designed to be cheap to read — only changePercent + symbol are projected per asset class.',
    arguments: [],
    steps: [
      {
        tool: 'get_market_data',
        args: { asset_class: ['equity', 'commodity', 'crypto'] },
        jmespath: '{equity: data."stocks-bootstrap".quotes[*].{symbol: symbol, changePercent: changePercent}, commodity: data."commodities-bootstrap".quotes[*].{symbol: symbol, changePercent: changePercent}, crypto: data.crypto.quotes[*].{symbol: symbol, changePercent: changePercent}}',
        purpose: 'Per-asset-class quote pairs (symbol + changePercent only). Skip ETF flows / sectors / Gulf / fear-greed — they belong in a deeper drill-down, not a session-opening read.',
      },
    ],
    intro:
      'Prepare a market-open briefing. Call the step below to fetch equity, commodity, and crypto movers, then highlight the largest gainers and losers per asset class along with anything anomalous (e.g. correlated moves, single-name outliers).',
  },
  {
    name: 'conflict-pulse',
    description:
      'Active conflict events (UCDP) + alert-flagged top news stories. Optional country filter narrows both feeds; omit for a global pulse.',
    arguments: [
      {
        name: 'country',
        description: 'Optional country filter. UCDP event names use full country names ("United States"); news intelligence uses ISO 3166-1 alpha-2. Pass the most specific form that matches both — the postFilters are case-insensitive on substring/code respectively.',
        required: false,
      },
    ],
    steps: [
      {
        tool: 'get_conflict_events',
        args: { country: '${country}', min_fatalities: 1 },
        jmespath: 'data."ucdp-events".events',
        purpose: 'UCDP armed-conflict events (≥1 fatality) — the canonical low-noise feed for hot conflicts.',
      },
      {
        tool: 'get_news_intelligence',
        args: { country: '${country}', alerts_only: true },
        jmespath: 'data.insights.topStories',
        purpose: 'Alert-flagged top stories only — high signal-to-noise filter on the news layer.',
      },
    ],
    intro:
      'Read the current conflict pulse${country_suffix}. Run both steps below and synthesise: where are the active conflict events, and what alert-flagged stories cluster with them? Be specific about geographies and sides.',
    intro_substitutions: {
      country_suffix: { when_present: ' for ${country}', when_absent: ' (global view)' },
    },
  },
  {
    name: 'route-risk-check',
    description:
      'Maritime chokepoint transit summary + risk posture for a single chokepoint (e.g. "hormuz", "suez", "malacca", "bab-el-mandeb", "panama"). The filter is case-insensitive substring against the chokepoint identifiers used by each dataset.',
    arguments: [
      {
        name: 'chokepoint',
        description: 'Substring match against chokepoint identifiers — e.g. "hormuz" matches both "hormuz_strait" and "Strait of Hormuz". Use the most specific name you have.',
        required: true,
      },
    ],
    steps: [
      {
        tool: 'get_chokepoint_status',
        args: { chokepoint: '${chokepoint}' },
        jmespath: 'data."transit-summaries".summaries',
        purpose: 'Per-chokepoint transit summary: today total / tanker / cargo, week-over-week change, risk level, incident count, disruption percentage, and a risk narrative.',
      },
    ],
    intro:
      'Assess the current route risk for the ${chokepoint} chokepoint. Call the step below and surface: today\'s transit volume, week-over-week change, risk level + narrative, and any incidents in the trailing 7 days. Flag explicitly if the dataAvailable field is false.',
  },
  {
    name: 'freshness-audit',
    description:
      'Quick audit of cache freshness across three high-cadence cache tools. Reads each envelope\'s cached_at + stale flag (no full data payload) so the operator can see at a glance whether the bootstrap pipeline is up to date.',
    arguments: [],
    steps: [
      {
        tool: 'get_market_data',
        args: { summary: true },
        jmespath: '{cached_at: cached_at, stale: stale}',
        purpose: 'Market-data envelope freshness (10-min cadence on equity quotes; stale if any contributing key is older than its per-key budget).',
      },
      {
        tool: 'get_energy_intelligence',
        args: { summary: true },
        jmespath: '{cached_at: cached_at, stale: stale}',
        purpose: 'Energy bundle envelope freshness (multi-cadence — EIA daily, Ember daily, gas-storage daily, World Bank annual).',
      },
      {
        tool: 'get_chokepoint_status',
        args: { summary: true },
        jmespath: '{cached_at: cached_at, stale: stale}',
        purpose: 'Chokepoint transit-summary envelope freshness (10-min relay cadence on the live transit feeds).',
      },
    ],
    intro:
      'Audit the bootstrap pipeline freshness across markets, energy, and maritime chokepoints. For each step below, project ONLY the envelope (cached_at + stale) — the summary: true flag collapses the payload so this stays cheap. Then report a one-line freshness verdict per tool.',
  },
];

// ---------------------------------------------------------------------------
// Substitution + rendering
// ---------------------------------------------------------------------------

// Recognised token grammar: ${name} where name is one of the prompt's
// declared arguments. Non-matching `${...}` content is treated as a token
// (so a typo'd token surfaces as a load-time error, not a silent passthrough).
const TOKEN_RE = /\$\{([^}]*)\}/g;

function collectTokens(s: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(s)) !== null) out.push(m[1] ?? '');
  return out;
}

// Recursive token walk over the args_template object — covers strings nested
// in arrays/objects (e.g. `{countries: ["${iso2}"]}`). Non-string leaves
// (numbers, booleans, null) are skipped.
function collectTokensFromValue(v: unknown, sink: string[]): void {
  if (typeof v === 'string') {
    for (const t of collectTokens(v)) sink.push(t);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectTokensFromValue(x, sink);
    return;
  }
  if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) collectTokensFromValue(x, sink);
  }
}

function substituteString(s: string, values: Record<string, string>): string {
  return s.replace(TOKEN_RE, (_, name) => values[name] ?? '');
}

function substituteValue(v: unknown, values: Record<string, string>): unknown {
  if (typeof v === 'string') return substituteString(v, values);
  if (Array.isArray(v)) return v.map((x) => substituteValue(x, values));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = substituteValue(val, values);
    }
    return out;
  }
  return v;
}

// Render `intro_substitutions` conditional segments BEFORE the standard
// ${arg} pass so the intro template can express "with a country filter" vs.
// "global view" branches without per-prompt code. Each substitution name
// (e.g. country_suffix) maps to one of two literal substrings keyed by
// whether the controlling arg was provided.
function applyIntroSubstitutions(
  intro: string,
  intro_substitutions: McpPromptDef['intro_substitutions'] | undefined,
  values: Record<string, string>,
): string {
  if (!intro_substitutions) return intro;
  let out = intro;
  for (const [tokenName, spec] of Object.entries(intro_substitutions)) {
    // The controlling arg name is implied by the values inside the spec —
    // each spec template references one arg via ${name}. Determine presence
    // by inspecting the spec's own token grammar: if the referenced arg has a
    // non-empty value, render when_present; otherwise when_absent.
    const argsReferenced = [
      ...collectTokens(spec.when_present),
      ...collectTokens(spec.when_absent),
    ];
    const isPresent = argsReferenced.some((arg) => (values[arg] ?? '').length > 0);
    const replacement = isPresent ? spec.when_present : spec.when_absent;
    out = out.split('${' + tokenName + '}').join(replacement);
  }
  return out;
}

export interface BuildPromptResponseError {
  ok: false;
  code: number;
  message: string;
}
export interface BuildPromptResponseOk {
  ok: true;
  description: string;
  messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }>;
}

// Resolve a prompts/get call: look up the prompt by name, validate the
// provided arguments against the declaration, substitute, and render the
// user-facing workflow message. Returns a discriminated union so the dispatch
// layer can map ok=false to the right JSON-RPC error code (-32602 for both
// unknown-name and missing-required-arg, mirroring tools/call).
export function buildPromptResponse(
  promptName: string,
  providedArgs: Record<string, unknown> | undefined,
): BuildPromptResponseOk | BuildPromptResponseError {
  const prompt = PROMPT_REGISTRY.find((p) => p.name === promptName);
  if (!prompt) {
    return { ok: false, code: -32602, message: `Unknown prompt: ${promptName}` };
  }

  const values: Record<string, string> = {};
  for (const arg of prompt.arguments) {
    const raw = providedArgs?.[arg.name];
    if (raw == null || raw === '') {
      if (arg.required) {
        return { ok: false, code: -32602, message: `Missing required argument "${arg.name}" for prompt "${promptName}"` };
      }
      values[arg.name] = '';
      continue;
    }
    values[arg.name] = String(raw);
  }

  const renderedIntro = substituteString(
    applyIntroSubstitutions(prompt.intro, prompt.intro_substitutions, values),
    values,
  );

  const lines: string[] = [renderedIntro, ''];
  prompt.steps.forEach((step, i) => {
    const rawArgs = substituteValue(step.args, values) as Record<string, unknown>;
    // Strip top-level keys that resolved to '' (an omitted optional arg —
    // required-arg absence already returned -32602 above). Passing `""` to a
    // tool is ambiguous: postFilters today truthy-check (safe), but a future
    // tool that guards with `!== undefined` would try to filter by empty
    // string and serve incorrect/empty results instead of the global view.
    // Render the no-filter call literally as `{}` so the LLM sees the
    // intended shape.
    const renderedArgs = Object.fromEntries(
      Object.entries(rawArgs).filter(([, v]) => v !== ''),
    );
    lines.push(`Step ${i + 1} — ${step.tool}`);
    lines.push(`  purpose: ${substituteString(step.purpose, values)}`);
    lines.push(`  arguments: ${JSON.stringify(renderedArgs)}`);
    lines.push(`  jmespath: ${step.jmespath}`);
    lines.push('');
  });

  return {
    ok: true,
    description: prompt.description,
    messages: [
      { role: 'user', content: { type: 'text', text: lines.join('\n').trimEnd() } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Load-time validator
// ---------------------------------------------------------------------------
// Throws on any structural authoring mistake. Runs once at module-init so a
// malformed PROMPT_REGISTRY takes down the handler at deploy time rather
// than producing silently broken renders on first prompts/get. Same
// discipline as the TOOL_REGISTRY collision-guard in registry/index.ts.
function validatePromptRegistry(): void {
  const namesSeen = new Set<string>();
  for (const prompt of PROMPT_REGISTRY) {
    if (namesSeen.has(prompt.name)) {
      throw new Error(`api/mcp/prompts/index.ts: duplicate prompt name "${prompt.name}".`);
    }
    namesSeen.add(prompt.name);

    const argNames = new Set<string>();
    for (const arg of prompt.arguments) {
      if (argNames.has(arg.name)) {
        throw new Error(`api/mcp/prompts/index.ts: prompt "${prompt.name}" declares duplicate argument "${arg.name}".`);
      }
      argNames.add(arg.name);
    }

    // Allow intro_substitutions[tokenName] as an additional declared token in
    // the intro string (it's a synthetic name expanded BEFORE the ${arg}
    // pass). The token names declared in intro_substitutions stand in for
    // their conditional segments and don't need to appear in arguments[].
    const introTokens = new Set<string>(prompt.intro_substitutions ? Object.keys(prompt.intro_substitutions) : []);

    const validateTokensIn = (where: string, s: string): void => {
      for (const tok of collectTokens(s)) {
        if (!argNames.has(tok) && !introTokens.has(tok)) {
          throw new Error(`api/mcp/prompts/index.ts: prompt "${prompt.name}" ${where} references unknown token "\${${tok}}". Declared args: [${[...argNames].join(', ')}]${introTokens.size ? `; intro substitutions: [${[...introTokens].join(', ')}]` : ''}.`);
        }
      }
    };

    validateTokensIn('intro', prompt.intro);
    if (prompt.intro_substitutions) {
      for (const [name, spec] of Object.entries(prompt.intro_substitutions)) {
        // Inside intro_substitutions specs, only real argument names are
        // permitted — synthetic names cannot reference each other.
        for (const tok of collectTokens(spec.when_present)) {
          if (!argNames.has(tok)) {
            throw new Error(`api/mcp/prompts/index.ts: prompt "${prompt.name}" intro_substitutions.${name}.when_present references unknown token "\${${tok}}".`);
          }
        }
        for (const tok of collectTokens(spec.when_absent)) {
          if (!argNames.has(tok)) {
            throw new Error(`api/mcp/prompts/index.ts: prompt "${prompt.name}" intro_substitutions.${name}.when_absent references unknown token "\${${tok}}".`);
          }
        }
      }
    }
    for (const [i, step] of prompt.steps.entries()) {
      const sink: string[] = [];
      collectTokensFromValue(step.args, sink);
      for (const tok of sink) {
        if (!argNames.has(tok)) {
          throw new Error(`api/mcp/prompts/index.ts: prompt "${prompt.name}" step ${i + 1} (${step.tool}) args reference unknown token "\${${tok}}".`);
        }
      }
      validateTokensIn(`step ${i + 1} (${step.tool}) purpose`, step.purpose);
    }
  }
}

validatePromptRegistry();

// ---------------------------------------------------------------------------
// prompts/list public shape
// ---------------------------------------------------------------------------
// Per MCP spec, prompts/list returns `{prompts: [{name, description,
// arguments}]}` — no `steps` / `intro`. Internal authoring fields stay
// internal; the wire shape is the spec's.
export interface PublicPromptShape {
  name: string;
  description: string;
  arguments: McpPromptArgument[];
}

export const PROMPT_LIST_RESPONSE: PublicPromptShape[] = PROMPT_REGISTRY.map((p) => ({
  name: p.name,
  description: p.description,
  arguments: p.arguments.map((a) => ({ ...a })),
}));
