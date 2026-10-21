import { z } from 'zod';

export const PLUGIN_MAP_LAYERS = ['natural', 'fires', 'cables', 'pipelines', 'waterways', 'bases'] as const;
export type PluginMapLayer = typeof PLUGIN_MAP_LAYERS[number];

export const pluginNewsViewSchema = z.object({
  query: z.string().max(200).optional(),
  source: z.string().max(200).optional(),
  category: z.string().max(80).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).optional(),
  time_range: z.enum(['1h', '6h', '24h', '48h', '7d', 'all']).optional(),
  renderer: z.enum(['flat', 'globe']).optional(),
  map_layers: z.array(z.enum(PLUGIN_MAP_LAYERS)).max(PLUGIN_MAP_LAYERS.length).refine(layers => new Set(layers).size === layers.length, 'Map layers must be unique').optional(),
  map_latitude: z.number().min(-90).max(90).optional(),
  map_longitude: z.number().min(-180).max(180).optional(),
  map_zoom: z.number().min(1).max(8).optional(),
}).strict().refine(value => (value.map_latitude === undefined) === (value.map_longitude === undefined), 'Map center requires both latitude and longitude');
export type PluginNewsView = z.infer<typeof pluginNewsViewSchema>;
export const newsDashboardRequestSchema = z.object({
  view: pluginNewsViewSchema,
  refresh: z.boolean().default(false),
  request_id: z.string().uuid().optional(),
}).strict();

export function parseNewsDashboardRequest(input: Record<string, unknown>) {
  const { refresh, request_id, jmespath: _projection, ...view } = input;
  return newsDashboardRequestSchema.safeParse({ view, refresh, request_id });
}

export const PLUGIN_NEWS_VIEW_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', maxLength: 200, description: 'Open the existing WorldMonitor search with this query.' },
    source: { type: 'string', maxLength: 200, description: 'Show only items from one feed source, matched exactly against each item\'s source name. Omit for all sources.' },
    category: { type: 'string', maxLength: 80, description: 'Show only one news panel (category id such as "conflict" or "economy"); an unknown id is reported in the receipt. Omit for all panels.' },
    country: { type: 'string', pattern: '^[A-Z]{2}$', description: 'Uppercase ISO 3166-1 alpha-2 code. Keeps items that mention that country and enables the country-brief control.' },
    time_range: { type: 'string', enum: ['1h', '6h', '24h', '48h', '7d', 'all'], description: 'Publication window applied to the news list and the map time filter (default all).' },
    renderer: { type: 'string', enum: ['flat', 'globe'], description: 'Map projection to render: flat or globe. The receipt reports a fallback when the requested renderer is unavailable.' },
    map_layers: { type: 'array', items: { type: 'string', enum: PLUGIN_MAP_LAYERS }, maxItems: PLUGIN_MAP_LAYERS.length, uniqueItems: true, description: 'Replace selected hazard and landmark layers. Hazard data is a bounded global snapshot, independent of news country filters. Empty array clears layers.' },
    map_latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude of the map center in degrees. Must be given together with map_longitude.' },
    map_longitude: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude of the map center in degrees. Must be given together with map_latitude.' },
    map_zoom: { type: 'number', minimum: 1, maximum: 8, description: 'Map zoom level from 1 (world) to 8 (city scale).' },
  },
  required: [],
};

export const NEWS_DASHBOARD_INPUT_SCHEMA = {
  ...PLUGIN_NEWS_VIEW_INPUT_SCHEMA,
  properties: {
    ...PLUGIN_NEWS_VIEW_INPUT_SCHEMA.properties,
    refresh: { type: 'boolean', description: 'Refresh news and map observations with one new paid request. Default false reuses the loaded dashboard request.' },
    request_id: { type: 'string', format: 'uuid', description: 'Stable ID for a refresh; retries share one paid request.' },
  },
};
