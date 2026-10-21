import { z } from 'zod';
import {
  DASHBOARD_COUNTRY_CODE_PATTERN,
  DASHBOARD_MAP_MAX_LATITUDE,
  DASHBOARD_MAP_MODES,
  DASHBOARD_MAP_VIEWS,
  DASHBOARD_TIME_RANGES,
  DASHBOARD_LAYER_ACTION_TARGET_ID_PATTERN,
  DASHBOARD_PANEL_ACTION_ID_PATTERN,
  MAX_LAYER_ACTION_TARGET_ID_LENGTH,
  MAX_LAYER_ACTION_TARGETS,
} from './agent-bus-contract';

export const AGENT_BUS_ACTION_TYPES = [
  'suggest-widget',
  'open_panel',
  'set_view',
  'set_layers',
  'set_time_range',
  'focus_country',
  'set_map_mode',
] as const;

const labelSchema = z.string().trim().min(1).max(96).optional();
const reasonSchema = z.string().trim().min(1).max(240).optional();
const mapViewSchema = z.enum(DASHBOARD_MAP_VIEWS);
const layerActionTargetIdSchema = z.string()
  .min(1)
  .max(MAX_LAYER_ACTION_TARGET_ID_LENGTH)
  .regex(new RegExp(DASHBOARD_LAYER_ACTION_TARGET_ID_PATTERN));

export const suggestWidgetActionSchema = z.object({
  type: z.literal('suggest-widget'),
  label: labelSchema.default('Create chart widget'),
  prefill: z.string().trim().min(1).max(500),
}).strict();

export const openPanelActionSchema = z.object({
  type: z.literal('open_panel'),
  label: labelSchema,
  panelId: z.string().trim().min(1).max(96).regex(new RegExp(DASHBOARD_PANEL_ACTION_ID_PATTERN)),
  reason: reasonSchema,
}).strict();

export const setViewActionSchema = z.object({
  type: z.literal('set_view'),
  label: labelSchema,
  view: mapViewSchema.optional(),
  lat: z.number().finite()
    .min(-DASHBOARD_MAP_MAX_LATITUDE)
    .max(DASHBOARD_MAP_MAX_LATITUDE)
    .optional(),
  lon: z.number().finite().min(-180).max(180).optional(),
  zoom: z.number().finite().min(1).max(10).optional(),
  reason: reasonSchema,
}).strict().superRefine((action, ctx) => {
  const hasNamedView = action.view != null;
  const hasAnyCoordinate = action.lat != null || action.lon != null;
  const hasCoordinatePair = action.lat != null && action.lon != null;
  if (hasNamedView && hasAnyCoordinate) {
    ctx.addIssue({
      code: 'custom',
      message: 'set_view accepts either a named view or a lat/lon pair, not both',
      path: ['view'],
    });
    return;
  }
  if (!hasNamedView && !hasCoordinatePair) {
    ctx.addIssue({
      code: 'custom',
      message: 'set_view requires either a named view or a lat/lon pair',
      path: ['view'],
    });
  }
  if ((action.lat == null) !== (action.lon == null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'set_view lat and lon must be provided together',
      path: action.lat == null ? ['lat'] : ['lon'],
    });
  }
});

export const setLayersActionSchema = z.object({
  type: z.literal('set_layers'),
  label: labelSchema,
  layers: z.record(
    layerActionTargetIdSchema,
    z.boolean(),
  )
    .refine((layers) => Object.keys(layers).length > 0, 'set_layers requires at least one layer')
    .refine(
      (layers) => Object.keys(layers).length <= MAX_LAYER_ACTION_TARGETS,
      `set_layers accepts at most ${MAX_LAYER_ACTION_TARGETS} layers`,
    ),
  reason: reasonSchema,
}).strict();

export const setTimeRangeActionSchema = z.object({
  type: z.literal('set_time_range'),
  label: labelSchema,
  timeRange: z.enum(DASHBOARD_TIME_RANGES),
  reason: reasonSchema,
}).strict();

export const focusCountryActionSchema = z.object({
  type: z.literal('focus_country'),
  label: labelSchema,
  iso2: z.string().regex(new RegExp(DASHBOARD_COUNTRY_CODE_PATTERN)),
  reason: reasonSchema,
}).strict();

export const setMapModeActionSchema = z.object({
  type: z.literal('set_map_mode'),
  label: labelSchema,
  mode: z.enum(DASHBOARD_MAP_MODES),
  reason: reasonSchema,
}).strict();

export const agentBusActionSchema = z.discriminatedUnion('type', [
  suggestWidgetActionSchema,
  openPanelActionSchema,
  setViewActionSchema,
  setLayersActionSchema,
  setTimeRangeActionSchema,
  focusCountryActionSchema,
  setMapModeActionSchema,
]);

export type SuggestWidgetAction = z.infer<typeof suggestWidgetActionSchema>;
export type OpenPanelAction = z.infer<typeof openPanelActionSchema>;
export type SetViewAction = z.infer<typeof setViewActionSchema>;
export type SetLayersAction = z.infer<typeof setLayersActionSchema>;
export type SetTimeRangeAction = z.infer<typeof setTimeRangeActionSchema>;
export type FocusCountryAction = z.infer<typeof focusCountryActionSchema>;
export type SetMapModeAction = z.infer<typeof setMapModeActionSchema>;
export type AgentBusAction = z.infer<typeof agentBusActionSchema>;
export type DashboardControlAction = Exclude<AgentBusAction, SuggestWidgetAction>;
export type DashboardControlActionType = DashboardControlAction['type'];
export type AgentBusActionParseResult =
  | { ok: true; action: AgentBusAction }
  | { ok: false; issues: string[] };

export function parseAgentBusAction(input: unknown): AgentBusActionParseResult {
  const parsed = agentBusActionSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, action: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    }),
  };
}

export function isDashboardControlAction(action: AgentBusAction): action is DashboardControlAction {
  return action.type !== 'suggest-widget';
}
