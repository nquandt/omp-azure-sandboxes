# Changelog

## 0.1.0

- Add Bun/TypeScript CLI scaffold.
- Add isolated per-installation Azure resource configuration.
- Add Azure and ACA prerequisite diagnostics.
- Add idempotent resource-group and sandbox-group provisioning.
- Add generic sandbox creation and interactive shell commands.
- Document the portable, user-owned Azure deployment model.
- Define OMP multi-provider model selection and broker/gateway credential boundaries.
- Add pinned OMP worker, auth broker, and auth gateway image.
- Add Azure credential-plane deployment and local OAuth migration commands.
- Add OMP worker disk registration and `sand omp` remote TUI launch.
- Execute `sandbox shell --command` through ACA exec so full commands are not
  misinterpreted as executable paths.
- Add the managed-identity dispatcher, persistent job registry, and scoped
  gateway client credentials.
- Add depth-1 OMP `sand_spawn`, status, wait, result, and cancel tools.
- Add equivalent laptop `sand agent` commands.
- Pin worker disk registration to the resolved ACR manifest digest.
- Treat a child sandbox without a status file as starting during polling.
- Give remote OMP TUI sessions a terminal type when ACA does not provide one.
- Run interactive cloud sessions as the real remote OMP TUI over the Iroh SSH
  transport, kept alive across disconnects by dtach, with session listing,
  reattachment, and stopping commands.
- Reject stale worker images before allocating cloud resources.
- Garbage-collect unreferenced obsolete worker disk images after registration
  while retaining the current image and images used by existing sandboxes.
- Add key-only OpenSSH over pinned dumbpipe/Iroh transport for remote shell,
  command execution, file transfer, port forwarding, and VS Code Remote-SSH.
- Wake stopped sandboxes before Iroh connections and keep them active with
  control-plane heartbeats while a proxy connection remains open.
- Disable egress TLS inspection for Sand sessions so Iroh relay and discovery
  connections validate their native certificates through the ACA egress proxy.
- Start remote OMP quietly: no splash, setup wizard, changelog panel, or
  update check, and disable in-sandbox auto-update of the pinned OMP.
- List the top-level `sand code` and `sand ssh` development-box commands in the
  public command reference.
- Transfer local Git worktrees through private, short-lived Blob packages for
  OMP, VS Code, and SSH sessions.
- Delete root session volumes with their sandboxes and collect child results
  before deleting ephemeral child sandboxes and volumes.
- Retain completed child result records for seven days and then prune them.
