#!/usr/bin/env bash
set -euo pipefail

export TERM="${TERM:-xterm-256color}"

# Root sessions use the broker as the credential source of truth. Do not start
# from the on-disk snapshot: a session restarted after login or token rotation
# must fetch the broker's current credential generation before its first model
# request. OAuth access-token refresh remains the broker's responsibility.
export OMP_AUTH_BROKER_SNAPSHOT_TTL_MS=0

if [[ -f /state/sand.env ]]; then
  # shellcheck disable=SC1091
  source /state/sand.env
fi

# Azure Container Apps may scale the broker to zero. Wait for its cold start
# before OMP performs its shorter startup credential check.
if [[ -n "${OMP_AUTH_BROKER_URL:-}" ]]; then
  broker_ready=false
  for _ in {1..15}; do
    if omp auth-broker status >/dev/null 2>&1; then
      broker_ready=true
      break
    fi
    sleep 2
  done
  if [[ "$broker_ready" != true ]]; then
    printf 'auth broker did not become ready after scaling from zero: %s\n' "$OMP_AUTH_BROKER_URL" >&2
    exit 1
  fi
fi

mkdir -p "$HOME/.omp" /workspace
cd /workspace

if [[ -n "${SAND_REPOSITORY:-}" && ! -d /workspace/.git ]]; then
  git clone -- "${SAND_REPOSITORY}" /workspace
fi

# The model file is written by the sand CLI on every connection, so it holds the
# currently configured default. SAND_MODEL is the value from sandbox creation.
model="${SAND_MODEL:-}"
if [[ -s "$HOME/.sand/model" ]]; then
  model="$(<"$HOME/.sand/model")"
fi

omp_args=(omp)
if compgen -G "$HOME/.omp/agent/sessions/*" >/dev/null; then
  omp_args+=(--continue)
fi
if [[ -n "$model" ]]; then
  omp_args+=(--model "$model")
fi
if [[ -n "${SAND_DISPATCHER_URL:-}" ]]; then
  omp_args+=(--extension /opt/sand/sand-extension.ts)
fi

exec "${omp_args[@]}" "$@"
