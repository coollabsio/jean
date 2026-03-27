#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_BUILD_STARTED_AT="$(date +%s)"
WEB_WATCHER_PID=""
VITE_PID=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "${VITE_PID}" ]] && kill -0 "${VITE_PID}" 2>/dev/null; then
    kill "${VITE_PID}" 2>/dev/null || true
    wait "${VITE_PID}" 2>/dev/null || true
  fi

  if [[ -n "${WEB_WATCHER_PID}" ]] && kill -0 "${WEB_WATCHER_PID}" 2>/dev/null; then
    kill "${WEB_WATCHER_PID}" 2>/dev/null || true
    wait "${WEB_WATCHER_PID}" 2>/dev/null || true
  fi

  exit "${exit_code}"
}

wait_for_web_dist() {
  local deadline=$((SECONDS + 60))
  local dist_index="${ROOT_DIR}/dist/index.html"

  while (( SECONDS < deadline )); do
    if [[ -f "${dist_index}" ]]; then
      local dist_mtime=0
      dist_mtime=$(stat -c %Y "${dist_index}" 2>/dev/null || stat -f %m "${dist_index}" 2>/dev/null || echo 0)
      if (( dist_mtime >= DIST_BUILD_STARTED_AT )); then
        return 0
      fi
    fi

    if ! kill -0 "${WEB_WATCHER_PID}" 2>/dev/null; then
      echo "Web access dist watcher exited before the initial build completed." >&2
      return 1
    fi

    sleep 1
  done

  echo "Timed out waiting for dist/index.html to rebuild; continuing with the existing dist output." >&2
}

trap cleanup EXIT INT TERM

cd "${ROOT_DIR}"

echo "Starting web access dist watcher..."
bun run dev:web &
WEB_WATCHER_PID=$!

wait_for_web_dist

echo "Starting Vite dev server for Tauri..."
bun run dev &
VITE_PID=$!

wait "${VITE_PID}"
