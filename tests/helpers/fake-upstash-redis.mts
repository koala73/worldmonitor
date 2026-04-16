export interface FakeRedisSortedSetEntry {
  member: string;
  score: number;
}

export interface FakeRedisState {
  fetchImpl: typeof fetch;
  redis: Map<string, string>;
  sortedSets: Map<string, FakeRedisSortedSetEntry[]>;
  expires: Map<string, number>;
}

export function createRedisFetch(fixtures: Record<string, unknown>): FakeRedisState {
  const redis = new Map<string, string>();
  const sortedSets = new Map<string, FakeRedisSortedSetEntry[]>();
  const expires = new Map<string, number>();

  for (const [key, value] of Object.entries(fixtures)) {
    redis.set(key, JSON.stringify(value));
  }

  const upsertSortedSet = (key: string, score: number, member: string) => {
    const next = (sortedSets.get(key) ?? []).filter((item) => item.member !== member);
    next.push({ member, score });
    next.sort((left, right) => left.score - right.score || left.member.localeCompare(right.member));
    sortedSets.set(key, next);
  };

  const removeByRank = (key: string, start: number, stop: number) => {
    const items = [...(sortedSets.get(key) ?? [])];
    if (items.length === 0) return;

    const normalizeIndex = (index: number) => (index < 0 ? items.length + index : index);
    const startIndex = Math.max(0, normalizeIndex(start));
    const stopIndex = Math.min(items.length - 1, normalizeIndex(stop));
    if (startIndex > stopIndex) return;
    items.splice(startIndex, stopIndex - startIndex + 1);
    sortedSets.set(key, items);
  };

  const readByRank = (key: string, start: number, stop: number) => {
    const items = [...(sortedSets.get(key) ?? [])];
    if (items.length === 0) return [];

    const normalizeIndex = (index: number) => (index < 0 ? items.length + index : index);
    const startIndex = Math.max(0, normalizeIndex(start));
    const stopIndex = Math.min(items.length - 1, normalizeIndex(stop));
    if (startIndex > stopIndex) return [];
    return items.slice(startIndex, stopIndex + 1);
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(process.env.UPSTASH_REDIS_REST_URL || '')) {
      throw new Error(`Unexpected URL: ${url}`);
    }

    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(parsed.pathname.slice('/get/'.length));
      return new Response(JSON.stringify({ result: redis.get(key) ?? null }), { status: 200 });
    }

    if (parsed.pathname.startsWith('/set/')) {
      const parts = parsed.pathname.split('/');
      const key = decodeURIComponent(parts[2] || '');
      const value = decodeURIComponent(parts[3] || '');
      redis.set(key, value);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }

    if (parsed.pathname === '/pipeline') {
      const commands = JSON.parse(typeof init?.body === 'string' ? init.body : '[]') as Array<Array<string | number>>;
      const result = commands.map((command) => {
        const [verb, key = '', ...args] = command;
        const redisKey = String(key);

        if (verb === 'GET') {
          return { result: redis.get(redisKey) ?? null };
        }

        if (verb === 'SET') {
          redis.set(redisKey, String(args[0] || ''));
          return { result: 'OK' };
        }

        if (verb === 'ZADD') {
          let added = 0;
          for (let index = 0; index < args.length; index += 2) {
            const existed = (sortedSets.get(redisKey) ?? []).some((e) => e.member === String(args[index + 1] ?? ''));
            upsertSortedSet(redisKey, Number(args[index] ?? 0), String(args[index + 1] ?? ''));
            if (!existed) added += 1;
          }
          return { result: added };
        }

        if (verb === 'ZRANGE') {
          const items = readByRank(redisKey, Number(args[0] ?? 0), Number(args[1] ?? 0));
          const withScores = args.map(String).includes('WITHSCORES');
          if (!withScores) return { result: items.map((item) => item.member) };
          return { result: items.flatMap((item) => [item.member, String(item.score)]) };
        }

        if (verb === 'ZREMRANGEBYRANK') {
          const before = (sortedSets.get(redisKey) ?? []).length;
          removeByRank(redisKey, Number(args[0] ?? 0), Number(args[1] ?? 0));
          const after = (sortedSets.get(redisKey) ?? []).length;
          return { result: before - after };
        }

        if (verb === 'EXPIRE') {
          expires.set(redisKey, Number(args[0] ?? 0));
          return { result: 1 };
        }

        throw new Error(`Unexpected pipeline command: ${verb}`);
      });
      return new Response(JSON.stringify(result), { status: 200 });
    }

    throw new Error(`Unexpected Redis path: ${parsed.pathname}`);
  }) as typeof fetch;

  return { fetchImpl, redis, sortedSets, expires };
}

export function installRedis(fixtures: Record<string, unknown>, opts: { keepVercelEnv?: boolean } = {}): FakeRedisState {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  if (!opts.keepVercelEnv) delete process.env.VERCEL_ENV;
  const state = createRedisFetch(fixtures);
  globalThis.fetch = state.fetchImpl;
  return state;
}
