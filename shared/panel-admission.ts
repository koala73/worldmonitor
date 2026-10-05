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
export const marketPanelAdmissionSchema = panelReceiptSchema.extend({ panel: z.literal('markets') });
export type MarketPanelAdmission = z.infer<typeof marketPanelAdmissionSchema>;
export const MARKET_ASSET_CLASSES = ['equity', 'commodity', 'crypto', 'sectors', 'etf', 'gulf', 'sentiment'] as const;
export const marketPanelReadSchema = z.object({
  symbols: z.array(z.string()).optional().transform(values => {
    const symbols = [...new Set((values ?? []).map(value => value.trim().toLowerCase()).filter(Boolean))].sort();
    return symbols.length ? symbols : undefined;
  }),
  asset_class: z.array(z.enum(MARKET_ASSET_CLASSES)).optional().transform(values => values?.length ? [...new Set(values)].sort() : undefined),
  limit: z.number().default(30),
}).strict();
export type MarketPanelRead = z.infer<typeof marketPanelReadSchema>;
export const marketPanelViewSchema = marketPanelReadSchema.extend({
  refresh: z.boolean().default(false),
  request_id: z.string().uuid().optional(),
}).refine(value => !value.refresh || value.request_id !== undefined, 'Refresh requires a request_id');
export type MarketPanelView = z.infer<typeof marketPanelViewSchema>;
export type PanelUsage = z.infer<typeof panelReceiptSchema>['usage'];
