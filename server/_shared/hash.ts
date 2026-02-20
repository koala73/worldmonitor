/**
 * FNV-1a 52-bit hash — stronger than Java hashCode (32-bit) or DJB2 (32-bit).
 *
 * Uses 52 bits (JS safe integer range) to greatly reduce collision probability
 * compared to 32-bit hashes. At 77k keys, 32-bit has ~50% collision chance
 * (birthday problem); 52-bit has ~0.00007% chance at 77k keys.
 *
 * Unified implementation replacing two separate hashString functions (H-7 fix).
 */
export function hashString(input: string): string {
  // FNV-1a parameters adapted for 52-bit output (within JS safe integer range)
  let h = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK_52 = (1n << 52n) - 1n;

  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK_52;
  }

  return Number(h).toString(36);
}
