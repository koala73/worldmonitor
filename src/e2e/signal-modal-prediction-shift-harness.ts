import '../styles/main.css';
import { SignalModal } from '@/components/SignalModal';
import { initI18n } from '@/services/i18n';
import {
  analyzeCorrelationsCore,
  type CorrelationSignalCore,
  type PredictionMarketCore,
} from '@/services/analysis-core';

declare global {
  interface Window {
    __predictionShiftHarness?: { ready: boolean; sign: 'before' | 'after' };
  }
}

const MARKET = 'Will the central bank of Atlantis raise rates this year?';

function runTwoSnapshots(
  before: PredictionMarketCore[],
  after: PredictionMarketCore[],
): CorrelationSignalCore[] {
  const seen = new Set<string>();
  const isRecentDuplicate = (key: string) => seen.has(key);
  const markSignalSeen = (key: string) => { seen.add(key); };
  const getSourceType = () => 'other' as const;
  const first = analyzeCorrelationsCore([], before, [], null, getSourceType, isRecentDuplicate, markSignalSeen);
  const second = analyzeCorrelationsCore([], after, [], first.snapshot, getSourceType, isRecentDuplicate, markSignalSeen);
  return second.signals.filter(signal => signal.type === 'prediction_leads_news');
}

await initI18n({ waitForFullTranslation: true });

const params = new URLSearchParams(location.search);
const sign = params.get('sign') === 'before' ? 'before' : 'after';
const [signal] = runTwoSnapshots(
  [{ title: MARKET, yesPrice: 40 }],
  [{ title: MARKET, yesPrice: 30 }],
);
if (!signal) throw new Error('expected a prediction_leads_news signal for 40 → 30');

if (sign === 'before') {
  // Pre-#8868: Math.abs then a '+' test made every move read as a rise.
  signal.description = `"${MARKET.slice(0, 60)}..." moved +10.0% with low news coverage`;
  signal.data.predictionShift = 10;
}

document.body.style.background = 'var(--bg, #0a0a0a)';
document.documentElement.dataset.wmHarnessReady = 'true';
window.__predictionShiftHarness = { ready: true, sign };

new SignalModal().showSignal(signal);
