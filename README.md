# sand

`sand` runs coding-agent sessions in Azure Container Apps Sandboxes. The local
CLI is a control and terminal client; repositories, agent processes, tools, and
credentials can remain entirely in Azure.

The deployed system includes durable root OMP sessions and an authenticated
dispatcher that creates isolated depth-1 OMP subagents.

The first agent runtime target is OMP with its complete multi-provider model
catalog and `/model` picker. See [multi-provider authentication](docs/authentication.md)
for the broker/gateway trust model.

## Why Bun and TypeScript

- OMP plugins use the same language and runtime.
- Azure control-plane contracts can be shared by the CLI, dispatcher, and plugin.
- Bun can publish the CLI as a package or compile it into standalone executables.
- The planned Iroh PTY transport can remain a small Rust component behind a
  transport interface.

## Prerequisites

- Bun 1.3 or newer.
- Azure CLI.
- Azure Container Apps `aca` CLI.
- An Azure subscription using Microsoft Entra ID.
- An existing resource group and Container Apps sandbox group.
- `Container Apps SandboxGroup Data Owner` on the sandbox group.

Create the resource group and sandbox group through `sand`:

```bash
SUBSCRIPTION_ID="$(az account show --query id -o tsv)"

bun run src/main.ts infra create \
  --subscription "$SUBSCRIPTION_ID" \
  --resource-group my-sand-rg \
  --sandbox-group my-sand-group \
  --region westus2
```

The group creator normally receives the required data-owner role. Additional
users and service identities need an explicit assignment scoped to the sandbox
group.

## Install and configure

```bash
bun install

bun run src/main.ts init \
  --subscription "$SUBSCRIPTION_ID" \
  --resource-group my-sand-rg \
  --sandbox-group my-sand-group \
  --region westus2

bun run src/main.ts doctor
```

Configuration defaults to `~/.config/sand/config.json`. Override it with
`SAND_CONFIG` or `--config PATH`. It contains resource coordinates and defaults,
not credentials. Authentication remains with Azure CLI/Entra.

## Current commands

```bash
sand config show
sand doctor
sand infra create --subscription ID --resource-group NAME --sandbox-group NAME --region REGION
sand infra auth
sand auth status
sand auth login anthropic
sand auth import --from-local
sand auth import --from-local --apply
sand models
sand models gpt-5
sand infra worker
sand omp
sand omp --model anthropic/claude-sonnet-4-6
sand omp --repo https://github.com/OWNER/REPOSITORY.git
sand omp --model cursor/gpt-5.6-sol:medium --prompt "Delegate one check with sand_spawn"
sand session list
sand session attach <sandbox-id>
sand session ssh <sandbox-id>
sand session exec <sandbox-id> -- git status
sand session code <sandbox-id>
sand session stop <sandbox-id>
sand agent spawn --task "Review the parser" --model cursor/gpt-5.6-sol
sand agent status <job-id>
sand agent wait <job-id>
sand agent result <job-id>
sand agent cancel <job-id>

sand sandbox create \
  --disk ubuntu \
  --cpu 2500m \
  --memory 4096Mi \
  --label owner=me

sand sandbox shell <sandbox-id>
sand sandbox shell <sandbox-id> --command 'HOME=/state/home omp -p --model cursor/gpt-5.6-sol:medium "Reply with exactly SAND_OK"'
```

`sand infra worker` keeps the current worker disk image and removes older Sand
worker images that no sandbox references. Images backing running or suspended
sandboxes are retained so those sandboxes remain resumable.

Worker sandboxes expose a loopback-only OpenSSH server through an encrypted
Iroh connection using dumbpipe. `sand session ssh` and `sand session exec`
create and inject a Sand-owned Ed25519 key, pin the SSH host key through the
authenticated ACA control plane, wake stopped sandboxes, and keep them active
while the Iroh connection is open. `sand session code` opens `/workspace`
through VS Code Remote-SSH using generated SSH configuration. No public port,
password, VPN, or separate account login is required.

Every `aca` invocation receives the configured subscription, resource group,
region, and sandbox group explicitly. `sand` does not depend on or mutate a
machine-wide ACA default, allowing different config files to target independent
Azure installations.

Without `--command`, `sandbox shell` opens an interactive shell. With
`--command`, it executes the complete command through the ACA exec API.

Interactive `sand omp` sessions open the real OMP TUI running in the sandbox
over the Iroh SSH connection, so `/model`, `/resume`, `/compact`, shell
commands, Python, and skills all work. The process is kept alive across
disconnects by `dtach`, which passes bytes through without emulating a
terminal, so your terminal's own keys and scrollback apply.
Detach with Ctrl-\ without stopping OMP. Reconnect with
`sand session attach <sandbox-id>`, or run `sand-omp` inside any shell on the
sandbox, including the VS Code terminal. If suspension stopped the process,
OMP restarts and continues the previous conversation.

`sand auth import --from-local` is a dry run. Add `--apply` only after reviewing
the providers it reports. OAuth credentials are uploaded to the private broker;
API keys from environment variables are excluded unless `--include-env` is
explicitly supplied.

The broker and gateway use Container Apps consumption scaling with zero minimum
replicas. The dispatcher keeps one minimum replica running to own job expiry
and credential revocation. Agent sandboxes use disk-mode auto-suspend
after five idle minutes.
Persistent disks, Azure Files, ACR images, and Log Analytics retain storage and
may still incur storage or ingestion charges while compute is at zero.

## Portable deployment model

The distributable system will have replaceable infrastructure coordinates:

```text
sand CLI / OMP plugin
        |
        v
dispatcher API
        |
        +-- sandbox group
        +-- workspace and session Blob containers
        +-- per-session Data Disks
        +-- container registry / agent disk image
        +-- identity and egress policy
```

Users will deploy these resources into their own subscription and provide the
resulting resource IDs to `sand`. No central Sand tenant, shared Azure
subscription, or publisher-owned model credentials are required.

Distribution targets:

- Standalone macOS, Linux, and Windows CLI binaries in GitHub Releases.
- An npm package for Bun users.
- A versioned Bicep module that creates the dispatcher and required Azure
  resources.
- A separately versioned OMP plugin using the same dispatcher contract.
- A custom worker image whose digest is configurable and pinned by deployments.

## Development

Install dependencies, type-check the source, and build the standalone CLI:

```bash
bun install
bun run typecheck
bun run build
```

The compiled executable is written to `dist/sand`.

## License

Sand is available under the [MIT License](LICENSE).

## Remaining distribution work

1. Add Blob workspace package transfer for dirty local worktrees.
2. Publish standalone binaries, the container image, and deployment templates.
3. Replace the preview ACA CLI dependency when the stable SDK is available.
