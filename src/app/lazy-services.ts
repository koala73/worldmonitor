export type SignalAggregator = typeof import('@/services/signal-aggregator').signalAggregator;

let signalAggregatorPromise: Promise<SignalAggregator> | null = null;

export function getSignalAggregator(): Promise<SignalAggregator> {
  signalAggregatorPromise ??= import('@/services/signal-aggregator')
    .then(module => module.signalAggregator)
    .catch((err) => {
      signalAggregatorPromise = null;
      throw err;
    });
  return signalAggregatorPromise;
}
