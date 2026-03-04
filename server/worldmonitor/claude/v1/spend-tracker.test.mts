import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { trackUsage, getDailySpend, isBudgetExceeded, _resetForTesting } from './spend-tracker.ts';

describe('spend-tracker', () => {
  const originalBudget = process.env.CLAUDE_DAILY_BUDGET_USD;

  beforeEach(() => {
    _resetForTesting();
  });

  afterEach(() => {
    if (originalBudget !== undefined) {
      process.env.CLAUDE_DAILY_BUDGET_USD = originalBudget;
    } else {
      delete process.env.CLAUDE_DAILY_BUDGET_USD;
    }
  });

  it('starts with zero spend', () => {
    assert.strictEqual(getDailySpend(), 0);
  });

  it('tracks haiku usage correctly', () => {
    // Haiku: $0.80/MTok input, $4/MTok output
    // 1000 input + 500 output = 0.001 * 0.80 + 0.0005 * 4.0 = 0.0008 + 0.002 = 0.0028
    trackUsage(1000, 500, 'haiku');
    const spend = getDailySpend();
    assert.ok(Math.abs(spend - 0.0028) < 0.0001, `Expected ~$0.0028, got $${spend}`);
  });

  it('tracks sonnet usage correctly', () => {
    // Sonnet: $3/MTok input, $15/MTok output
    // 1000 input + 500 output = 0.001 * 3 + 0.0005 * 15 = 0.003 + 0.0075 = 0.0105
    trackUsage(1000, 500, 'sonnet');
    const spend = getDailySpend();
    assert.ok(Math.abs(spend - 0.0105) < 0.0001, `Expected ~$0.0105, got $${spend}`);
  });

  it('accumulates multiple usage records', () => {
    trackUsage(1000, 500, 'haiku');
    trackUsage(1000, 500, 'sonnet');
    const spend = getDailySpend();
    assert.ok(spend > 0.01, `Expected > $0.01, got $${spend}`);
  });

  it('isBudgetExceeded returns false when under default budget', () => {
    delete process.env.CLAUDE_DAILY_BUDGET_USD;
    trackUsage(1000, 500, 'haiku');
    assert.strictEqual(isBudgetExceeded(), false);
  });

  it('isBudgetExceeded returns true when over custom budget', () => {
    process.env.CLAUDE_DAILY_BUDGET_USD = '0.001';
    trackUsage(1000, 500, 'sonnet'); // ~$0.0105, over $0.001
    assert.strictEqual(isBudgetExceeded(), true);
  });

  it('isBudgetExceeded uses default budget of $25 when env not set', () => {
    delete process.env.CLAUDE_DAILY_BUDGET_USD;
    // Even large usage shouldn't hit $25
    trackUsage(100000, 50000, 'sonnet'); // ~$1.05
    assert.strictEqual(isBudgetExceeded(), false);
  });
});
