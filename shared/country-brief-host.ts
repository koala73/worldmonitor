import { z } from 'zod';
import { BRIEF_TOPICS } from './country-brief-sections';
import { panelReceiptSchema } from './panel-admission';
import { resolveCountryCode } from './country-code-resolve';
import { RAW_SIGNAL_PATH } from './country-raw-signals';

const signalCountryNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
// Intl includes named organizations, statistical regions and test locales as well as countries/territories.
const nonCountrySignalRegions = new Set(['EU', 'UN', 'EZ', 'QO', 'XA', 'XB', 'XX', 'ZZ']);
const signalCountryCode = z.string().regex(/^[A-Z]{2}$/).refine(code => resolveCountryCode(code) === code && !nonCountrySignalRegions.has(code) && signalCountryNames.of(code) !== undefined, 'Unrecognized country');

export const panelAdmissionSchema = panelReceiptSchema.extend({ countryCode: z.string().regex(/^[A-Z]{2}$/) });
export type PanelAdmission = z.infer<typeof panelAdmissionSchema>;

export const countryViewSchema = z.object({
  country_code: z.string().min(2).max(100),
  refresh: z.boolean().default(false),
  request_id: z.string().uuid().optional(),
  topic: z.enum(Object.keys(BRIEF_TOPICS) as [keyof typeof BRIEF_TOPICS, ...Array<keyof typeof BRIEF_TOPICS>]).default('overview'),
}).strict();

const activityBoundsSchema = {
  ne_lat: z.coerce.number().min(-90).max(90).default(0),
  ne_lon: z.coerce.number().min(-180).max(180).default(0),
  sw_lat: z.coerce.number().min(-90).max(90).default(0),
  sw_lon: z.coerce.number().min(-180).max(180).default(0),
};

export const COUNTRY_READERS = {
  signalsRaw: { path: RAW_SIGNAL_PATH, args: z.object({ country_code: signalCountryCode }).strict() },
  flights: { path: '/api/military/v1/list-military-flights', args: z.object({ ...activityBoundsSchema, page_size: z.coerce.number().int().min(100).max(100).default(100), operator: z.literal('MILITARY_OPERATOR_UNSPECIFIED').default('MILITARY_OPERATOR_UNSPECIFIED'), aircraft_type: z.literal('MILITARY_AIRCRAFT_TYPE_UNSPECIFIED').default('MILITARY_AIRCRAFT_TYPE_UNSPECIFIED'), cursor: z.string().max(200).default('') }).strict() },
  vessels: { path: '/api/maritime/v1/get-vessel-snapshot', args: z.object({ ne_lat: z.coerce.number().pipe(z.literal(0)).default(0), ne_lon: z.coerce.number().pipe(z.literal(0)).default(0), sw_lat: z.coerce.number().pipe(z.literal(0)).default(0), sw_lon: z.coerce.number().pipe(z.literal(0)).default(0), include_candidates: z.literal('true').default('true') }).strict() },
  fleet: { path: '/api/military/v1/get-usni-fleet-report', args: z.object({ }).strict() },
  facts: { path: '/api/intelligence/v1/get-country-facts', args: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/) }).strict() },
  energy: { path: '/api/intelligence/v1/get-country-energy-profile', args: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/) }).strict() },
  maritime: { path: '/api/intelligence/v1/get-country-port-activity', args: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/) }).strict() },
  risk: { path: '/api/intelligence/v1/get-country-risk', args: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/) }).strict() },
  stock: { path: '/api/market/v1/get-country-stock-index', args: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/) }).strict() },
  food: { path: '/api/resilience/v1/get-food-stocks', args: z.object({ countryCode: z.string().regex(/^(?:[A-Z]{2}|WORLD)$/), commodity: z.string().max(40).default('') }).strict() },
  demographics: { path: '/api/resilience/v1/get-demographics-capability', args: z.object({ countryCode: z.string().regex(/^[A-Z]{2}$/) }).strict() },
  resilience: { path: '/api/resilience/v1/get-resilience-score', args: z.object({ countryCode: z.string().regex(/^[A-Z]{2}$/) }).strict() },
  factors: { path: '/api/scorecard/v1/get-five-factor-scorecard', args: z.object({ countryCode: z.string().regex(/^[A-Z]{2}$/) }).strict() },
  debt: { path: '/api/economic/v1/get-national-debt', args: z.object({  }).strict() },
  flows: { path: '/api/trade/v1/list-comtrade-flows', args: z.object({ reporter_code: z.string().regex(/^\d{1,3}$/), cmd_code: z.string().regex(/^\d{0,6}$/).default(''), anomalies_only: z.enum(['true', 'false']).default('false') }).strict() },
  tariffs: { path: '/api/trade/v1/get-tariff-trends', args: z.object({ reporting_country: z.string().regex(/^\d{1,3}$/), product_sector: z.string().max(20).default(''), years: z.coerce.number().int().min(1).max(10).default(10), partner_country: z.string().regex(/^\d{0,3}$/).default('') }).strict() },
  products: { path: '/api/supply-chain/v1/get-country-products', args: z.object({ iso2: z.string().regex(/^[A-Z]{2}$/), hs4: z.string().regex(/^\d{4}$/).optional() }).strict() },
  commodities: { path: '/api/supply-chain/v1/get-country-vulnerabilities', args: z.object({ iso2: z.string().regex(/^[A-Z]{2}$/) }).strict() },
  exposure: { path: '/api/supply-chain/v1/get-country-chokepoint-index', args: z.object({ iso2: z.string().regex(/^[A-Z]{2}$/), hs2: z.enum(['27', '84', '85', '87', '30', '72', '39', '29', '10', '62']) }).strict() },
  dependency: { path: '/api/supply-chain/v1/get-sector-dependency', args: z.object({ iso2: z.string().regex(/^[A-Z]{2}$/), hs2: z.enum(['27', '84', '85', '87', '30', '72', '39', '29', '10', '62']) }).strict() },
  bypass: { path: '/api/supply-chain/v1/get-bypass-options', args: z.object({ chokepointId: z.string().regex(/^[a-z0-9_-]{1,80}$/), cargoType: z.enum(['container', 'tanker', 'bulk']).default('container'), closurePct: z.coerce.number().min(0).max(100).default(0) }).strict() },
  chokepoints: { path: '/api/supply-chain/v1/get-chokepoint-status', args: z.object({  }).strict() },
  cost: { path: '/api/supply-chain/v1/get-multi-sector-cost-shock', args: z.object({ iso2: z.string().regex(/^[A-Z]{2}$/), chokepointId: z.string().regex(/^[a-z0-9_-]{1,80}$/), closureDays: z.coerce.number().int().min(1).max(365).default(30) }).strict() },
  pipelines: { path: '/api/supply-chain/v1/list-pipelines', args: z.object({ commodityType: z.literal('').default('') }).strict() },
  facilities: { path: '/api/supply-chain/v1/list-storage-facilities', args: z.object({ facilityType: z.literal('').default('') }).strict() },
  shortages: { path: '/api/supply-chain/v1/list-fuel-shortages', args: z.object({ country: z.literal('').default(''), product: z.literal('').default(''), severity: z.literal('').default('') }).strict() },
  pipelineDetail: { path: '/api/supply-chain/v1/get-pipeline-detail', args: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/), pipelineId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict() },
  facilityDetail: { path: '/api/supply-chain/v1/get-storage-facility-detail', args: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/), facilityId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict() },
  shortageDetail: { path: '/api/supply-chain/v1/get-fuel-shortage-detail', args: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/), shortageId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict() },
  disruptions: { path: '/api/supply-chain/v1/list-energy-disruptions', args: z.object({ assetId: z.literal('').default(''), assetType: z.literal('').default(''), ongoingOnly: z.enum(['true', 'false']).default('false') }).strict() },
  scenario: { path: '/api/intelligence/v1/compute-energy-shock', args: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/), chokepoint_id: z.string().regex(/^[a-z0-9_-]{1,80}$/), disruption_pct: z.coerce.number().min(0).max(100).default(0), fuel_mode: z.enum(['both', 'oil', 'gas']).default('oil') }).strict() },
  defense: { path: '/api/military/v1/get-defense-industrial-base', args: z.object({ country_code: z.string().regex(/^[A-Z]{2}$/) }).strict() },
  markets: { path: '/api/prediction/v1/list-prediction-markets', args: z.object({ page_size: z.coerce.number().int().min(1).max(100).default(50), query: z.string().max(100).default(''), category: z.string().max(40).default(''), cursor: z.literal('').default('') }).strict() },
  china: { path: '/api/intelligence/v1/get-china-decision-signals', args: z.object({  }).strict() },
  production: { path: '/api/supply-chain/v1/get-mineral-production', args: z.object({ commodity: z.string().regex(/^[a-z0-9-]{1,60}$/), iso2: z.literal('').default(''), stage: z.literal('').default('') }).strict() },
  housing: { path: '/api/bootstrap', args: z.object({ keys: z.literal('bisDsr,bisPropertyResidential,bisPropertyCommercial') }).strict() },
  imf: { path: '/api/bootstrap', args: z.object({ keys: z.literal('imfMacro,imfGrowth,imfLabor,imfExternal') }).strict() },
} as const;
export type CountryReader = keyof typeof COUNTRY_READERS;

export const countryReaderSchema = z.object({
  section: z.enum(Object.keys(COUNTRY_READERS) as [CountryReader, ...CountryReader[]]),
  arguments: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
}).strict();

export const countryReadResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ready'), section: countryReaderSchema.shape.section, value: z.record(z.string(), z.unknown()), retrievedAt: z.string().datetime() }),
  z.object({ state: z.enum(['locked', 'unavailable']), section: countryReaderSchema.shape.section, reason: z.string().max(400) }),
]);
export type CountryReadResult = z.infer<typeof countryReadResultSchema>;
