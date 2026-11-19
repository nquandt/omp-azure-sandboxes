# OMP multi-provider authentication

Sand must preserve OMP's provider-qualified model catalog and `/model` picker.
The worker image therefore runs unmodified OMP model resolution rather than
inventing a Sand-specific model abstraction.

## Separate configuration from credentials

The following non-secret files may be synchronized into a remote OMP profile:

- `config.yml`, including model roles and quick-cycle choices.
- `models.yml`, including custom provider metadata and endpoints.
- Plugin and extension declarations.

Provider API keys, OAuth access tokens, refresh tokens, broker tokens, and
gateway tokens are never included in workspace packages or disk images.

## Credential plane

OMP already provides the two primitives Sand needs:

1. `omp auth-broker` centralizes provider logins and refresh tokens.
2. `omp auth-gateway` proxies model requests without giving provider
   credentials to its client.

Sand will deploy one private credential-plane service per installation. The
broker and gateway share persistent encrypted storage. Their loopback services
are exposed only through TLS and private Azure networking.

### Interactive root sandbox

A personal root sandbox is equivalent to the user's local OMP trust boundary.
It may use broker-backed OMP so built-in OAuth providers, account rotation,
model discovery, `/model`, and model roles behave exactly as they do locally.

The broker administrator bearer must not be placed in the workspace, command
line, image, or session journal. Sand injects it only into the OMP process. This
still makes the root sandbox trusted: arbitrary code running as that process
user can request usable provider access tokens.

### Nested subagent sandbox

A nested sandbox never receives broker access. It receives a session-scoped
gateway capability limited by:

- Parent root session.
- Provider and selected model.
- Expiration.
- Request and spend budget.
- Maximum concurrency.

The gateway resolves the provider credential through the broker and injects
upstream authentication. A child can spend its assigned quota but cannot read
or refresh the underlying provider credential.

The dispatcher writes only the SHA-256 digest of each child token to the
gateway client table. The raw token is injected into that child's sandbox and
is restricted to the requested provider-qualified model. Children receive no
broker token, dispatcher token, Azure identity, or spawn tool. `--max-cost`,
wall-clock timeout, token revocation, and a one-child-session-per-sandbox
policy bound normal execution.

## Provisioning credentials

Administrative commands run outside agent sandboxes:

```text
sand auth login <provider>
sand auth import --from-local
sand auth list
sand auth logout <provider>
sand auth rotate
```

`auth import` will use OMP's broker migration support. It must require an
explicit provider selection or confirmation before copying credentials. Sand
never copies the complete local `~/.omp` directory.

OAuth refresh happens in the broker. API keys are stored in the same credential
plane or referenced from Azure Key Vault. Interactive `/login` inside a root
session is an optional convenience, not the normal provisioning path.

## Model selection

The remote root supports the normal OMP surfaces:

```text
/model
/model provider/model-id
```

Sand adds equivalent launch and inspection commands:

```text
sand omp --model provider/model-id
sand models
```

Model-role changes persist with the remote session profile on its Data Disk.
Users may optionally synchronize non-secret local model roles when creating a
new remote profile.

## Session startup and credential refresh

Root sessions always fetch the current broker credential snapshot when OMP
starts. They do not reuse the encrypted on-disk snapshot from an earlier
sandbox run. The broker remains the canonical credential writer, refreshes
OAuth credentials immediately on broker startup and every 60 seconds when they
are within five minutes of expiry, and handles request-time auth recovery.

Reattaching to a still-running `dtach` process does not restart OMP, but the
broker-backed credential store continues receiving live snapshot updates. A
new login therefore does not require recreating the sandbox.

Use these commands from the trusted client machine, not from the sandbox:

```text
sand auth status
sand auth check
sand auth check --strict
sand auth login github-copilot
```

`sand auth status` proves broker connectivity. `sand auth check` bypasses OMP's
encrypted one-hour snapshot cache and probes the broker's current credentials
without running a chat completion. `--strict` also sends a minimal chat request
for each eligible credential; it consumes a small amount of quota and is the
useful distinction between a stored credential and one the provider authorizes
for inference. `sand auth login` performs a new provider login and migrates
that OAuth credential into the broker.

A GitHub Copilot HTTP 401 can indicate an expired or revoked credential and is
eligible for OAuth recovery. A Copilot HTTP 403 stating that the token is valid
but the account, model, feature, or integration identity is denied is an
authorization decision, not a refresh failure. OMP tries the default
`copilot-chat` integration identity and, when it was not explicitly pinned,
retries once as `copilot-developer-cli`. If both are denied, relogin can only
help when the broker holds a credential for the wrong GitHub account; otherwise
the Copilot plan, model policy, or Business organization client policy must be
changed.

After a successful relogin, an unchanged 403 proves that refreshing was not the
missing operation. Run `sand auth check --strict --json` to identify the denied
broker credential. If other Copilot models work, the selected model is disabled
by account or organization model policy. If every Copilot model fails while
other providers pass, the organization is denying both OMP client identities.
`COPILOT_INTEGRATION_ID` can pin an organization-approved identity, but Sand
does not impersonate another client by default; use an override only when the
organization administrator explicitly permits that identity.

GitHub Copilot credentials currently have no stable broker `identityKey`.
Uploading repeated local migrations can therefore create multiple active rows
instead of updating the account already stored by the broker. Account selection
may then choose an older revoked row even though a newer local login works.

`sand auth login github-copilot` avoids this ambiguity by logging in through an
isolated temporary OMP profile and uploading only that credential. After the
upload succeeds and a distinct broker row is visible, Sand disables every
Copilot row that existed before the login. A failed login or upload leaves the
old broker rows active. Other providers retain OMP's normal multi-account
upsert and rotation behavior.

## Security invariants

- Refresh tokens remain in the credential plane.
- Nested sandboxes never receive broker access.
- Workspace archives and OMP session archives contain no credential database.
- Provider secrets never appear in process arguments.
- Every gateway capability is revocable by job ID; the dispatcher revokes it
  on completion, cancellation, or expiry.
- The gateway enforces the model allow-list. OMP enforces the requested
  `--max-cost` and wall-clock limits during the child run.
- Only root sessions receive the dispatcher extension, making the enforced
  nesting depth one.

The current gateway does not meter scoped clients. A malicious child that
extracts its own token and calls the gateway directly can bypass OMP's
`--max-cost` flag until the dispatcher revokes the token at expiry. Model scope
and maximum lifetime remain enforced; hard per-token spend accounting requires
gateway support.
