export const CHINA_ACTIVITY_PROXY_FAMILIES = [
  'freight',
  'maritime',
  'aviation',
  'energy',
  'commodity',
  'corridor',
  'market',
] as const;

export type ChinaActivityProxyFamily = (typeof CHINA_ACTIVITY_PROXY_FAMILIES)[number];

export interface ChinaActivityProxyDefinition {
  id: string;
  label: string;
  family: ChinaActivityProxyFamily;
  decisionRationale: string;
  unit: string;
  frequency: string;
  transformation: Readonly<{
    kind: 'signed_value' | 'percentage_change';
    direction: 'same' | 'inverse';
    description: string;
  }>;
  lagRule: Readonly<{
    days: number;
    description: string;
  }>;
  alignment: Readonly<{
    window: 'latest_point_in_window';
    forwardFill: false;
    interpolate: false;
    description: string;
  }>;
  freshnessBudgetMinutes: number;
  source: Readonly<{
    publisherId: string;
    publisherName: string;
    url: string;
    provenance: string;
  }>;
}

function proxyDefinition(
  definition: ChinaActivityProxyDefinition,
): Readonly<ChinaActivityProxyDefinition> {
  return Object.freeze({
    ...definition,
    transformation: Object.freeze(definition.transformation),
    lagRule: Object.freeze(definition.lagRule),
    alignment: Object.freeze(definition.alignment),
    source: Object.freeze(definition.source),
  });
}

export const CHINA_ACTIVITY_PROXY_REGISTRY: readonly Readonly<ChinaActivityProxyDefinition>[] =
  Object.freeze([
    proxyDefinition({
      id: 'ccfi_freight_rate_change',
      label: 'China Containerized Freight Index change',
      family: 'freight',
      decisionRationale: 'Container freight-rate direction is retained as a bounded logistics-price proxy, while the panel warns that capacity shocks can move rates without matching activity.',
      unit: '% change',
      frequency: 'weekly',
      transformation: {
        kind: 'signed_value',
        direction: 'same',
        description: "Use the exchange's own published period-over-period percentage change, or the change between two period levels it published; never infer a change from a single index level.",
      },
      lagRule: {
        days: 0,
        description: 'Align to the published weekly observation without a hidden lead or lag.',
      },
      alignment: {
        window: 'latest_point_in_window',
        forwardFill: false,
        interpolate: false,
        description: 'Use only an observed weekly point inside the comparison window; never carry a rate forward.',
      },
      freshnessBudgetMinutes: 28 * 24 * 60,
      source: {
        publisherId: 'publisher:shanghai-shipping-exchange',
        publisherName: 'Shanghai Shipping Exchange',
        url: 'https://en.sse.net.cn/indices/ccfinew.jsp',
        provenance: 'Consumed from the reviewed #5578 corridor trade signal and its source envelope.',
      },
    }),
    proxyDefinition({
      id: 'portwatch_tanker_calls_trend',
      label: 'Reviewed China port activity trend',
      family: 'maritime',
      decisionRationale: 'The mean reviewed PortWatch trend delta captures broad maritime activity direction across configured China gateways without turning vessel calls into a GDP level.',
      unit: 'trend delta',
      frequency: 'daily',
      transformation: {
        kind: 'signed_value',
        direction: 'same',
        description: 'Average only explicit finite trend deltas across reviewed port nodes; positive means strengthening.',
      },
      lagRule: {
        days: 0,
        description: 'Align to each underlying port observation date with no synthetic lag.',
      },
      alignment: {
        window: 'latest_point_in_window',
        forwardFill: false,
        interpolate: false,
        description: 'Use the latest reviewed aggregate inside the window and expose missing nodes separately.',
      },
      freshnessBudgetMinutes: 10 * 24 * 60,
      source: {
        publisherId: 'publisher:imf-portwatch',
        publisherName: 'IMF PortWatch',
        url: 'https://portwatch.imf.org/',
        provenance: 'Consumed from the reviewed #5578 port condition and exact source-signal timestamps.',
      },
    }),
    proxyDefinition({
      id: 'aviation_hub_disruption_balance',
      label: 'Reviewed China aviation hub balance',
      family: 'aviation',
      decisionRationale: 'The normal-versus-disrupted balance across configured hubs is a transparent operational proxy and is not treated as passenger volume or verified output.',
      unit: 'normal minus disrupted share',
      frequency: 'intra-day',
      transformation: {
        kind: 'signed_value',
        direction: 'same',
        description: 'Compute the reviewed-hub normal share minus disrupted share; omitted hubs remain missing.',
      },
      lagRule: {
        days: 0,
        description: 'Align to the provider coverage timestamp without a hidden lead or lag.',
      },
      alignment: {
        window: 'latest_point_in_window',
        forwardFill: false,
        interpolate: false,
        description: 'Use a contemporaneous reviewed-hub snapshot only; never interpolate provider status.',
      },
      freshnessBudgetMinutes: 180,
      source: {
        publisherId: 'publisher:aviationstack',
        publisherName: 'AviationStack',
        url: 'https://aviationstack.com/',
        provenance: 'Consumed from the reviewed #5578 aviation condition with configured IATA selectors.',
      },
    }),
    proxyDefinition({
      id: 'china_energy_demand_change',
      label: 'China energy-demand change',
      family: 'energy',
      decisionRationale: 'Observed energy-demand change can corroborate industrial direction, but mere source coverage or generation mix is never converted into an activity contribution.',
      unit: '% change',
      frequency: 'monthly',
      transformation: {
        kind: 'signed_value',
        direction: 'same',
        description: 'Use an explicitly published demand change; source-availability booleans do not become zero.',
      },
      lagRule: {
        days: 30,
        description: 'Apply the documented one-month publication lag before the observation is eligible.',
      },
      alignment: {
        window: 'latest_point_in_window',
        forwardFill: false,
        interpolate: false,
        description: 'Use the latest released monthly change inside the live 210-day window; do not fill absent months.',
      },
      freshnessBudgetMinutes: 210 * 24 * 60,
      source: {
        publisherId: 'publisher:worldmonitor-energy-spine',
        publisherName: 'WorldMonitor energy spine',
        url: 'https://www.worldmonitor.app/docs/data-sources',
        provenance: 'Consumed only when the reviewed #5578 energy condition exposes a directional observed metric. The value sums TOTDEMO for the available GASOLINE, GASDIES, JETKERO, RESFUEL, and LPG products; at least three matching products are required and absolute changes above 50% are refused.',
      },
    }),
    proxyDefinition({
      id: 'china_input_commodity_change',
      label: 'China-sensitive input commodity change',
      family: 'commodity',
      decisionRationale: 'A transparent mean of China-sensitive copper and aluminium moves provides market corroboration, while the output preserves that prices also reflect global supply shocks.',
      unit: '% change',
      frequency: 'daily',
      transformation: {
        kind: 'signed_value',
        direction: 'same',
        description: 'Average finite published percentage changes for the reviewed copper and aluminium symbols.',
      },
      lagRule: {
        days: 0,
        description: 'Align to the quote snapshot timestamp without a hidden lead or lag.',
      },
      alignment: {
        window: 'latest_point_in_window',
        forwardFill: false,
        interpolate: false,
        description: 'Use only a current quote snapshot and disclose absent symbols rather than filling them.',
      },
      freshnessBudgetMinutes: 180,
      source: {
        publisherId: 'publisher:alphavantage-yahoo',
        publisherName: 'Alpha Vantage and Yahoo Finance',
        url: 'https://www.worldmonitor.app/docs/data-sources',
        provenance: 'Consumed from the canonical market commodity seed with its independent seed-health record.',
      },
    }),
    proxyDefinition({
      id: 'corridor_activity_breadth_change',
      label: 'China corridor activity-breadth change',
      family: 'corridor',
      decisionRationale: 'Change in signed source-derived activity across corridor families can show broadening or narrowing, while directional availability transitions are explicitly excluded as activity.',
      unit: 'family-count change',
      frequency: 'daily',
      transformation: {
        kind: 'signed_value',
        direction: 'same',
        description: 'Use the change in strengthening-family count minus weakening-family count versus a prior comparable snapshot; availability alone is never a value.',
      },
      lagRule: {
        days: 0,
        description: 'Align comparable corridor snapshots by their assessed timestamps with no hidden lag.',
      },
      alignment: {
        window: 'latest_point_in_window',
        forwardFill: false,
        interpolate: false,
        description: 'Require two comparable snapshots; never convert missing families into unchanged activity.',
      },
      freshnessBudgetMinutes: 72 * 60,
      source: {
        publisherId: 'publisher:worldmonitor-china-corridors',
        publisherName: 'WorldMonitor China corridor control towers',
        url: 'https://www.worldmonitor.app/docs/data-sources',
        provenance: 'Derived only from reproducible #5578 corridor snapshots whose conditions retain source provenance.',
      },
    }),
    proxyDefinition({
      id: 'sse_composite_week_change',
      label: 'SSE Composite weekly change',
      family: 'market',
      decisionRationale: 'The published weekly equity-market move is retained as a sentiment and financing proxy, not as proof of hidden real-economy activity.',
      unit: '% change',
      frequency: 'daily',
      transformation: {
        kind: 'signed_value',
        direction: 'same',
        description: 'Use the bounded weekly percentage change from the seeded SSE Composite snapshot.',
      },
      lagRule: {
        days: 0,
        description: 'Align to the market snapshot timestamp without a hidden lead or lag.',
      },
      alignment: {
        window: 'latest_point_in_window',
        forwardFill: false,
        interpolate: false,
        description: 'Use a current seeded market snapshot; do not carry a prior close series across outages.',
      },
      freshnessBudgetMinutes: 10 * 24 * 60,
      source: {
        publisherId: 'publisher:yahoo-finance',
        publisherName: 'Yahoo Finance',
        url: 'https://finance.yahoo.com/quote/000001.SS/',
        provenance: 'Consumed from the Railway-owned China country-index snapshot and its explicit fetchedAt timestamp.',
      },
    }),
  ]);
