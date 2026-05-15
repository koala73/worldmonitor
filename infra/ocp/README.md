# Hlidskjalf-Monitor — OpenShift Manifests

Raw OCP manifests for deploying hlidskjalf-monitor to the SNO cluster
(`grimm-lin`, namespace `hlidskjalf-monitor`). Apply with the Ansible playbook
in [`../ansible/`](../ansible/README.md), not by hand.

## Image Tagging Strategy

Images live in the public Quay registry:

| Image | Built from |
|-------|------------|
| `image-registry.openshift-image-registry.svc:5000/hlidskjalf-monitor/hlidskjalf-mon`   | `Dockerfile.bun-server` (Bun + Hono server, yt-dlp, dashboard static) |
| `quay.io/greyssonenterprises/hlidskjalf-relay` | `Dockerfile.relay` (Node + GramJS Telegram MTProto, OREF/RSS proxy)   |

Each build produces **two tags**:

- `:latest` — moving pointer, used by Deployment/CronJob manifests by default
- `:<git-sha>` — immutable, e.g. `:a1b2c3d`, for rollback or pinning

Build + push both images with:

```fish
./scripts/build-image.sh             # build + push :latest and :<sha>
./scripts/build-image.sh --no-push   # local build only
```

The script auto-detects podman (preferred) or docker. To roll a Deployment to
a specific SHA without changing the manifest:

```fish
oc set image deploy/hlidskjalf-server bun-server=image-registry.openshift-image-registry.svc:5000/hlidskjalf-monitor/hlidskjalf-mon:a1b2c3d -n hlidskjalf-monitor
```

## Ops CronJobs

Four operational CronJobs (separate from the ~150 `cronjob-seed-*` data
collectors) keep the deployment healthy:

| Manifest | Schedule | What it does |
|----------|----------|--------------|
| `cronjob-backup-redis.yaml`     | `0 2 * * *`     | Runs Redis `BGSAVE`, then copies `dump.rdb` and `/app/data` (config-data PVC) into a timestamped backup directory on the backup PVC. |
| `cronjob-monitor-jobs.yaml`     | `*/15 * * * *` | Queries OCP API for failed Jobs in the namespace over the last 15m and posts a Block Kit alert to `#hlidskjalf-alerts` if any are found. Requires `hlidskjalf-monitor-sa` ServiceAccount + `jobs/cronjobs` read RBAC (see header comment in the manifest). |
| `cronjob-freshness-check.yaml`  | `*/15 * * * *` | Runs `scripts/check-freshness.mjs`. Reads `seed:lastrun:*` markers from Redis and alerts to `#hlidskjalf-alerts` if any tracked source is older than its threshold (30m for `weather-alerts`, 1h for `conflict-intel`, `prediction-markets`, `military-flights`, `climate-anomalies`, `portwatch`). |
| `cronjob-daily-briefing.yaml`   | `0 13 * * *`    | *(Created by delivery teammate.)* Runs the daily intelligence briefing renderer and posts to `#hlidskjalf-briefing`. 13:00 UTC = 06:00 Pacific. |

The ~150 `cronjob-seed-*.yaml` files are the data-collection cron jobs (one
per `scripts/seed-*.mjs`) and are not ops manifests.

## Deploy

End-to-end deploy is driven by Ansible, not raw `oc apply`. The playbook
applies every YAML in this directory and then populates the `hlidskjalf-secrets`
Secret from `ansible-vault`-encrypted values.

```fish
ansible-playbook infra/ansible/deploy.yml --ask-vault-pass
```

The canonical playbook lives in the `greysson-agents` IaC repo:

```
/Volumes/owc-express/repos/GreyssonEnterprises/greysson-agents/playbooks/deploy-hlidskjalf-monitor.yml
```

See [`../ansible/README.md`](../ansible/README.md) for the full workflow,
secrets schema, and verification commands.

## Quick reference — manual apply (not recommended)

For ad-hoc updates of a single manifest you can still:

```fish
oc apply -f infra/ocp/cronjob-freshness-check.yaml
```

But the secrets Secret will be empty unless you re-run the Ansible playbook.
