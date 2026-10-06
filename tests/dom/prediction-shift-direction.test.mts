/**
 * The "Prediction Market Shift" signal (#8868) described every move as a rise:
 * `analyzeCorrelationsCore` took `Math.abs` of the price change before both the
 * `+` test and `data.predictionShift`, so a market that fell from 40 to 30 read
 * "moved +10.0%" and consumers could not recover the direction. Markets were
 * also keyed by a 50-character title prefix, so dated variants of one question
 * could be compared against each other's previous price.
 *
 * It lives under tests/dom because analysis-core pulls in `@/services/i18n`,
 * which needs Vite's `import.meta.glob` and cannot load under `tsx --test`.
 */
import { describe, expect, it } from 'vitest';

import {
  analyzeCorrelationsCore,
  predictionMarketKey,
  type CorrelationSignalCore,
  type PredictionMarketCore,
  type StreamSnapshot,
} from '@/services/analysis-core';

function runSnapshots(polls: PredictionMarketCore[][]): CorrelationSignalCore[] {
  const seen = new Set<string>();
  const isRecentDuplicate = (key: string) => seen.has(key);
  const markSignalSeen = (key: string) => { seen.add(key); };
  const getSourceType = () => 'other' as const;

  let snapshot: StreamSnapshot | null = null;
  const signals: CorrelationSignalCore[] = [];
  for (const poll of polls) {
    const result = analyzeCorrelationsCore([], poll, [], snapshot, getSourceType, isRecentDuplicate, markSignalSeen);
    snapshot = result.snapshot;
    signals.push(...result.signals.filter(signal => signal.type === 'prediction_leads_news'));
  }
  return signals;
}

function runTwoSnapshots(
  before: PredictionMarketCore[],
  after: PredictionMarketCore[],
): CorrelationSignalCore[] {
  return runSnapshots([before, after]);
}

const MARKET = 'Will the central bank of Atlantis raise rates this year?';

describe('prediction-market shift direction (#8868)', () => {
  it('reports a fall as a negative signed delta in the description and data', () => {
    const [signal, ...rest] = runTwoSnapshots(
      [{ title: MARKET, yesPrice: 40 }],
      [{ title: MARKET, yesPrice: 30 }],
    );
    expect(rest).toEqual([]);
    expect(signal).toBeDefined();
    expect(signal!.data.predictionShift).toBe(-10);
    expect(signal!.description).toContain('moved -10.0%');
    expect(signal!.description).not.toContain('+');
  });

  it('reports a rise as a positive signed delta', () => {
    const [signal] = runTwoSnapshots(
      [{ title: MARKET, yesPrice: 30 }],
      [{ title: MARKET, yesPrice: 40 }],
    );
    expect(signal).toBeDefined();
    expect(signal!.data.predictionShift).toBe(10);
    expect(signal!.description).toContain('moved +10.0%');
  });

  it('applies the threshold to the magnitude in both directions', () => {
    expect(runTwoSnapshots([{ title: MARKET, yesPrice: 40 }], [{ title: MARKET, yesPrice: 37 }])).toEqual([]);
    expect(runTwoSnapshots([{ title: MARKET, yesPrice: 40 }], [{ title: MARKET, yesPrice: 43 }])).toEqual([]);
  });

  it('does not compare dated variants that share a 50-character prefix and event URL', () => {
    const url = 'https://polymarket.com/event/atlantis-ceasefire';
    const march = 'Will Atlantis and Lemuria sign a ceasefire agreement by March 31, 2027?';
    const june = 'Will Atlantis and Lemuria sign a ceasefire agreement by June 30, 2027?';
    // Precondition: the old title-prefix key could not tell these apart.
    expect(march.slice(0, 50)).toBe(june.slice(0, 50));
    expect(predictionMarketKey({ title: march, url })).not.toBe(predictionMarketKey({ title: june, url }));

    const signals = runTwoSnapshots(
      [{ title: march, yesPrice: 40, url }, { title: june, yesPrice: 70, url }],
      [{ title: march, yesPrice: 41, url }, { title: june, yesPrice: 71, url }],
    );
    // Each market moved one point against its own previous price; neither
    // crossed the threshold, so no shift may be reported.
    expect(signals).toEqual([]);
  });

  it('emits both alerts when an equally sized rise reverses', () => {
    const signals = runSnapshots([
      [{ title: MARKET, yesPrice: 30 }],
      [{ title: MARKET, yesPrice: 40 }],
      [{ title: MARKET, yesPrice: 30 }],
    ]);
    expect(signals.map(signal => signal.data.predictionShift)).toEqual([10, -10]);
    expect(signals[0]!.description).toContain('moved +10.0%');
    expect(signals[1]!.description).toContain('moved -10.0%');
  });

  it('still compares prices when a unique title later gains a URL', () => {
    const url = 'https://polymarket.com/event/atlantis-rates';
    const [signal, ...rest] = runTwoSnapshots(
      [{ title: MARKET, yesPrice: 40 }],
      [{ title: MARKET, yesPrice: 30, url }],
    );
    expect(rest).toEqual([]);
    expect(signal!.data.predictionShift).toBe(-10);
  });

  it('still compares prices when a unique title later loses a URL', () => {
    const url = 'https://polymarket.com/event/atlantis-rates';
    const [signal, ...rest] = runTwoSnapshots(
      [{ title: MARKET, yesPrice: 40, url }],
      [{ title: MARKET, yesPrice: 30 }],
    );
    expect(rest).toEqual([]);
    expect(signal!.data.predictionShift).toBe(-10);
  });
});
