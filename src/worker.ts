import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type SandConfig, writeConfig } from "./config";
import { capture, runInteractive } from "./process";
import { WORKER_DISK_NAME, WORKER_IMAGE_TAG } from "./worker-version";
import { attachOmpSession } from "./ssh";
import { type UploadedWorkspace, uploadWorkspace } from "./workspace";

function services(config: SandConfig): NonNullable<SandConfig["services"]> {
  if (config.services === undefined) {
    throw new Error("credential plane is not deployed\nRun sand infra auth first.");
  }
  return config.services;
}

function requireCurrentWorker(config: SandConfig): NonNullable<SandConfig["services"]> {
  const configured = services(config);
  if (!configured.image.endsWith(`:${WORKER_IMAGE_TAG}`)) {
    throw new Error(
      `worker image ${configured.image} is incompatible with this CLI\n` +
        "Run sand infra auth, then sand infra worker.",
    );
  }
  return configured;
}

function scope(config: SandConfig): string[] {
  return [
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--region",
    config.azure.region,
  ];
}

async function requireCapture(command: string[], description: string): Promise<string> {
  const result = await capture(command);
  if (result.exitCode !== 0) {
    throw new Error(`${description} failed:\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function parseId(output: string, description: string): string {
  const value = parseJson<Record<string, unknown>>(output, description);
  const id = value.id;
  if (typeof id !== "string" || id === "") {
    throw new Error(`${description} returned no id`);
  }
  return id;
}

function parseJson<T>(output: string, description: string): T {
  if (output.trim() === "null") {
    return null as T;
  }
  const objectIndex = output.indexOf("{");
  const arrayIndex = output.indexOf("[");
  const candidates = [objectIndex, arrayIndex].filter((index) => index >= 0);
  const start = candidates.length === 0 ? -1 : Math.min(...candidates);
  if (start < 0) {
    throw new Error(`${description} returned no JSON`);
  }
  return JSON.parse(output.slice(start)) as T;
}

interface RegisteredDisk {
  id?: unknown;
  name?: unknown;
  labels?: Record<string, unknown>;
}

function registeredDiskName(disk: RegisteredDisk): string | undefined {
  if (typeof disk.name === "string") {
    return disk.name;
  }
  const name = disk.labels?.name;
  return typeof name === "string" ? name : undefined;
}

async function cleanupWorkerDisks(
  config: SandConfig,
  currentDiskId: string,
): Promise<void> {
  const disks = parseJson<RegisteredDisk[]>(
    await requireCapture(
      [
        "aca",
        "sandboxgroup",
        "disk",
        "list",
        ...scope(config),
        "--group",
        config.azure.sandboxGroup,
        "--output",
        "json",
      ],
      "disk image listing",
    ),
    "disk image listing",
  );
  const sandboxes = parseJson<
    Array<{ sourcesRef?: { diskImage?: { id?: unknown } } }>
  >(
    await requireCapture(
      [
        "aca",
        "sandbox",
        "list",
        ...scope(config),
        "--group",
        config.azure.sandboxGroup,
        "--output",
        "json",
      ],
      "sandbox listing",
    ),
    "sandbox listing",
  );
  const referencedDiskIds = new Set(
    sandboxes
      .map((sandbox) => sandbox.sourcesRef?.diskImage?.id)
      .filter((id): id is string => typeof id === "string"),
  );

  let retained = 0;
  let deleted = 0;
  for (const disk of disks) {
    const id = disk.id;
    if (
      typeof id !== "string" ||
      id === currentDiskId ||
      disk.labels?.runtime !== "omp"
    ) {
      continue;
    }
    if (referencedDiskIds.has(id)) {
      retained += 1;
      continue;
    }
    const result = await capture([
      "aca",
      "sandboxgroup",
      "disk",
      "delete",
      ...scope(config),
      "--group",
      config.azure.sandboxGroup,
      "--id",
      id,
    ]);
    if (result.exitCode === 0) {
      deleted += 1;
    } else {
      console.warn(
        `Could not delete obsolete worker disk ${registeredDiskName(disk) ?? id}: ` +
          result.stderr.trim(),
      );
    }
  }
  console.log(
    `Worker disk cleanup: deleted ${deleted}, retained ${retained} referenced image(s).`,
  );
}

async function brokerToken(config: SandConfig): Promise<string> {
  const configured = services(config);
  return requireCapture(
    [
      "az",
      "containerapp",
      "secret",
      "show",
      "--subscription",
      config.azure.subscriptionId,
      "--resource-group",
      config.azure.resourceGroup,
      "--name",
      configured.brokerApp,
      "--secret-name",
      "broker-token",
      "--query",
      "value",
      "--output",
      "tsv",
    ],
    "broker token lookup",
  );
}

async function dispatcherToken(config: SandConfig): Promise<string> {
  const configured = services(config);
  if (configured.dispatcherApp === undefined) {
    throw new Error("sandbox dispatcher is not deployed\nRun sand infra worker first.");
  }
  return requireCapture(
    [
      "az",
      "containerapp",
      "secret",
      "show",
      "--subscription",
      config.azure.subscriptionId,
      "--resource-group",
      config.azure.resourceGroup,
      "--name",
      configured.dispatcherApp,
      "--secret-name",
      "dispatcher-token",
      "--query",
      "value",
      "--output",
      "tsv",
    ],
    "dispatcher token lookup",
  );
}

export async function registerWorkerImage(
  config: SandConfig,
  configPath: string,
): Promise<void> {
  const configured = services(config);
  const diskName = WORKER_DISK_NAME;
  const existing = parseJson<RegisteredDisk[]>(
    await requireCapture(
      [
        "aca",
        "sandboxgroup",
        "disk",
        "list",
        ...scope(config),
        "--group",
        config.azure.sandboxGroup,
        "--output",
        "json",
      ],
      "disk image listing",
    ),
    "disk image listing",
  );
  const found = existing.find((disk) => registeredDiskName(disk) === diskName);
  if (found !== undefined && typeof found.id === "string") {
    configured.workerDiskId = found.id;
    await writeConfig(config, configPath);
    await cleanupWorkerDisks(config, found.id);
    return;
  }

  const identityName = "id-sand-acr-pull";
  let identityResult = await capture([
    "az",
    "identity",
    "show",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    identityName,
    "--output",
    "json",
  ]);
  if (identityResult.exitCode !== 0) {
    identityResult = await capture([
      "az",
      "identity",
      "create",
      "--subscription",
      config.azure.subscriptionId,
      "--resource-group",
      config.azure.resourceGroup,
      "--name",
      identityName,
      "--location",
      config.azure.region,
      "--output",
      "json",
    ]);
  }
  if (identityResult.exitCode !== 0) {
    throw new Error(`registry identity creation failed:\n${identityResult.stderr.trim()}`);
  }
  const identity = parseJson<{ clientId: string; id: string; principalId: string }>(
    identityResult.stdout,
    "registry identity",
  );
  await requireCapture(
    [
      "aca",
      "sandboxgroup",
      "identity",
      "assign",
      ...scope(config),
      "--group",
      config.azure.sandboxGroup,
      "--user-assigned",
      identity.id,
      "--output",
      "json",
    ],
    "sandbox group identity assignment",
  );

  const registryId = await requireCapture(
    [
      "az",
      "acr",
      "show",
      "--subscription",
      config.azure.subscriptionId,
      "--resource-group",
      config.azure.resourceGroup,
      "--name",
      configured.registryName,
      "--query",
      "id",
      "--output",
      "tsv",
    ],
    "registry lookup",
  );
  const role = await capture([
    "az",
    "role",
    "assignment",
    "create",
    "--subscription",
    config.azure.subscriptionId,
    "--assignee-object-id",
    identity.principalId,
    "--assignee-principal-type",
    "ServicePrincipal",
    "--role",
    "AcrPull",
    "--scope",
    registryId,
    "--output",
    "none",
  ]);
  if (role.exitCode !== 0 && !role.stderr.includes("RoleAssignmentExists")) {
    throw new Error(`AcrPull assignment failed:\n${role.stderr.trim()}`);
  }

  const imagePath = configured.image.slice(configured.image.indexOf("/") + 1);
  const tagSeparator = imagePath.lastIndexOf(":");
  if (tagSeparator < 0) {
    throw new Error(`worker image has no tag: ${configured.image}`);
  }
  const repository = imagePath.slice(0, tagSeparator);
  const digest = await requireCapture(
    [
      "az",
      "acr",
      "repository",
      "show",
      "--subscription",
      config.azure.subscriptionId,
      "--name",
      configured.registryName,
      "--image",
      imagePath,
      "--query",
      "digest",
      "--output",
      "tsv",
    ],
    "worker image digest lookup",
  );
  const immutableImage = `${configured.registryName}.azurecr.io/${repository}@${digest}`;

  let result = await capture(
    [
      "aca",
      "sandboxgroup",
      "disk",
      "create",
      ...scope(config),
      "--group",
      config.azure.sandboxGroup,
      "--name",
      diskName,
      "--image",
      immutableImage,
      "--identity",
      identity.clientId,
      "--label",
      "runtime=omp",
      "--label",
      "version=18.22.2",
      "--output",
      "json",
    ],
  );
  if (result.exitCode !== 0 && result.stderr.includes("RegistryAuthFailed")) {
    const credentials = parseJson<{
      username: string;
      passwords: Array<{ value: string }>;
    }>(
      await requireCapture(
        [
          "az",
          "acr",
          "credential",
          "show",
          "--subscription",
          config.azure.subscriptionId,
          "--name",
          configured.registryName,
          "--output",
          "json",
        ],
        "registry credential lookup",
      ),
      "registry credential lookup",
    );
    const password = credentials.passwords[0]?.value;
    if (password === undefined) {
      throw new Error("registry returned no password");
    }
    result = await capture([
      "aca",
      "sandboxgroup",
      "disk",
      "create",
      ...scope(config),
      "--group",
      config.azure.sandboxGroup,
      "--name",
      diskName,
      "--image",
      immutableImage,
      "--username",
      credentials.username,
      "--token",
      password,
      "--label",
      "runtime=omp",
      "--label",
      "version=18.22.2",
      "--output",
      "json",
    ]);
  }
  if (result.exitCode !== 0) {
    throw new Error(`worker disk registration failed:\n${result.stderr.trim()}`);
  }
  configured.workerDiskId = parseId(result.stdout, "worker disk registration");
  await writeConfig(config, configPath);
  await cleanupWorkerDisks(config, configured.workerDiskId);
}

export interface OmpSessionOptions {
  model?: string;
  repository?: string;
  prompt?: string;
  workspace?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export async function createOmpSandbox(
  config: SandConfig,
  options: OmpSessionOptions,
): Promise<string> {
  const workspace =
    options.workspace === undefined ? undefined : await uploadWorkspace(config, options.workspace);
  try {
    return await createPreparedOmpSandbox(config, options, workspace);
  } finally {
    await workspace?.dispose();
  }
}

async function createPreparedOmpSandbox(
  config: SandConfig,
  options: OmpSessionOptions,
  workspace: UploadedWorkspace | undefined,
): Promise<string> {
  const configured = requireCurrentWorker(config);
  if (configured.workerDiskId === undefined) {
    throw new Error("OMP worker image is not registered\nRun sand infra worker first.");
  }
  if (configured.dispatcherUrl === undefined) {
    throw new Error("sandbox dispatcher is not deployed\nRun sand infra worker first.");
  }

  const sessionId = randomUUID();
  const volumeName = `state-${sessionId.slice(0, 12)}`;
  await requireCapture(
    [
      "aca",
      "sandboxgroup",
      "volume",
      "create",
      ...scope(config),
      "--group",
      config.azure.sandboxGroup,
      "--name",
      volumeName,
      "--type",
      "DataDisk",
      "--size",
      "10Gi",
      "--label",
      `session=${sessionId}`,
      "--output",
      "json",
    ],
    "session volume creation",
  );

  const environment: Record<string, string> = {
    OMP_AUTH_BROKER_URL: configured.brokerUrl,
    SAND_DISPATCHER_URL: configured.dispatcherUrl,
    SAND_SESSION_ID: sessionId,
  };
  const sessionModel = options.model ?? config.defaults.model;
  if (sessionModel !== undefined) {
    environment.SAND_MODEL = sessionModel;
  }
  if (options.repository !== undefined) {
    environment.SAND_REPOSITORY = options.repository;
  }
  if (workspace !== undefined) {
    environment.SAND_WORKSPACE_URL = workspace.url;
    environment.SAND_WORKSPACE_SHA256 = workspace.sha256;
  }
  const manifestDirectory = await mkdtemp(join(tmpdir(), "sand-manifest-"));
  let createOutput: string;
  try {
    const manifestFile = join(manifestDirectory, "sandbox.json");
    await writeFile(
      manifestFile,
      JSON.stringify({
        diskId: configured.workerDiskId,
        resources: {
          cpu: config.defaults.cpu,
          memory: config.defaults.memory,
          disk: "20480Mi",
        },
        lifecycle: {
          autoSuspendPolicy: { enabled: true, interval: 300, mode: "Disk" },
        },
        environment,
        egressPolicy: { defaultAction: "Allow", trafficInspection: "None" },
        labels: { session: sessionId, runtime: "omp" },
        volumes: [{ volumeName, mountpoint: "/state", readOnly: false }],
      }),
      { mode: 0o600 },
    );
    createOutput = await requireCapture(
      [
        "aca",
        "sandbox",
        "apply",
        ...scope(config),
        "--group",
        config.azure.sandboxGroup,
        "--file",
        manifestFile,
        "--output",
        "json",
      ],
      "sandbox creation",
    );
  } finally {
    await rm(manifestDirectory, { recursive: true, force: true });
  }
  let sandboxId: string;
  try {
    sandboxId = parseId(createOutput, "sandbox creation");
  } catch {
    const matches = parseJson<Array<{ id?: string }>>(
      await requireCapture(
        [
          "aca",
          "sandbox",
          "list",
          ...scope(config),
          "--group",
          config.azure.sandboxGroup,
          "--selector",
          `session=${sessionId}`,
          "--output",
          "json",
        ],
        "created sandbox lookup",
      ),
      "created sandbox lookup",
    );
    const id = matches[0]?.id;
    if (id === undefined) {
      throw new Error("sandbox creation returned no id");
    }
    sandboxId = id;
  }

  await requireCapture(
    [
      "aca",
      "sandbox",
      "exec",
      ...scope(config),
      "--group",
      config.azure.sandboxGroup,
      "--id",
      sandboxId,
      "--command",
      "mkdir -p /state/home/.omp /state/home/.sand && chmod 700 /state/home/.omp /state/home/.sand",
      "--output",
      "json",
    ],
    "session state initialization",
  );
  if (workspace !== undefined) {
    await requireCapture(
      [
        "aca",
        "sandbox",
        "exec",
        ...scope(config),
        "--group",
        config.azure.sandboxGroup,
        "--id",
        sandboxId,
        "--command",
        "/usr/local/bin/sand-workspace-init",
        "--output",
        "json",
      ],
      "workspace import",
    );
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sand-session-"));
  try {
    const tokenFile = join(temporaryDirectory, "auth-broker.token");
    await writeFile(tokenFile, await brokerToken(config), { mode: 0o600 });
    const dispatcherTokenFile = join(temporaryDirectory, "dispatcher.token");
    await writeFile(dispatcherTokenFile, await dispatcherToken(config), { mode: 0o600 });
    await requireCapture(
      [
        "aca",
        "sandbox",
        "fs",
        "write",
        ...scope(config),
        "--group",
        config.azure.sandboxGroup,
        "--id",
        sandboxId,
        "--path",
        "/state/home/.omp/auth-broker.token",
        "--file",
        tokenFile,
        "--output",
        "json",
      ],
      "broker token injection",
    );
    await requireCapture(
      [
        "aca",
        "sandbox",
        "fs",
        "write",
        ...scope(config),
        "--group",
        config.azure.sandboxGroup,
        "--id",
        sandboxId,
        "--path",
        "/state/home/.sand/dispatcher.token",
        "--file",
        dispatcherTokenFile,
        "--output",
        "json",
      ],
      "dispatcher token injection",
    );
    await requireCapture(
      [
        "aca",
        "sandbox",
        "exec",
        ...scope(config),
        "--group",
        config.azure.sandboxGroup,
        "--id",
        sandboxId,
        "--command",
        "chmod 600 /state/home/.omp/auth-broker.token /state/home/.sand/dispatcher.token",
        "--output",
        "json",
      ],
      "broker token permission hardening",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(`Session ${sessionId}`);
  console.log(`Sandbox ${sandboxId}`);
  return sandboxId;
}

export async function deleteOmpSandbox(config: SandConfig, sandboxId: string): Promise<void> {
  const sandbox = parseJson<{ labels?: Record<string, unknown> }>(
    await requireCapture(
      [
        "aca",
        "sandbox",
        "get",
        ...scope(config),
        "--group",
        config.azure.sandboxGroup,
        "--id",
        sandboxId,
        "--output",
        "json",
      ],
      "session lookup",
    ),
    "session lookup",
  );
  const sessionId = sandbox.labels?.session;
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error(`sandbox ${sandboxId} has no Sand session label`);
  }
  await requireCapture(
    [
      "aca",
      "sandbox",
      "delete",
      ...scope(config),
      "--group",
      config.azure.sandboxGroup,
      "--id",
      sandboxId,
      "--yes",
      "--output",
      "json",
    ],
    "session deletion",
  );
  await requireCapture(
    [
      "aca",
      "sandboxgroup",
      "volume",
      "delete",
      ...scope(config),
      "--group",
      config.azure.sandboxGroup,
      "--selector",
      `session=${sessionId}`,
      "--output",
      "json",
    ],
    "session volume deletion",
  );
}

export async function latestOmpSandbox(config: SandConfig): Promise<string | undefined> {
  const sandboxes = parseJson<
    Array<{
      id?: unknown;
      createdAt?: unknown;
      sourcesRef?: { diskImage?: { id?: unknown } };
    }>
  >(
    await requireCapture(
      [
        "aca",
        "sandbox",
        "list",
        ...scope(config),
        "--group",
        config.azure.sandboxGroup,
        "--selector",
        "runtime=omp",
        "--output",
        "json",
      ],
      "session listing",
    ),
    "session listing",
  );
  const currentDiskId = config.services?.workerDiskId;
  const newest = sandboxes
    .filter(
      (sandbox): sandbox is typeof sandbox & { id: string; createdAt: string } =>
        typeof sandbox.id === "string" &&
        typeof sandbox.createdAt === "string" &&
        sandbox.sourcesRef?.diskImage?.id === currentDiskId,
    )
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  return newest?.id;
}

export async function startOmpSession(
  config: SandConfig,
  configPath: string,
  options: OmpSessionOptions,
): Promise<number> {
  const sandboxId = await createOmpSandbox(config, options);
  if (options.prompt !== undefined) {
    const command = [
      "HOME=/state/home",
      "/usr/local/bin/sand-omp-session",
      "--print",
      "--wait-async",
      shellQuote(options.prompt),
    ];
    return runInteractive([
      "aca",
      "sandbox",
      "exec",
      ...scope(config),
      "--group",
      config.azure.sandboxGroup,
      "--id",
      sandboxId,
      "--command",
      command.join(" "),
    ]);
  }
  return attachOmpSession(config, configPath, sandboxId, options.model);
}

