import type { MarketServiceClientOptions } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { AviationServiceClientOptions } from '@/generated/client/worldmonitor/aviation/v1/service_client';
import type { ClimateServiceClientOptions } from '@/generated/client/worldmonitor/climate/v1/service_client';
import type { ConflictServiceClientOptions } from '@/generated/client/worldmonitor/conflict/v1/service_client';
import type { ConsumerPricesServiceClientOptions } from '@/generated/client/worldmonitor/consumer_prices/v1/service_client';
import type { CyberServiceClientOptions } from '@/generated/client/worldmonitor/cyber/v1/service_client';
import type { DisplacementServiceClientOptions } from '@/generated/client/worldmonitor/displacement/v1/service_client';
import type { EconomicServiceClientOptions } from '@/generated/client/worldmonitor/economic/v1/service_client';
import type { ForecastServiceClientOptions } from '@/generated/client/worldmonitor/forecast/v1/service_client';
import type { GivingServiceClientOptions } from '@/generated/client/worldmonitor/giving/v1/service_client';
import type { HealthServiceClientOptions } from '@/generated/client/worldmonitor/health/v1/service_client';
import type { InfrastructureServiceClientOptions } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { IntelligenceServiceClientOptions } from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import type { MaritimeServiceClientOptions } from '@/generated/client/worldmonitor/maritime/v1/service_client';
import type { MilitaryServiceClientOptions } from '@/generated/client/worldmonitor/military/v1/service_client';
import type { NaturalServiceClientOptions } from '@/generated/client/worldmonitor/natural/v1/service_client';
import type { NewsServiceClientOptions } from '@/generated/client/worldmonitor/news/v1/service_client';
import type { PositiveEventsServiceClientOptions } from '@/generated/client/worldmonitor/positive_events/v1/service_client';
import type { PredictionServiceClientOptions } from '@/generated/client/worldmonitor/prediction/v1/service_client';
import type { RadiationServiceClientOptions } from '@/generated/client/worldmonitor/radiation/v1/service_client';
import type { ResearchServiceClientOptions } from '@/generated/client/worldmonitor/research/v1/service_client';
import type { ResilienceServiceClientOptions } from '@/generated/client/worldmonitor/resilience/v1/service_client';
import type { ScorecardServiceClientOptions } from '@/generated/client/worldmonitor/scorecard/v1/service_client';
import type { SanctionsServiceClientOptions } from '@/generated/client/worldmonitor/sanctions/v1/service_client';
import type { SafetyServiceClientOptions } from '@/generated/client/worldmonitor/safety/v1/service_client';
import type { ScenarioServiceClientOptions } from '@/generated/client/worldmonitor/scenario/v1/service_client';
import type { SeismologyServiceClientOptions } from '@/generated/client/worldmonitor/seismology/v1/service_client';
import type { SupplyChainServiceClientOptions } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import type { ThermalServiceClientOptions } from '@/generated/client/worldmonitor/thermal/v1/service_client';
import type { TradeServiceClientOptions } from '@/generated/client/worldmonitor/trade/v1/service_client';
import type { UnrestServiceClientOptions } from '@/generated/client/worldmonitor/unrest/v1/service_client';
import type { WebcamServiceClientOptions } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import type { WildfireServiceClientOptions } from '@/generated/client/worldmonitor/wildfire/v1/service_client';

type AssertOptionsMatch<Canonical, Candidate> = (<T>() => T extends Canonical ? 1 : 2) extends (<T>() => T extends Candidate ? 1 : 2)
  ? (<T>() => T extends Candidate ? 1 : 2) extends (<T>() => T extends Canonical ? 1 : 2)
    ? true
    : false
  : false;

type AssertAllOptionsMatch<Checks extends readonly true[]> = Checks;

type IntentionalOptionsDrift = { readonly __intentionalOptionsDrift: unique symbol };
type IntentionalOptionsMismatch = AssertOptionsMatch<
  MarketServiceClientOptions,
  MarketServiceClientOptions & IntentionalOptionsDrift
>;

// @ts-expect-error -- an intentional mismatch must fail the same constraint used by the real guard.
export type LazyRpcClientOptionsDriftGuardRejectsMismatch = AssertAllOptionsMatch<[IntentionalOptionsMismatch]>;

/** Compile-time guard: every lazy RPC client must share the same constructor options shape. */
export type LazyRpcClientOptionsDriftChecks = AssertAllOptionsMatch<[
  AssertOptionsMatch<MarketServiceClientOptions, AviationServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, ClimateServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, ConflictServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, ConsumerPricesServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, CyberServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, DisplacementServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, EconomicServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, ForecastServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, GivingServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, HealthServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, InfrastructureServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, IntelligenceServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, MaritimeServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, MilitaryServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, NaturalServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, NewsServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, PositiveEventsServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, PredictionServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, RadiationServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, ResearchServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, ResilienceServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, ScorecardServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, SanctionsServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, SafetyServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, ScenarioServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, SeismologyServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, SupplyChainServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, ThermalServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, TradeServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, UnrestServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, WebcamServiceClientOptions>,
  AssertOptionsMatch<MarketServiceClientOptions, WildfireServiceClientOptions>,
]>;

export type LazyRpcClientOptionsDriftChecksPass = LazyRpcClientOptionsDriftChecks[number];
