// Supply Redis admission for tests whose subject is Finnhub response handling.
export function allowSymbolSearchBudget(upstream: typeof fetch): typeof fetch {
  process.env.UPSTASH_REDIS_REST_URL ||= 'https://symbol-budget.test';
  process.env.UPSTASH_REDIS_REST_TOKEN ||= 'synthetic-token';
  return async (input, init) => {
    if (new URL(String(input)).origin === 'https://symbol-budget.test') {
      const commands = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      return Response.json(commands
        ? commands.map(() => ({ result: [100, 600] }))
        : { result: null });
    }
    return upstream(input, init);
  };
}
