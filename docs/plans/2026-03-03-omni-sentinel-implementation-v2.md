# Omni Sentinel — Implementation Plan v2

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend World Monitor with Claude AI analysis, expanded social media, military analysis (JP 3-60), government data, historical trajectories, and enhanced prediction markets.

**Architecture:** Proto-first plugin mode. Each module follows World Monitor's service pattern: `.proto` → `buf generate` → server handler → Edge Function → client wrapper → panel component → feature flag.

**Tech Stack:** Preact + TypeScript + MapLibre GL + Deck.gl | Vercel Edge Functions + Railway | Upstash Redis | Anthropic Claude API | buf/sebuf proto codegen

**Source Documents:**
- Design: `docs/plans/2026-03-03-omni-sentinel-design.md`
- Master Checklist: `docs/plans/2026-03-03-omni-sentinel-master-checklist.md`
- Reviews: `docs/reviews/` (security, scalability, cost, feature, ops, synthesis)
- Research: `docs/research/` (global platform map, Twitter/Telegram guide)
- Legal: `LEGAL.md`

**Critical Fork Rule:** NEVER directly edit upstream core files (`summarization.ts`, `panels.ts`, `runtime-config.ts`, `gateway.ts`). Create sentinel-specific config files instead. See `CLAUDE.md` for details.

---

## Execution Strategy

8 worktrees, one per module. Module 0 (Infrastructure) must complete first. Module 3 (JP 3-60) depends on Module 1 (Claude). All others can run in parallel after Module 0.

```
wt-infra      → Module 0 (Infrastructure)     → no dependencies
wt-claude     → Module 1 (Claude AI Provider)  → depends on Module 0
wt-social     → Module 2 (Social Media)        → depends on Module 0
wt-analyst    → Module 3 (JP 3-60 Analyst)     → depends on Module 0 + Module 1
wt-govdata    → Module 4 (Government Data)     → depends on Module 0
wt-trajectory → Module 5 (Historical Trajectory)→ depends on Module 0
wt-prediction → Module 6 (Prediction Markets)  → depends on Module 0
wt-rss        → Module 7 (RSS Expansion)       → no dependencies
```

---

## Module 0: Infrastructure Foundation

**Goal:** Shared utilities that all other modules depend on.

### Task 0.1: Input Validation Utility

**Files:**
- Create: `src/utils/validation.ts`
- Create: `src/utils/validation.test.ts`

**Step 1: Write the failing test**

```typescript
// src/utils/validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateStringParam, validateHexParam, validateNumberParam } from './validation';

describe('validateStringParam', () => {
  it('rejects empty strings', () => {
    expect(() => validateStringParam('', 'test')).toThrow('test is required');
  });

  it('rejects strings exceeding maxLength', () => {
    expect(() => validateStringParam('a'.repeat(101), 'test', 100)).toThrow('test exceeds maximum length');
  });

  it('rejects strings not matching pattern', () => {
    expect(() => validateStringParam('invalid!@#', 'subreddit', 50, /^[a-zA-Z0-9_]+$/)).toThrow('subreddit contains invalid characters');
  });

  it('accepts valid strings', () => {
    expect(validateStringParam('worldnews', 'subreddit', 50, /^[a-zA-Z0-9_]+$/)).toBe('worldnews');
  });

  it('trims whitespace', () => {
    expect(validateStringParam('  test  ', 'field')).toBe('test');
  });
});

describe('validateHexParam', () => {
  it('validates ICAO24 hex codes', () => {
    expect(validateHexParam('a1b2c3', 'icao24')).toBe('a1b2c3');
  });

  it('rejects non-hex strings', () => {
    expect(() => validateHexParam('zzzzzz', 'icao24')).toThrow('icao24 must be a valid hex string');
  });
});

describe('validateNumberParam', () => {
  it('validates numbers within range', () => {
    expect(validateNumberParam(50, 'limit', 1, 100)).toBe(50);
  });

  it('rejects numbers outside range', () => {
    expect(() => validateNumberParam(200, 'limit', 1, 100)).toThrow('limit must be between 1 and 100');
  });
});
```

**Step 2: Run test to verify it fails**

Run: check `package.json` for test command, then run tests targeting this file
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/utils/validation.ts
export function validateStringParam(
  value: string | undefined | null,
  name: string,
  maxLength = 500,
  pattern?: RegExp
): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${name} exceeds maximum length of ${maxLength}`);
  }
  if (pattern && !pattern.test(trimmed)) {
    throw new Error(`${name} contains invalid characters`);
  }
  return trimmed;
}

export function validateHexParam(value: string, name: string, length?: number): string {
  const trimmed = validateStringParam(value, name, 20);
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error(`${name} must be a valid hex string`);
  }
  if (length && trimmed.length !== length) {
    throw new Error(`${name} must be exactly ${length} hex characters`);
  }
  return trimmed.toLowerCase();
}

export function validateNumberParam(value: number, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new Error(`${name} must be a number`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}
```

**Step 4: Run test to verify it passes**

Expected: PASS

**Step 5: Commit**

```bash
git add src/utils/validation.ts src/utils/validation.test.ts
git commit -m "feat(infra): add input validation utilities"
```

### Task 0.2: Claude Response Validation Utility

**Files:**
- Create: `src/utils/ai-response.ts`
- Create: `src/utils/ai-response.test.ts`

**Step 1: Write the failing test**

```typescript
// src/utils/ai-response.test.ts
import { describe, it, expect } from 'vitest';
import { extractJson, sanitizeHtml } from './ai-response';

describe('extractJson', () => {
  it('extracts JSON from markdown code fences', () => {
    const input = '```json\n{"score": 0.8}\n```';
    expect(extractJson(input)).toEqual({ score: 0.8 });
  });

  it('extracts bare JSON', () => {
    expect(extractJson('{"key":"value"}')).toEqual({ key: 'value' });
  });

  it('extracts JSON with surrounding text', () => {
    const input = 'Here is the analysis:\n{"score": 0.5}\nEnd of response.';
    expect(extractJson(input)).toEqual({ score: 0.5 });
  });

  it('throws on invalid JSON', () => {
    expect(() => extractJson('not json at all')).toThrow('No valid JSON found in response');
  });

  it('extracts JSON array', () => {
    expect(extractJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });
});

describe('sanitizeHtml', () => {
  it('strips script tags', () => {
    expect(sanitizeHtml('hello<script>alert(1)</script>world')).toBe('helloworld');
  });

  it('strips on-event handlers', () => {
    expect(sanitizeHtml('<div onclick="alert(1)">text</div>')).toBe('<div>text</div>');
  });

  it('preserves safe HTML', () => {
    expect(sanitizeHtml('<p><strong>bold</strong></p>')).toBe('<p><strong>bold</strong></p>');
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Write minimal implementation**

```typescript
// src/utils/ai-response.ts

/** Extract JSON object/array from LLM response text (handles code fences, surrounding text) */
export function extractJson<T = unknown>(text: string): T {
  // Try code fence extraction first
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  // Try bare JSON (find first { or [)
  const jsonStart = text.search(/[\[{]/);
  if (jsonStart === -1) throw new Error('No valid JSON found in response');

  // Find matching closing bracket
  const startChar = text[jsonStart];
  const endChar = startChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === startChar) depth++;
    if (ch === endChar) depth--;
    if (depth === 0) {
      try { return JSON.parse(text.slice(jsonStart, i + 1)); } catch {}
      break;
    }
  }

  throw new Error('No valid JSON found in response');
}

const UNSAFE_TAGS = /(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)/gi;
const EVENT_HANDLERS = /\s+on\w+="[^"]*"/gi;

/** Strip dangerous HTML (script tags, event handlers). NOT a full sanitizer — use for display hints only. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(UNSAFE_TAGS, '')
    .replace(EVENT_HANDLERS, '');
}
```

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git add src/utils/ai-response.ts src/utils/ai-response.test.ts
git commit -m "feat(infra): add AI response JSON extraction and HTML sanitization"
```

### Task 0.3: Sentinel Configuration Files (Fork Safety)

**Files:**
- Create: `src/config/sentinel-panels.ts`
- Create: `src/services/sentinel-ai-config.ts`
- Create: `src/services/sentinel-features.ts`
- Create: `server/sentinel-gateway-config.ts`

**Step 1: Read existing core files to understand their structure**

Read these files to understand the export shapes:
- `src/config/panels.ts` — understand `PANELS` array type and structure
- `src/services/summarization.ts` — understand `API_PROVIDERS` array
- `src/services/runtime-config.ts` — understand `RuntimeFeatureId` and `RUNTIME_FEATURES`
- `server/gateway.ts` — understand service registration pattern

**Step 2: Create sentinel-panels.ts**

```typescript
// src/config/sentinel-panels.ts
// SENTINEL: New panel configurations. Imported by panels.ts with minimal merge.
// See CLAUDE.md "Fork Management" — do NOT edit panels.ts directly.

import type { PanelConfig } from './panels'; // adjust type import based on what you find

export const SENTINEL_PANELS: PanelConfig[] = [
  // Panels will be added by each module as they are built
  // Module 1: Claude AI → ClaudeSettingsPanel
  // Module 2: Social Media → SocialFeedPanel
  // Module 3: JP 3-60 → AnalystPanel
  // Module 4: Government → NotamPanel, SanctionsPanel
  // Module 5: Trajectory → TrajectoryPanel
  // Module 6: Prediction → PredictionComparisonPanel
];
```

**Step 3: Create sentinel-ai-config.ts**

```typescript
// src/services/sentinel-ai-config.ts
// SENTINEL: Claude AI provider configuration. Imported by summarization.ts.

export const SENTINEL_AI_PROVIDERS = [
  {
    name: 'claude' as const,
    displayName: 'Claude (Anthropic)',
    models: {
      summarize: 'claude-haiku-4-5-20251001',
      analyze: 'claude-sonnet-4-20250514',
    },
    serverOnly: true, // API key never sent to client
  },
] as const;
```

**Step 4: Create sentinel-features.ts**

```typescript
// src/services/sentinel-features.ts
// SENTINEL: Feature flag definitions. Imported by runtime-config.ts.

export const SENTINEL_FEATURE_IDS = [
  'aiClaude',
  'socialReddit',
  'socialTwitter',
  'socialBluesky',
  'socialYouTube',
  'socialTikTok',
  'socialVK',
  'analystJP360',
  'govNotam',
  'govSanctions',
  'trajectory',
  'predictionKalshi',
  'predictionMetaculus',
] as const;

export type SentinelFeatureId = (typeof SENTINEL_FEATURE_IDS)[number];

export const SENTINEL_DEFAULT_TOGGLES: Record<SentinelFeatureId, boolean> = {
  aiClaude: false,        // Requires API key
  socialReddit: true,
  socialTwitter: false,   // Requires TwitterAPI.io key
  socialBluesky: true,
  socialYouTube: false,   // Requires YouTube API key
  socialTikTok: false,    // Requires Apify + Railway
  socialVK: false,        // Requires VK service token
  analystJP360: false,    // Requires Claude
  govNotam: true,
  govSanctions: true,
  trajectory: true,
  predictionKalshi: true,
  predictionMetaculus: true,
};
```

**Step 5: Create sentinel-gateway-config.ts**

```typescript
// server/sentinel-gateway-config.ts
// SENTINEL: Gateway service registrations. Imported by gateway.ts.

export const SENTINEL_SERVICES = {
  claude: {
    cacheTier: 'medium', // 5min default, overridden per RPC
    rpcOverrides: {
      Summarize: { cacheTier: 'medium', ttl: 900 },  // 15min
      Analyze: { cacheTier: 'slow', ttl: 1800 },     // 30min
      Predict: { cacheTier: 'slow', ttl: 1800 },     // 30min
    },
  },
  social: {
    cacheTier: 'fast',
    rpcOverrides: {
      ListRedditPosts: { ttl: 300 },     // 5min
      ListTweets: { ttl: 60 },           // 1min
      ListBlueskyPosts: { ttl: 120 },    // 2min
      ListYouTubeVideos: { ttl: 300 },   // 5min
      ListTikTokPosts: { ttl: 600 },     // 10min
      ListVKPosts: { ttl: 300 },         // 5min
    },
  },
  analyst: { cacheTier: 'slow', ttl: 1800 },
  govdata: {
    cacheTier: 'medium',
    rpcOverrides: {
      ListNotams: { ttl: 900 },          // 15min
      ListSanctions: { ttl: 86400 },     // 24h
    },
  },
  trajectory: { cacheTier: 'slow', ttl: 3600 },
} as const;
```

**Step 6: Make minimal edits to core files**

For each core file, add ONE import line and ONE merge line. Example for `panels.ts`:

```typescript
// At top of src/config/panels.ts, add:
// SENTINEL: import sentinel panel configs
import { SENTINEL_PANELS } from './sentinel-panels';

// At the panel array export, prepend:
export const PANELS = [...SENTINEL_PANELS, ...EXISTING_PANELS];
```

Repeat pattern for `summarization.ts`, `runtime-config.ts`, `gateway.ts`. Mark each change with `// SENTINEL:` comment.

**Step 7: Commit**

```bash
git add src/config/sentinel-panels.ts src/services/sentinel-ai-config.ts \
  src/services/sentinel-features.ts server/sentinel-gateway-config.ts \
  src/config/panels.ts src/services/summarization.ts \
  src/services/runtime-config.ts server/gateway.ts
git commit -m "feat(infra): add sentinel config files with minimal core file changes"
```

### Task 0.4: Error Boundary Component

**Files:**
- Create: `src/components/SentinelErrorBoundary.tsx`

**Step 1: Read existing error handling patterns**

Read `src/components/` to see if error boundaries already exist.

**Step 2: Create error boundary**

```tsx
// src/components/SentinelErrorBoundary.tsx
import { Component, type ComponentChildren } from 'preact';

interface Props {
  fallback?: ComponentChildren;
  moduleName: string;
  children: ComponentChildren;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class SentinelErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error(`[Sentinel:${this.props.moduleName}]`, error);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div class="sentinel-error-panel">
          <p>{this.props.moduleName}: temporarily unavailable</p>
          <button onClick={() => this.setState({ hasError: false })}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

**Step 3: Commit**

```bash
git add src/components/SentinelErrorBoundary.tsx
git commit -m "feat(infra): add Preact error boundary for sentinel modules"
```

### Task 0.5: Environment & DX Setup

**Files:**
- Create: `.env.example`
- Verify: `.nvmrc` exists

**Step 1: Create .env.example**

```bash
# Omni Sentinel — Environment Variables
# Copy to .env.local and fill in values

# === Module 1: Claude AI ===
CLAUDE_API_KEY=              # Anthropic API key (required for AI features)
OPENROUTER_API_KEY=          # OpenRouter fallback key (optional)
MODULE_CLAUDE_ENABLED=true

# === Module 2: Social Media ===
REDDIT_CLIENT_ID=            # Reddit OAuth2 client ID
REDDIT_CLIENT_SECRET=        # Reddit OAuth2 client secret
MODULE_SOCIAL_REDDIT_ENABLED=true

TWITTER_ADAPTER=twitterapiio # twitterapiio | socialdata | official
TWITTERAPIIO_API_KEY=        # TwitterAPI.io key (~$0.15/1K tweets)
MODULE_SOCIAL_TWITTER_ENABLED=false

YOUTUBE_API_KEY=             # YouTube Data API v3 key (free)
MODULE_SOCIAL_YOUTUBE_ENABLED=false

BLUESKY_HANDLE=              # Optional: for authenticated requests
BLUESKY_APP_PASSWORD=        # Optional: for authenticated requests
MODULE_SOCIAL_BLUESKY_ENABLED=true

APIFY_TOKEN=                 # Apify token for TikTok scraping
MODULE_SOCIAL_TIKTOK_ENABLED=false

VK_SERVICE_TOKEN=            # VK API service token
MODULE_SOCIAL_VK_ENABLED=false

# === Module 3: JP 3-60 Analyst ===
MODULE_ANALYST_ENABLED=true  # Requires CLAUDE_API_KEY

# === Module 4: Government Data ===
FAA_API_KEY=                 # FAA NOTAM API key (free)
MODULE_GOVDATA_NOTAM_ENABLED=true
MODULE_GOVDATA_SANCTIONS_ENABLED=true

# === Module 5: Historical Trajectory ===
# OpenSky Impala DB — free for academic use, no key needed
MODULE_TRAJECTORY_ENABLED=true

# === Module 6: Prediction Markets ===
# Kalshi and Metaculus have free public APIs
MODULE_PREDICTION_KALSHI_ENABLED=true
MODULE_PREDICTION_METACULUS_ENABLED=true

# === Infrastructure ===
UPSTASH_REDIS_REST_URL=      # Upstash Redis URL
UPSTASH_REDIS_REST_TOKEN=    # Upstash Redis token
```

**Step 2: Commit**

```bash
git add .env.example
git commit -m "feat(infra): add .env.example with all module environment variables"
```

---

## Module 1: Claude AI Provider

**Goal:** Claude as primary AI provider with Haiku for summaries, Sonnet for analysis.

### Task 1.1: Proto Definitions

**Files:**
- Create: `proto/worldmonitor/claude/v1/service.proto`
- Create: `proto/worldmonitor/claude/v1/summarize.proto`
- Create: `proto/worldmonitor/claude/v1/analyze.proto`
- Create: `proto/worldmonitor/claude/v1/predict.proto`

**Step 1: Read existing proto files for pattern**

Read `proto/worldmonitor/` directory to see existing proto structure and conventions.

**Step 2: Create service.proto**

```protobuf
// proto/worldmonitor/claude/v1/service.proto
syntax = "proto3";
package worldmonitor.claude.v1;

import "worldmonitor/claude/v1/summarize.proto";
import "worldmonitor/claude/v1/analyze.proto";
import "worldmonitor/claude/v1/predict.proto";

service ClaudeService {
  rpc Summarize(SummarizeRequest) returns (SummarizeResponse);
  rpc Analyze(AnalyzeRequest) returns (AnalyzeResponse);
  rpc Predict(PredictRequest) returns (PredictResponse);
}
```

**Step 3: Create summarize.proto**

```protobuf
syntax = "proto3";
package worldmonitor.claude.v1;

message SummarizeRequest {
  repeated string headlines = 1;
  string region = 2;        // optional regional focus
  string language = 3;      // ISO 639-1 code, default "en"
}

message SummarizeResponse {
  string summary = 1;
  repeated string key_points = 2;
  string sentiment = 3;     // "positive" | "negative" | "neutral" | "mixed"
  string status = 4;        // "ok" | "error" | "cached"
  string error_message = 5; // populated when status = "error"
  int32 input_tokens = 6;
  int32 output_tokens = 7;
}
```

**Step 4: Create analyze.proto**

```protobuf
syntax = "proto3";
package worldmonitor.claude.v1;

message AnalyzeRequest {
  string query = 1;               // e.g., "Middle East tensions analysis"
  repeated string context_data = 2; // news headlines, social posts, etc.
  string region = 3;
}

message AnalyzeResponse {
  string analysis = 1;             // structured analysis text
  repeated string key_findings = 2;
  string risk_level = 3;           // "low" | "medium" | "high" | "critical"
  string status = 4;
  string error_message = 5;
  int32 input_tokens = 6;
  int32 output_tokens = 7;
}
```

**Step 5: Create predict.proto**

```protobuf
syntax = "proto3";
package worldmonitor.claude.v1;

message PredictRequest {
  string scenario = 1;             // the scenario to predict
  repeated string evidence = 2;    // supporting evidence
  string timeframe = 3;            // "7d" | "30d" | "90d"
}

message DimensionScore {
  string name = 1;
  double score = 2;                // 0.0 - 1.0
  double weight = 3;               // 0.0 - 1.0
  string reasoning = 4;
}

message PredictResponse {
  repeated DimensionScore dimensions = 1;
  double overall_probability = 2;  // 0.0 - 1.0
  string confidence = 3;           // "low" | "medium" | "high"
  string timeframe = 4;
  string narrative = 5;
  string status = 6;
  string error_message = 7;
  int32 input_tokens = 8;
  int32 output_tokens = 9;
}
```

**Step 6: Run buf generate**

```bash
buf generate proto/
```

**Step 7: Commit**

```bash
git add proto/worldmonitor/claude/
git commit -m "feat(claude): add proto definitions for Claude AI service"
```

### Task 1.2: Server Handler — Summarize

**Files:**
- Create: `server/worldmonitor/claude/v1/summarize.ts`
- Create: `server/worldmonitor/claude/v1/summarize.test.ts`

**Step 1: Read existing handler patterns**

Read an existing handler in `server/worldmonitor/` to understand the pattern (imports, request parsing, response building).

**Step 2: Write the failing test**

```typescript
// server/worldmonitor/claude/v1/summarize.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSummarize } from './summarize';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('handleSummarize', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CLAUDE_API_KEY = 'test-key';
  });

  it('returns summary from Claude API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: '{"summary":"Test summary","key_points":["point1"],"sentiment":"neutral"}' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    const result = await handleSummarize({
      headlines: ['Headline 1', 'Headline 2'],
      region: 'Middle East',
      language: 'en',
    });

    expect(result.summary).toBe('Test summary');
    expect(result.status).toBe('ok');
    expect(result.inputTokens).toBe(100);
  });

  it('returns error status when API key missing', async () => {
    delete process.env.CLAUDE_API_KEY;
    const result = await handleSummarize({ headlines: ['test'], region: '', language: 'en' });
    expect(result.status).toBe('error');
    expect(result.errorMessage).toContain('not configured');
  });

  it('returns error status on API failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' });
    const result = await handleSummarize({ headlines: ['test'], region: '', language: 'en' });
    expect(result.status).toBe('error');
  });

  it('uses Haiku model for summarization', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: '{"summary":"s","key_points":[],"sentiment":"neutral"}' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    });

    await handleSummarize({ headlines: ['test'], region: '', language: 'en' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toContain('haiku');
  });
});
```

**Step 3: Run test to verify it fails**

**Step 4: Write minimal implementation**

```typescript
// server/worldmonitor/claude/v1/summarize.ts
import { extractJson } from '../../../../src/utils/ai-response';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

interface SummarizeInput {
  headlines: string[];
  region: string;
  language: string;
}

interface SummarizeOutput {
  summary: string;
  keyPoints: string[];
  sentiment: string;
  status: string;
  errorMessage: string;
  inputTokens: number;
  outputTokens: number;
}

export async function handleSummarize(input: SummarizeInput): Promise<SummarizeOutput> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    return {
      summary: '', keyPoints: [], sentiment: '',
      status: 'error', errorMessage: 'Claude API not configured',
      inputTokens: 0, outputTokens: 0,
    };
  }

  const systemPrompt = `You are a concise news analyst. Summarize the following headlines into a brief situational overview. Focus on geopolitical and security implications.${input.region ? ` Focus on the ${input.region} region.` : ''} Respond in JSON: {"summary": "...", "key_points": ["..."], "sentiment": "positive|negative|neutral|mixed"}`;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: input.headlines.join('\n') }],
      }),
    });

    if (!response.ok) {
      return {
        summary: '', keyPoints: [], sentiment: '',
        status: 'error', errorMessage: `Claude API error: ${response.status}`,
        inputTokens: 0, outputTokens: 0,
      };
    }

    const data = await response.json();
    const text = data.content[0]?.text ?? '';
    const parsed = extractJson<{ summary: string; key_points: string[]; sentiment: string }>(text);

    return {
      summary: parsed.summary,
      keyPoints: parsed.key_points,
      sentiment: parsed.sentiment,
      status: 'ok',
      errorMessage: '',
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  } catch (err) {
    return {
      summary: '', keyPoints: [], sentiment: '',
      status: 'error', errorMessage: err instanceof Error ? err.message : 'Unknown error',
      inputTokens: 0, outputTokens: 0,
    };
  }
}
```

**Step 5: Run test to verify it passes**

**Step 6: Commit**

```bash
git add server/worldmonitor/claude/v1/summarize.ts server/worldmonitor/claude/v1/summarize.test.ts
git commit -m "feat(claude): implement Summarize handler with Haiku model"
```

### Task 1.3: Server Handler — Analyze

**Files:**
- Create: `server/worldmonitor/claude/v1/analyze.ts`
- Create: `server/worldmonitor/claude/v1/analyze.test.ts`

Follow the same TDD pattern as Task 1.2. Key differences:
- Uses **Sonnet** model (`claude-sonnet-4-20250514`) instead of Haiku
- System prompt focuses on deep geopolitical analysis
- Returns `analysis`, `keyFindings`, `riskLevel`
- Higher `max_tokens` (2048)

**Step 1: Write failing test** (similar structure to 1.2 but testing analysis-specific fields)

**Step 2: Run test to verify it fails**

**Step 3: Implement** (follow summarize.ts pattern, swap model + system prompt)

**Step 4: Run test to verify it passes**

**Step 5: Commit**

```bash
git add server/worldmonitor/claude/v1/analyze.ts server/worldmonitor/claude/v1/analyze.test.ts
git commit -m "feat(claude): implement Analyze handler with Sonnet model"
```

### Task 1.4: Server Handler — Predict (6-Dimension Scoring)

**Files:**
- Create: `server/worldmonitor/claude/v1/predict.ts`
- Create: `server/worldmonitor/claude/v1/predict.test.ts`

Key differences from Analyze:
- Uses **Sonnet** model
- System prompt implements JP 3-60 six-dimension scoring
- Response is structured `DimensionScore[]` + overall probability
- Must validate that scores are 0.0-1.0 and weights sum to 1.0

**Step 1-5:** Same TDD cycle. System prompt for prediction:

```
You are a military intelligence analyst using the JP 3-60 framework. Score the following scenario on 6 dimensions (0.0-1.0):
1. Military Readiness (20% weight)
2. Political Will (25% weight)
3. Target Urgency (20% weight)
4. Diplomatic Alternatives (15% weight) — higher = MORE alternatives = LOWER conflict probability
5. Allied Support (10% weight)
6. Provocation Level (10% weight)

Respond in JSON: {
  "dimensions": [{"name":"...","score":0.0-1.0,"weight":0.0-1.0,"reasoning":"..."}],
  "overall_probability": 0.0-1.0,
  "confidence": "low|medium|high",
  "timeframe": "...",
  "narrative": "..."
}
```

**Step 6: Commit**

```bash
git add server/worldmonitor/claude/v1/predict.ts server/worldmonitor/claude/v1/predict.test.ts
git commit -m "feat(claude): implement Predict handler with JP 3-60 dimension scoring"
```

### Task 1.5: Edge Function + Client Wrapper

**Files:**
- Create: `api/claude/v1/[rpc].ts`
- Create: `src/services/claude/index.ts`

**Step 1: Read existing edge function pattern**

Read an existing `api/*/v1/[rpc].ts` to understand the pattern (how requests are routed, how handlers are called, how responses are serialized).

**Step 2: Create Edge Function**

```typescript
// api/claude/v1/[rpc].ts
// Follow existing pattern from other api/*/v1/[rpc].ts files.
// Key additions:
// 1. Check process.env.MODULE_CLAUDE_ENABLED at top
// 2. Rate limiting: 10 req/min/IP (stricter than default)
// 3. Route Summarize/Analyze/Predict to respective handlers
```

**Step 3: Create client wrapper**

```typescript
// src/services/claude/index.ts
// Follow existing client pattern from src/services/
// Wrap generated proto client with circuit breaker
```

**Step 4: Register in sentinel-gateway-config.ts** (already done in Task 0.3)

**Step 5: Commit**

```bash
git add api/claude/v1/ src/services/claude/
git commit -m "feat(claude): add edge function and client wrapper"
```

### Task 1.6: Rate Limiting + Spend Tracking

**Files:**
- Create: `server/worldmonitor/claude/v1/rate-limit.ts`
- Create: `server/worldmonitor/claude/v1/spend-tracker.ts`

**Step 1: Implement rate limiter** using Upstash Redis (IP-based, 10 req/min for Summarize, 20 req/min for Analyze/Predict)

**Step 2: Implement spend tracker** — log `input_tokens` + `output_tokens` per call to Redis, with budget alert thresholds ($10/$25/$50)

**Step 3: Wire into edge function** (middleware pattern)

**Step 4: Commit**

```bash
git add server/worldmonitor/claude/v1/rate-limit.ts server/worldmonitor/claude/v1/spend-tracker.ts
git commit -m "feat(claude): add rate limiting and spend tracking"
```

---

## Module 2: Social Media Integration

**Goal:** Reddit, X/Twitter, Bluesky, YouTube, TikTok, VK feeds with unified SocialPost type.

### Task 2.1: Proto Definitions

**Files:**
- Create: `proto/worldmonitor/social/v1/service.proto`
- Create: `proto/worldmonitor/social/v1/common.proto`
- Create: `proto/worldmonitor/social/v1/reddit.proto`
- Create: `proto/worldmonitor/social/v1/twitter.proto`
- Create: `proto/worldmonitor/social/v1/bluesky.proto`
- Create: `proto/worldmonitor/social/v1/youtube.proto`
- Create: `proto/worldmonitor/social/v1/tiktok.proto`
- Create: `proto/worldmonitor/social/v1/vk.proto`

**Step 1: Create common.proto (unified SocialPost type)**

```protobuf
syntax = "proto3";
package worldmonitor.social.v1;

message SocialPost {
  string id = 1;
  string platform = 2;        // "reddit" | "twitter" | "bluesky" | "youtube" | "tiktok" | "vk"
  string author = 3;
  string content = 4;         // text content (sanitized, never raw HTML)
  string url = 5;
  int64 timestamp = 6;        // unix ms
  string media_url = 7;       // optional thumbnail/media
  double latitude = 8;        // optional geotag
  double longitude = 9;
  int32 engagement = 10;      // likes/upvotes/views depending on platform
  string subreddit = 11;      // reddit-only
  string hashtags = 12;       // comma-separated
}
```

**Step 2: Create service.proto + per-platform protos**

Each platform RPC takes platform-specific parameters (subreddit name, account handle, keyword) and returns `repeated SocialPost`.

**Step 3: Run buf generate**

**Step 4: Commit**

```bash
git add proto/worldmonitor/social/
git commit -m "feat(social): add proto definitions for 6 social media platforms"
```

### Task 2.2: Reddit Handler (OAuth2)

**Files:**
- Create: `server/worldmonitor/social/v1/reddit.ts`
- Create: `server/worldmonitor/social/v1/reddit.test.ts`

**Step 1: Write failing test**

Mock Reddit OAuth2 token exchange + `/r/{subreddit}/hot.json` response. Test:
- Successful post retrieval
- OAuth2 token acquisition
- Input validation (subreddit name pattern: `/^[a-zA-Z0-9_]+$/`)
- Error handling (subreddit not found, rate limited)

**Step 2: Implement**

```typescript
// Key implementation points:
// 1. OAuth2 client credentials flow: POST https://oauth.reddit.com/api/v1/access_token
// 2. Use access token for API calls: GET https://oauth.reddit.com/r/{subreddit}/hot
// 3. Cache OAuth token in memory (expires in 1h)
// 4. Map Reddit post JSON → SocialPost proto
// 5. Validate subreddit name with validateStringParam()
```

**Step 3: Commit**

```bash
git add server/worldmonitor/social/v1/reddit.ts server/worldmonitor/social/v1/reddit.test.ts
git commit -m "feat(social): implement Reddit handler with OAuth2"
```

### Task 2.3: Twitter Handler (Adapter Pattern)

**Files:**
- Create: `server/worldmonitor/social/v1/twitter.ts`
- Create: `server/worldmonitor/social/v1/twitter-adapters.ts`
- Create: `server/worldmonitor/social/v1/twitter.test.ts`

**Step 1: Define adapter interface**

```typescript
// server/worldmonitor/social/v1/twitter-adapters.ts
export interface TwitterDataSource {
  searchTweets(query: string, limit: number): Promise<TwitterRawTweet[]>;
  getUserTweets(username: string, limit: number): Promise<TwitterRawTweet[]>;
}

interface TwitterRawTweet {
  id: string;
  text: string;
  author: string;
  createdAt: string;
  likeCount: number;
  url: string;
}

// Default adapter: TwitterAPI.io
export class TwitterApiIoAdapter implements TwitterDataSource { ... }

// Fallback: SocialData
export class SocialDataAdapter implements TwitterDataSource { ... }
```

**Step 2: Write failing test** (mock adapter, test handler logic)

**Step 3: Implement handler** (select adapter based on `process.env.TWITTER_ADAPTER`)

**Step 4: Commit**

```bash
git add server/worldmonitor/social/v1/twitter.ts server/worldmonitor/social/v1/twitter-adapters.ts \
  server/worldmonitor/social/v1/twitter.test.ts
git commit -m "feat(social): implement Twitter handler with adapter pattern"
```

### Task 2.4: Bluesky Handler (AT Protocol)

**Files:**
- Create: `server/worldmonitor/social/v1/bluesky.ts`
- Create: `server/worldmonitor/social/v1/bluesky.test.ts`

Key points:
- Public API, no auth needed
- Endpoint: `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts`
- Limit cap: `Math.min(limit, 25)` — API maximum is 25
- Map AT Protocol response → SocialPost

**Step 1-5:** TDD cycle

**Step 6: Commit**

### Task 2.5: YouTube Handler (Data API v3)

**Files:**
- Create: `server/worldmonitor/social/v1/youtube.ts`
- Create: `server/worldmonitor/social/v1/youtube.test.ts`

Key points:
- YouTube Data API v3: `https://www.googleapis.com/youtube/v3/search`
- API key from `process.env.YOUTUBE_API_KEY`
- Free tier: 10,000 units/day (search = 100 units each → ~100 searches/day)
- Map YouTube search result → SocialPost (video title as content, thumbnail as media_url)

**Step 1-5:** TDD cycle

**Step 6: Commit**

### Task 2.6: TikTok Handler (Apify)

**Files:**
- Create: `server/worldmonitor/social/v1/tiktok.ts`
- Create: `server/worldmonitor/social/v1/tiktok.test.ts`

Key points:
- Uses Apify TikTok Scraper actor
- Runs on Railway worker (not Edge Function — Apify calls can be slow)
- Map Apify response → SocialPost

**Step 1-5:** TDD cycle

**Step 6: Commit**

### Task 2.7: VK Handler

**Files:**
- Create: `server/worldmonitor/social/v1/vk.ts`
- Create: `server/worldmonitor/social/v1/vk.test.ts`

Key points:
- VK API v5: `https://api.vk.com/method/wall.get`
- Service token from `process.env.VK_SERVICE_TOKEN`
- Monitor military-related public groups
- Map VK wall post → SocialPost

**Step 1-5:** TDD cycle

**Step 6: Commit**

### Task 2.8: Edge Function + Client Wrapper

**Files:**
- Create: `api/social/v1/[rpc].ts`
- Create: `src/services/social/index.ts`

Follow same pattern as Module 1 Task 1.5. Each RPC checks its own killswitch (`MODULE_SOCIAL_REDDIT_ENABLED`, etc.).

**Step 1-3:** Implement following existing patterns

**Step 4: Commit**

### Task 2.9: SocialFeedPanel Frontend

**Files:**
- Create: `src/components/SocialFeedPanel.tsx`
- Modify: `src/config/sentinel-panels.ts` (register panel)

**Step 1: Read existing TelegramIntelPanel** to understand the UI pattern

**Step 2: Create SocialFeedPanel**

```tsx
// Key features:
// - Platform filter tabs: All | Reddit | X | Bluesky | YouTube | TikTok | VK
// - Each post rendered as textContent (never innerHTML)
// - URLs sanitized with sanitizeUrl()
// - Server-side truncation (max 500 chars per post)
// - Sliding window: max 100 posts in memory, oldest removed first
// - Deduplication by post ID
// - "Loading..." / "Not configured" / "Error" states
```

**Step 3: Register in sentinel-panels.ts**

**Step 4: Commit**

```bash
git add src/components/SocialFeedPanel.tsx src/config/sentinel-panels.ts
git commit -m "feat(social): add SocialFeedPanel with platform filter tabs"
```

---

## Module 3: JP 3-60 Military Analysis Agent

**Goal:** AnalystPanel that uses Claude with JP 3-60 framework for structured military analysis.

### Task 3.1: Proto Definitions

**Files:**
- Create: `proto/worldmonitor/analyst/v1/service.proto`
- Create: `proto/worldmonitor/analyst/v1/assessment.proto`
- Create: `proto/worldmonitor/analyst/v1/prediction.proto`

**Step 1: Create protos** following patterns from Module 1

```protobuf
service AnalystService {
  rpc RunAssessment(AssessmentRequest) returns (AssessmentResponse);
  rpc GetPrediction(PredictionRequest) returns (PredictionResponse);
}
```

`AssessmentRequest` takes `query` + `region` + optional `context_data`.
`AssessmentResponse` returns the full 6-step analysis as structured text + 6-dimension scores.

**Step 2: Run buf generate**

**Step 3: Commit**

### Task 3.2: Assessment Handler

**Files:**
- Create: `server/worldmonitor/analyst/v1/assessment.ts`
- Create: `server/worldmonitor/analyst/v1/assessment.test.ts`
- Create: `server/worldmonitor/analyst/v1/jp360-prompts.ts`

**Step 1: Create JP 3-60 system prompts file**

```typescript
// server/worldmonitor/analyst/v1/jp360-prompts.ts
// Contains the system prompt that instructs Claude to follow the JP 3-60 six-step pipeline.
// Uses Anthropic prompt caching (cache_control) for the system prompt since it's static.

export const JP360_SYSTEM_PROMPT = `You are a senior military intelligence analyst...`;
// Full prompt implementing 6-step pipeline and 6-dimension scoring
```

**Step 2: Write failing test** (mock Claude API, verify structured output)

**Step 3: Implement handler** — single Claude call with JP 3-60 system prompt + user query + context data. Uses Sonnet model.

**Step 4: Add prompt caching** — pass `cache_control: { type: "ephemeral" }` on the system message to avoid re-processing the long JP 3-60 prompt.

**Step 5: Commit**

### Task 3.3: Edge Function + Client

Follow same pattern. Killswitch: `MODULE_ANALYST_ENABLED`.

### Task 3.4: AnalystPanel Frontend

**Files:**
- Create: `src/components/AnalystPanel.tsx`

**Step 1: Read existing DeductionPanel** for pattern

**Step 2: Create AnalystPanel**

```tsx
// Key features:
// - Text input for analysis query
// - Region selector dropdown
// - "Analyze" button with loading state
// - Output: structured report with 6-dimension radar chart
// - Probability display with confidence badge
// - Ethical disclaimer: "AI-generated estimate, not a prediction"
// - DataFreshnessIndicator showing cache status
```

**Step 3: Register in sentinel-panels.ts**

**Step 4: Commit**

---

## Module 4: Government Data

**Goal:** NOTAM flight restrictions + OpenSanctions entity search.

### Task 4.1: NOTAM Proto + Handler

**Files:**
- Create: `proto/worldmonitor/govdata/v1/service.proto`
- Create: `proto/worldmonitor/govdata/v1/notam.proto`
- Create: `server/worldmonitor/govdata/v1/notam.ts`
- Create: `server/worldmonitor/govdata/v1/notam.test.ts`

**Step 1: Create proto**

```protobuf
message Notam {
  string id = 1;
  string type = 2;         // "TFR" | "NOTAM" | "NAVAID"
  string description = 3;
  double latitude = 4;
  double longitude = 5;
  double radius_nm = 6;    // radius in nautical miles
  int64 effective_from = 7;
  int64 effective_to = 8;
  string source = 9;       // "FAA" | "ICAO"
}
```

**Step 2: Write failing test** (mock FAA NOTAM API response)

**Step 3: Implement** — fetch from FAA NOTAM system, parse response, map to proto

**Step 4: Commit**

### Task 4.2: Sanctions Proto + Handler

**Files:**
- Create: `proto/worldmonitor/govdata/v1/sanctions.proto`
- Create: `server/worldmonitor/govdata/v1/sanctions.ts`
- Create: `server/worldmonitor/govdata/v1/sanctions.test.ts`

Key points:
- OpenSanctions API: `https://api.opensanctions.org/search/{dataset}`
- Free API, no key needed
- Search by entity name → returns sanctioned entities
- 24h cache (sanctions data doesn't change frequently)

**Step 1-5:** TDD cycle

**Step 6: Commit**

### Task 4.3: NAVTEX Enhancement (Existing Service)

**Files:**
- Modify: existing maritime warnings service (find it first by reading codebase)

**Step 1: Read existing maritime warnings handler** — find `list-navigational-warnings.ts`

**Step 2: Enhance** with additional NAVTEX data if the existing implementation is insufficient. Minimal changes — this service already exists in upstream.

**Step 3: Commit** (only if changes needed)

### Task 4.4: Edge Function + NotamPanel Frontend

Follow standard pattern. Create `NotamPanel` with map overlay for TFR polygons.

---

## Module 5: Historical Trajectory Database

**Goal:** Flight history via OpenSky Impala DB with map rendering.

### Task 5.1: Proto Definitions

**Files:**
- Create: `proto/worldmonitor/trajectory/v1/service.proto`
- Create: `proto/worldmonitor/trajectory/v1/flight_history.proto`

```protobuf
service TrajectoryService {
  rpc QueryFlightHistory(FlightHistoryRequest) returns (FlightHistoryResponse);
}

message FlightHistoryRequest {
  string icao24 = 1;       // validated hex, 6 chars
  int64 begin = 2;         // unix timestamp
  int64 end = 3;           // unix timestamp
}

message FlightHistoryResponse {
  repeated TrajectoryPoint points = 1;
  string callsign = 2;
  string status = 3;
  string error_message = 4;
}

message TrajectoryPoint {
  double latitude = 1;
  double longitude = 2;
  double altitude = 3;      // meters
  int64 timestamp = 4;
  double velocity = 5;      // m/s
  double heading = 6;       // degrees
  bool on_ground = 7;
}
```

### Task 5.2: Flight History Handler

**Files:**
- Create: `server/worldmonitor/trajectory/v1/flight-history.ts`
- Create: `server/worldmonitor/trajectory/v1/flight-history.test.ts`

Key points:
- OpenSky REST API: `https://opensky-network.org/api/tracks/all?icao24={}&time={}`
- Free for anonymous (limited), free for registered users
- Validate icao24 with `validateHexParam(value, 'icao24', 6)`
- Downsampling with Ramer-Douglas-Peucker for long trajectories (>500 points)
- Memory limit: max 10,000 points per response

**Step 1-5:** TDD cycle

### Task 5.3: Edge Function + TrajectoryPanel Frontend

Create panel with:
- "View History" button (appears when clicking aircraft on map)
- Historical track line rendered on MapLibre
- Time slider for playback
- Downsampled trajectory for performance

---

## Module 6: Enhanced Prediction Markets

**Goal:** Add Kalshi and Metaculus alongside existing Polymarket.

### Task 6.1: Extend Existing Prediction Proto

**Files:**
- Modify: existing `proto/worldmonitor/prediction/v1/` (read first)
- Create: `server/worldmonitor/prediction/v1/kalshi.ts`
- Create: `server/worldmonitor/prediction/v1/kalshi.test.ts`
- Create: `server/worldmonitor/prediction/v1/metaculus.ts`
- Create: `server/worldmonitor/prediction/v1/metaculus.test.ts`

**Step 1: Read existing prediction service** to understand current proto + handler structure

**Step 2: Add Kalshi handler**

```typescript
// Kalshi API: https://trading-api.kalshi.com/trade-api/v2/markets
// Public API, no auth needed for market data
// Filter for geopolitical/conflict markets
```

**Step 3: Add Metaculus handler**

```typescript
// Metaculus API: https://www.metaculus.com/api2/questions/
// Public API, no auth needed
// Filter for geopolitical questions
```

**Step 4: Write tests for both**

**Step 5: Commit**

### Task 6.2: Prediction Comparison Panel (Future — v2 UI)

Create comparison view showing Polymarket vs Kalshi vs Metaculus odds side-by-side. This is a v2 feature — basic integration comes first.

---

## Module 7: Expanded RSS/News

**Goal:** Config-only changes to add missing news sources.

### Task 7.1: Audit Existing Feeds

**Files:**
- Read: `src/config/feeds.ts`
- Read: `api/rss-proxy.js`

**Step 1: Read feeds.ts** to catalog ALL existing feeds

**Step 2: Identify** which feeds from the master checklist already exist (RUSI, The Diplomat, Nikkei Asia, CSIS, Carnegie, Atlantic Council are expected to already exist)

**Step 3: Create a list** of ACTUALLY missing feeds

### Task 7.2: Add Missing Feeds

**Files:**
- Modify: `src/config/sentinel-panels.ts` or create `src/config/sentinel-feeds.ts`
- Modify: `api/rss-proxy.js` (add to ALLOWED_DOMAINS)

Feeds to add (if not already present):
- ISW (Institute for the Study of War)
- INSS (Institute for National Security Studies)
- IISS (International Institute for Strategic Studies)
- Al-Monitor
- Middle East Eye
- MIIT (China Ministry of Industry and Information Technology)
- MOFCOM (China Ministry of Commerce)
- Xinhua

**Step 1: Create sentinel-feeds.ts** with new feed configs

**Step 2: Add domains** to `api/rss-proxy.js` ALLOWED_DOMAINS

**Step 3: Commit**

```bash
git add src/config/sentinel-feeds.ts api/rss-proxy.js
git commit -m "feat(rss): add ISW, INSS, IISS, Al-Monitor and other missing feeds"
```

---

## Post-Implementation Checklist

After all modules are complete:

- [ ] Run full test suite: all tests pass
- [ ] Run `buf generate proto/` — no errors
- [ ] Verify all feature flags work (enable/disable each module)
- [ ] Verify all killswitches work (`MODULE_*_ENABLED=false`)
- [ ] Test error boundaries (simulate API failures)
- [ ] Verify fork safety: `git diff upstream/main -- src/config/panels.ts src/services/summarization.ts src/services/runtime-config.ts server/gateway.ts` shows minimal changes
- [ ] Run `git merge upstream/main` to verify no conflicts with upstream
- [ ] All i18n keys added to `src/locales/en.json`
- [ ] `.env.example` updated with all variables
- [ ] LEGAL.md reviewed for accuracy

---

*Last updated: 2026-03-04. Revision from v1 incorporating all review findings, owner decisions, and research.*
