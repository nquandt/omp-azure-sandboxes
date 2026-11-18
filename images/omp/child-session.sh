#!/usr/bin/env bash
set -euo pipefail

mkdir -p "$HOME/.omp/agent" /workspace

if [[ -n "${SAND_REPOSITORY:-}" && ! -d /workspace/.git ]]; then
  git clone -- "$SAND_REPOSITORY" /workspace
fi

model_id="${SAND_MODEL#*/}"
cat >"$HOME/.omp/agent/models.yml" <<EOF
providers:
  sand-gateway:
    baseUrl: ${SAND_GATEWAY_URL}/v1
    apiKey: SAND_GATEWAY_TOKEN
    authHeader: true
    api: openai-completions
    models:
      - id: ${model_id}
EOF

omp models --json >/dev/null

started_at="$(date +%s)"
printf '{"state":"running","startedAt":%s}\n' "$started_at" >/state/status.json

set +e
timeout --signal=TERM --kill-after=30s "${SAND_MAX_TIME}s" \
  omp \
    --print \
    --wait-async \
    --model "sand-gateway/${model_id}" \
    --max-cost "$SAND_MAX_COST" \
    --max-time "$SAND_MAX_TIME" \
    --cwd /workspace \
    "$(cat /state/task.txt)" \
    >/state/result.tmp 2>&1
exit_code=$?
set -e

mv /state/result.tmp /state/result.txt
finished_at="$(date +%s)"
if [[ "$exit_code" -eq 0 ]]; then
  state=completed
else
  state=failed
fi
printf '{"state":"%s","exitCode":%s,"startedAt":%s,"finishedAt":%s}\n' \
  "$state" "$exit_code" "$started_at" "$finished_at" >/state/status.json
