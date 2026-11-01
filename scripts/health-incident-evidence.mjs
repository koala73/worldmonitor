import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HEALTHY = new Set(['OK', 'OK_ZERO', 'OK_CASCADE', 'COVERAGE_MARGIN_LOW']);
const PENDING = new Set(['EMPTY_ON_DEMAND', 'ROLLOUT_PENDING', 'REFRESH_PENDING', 'NOT_CONFIGURED', 'SOURCE_BLOCKED']);

async function appendEvent(directory, event) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${Date.now()}-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(event, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return path;
}

export async function captureHealthEvidence(directory, snapshot, owner) {
  if (!snapshot || !Number.isFinite(Date.parse(snapshot.checkedAt))
    || !snapshot.checks || typeof snapshot.checks !== 'object' || Array.isArray(snapshot.checks)) {
    throw new Error('A full health snapshot with checkedAt and checks is required');
  }
  if (typeof owner !== 'string' || !owner.trim()) throw new Error('An existing incident owner is required');
  for (const check of Object.values(snapshot.checks)) {
    if (!check || typeof check.status !== 'string' || !check.status) throw new Error('Invalid health check status');
  }
  return appendEvent(directory, {
    type: 'observation', observedAt: new Date(snapshot.checkedAt).toISOString(),
    capturedAt: new Date().toISOString(), owner, snapshot,
  });
}

export async function readIncidents(directory) {
  const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  const events = await Promise.all(files.map(async file => JSON.parse(await readFile(join(directory, file), 'utf8'))));
  events.sort((a, b) => a.observedAt.localeCompare(b.observedAt)
    || Number(a.type === 'resolution') - Number(b.type === 'resolution')
    || (a.capturedAt ?? '').localeCompare(b.capturedAt ?? ''));
  const incidents = [];
  const active = new Map();
  for (const event of events) {
    if (event.type === 'resolution') {
      const incident = incidents.find(row => row.id === event.incidentId);
      if (incident) {
        incident.causeStatus = 'resolved';
        incident.resolutionEvidence = event.evidence;
        active.delete(incident.source);
      }
      continue;
    }
    if (event.type !== 'observation') throw new Error('Unknown evidence event');
    for (const [source, check] of Object.entries(event.snapshot.checks)) {
      if (PENDING.has(check.status)) continue;
      let incident = active.get(source);
      if (HEALTHY.has(check.status)) {
        if (incident) {
          incident.state = 'recovered';
          incident.lastSeen = event.observedAt;
          incident.lastStatus = check.status;
        }
        continue;
      }
      if (!incident) {
        incident = {
          id: `${source}@${event.observedAt}`, source, owner: event.owner,
          firstSeen: event.observedAt, occurrences: 1, causeStatus: 'open', state: 'failing',
        };
        incidents.push(incident);
        active.set(source, incident);
      } else if (incident.state === 'recovered') incident.occurrences++;
      incident.state = 'failing';
      incident.lastSeen = event.observedAt;
      incident.lastStatus = check.status;
    }
  }
  return incidents;
}

export async function resolveIncident(directory, incidentId, evidence) {
  if (typeof evidence !== 'string' || !evidence.trim()) throw new Error('Resolution evidence is required');
  const incident = (await readIncidents(directory)).find(row => row.id === incidentId && row.causeStatus === 'open');
  if (!incident) throw new Error('Open incident not found');
  return appendEvent(directory, {
    type: 'resolution', incidentId, evidence, observedAt: incident.lastSeen,
    capturedAt: new Date().toISOString(),
  });
}

async function main([command, directory, input, owner]) {
  if (command === 'capture' && directory && input && owner) {
    console.log(await captureHealthEvidence(directory, JSON.parse(await readFile(input, 'utf8')), owner));
  } else if (command === 'report' && directory) {
    console.log(JSON.stringify(await readIncidents(directory), null, 2));
  } else if (command === 'resolve' && directory && input && owner) {
    console.log(await resolveIncident(directory, input, owner));
  } else {
    throw new Error('Usage: health-incident-evidence.mjs capture DIR SNAPSHOT OWNER | report DIR | resolve DIR INCIDENT_ID EVIDENCE');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
