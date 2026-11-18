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
