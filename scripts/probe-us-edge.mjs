#!/usr/bin/env node
/**
 * 🛰️ US Edge Probe — manual CLI wrapper.
 *
 * The probe runs in production as a Vercel cron (api/ops/edge-probe.js every
 * 15 min + api/ops/edge-probe-summary.js daily); the full logic lives in
 * api/ops/_probe-core.js. This wrapper exists for ad-hoc local runs and for
 * the manual GitHub Actions dispatch (.github/workflows/edge-probe.yml).
 *
 * Usage:
 *   WM_PROBE_KEY=<key> node scripts/probe-us-edge.mjs [av] [--summary]
 *
 * Env: WM_PROBE_KEY (or WORLDMONITOR_VALID_KEYS), WM_SLACK_ALERT_WEBHOOK
 * (optional — omit for stdout-only), GLOBALPING_TOKEN (optional),
 * UPSTASH_REDIS_REST_URL/_TOKEN (optional — intro-once marker).
 *
 * Exit code: 1 when problems were detected in alert mode (CI-friendly),
 * 0 otherwise (summary mode never fails the job).
 */

import { runEdgeProbe } from '../api/ops/_probe-core.js';

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const av = args.find((a) => !a.startsWith('--')) || '2.2';

const result = await runEdgeProbe({ summary, av });
if (!result.healthy && !summary) process.exit(1);
