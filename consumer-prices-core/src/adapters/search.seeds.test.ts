import { describe, expect, it, vi } from 'vitest';
import { SearchAdapter, SearchTargetError } from './search.js';
import type { ExaProvider } from '../acquisition/exa.js';
import type { FirecrawlProvider } from '../acquisition/firecrawl.js';
import type { AdapterContext } from './types.js';
import type { RetailerConfig } from '../config/types.js';
import { loadBasketConfig, loadRetailerConfig } from '../config/loader.js';
import { AUTO_MATCH_THRESHOLD } from './validator.js';

function makeContext(config: RetailerConfig): AdapterContext {
  return {
    config,
    runId: 'run-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function callsFor(fn: ReturnType<typeof vi.fn>, url: string): number {
  return fn.mock.calls.filter(([calledUrl]) => calledUrl === url).length;
}

describe('SearchAdapter configured item seeds', () => {
  it('tries an item seed after a stale pin before paid discovery', async () => {
    const config = loadRetailerConfig('pao_de_acucar_br');
    const seedUrl = 'https://www.paodeacucar.com/produto/144583/pao';
    config.discovery.seeds = [{ id: 'bread_white', url: seedUrl, category: 'bread' }];
    const stalePinUrl = 'https://www.paodeacucar.com/produto/999999/suco-de-laranja-1l';
    const exa = {
      search: vi.fn().mockResolvedValue([]),
      extract: vi.fn().mockImplementation(async (url: string) =>
        url === seedUrl
          ? {
              data: {
                productName: 'Pão de Forma Branco Panco Premium Pacote 500g',
                price: 11.49,
                currency: 'BRL',
                inStock: true,
                sizeText: '500g',
              },
              pageContent: 'Pão de Forma Branco Panco Premium Pacote 500g\nR$ 11,49',
            }
          : { data: {}, pageContent: 'Suco de laranja' },
      ),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: {}, pageContent: 'Por favor, confirme seu acesso' }),
    } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = {
      ...makeContext(config),
      pinnedUrls: new Map([
        [
          'essentials-br:Pão de Forma Branco 500g',
          { sourceUrl: stalePinUrl, productId: 'stale-product', matchId: 'stale-match' },
        ],
      ]),
    } as AdapterContext;
    const targets = await adapter.discoverTargets(context);
    const target = targets.find((candidate) => candidate.id === 'bread_white');
    expect(target).toBeDefined();
    expect(target?.metadata?.direct).toBe(true);
    expect(target?.url).toBe(stalePinUrl);
    expect(target?.metadata?.seedUrl).toBe(seedUrl);

    const result = await adapter.fetchTarget(context, target!);
    const [product] = await adapter.parseListing(context, result);

    expect(product?.sourceUrl).toBe(seedUrl);
    expect(product?.price).toBe(11.49);
    expect(product?.rawPayload.direct).toBe(false);
    expect(exa.search).not.toHaveBeenCalled();
    expect(firecrawl.extract).toHaveBeenCalledTimes(2);
    expect(exa.extract).toHaveBeenNthCalledWith(1, stalePinUrl, expect.any(Object), expect.any(Object));
    expect(exa.extract).toHaveBeenNthCalledWith(2, seedUrl, expect.any(Object), expect.any(Object));
  });

  it('does not extract the seed twice when the stale pin already points at it', async () => {
    const config = loadRetailerConfig('pao_de_acucar_br');
    const seedUrl = 'https://www.paodeacucar.com/produto/144583/pao';
    const discoveredUrl = 'https://www.paodeacucar.com/produto/202020/pao-de-forma-branco-500g';
    config.discovery.seeds = [{ id: 'bread_white', url: seedUrl, category: 'bread' }];
    const exaSearch = vi.fn().mockResolvedValue([{ url: discoveredUrl }]);
    const exaExtract = vi.fn().mockImplementation(async (url: string) =>
      url === discoveredUrl
        ? {
            data: {
              productName: 'Pão de Forma Branco Pacote 500g',
              price: 10.99,
              currency: 'BRL',
              inStock: true,
              sizeText: '500g',
            },
            pageContent: 'Pão de Forma Branco Pacote 500g\nR$ 10,99',
          }
        : { data: {}, pageContent: 'Produto sem preço' },
    );
    const firecrawlExtract = vi.fn().mockResolvedValue({ data: {}, pageContent: 'Por favor, confirme seu acesso' });
    const adapter = new SearchAdapter(
      { search: exaSearch, extract: exaExtract } as unknown as ExaProvider,
      { extract: firecrawlExtract } as unknown as FirecrawlProvider,
    );
    const context = {
      ...makeContext(config),
      pinnedUrls: new Map([
        ['essentials-br:Pão de Forma Branco 500g', { sourceUrl: seedUrl, productId: 'seed-product', matchId: 'seed-match' }],
      ]),
    } as AdapterContext;
    const target = (await adapter.discoverTargets(context)).find((candidate) => candidate.id === 'bread_white');
    expect(target?.metadata?.direct).toBe(true);
    expect(target?.url).toBe(seedUrl);

    const result = await adapter.fetchTarget(context, target!);
    const [product] = await adapter.parseListing(context, result);

    expect(product?.sourceUrl).toBe(discoveredUrl);
    expect(product?.rawPayload.direct).toBe(false);
    expect(callsFor(firecrawlExtract, seedUrl)).toBe(1);
    expect(callsFor(exaExtract, seedUrl)).toBe(1);
    expect(exaSearch).toHaveBeenCalledOnce();
  });

  it.each([
    ['foreign host', 'https://example.com/produto/144583/pao'],
    ['wrong path', 'https://www.paodeacucar.com/busca?termo=pao'],
  ])('ignores an item seed outside the retailer policy: %s', async (_case, unsafeUrl) => {
    const config = loadRetailerConfig('pao_de_acucar_br');
    config.discovery.seeds = [{ id: 'bread_white', url: unsafeUrl, category: 'bread' }];
    const context = makeContext(config);
    const adapter = new SearchAdapter({} as unknown as ExaProvider, {} as unknown as FirecrawlProvider);

    const targets = await adapter.discoverTargets(context);
    const target = targets.find((candidate) => candidate.id === 'bread_white');

    expect(target?.url).toBe(config.baseUrl);
    expect(target?.metadata?.seedUrl).toBeUndefined();
    expect(context.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ignored out-of-policy URL'));
  });

  it('ignores an item seed on another storefront of a multi-market host', async () => {
    const config = loadRetailerConfig('noon_sa');
    config.discovery.seeds = [{ id: 'eggs_12', url: 'https://minutes.noon.com/uae-en/now-product/eggs-1', category: 'eggs' }];
    const context = makeContext(config);
    const adapter = new SearchAdapter({} as unknown as ExaProvider, {} as unknown as FirecrawlProvider);

    const targets = await adapter.discoverTargets(context);
    const target = targets.find((candidate) => candidate.id === 'eggs_12');

    expect(target).toBeDefined();
    expect(target?.url).toBe(config.baseUrl);
    expect(target?.metadata?.seedUrl).toBeUndefined();
    expect(context.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ignored out-of-policy URL'));
  });

  it('falls back to paid discovery when the seed extraction itself throws', async () => {
    const config = loadRetailerConfig('pao_de_acucar_br');
    const seedUrl = 'https://www.paodeacucar.com/produto/144583/pao';
    const discoveredUrl = 'https://www.paodeacucar.com/produto/202020/pao-de-forma-branco-500g';
    config.discovery.seeds = [{ id: 'bread_white', url: seedUrl, category: 'bread' }];
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: discoveredUrl }]),
      extract: vi.fn().mockImplementation(async (url: string) =>
        url === discoveredUrl
          ? {
              data: {
                productName: 'Pão de Forma Branco Pacote 500g',
                price: 10.99,
                currency: 'BRL',
                inStock: true,
                sizeText: '500g',
              },
              pageContent: 'Pão de Forma Branco Pacote 500g\nR$ 10,99',
            }
          : { data: { productName: 144583, price: 9.9, currency: 'BRL', inStock: true } },
      ),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: {}, pageContent: 'Por favor, confirme seu acesso' }),
    } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(config);
    const target = (await adapter.discoverTargets(context)).find((candidate) => candidate.id === 'bread_white');

    const result = await adapter.fetchTarget(context, target!);
    const [product] = await adapter.parseListing(context, result);

    expect(product?.sourceUrl).toBe(discoveredUrl);
    expect(product?.price).toBe(10.99);
    expect(exa.search).toHaveBeenCalledOnce();
    expect(context.logger.warn).toHaveBeenCalledWith(expect.stringContaining('seed fetch error'));
  });

  it('fails closed when discovery only re-ranks the seed page already attempted', async () => {
    const config = loadRetailerConfig('pao_de_acucar_br');
    const seedUrl = 'https://www.paodeacucar.com/produto/144583/pao';
    config.discovery.seeds = [{ id: 'bread_white', url: seedUrl, category: 'bread' }];
    const exaSearch = vi.fn().mockResolvedValue([{ url: seedUrl }]);
    const exaExtract = vi.fn().mockResolvedValue({ data: {}, pageContent: 'Produto sem preço' });
    const adapter = new SearchAdapter(
      { search: exaSearch, extract: exaExtract } as unknown as ExaProvider,
      { extract: vi.fn().mockResolvedValue({ data: {}, pageContent: 'Por favor, confirme seu acesso' }) } as unknown as FirecrawlProvider,
    );
    const context = makeContext(config);
    const target = (await adapter.discoverTargets(context)).find((candidate) => candidate.id === 'bread_white');

    const error = await adapter.fetchTarget(context, target!).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SearchTargetError);
    expect((error as SearchTargetError).message).toMatch(/repeated a URL already attempted/);
    expect((error as SearchTargetError).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'firecrawl', reason: 'missing-price' }),
        expect.objectContaining({ provider: 'exa', reason: 'missing-price' }),
      ]),
    );
    expect(exaExtract).toHaveBeenCalledTimes(1);
    expect(exaExtract).toHaveBeenCalledWith(seedUrl, expect.any(Object), expect.any(Object));
    expect(exaSearch).toHaveBeenCalled();
  });

  it.each([
    ['only out-of-policy pages', [{ url: 'https://www.paodeacucar.com/busca?termo=pao' }], /host\/path check/],
    ['no pages at all', [], /no pages found/],
  ])('carries seed failures into the discovery error when Exa returns %s', async (_case, draw, message) => {
    const config = loadRetailerConfig('pao_de_acucar_br');
    const seedUrl = 'https://www.paodeacucar.com/produto/144583/pao';
    config.discovery.seeds = [{ id: 'bread_white', url: seedUrl, category: 'bread' }];
    const adapter = new SearchAdapter(
      {
        search: vi.fn().mockResolvedValue(draw),
        extract: vi.fn().mockResolvedValue({ data: {}, pageContent: 'Produto sem preço' }),
      } as unknown as ExaProvider,
      { extract: vi.fn().mockResolvedValue({ data: {}, pageContent: 'Por favor, confirme seu acesso' }) } as unknown as FirecrawlProvider,
    );
    const context = makeContext(config);
    const target = (await adapter.discoverTargets(context)).find((candidate) => candidate.id === 'bread_white');

    const error = await adapter.fetchTarget(context, target!).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SearchTargetError);
    expect((error as SearchTargetError).message).toMatch(message);
    expect((error as SearchTargetError).rejectedCount).toBe(0);
    expect((error as SearchTargetError).failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'firecrawl', reason: 'missing-price' }),
        expect.objectContaining({ provider: 'exa', reason: 'missing-price' }),
      ]),
    );
  });

  it('rejects a seed page the validator fails and falls back to paid discovery', async () => {
    const config = loadRetailerConfig('pao_de_acucar_br');
    const seedUrl = 'https://www.paodeacucar.com/produto/144583/pao';
    const discoveredUrl = 'https://www.paodeacucar.com/produto/202020/pao-de-forma-branco-500g';
    config.discovery.seeds = [{ id: 'bread_white', url: seedUrl, category: 'bread' }];
    const exaSearch = vi.fn().mockResolvedValue([{ url: discoveredUrl }]);
    const exaExtract = vi.fn().mockImplementation(async (url: string) =>
      url === seedUrl
        ? {
            data: {
              productName: 'Pão de Forma Branco Pacote 170g',
              price: 5.49,
              currency: 'BRL',
              inStock: true,
              sizeText: '170g',
            },
            pageContent: 'Pão de Forma Branco Pacote 170g\nR$ 5,49',
          }
        : {
            data: {
              productName: 'Pão de Forma Branco Pacote 500g',
              price: 10.99,
              currency: 'BRL',
              inStock: true,
              sizeText: '500g',
            },
            pageContent: 'Pão de Forma Branco Pacote 500g\nR$ 10,99',
          },
    );
    const adapter = new SearchAdapter(
      { search: exaSearch, extract: exaExtract } as unknown as ExaProvider,
      { extract: vi.fn().mockResolvedValue({ data: {}, pageContent: 'Por favor, confirme seu acesso' }) } as unknown as FirecrawlProvider,
    );
    const context = makeContext(config);
    const target = (await adapter.discoverTargets(context)).find((candidate) => candidate.id === 'bread_white');

    const result = await adapter.fetchTarget(context, target!);
    const [product] = await adapter.parseListing(context, result);

    expect(product?.sourceUrl).toBe(discoveredUrl);
    expect(product?.price).toBe(10.99);
    expect(product?.rawPayload.validator).toMatchObject({ ok: true });
    expect(exaSearch).toHaveBeenCalledOnce();
    expect(callsFor(exaExtract, seedUrl)).toBe(1);
    expect(context.logger.warn).toHaveBeenCalledWith(expect.stringContaining('rejected by validator'));
  });

  it('continues discovery when a seed match is valid but below automatic admission', async () => {
    const config = loadRetailerConfig('pao_de_acucar_br');
    const seedUrl = 'https://www.paodeacucar.com/produto/144583/pao';
    const discoveredUrl = 'https://www.paodeacucar.com/produto/202020/pao-de-forma-branco-500g';
    config.discovery.seeds = [{ id: 'bread_white', url: seedUrl, category: 'bread' }];
    const exaSearch = vi.fn().mockResolvedValue([{ url: discoveredUrl }]);
    const exaExtract = vi.fn().mockImplementation(async (url: string) =>
      url === seedUrl
        ? {
            data: {
              productName: 'Pão de Forma Panco Premium Pacote 500g',
              price: 11.49,
              currency: 'BRL',
              inStock: true,
              sizeText: '500g',
            },
            pageContent: 'Pão de Forma Panco Premium Pacote 500g\nR$ 11,49',
          }
        : {
            data: {
              productName: 'Pão de Forma Branco Pacote 500g',
              price: 10.99,
              currency: 'BRL',
              inStock: true,
              sizeText: '500g',
            },
            pageContent: 'Pão de Forma Branco Pacote 500g\nR$ 10,99',
          },
    );
    const adapter = new SearchAdapter(
      { search: exaSearch, extract: exaExtract } as unknown as ExaProvider,
      { extract: vi.fn().mockResolvedValue({ data: {}, pageContent: 'Por favor, confirme seu acesso' }) } as unknown as FirecrawlProvider,
    );
    const context = makeContext(config);
    const target = (await adapter.discoverTargets(context)).find((candidate) => candidate.id === 'bread_white');

    const result = await adapter.fetchTarget(context, target!);
    const [product] = await adapter.parseListing(context, result);

    expect(product?.sourceUrl).toBe(discoveredUrl);
    expect(product?.price).toBe(10.99);
    expect(exaSearch).toHaveBeenCalledOnce();
    expect(context.logger.warn).toHaveBeenCalledWith(expect.stringContaining('below automatic admission'));
  });

  it('keeps a valid seed candidate when discovery finds no better page', async () => {
    const config = loadRetailerConfig('pao_de_acucar_br');
    const seedUrl = 'https://www.paodeacucar.com/produto/144583/pao';
    config.discovery.seeds = [{ id: 'bread_white', url: seedUrl, category: 'bread' }];
    const exaSearch = vi.fn().mockResolvedValue([]);
    const exaExtract = vi.fn().mockResolvedValue({
      data: {
        productName: 'Pão de Forma Panco Premium Pacote 500g',
        price: 11.49,
        currency: 'BRL',
        inStock: true,
        sizeText: '500g',
      },
      pageContent: 'Pão de Forma Panco Premium Pacote 500g\nR$ 11,49',
    });
    const adapter = new SearchAdapter(
      { search: exaSearch, extract: exaExtract } as unknown as ExaProvider,
      { extract: vi.fn().mockResolvedValue({ data: {}, pageContent: 'Por favor, confirme seu acesso' }) } as unknown as FirecrawlProvider,
    );
    const context = makeContext(config);
    const target = (await adapter.discoverTargets(context)).find((candidate) => candidate.id === 'bread_white');

    const result = await adapter.fetchTarget(context, target!);
    const [product] = await adapter.parseListing(context, result);
    const validator = product?.rawPayload.validator as { ok: boolean; score: number } | undefined;

    expect(product?.sourceUrl).toBe(seedUrl);
    expect(validator).toMatchObject({ ok: true });
    expect(validator?.score).toBeLessThan(AUTO_MATCH_THRESHOLD);
    expect(exaSearch).toHaveBeenCalledTimes(2);
  });

  it('falls back to paid discovery when an item seed has no price', async () => {
    const config = loadRetailerConfig('pao_de_acucar_br');
    const seedUrl = 'https://www.paodeacucar.com/produto/144583/pao';
    const discoveredUrl = 'https://www.paodeacucar.com/produto/202020/pao-de-forma-branco-500g';
    config.discovery.seeds = [{ id: 'bread_white', url: seedUrl, category: 'bread' }];
    const exaExtract = vi.fn().mockImplementation(async (url: string) =>
      url === discoveredUrl
        ? {
            data: {
              productName: 'Pão de Forma Branco Pacote 500g',
              price: 10.99,
              currency: 'BRL',
              inStock: true,
              sizeText: '500g',
            },
            pageContent: 'Pão de Forma Branco Pacote 500g\nR$ 10,99',
          }
        : { data: {}, pageContent: 'Produto sem preço' },
    );
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: seedUrl }, { url: discoveredUrl }]),
      extract: exaExtract,
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: {}, pageContent: 'Por favor, confirme seu acesso' }),
    } as unknown as FirecrawlProvider;
    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(config);
    const target = (await adapter.discoverTargets(context)).find((candidate) => candidate.id === 'bread_white');

    const result = await adapter.fetchTarget(context, target!);
    const [product] = await adapter.parseListing(context, result);

    expect(product?.sourceUrl).toBe(discoveredUrl);
    expect(product?.price).toBe(10.99);
    expect(exa.search).toHaveBeenCalledOnce();
    expect(callsFor(exaExtract, seedUrl)).toBe(1);
  });

  it('ships known Pão product pages for the qualifying basket items', async () => {
    const config = loadRetailerConfig('pao_de_acucar_br');
    const seeds = new Map(config.discovery.seeds.map((seed) => [seed.id, seed.url]));

    expect(Object.fromEntries(seeds)).toEqual({
      eggs_12: 'https://www.paodeacucar.com/produto/123706',
      milk_1l: 'https://www.paodeacucar.com/produto/164065',
      bread_white: 'https://www.paodeacucar.com/produto/144583/pao',
      rice_1kg: 'https://www.paodeacucar.com/produto/102639/arroz-branco-tipo-1-qualita-pacote-1kg',
      cooking_oil_soy_900ml: 'https://www.paodeacucar.com/produto/124153/oleo-de-soja-soya-garrafa-900ml',
      tomatoes_1kg: 'https://www.paodeacucar.com/produto/198376/tomate-italiano-selecionado-qualita-1kg',
      water_1_5l:
        'https://www.paodeacucar.com/produto/99466/agua-mineral-natural-sem-gas-crystal-garrafa-15l',
      sugar_1kg: 'https://www.paodeacucar.com/produto/162802/acucar-cristalcucar-uniao-pacote-1kg',
      yogurt_500g: 'https://www.paodeacucar.com/produto/1619280',
    });

    const basketItemIds = new Set(loadBasketConfig('essentials_br').items.map((item) => item.id));
    for (const id of seeds.keys()) expect(basketItemIds).toContain(id);

    const context = makeContext(config);
    const adapter = new SearchAdapter({} as unknown as ExaProvider, {} as unknown as FirecrawlProvider);
    const targets = await adapter.discoverTargets(context);
    for (const [id, url] of seeds) expect(targets.find((target) => target.id === id)?.metadata?.seedUrl).toBe(url);
    for (const id of ['chicken_whole_1kg', 'onions_1kg']) {
      expect(targets.find((target) => target.id === id)?.metadata?.seedUrl).toBeUndefined();
    }
    expect(context.logger.warn).not.toHaveBeenCalled();
  });
});
