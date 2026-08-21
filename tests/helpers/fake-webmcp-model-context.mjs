function domException(name, message) {
  return new DOMException(message, name);
}

function registrationErrorFor(option, tool) {
  if (typeof option === 'function') return option(tool) ?? null;
  if (option instanceof Map) return option.get(tool.name) ?? null;
  return option?.[tool.name] ?? null;
}

/**
 * Small behavioral model of the public WebMCP registry surface used by tests.
 * It intentionally models only registerTool/getTools/executeTool and abort
 * ownership; browser implementation details are outside this contract.
 */
export class FakeWebMcpModelContext {
  #tools = new Map();
  #pending = new Map();
  #deferredToolNames;
  #registrationFailure;

  constructor({
    deferredToolNames = [],
    deferAllRegistrations = false,
    registrationFailure = null,
  } = {}) {
    this.#deferredToolNames = deferAllRegistrations
      ? null
      : new Set(deferredToolNames);
    this.deferAllRegistrations = deferAllRegistrations;
    this.#registrationFailure = registrationFailure;
    this.registrationCalls = [];
    this.executionCalls = [];
  }

  registerTool(tool, options = {}) {
    const signal = options.signal;
    this.registrationCalls.push({ tool, signal });

    if (signal?.aborted) {
      return Promise.reject(domException('AbortError', 'Registration was aborted.'));
    }
    if (!tool || typeof tool !== 'object'
      || typeof tool.name !== 'string'
      || typeof tool.description !== 'string'
      || !tool.inputSchema
      || typeof tool.execute !== 'function') {
      return Promise.reject(new TypeError('Invalid WebMCP tool definition.'));
    }
    if (this.#tools.has(tool.name) || this.#pending.has(tool.name)) {
      return Promise.reject(domException('InvalidStateError', 'Tool name is already registered.'));
    }

    const configuredFailure = registrationErrorFor(this.#registrationFailure, tool);
    if (configuredFailure) return Promise.reject(configuredFailure);

    if (this.deferAllRegistrations || this.#deferredToolNames?.has(tool.name)) {
      return this.#deferRegistration(tool, signal);
    }
    return this.#acceptRegistration(tool, signal);
  }

  #acceptRegistration(tool, signal) {
    if (signal?.aborted) {
      return Promise.reject(domException('AbortError', 'Registration was aborted.'));
    }
    const descriptor = Object.freeze({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: JSON.stringify(tool.inputSchema),
      annotations: tool.annotations,
    });
    this.#tools.set(tool.name, { tool, signal, descriptor });
    signal?.addEventListener('abort', () => {
      const current = this.#tools.get(tool.name);
      if (current?.signal === signal) this.#tools.delete(tool.name);
    }, { once: true });
    return Promise.resolve();
  }

  #deferRegistration(tool, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.#pending.get(tool.name);
        if (pending?.signal !== signal) return;
        this.#pending.delete(tool.name);
        reject(domException('AbortError', 'Registration was aborted.'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.#pending.set(tool.name, { tool, signal, resolve, reject, abort });
    });
  }

  async releaseRegistration(name) {
    const pending = this.#pending.get(name);
    if (!pending) return false;
    this.#pending.delete(name);
    pending.signal?.removeEventListener('abort', pending.abort);
    try {
      await this.#acceptRegistration(pending.tool, pending.signal);
      pending.resolve();
    } catch (error) {
      pending.reject(error);
    }
    return true;
  }

  async releaseAllRegistrations() {
    const names = [...this.#pending.keys()];
    await Promise.all(names.map((name) => this.releaseRegistration(name)));
  }

  rejectRegistration(name, error = domException('NotAllowedError', 'Registration was denied.')) {
    const pending = this.#pending.get(name);
    if (!pending) return false;
    this.#pending.delete(name);
    pending.signal?.removeEventListener('abort', pending.abort);
    pending.reject(error);
    return true;
  }

  async getTools() {
    return [...this.#tools.values()]
      .map(({ descriptor }) => descriptor)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async executeTool(registeredTool, inputJson, options = {}) {
    const entry = registeredTool && typeof registeredTool === 'object'
      ? this.#tools.get(registeredTool.name)
      : undefined;
    const name = entry?.descriptor === registeredTool ? registeredTool.name : '';
    if (!entry) throw domException('InvalidStateError', 'Tool is not registered.');
    if (!name) throw domException('InvalidStateError', 'Tool descriptor is stale or foreign.');
    if (typeof inputJson !== 'string') throw new TypeError('Tool input must be JSON text.');

    let args;
    try {
      args = JSON.parse(inputJson);
    } catch {
      throw new TypeError('Tool input must be valid JSON text.');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new TypeError('Tool input must decode to an object.');
    }

    const signal = options.signal;
    if (signal?.aborted) throw domException('AbortError', 'Tool execution was aborted.');
    this.executionCalls.push({ name, args, signal });

    let abortListener;
    const aborted = signal
      ? new Promise((_, reject) => {
          abortListener = () => reject(domException('AbortError', 'Tool execution was aborted.'));
          signal.addEventListener('abort', abortListener, { once: true });
        })
      : new Promise(() => {});
    try {
      return await Promise.race([
        Promise.resolve(entry.tool.execute(args, { signal })),
        aborted,
      ]);
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  get pendingRegistrationNames() {
    return [...this.#pending.keys()].sort();
  }
}

export function createFakeWebMcpRuntime(modelContext, track = () => {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();

  function addListener(store, type, listener, options = {}) {
    store.set(type, { listener, once: options.once === true });
    options.signal?.addEventListener('abort', () => store.delete(type), { once: true });
  }

  function dispatch(store, type) {
    const registration = store.get(type);
    if (!registration) return false;
    if (registration.once) store.delete(type);
    registration.listener(new Event(type));
    return true;
  }

  const document = {
    modelContext,
    addEventListener(type, listener, options) {
      addListener(documentListeners, type, listener, options);
    },
  };
  const window = {
    addEventListener(type, listener, options) {
      addListener(windowListeners, type, listener, options);
    },
  };

  return {
    document,
    window,
    runtime: { document, window, track },
    documentListeners,
    windowListeners,
    dispatchDocument(type) { return dispatch(documentListeners, type); },
    dispatchWindow(type) { return dispatch(windowListeners, type); },
  };
}
