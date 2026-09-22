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

export interface FakeRedisOptions {
  now?: () => number;
  initialExpiresAt?: Record<string, number>;
}

export function createRedisFetch(
  fixtures: Record<string, unknown>,
  { now = () => Date.now(), initialExpiresAt = {} }: FakeRedisOptions = {},
): FakeRedisState {
  const redis = new Map<string, string>();
  const sortedSets = new Map<string, FakeRedisSortedSetEntry[]>();
  const expires = new Map<string, number>();
  const expiryAt = new Map<string, number>();

  for (const [key, value] of Object.entries(fixtures)) {
    redis.set(key, JSON.stringify(value));
  }

  const clearExpiry = (key: string) => {
    expires.delete(key);
    expiryAt.delete(key);
  };

  const removeKey = (key: string) => {
    const existed = redis.delete(key);
    clearExpiry(key);
    return existed;
  };

  const expireDueKeys = () => {
    const current = now();
    for (const [key, deadline] of expiryAt) {
      if (deadline <= current) removeKey(key);
    }
  };

  for (const [key, deadline] of Object.entries(initialExpiresAt)) {
    if (redis.has(key) && Number.isFinite(deadline)) {
      expiryAt.set(key, deadline);
      expires.set(key, Math.max(0, (deadline - now()) / 1000));
    }
  }
  expireDueKeys();

  const setExpiry = (key: string, ttlSeconds: number) => {
    const ttlMs = Math.max(0, ttlSeconds * 1000);
    expires.set(key, ttlSeconds);
    expiryAt.set(key, now() + ttlMs);
    expireDueKeys();
  };

  const setExpiryMs = (key: string, ttlMs: number) => {
    expires.set(key, ttlMs / 1000);
    expiryAt.set(key, now() + Math.max(0, ttlMs));
    expireDueKeys();
  };

  const writeValue = (key: string, value: string, ttlSeconds?: number, ttlMs?: number) => {
    redis.set(key, value);
    if (ttlMs != null) setExpiryMs(key, ttlMs);
    else if (ttlSeconds != null) setExpiry(key, ttlSeconds);
    else clearExpiry(key);
  };

  const parseSetTtl = (options: Array<string | number>) => {
    for (let index = 0; index < options.length; index++) {
      const option = String(options[index]).toUpperCase();
      if (option === 'EX') return { seconds: Number(options[index + 1] ?? 0) };
      if (option === 'PX') return { milliseconds: Number(options[index + 1] ?? 0) };
    }
    return {};
  };

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

  const removeByScore = (key: string, min: number, max: number) => {
    const items = sortedSets.get(key) ?? [];
    const next = items.filter((item) => item.score < min || item.score > max);
    sortedSets.set(key, next);
    return items.length - next.length;
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

    expireDueKeys();
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(parsed.pathname.slice('/get/'.length));
      return new Response(JSON.stringify({ result: redis.get(key) ?? null }), {
        status: 200,
      });
    }

    if (parsed.pathname.startsWith('/set/')) {
      const parts = parsed.pathname.split('/');
      const key = decodeURIComponent(parts[2] || '');
      const value = decodeURIComponent(parts[3] || '');
      writeValue(key, value);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }

    if (parsed.pathname === '/') {
      const command = JSON.parse(typeof init?.body === 'string' ? init.body : '[]') as Array<string | number>;
      const [verb, key = '', value = ''] = command;
      const normalizedVerb = String(verb).toUpperCase();
      const redisKey = String(key);
      if (normalizedVerb === 'GET') {
        return new Response(JSON.stringify({ result: redis.get(redisKey) ?? null }), { status: 200 });
      }
      if (normalizedVerb === 'SET') {
        const options = command.slice(3);
        const opts = options.map(String).map((item) => item.toUpperCase());
        if (opts.includes('NX') && redis.has(redisKey)) {
          return new Response(JSON.stringify({ result: null }), {
            status: 200,
          });
        }
        const ttl = parseSetTtl(options);
        writeValue(redisKey, String(value), ttl.seconds, ttl.milliseconds);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      if (normalizedVerb === 'DEL') {
        return new Response(JSON.stringify({ result: removeKey(redisKey) ? 1 : 0 }), { status: 200 });
      }
      if (normalizedVerb === 'EXPIRE') {
        const ttlSeconds = Number(value);
        if (!redis.has(redisKey)) return new Response(JSON.stringify({ result: 0 }), { status: 200 });
        setExpiry(redisKey, ttlSeconds);
        return new Response(JSON.stringify({ result: 1 }), { status: 200 });
      }
      if (normalizedVerb === 'EVAL') {
        const keyArg = String(command[3] ?? '');
        const expected = String(command[4] ?? '');
        if (redis.get(keyArg) === expected) {
          removeKey(keyArg);
          return new Response(JSON.stringify({ result: 1 }), { status: 200 });
        }
        return new Response(JSON.stringify({ result: 0 }), { status: 200 });
      }
      throw new Error(`Unexpected POST / command: ${verb}`);
    }

    if (parsed.pathname === '/pipeline' || parsed.pathname === '/multi-exec') {
      const commands = JSON.parse(typeof init?.body === 'string' ? init.body : '[]') as Array<Array<string | number>>;
      const result = commands.map((command) => {
        const [verb, key = '', ...args] = command;
        const normalizedVerb = String(verb).toUpperCase();
        const redisKey = String(key);

        if (normalizedVerb === 'GET') {
          return { result: redis.get(redisKey) ?? null };
        }

        if (normalizedVerb === 'GETDEL') {
          const value = redis.get(redisKey) ?? null;
          removeKey(redisKey);
          return { result: value };
        }

        if (normalizedVerb === 'SET') {
          const options = args.slice(1);
          const opts = options.map(String).map((item) => item.toUpperCase());
          if (opts.includes('NX') && redis.has(redisKey)) {
            return { result: null };
          }
          const ttl = parseSetTtl(options);
          writeValue(redisKey, String(args[0] || ''), ttl.seconds, ttl.milliseconds);
          return { result: 'OK' };
        }

        if (normalizedVerb === 'DEL') {
          return { result: removeKey(redisKey) ? 1 : 0 };
        }

        if (normalizedVerb === 'INCR') {
          const current = Number(redis.get(redisKey) ?? '0');
          const next = (Number.isFinite(current) ? current : 0) + 1;
          redis.set(redisKey, String(next));
          return { result: next };
        }

        if (normalizedVerb === 'DECR') {
          const current = Number(redis.get(redisKey) ?? '0');
          const next = (Number.isFinite(current) ? current : 0) - 1;
          redis.set(redisKey, String(next));
          return { result: next };
        }

        if (normalizedVerb === 'EVAL') {
          const keyCount = Number(command[2] ?? 0);
          const script = String(command[1] ?? '');
          if (Number.isInteger(keyCount) && keyCount > 0 && script.includes("ARGV[i] == ''")) {
            const keys = command.slice(3, 3 + keyCount).map(String);
            const argv = command.slice(3 + keyCount);
            const dataKeyCount = keyCount - 1;
            const dataTtl = Number(argv[keyCount] ?? 0);
            const metaTtl = Number(argv[keyCount + 1] ?? 0);
            for (let index = 0; index < dataKeyCount; index++) {
              const value = String(argv[index] ?? '');
              if (value === '') {
                removeKey(keys[index]!);
              } else {
                writeValue(keys[index]!, value, dataTtl);
              }
            }
            writeValue(keys[dataKeyCount]!, String(argv[dataKeyCount] ?? ''), metaTtl);
            return { result: keyCount };
          }
          if (
            !Number.isInteger(keyCount)
            || keyCount < 0
            || !script.includes("ARGV[#KEYS + i]")
          ) {
            throw new Error('Unexpected pipeline EVAL script');
          }
          const keys = command.slice(3, 3 + keyCount).map(String);
          const values = command.slice(3 + keyCount, 3 + keyCount * 2).map(String);
          const ttls = command.slice(3 + keyCount * 2, 3 + keyCount * 3).map(Number);
          if (keys.length !== keyCount || values.length !== keyCount || ttls.length !== keyCount) {
            throw new Error('Malformed atomic cache publish command');
          }
          for (let index = 0; index < keyCount; index++) {
            writeValue(keys[index]!, values[index]!, ttls[index]!);
          }
          return { result: keyCount };
        }

        if (normalizedVerb === 'EVALSHA' || normalizedVerb === 'EVALSHA_RO') {
          const numericArgs = args.map(Number).filter((value) => Number.isFinite(value));
          const limit = numericArgs.length > 0 ? Math.max(...numericArgs) : 600;
          // Mirrors the Upstash rate-limit Lua response shape enough for gateway
          // policy tests: [remaining, reset_at_ms].
          return { result: [Math.max(0, limit - 1), limit] };
        }

        if (normalizedVerb === 'EXISTS') {
          // Real Redis EXISTS returns 1/0 for single key, count for multi-key.
          // The handler's parity check uses single-key form per pipeline entry,
          // so we just mirror that shape here.
          return { result: redis.has(redisKey) ? 1 : 0 };
        }

        if (normalizedVerb === 'ZADD') {
          let added = 0;
          for (let index = 0; index < args.length; index += 2) {
            const existed = (sortedSets.get(redisKey) ?? []).some((e) => e.member === String(args[index + 1] ?? ''));
            upsertSortedSet(redisKey, Number(args[index] ?? 0), String(args[index + 1] ?? ''));
            if (!existed) added += 1;
          }
          return { result: added };
        }

        if (normalizedVerb === 'ZRANGE') {
          const items = readByRank(redisKey, Number(args[0] ?? 0), Number(args[1] ?? 0));
          const withScores = args.map(String).includes('WITHSCORES');
          if (!withScores) return { result: items.map((item) => item.member) };
          return {
            result: items.flatMap((item) => [item.member, String(item.score)]),
          };
        }

        if (normalizedVerb === 'ZREM') {
          const members = new Set(args.map(String));
          const before = (sortedSets.get(redisKey) ?? []).length;
          sortedSets.set(
            redisKey,
            (sortedSets.get(redisKey) ?? []).filter((entry) => !members.has(entry.member)),
          );
          return { result: before - (sortedSets.get(redisKey) ?? []).length };
        }

        if (normalizedVerb === 'ZREMRANGEBYRANK') {
          const before = (sortedSets.get(redisKey) ?? []).length;
          removeByRank(redisKey, Number(args[0] ?? 0), Number(args[1] ?? 0));
          const after = (sortedSets.get(redisKey) ?? []).length;
          return { result: before - after };
        }

        if (normalizedVerb === 'ZREMRANGEBYSCORE') {
          return { result: removeByScore(redisKey, Number(args[0] ?? 0), Number(args[1] ?? 0)) };
        }

        if (normalizedVerb === 'EXPIRE') {
          if (!redis.has(redisKey)) return { result: 0 };
          setExpiry(redisKey, Number(args[0] ?? 0));
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

export function installRedis(
  fixtures: Record<string, unknown>,
  opts: FakeRedisOptions & { keepVercelEnv?: boolean } = {},
): FakeRedisState {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  if (!opts.keepVercelEnv) delete process.env.VERCEL_ENV;
  const state = createRedisFetch(fixtures, opts);
  globalThis.fetch = state.fetchImpl;
  return state;
}
