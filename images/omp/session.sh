#!/usr/bin/env bash
set -euo pipefail

export TERM="${TERM:-xterm-256color}"

if [[ -f /state/sand.env ]]; then
  # shellcheck disable=SC1091
  source /state/sand.env
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
