import { z } from 'zod';

export const AGENT_BUS_ACTION_TYPES = [
  'suggest-widget',
  'open_panel',
  'set_view',
  'set_layers',
] as const;

const labelSchema = z.string().trim().min(1).max(96).optional();
const reasonSchema = z.string().trim().min(1).max(240).optional();
const mapViewSchema = z.enum(['global', 'america', 'mena', 'eu', 'asia', 'latam', 'africa', 'oceania']);

export const suggestWidgetActionSchema = z.object({
  type: z.literal('suggest-widget'),
  label: labelSchema.default('Create chart widget'),
  prefill: z.string().trim().min(1).max(500),
}).strict();

export const openPanelActionSchema = z.object({
  type: z.literal('open_panel'),
  label: labelSchema,
  panelId: z.string().trim().min(1).max(96).regex(/^[a-z0-9][a-z0-9@_-]*$/),
  reason: reasonSchema,
}).strict();

export const setViewActionSchema = z.object({
  type: z.literal('set_view'),
  label: labelSchema,
  view: mapViewSchema.optional(),
  lat: z.number().finite().min(-90).max(90).optional(),
  lon: z.number().finite().min(-180).max(180).optional(),
  zoom: z.number().finite().min(1).max(10).optional(),
  reason: reasonSchema,
}).strict().superRefine((action, ctx) => {
  const hasCoordinatePair = action.lat != null && action.lon != null;
  if (!action.view && !hasCoordinatePair) {
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
  layers: z.record(z.string().trim().min(1).max(80), z.boolean())
    .refine((layers) => Object.keys(layers).length > 0, 'set_layers requires at least one layer'),
  reason: reasonSchema,
}).strict();

export const agentBusActionSchema = z.discriminatedUnion('type', [
  suggestWidgetActionSchema,
  openPanelActionSchema,
  setViewActionSchema,
  setLayersActionSchema,
]);

export type SuggestWidgetAction = z.infer<typeof suggestWidgetActionSchema>;
export type OpenPanelAction = z.infer<typeof openPanelActionSchema>;
export type SetViewAction = z.infer<typeof setViewActionSchema>;
export type SetLayersAction = z.infer<typeof setLayersActionSchema>;
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
