export function withWindow<T>(value: unknown, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
  try {
    return fn();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete (globalThis as typeof globalThis & { window?: unknown }).window;
  }
}

export function webVitalsTestWindow(innerWidth: number): unknown {
  return {
    innerWidth,
    matchMedia: (query: string) => ({
      matches: query === '(max-width: 1024px)' ? innerWidth <= 1024 : false,
    }),
    navigator: { userAgentData: { mobile: false } },
  };
}
