import { z } from 'zod';

export const panelReceiptSchema = z.object({
  token: z.string().max(160), expiresAt: z.string().datetime(), reused: z.boolean(),
  usage: z.object({ used: z.number().int().nonnegative(), limit: z.number().nonnegative().nullable(), remaining: z.number().nonnegative().nullable(), resetsAt: z.string().datetime(), unit: z.literal('requests') }),
});
export const newsPanelAdmissionSchema = panelReceiptSchema.extend({ panel: z.literal('news') });
export type NewsPanelAdmission = z.infer<typeof newsPanelAdmissionSchema>;
export type PanelUsage = z.infer<typeof panelReceiptSchema>['usage'];
