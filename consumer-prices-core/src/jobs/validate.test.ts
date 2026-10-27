import { beforeEach, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db/client.js', () => ({ query, closePool: vi.fn() }));
vi.mock('../config/loader.js', () => ({ loadAllBasketConfigs: () => [{ slug: 'test', marketCode: 'AE' }] }));
const { validateAll } = await import('./validate.js');
const { aggregateBasket } = await import('./aggregate.js');
function row(id: string, price: number, status = 'auto', owner: string | null = null, admitted = true) {
  return { match_id: id, basket_item_id: 'item', match_status: status, retailer_slug: id,
    canonical_name: 'Milk', price: String(price), currency_code: 'AED', reviewed_by: owner,
    observation_id: `observation-${id}`, admitted };
}
beforeEach(() => query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 }));
it('holds both sides of a two-retailer disagreement', async () => {
  query.mockResolvedValueOnce({ rows: [row('honest', 10), row('attacker', 100)] });
  await validateAll();
  expect(query.mock.calls.slice(1).map(([, args]) => args[0])).toEqual(['honest', 'attacker']);
});
it('keeps an ordinary pair and a three-retailer consensus', async () => {
  query.mockResolvedValueOnce({ rows: [row('a', 10), row('b', 11)] });
  await validateAll();
  expect(query).toHaveBeenCalledTimes(1);
  query.mockClear().mockResolvedValueOnce({ rows: [row('a', 10), row('b', 11), row('c', 100)] });
  await validateAll();
  expect(query.mock.calls.slice(1).map(([, args]) => args[0])).toEqual(['c']);
});
it.each([[null, true], ['human', true], ['validate-job', false]] as const)(
  'preserves review owner %s with admission %s', async (owner, admitted) => {
    query.mockResolvedValueOnce({ rows: [row('held', 10, 'review', owner, admitted), row('peer', 10)] });
    await validateAll();
    expect(query).toHaveBeenCalledTimes(1);
  });
it('recovers only its own hold on the same passing latest observation', async () => {
  query.mockResolvedValueOnce({ rows: [row('held', 10, 'review', 'validate-job'), row('peer', 10)] });
  await validateAll();
  expect(query).toHaveBeenCalledTimes(2);
  const [sql, args] = query.mock.calls[1];
  expect(sql).toContain("match_status = 'review' AND reviewed_by = 'validate-job'");
  expect(sql).toContain('ORDER BY observed_at DESC, id DESC LIMIT 1');
  expect(args[2]).toBe('observation-held');
});
it('selects the latest observation before checking stock', async () => {
  query.mockResolvedValueOnce({ rows: [{ id: 'basket' }] });
  await aggregateBasket('test', 'AE');
  const sql = query.mock.calls[1][0] as string;
  expect(sql).not.toContain('WHERE retailer_product_id = rp.id AND in_stock = true');
  expect(sql).toContain(') po ON po.in_stock = true');
});
