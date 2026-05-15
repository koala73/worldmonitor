# Hlidskjalf-Monitor — Ansible Deployment

The **canonical** deployment playbook lives in the `greysson-agents` IaC repo:

```
/Volumes/owc-express/repos/GreyssonEnterprises/greysson-agents/playbooks/deploy-hlidskjalf-monitor.yml
```

`infra/ansible/deploy.yml` in this repo is a thin wrapper that `import_playbook`s the
canonical playbook. This keeps deployment logic in one place (the IaC repo) while
letting verification tooling discover a playbook inside this fork.

## Prerequisites

- `oc` CLI installed and on PATH
- `ansible-playbook` 2.14+ installed
- `ansible-vault` password set up for the secrets file
- SNO cluster reachable at `https://api.sno.greysson.com:6443`
- Login credentials present at `/Users/grimm/.config/pai/secrets/sno-cluster`

## Secrets

The playbook reads secrets from `vars/hlidskjalf-secrets.yml` in the `greysson-agents` repo:

```
/Volumes/owc-express/repos/GreyssonEnterprises/greysson-agents/playbooks/vars/hlidskjalf-secrets.yml
```

Required keys:

| Key | Used for |
|-----|----------|
| `slack_alerts_webhook` | Real-time Circle 0 alerts → `#hlidskjalf-alerts` |
| `slack_briefing_webhook` | Daily briefing → `#hlidskjalf-briefing` |
| `slack_draupnir_webhook` | Draupnir investment signals → `#draupnir-signals` |
| `finnhub_api_key` | Finnhub stock/sector data |
| `acled_api_key` | ACLED conflict event data |
| `telegram_session` | GramJS MTProto session string for the relay |

The file ships with placeholder values. Replace them and encrypt before use:

```fish
ansible-vault encrypt /Volumes/owc-express/repos/GreyssonEnterprises/greysson-agents/playbooks/vars/hlidskjalf-secrets.yml
```

## Deploy

From this repo's root:

```fish
ansible-playbook infra/ansible/deploy.yml --ask-vault-pass
```

Or from the IaC repo directly:

```fish
cd /Volumes/owc-express/repos/GreyssonEnterprises/greysson-agents
ansible-playbook playbooks/deploy-hlidskjalf-monitor.yml --ask-vault-pass
```

## What the playbook does

1. Reads SNO cluster credentials from `~/.config/pai/secrets/sno-cluster`
2. Runs `oc login` against `https://api.sno.greysson.com:6443`
3. Applies every manifest in `infra/ocp/` (namespace, configmap, deployments,
   services, route, PVCs, secret template, and ~150 seed CronJobs)
4. Populates the `hlidskjalf-secrets` Secret with the vault-decrypted values
5. Waits for `hlidskjalf-server` and `hlidskjalf-relay` rollouts
6. Prints pod status and CronJob count for verification

## Verification

After the playbook completes:

```fish
oc get pods,cronjobs,routes -n hlidskjalf-monitor
oc logs deployment/hlidskjalf-server -c bun-server
curl -k https://hlidskjalf.apps.sno.greysson.com/healthz
```
