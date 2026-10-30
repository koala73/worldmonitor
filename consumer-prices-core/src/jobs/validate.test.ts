import { beforeEach, expect, it, vi } from 'vitest';
const { query, tx } = vi.hoisted(() => ({ query: vi.fn(), tx: vi.fn() }));
vi.mock('../db/client.js', () => ({
  query, closePool: vi.fn(), withTransaction: (work: (execute: typeof tx) => unknown) => work(tx),
}));
vi.mock('../config/loader.js', () => ({ loadAllBasketConfigs: () => [{ slug: 'test', marketCode: 'AE' }] }));
const { validateAll } = await import('./validate.js');
const { aggregateBasket } = await import('./aggregate.js');
const { MAX_OBSERVATION_AGE_DAYS } = await import('../observation-freshness.js');
function row(id: string, price: number, status = 'auto', owner: string | null = null, admitted: boolean | null = true) {
  return { match_id: id, basket_item_id: 'item', match_status: status, retailer_slug: id,
    canonical_name: 'Milk', price: String(price), currency_code: 'AED', reviewed_by: owner,
    observation_id: `observation-${id}`, admitted,
    validator: admitted === null ? null : { ok: admitted, score: admitted ? 0.9 : 0.7, reasons: [], signals: {} } };
}
beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  tx.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
});
it('holds both sides of a two-retailer disagreement', async () => {
  query.mockResolvedValueOnce({ rows: [row('honest', 10), row('attacker', 100)] });
  await validateAll();
  expect(query.mock.calls.slice(1).map(([, args]) => args[0])).toEqual(['honest', 'attacker']);
  for (const [, args] of query.mock.calls.slice(1)) {
    expect(JSON.parse(args[1])).toMatchObject({ reason: 'price_disagreement', threshold: '>2.5x peer' });
  }
});
it('preserves human approval provenance when a price disagreement needs review', async () => {
  query.mockResolvedValueOnce({ rows: [row('human', 30, 'approved', 'curator'), row('peer', 100)] });
  await validateAll();
  const [sql, args] = query.mock.calls[1];
  expect(sql).toContain("WHEN match_status = 'approved' THEN reviewed_by");
  expect(sql).toContain("WHEN match_status = 'approved' THEN reviewed_at");
  expect(JSON.parse(args[1])).toMatchObject({ previousMatchStatus: 'approved', previousReviewedBy: 'curator' });
});
it('does not treat two SKUs from one retailer as two independent peers', async () => {
  query.mockResolvedValueOnce({ rows: [row('a', 10), { ...row('b', 100), retailer_slug: 'a' }] });
  await validateAll();
  expect(query).toHaveBeenCalledTimes(1);
});
it('holds both retailer sides when duplicate SKUs inflate a disputed pair', async () => {
  query.mockResolvedValueOnce({ rows: [row('a', 10), row('b', 100), { ...row('b2', 100), retailer_slug: 'b' }] });
  await validateAll();
  expect(query.mock.calls.slice(1).map(([, args]) => args[0])).toEqual(['a', 'b', 'b2']);
});
it('gives each retailer one median vote despite duplicate SKUs', async () => {
  query.mockResolvedValueOnce({ rows: [row('a', 10), row('b', 11), row('c', 100),
    { ...row('c2', 100), retailer_slug: 'c' }, { ...row('c3', 100), retailer_slug: 'c' }] });
  await validateAll();
  expect(query.mock.calls.slice(1).map(([, args]) => args[0])).toEqual(['c', 'c2', 'c3']);
});
it('restores its own legacy hold when no validator was required', async () => {
  query.mockResolvedValueOnce({ rows: [row('held', 10, 'review', 'validate-job', null), row('peer', 10)] });
  await validateAll();
  expect(query).toHaveBeenCalledTimes(2);
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
it.each([
  ['validate', () => validateAll(), 0],
  ['aggregate', async () => { query.mockResolvedValueOnce({ rows: [{ id: 'basket' }] }); await aggregateBasket('test', 'AE'); }, 1],
] as const)('%s reads only products a scrape saw within the freshness window', async (_name, run, callIndex) => {
  await run();
  const [sql, args] = query.mock.calls[callIndex] as [string, unknown[]];
  // last_seen_at, not observed_at: an unchanged payload reuses its old
  // observation row, so observed_at stops moving while the price stays current.
  expect(sql).toMatch(/\) po ON po\.in_stock = true\s+AND rp\.last_seen_at >= NOW\(\) - make_interval\(days => \$3\)/);
  expect(sql).not.toContain('po.observed_at >= NOW()');
  expect(args[2]).toBe(MAX_OBSERVATION_AGE_DAYS);
});
it('records zero coverage when the freshness window leaves the basket empty', async () => {
  query.mockResolvedValueOnce({ rows: [{ id: 'basket' }] }).mockResolvedValueOnce({ rows: [] });
  await aggregateBasket('test', 'AE');
  // Both statements run in one transaction: a failed coverage write must not
  // leave the day's indices deleted with nothing in their place.
  expect(query.mock.calls.some(([sql]) => /computed_indices/.test(String(sql)))).toBe(false);
  const sqls = tx.mock.calls.map(([sql]) => String(sql));
  const writes = tx.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO computed_indices'));
  expect(writes).toHaveLength(1);
  expect(writes[0][1]).toEqual(expect.arrayContaining(['basket', 'coverage_pct', 0]));
  // An earlier run the same day may have written indices; they must not outlive the empty basket.
  const clear = sqls.findIndex((sql) => /DELETE FROM computed_indices\s+WHERE basket_id = \$1 AND metric_date = NOW\(\)::date/.test(sql));
  expect(clear).toBeGreaterThan(-1);
  expect(clear).toBeLessThan(sqls.findIndex((sql) => sql.includes('INSERT INTO computed_indices')));
  expect(tx.mock.calls[clear][1]).toEqual(['basket']);
});
it('keeps its hold while another retailer was seen recently but is missing from the priced rows', async () => {
  // The peer's latest observation is out of stock, so the priced query drops it;
  // a scrape still saw it inside the window, so the disagreement is not resolved.
  query.mockResolvedValueOnce({ rows: [row('held', 61, 'review', 'validate-job')] })
    .mockResolvedValueOnce({ rows: [{ basket_item_id: 'item', retailers: 2 }] });
  await validateAll();
  expect(query).toHaveBeenCalledTimes(2);
  const [sql, args] = query.mock.calls[1] as [string, unknown[]];
  expect(sql).toContain('rp.last_seen_at >= NOW() - make_interval(days => $3)');
  expect(sql).not.toContain('in_stock');
  expect(args).toEqual(['test', 'AE', MAX_OBSERVATION_AGE_DAYS]);
});
it('releases its own hold once the item has no fresh peer left to disagree with', async () => {
  // Only the held retailer itself was seen within the window.
  query.mockResolvedValueOnce({ rows: [row('held', 61, 'review', 'validate-job')] })
    .mockResolvedValueOnce({ rows: [{ basket_item_id: 'item', retailers: 1 }] });
  await validateAll();
  expect(query).toHaveBeenCalledTimes(3);
  const [sql, args] = query.mock.calls[2];
  expect(sql).toContain("SET match_status = 'auto'");
  expect(JSON.parse(args[1])).toMatchObject({ reason: 'no_fresh_peer', price: 61 });
  expect(args[2]).toBe('observation-held');
});
it.each([['human', true], ['validate-job', false]] as const)(
  'keeps an unpeered hold owned by %s with admission %s', async (owner, admitted) => {
    query.mockResolvedValueOnce({ rows: [row('held', 61, 'review', owner, admitted)] });
    await validateAll();
    expect(query).toHaveBeenCalledTimes(1);
  });
