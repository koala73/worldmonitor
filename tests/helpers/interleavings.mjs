import { AsyncLocalStorage } from 'node:async_hooks';

// Model checking for real code that talks to Upstash. Each Redis command is
// one step: Upstash runs a /pipeline's commands in order, but other clients'
// commands can run between them (only /multi-exec is atomic). The explorer
// replays the actors once per order of steps, and per placement of faulty
// requests, and checks the final state of each run. Orders that differ only by
// swapping independent steps (different keys, or two reads) are explored once,
// using sleep sets. Usage and how to read a counterexample:
// .agents/skills/verify-brief-erasure/SKILL.md.

const FAULTS = ['ok', 'dropped', 'lost'];

class Run {
  constructor(prefix, previousTrace, maxFaults, faultsIn) {
    this.prefix = prefix;
    this.previousTrace = previousTrace;
    this.maxFaults = maxFaults;
    this.faultsIn = faultsIn;
    this.choices = [];
    this.widths = [];
    this.pending = [];
    this.trace = [];
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

  record(entry) {
    const i = this.trace.length;
    if (this.replaying && this.previousTrace[i] !== entry) {
      throw new Error(`exploreInterleavings: actors are not deterministic; replay step ${i} was "${entry}", first run had "${this.previousTrace[i]}"`);
    }
    this.trace.push(entry);
  }

  /** `access` is { keys, writes } for one command, or { all: true } for SCAN. */
  step(actor, label, access, apply) {
    return new Promise((resolve, reject) => {
      this.pending.push({ actor, label, access, apply, resolve, reject });
      this.onChange?.();
    });
  }

  fault(actor, label) {
    if (this.faults >= this.maxFaults || (this.faultsIn && !this.faultsIn.includes(actor))) return 'ok';
    const fault = FAULTS[this.choose(FAULTS.length)];
    if (fault === 'ok') return fault;
    this.faults += 1;
    this.record(`${actor}: ${label} (${fault === 'dropped' ? 'request failed, nothing applied' : 'applied, response lost'})`);
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
 */
export async function exploreInterleavings({ setup, actors, check, maxFaults = 0, faultsIn, maxRuns = 200_000 }) {
  let prefix = [];
  let previousTrace = [];
  for (let runs = 1; runs <= maxRuns; runs += 1) {
    const run = new Run(prefix, previousTrace, maxFaults, faultsIn);
    const world = setup(run);
    const outcomes = await execute(run, world, actors);
    const message = outcomes && check(world, outcomes);
    if (message) return { runs, violation: { message, trace: run.trace } };
    previousTrace = run.trace;
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
    for (const actor of actors) {
      if (started.has(actor.name)) continue;
      if (!(actor.after ?? []).every((name) => name in outcomes)) continue;
      started.add(actor.name);
      actorContext.run(actor.name, () => actor.start(world)).then(
        (value) => { outcomes[actor.name] = { ok: true, value }; run.onChange?.(); },
        (error) => { outcomes[actor.name] = { ok: false, error }; run.onChange?.(); },
      );
    }
  };
  startReady();
  for (;;) {
    await untilAllParked(run, outcomes, started);
    startReady();
    await untilAllParked(run, outcomes, started);
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
    run.record(`${step.actor}: ${step.label}`);
    step.resolve(step.apply());
  }
}

function untilAllParked(run, outcomes, started) {
  return new Promise((resolve, reject) => {
    let queued = false;
    const watchdog = setTimeout(() => {
      run.onChange = null;
      reject(new Error('exploreInterleavings: an actor is waiting on something other than a modelled request (a timer?)'));
    }, 5_000);
    const check = () => {
      queued = false;
      const parked = new Set(run.pending.map((p) => p.actor));
      if (![...started].every((name) => name in outcomes || parked.has(name))) return;
      clearTimeout(watchdog);
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

const READS = new Set(['GET', 'ZRANGE', 'EXISTS', 'TTL', 'PTTL']);

function accessOf(command) {
  const verb = String(command[0]).toUpperCase();
  if (verb === 'SCAN') return { all: true, writes: false };
  const keys = verb === 'DEL' ? command.slice(1).map(String) : [String(command[1])];
  return { keys, writes: !READS.has(verb) };
}

/**
 * An in-memory Redis for the commands the modelled code sends. Real Redis
 * semantics that matter to a model: an empty sorted set does not exist, and
 * SCAN MATCH is a glob.
 * @param {Record<string, string | Record<string, number>>} initial strings, or sorted sets as member → score
 */
export function createModelRedis(initial = {}) {
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
    SCAN: ([, , pattern]) => ['0', [...data.keys()].filter((key) => globToRegExp(pattern).test(key))],
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
    const key = String(command[1] ?? '');
    if (isShared(key)) return false;
    const owner = owners.get(key) ?? actor;
    if (owner !== actor) throw new Error(`upstashFetch: ${owner} and ${actor} both touch ${key}, which isShared says is unshared`);
    owners.set(key, actor);
    return true;
  };
  const serve = async (input, init) => {
    const actor = actorContext.getStore() ?? 'unknown';
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
    const describe = (command) => command.slice(0, 2).join(' ');
    const label = batch.length === 1 ? describe(batch[0]) : `${url.pathname.slice(1)} [${batch.map(describe).join(', ')}]`;
    const fault = run.fault(actor, label);
    if (fault === 'dropped') throw new TypeError('fetch failed');
    let cells = [];
    if (atomic) {
      const accesses = batch.map(accessOf);
      const access = accesses.some((a) => a.all)
        ? { all: true, writes: accesses.some((a) => a.writes) }
        : { keys: accesses.flatMap((a) => a.keys), writes: accesses.some((a) => a.writes) };
      cells = await run.step(actor, label, access, () => batch.map(redis.cell));
    } else {
      for (const command of batch) {
        cells.push(local(actor, command) ? redis.cell(command) : await run.step(actor, describe(command), accessOf(command), () => redis.cell(command)));
      }
    }
    if (fault === 'lost') throw new TypeError('fetch failed');
    const payload = url.pathname === '/pipeline' || url.pathname === '/multi-exec' ? cells : cells[0];
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return Object.assign(serve, { requests });
}
