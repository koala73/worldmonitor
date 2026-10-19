import assert from 'node:assert/strict';

import {
  FANOUT_TRIM_SCRIPT,
  HAZARD_INIT_SCRIPT,
  HAZARD_SEEN_SCRIPT,
  LOCK_RENEW_SCRIPT,
  PRUNE_SCRIPT,
  RECORD_CAS_SCRIPT,
  SEEN_ADD_SCRIPT,
  STATE_HDEL_SCRIPT,
  STATE_WRITE_SCRIPT,
  STATUS_WRITE_SCRIPT,
} from '../../scripts/shipping-webhook-worker.mjs';

/**
 * In-memory stand-in for the Upstash pipeline the shipping webhook worker
 * talks to. Strings, sets, hashes, lists and sorted sets live in one Map;
 * lists are arrays with index 0 at the head (LPUSH unshifts), sorted sets are
 * Maps of member -> score. Every worker Lua script is interpreted by name, so
 * a test exercises the same fenced semantics the worker relies on.
 */
export function fakeRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  const ttl = new Map();
  const log = [];
  const listAt = (key) => {
    const list = store.get(key);
    return Array.isArray(list) ? list : null;
  };
  const run = (command) => {
    const [verb, key, ...args] = command;
    switch (verb) {
      case 'GET': return store.get(key) ?? null;
      case 'SET': {
        if (args.includes('NX') && store.has(key)) return null;
        store.set(key, args[0]);
        if (args[1] === 'EX') ttl.set(key, Number(args[2]));
        else if (!args.includes('KEEPTTL')) ttl.delete(key);
        return 'OK';
      }
      case 'SMEMBERS': return [...(store.get(key) ?? new Set())];
      case 'SADD': {
        const set = store.get(key) ?? new Set();
        let added = 0;
        for (const member of args) if (!set.has(member)) { set.add(member); added += 1; }
        store.set(key, set);
        return added;
      }
      case 'SREM': {
        const set = store.get(key);
        if (!set?.delete(args[0])) return 0;
        if (set.size === 0) store.delete(key);
        return 1;
      }
      case 'DEL': return store.delete(key) ? 1 : 0;
      case 'HGETALL': return Object.entries(store.get(key) ?? {}).flat();
      case 'HSET': {
        const hash = store.get(key) ?? {};
        for (let i = 0; i < args.length; i += 2) hash[args[i]] = args[i + 1];
        store.set(key, hash);
        return args.length / 2;
      }
      case 'EXPIRE': ttl.set(key, Number(args[0])); return store.has(key) ? 1 : 0;
      case 'SCAN': {
        const keys = [...store.keys()].filter((name) => /^webhook:sub:.+:v1$/.test(name));
        return ['0', keys];
      }
      case 'LPUSH': {
        const list = listAt(key) ?? [];
        list.unshift(...args.reverse());
        store.set(key, list);
        return list.length;
      }
      case 'LLEN': return listAt(key)?.length ?? 0;
      case 'LRANGE': {
        const list = listAt(key) ?? [];
        const norm = (index) => (index < 0 ? Math.max(0, list.length + index) : Math.min(index, list.length));
        const start = norm(Number(args[0]));
        const stop = Number(args[1]) < 0 ? list.length + Number(args[1]) : Math.min(Number(args[1]), list.length - 1);
        return stop < start ? [] : list.slice(start, stop + 1);
      }
      case 'ZSCORE': {
        const zset = store.get(key);
        return zset instanceof Map && zset.has(args[0]) ? String(zset.get(args[0])) : null;
      }
      case 'ZCARD': return store.get(key) instanceof Map ? store.get(key).size : 0;
      case 'ZRANGE': {
        const zset = store.get(key);
        if (!(zset instanceof Map)) return [];
        const members = [...zset].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([member]) => member);
        const stop = Number(args[1]) < 0 ? members.length + Number(args[1]) : Number(args[1]);
        return members.slice(Number(args[0]), stop + 1);
      }
      case 'EVAL': {
        const script = key;
        const keys = args.slice(1, 1 + Number(args[0]));
        const argv = args.slice(1 + Number(args[0]));
        if (script === LOCK_RENEW_SCRIPT) return store.get(keys[0]) === argv[0] ? 1 : 0;
        if (store.get(keys[0]) !== argv[0]) return -1;
        if (script === PRUNE_SCRIPT) {
          if (store.has(keys[1])) return 0;
          store.get(keys[2])?.delete(argv[1]);
          store.delete(keys[3]);
          return 1;
        }
        if (script === STATE_WRITE_SCRIPT) {
          if (!store.has(keys[1])) return 0;
          const hash = store.get(keys[2]) ?? {};
          for (let i = 2; i < argv.length; i += 2) hash[argv[i]] = argv[i + 1];
          store.set(keys[2], hash);
          ttl.set(keys[2], Number(argv[1]));
          return 1;
        }
        if (script === STATE_HDEL_SCRIPT) {
          const hash = store.get(keys[1]);
          if (!hash) return 0;
          let removed = 0;
          for (const field of argv.slice(1)) {
            if (field in hash) { delete hash[field]; removed += 1; }
          }
          if (Object.keys(hash).length === 0) store.delete(keys[1]);
          return removed;
        }
        if (script === FANOUT_TRIM_SCRIPT) {
          const list = listAt(keys[1]);
          if (list) {
            const keep = Math.max(0, list.length - Number(argv[1]));
            list.length = keep;
            if (keep === 0) store.delete(keys[1]);
          }
          return 1;
        }
        if (script === SEEN_ADD_SCRIPT) {
          const zset = store.get(keys[1]) instanceof Map ? store.get(keys[1]) : new Map();
          for (const [member, score] of [...zset]) if (score <= Number(argv[1])) zset.delete(member);
          let added = 0;
          for (let i = 3; i + 1 < argv.length; i += 2) {
            if (!zset.has(argv[i + 1])) { zset.set(argv[i + 1], Number(argv[i])); added += 1; }
          }
          store.set(keys[1], zset);
          ttl.set(keys[1], Number(argv[2]));
          return added;
        }
        if (script === HAZARD_INIT_SCRIPT) {
          const hash = store.get(keys[1]) ?? {};
          for (let i = 1; i + 1 < argv.length; i += 2) if (!(argv[i] in hash)) hash[argv[i]] = argv[i + 1];
          store.set(keys[1], hash);
          return 1;
        }
        if (script === HAZARD_SEEN_SCRIPT) {
          const zset = store.get(keys[1]) instanceof Map ? store.get(keys[1]) : new Map();
          for (const [member, score] of [...zset]) if (score <= Number(argv[1])) zset.delete(member);
          let added = 0;
          for (let i = 3; i + 1 < argv.length; i += 2) {
            if (!zset.has(argv[i + 1])) added += 1;
            zset.set(argv[i + 1], Number(argv[i]));
          }
          store.set(keys[1], zset);
          ttl.set(keys[1], Number(argv[2]));
          return added;
        }
        if (script === STATUS_WRITE_SCRIPT) {
          store.set(keys[1], argv[1]);
          ttl.set(keys[1], Number(argv[2]));
          store.set(keys[2], argv[3]);
          ttl.set(keys[2], Number(argv[4]));
          if (argv[5] === '1' && !store.has(keys[3])) store.set(keys[3], '1');
          return 1;
        }
        assert.equal(script, RECORD_CAS_SCRIPT);
        if (store.get(keys[1]) !== argv[1]) return 0;
        store.set(keys[1], argv[2]);
        return 1;
      }
      default: throw new Error(`unexpected command ${verb}`);
    }
  };
  const redis = async (commands) => {
    log.push(...commands);
    return commands.map((command) => ({ result: run(command) }));
  };
  return { redis, store, ttl, log };
}
