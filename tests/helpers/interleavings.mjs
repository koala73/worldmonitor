import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';

const { COMPARE_AND_DELETE_SCRIPT } = createRequire(import.meta.url)('../../scripts/shared/compare-and-delete-script.cjs');

// Model checking for real code that talks to Upstash. Each Redis command is
// one step: Upstash runs a /pipeline's commands in order, but other clients'
// commands can run between them (only /multi-exec is atomic). The explorer
// replays the actors once per order of steps, and per placement of faulty
// requests, and checks the final state of each run. Orders that differ only by
// swapping independent steps (different keys, or two reads) are explored once,
// using sleep sets. Usage and how to read a counterexample:
// .agents/skills/verify-brief-erasure/SKILL.md.

const FAULTS = ['ok', 'dropped', 'lost'];
// A model may stub setTimeout to skip back-off sleeps; the watchdog keeps real time.
const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis;

class Run {
  constructor(prefix, previousReplayKeys, maxFaults, faultable) {
    this.prefix = prefix;
    this.previousReplayKeys = previousReplayKeys;
    this.maxFaults = maxFaults;
    this.faultable = faultable;
    this.choices = [];
    this.widths = [];
    this.pending = [];
    this.trace = [];
    this.replayKeys = [];
    this.faults = 0;
    this.sleep = [];
    this.onChange = null;
  }

  get replaying() {
    return this.choices.length < this.prefix.length;
  }

  choose(width) {
    const pick = this.replaying ? this.prefix[this.choices.length] : 0;
    this.choices.push(pick);
    this.widths.push(width);
    return pick;
  }

  record(entry, replayKey = entry) {
    const i = this.trace.length;
    if (this.replaying && this.previousReplayKeys[i] !== replayKey) {
      throw new Error(`exploreInterleavings: actors are not deterministic; replay step ${i} was "${replayKey}", first run had "${this.previousReplayKeys[i]}"`);
    }
    this.trace.push(entry);
    this.replayKeys.push(replayKey);
  }

  /** `access` is { keys, writes } for one command, or { all: true } for SCAN. */
  step(actor, label, access, apply, replayKey = label) {
    return new Promise((resolve, reject) => {
      this.pending.push({ actor, label, replayKey, access, apply, resolve, reject });
      this.onChange?.();
    });
  }

  fault(actor, label, replayKey = label) {
    if (this.faults >= this.maxFaults || !this.faultable(actor, label)) return 'ok';
    const fault = FAULTS[this.choose(FAULTS.length)];
    if (fault === 'ok') return fault;
    this.faults += 1;
    const what = fault === 'dropped' ? 'request failed, nothing applied' : 'applied, response lost';
    this.record(`${actor}: ${label} (${what})`, `${actor}: ${replayKey} (${what})`);
    return fault;
  }
}

/**
 * @param {object} model
 * @param {(run: Run) => object} model.setup fresh world for one run
 * @param {Array<{ name: string, start: (world: object) => Promise<unknown>, after?: string[] }>} model.actors
 *   an actor with `after` starts once those actors have finished
 * @param {(world: object, outcomes: Record<string, { ok: boolean, value?: unknown, error?: unknown }>) => string | null} model.check
 *   a violation message, or null
 * @param {number} [model.maxFaults] how many requests in one run may fail
 * @param {string[]} [model.faultsIn] only these actors' requests may fail; all by default
 * @param {(actor: string, label: string) => boolean} [model.faultable] only these requests may fail; all by default
 */
export async function exploreInterleavings({ setup, actors, check, maxFaults = 0, faultsIn, faultable = () => true, maxRuns = 200_000 }) {
  const mayFail = (actor, label) => (!faultsIn || faultsIn.includes(actor)) && faultable(actor, label);
  let prefix = [];
  let previousReplayKeys = [];
  for (let runs = 1; runs <= maxRuns; runs += 1) {
    const run = new Run(prefix, previousReplayKeys, maxFaults, mayFail);
    const world = setup(run);
    const outcomes = await execute(run, world, actors);
    const message = outcomes && check(world, outcomes);
    if (message) return { runs, violation: { message, trace: run.trace } };
    previousReplayKeys = run.replayKeys;
    prefix = nextPrefix(run);
    if (!prefix) return { runs, violation: null };
  }
  throw new Error(`exploreInterleavings: more than ${maxRuns} runs; shrink the model or raise maxRuns`);
}

function nextPrefix(run) {
  for (let i = run.choices.length - 1; i >= 0; i -= 1) {
    if (run.choices[i] + 1 < run.widths[i]) return [...run.choices.slice(0, i), run.choices[i] + 1];
  }
  return null;
}

function independent(a, b) {
  if (a.actor === b.actor) return false;
  const x = a.access;
  const y = b.access;
  if (x.all || y.all) return !(x.writes || y.writes);
  if (!x.writes && !y.writes) return true;
  return !x.keys.some((key) => y.keys.includes(key));
}

async function execute(run, world, actors) {
  const outcomes = {};
  const started = new Set();
  const startReady = () => {
    let any = false;
    for (const actor of actors) {
      if (started.has(actor.name)) continue;
      if (!(actor.after ?? []).every((name) => name in outcomes)) continue;
      started.add(actor.name);
      any = true;
      actorContext.run(actor.name, () => actor.start(world)).then(
        (value) => { outcomes[actor.name] = { ok: true, value }; run.onChange?.(); },
        (error) => { outcomes[actor.name] = { ok: false, error }; run.onChange?.(); },
      );
    }
    return any;
  };
  startReady();
  for (;;) {
    do await untilAllParked(run, outcomes, started);
    while (startReady());
    if (run.pending.length === 0) {
      if (Object.keys(outcomes).length === actors.length) return outcomes;
      const waiting = actors.filter((a) => !(a.name in outcomes)).map((a) => a.name);
      throw new Error(`exploreInterleavings: ${waiting.join(', ')} never finished and made no request`);
    }
    const asleep = (step) => run.sleep.some((z) => z.actor === step.actor && z.label === step.label);
    const awake = run.pending.filter((step) => !asleep(step));
    // Every order from here was covered by an earlier sibling.
    if (awake.length === 0) return null;
    const pick = run.choose(awake.length);
    const step = awake[pick];
    run.sleep = [...run.sleep, ...awake.slice(0, pick)].filter((z) => independent(z, step));
    run.pending.splice(run.pending.indexOf(step), 1);
    run.record(`${step.actor}: ${step.label}`, `${step.actor}: ${step.replayKey}`);
    step.resolve(step.apply());
  }
}

function untilAllParked(run, outcomes, started) {
  return new Promise((resolve, reject) => {
    let queued = false;
    const watchdog = realSetTimeout(() => {
      run.onChange = null;
      reject(new Error('exploreInterleavings: an actor is waiting on something other than a modelled request (a timer?)'));
    }, 5_000);
    const check = () => {
      queued = false;
      const parked = new Set(run.pending.map((p) => p.actor));
      if (![...started].every((name) => name in outcomes || parked.has(name))) return;
      realClearTimeout(watchdog);
      run.onChange = null;
      resolve();
    };
    run.onChange = () => {
      if (queued) return;
      queued = true;
      setImmediate(check);
    };
    run.onChange();
  });
}

const actorContext = new AsyncLocalStorage();

export function currentActor() {
  return actorContext.getStore() ?? 'unknown';
}

const READS = new Set(['GET', 'ZRANGE', 'EXISTS', 'TTL', 'PTTL']);

function accessOf(command) {
  const verb = String(command[0]).toUpperCase();
  if (verb === 'SCAN') return { all: true, writes: false };
  if (verb === 'EVAL') return { keys: command.slice(3, 3 + Number(command[2])).map(String), writes: true };
  const keys = verb === 'DEL' ? command.slice(1).map(String) : [String(command[1])];
  return { keys, writes: !READS.has(verb) };
}

/**
 * An in-memory Redis for the commands the modelled code sends. Real Redis
 * semantics that matter to a model: an empty sorted set does not exist, SCAN
 * MATCH is a glob, and SCAN can return fewer keys than COUNT, or none, before
 * its cursor reaches 0.
 * @param {Record<string, string | Record<string, number>>} initial strings, or sorted sets as member → score
 * @param {{ scanCount?: number }} [options] most keys one SCAN call examines
 */
export function createModelRedis(initial = {}, { scanCount = Infinity } = {}) {
  const data = new Map(Object.entries(initial).map(([key, value]) =>
    [key, typeof value === 'string' ? value : new Map(Object.entries(value))]));
  const zset = (key) => {
    const value = data.get(key) ?? new Map();
    if (typeof value === 'string') throw new Error('WRONGTYPE');
    return value;
  };
  const storeZset = (key, set) => {
    if (set.size === 0) data.delete(key);
    else data.set(key, set);
  };
  const scanCursors = new Map();
  const commands = {
    GET: ([key]) => {
      const value = data.get(key);
      if (value instanceof Map) throw new Error('WRONGTYPE');
      return value ?? null;
    },
    SET: ([key, value, ...flags]) => {
      if (flags.some((f) => f.toUpperCase() === 'NX') && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    },
    SETEX: ([key, , value]) => {
      data.set(key, value);
      return 'OK';
    },
    DEL: (keys) => keys.filter((key) => data.delete(key)).length,
    EXPIRE: ([key]) => (data.has(key) ? 1 : 0),
    ZADD: ([key, score, member]) => {
      const set = zset(key);
      const added = set.has(member) ? 0 : 1;
      set.set(member, Number(score));
      storeZset(key, set);
      return added;
    },
    ZREM: ([key, member]) => {
      const set = zset(key);
      const removed = set.delete(member) ? 1 : 0;
      storeZset(key, set);
      return removed;
    },
    ZREMRANGEBYSCORE: ([key, min, max]) => {
      const set = zset(key);
      const low = min === '-inf' ? -Infinity : Number(min);
      const high = max === '+inf' ? Infinity : Number(max);
      let removed = 0;
      for (const [member, score] of set) {
        if (score >= low && score <= high) { set.delete(member); removed += 1; }
      }
      storeZset(key, set);
      return removed;
    },
    ZRANGE: ([key, start, stop]) => {
      const members = [...zset(key)].sort((a, b) => a[1] - b[1]).map(([member]) => member);
      return members.slice(Number(start), Number(stop) === -1 ? undefined : Number(stop) + 1);
    },
    LPUSH: ([key, ...values]) => {
      const list = data.get(key) ?? [];
      if (!Array.isArray(list)) throw new Error('WRONGTYPE');
      list.unshift(...values.reverse());
      data.set(key, list);
      return list.length;
    },
    EVAL: ([script, numKeys, key, token]) => {
      if (script !== COMPARE_AND_DELETE_SCRIPT || numKeys !== '1') throw new Error('model redis: EVAL supports only the pinned compare-and-delete script');
      return data.get(key) === token && data.delete(key) ? 1 : 0;
    },
    SCAN: ([cursor, ...options]) => {
      const flag = (name) => {
        const i = options.findIndex((o) => o.toUpperCase() === name);
        return i < 0 ? undefined : options[i + 1];
      };
      const pattern = flag('MATCH') ?? '*';
      const count = Math.min(Number(flag('COUNT') ?? 10), scanCount);
      // A cursor resumes after the last key it examined, so a key that exists
      // for the whole scan is returned even when others are deleted meanwhile.
      const after = cursor === '0' ? null : scanCursors.get(cursor);
      if (after === undefined) throw new Error(`model redis: unknown SCAN cursor ${cursor}`);
      const rest = [...data.keys()].sort().filter((key) => after === null || key > after);
      const page = rest.slice(0, count);
      let next = '0';
      if (rest.length > count) {
        next = String(scanCursors.size + 1);
        scanCursors.set(next, page[page.length - 1]);
      }
      return [next, page.filter((key) => globToRegExp(pattern).test(key))];
    },
  };
  const cell = (command) => {
    const [verb, ...args] = command.map(String);
    const fn = commands[verb.toUpperCase()];
    if (!fn) throw new Error(`model redis: unsupported command ${verb}`);
    try {
      return { result: fn(args) };
    } catch (err) {
      return { error: err.message };
    }
  };
  return { data, cell };
}

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '\\') source += escapeRegExp(glob[++i] ?? '');
    else if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += escapeRegExp(ch);
  }
  return new RegExp(`^${source}$`, 's');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A fetch that serves the Upstash REST API from `redis`, one step per command;
 * `.requests` counts each actor's HTTP requests. A command on a key for which
 * `isShared` is false runs without a step, since no order can change its
 * effect; two actors touching such a key is an error.
 * A faulty request either never reaches Redis or runs every command and loses
 * the response, which is what a timeout or dropped connection can do.
 */
export function upstashFetch(run, redis, { isShared = () => true } = {}) {
  const requests = {};
  const owners = new Map();
  const local = (actor, command) => {
    const access = accessOf(command);
    if (access.all || access.keys.some(isShared)) return false;
    for (const key of access.keys) {
      const owner = owners.get(key) ?? actor;
      if (owner !== actor) throw new Error(`upstashFetch: ${owner} and ${actor} both touch ${key}, which isShared says is unshared`);
      owners.set(key, actor);
    }
    return true;
  };
  const serve = async (input, init) => {
    const actor = currentActor();
    requests[actor] = (requests[actor] ?? 0) + 1;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    let batch;
    let atomic = false;
    if (url.pathname === '/pipeline' || url.pathname === '/multi-exec') {
      batch = body;
      atomic = url.pathname === '/multi-exec';
    } else if (url.pathname === '/' && Array.isArray(body)) {
      batch = [body];
    } else {
      batch = [url.pathname.split('/').slice(1).map(decodeURIComponent)];
    }
    const describe = (command) => (String(command[0]).toUpperCase() === 'EVAL' ? `EVAL ${command[3]}` : command.slice(0, 2).join(' '));
    const label = batch.length === 1 ? describe(batch[0]) : `${url.pathname.slice(1)} [${batch.map(describe).join(', ')}]`;
    const fault = run.fault(actor, label, JSON.stringify(batch));
    if (fault === 'dropped') throw new TypeError('fetch failed');
    let cells = [];
    if (atomic) {
      const accesses = batch.map(accessOf);
      const access = accesses.some((a) => a.all)
        ? { all: true, writes: accesses.some((a) => a.writes) }
        : { keys: accesses.flatMap((a) => a.keys), writes: accesses.some((a) => a.writes) };
      cells = await run.step(actor, label, access, () => batch.map(redis.cell), JSON.stringify(batch));
    } else {
      for (const command of batch) {
        cells.push(local(actor, command) ? redis.cell(command)
          : await run.step(actor, describe(command), accessOf(command), () => redis.cell(command), JSON.stringify(command)));
      }
    }
    if (fault === 'lost') throw new TypeError('fetch failed');
    const payload = url.pathname === '/pipeline' || url.pathname === '/multi-exec' ? cells : cells[0];
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return Object.assign(serve, { requests });
}
