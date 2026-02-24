export const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Global Yahoo Finance request gate.
 * Ensures minimum spacing between ANY Yahoo requests across all handlers.
 * Multiple handlers calling Yahoo concurrently causes IP-level rate limiting (429).
 */
let yahooLastRequest = 0;
const YAHOO_MIN_GAP_MS = 600;
let yahooQueue: Promise<void> = Promise.resolve();

export function yahooGate(): Promise<void> {
  yahooQueue = yahooQueue.then(async () => {
    const elapsed = Date.now() - yahooLastRequest;
    if (elapsed < YAHOO_MIN_GAP_MS) {
      await new Promise<void>(r => setTimeout(r, YAHOO_MIN_GAP_MS - elapsed));
    }
    yahooLastRequest = Date.now();
  });
  return yahooQueue;
}
