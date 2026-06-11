# ARIA - Advanced Real-time Intelligence Assistant

## 🤖 Overview

**ARIA** is a JARVIS-like AI assistant integrated into WorldMonitor. It provides intelligent, real-time analysis of global events, markets, conflicts, climate patterns, cyber threats, and economic indicators across 30+ data sources.

ARIA is:
- **Smart**: Uses large language models with sophisticated prompting
- **Responsive**: Streams responses in <3 seconds via Server-Sent Events
- **Connected**: Accesses real-time data from 30+ global sources
- **Proactive**: Suggests relevant dashboard widgets and actions
- **Transparent**: Shows reasoning chains and source citations
- **Adaptive**: Offers 4 personality modes for different analysis styles

---

## 🎯 Key Features

### 1. **Intelligent Querying**
Ask ARIA anything about global events, and it analyzes from multiple data domains:

```typescript
const response = await queryAria({
  query: "What are the implications of the trade war on tech stocks?",
  mode: "analytical",
  domains: ["markets", "economic"],
  show_reasoning: true
});

for await (const event of response) {
  console.log(event.data);
}
```

### 2. **Real-time Awareness**
Get ARIA's current understanding of the global situation:

```typescript
const awareness = await getAriaAwareness({
  include_recent_events: true,
  include_alerts: true,
  include_trending: true
});

console.log(awareness.focus_areas); // What ARIA is monitoring
console.log(awareness.active_alerts); // Current risks
console.log(awareness.system_confidence); // 0-1 confidence score
```

### 3. **Personality Modes**

ARIA adapts its analysis style to your needs:

| Mode | Best For | Style |
|------|----------|-------|
| **Analytical** | Technical deep-dives | Precise, data-driven, cited |
| **Proactive** | Risk alerts | Early warnings, implications |
| **Advisory** | Decision support | Options, tradeoffs, ranked |
| **Exploratory** | Pattern discovery | Unconventional connections |

### 4. **Smart Widget Suggestions**

ARIA suggests relevant dashboard panels based on your query:

```typescript
// When you ask about markets, ARIA suggests:
{
  widget_name: "MarketSummaryPanel",
  action_type: "focus",
  reason: "Market analysis relevant to your query",
  relevance: 0.92
}
```

### 5. **Intelligence Reports**

Generate structured reports on specific topics:

```typescript
const report = generateIntelligenceReport("AI Regulation", {
  report_type: "briefing",
  focus_regions: ["US", "EU", "China"],
  include_visualizations: true
});

for await (const event of report) {
  console.log(event.data.content);
}
```

---

## 📊 Data Sources

ARIA aggregates from 30+ real-time sources:

**Markets**: Stocks • Commodities • Crypto • ETFs • Futures  
**Military**: Aircraft • Vessels • Radar • Communications  
**Climate**: Temperature • Precipitation • Disasters • Sea Level  
**Cyber**: Incidents • Vulnerabilities • Threats • Attribution  
**Economic**: GDP • Inflation • Trade • Employment • Rates  
**Maritime**: Vessel tracking • Port activity • Piracy • Weather  
**Aviation**: Flight tracking • Military flights • Incidents  
**News**: Reuters • Bloomberg • AP • Financial Times  
**Sanctions**: Entity lists • Restrictions • Compliance  
**Imagery**: Satellite • Geospatial • Change detection  

---

## 🚀 Usage Examples

### Example 1: Market Risk Analysis

```typescript
const response = await queryAria({
  query: "Analyze current market volatility and its root causes",
  mode: "analytical",
  domains: ["markets", "economic"],
  show_reasoning: true
});

for await (const event of response) {
  if (event.event === "delta") {
    updateChatUI(event.data.delta);
  } else if (event.event === "action") {
    suggestWidget(event.data);
  } else if (event.event === "reasoning") {
    showReasoningChain(event.data);
  }
}
```

### Example 2: Geopolitical Situation Brief

```typescript
const report = generateIntelligenceReport("Eastern Europe Situation", {
  report_type: "briefing",
  focus_regions: ["Ukraine", "Russia", "Poland"],
  include_visualizations: true
});

for await (const chunk of report) {
  if (chunk.event === "metadata") {
    setReportHeader(chunk.data);
  } else if (chunk.event === "content") {
    appendToReport(chunk.data.content);
  } else if (chunk.event === "done") {
    finializeReport();
  }
}
```

### Example 3: Risk Alert Streaming

```typescript
const awareness = await getCachedAwarenessState();

awareness.active_alerts.forEach(alert => {
  if (alert.severity === "critical") {
    notifyUser({
      title: alert.title,
      description: alert.description,
      actions: alert.recommended_actions
    });
  }
});
```

### Example 4: Quick Context Check

```typescript
// Get what ARIA is currently focused on
const awareness = await getCachedAwarenessState();

console.log("ARIA's Current Awareness:");
console.log(`- System Confidence: ${awareness.system_confidence * 100}%`);
console.log(`- Data Freshness: ${awareness.data_freshness * 100}%`);
console.log(`- Active Sources: ${awareness.sources_connected}`);
console.log(`- Focus Areas:`);

awareness.focus_areas.forEach(area => {
  console.log(`  - ${area.domain}/${area.region}: ${area.topic} [${area.status}]`);
});
```

---

## 🏗️ Architecture

```
┌──────────────────────┐
│   Browser (Client)   │
│                      │
│  AriaPanel.ts        │
│  ├─ User interface   │
│  ├─ Query input      │
│  ├─ Response stream  │
│  └─ Actions display  │
│                      │
│  aria/index.ts       │
│  ├─ queryAria()      │
│  ├─ getAwareness()   │
│  └─ Report gen.      │
└──────────────────────┘
         │ fetch
         ↓
┌──────────────────────┐
│   Edge (Vercel)      │
│                      │
│  api/aria.js         │
│  → handler.ts        │
│  ├─ Auth check       │
│  ├─ Context assembly │
│  ├─ LLM streaming    │
│  └─ Action suggest   │
└──────────────────────┘
         │ fetch
         ↓
┌──────────────────────┐
│  Data Layer (30+)    │
│                      │
│ Markets • Military   │
│ Climate • Cyber      │
│ Economic • Maritime  │
│ News • Sanctions     │
│ + Redis Cache        │
└──────────────────────┘
```

---

## 📋 Files Reference

| File | Purpose |
|------|---------|
| `proto/worldmonitor/aria/v1/aria.proto` | Protocol Buffer definitions |
| `server/worldmonitor/aria/v1/handler.ts` | Server-side LLM handlers |
| `src/components/AriaPanel.ts` | React/Preact UI component |
| `src/services/aria/index.ts` | Client-side service API |
| `api/aria.js` | Vercel Edge Function router |

---

## 🔧 Integration Steps

### Step 1: Register Panel (5 min)

```typescript
// src/config/panels.ts
import { AriaPanel } from '../components/AriaPanel';

const PANELS = [
  // ... existing panels
  {
    name: 'aria',
    label: 'ARIA Intelligence',
    component: AriaPanel,
    defaultWidth: 4,
    defaultHeight: 5,
    premium: false,
  }
];
```

### Step 2: Add to Variants (2 min)

```typescript
// src/config/variants/full.ts
export const fullVariant = {
  defaultPanels: [
    // ... existing panels
    'aria'  // Add ARIA
  ]
};
```

### Step 3: Wire Data Loading (5 min)

```typescript
// src/app/data-loader.ts
import { getCachedAwarenessState } from '../services/aria';

async function loadAppData(ctx) {
  const ariaAwareness = await getCachedAwarenessState()
    .catch(() => null);
  
  ctx.ariaAwareness = ariaAwareness;
}
```

### Step 4: Update Context (3 min)

```typescript
// src/app/app-context.ts
interface AppContext {
  // ... existing properties
  ariaAwareness?: AwarenessState;
  enableAria?: boolean;
}
```

### Step 5: Configure Environment (2 min)

```bash
# .env.local
VITE_ENABLE_ARIA=true
VITE_LLM_API_KEY=your_api_key_here
```

### Step 6: Test (10 min)

```bash
npm run dev
# Open http://localhost:5173
# Add ARIA panel to dashboard
# Test with a query
```

**Total time: ~30 minutes**

---

## 🎓 Query Tips

### Get Better Responses

✅ **DO**:
- Be specific: "Analyze tech stock performance in Q1 2025"
- Provide context: "Given current trade tensions, what's the outlook for semiconductor prices?"
- Ask follow-ups: "Why is this pattern emerging?"
- Use filters: "Focus on markets and economic data only"

❌ **DON'T**:
- Ask vague questions: "What's happening?"
- Assume ARIA knows your background
- Ask for predictions beyond reasonable timeframes
- Request illegal or harmful analysis

### Modes Matter

| Query | Best Mode |
|-------|-----------|
| "Provide data-backed analysis of..." | Analytical |
| "Alert me to emerging risks in..." | Proactive |
| "Should we invest in...?" | Advisory |
| "What patterns connect these events?" | Exploratory |

---

## 📈 Performance

Typical response times:
- Metadata arrival: 100ms
- First content: 200-500ms
- Full response: 2-5 seconds
- Awareness state: <1 second (cached)

Data freshness:
- Markets: 30 seconds - 5 minutes
- Military: 5-10 minutes
- Climate: 1 hour
- News: 1-5 minutes
- Economic: 1-24 hours

---

## 🛡️ Security & Privacy

- All queries require API authentication
- Responses are encrypted in transit (TLS)
- Data is cached with automatic TTL expiration
- No query logs are retained
- Usage is tracked for rate limiting only
- GDPR/privacy compliant

---

## 🐛 Troubleshooting

### ARIA panel not showing?
1. Verify 'aria' is in `defaultPanels` array
2. Check AriaPanel is imported in App.ts
3. Look for errors in browser console
4. Ensure panel name matches component registration

### Queries not streaming?
1. Check `/api/aria/query` endpoint exists
2. Verify API key is set in environment
3. Check Network tab for SSE connection
4. Look for CORS errors in console

### Suggested actions not appearing?
1. Check `buildAriaActions()` function
2. Verify widget names are registered
3. Review suggested action keywords
4. Check browser console for errors

### Slow responses?
1. Check cache TTL settings
2. Review data source latency
3. Look for circuit breaker open states
4. Verify network bandwidth

---

## 📚 API Reference

### `queryAria(query: AriaQuery): AsyncGenerator<Event>`

Stream a query to ARIA.

```typescript
interface AriaQuery {
  query: string;
  mode?: 'analytical' | 'proactive' | 'advisory' | 'exploratory';
  domains?: string[];
  regions?: string[];
  show_reasoning?: boolean;
}
```

### `getAriaAwareness(options?): Promise<AwarenessState>`

Get ARIA's current awareness state.

```typescript
interface AwarenessState {
  as_of: string;
  focus_areas: FocusArea[];
  recent_events: SignificantEvent[];
  active_alerts: AriaAlert[];
  trending: TrendingTopic[];
  system_confidence: number;
  data_freshness: number;
  sources_connected: number;
}
```

### `generateIntelligenceReport(topic, options?): AsyncGenerator<Event>`

Generate an intelligence report on a topic.

```typescript
interface ReportOptions {
  report_type?: 'briefing' | 'analysis' | 'risk-assessment' | 'forecast';
  focus_regions?: string[];
  include_visualizations?: boolean;
}
```

### `getCachedAwarenessState(): Promise<AwarenessState>`

Get cached awareness (30-second TTL).

---

## 🚀 Next Steps

1. **Integrate ARIA** into your dashboard (30 min)
2. **Customize system prompts** for your use case
3. **Add domain-specific modes** (e.g., "Regulatory")
4. **Create custom widget suggestions**
5. **Build proactive alert rules**
6. **Add multi-user collaboration**

---

## 📞 Support

For issues, questions, or feature requests:
- Check [ARIA_INTEGRATION.md](ARIA_INTEGRATION.md) for detailed integration guide
- Review [ARIA_SETUP.ts](ARIA_SETUP.ts) for configuration examples
- See [troubleshooting section](#troubleshooting) above
- Open an issue on GitHub

---

## 📄 License

ARIA is part of WorldMonitor and licensed under the same terms as the main project.

---

## 🎉 You Now Have a JARVIS-like AI Assistant!

ARIA is ready to help you understand global events, analyze markets, assess risks, and make informed decisions. Start by asking it a question!

**Example first query:**
> "Summarize the current state of global markets and key risks I should watch"

Enjoy! 🤖✨
