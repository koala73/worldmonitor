#!/usr/bin/env bash
# Starts Deploy Gate for a PR that a workflow opened with github.token.
#
# GitHub fires no workflow_run event for a run whose actor is the Actions
# token, so Deploy Gate's event path never evaluates such a PR. Only the
# 30-minute sweep reaches it (#10011), which left #10090 blocked for about
# half an hour after its checks passed. This waits for the PR's own
# pull_request runs to finish, then dispatches the gate for that exact head.
#
# A PR opened with a user or app token (REVIEW_PR_TOKEN) gets the normal event
# path, so it is left alone. On timeout the gate is dispatched anyway: it posts
# pending and the sweep keeps retrying, as it would without this step.
#
# Env: REPO (owner/name), BRANCH (PR head branch), GH_TOKEN (actions: write),
# optional POLL_SECONDS (default 60) and MAX_WAIT_SECONDS (default 3000).
set -euo pipefail

: "${REPO:?REPO is required}"
: "${BRANCH:?BRANCH is required}"
poll_seconds=${POLL_SECONDS:-60}
max_wait_seconds=${MAX_WAIT_SECONDS:-3000}

pr=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open \
  --json number,headRefOid,author --jq '.[0] // empty')
if [ -z "$pr" ]; then
  echo "No open PR for ${BRANCH}; nothing to gate."
  exit 0
fi

number=$(jq -r '.number' <<<"$pr")
sha=$(jq -r '.headRefOid' <<<"$pr")
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::PR #${number} has no valid head SHA: ${sha}"
  exit 1
fi
if ! jq -e '.author.is_bot == true and .author.login == "app/github-actions"' <<<"$pr" >/dev/null; then
  echo "PR #${number} was not opened with the Actions token; its CI events drive Deploy Gate."
  exit 0
fi

waited=0
while :; do
  statuses=$(gh api "repos/${REPO}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100" \
    --jq '[.workflow_runs[].status]')
  total=$(jq 'length' <<<"$statuses")
  open=$(jq '[.[] | select(. != "completed")] | length' <<<"$statuses")
  if [ "$total" -gt 0 ] && [ "$open" -eq 0 ]; then
    echo "All ${total} pull_request runs on ${sha} completed."
    break
  fi
  if [ "$waited" -ge "$max_wait_seconds" ]; then
    echo "::warning::PR #${number} still has ${open} of ${total} pull_request runs open after ${waited}s; dispatching Deploy Gate anyway, the sweep retries a pending gate."
    break
  fi
  sleep "$poll_seconds"
  waited=$((waited + poll_seconds))
done

gh workflow run deploy-gate.yml --repo "$REPO" --ref main -f sha="$sha"
echo "Dispatched Deploy Gate for PR #${number} at ${sha}."
