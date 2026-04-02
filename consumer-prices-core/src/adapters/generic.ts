/**
 * Generic config-driven adapter.
 * Uses CSS selectors from the retailer YAML to extract products.
 * Works with any acquisition provider (Playwright, Firecrawl, Exa, P0).
 */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — jsdom types provided via @types/jsdom
import { JSDOM } from 'jsdom';
import { fetchWithFallback } from '../acquisition/registry.js';
import type { AdapterContext, FetchResult, ParsedProduct, RetailerAdapter, Target } from './types.js';
import type { RetailerConfig } from '../config/types.js';

function parsePrice(text: string | null | undefined, config: RetailerConfig): number | null {
  if (!text) return null;

  const fmt = config.extraction?.priceFormat;
  let clean = text;

  if (fmt?.currencySymbols) {
    for (const sym of fmt.currencySymbols) {
      clean = clean.replace(sym, '');
    }
  }

  const dec = fmt?.decimalSeparator ?? '.';
  const thou = fmt?.thousandsSeparator ?? ',';

  clean = clean.replace(new RegExp(`\\${thou}`, 'g'), '').replace(dec, '.').replace(/[^\d.]/g, '').trim();

  const val = parseFloat(clean);
  return isNaN(val) ? null : val;
}

function selectText(doc: Document, selector: string): string | null {
  if (!selector) return null;

  if (selector.includes('::attr(')) {
    const [sel, attr] = selector.replace(')', '').split('::attr(');
    const el = doc.querySelector(sel.trim());
    return el?.getAttribute(attr.trim()) ?? null;
  }

  return doc.querySelector(selector)?.textContent?.trim() ?? null;
}

export class GenericPlaywrightAdapter implements RetailerAdapter {
  readonly key = 'generic';

  async discoverTargets(ctx: AdapterContext): Promise<Target[]> {
    return ctx.config.discovery.seeds.map((s) => ({
      id: s.id,
      url: s.url.startsWith('http') ? s.url : `${ctx.config.baseUrl}${s.url}`,
      category: s.category ?? s.id,
    }));
  }

  async fetchTarget(ctx: AdapterContext, target: Target): Promise<FetchResult> {
    if (!ctx.config.acquisition) throw new Error(`Generic adapter requires acquisition config (retailer: ${ctx.config.slug})`);
    const result = await fetchWithFallback(target.url, ctx.config.acquisition, ctx.config.rateLimit ? {
      timeout: 30_000,
    } : undefined);

    return {
      url: result.url,
      html: result.html,
      markdown: result.markdown,
      statusCode: result.statusCode,
      fetchedAt: result.fetchedAt,
    };
  }

  async parseListing(ctx: AdapterContext, result: FetchResult): Promise<ParsedProduct[]> {
    const selectors = ctx.config.extraction?.productCard;
    if (!selectors) return [];

    const dom = new JSDOM(result.html);
    const doc = dom.window.document;
    const cards = doc.querySelectorAll(selectors.container);

    const products: ParsedProduct[] = [];

    for (const card of cards) {
      try {
        const rawTitle = selectText(card as unknown as Document, selectors.title) ?? '';
        if (!rawTitle) continue;

        const priceText = selectText(card as unknown as Document, selectors.price);
        const price = parsePrice(priceText, ctx.config);
        if (!price) continue;

        const listPriceText = selectors.listPrice
          ? selectText(card as unknown as Document, selectors.listPrice)
          : null;
        const listPrice = parsePrice(listPriceText, ctx.config);

        const relUrl = selectText(card as unknown as Document, selectors.url) ?? '';
        const sourceUrl = relUrl.startsWith('http') ? relUrl : `${ctx.config.baseUrl}${relUrl}`;

        products.push({
          sourceUrl,
          rawTitle,
          rawBrand: selectors.brand ? selectText(card as unknown as Document, selectors.brand) : null,
          rawSizeText: selectors.sizeText
            ? selectText(card as unknown as Document, selectors.sizeText)
            : null,
          imageUrl: selectors.imageUrl
            ? selectText(card as unknown as Document, selectors.imageUrl)
            : null,
          categoryText: null,
          retailerSku: selectors.sku ? selectText(card as unknown as Document, selectors.sku) : null,
          price,
          listPrice,
          promoPrice: price < (listPrice ?? price) ? price : null,
          promoText: null,
          inStock: true,
          rawPayload: { title: rawTitle, price: priceText, url: relUrl },
        });
      } catch (err) {
        ctx.logger.warn(`[generic] parse error on card: ${err}`);
      }
    }

    return products;
  }

  async parseProduct(ctx: AdapterContext, result: FetchResult): Promise<ParsedProduct> {
    const selectors = ctx.config.extraction?.productPage;
    const dom = new JSDOM(result.html);
    const doc = dom.window.document;

    const rawTitle = selectors?.title ? (selectText(doc, selectors.title) ?? '') : '';
    const priceText = selectors?.price ? selectText(doc, selectors.price) : null;
    const price = parsePrice(priceText, ctx.config) ?? 0;

    const jsonld = selectors?.jsonld ? doc.querySelector(selectors.jsonld)?.textContent : null;
    let jsonldData: Record<string, unknown> = {};
    if (jsonld) {
      try { jsonldData = JSON.parse(jsonld) as Record<string, unknown>; } catch {}
    }

    return {
      sourceUrl: result.url,
      rawTitle: rawTitle || (jsonldData.name as string) || '',
      rawBrand: (jsonldData.brand as { name?: string })?.name ?? null,
      rawSizeText: null,
      imageUrl: (jsonldData.image as string) ?? null,
      categoryText: selectors?.categoryPath ? selectText(doc, selectors.categoryPath) : null,
      retailerSku: selectors?.sku ? selectText(doc, selectors.sku) : null,
      price,
      listPrice: null,
      promoPrice: null,
      promoText: null,
      inStock: true,
      rawPayload: { title: rawTitle, price: priceText, jsonld: jsonldData },
    };
  }

  async validateConfig(config: RetailerConfig): Promise<string[]> {
    const errors: string[] = [];
    if (!config.baseUrl) errors.push('baseUrl is required');
    if (!config.discovery.seeds?.length) errors.push('at least one discovery seed is required');
    if (!config.extraction?.productCard?.container) errors.push('extraction.productCard.container is required');
    return errors;
  }
}

