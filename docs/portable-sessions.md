# Portable sessions and projects

Status: design direction; commands and formats described below are not yet implemented.

## Goal

Sand should make an isolated development session durable and movable without making
its current compute provider part of its identity. A developer can begin in a local
Docker container, move the session to an Azure Container Apps sandbox before leaving
their laptop, and later resume it from another machine or restore it locally.

The unit of portability is a **Sand session**: project workspaces, OMP conversation
state, selected non-secret configuration, and lineage metadata. Sand moves this
durable state and starts a new runtime around it. It does not checkpoint a Linux
process.

## Current baseline

The Azure implementation already provides part of this model:

- Each root OMP sandbox has a persistent Data Disk mounted at `/state`.
- OMP uses `/state/home`, and its JSONL sessions survive sandbox suspension.
- `dtach` keeps OMP attached to a stable PTY while the sandbox remains active.
- `sand session attach` resumes a disconnected session; OMP starts with
  `--continue` if its process must be recreated.
- `sand omp --workspace PATH` transfers one Git repository's `HEAD`, local tracked
  changes, and untracked non-ignored files into a new cloud session.
- Root sessions can dispatch depth-1 cloud children. A child currently clones one
  optional public repository, returns text, and is deleted after collection.

This is durable cloud execution, not yet portable session management. In particular,
there is no Docker backend, backend-independent catalog, destination import, local
restore, multi-repository project, or child change artifact.

## Principles

1. **Identity is independent of placement.** A stable Sand session ID survives moves
   between Docker and Azure resources.
2. **One authoritative writable placement.** Moving a session transfers ownership;
   it does not create two live copies that silently diverge.
3. **Restore never overwrites by default.** A managed Docker volume or a new host
   directory is the safe destination.
4. **Snapshot before mutation.** Any future in-place host restore first captures the
   destination and can roll back after a failed apply.
5. **Git represents code lineage; Sand represents runtime lineage.** Branches and
   commits are the exchange format for agent changes. Sand snapshots also preserve
   valid uncommitted work.
6. **Secrets are destination capabilities, not session files.** Provider, dispatcher,
   Azure, SSH, and registry credentials are injected again at the destination.
7. **Dedicated compute replaces worktree isolation, not Git integration.** A cloud
   child uses a normal clone and branch inside its own sandbox and returns commits or
   a Git bundle to its parent.
8. **The host control plane remains outside the agent trust boundary.** A sandbox
   receives only the operations and scoped credentials it needs.

## Session model

A local catalog should map a stable identity to its current placement and latest
snapshot:

```text
SandSession
  id
  name
  projectId
  placement: docker | azure
  placementResourceId
  state: creating | running | quiescing | stopped | moving | failed
  generation
  parentSessionId?
  ompSessionId?
  workerImage
  ompVersion
  createdAt
  lastActiveAt
```

`lastActiveAt`, not resource creation time, determines the default session to attach.
The catalog must preserve historical placement records so an interrupted move can
identify its authoritative source. The first implementation can use a local SQLite
database. A later team service may replicate catalog metadata, but session bundles
remain the source of truth for recovery.

Expected command direction:

```bash
sand new [--project NAME] [--backend docker|cloud]
sand list
sand attach SESSION
sand stop SESSION
sand delete SESSION
sand export SESSION --output PATH
sand import PATH --backend docker|cloud
sand move SESSION --to docker|cloud
sand restore SESSION [--into NEW_DIRECTORY]
```

`stop` preserves state. `delete` removes state. These must not be aliases.

## Managed local Docker sessions

The normal local mode should use managed Docker volumes for `/state` and the project
workspace. It should not bind-mount the developer's existing checkout by default.
This provides isolation and makes a local session structurally similar to a cloud
session.

A Docker root receives:

- A read-only, pinned worker image.
- Writable managed volumes for `/state` and `/workspace`.
- A filtered environment rather than the invoking terminal's environment.
- No host home mount, Docker socket, SSH agent, or cloud credentials by default.
- Dropped Linux capabilities and `no-new-privileges`.
- Explicit network and credential profiles.

A host-connected bind mount can be an opt-in fast mode, but Sand must label it as a
weaker isolation mode and cannot promise safe movement while host files can change
outside the session.

The current worker image pins x86-64 OMP, ACA, and dumbpipe binaries. Local Docker on
ARM64 requires a multi-architecture worker image or a local-worker image that omits
Azure-only binaries.

### Sand inside the sandbox

The full administrative CLI must not receive the host's Docker socket, Azure CLI
session, or storage-account credentials. The image can expose a restricted Sand
client using the same command vocabulary but only the capabilities granted to the
current root session:

- Inspect the current session and project.
- Request a cloud child through the authenticated dispatcher.
- Read, wait for, collect, or cancel that session's child jobs.
- Request a move or snapshot through an external controller.

Moves and privileged infrastructure operations are performed by the host or service
controller. A request from inside the container is a control-plane request, not
nested Docker management. Cloud children continue to receive no dispatcher or broker
administrative capability and cannot create grandchildren.

## Snapshot and restore

### Portable bundle

A versioned bundle should contain:

```text
manifest.json
project/
  project definition and lock data
repositories/
  <repo-id>/repository.bundle
  <repo-id>/worktree.tar
  <repo-id>/metadata.json
state/
  omp sessions and blobs
  session artifacts and todos
checksums.json
```

The manifest records format version, Sand session ID, generation, source placement,
project ID, repository paths, base commits, branch names, OMP and worker versions,
and content hashes.

Exclude or regenerate:

- Provider, broker, gateway, dispatcher, Azure, SSH, and registry credentials.
- `dtach` and SSH sockets, PIDs, locks, terminal breadcrumbs, and host-specific paths.
- Rebuildable caches unless required for a documented offline workflow.

A bundle is sensitive even after credential removal because transcripts, tool output,
and uncommitted files can contain secrets. Cloud transfer should use client-side
encryption in addition to private, short-lived transport URLs.

### Safe restore targets

Restore supports three distinct operations:

1. **Resume into a managed Docker volume** — preferred local workflow. The existing
   host checkout is untouched.
2. **Materialize into a new host directory** — useful for inspection or leaving Sand.
   The target must be absent or empty.
3. **Apply into an existing host project** — deferred until conflict semantics are
   implemented. It must never be the default.

For a future in-place apply, Sand must:

1. Acquire a project lock and detect running Sand sessions.
2. Snapshot every destination repository, including untracked non-ignored files and
   deletions, before writing.
3. Compare source base, destination base, and destination worktree as a three-way
   operation per repository.
4. Stop on conflicts without discarding either side.
5. Retain the pre-restore snapshot until explicit cleanup.
6. Report exactly which repositories and paths changed.

A plain recursive copy is not acceptable. It can silently overwrite local work and
cannot represent deletions safely.

### Move protocol

A move is a transactional handoff:

1. Lock the Sand session and reject new attachments.
2. Ask OMP to finish the active turn or abort it after an explicit timeout.
3. Stop foreground execution and flush session files.
4. Produce and checksum generation `N + 1` of the portable bundle.
5. Import into a new destination placement.
6. Reinject destination credentials and rewrite destination-specific paths.
7. Start OMP against the transferred session and verify session ID, project lock, and
   repository hashes.
8. Atomically mark the destination authoritative in the catalog.
9. Keep the stopped source as a rollback copy until retention expires or the user
   removes it.

A failed import leaves the source authoritative. Background processes, open network
connections, PTYs, language servers, debuggers, and Python kernels are reconstructed,
not migrated. Completed transcript entries and filesystem writes survive; an active
model turn is finished or recorded as interrupted.

## Projects and multiple repositories

A Sand project is a declarative description of the workspace required for a product,
not necessarily a Git repository itself. A project can be stored in a product-owned
repository, a small catalog repository, or the developer's personal Sand config.

Suggested committed format:

```json
{
  "schemaVersion": 1,
  "name": "checkout",
  "repositories": [
    {
      "id": "api",
      "url": "ssh://git.example.com/checkout-api.git",
      "path": "api",
      "ref": "main"
    },
    {
      "id": "web",
      "url": "ssh://git.example.com/checkout-web.git",
      "path": "web",
      "ref": "main"
    }
  ],
  "workspaceRoot": ".",
  "setup": {
    "command": "./dev/bootstrap",
    "requiresApproval": true
  }
}
```

The filename can be `sand.project.json`. Repository IDs and relative paths are stable
bundle keys. A generated lock records resolved commits and image/toolchain versions.
Personal overrides belong in an ignored `.sand/project.local.json` and must not change
shared repository identity.

A project definition should remain deliberately small:

- Repository URL, path, and initial ref.
- Workspace root and optional additional OMP directories.
- Pinned worker/toolchain profile.
- An explicit, reviewable setup command.
- Named services and ports only when runtime orchestration needs them.

It should not become a second build system or encode arbitrary machine provisioning.
Existing repository scripts remain responsible for bootstrap and development services.
Sand provides isolation, checkout, state capture, placement, and lifecycle.

A first-day flow can become:

```bash
sand auth login
sand project add ssh://git.example.com/platform/dev-projects.git#checkout
sand new --project checkout
```

Sand resolves the project, clones all repositories into a managed workspace, shows the
setup command before first execution, injects scoped model access, and opens OMP at the
project root. The same project lock is used when moving to cloud or restoring locally.

## Cloud children and integration

### Current limitation

The current dispatcher accepts a task, model, and optional public repository URL. The
child returns only its final text; its sandbox and volume are then deleted. It cannot
consume the root's uncommitted multi-repository state or return code changes. Therefore
Sand should not disable OMP's native subagents yet.

### Target child input

A code-changing cloud child should receive:

- Parent session ID and immutable snapshot generation.
- The complete project lock.
- Only the repositories and paths required by its assignment, when safely reducible.
- A base commit and parent worktree snapshot for each assigned repository.
- A unique branch namespace such as `sand/<parent-session>/<job>/<repo>`.
- Scoped model, time, spend, network, and repository capabilities.

The child uses ordinary clones and branches inside dedicated compute. It does not need
a host-side Git worktree because no sibling shares its filesystem.

### Target child output

A code-changing child returns a structured result:

```text
ChildResult
  jobId
  parentGeneration
  status
  summary
  repositoryResults[]
    repositoryId
    baseCommit
    headCommit
    gitBundle or object-pack reference
    changedPaths
    validation
```

Commits do not need to be pushed to the canonical remote. The dispatcher can retain an
encrypted Git bundle or content-addressed object pack long enough for the parent to
import it under a local ref. Pushing is an explicit publish policy for CI or
cross-machine collaboration, not a requirement for parent-child integration.

Read-only children return findings without a repository artifact. A child that changes
uncommitted parent content must base its branch on the transferred snapshot, not merely
clone the remote branch.

### Map-reduce integration

The parent acts as integrator:

1. **Map:** create self-contained assignments against one immutable parent generation.
2. **Execute:** children work in separate sandboxes and branch namespaces.
3. **Collect:** import each result under a namespaced local ref.
4. **Reduce:** inspect validation and changed paths, then merge or cherry-pick results
   in a deterministic order.
5. **Resolve:** the parent handles conflicts with full project context.
6. **Advance:** successful integration creates a new parent snapshot generation.

For a multi-repository task, one child result can contain one branch per affected
repository tied together by the same job ID. Sand never pretends that commits in two
repositories form one atomic Git commit; the project-level result manifest records the
coordination.

Branches provide lineage and reviewability. Dedicated compute provides isolation.
These solve different problems, and neither requires host-side worktrees.

### Native versus cloud subagents

Sand should initially expose a project policy:

```text
subagents: native | cloud | hybrid
```

- `native`: unchanged OMP behavior.
- `cloud`: route eligible tasks through the Sand dispatcher.
- `hybrid`: allow the root to choose based on isolation, duration, and artifact needs.

`hybrid` is the safe initial default. A team can choose `cloud` only after cloud
children can consume parent snapshots and return structured code artifacts. Removing
native subagent tools before that cutover would regress code-changing delegation.

## Delivery progression

### Phase 1: local isolation and identity

- Introduce the backend-independent session catalog and stable session IDs.
- Add a multi-architecture Docker root image and managed-volume lifecycle.
- Split `stop` from destructive `delete`.
- Add friendly names, project metadata, and `lastActiveAt` session listing.

### Phase 2: projects and explicit snapshots

- Add `sand.project.json`, project locks, and multi-repository workspace creation.
- Generalize the existing one-repository packager into a versioned project bundle.
- Add offline `sand export` and `sand import` between stopped placements.
- Restore only into managed volumes or new directories.

### Phase 3: transactional movement

- Add quiesce, encrypted transfer, destination verification, rollback retention, and
  `sand move`.
- Allow a restricted in-session client to request moves through an external controller.
- Make the catalog show authoritative and retained rollback placements.

### Phase 4: branch-producing cloud children

- Pass parent snapshot generations and project locks to children.
- Return structured per-repository Git artifacts and validation metadata.
- Import child refs and support deterministic parent integration.
- Permit project policy to prefer or require cloud subagents.

### Phase 5: guarded host synchronization

- Add pre-image snapshots and three-way apply into an existing host project.
- Surface conflicts per repository and retain rollback state.
- Add explicit publish/push policies for teams that require remote branches or CI.

## Deferred concerns

- Live bidirectional filesystem synchronization.
- Process-level migration through CRIU or VM snapshots.
- Exactly-once recovery of arbitrary in-flight tools.
- Automatic pushing to canonical Git remotes.
- A project-definition build or package manager.
- Replacing OMP's persistence engine with a durable task-state harness.

These may be useful later, but none is required to establish isolated local work,
portable session state, multi-repository projects, and branch-based cloud delegation.
