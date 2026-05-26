import { createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';

export function timingSafeEqual(a: string, b: string): boolean {
  const h = (s: string) => createHash('sha256').update(s).digest();
  return cryptoTimingSafeEqual(h(a), h(b));
}

export { createHash };
