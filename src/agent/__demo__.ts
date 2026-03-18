/**
 * Demo: full pipeline run with cyberpunk HUD output.
 */
import { ingest, encode, filter, collapse, synthesize } from './pipeline/stages';
import { renderBrief } from './runtime/status';
import type { SignalDomain, Severity, IntelligenceBrief } from './types';

// Simulate a real convergence scenario
const inputs = [
  { domain: 'conflict' as SignalDomain, rawItems: [{ id: 'ua-1', severity: 'high' as Severity, regions: ['UA'], timestamp: Date.now() - 900000, payload: { type: 'battle', location: 'Donetsk' }, confidence: 0.95, tags: ['conflict'] }] },
  { domain: 'military' as SignalDomain, rawItems: [{ id: 'ua-2', severity: 'high' as Severity, regions: ['UA'], timestamp: Date.now() - 600000, geo: { lat: 48.0, lon: 37.8 }, payload: { type: 'surge', aircraft: 12 }, confidence: 0.9, tags: ['military'] }] },
  { domain: 'infrastructure' as SignalDomain, rawItems: [{ id: 'ua-3', severity: 'medium' as Severity, regions: ['UA'], timestamp: Date.now() - 300000, payload: { type: 'outage', asn: 'AS13249' }, confidence: 0.85, tags: ['infra'] }] },
  { domain: 'cyber' as SignalDomain, rawItems: [{ id: 'ir-1', severity: 'high' as Severity, regions: ['IR'], timestamp: Date.now() - 1200000, payload: { type: 'c2_server' }, confidence: 0.8, tags: ['cyber'] }] },
  { domain: 'economic' as SignalDomain, rawItems: [{ id: 'us-1', severity: 'medium' as Severity, regions: ['US'], timestamp: Date.now(), payload: { verdict: 'CAUTIOUS' }, confidence: 0.85, tags: ['macro'] }] },
  { domain: 'news' as SignalDomain, rawItems: [{ id: 'n-1', severity: 'low' as Severity, regions: ['US'], timestamp: Date.now() - 7200000, payload: { title: 'Markets steady' }, confidence: 0.6, tags: ['news'] }] },
];

const signals = ingest(inputs);
const encoded = encode(signals);
const filtered = filter(encoded);
const collapsed = collapse(filtered);
const synthesis = synthesize(collapsed);

const brief: IntelligenceBrief = {
  id: 'demo-brief',
  timestamp: Date.now(),
  threatLevel: synthesis.overallThreatLevel,
  findings: synthesis.findings,
  focalPoints: synthesis.focalPoints,
  recommendations: ['WATCH: UA convergence across 3 domains', 'MONITOR: IR cyber activity elevated'],
  pipelineRunId: 'demo-run-1',
  signalCount: signals.length,
  domainsCovered: [...new Set(signals.map(s => s.domain))],
};

console.log(renderBrief(brief));
console.log();
console.log('Pipeline stats:');
console.log('  Signals ingested:', signals.length);
console.log('  After encoding:', encoded.length);
console.log('  After filtering:', filtered.length);
console.log('  After collapse:', collapsed.length);
console.log('  Findings:', synthesis.findings.length);
console.log('  Focal points:', synthesis.focalPoints.length);
console.log('  Threat level:', synthesis.overallThreatLevel);
