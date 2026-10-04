import { z } from 'zod';

export const panelReceiptSchema = z.object({
  token: z.string().max(160), expiresAt: z.string().datetime(), reused: z.boolean(),
  usage: z.object({ used: z.number().int().nonnegative(), limit: z.number().nonnegative().nullable(), remaining: z.number().nonnegative().nullable(), resetsAt: z.string().datetime(), unit: z.literal('requests') }),
});
export const newsPanelAdmissionSchema = panelReceiptSchema.extend({ panel: z.literal('news') });
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

export const predictionPanelAdmissionSchema = panelReceiptSchema.extend({ panel: z.literal('predictions') });
export type PredictionPanelAdmission = z.infer<typeof predictionPanelAdmissionSchema>;
export const predictionPanelReadSchema = z.object({
  category: z.string().optional().transform(value => value?.trim().toLowerCase() || undefined).pipe(z.enum(['geopolitical', 'tech', 'finance']).optional()),
  source: z.string().optional().transform(value => value?.trim().toLowerCase() || undefined).pipe(z.enum(['kalshi', 'polymarket']).optional()),
  query: z.string().optional().transform(value => value?.trim().toLowerCase() || undefined),
  limit: z.number().default(30),
}).strict();
export const predictionPanelViewSchema = predictionPanelReadSchema.extend({
  refresh: z.boolean().default(false),
  request_id: z.string().uuid().optional(),
}).refine(value => !value.refresh || value.request_id !== undefined, 'Refresh requires a request_id');
