#!/usr/bin/env bash
# WorldMonitor verification harness.
#
#   .agents/skills/verify-worldmonitor/scripts/wm-verify.sh launch [port]
#   .agents/skills/verify-worldmonitor/scripts/wm-verify.sh doctor
#   .agents/skills/verify-worldmonitor/scripts/wm-verify.sh drive <step.mjs> [--name label]
#   .agents/skills/verify-worldmonitor/scripts/wm-verify.sh cleanup
#
# Run from the repo root of the worktree you are verifying.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
[ -f "$REPO_ROOT/package.json" ] || REPO_ROOT="$PWD"
EVIDENCE_ROOT="$REPO_ROOT/.claude/verify-evidence"
INSTANCE_FILE="$EVIDENCE_ROOT/instance.json"
LOG_FILE="$EVIDENCE_ROOT/dev-server.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

pick_port() {
  local p
  for p in 4480 4481 4482 4483 4484 4485 4486 4487; do
    if port_free "$p"; then echo "$p"; return 0; fi
  done
  echo "[wm-verify] no free port in 4480-4487" >&2
  return 1
}

cmd_launch() {
  if [ -f "$INSTANCE_FILE" ]; then
    local old_pid
    old_pid="$(node -e "process.stdout.write(String(require('$INSTANCE_FILE').pid))" 2>/dev/null || echo '')"
    if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
      echo "[wm-verify] an instance is already running (pid $old_pid). Run 'doctor', or 'cleanup' first."
      cat "$INSTANCE_FILE"
      return 0
    fi
    rm -f "$INSTANCE_FILE"
  fi

  local port="${1:-}"
  if [ -z "$port" ]; then port="$(pick_port)"; fi
  if ! port_free "$port"; then
    echo "[wm-verify] port $port is already in use — another agent or the user owns it. Pick another." >&2
    return 1
  fi

  mkdir -p "$EVIDENCE_ROOT"
  local variant="${WM_VERIFY_VARIANT:-full}"
  echo "VITE_E2E=1 VITE_VARIANT=$variant port=$port" >"$EVIDENCE_ROOT/launch-env.txt"
  echo "[wm-verify] starting VITE_VARIANT=$variant dev server on 127.0.0.1:$port"
  (
    cd "$REPO_ROOT"
    VITE_E2E=1 VITE_VARIANT="$variant" npm run dev -- --host 127.0.0.1 --port "$port" \
      >"$LOG_FILE" 2>&1 &
    echo $! >"$EVIDENCE_ROOT/.pid"
  )
  local pid
  pid="$(cat "$EVIDENCE_ROOT/.pid")"
  rm -f "$EVIDENCE_ROOT/.pid"

  local waited=0
  # /tests/map-harness.html is the same readiness probe playwright.config.ts uses:
  # it forces Vite to transform a real module graph, so a 200 means "can serve the
  # app", not just "socket is open".
  until curl -sf -o /dev/null "http://127.0.0.1:$port/tests/map-harness.html"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "[wm-verify] dev server died during startup. Last log lines:" >&2
      tail -30 "$LOG_FILE" >&2
      return 1
    fi
    if [ "$waited" -ge 180 ]; then
      echo "[wm-verify] dev server did not become ready in 180s. Last log lines:" >&2
      tail -30 "$LOG_FILE" >&2
      kill "$pid" 2>/dev/null || true
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

  node -e "
    require('fs').writeFileSync(process.argv[1], JSON.stringify({
      pid: Number(process.argv[2]),
      port: Number(process.argv[3]),
      baseUrl: 'http://127.0.0.1:' + process.argv[3],
      variant: process.argv[4],
      startedAt: new Date().toISOString(),
      log: process.argv[5],
    }, null, 2) + '\n');
  " "$INSTANCE_FILE" "$pid" "$port" "$variant" "$LOG_FILE"

  echo "[wm-verify] ready in ${waited}s — http://127.0.0.1:$port/dashboard (pid $pid)"
  cat "$INSTANCE_FILE"
}

cmd_doctor() {
  if [ ! -f "$INSTANCE_FILE" ]; then
    echo "doctor: FAIL — no instance recorded. Run 'launch'."
    return 1
  fi
  local pid port base
  pid="$(node -e "process.stdout.write(String(require('$INSTANCE_FILE').pid))")"
  port="$(node -e "process.stdout.write(String(require('$INSTANCE_FILE').port))")"
  base="$(node -e "process.stdout.write(require('$INSTANCE_FILE').baseUrl)")"

  local ok=0
  if kill -0 "$pid" 2>/dev/null; then echo "doctor: process $pid alive"; else echo "doctor: FAIL — pid $pid is gone"; ok=1; fi

  # The port must be held by OUR pid (or one of its children). A port answering
  # for someone else's server is the failure this check exists to catch.
  local owners
  owners="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ')"
  if [ -z "$owners" ]; then
    echo "doctor: FAIL — nothing listening on $port"; ok=1
  else
    local owned=1
    local o
    for o in $owners; do
      local walk="$o"
      local hops=0
      while [ -n "$walk" ] && [ "$walk" != "1" ] && [ "$hops" -lt 8 ]; do
        if [ "$walk" = "$pid" ]; then owned=0; break; fi
        walk="$(ps -o ppid= -p "$walk" 2>/dev/null | tr -d ' ')"
        hops=$((hops + 1))
      done
      [ "$owned" -eq 0 ] && break
    done
    if [ "$owned" -eq 0 ]; then
      echo "doctor: port $port owned by our process tree ($owners)"
    else
      echo "doctor: FAIL — port $port is held by $owners, not by our pid $pid"; ok=1
    fi
  fi

  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$base/dashboard" || echo 000)"
  if [ "$code" = "200" ]; then echo "doctor: $base/dashboard -> 200"; else echo "doctor: FAIL — $base/dashboard -> $code"; ok=1; fi

  if curl -sf "$base/dashboard" | grep -q "skeleton-shell"; then
    echo "doctor: dashboard shell markup served"
  else
    echo "doctor: FAIL — dashboard HTML is not the app shell"; ok=1
  fi

  # Every drive waits on the data-wm-* readiness markers, and only VITE_E2E=1
  # emits them. A server launched without it looks healthy and then times out
  # in every drive, so prove the flag reached this process.
  if ps -o command= -p "$pid" 2>/dev/null | grep -q 'vite\|npm'; then
    echo "doctor: launcher process still running vite"
  else
    echo "doctor: FAIL — pid $pid is not a vite/npm process"; ok=1
  fi
  if grep -q 'VITE_E2E' "$EVIDENCE_ROOT/launch-env.txt" 2>/dev/null; then
    echo "doctor: launched with VITE_E2E=1 (readiness markers available)"
  else
    echo "doctor: FAIL — no VITE_E2E=1 record; relaunch via 'wm-verify.sh launch'"; ok=1
  fi

  # grep exits 1 on zero matches and `set -o pipefail` would abort doctor here,
  # reporting "not worth driving" for a perfectly clean log.
  local errs=0
  if [ -f "$LOG_FILE" ]; then
    errs="$( { grep -ciE 'error|ERR_' "$LOG_FILE" || true; } 2>/dev/null | tr -d '[:space:]')"
  fi
  echo "doctor: dev-server log lines matching error: ${errs:-0} ($LOG_FILE)"

  if [ "$ok" -eq 0 ]; then echo "doctor: OK"; else echo "doctor: NOT worth driving"; fi
  return "$ok"
}

cmd_drive() {
  [ $# -ge 1 ] || { echo "usage: wm-verify.sh drive <step.mjs> [--name label]" >&2; return 2; }
  (cd "$REPO_ROOT" && node "$SCRIPT_DIR/drive.mjs" "$@")
}

cmd_cleanup() {
  if [ ! -f "$INSTANCE_FILE" ]; then
    echo "[wm-verify] nothing to clean up (no instance.json). Evidence under $EVIDENCE_ROOT is untouched."
    return 0
  fi
  local pid
  pid="$(node -e "process.stdout.write(String(require('$INSTANCE_FILE').pid))" 2>/dev/null || echo '')"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    # Kill the pid WE recorded and its children. Never pkill by name — other
    # worktrees and the user's own dev server are also `vite` processes.
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    local waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 10 ]; do sleep 1; waited=$((waited + 1)); done
    kill -KILL "$pid" 2>/dev/null || true
    echo "[wm-verify] stopped pid $pid"
  else
    echo "[wm-verify] recorded pid $pid was already gone"
  fi
  rm -f "$INSTANCE_FILE" "$EVIDENCE_ROOT/launch-env.txt"
  echo "[wm-verify] evidence kept in $EVIDENCE_ROOT (run directories are never deleted by cleanup)"
}

case "${1:-}" in
  launch) shift; cmd_launch "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  drive) shift; cmd_drive "$@" ;;
  cleanup) shift; cmd_cleanup "$@" ;;
  *)
    echo "usage: wm-verify.sh {launch [port]|doctor|drive <step.mjs> [--name label]|cleanup}" >&2
    exit 2
    ;;
esac
