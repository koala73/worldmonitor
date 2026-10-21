import { config as configureZod } from 'zod/v4/core';

// The production CSP intentionally omits `unsafe-eval`. Zod v4 can probe a
// JIT object parser with `new Function`, which works around CSP only by
// producing an enforced violation event. Keep validation on the interpreter
// path so the dashboard starts cleanly under the hardened policy.
configureZod({ jitless: true });
