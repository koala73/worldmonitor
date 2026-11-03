export function throwOnMissingStaticTranslation(key: string): never {
  throw new Error(`[prerender] missing welcome SSR locale key: ${key}`);
}
