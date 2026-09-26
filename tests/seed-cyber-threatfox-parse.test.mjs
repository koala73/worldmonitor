import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseThreatFoxRecord } from '../scripts/seed-cyber-threats.mjs';

// ThreatFox (abuse.ch) IOC ingestion: parseThreatFoxRecord maps a ThreatFox
// /api/v1/ `get_iocs` row into the RawThreat shape consumed by the cyber seed.
// ThreatFox rows carry ioc_type ("ip:port" | "domain" | "url"), threat_type
// (e.g. botnet_cc, payload_delivery, credential_phishing), malware_printable,
// and a 0-100 confidence_level that drives severity.

const NOW = Date.now();
const DAY = 86_400_000;
const CUTOFF = NOW - 14 * DAY;

const recent = (days) => new Date(NOW - days * DAY).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

describe('parseThreatFoxRecord', () => {
  it('parses an ip:port IOC into a bare IP c2_server threat', () => {
    const t = parseThreatFoxRecord({
      id: '1', ioc: '192.0.2.10:443', ioc_type: 'ip:port', threat_type: 'botnet_cc',
      malware: 'asyncrat', malware_printable: 'AsyncRAT', confidence_level: 75,
      first_seen: recent(2), last_seen: recent(1), tags: ['asyncrat'],
    }, CUTOFF);
    assert.ok(t, 'record parses');
    assert.equal(t.indicator, '192.0.2.10');
    assert.equal(t.indicatorType, 'ip');
    assert.equal(t.type, 'c2_server');
    assert.equal(t.source, 'threatfox');
    assert.equal(t.severity, 'high');
    assert.equal(t.malwareFamily, 'AsyncRAT');
    assert.ok(t.tags.includes('threatfox'), 'source tag is stamped');
    assert.ok(t.firstSeen > 0 && t.lastSeen > 0, 'UTC dates parse to epoch ms');
  });

  it('keeps domain and url indicators with their own indicator types', () => {
    const domain = parseThreatFoxRecord({
      ioc: 'evil.example.com', ioc_type: 'domain', threat_type: 'payload_delivery',
      malware_printable: 'Emotet', confidence_level: 95, first_seen: recent(1), last_seen: recent(1),
    }, CUTOFF);
    assert.equal(domain.indicatorType, 'domain');
    assert.equal(domain.type, 'malware_host');
    assert.equal(domain.severity, 'critical', 'confidence 95 and Emotet family');

    const url = parseThreatFoxRecord({
      ioc: 'http://evil.example/payload.exe', ioc_type: 'url', threat_type: 'malware_download',
      malware_printable: 'Dridex', confidence_level: 60, first_seen: recent(1), last_seen: recent(1),
    }, CUTOFF);
    assert.equal(url.indicatorType, 'url');
    assert.equal(url.type, 'malware_host');
    assert.equal(url.severity, 'high', 'Dridex family boosts medium -> high');
  });

  it('maps phishing threat types to the phishing classification', () => {
    const t = parseThreatFoxRecord({
      ioc: 'http://login-verify.example/', ioc_type: 'url', threat_type: 'credential_phishing',
      malware_printable: '', confidence_level: 55, first_seen: recent(1), last_seen: recent(1),
    }, CUTOFF);
    assert.equal(t.type, 'phishing');
  });

  it('drops records older than the cutoff window', () => {
    const t = parseThreatFoxRecord({
      ioc: '192.0.2.99:8080', ioc_type: 'ip:port', threat_type: 'botnet_cc',
      confidence_level: 80, first_seen: recent(20), last_seen: recent(20),
    }, CUTOFF);
    assert.equal(t, null, 'stale IOC is filtered out');
  });

  it('drops malformed records instead of throwing', () => {
    assert.equal(parseThreatFoxRecord(null, CUTOFF), null);
    assert.equal(parseThreatFoxRecord({ ioc: '' }, CUTOFF), null);
    assert.equal(parseThreatFoxRecord({ ioc: 'not a url or host!!', ioc_type: 'url' }, CUTOFF), null);
    // ip:port whose host part is not an IP is invalid
    assert.equal(parseThreatFoxRecord({ ioc: 'example.com:80', ioc_type: 'ip:port', first_seen: recent(1) }, CUTOFF), null);
  });

  it('infers indicator type when ioc_type is missing', () => {
    const t = parseThreatFoxRecord({
      ioc: 'http://192.0.2.5/path', threat_type: 'malware_url',
      confidence_level: 50, first_seen: recent(1), last_seen: recent(1),
    }, CUTOFF);
    assert.equal(t.indicatorType, 'ip');
    assert.equal(t.indicator, '192.0.2.5');

    const bareDomain = parseThreatFoxRecord({
      ioc: 'bare.example.org', threat_type: 'malware_domain',
      confidence_level: 50, first_seen: recent(1), last_seen: recent(1),
    }, CUTOFF);
    assert.equal(bareDomain.indicatorType, 'domain');
  });

  it('derives severity from confidence_level with sane thresholds', () => {
    const row = (confidence) => ({
      ioc: '192.0.2.7:443', ioc_type: 'ip:port', threat_type: 'botnet_cc',
      malware_printable: 'Cobalt Strike', first_seen: recent(1), last_seen: recent(1),
      confidence_level: confidence,
    });
    assert.equal(parseThreatFoxRecord(row(90), CUTOFF).severity, 'critical');
    assert.equal(parseThreatFoxRecord(row(75), CUTOFF).severity, 'high');
    assert.equal(parseThreatFoxRecord(row(50), CUTOFF).severity, 'medium');
    assert.equal(parseThreatFoxRecord(row(10), CUTOFF).severity, 'low');
    assert.equal(parseThreatFoxRecord(row(undefined), CUTOFF).severity, 'medium', 'missing confidence defaults to medium');
  });
});
