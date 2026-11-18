#!/usr/bin/env bash
set -euo pipefail

state=/state/ssh
mkdir -p "$state" /run/sshd /state/home/.ssh
chmod 0700 "$state" /state/home/.ssh

if [[ ! -f "$state/ssh_host_ed25519_key" ]]; then
  ssh-keygen -q -t ed25519 -N '' -f "$state/ssh_host_ed25519_key"
fi
if [[ ! -f "$state/iroh-secret" ]]; then
  umask 077
  openssl rand -hex 32 >"$state/iroh-secret"
fi

chmod 0600 "$state/ssh_host_ed25519_key" "$state/iroh-secret"
chmod 0644 "$state/ssh_host_ed25519_key.pub"
touch /state/home/.ssh/authorized_keys
chmod 0600 /state/home/.ssh/authorized_keys

sed -i 's|^\(root:[^:]*:0:0:[^:]*\):/root:|\1:/state/home:|' /etc/passwd
cp -n /root/.bashrc /root/.profile /state/home/ 2>/dev/null || true
(
  umask 077
  while IFS='=' read -r key value; do
    printf 'export %s=%q\n' "$key" "$value"
  done < <(env | grep -E '^(SAND_|OMP_AUTH_BROKER_URL=)') >/state/sand.env
)

/usr/sbin/sshd -f /etc/ssh/sshd_config_sand

export IROH_SECRET
IROH_SECRET="$(cat "$state/iroh-secret")"
rm -f "$state/dumbpipe.ticket"
dumbpipe listen-tcp --host 127.0.0.1:2222 >"$state/listen.log" 2>&1 &
listener=$!
trap 'kill "$listener" 2>/dev/null || true; exit 0' TERM INT
for _ in $(seq 1 120); do
  ticket="$(grep -oE 'endpoint[a-z2-7]{40,}' "$state/listen.log" | tail -n 1 || true)"
  if [[ -n "$ticket" ]]; then
    umask 077
    printf '%s\n' "$ticket" >"$state/dumbpipe.ticket.tmp"
    mv "$state/dumbpipe.ticket.tmp" "$state/dumbpipe.ticket"
    break
  fi
  sleep 0.5
done
wait "$listener"
