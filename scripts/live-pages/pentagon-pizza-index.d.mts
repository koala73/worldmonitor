export interface PizzaIndexView {
  available: true;
  level: string;
  label: string;
  updatedAt: number;
  venues: Array<{ name: string; status: string }>;
}

export const PIZZA_INDEX_SLUG: string;
export const PIZZA_INDEX_PAGE_PATH: string;
export const PIZZA_INDEX_STATUS_PATH: string;
export function pizzaIndexReading(payload: unknown, now?: number): PizzaIndexView | null;
export function renderPizzaIndexSection(view: PizzaIndexView | null): string;
