export interface PizzaIndexView {
  available: true;
  level: string;
  label: string;
  updatedAt: number;
  venues: Array<{ name: string; status: string }>;
}

export interface PizzaIndexRecord {
  updatedAt: string;
  level: string;
  label: string;
  venues: Array<{ name: string; status: string }>;
}

export const PIZZA_INDEX_SLUG: string;
export const PIZZA_INDEX_PAGE_PATH: string;
export const PIZZA_INDEX_STATUS_PATH: string;
export const MAX_PUBLISHED_PIZZA_INDEX_AGE_MS: number;
export function pizzaIndexReading(payload: unknown, now?: number): PizzaIndexView | null;
export function pizzaIndexRecord(view: PizzaIndexView | PizzaIndexRecord): PizzaIndexRecord;
export function publishedPizzaIndex(livePulse: unknown, now?: number): PizzaIndexRecord | null;
export function glossaryPizzaIndex(
  pulses: Record<string, unknown>,
  modifiedDate: string | undefined,
  now?: number,
): { reading: PizzaIndexRecord | null; dateModified: string | undefined };
export function withoutExpiredPizzaIndex(html: string, now?: number): string | null;
export function renderPizzaIndexSection(
  reading: PizzaIndexView | PizzaIndexRecord | null,
  options?: { live?: boolean },
): string;
