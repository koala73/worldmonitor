#!/usr/bin/env bash
set -e
set -o pipefail
SHA=${SHA:-}
# A commit-status description is capped at 140 characters and GitHub
# answers 422 past it. Splicing the whole required-name list in made
# this job CRASH instead of posting its status once enough names were
# in the list — about seven (#6389, run 31357392032, all 20 pending).
# The failure arm is the dangerous one: no `gate` status posted at all
# reads as "missing", not "failure", to branch protection, to
# check-railway-deploy-drift.mjs and to the Seed Freshness Monitor.
# Keep the state and the COUNT, which survive truncation; the full
# list is already in this log. Reserve space for the contract stamp:
# the sweep uses it to distinguish current evidence from a stale
# success that covered an older required list (#5851).
gate_description() {
  text="$1"
  suffix=" $gate_stamp"
  text_limit=$((140 - ${#suffix}))
  if [ "${#text}" -le "$text_limit" ]; then
    printf '%s%s' "$text" "$suffix"
  else
    preview_length=$((text_limit - 3))
    printf '%s...%s' "${text:0:$preview_length}" "$suffix"
  fi
}
name_count() {
  printf '%s\n' "$1" | tr ',' '\n' | wc -l | tr -d ' '
}
# Retry a primary-rate-limit response once at GitHub's published
# reset time. The rate_limit endpoint does not spend primary budget;
# keeping this bounded avoids turning an outage into an infinite job.
gh_api_with_rate_limit_retry() {
  local resource="$1"
  shift
  local error_file output result reset now wait_seconds
  error_file=$(mktemp "${RUNNER_TEMP:-/tmp}/deploy-gate-error.XXXXXX")
  if output=$(gh api "$@" 2>"$error_file"); then
    rm -f "$error_file"
    printf '%s\n' "$output"
    return 0
  else
    result=$?
  fi

  cat "$error_file" >&2
  if ! grep -qi 'rate limit exceeded' "$error_file"; then
    rm -f "$error_file"
    return "$result"
  fi

  reset=$(gh api rate_limit --jq ".resources.$resource.reset" 2>/dev/null || true)
  if ! [ "$reset" -eq "$reset" ] 2>/dev/null; then
    echo "::error::GitHub API rate limit was exhausted and its reset time was unavailable."
    rm -f "$error_file"
    return "$result"
  fi

  now=$(date +%s)
  wait_seconds=$((reset - now + 5))
  if [ "$wait_seconds" -lt 1 ]; then wait_seconds=1; fi
  echo "GitHub $resource API budget exhausted; retrying once in ${wait_seconds}s." >&2
  rm -f "$error_file"
  sleep "$wait_seconds"
  gh api "$@"
}
post_gate_status() {
  local state="$1"
  local description previous error_file result read_failed=0
  description=$(gate_description "$2")
  gate_status_exhausted=0
  if previous=$(gh_api_with_rate_limit_retry core \
    "repos/$REPO/commits/$SHA/status?per_page=100" --paginate --slurp |
    jq -ce 'if type == "array" and length > 0 and all(.[]; (.statuses | type) == "array")
      then [.[].statuses[] | select(.context == "gate")] | sort_by(.id) | last // {}
      else error("Incomplete commit-status response") end'); then
    if printf '%s\n' "$previous" | jq -e --arg state "$state" --arg description "$description" \
      '.state == $state and .description == $description' >/dev/null; then
      echo "gate unchanged for $SHA ($state)"
      return 0
    fi
  else
    echo "::error::Could not read the current gate status for $SHA"
    state="pending"
    description=$(gate_description "Deploy Gate could not read status; retry scheduled")
    read_failed=1
  fi
  error_file=$(mktemp "${RUNNER_TEMP:-/tmp}/deploy-gate-status.XXXXXX")
  if gh_api_with_rate_limit_retry core "repos/$REPO/statuses/$SHA" --method POST \
    --field state="$state" \
    --field context="gate" \
    --field description="$description" 2>"$error_file"; then
    rm -f "$error_file"
    if [ "$read_failed" -eq 1 ]; then
      gate_fallback_handled=1
    fi
    return "$read_failed"
  else
    result=$?
  fi
  cat "$error_file" >&2
  if grep -qi 'This SHA and context has reached the maximum number of statuses' "$error_file"; then
    gate_status_exhausted=1
    echo "::error::Gate status capacity exhausted for $SHA; this head needs a new commit before its status can change."
  fi
  rm -f "$error_file"
  return "$result"
}
# The runner invokes this block with `bash -e`. If anything escapes
# the bounded API retry after evaluation starts, make one last status
# attempt. BASHPID keeps command-substitution subshells from posting
# duplicate statuses; only the SHA's evaluation shell owns the fallback.
gate_shell_pid=$BASHPID
active_sha=""
post_pending_on_exit() {
  exit_code=${1:-$?}
  if [ "$exit_code" -eq 0 ] || [ "$BASHPID" != "$gate_shell_pid" ] || [ -z "$active_sha" ] ||
    [ "${gate_status_exhausted:-0}" -eq 1 ] || [ "${gate_fallback_handled:-0}" -eq 1 ]; then
    return
  fi
  SHA="$active_sha"
  post_gate_status "pending" "Deploy Gate could not evaluate; retry scheduled" || true
}
trap post_pending_on_exit EXIT
# Every job of every workflow named in the workflow_run trigger above.
# A job missing here is never inspected, so it reports red on the PR
# while this gate still posts success — CI theatre, not a gate (#5402).
# tests/ci-workflow-coverage.test.mts fails when this list and those
# workflows drift apart in either direction. `audit-lockfile` is
# deliberately absent: it is a matrix job whose check runs are named
# `audit-lockfile (root)`, `audit-lockfile (scripts)`, … so a bare
# entry would wait on a check run that is never published; the
# always()-running `security-audit` aggregate blocks for it instead.
#
# Entries are check-run NAMES, and the lookup below keeps only the
# last-completed run per name. Test, Typecheck and Lint Code each
# define a job with the id `changes`; the latter two publish under
# `typecheck-changes` / `lint-changes` so all three are evaluated
# instead of two being masked by the third (#5822).
required='["changes","typecheck-changes","lint-changes","docs-stats","unit","consumer-prices","umami-postgres","sidecar","convex-tests","dom-tests","desktop-config","desktop-rust","variant-smoke-full","resilience-validation-smoke","digest-image","typecheck","biome","public-docs","mintlify-slugs","doc-anchors","security-audit","stacked-merge-guard","proto-changes","proto-breaking","fork-artifact-check","internal-generate","internal-auto-generate","internal-merge-freshness","proto-freshness"]'
gate_contract=$(REQUIRED_JOBS="$required" python3 -c 'import hashlib, os; print(hashlib.sha256(os.environ["REQUIRED_JOBS"].encode()).hexdigest()[:12])')
gate_stamp="[gate-contract:$gate_contract]"
repo_owner=${REPO%%/*}
repo_name=${REPO#*/}
# GraphQL is the cheap rollup, but GitHub outages often 503 the
# query endpoint while REST check-runs still answers. Falling back
# lets a SHA-specific dispatch post `gate` instead of stranding the
# PR on the EXIT-trap pending status.
fetch_required_check_runs() {
  local eval_sha="$1"
  local gql_error gql_pages rest_pages
  gql_error=$(mktemp "${RUNNER_TEMP:-/tmp}/deploy-gate-graphql.XXXXXX")
  if gql_pages=$(gh_api_with_rate_limit_retry graphql graphql --paginate --slurp \
    -f owner="$repo_owner" \
    -f name="$repo_name" \
    -F sha="$eval_sha" \
    -f query='query($owner: String!, $name: String!, $sha: GitObjectID!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        object(oid: $sha) {
          ... on Commit {
            statusCheckRollup {
              contexts(first: 100, after: $endCursor) {
                nodes {
                  ... on CheckRun { name conclusion databaseId startedAt completedAt }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      }
    }' 2>"$gql_error"); then
    rm -f "$gql_error"
    printf '%s\n' "$gql_pages" | jq -c --argjson required "$required" '[.[].data.repository.object.statusCheckRollup.contexts.nodes[]? | select(has("name") and (.name as $name | $required | index($name)))]'
    return 0
  fi
  cat "$gql_error" >&2
  rm -f "$gql_error"
  echo "GraphQL check-runs unavailable; falling back to REST" >&2
  rest_pages=$(gh_api_with_rate_limit_retry core \
    "repos/$REPO/commits/$eval_sha/check-runs?per_page=100" \
    --paginate --slurp) || return $?
  printf '%s\n' "$rest_pages" | jq -c --argjson required "$required" '[.[].check_runs[]? | select(.name as $name | $required | index($name)) | {name, conclusion, databaseId: .id, startedAt: .started_at, completedAt: .completed_at}]'
}


emit_output() {
  printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
}

validate_sha() {
  [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || {
    echo "::error::Deploy Gate requires an exact lowercase commit SHA" >&2
    return 1
  }
}

# Enforce the platform bound without silently losing a candidate.
emit_matrix() {
  local matrix="$1"
  local count
  count=$(printf '%s\n' "$matrix" | jq '.include | length')
  if [ "$count" -gt 256 ]; then
    echo "::error::Deploy Gate matrix exceeds 256 SHAs" >&2
    return 1
  fi
  emit_output matrix "$matrix"
  emit_output count "$count"
}

discover() {
  local discovery matrix
  if [ -n "$SHA" ]; then
    SHA=$(printf '%s' "$SHA" | tr 'A-F' 'a-f')
    validate_sha
    discovery=$(jq -nc --arg sha "$SHA" '{kind:"direct",sha:$sha,stale:[],pending:[],missing:[]}')
  else
    pr_gate_states=$(gh_api_with_rate_limit_retry graphql graphql --paginate --slurp \
      -f owner="$repo_owner" \
      -f name="$repo_name" \
      -f query='query($owner: String!, $name: String!, $endCursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequests(first: 100, states: [OPEN], after: $endCursor) {
            nodes {
              headRefOid
              commits(last: 1) {
                nodes {
                  commit {
                    status { context(name: "gate") { state description } }
                  }
                }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }')
    stale_terminal_shas=$(printf '%s\n' "$pr_gate_states" |
      jq -r --arg gate_stamp "$gate_stamp" '
        .[].data.repository.pullRequests.nodes[] |
        .commits.nodes[0].commit.status.context as $gate |
        select(
          $gate != null and
          $gate.state != "PENDING" and
          (($gate.description // "") | endswith($gate_stamp) | not)
        ) |
        .headRefOid
      ' |
      awk '!seen[$0]++')
    pending_shas=$(printf '%s\n' "$pr_gate_states" |
      jq -r '
        .[].data.repository.pullRequests.nodes[] |
        select(.commits.nodes[0].commit.status.context.state == "PENDING") |
        .headRefOid
      ' |
      awk '!seen[$0]++')
    missing_shas=$(printf '%s\n' "$pr_gate_states" | jq -r '
      .[].data.repository.pullRequests.nodes[] |
      select(.commits.nodes[0].commit.status.context == null) |
      .headRefOid
    ')

    discovery=$(jq -nc --arg stale "$stale_terminal_shas" --arg pending "$pending_shas" --arg missing "$missing_shas" '
      def shas: split("\n") | map(select(length > 0)) | reduce .[] as $sha ([]; if index($sha) then . else . + [$sha] end);
      {kind:"sweep", stale:($stale|shas), pending:($pending|shas), missing:($missing|shas)}')
  fi
  printf '%s\n' "$discovery" | jq -e '
    [.stale[], .pending[], .missing[]] as $shas |
    all($shas[]; test("^[0-9a-f]{40}$")) and ($shas|length) == ($shas|unique|length)
  ' >/dev/null
  matrix=$(printf '%s\n' "$discovery" | jq -c '{include:[.stale[]|{sha:.}]}')
  emit_matrix "$matrix"
  emit_output discovery "$discovery"
}

finish_invalidation() {
  local result=$?
  post_pending_on_exit "$result"
  if [ "${gate_status_exhausted:-0}" -eq 1 ]; then
    invalidation_outcome=exhausted
  fi
  jq -nc --arg sha "$SHA" --arg outcome "${invalidation_outcome:-failed}" \
    '{version:1,sha:$sha,outcome:$outcome}' > "$RESULT_PATH"
  return "$result"
}

invalidate() {
  validate_sha
  invalidation_outcome=failed
  trap finish_invalidation EXIT
  for _ in 1 2; do
    active_sha="$SHA"
    if post_gate_status "pending" "Required PR gate contract changed; re-evaluation scheduled"; then
      invalidation_outcome=invalidated
      active_sha=""
      return 0
    fi
    active_sha=""
    if [ "$gate_status_exhausted" -eq 1 ]; then
      invalidation_outcome=exhausted
      return 1
    fi
  done
  echo "::error::Could not invalidate stale gate status for $SHA"
  return 1
}

recover() {
  local plan failed_missing_shas missing_shas failed_gate_shas
  # Strictly collect one immutable result per expected SHA. An unknown outcome
  # must not be evaluated: its worker could have exhausted status capacity.
  plan=$(python3 -c '
import json, os, pathlib, sys
discovery = json.loads(os.environ["DISCOVERY"])
expected = set(discovery["stale"])
results = {}
protocol_failed = False
root = pathlib.Path(os.environ["RESULTS_DIR"])
prefix = "deploy-gate-invalidate-" + os.environ["RUN_ATTEMPT"] + "-"
for directory in sorted(root.iterdir()) if root.exists() else []:
    sha = directory.name.removeprefix(prefix)
    try:
        if directory.name != prefix + sha or sha not in expected or sha in results:
            raise ValueError("Unexpected or duplicate invalidation artifact")
        results[sha] = "unknown"
        path = directory / "result.json"
        if not directory.is_dir() or list(directory.iterdir()) != [path]:
            raise ValueError("Invalid invalidation artifact contents")
        row = json.loads(path.read_text())
        if not isinstance(row, dict) or set(row) != {"version", "sha", "outcome"} or row["version"] != 1 or row["sha"] != sha or row["outcome"] not in ("invalidated", "failed", "exhausted"):
            raise ValueError("Invalid invalidation result")
        results[sha] = row["outcome"]
    except (ValueError, KeyError, TypeError, OSError) as error:
        print("::error::" + str(error) + ": " + str(directory), file=sys.stderr)
        protocol_failed = True
        if sha in expected:
            results[sha] = "unknown"
unknown = expected - results.keys()
if unknown:
    print("::error::Missing invalidation results: " + ", ".join(sorted(unknown)), file=sys.stderr)
    protocol_failed = True
print(json.dumps({
    "stale": [sha for sha in discovery["stale"] if results.get(sha) in {"invalidated", "failed"}],
    "invalidation_failed": any(value != "invalidated" for value in results.values()),
    "protocol_failed": protocol_failed
}, separators=(",", ":")))
')
  missing_shas=$(printf '%s\n' "$DISCOVERY" | jq -r '.missing[]')
  failed_missing_shas=""
  if [ -n "$missing_shas" ]; then
    recent_run_cutoff=$(($(date +%s) - 86400))
    recent_run_cutoff_iso=$(date -u -d "@$recent_run_cutoff" +%Y-%m-%dT%H:%M:%SZ)
    failed_gate_shas=$(gh_api_with_rate_limit_retry core \
      "repos/$REPO/actions/workflows/deploy-gate.yml/runs?event=workflow_run&status=failure&created=>=$recent_run_cutoff_iso&per_page=100" \
      --paginate --slurp |
      jq -r --argjson cutoff "$recent_run_cutoff" '
        .[].workflow_runs[] |
        select(
          (.created_at | fromdateiso8601) >= $cutoff and
          (.display_title | test("^Deploy Gate [0-9a-f]{40}$"))
        ) |
        .display_title |
        sub("^Deploy Gate "; "")
      ')
    failed_missing_shas=$(printf '%s\n' "$missing_shas" | while read -r missing_sha; do
      if printf '%s\n' "$failed_gate_shas" | grep -qx "$missing_sha"; then
        echo "$missing_sha"
      fi
    done)
  fi

  local matrix
  matrix=$(jq -nc --argjson discovery "$DISCOVERY" --argjson plan "$plan" --arg recovered "$failed_missing_shas" '
    {include: (if $discovery.kind == "direct"
      then [{sha:$discovery.sha,check_attempts:2}]
      else ([$plan.stale[]|{sha:.,check_attempts:1}] +
        [$discovery.pending[]|{sha:.,check_attempts:2}] +
        [$recovered|split("\n")[]|select(length>0)|{sha:.,check_attempts:2}])
      end | reduce .[] as $row ([]; if any(.[]; .sha == $row.sha) then . else . + [$row] end))}')
  emit_matrix "$matrix"
  emit_output invalidation_failed "$(printf '%s\n' "$plan" | jq -r .invalidation_failed)"
  emit_output protocol_failed "$(printf '%s\n' "$plan" | jq -r .protocol_failed)"
}

evaluate_sha() {
echo "── evaluating $SHA"
active_sha="$SHA"

# #5479: the check-runs API can lag ~1 minute behind a job's completion,
# and workflow_run fires a bounded number of times per SHA — when the
# LAST event's single poll got a stale read, the posted "pending"
# status was never refreshed and the PR stayed stuck until a manual
# re-run (PRs #5476/#5475/#5481). When jobs still read as pending,
# re-poll once after a longer delay before concluding pending. The
# all-complete case breaks on the first pass. GraphQL has a separate
# installation budget from REST core and returns the current rollup in
# two pages (115 contexts measured on 2026-08-12). Publication reads
# the combined status once and writes only when the result changes.
max_attempts=${CHECK_ATTEMPTS:-2}
for attempt in 1 2; do
  runs=$(fetch_required_check_runs "$SHA")

  status=$(RUNS_JSON="$runs" REQUIRED_JOBS="$required" python3 -c "
import json
import os

runs = json.loads(os.environ['RUNS_JSON'])
required = json.loads(os.environ['REQUIRED_JOBS'])
latest = {}

for name in required:
  matches = [r for r in runs if r.get('name') == name]
  if matches:
    latest_run = sorted(
        matches,
        key=lambda r: (
            r.get('databaseId') or 0,
            r.get('completedAt') or r.get('startedAt') or '',
        ),
    )[-1]
    conclusion = latest_run.get('conclusion')
    latest[name] = conclusion.lower() if conclusion else 'pending'
  else:
    latest[name] = 'pending'

print(' '.join(f'{name}={latest[name]}' for name in required))
print('pending=' + ','.join(name for name in required if latest[name] == 'pending'))
print('failed=' + ','.join(name for name in required if latest[name] not in ('success', 'skipped')))
")

  echo "attempt $attempt: $status"
  pending=$(echo "$status" | awk -F= '/^pending=/ { print $2 }')
  failed=$(echo "$status" | awk -F= '/^failed=/ { print $2 }')

  if [ -z "$pending" ]; then
    break
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    break
  fi
  if [ "$attempt" -lt 2 ]; then
    sleep 60
  fi
done

if [ -n "$pending" ]; then
  post_gate_status "pending" "Waiting for required PR gates ($(name_count "$pending")): $pending"
  active_sha=""
  return 0
fi

if [ -n "$failed" ]; then
  post_gate_status "failure" "Required PR gates did not pass ($(name_count "$failed")): $failed"
  active_sha=""
  return 0
fi

post_gate_status "success" "All required PR gates passed"
active_sha=""
}

case "${1:-}" in
  discover) discover ;;
  invalidate) invalidate ;;
  recover) recover ;;
  evaluate)
    validate_sha
    [[ "${CHECK_ATTEMPTS:-2}" =~ ^[12]$ ]]
    evaluate_sha
    ;;
  *) echo "::error::Unknown Deploy Gate phase" >&2; exit 2 ;;
esac
