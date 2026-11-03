/**
 * Price grounding for the streaming chat analyst.
 *
 * On 2026-10-27 the analyst answered "Why is Brent up today?" with an "$80"
 * Brent level while the dashboard's Brent tile read $109.76. The quote was
 * missing from the prompt (chat-analyst-context.ts now includes the quotes a
 * question names), and nothing checked the answer against the context. This
 * module is the second half: a price the answer states must appear in the live
 * context, or the answer carries a visible caveat naming it.
 *
 * Why not the brief pipeline's validator (validateNoHallucinatedFacts in
 * shared/brief-llm-core.js)? It reads every count, year and percentage as a
 * fact and requires an exact match, which is right for a two-sentence brief
 * whose sentence can be dropped, and wrong for a streamed answer that
 * legitimately rounds "-0.88%" to "down nearly 1%". The streamed tokens also
 * cannot be retracted, so the check appends a caveat before the terminal event
 * rather than rewriting prose mid-stream.
 */

export interface PriceFigure {
  /** The amount as written, e.g. "$80", "€94.7", "USD 101.3". */
  text: string;
  /** The numeric value, scaled when a suffix such as "bn" is attached. */
  value: number;
  /** Decimal places the author wrote, which sets the rounding tolerance. */
  decimals: number;
  /** Normalised currency: "$", "US$" and "USD" are all USD. */
  currency: string;
}

// A currency marker, optional space, an amount with optional thousands
// separators and decimals, then an optional magnitude suffix. The marker is
// what makes the figure a price claim: bare numbers are counts, years and
// percentages, which this check deliberately leaves alone. The markers are
// the ones the Market Data block renders (chat-analyst-context.ts,
// quoteCurrencySign); a marker that starts with a letter must open a word, so
// "Caesar 80" is not a riyal price.
const PRICE_RE = /(\bUS\$|\bHK\$|\bC\$|\bCN¥|\bUSD|\bCHF|\bSAR|\bAED|[$€£¥₹₩])\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(k|m|mn|bn|b|tn|t|thousand|million|billion|trillion)\b)?/gi;

// The same amount in another currency is a different price (#9780 review):
// "£110.89" is not grounded by "$110.89". The yen and yuan share a sign, so
// "¥" and "CN¥" are one class.
const CURRENCY_OF_MARKER: Record<string, string> = {
  '$': 'USD', 'us$': 'USD', 'usd': 'USD',
  'hk$': 'HKD',
  'c$': 'CAD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY/CNY', 'cn¥': 'JPY/CNY',
  '₹': 'INR',
  '₩': 'KRW',
  chf: 'CHF',
  sar: 'SAR',
  aed: 'AED',
};

const SUFFIX_SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12,
};

/** Relative tolerance: "$111" or "near $4,050" against a quote of 110.89 / 4056 is the same figure. */
const RELATIVE_TOLERANCE = 0.025;

export function extractPriceFigures(text: string): PriceFigure[] {
  const figures: PriceFigure[] = [];
  if (typeof text !== 'string' || text.length === 0) return figures;
  for (const match of text.matchAll(PRICE_RE)) {
    const [raw, marker, whole, fraction, suffix] = match;
    const after = text[match.index! + raw.length];
    // "$80%" is not a price; neither is a figure glued to a following word.
    if (after === '%' || (after !== undefined && /[\p{L}\p{N}]/u.test(after) && !suffix)) continue;
    const base = Number(`${whole!.replace(/,/g, '')}${fraction ? `.${fraction}` : ''}`);
    if (!Number.isFinite(base)) continue;
    const scale = suffix ? SUFFIX_SCALE[suffix.toLowerCase()] ?? 1 : 1;
    figures.push({
      text: raw.trim(),
      value: base * scale,
      decimals: scale === 1 && fraction ? fraction.length : 0,
      currency: CURRENCY_OF_MARKER[marker!.toLowerCase()] ?? marker!.toUpperCase(),
    });
  }
  return figures;
}

function isSupported(figure: PriceFigure, ground: PriceFigure[]): boolean {
  const halfUnit = 0.5 * 10 ** -figure.decimals;
  return ground.some((g) => {
    if (g.currency !== figure.currency) return false;
    const tolerance = Math.max(RELATIVE_TOLERANCE * Math.abs(g.value), halfUnit);
    return Math.abs(figure.value - g.value) <= tolerance;
  });
}

/**
 * The price figures in `answer` that no figure in `groundText` supports, as
 * written and in order of first appearance. `groundText` is the user-turn
 * text: the live-context block plus the question(s), so a figure the user
 * introduced is never flagged back at them.
 */
export function findUnsupportedPrices(answer: string, groundText: string): string[] {
  const stated = extractPriceFigures(answer);
  if (stated.length === 0) return [];
  const ground = extractPriceFigures(groundText);
  const unsupported: string[] = [];
  for (const figure of stated) {
    if (isSupported(figure, ground)) continue;
    if (!unsupported.includes(figure.text)) unsupported.push(figure.text);
  }
  return unsupported;
}

/** The caveat appended to an answer, as a markdown paragraph of its own. */
export function formatPriceCaveat(unsupported: string[]): string {
  const plural = unsupported.length > 1;
  return `\n\n*Not in the live data: ${unsupported.join(', ')} — treat ${plural ? 'them' : 'it'} as unverified.*`;
}

/**
 * Pass the analyst's SSE stream through unchanged, accumulating the answer;
 * when the terminal `done` event arrives, check the stated prices against
 * `groundText` and, if any is unsupported, emit a caveat delta ahead of it.
 * Streams that end on an error or without `done` are forwarded byte for byte:
 * the client already renders those as failures.
 *
 * Pull-based rather than a TransformStream so that a client cancel reaches
 * the source synchronously, the way api/chat-analyst.ts's quota wrapper
 * already propagates it. This sits outermost, after that wrapper: the quota
 * decision keeps reading the raw provider stream, and only the bytes headed
 * to the client are inspected here.
 */
export function withPriceGrounding(
  stream: ReadableStream<Uint8Array>,
  groundText: string,
  onUnsupported?: (prices: string[], answer: string) => void,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buffered = '';
  let answer = '';
  let innerReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  // `terminated` is false only for an unframed tail at end of stream, which is
  // forwarded byte for byte but still inspected (#9780 review).
  const forwardLine = (line: string, controller: ReadableStreamDefaultController<Uint8Array>, terminated = true) => {
    if (line.startsWith('data: ')) {
      let event: { delta?: unknown; done?: unknown } | null = null;
      try {
        event = JSON.parse(line.slice(6)) as { delta?: unknown; done?: unknown };
      } catch {
        event = null;
      }
      if (event && typeof event.delta === 'string') {
        answer += event.delta;
      } else if (event && event.done === true) {
        const unsupported = findUnsupportedPrices(answer, groundText);
        if (unsupported.length > 0) {
          onUnsupported?.(unsupported, answer);
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ delta: formatPriceCaveat(unsupported) })}\n\n`));
        }
      }
    }
    controller.enqueue(enc.encode(terminated ? `${line}\n` : line));
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      innerReader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await innerReader.read();
          if (done || cancelled) break;
          buffered += dec.decode(value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) forwardLine(line, controller);
        }
        if (cancelled) return;
        buffered += dec.decode();
        if (buffered) forwardLine(buffered, controller, false);
        controller.close();
      } catch (err) {
        if (!cancelled) controller.error(err);
      }
    },
    cancel(reason) {
      cancelled = true;
      return innerReader?.cancel(reason) ?? Promise.resolve();
    },
  });
}
