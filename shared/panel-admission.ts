import { z } from 'zod';

export const panelReceiptSchema = z.object({
  token: z.string().max(160), expiresAt: z.string().datetime(), reused: z.boolean(),
  usage: z.object({ used: z.number().int().nonnegative(), limit: z.number().nonnegative().nullable(), remaining: z.number().nonnegative().nullable(), resetsAt: z.string().datetime(), unit: z.literal('requests') }),
});
export const newsPanelAdmissionSchema = panelReceiptSchema.extend({ panel: z.literal('news') });
export const forecastPanelAdmissionSchema = panelReceiptSchema.extend({ panel: z.literal('forecasts') });
export const forecastPanelReadSchema = z.object({
  domain: z.string().trim().max(80).default(''),
  region: z.string().trim().max(80).default(''),
  limit: z.number().int().min(1).max(30).default(30),
}).strict();
export const forecastPanelViewSchema = forecastPanelReadSchema.extend({
  refresh: z.boolean().default(false), request_id: z.string().uuid().optional(),
}).strict().refine(request => !request.refresh || request.request_id !== undefined, { message: 'Explicit refresh requires a request_id.', path: ['request_id'] });
export const forecastCaseReadSchema = z.object({
  forecast_id: z.string().min(1).max(160), generated_at: z.string().min(1).max(64),
}).strict();
export type ForecastPanelAdmission = z.infer<typeof forecastPanelAdmissionSchema>;
export type NewsPanelAdmission = z.infer<typeof newsPanelAdmissionSchema>;
export type PanelUsage = z.infer<typeof panelReceiptSchema>['usage'];
