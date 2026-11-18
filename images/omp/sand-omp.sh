#!/usr/bin/env bash
set -euo pipefail

# Attach to the sandbox's OMP process, starting it if it is not running.
# dtach only keeps the process alive across disconnects. It does not emulate a
# terminal, so the client terminal's keys, scrollback, and timing are unchanged.
# Detach without stopping OMP with Ctrl-\.
export TERM="${TERM:-xterm-256color}"
exec dtach -A /state/omp.sock -r winch -z /usr/local/bin/sand-omp-session "$@"
