// Haiku pricing: $0.80/MTok input, $4/MTok output
// Sonnet pricing: $3/MTok input, $15/MTok output
const PRICING = {
  haiku:  { input: 0.80 / 1_000_000, output: 4.0 / 1_000_000 },
  sonnet: { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
};

interface UsageRecord { inputTokens: number; outputTokens: number; model: 'haiku' | 'sonnet'; costUsd: number; timestamp: number; }

// In-memory daily tracker (reset at midnight UTC)
let dailyRecords: UsageRecord[] = [];
let lastResetDate = '';

function resetIfNewDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) { dailyRecords = []; lastResetDate = today; }
}

export function trackUsage(inputTokens: number, outputTokens: number, model: 'haiku' | 'sonnet'): void {
  resetIfNewDay();
  const pricing = PRICING[model];
  const costUsd = inputTokens * pricing.input + outputTokens * pricing.output;
  dailyRecords.push({ inputTokens, outputTokens, model, costUsd, timestamp: Date.now() });
  const totalToday = dailyRecords.reduce((s, r) => s + r.costUsd, 0);
  if (totalToday > 10) console.warn(`[Claude] Daily spend alert: $${totalToday.toFixed(2)} (>$10)`);
  if (totalToday > 25) console.warn(`[Claude] Daily spend WARNING: $${totalToday.toFixed(2)} (>$25)`);
  if (totalToday > 50) console.error(`[Claude] Daily spend CRITICAL: $${totalToday.toFixed(2)} (>$50)`);
}

export function getDailySpend(): number {
  resetIfNewDay();
  return dailyRecords.reduce((s, r) => s + r.costUsd, 0);
}

export function isBudgetExceeded(): boolean {
  const budgetStr = process.env.CLAUDE_DAILY_BUDGET_USD;
  const budget = budgetStr ? parseFloat(budgetStr) : 25;
  return getDailySpend() >= budget;
}

// Exported for testing
export function _resetForTesting(): void {
  dailyRecords = [];
  lastResetDate = '';
}
