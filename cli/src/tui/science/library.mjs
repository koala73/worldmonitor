// On-disk library for the Phenomena view: findings the research runs produced,
// one explainer (storyboard) file per finding, and a log of runs. Lives under
// the XDG data dir and never holds credentials.
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Empty when the environment names no home at all (headless harnesses): the
// library then lives in memory and never touches the user's real data.
export function dataDir(env = process.env, home = env.HOME || env.USERPROFILE || '') {
  if (env.WM_PHENOMENA_DIR) return env.WM_PHENOMENA_DIR;
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, 'worldmonitor', 'phenomena');
  if (!home) return '';
  return join(home, '.local', 'share', 'worldmonitor', 'phenomena');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(tmp, file); // atomic replace
}

export class Library {
  constructor({ dir = dataDir() } = {}) {
    this.dir = dir || '';
    this.memory = this.dir ? null : { findings: [], explainers: new Map() };
    this.explainerDir = join(dir, 'explainers');
    this.findingsFile = join(dir, 'findings.json');
    this.runsFile = join(dir, 'runs.jsonl');
  }

  ensure() {
    if (this.dir) mkdirSync(this.explainerDir, { recursive: true });
  }

  loadFindings() {
    const list = this.memory ? this.memory.findings : readJson(this.findingsFile, []);
    return Array.isArray(list) ? list.filter((f) => f && typeof f === 'object' && f.id && f.title) : [];
  }

  saveFindings(list) {
    if (this.memory) {
      this.memory.findings = list;
      return;
    }
    this.ensure();
    writeJson(this.findingsFile, list);
  }

  // Merge new findings into the saved list (newest first, by id).
  addFindings(incoming) {
    const have = this.loadFindings();
    const byId = new Map(have.map((f) => [f.id, f]));
    for (const f of incoming) byId.set(f.id, { ...(byId.get(f.id) || {}), ...f });
    const merged = [...byId.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    this.saveFindings(merged);
    return merged;
  }

  removeFinding(id) {
    const list = this.loadFindings().filter((f) => f.id !== id);
    this.saveFindings(list);
    return list;
  }

  explainerFile(id) {
    return join(this.explainerDir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  hasExplainer(id) {
    return this.memory ? this.memory.explainers.has(id) : existsSync(this.explainerFile(id));
  }

  loadExplainer(id) {
    return this.memory ? this.memory.explainers.get(id) || null : readJson(this.explainerFile(id), null);
  }

  saveExplainer(id, storyboard) {
    if (this.memory) {
      this.memory.explainers.set(id, storyboard);
      return;
    }
    this.ensure();
    writeJson(this.explainerFile(id), storyboard);
  }

  explainerIds() {
    if (this.memory) return [...this.memory.explainers.keys()];
    try {
      return readdirSync(this.explainerDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  logRun(entry) {
    if (this.memory) return;
    try {
      this.ensure();
      appendFileSync(this.runsFile, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
    } catch {
      // the log is a convenience
    }
  }
}
