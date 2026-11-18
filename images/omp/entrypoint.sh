#!/usr/bin/env bash
set -euo pipefail

umask 077
mkdir -p "$HOME/.omp"

write_secret_file() {
  local path="$1"
  local value="$2"
  local temporary="${path}.tmp"
  printf '%s' "$value" >"$temporary"
  chmod 0600 "$temporary"
  mv "$temporary" "$path"
}

case "${SAND_ROLE:-worker}" in
  broker)
    : "${SAND_BROKER_TOKEN:?SAND_BROKER_TOKEN is required}"
    durable_dir="$HOME/.omp"
    export HOME=/run/sand-home
    live_db="$HOME/.omp/agent/agent.db"
    durable_db="$durable_dir/agent/agent.db"
    mkdir -p "$(dirname "$live_db")" "$(dirname "$durable_db")"
    if [[ -f "$durable_db" ]]; then
      cp "$durable_db" "$live_db"
    elif [[ -f "$durable_dir/agent.db" ]]; then
      cp "$durable_dir/agent.db" "$live_db"
    fi
    write_secret_file "$HOME/.omp/auth-broker.token" "$SAND_BROKER_TOKEN"
    backup_broker() {
      if [[ ! -f "$live_db" ]]; then
        return
      fi
      sqlite3 "$live_db" ".backup '/tmp/agent.db.backup'"
      cp /tmp/agent.db.backup "$durable_db.next"
      mv "$durable_db.next" "$durable_db"
    }
    omp auth-broker serve \
      --bind=0.0.0.0:8765 \
      --trust-proxy-headers &
    broker_pid=$!
    trap 'kill "$broker_pid" 2>/dev/null || true; wait "$broker_pid" || true; backup_broker; exit 0' TERM INT
    while kill -0 "$broker_pid" 2>/dev/null; do
      sleep 10
      backup_broker
    done &
    backup_pid=$!
    set +e
    wait "$broker_pid"
    status=$?
    set -e
    kill "$backup_pid" 2>/dev/null || true
    backup_broker
    exit "$status"
    ;;
  gateway)
    : "${SAND_BROKER_URL:?SAND_BROKER_URL is required}"
    : "${SAND_BROKER_TOKEN:?SAND_BROKER_TOKEN is required}"
    : "${SAND_GATEWAY_TOKEN:?SAND_GATEWAY_TOKEN is required}"
    export OMP_AUTH_BROKER_URL="$SAND_BROKER_URL"
    export OMP_AUTH_BROKER_TOKEN="$SAND_BROKER_TOKEN"
    write_secret_file "$HOME/.omp/auth-gateway.token" "$SAND_GATEWAY_TOKEN"
    gateway_args=(
      auth-gateway serve
      --bind=0.0.0.0:4000
      --trust-proxy-headers
    )
    if [[ -n "${SAND_GATEWAY_CLIENTS_FILE:-}" ]]; then
      gateway_args+=("--clients=$SAND_GATEWAY_CLIENTS_FILE")
    fi
    exec omp "${gateway_args[@]}"
    ;;
  dispatcher)
    exec python3 /opt/sand/dispatcher.py
    ;;
  worker)
    if (($# > 0)); then
      exec "$@"
    fi
    exec /usr/local/bin/sand-ssh-service
    ;;
  *)
    printf 'unknown SAND_ROLE: %s\n' "$SAND_ROLE" >&2
    exit 64
    ;;
esac
