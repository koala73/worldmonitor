# Hlidskjalf-Monitor Deployment Status
*Last updated: 2026-05-13 — resume from here in the next session*

---

## DONE — Files verified on disk

| Item | Status | Notes |
|------|--------|-------|
| `infra/ocp/namespace.yaml` | ✅ | |
| `infra/ocp/secret.yaml` | ✅ | Template — values are empty strings |
| `infra/ocp/configmap.yaml` | ✅ | |
| `infra/ocp/deployment-server.yaml` | ✅ | bun-server + Redis 7 sidecar |
| `infra/ocp/services.yaml` | ✅ | server-svc:3000, redis-svc:6379, relay-svc:8080 |
| `infra/ocp/route.yaml` | ✅ | Edge TLS → hlidskjalf.apps.sno.greysson.com |
| `infra/ocp/pvcs.yaml` | ✅ | redis-data 1Gi, config-data 100Mi |
| `infra/ocp/deployment-relay.yaml` | ✅ | |
| `infra/ocp/cronjob-seed-*.yaml` | ✅ | 149 files, one per `scripts/seed-*.mjs` |
| `infra/ocp/cronjob-backup-redis.yaml` | ✅ | Daily 02:00 UTC |
| `infra/ocp/cronjob-monitor-jobs.yaml` | ✅ | Every 15m Slack heartbeat |
| `Dockerfile.bun-server` | ✅ | oven/bun:1-alpine, yt-dlp, USER 1001, HEALTHCHECK /healthz |
| `Dockerfile.relay` | ✅ | USER 1001 added |
| `src/services/clerk.ts` | ✅ | Replaced with no-op stub |
| `server/_shared/rate-limit.ts` | ✅ | Replaced with ioredis sliding window |
| `server/auth-session.ts` | ✅ | Always returns valid single-user session |
| `server/_shared/entitlement-check.ts` | ✅ | Always allows |
| `server/_shared/user-api-key.ts` | ✅ | Reads from env var |
| `server/_shared/pro-mcp-token.ts` | ✅ | No-op stub |
| `server/worldmonitor/leads/v1/submit-contact.ts` | ✅ | Returns 200 OK |
| `server/worldmonitor/leads/v1/register-interest.ts` | ✅ | Returns 200 OK |
| `server/server.ts` | ✅ | Hono, binds 0.0.0.0:3000, mounts gateway, /healthz |
| `/healthz` endpoint | ✅ | Checks Redis ping, 3 seed freshness keys, relay HTTP probe |
| `server/worldmonitor/spatial/` | ✅ | index.ts, h3-index.ts, query.ts, panel.ts |
| `server/worldmonitor/circle0/` | ✅ | index.ts, areas.ts, threat-scorer.ts, geofencing.ts, emergency-tier.ts, panel.ts |
| `server/worldmonitor/youtube-osint/` | ✅ | index.ts, rss-monitor.ts, transcript.ts, fabric-analysis.ts, pattern-registry.ts, panel.ts |
| `server/worldmonitor/local-intel/` | ✅ | index.ts, enforcement-detector.ts, crime-trends.ts, citizen-ingestor.ts, panel.ts |
| `server/worldmonitor/draupnir/` | ✅ | index.ts, signal-classifier.ts, relevance-scorer.ts, actionability.ts, persistence.ts, panel.ts |
| `server/worldmonitor/slack/formatter.ts` | ✅ | Block Kit, severity color coding, map thumbnails |
| `server/worldmonitor/slack/webhooks.ts` | ✅ | 3 webhook senders, rate limiting, hourly batch queue |
| Cloud dep grep | ✅ | No `@clerk`, `@convex`, or `@upstash` import statements remain |
| Ansible playbook | ✅ | **At wrong path** (see NOT DONE below) |

---

## NOT DONE — Must complete before deployment

### 1. Ansible playbook is at the wrong path
- **Current location**: `/Volumes/owc-express/gdrive-personal/areas/infrastructure/coding/GreyssonEnterprises/greysson-agents/playbooks/deploy-hlidskjalf-monitor.yml`
- **Correct location**: `/Volumes/owc-express/repos/GreyssonEnterprises/greysson-agents/playbooks/deploy-hlidskjalf-monitor.yml`
- **Fix**: `cp` or `mv` it to the repos path.

### 2. Ansible vars file doesn't exist
- Needs: `greysson-agents/playbooks/vars/hlidskjalf-secrets.yml` (ansible-vault encrypted)
- Required keys: `slack_alerts_webhook`, `slack_briefing_webhook`, `slack_draupnir_webhook`, `finnhub_api_key`, `acled_api_key`, `telegram_session`

### 3. New modules are not wired into WorldMonitor's data flow
The TypeScript files exist but nothing calls them. Specifically:
- Intelligence modules (`spatial`, `circle0`, `youtube-osint`, `local-intel`) are not registered in `server/worldmonitor/intelligence/` correlation engine
- `draupnir` module is not registered as a consumer of correlation output
- Circle 0 geofence callbacks don't call `sendAlert()`
- Daily briefing doesn't call `sendBriefing()`
- New `/api/worldmonitor/spatial`, `/api/worldmonitor/circle0`, etc. panel endpoints are not registered in `server/gateway.ts` or `server/router.ts`

### 4. Tests have not been run
- `bun test` crashes on e2e Playwright files (pre-existing version conflict, unrelated to this work)
- `npm run test:data` fails because `tsx` is not installed (`sh: tsx: command not found`)
- `npm run test:sidecar` untested
- Unknown whether the new server modules break any existing tests
- New modules have zero test coverage

### 5. Missing Hlidskjalf ports
- Reddit OSINT ingestor not ported from `hlidskjalf/src/ingestors/reddit.ts`
- Enhanced ADS-B → GPS jamming derivation not ported
- Local news RSS feeds not added

### 6. Dependencies not verified
- `ioredis`, `hono`, `@hono/node-server` were added by a background agent — not verified in `package.json` or that `npm install` completed cleanly
- `tsx` is missing — needed for `npm run test:data`

### 7. Nothing is deployed
- Images not built or pushed to `quay.io/greyssonenterprises`
- `oc apply` has not been run
- No pods are running on SNO

---

## Recommended next session order

1. Verify `ioredis`, `hono`, `@hono/node-server` are in `package.json`; run `npm install` if needed
2. Move Ansible playbook to `repos/GreyssonEnterprises/greysson-agents/playbooks/`
3. Run `npm run test:sidecar` to get a baseline pass/fail count
4. Fix `tsx` missing: `npm install -D tsx`; then run `npm run test:data`
5. Wire new modules into correlation engine and gateway router
6. Wire Circle 0 → Slack, Draupnir → Slack
7. Create `vars/hlidskjalf-secrets.yml` with real values (ansible-vault encrypt)
8. Build and push images
9. Run Ansible playbook against SNO
10. Verify pods, CronJobs, dashboard, Slack delivery
