import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { type SandConfig, writeConfig } from "./config";
import { capture, runInteractive } from "./process";
import { OMP_VERSION, WORKER_IMAGE_TAG } from "./worker-version";

const IMAGE_TAG = WORKER_IMAGE_TAG;

function compactId(value: string): string {
  return value.replaceAll("-", "").slice(0, 12).toLowerCase();
}

async function requireCapture(command: string[], description: string): Promise<string> {
  const result = await capture(command);
  if (result.exitCode !== 0) {
    throw new Error(`${description} failed:\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function requireRun(command: string[], description: string): Promise<void> {
  const exitCode = await runInteractive(command);
  if (exitCode !== 0) {
    throw new Error(`${description} failed with exit code ${exitCode}`);
  }
}

async function exists(command: string[]): Promise<boolean> {
  return (await capture(command)).exitCode === 0;
}

async function appSecret(
  subscriptionId: string,
  resourceGroup: string,
  app: string,
  name: string,
): Promise<string | undefined> {
  const result = await capture([
    "az",
    "containerapp",
    "secret",
    "show",
    "--subscription",
    subscriptionId,
    "--resource-group",
    resourceGroup,
    "--name",
    app,
    "--secret-name",
    name,
    "--query",
    "value",
    "--output",
    "tsv",
  ]);
  return result.exitCode === 0 && result.stdout.trim() !== ""
    ? result.stdout.trim()
    : undefined;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

interface ContainerAppOptions {
  name: string;
  environmentId: string;
  location: string;
  image: string;
  registryServer: string;
  registryUsername: string;
  registryPassword: string;
  targetPort: number;
  secrets: Record<string, string>;
  env: Array<{ name: string; value?: string; secretRef?: string }>;
  volume?: { storageName: string; mountPath: string };
  identity?: "SystemAssigned";
  minReplicas?: number;
}

function containerAppDocument(options: ContainerAppOptions): object {
  const volumes = options.volume
    ? [
        {
          name: "state",
          storageName: options.volume.storageName,
          storageType: "AzureFile",
        },
      ]
    : undefined;
  const volumeMounts = options.volume
    ? [{ volumeName: "state", mountPath: options.volume.mountPath }]
    : undefined;

  return {
    location: options.location,
    name: options.name,
    type: "Microsoft.App/containerApps",
    ...(options.identity === undefined ? {} : { identity: { type: options.identity } }),
    properties: {
      managedEnvironmentId: options.environmentId,
      configuration: {
        activeRevisionsMode: "Single",
        ingress: {
          external: true,
          allowInsecure: false,
          targetPort: options.targetPort,
          transport: "auto",
        },
        registries: [
          {
            server: options.registryServer,
            username: options.registryUsername,
            passwordSecretRef: "registry-password",
          },
        ],
        secrets: [
          { name: "registry-password", value: options.registryPassword },
          ...Object.entries(options.secrets).map(([name, value]) => ({ name, value })),
        ],
      },
      template: {
        containers: [
          {
            name: options.name,
            image: options.image,
            resources: { cpu: 0.5, memory: "1Gi" },
            env: options.env,
            ...(volumeMounts === undefined ? {} : { volumeMounts }),
          },
        ],
        scale: { minReplicas: options.minReplicas ?? 0, maxReplicas: 1 },
        ...(volumes === undefined ? {} : { volumes }),
      },
    },
  };
}

export async function deployAuthInfrastructure(
  config: SandConfig,
  configPath: string,
): Promise<void> {
  const { subscriptionId, resourceGroup, region } = config.azure;
  const suffix = compactId(subscriptionId);
  const registryName = `acrsand${suffix}`;
  const storageName = `stsand${suffix}`;
  const environmentName = `cae-sand-${region}`;
  const brokerApp = "sand-auth-broker";
  const gatewayApp = "sand-auth-gateway";
  const image = `${registryName}.azurecr.io/sand/omp:${IMAGE_TAG}`;
  const scope = ["--subscription", subscriptionId, "--resource-group", resourceGroup];

  if (
    !(await exists([
      "az",
      "acr",
      "show",
      ...scope,
      "--name",
      registryName,
      "--output",
      "none",
    ]))
  ) {
    await requireRun(
      [
        "az",
        "acr",
        "create",
        ...scope,
        "--name",
        registryName,
        "--sku",
        "Basic",
        "--admin-enabled",
        "true",
        "--output",
        "none",
      ],
      "container registry creation",
    );
  }

  if (
    !(await exists([
      "az",
      "storage",
      "account",
      "show",
      ...scope,
      "--name",
      storageName,
      "--output",
      "none",
    ]))
  ) {
    await requireRun(
      [
        "az",
        "storage",
        "account",
        "create",
        ...scope,
        "--name",
        storageName,
        "--location",
        region,
        "--sku",
        "Standard_LRS",
        "--kind",
        "StorageV2",
        "--min-tls-version",
        "TLS1_2",
        "--allow-blob-public-access",
        "false",
        "--output",
        "none",
      ],
      "storage account creation",
    );
  }

  if (
    !(await exists([
      "az",
      "storage",
      "share-rm",
      "show",
      ...scope,
      "--storage-account",
      storageName,
      "--name",
      "broker-state",
      "--output",
      "none",
    ]))
  ) {
    await requireRun(
      [
        "az",
        "storage",
        "share-rm",
        "create",
        ...scope,
        "--storage-account",
        storageName,
        "--name",
        "broker-state",
        "--quota",
        "5",
        "--output",
        "none",
      ],
      "broker file share creation",
    );
  }

  if (
    !(await exists([
      "az",
      "storage",
      "share-rm",
      "show",
      ...scope,
      "--storage-account",
      storageName,
      "--name",
      "dispatcher-state",
      "--output",
      "none",
    ]))
  ) {
    await requireRun(
      [
        "az",
        "storage",
        "share-rm",
        "create",
        ...scope,
        "--storage-account",
        storageName,
        "--name",
        "dispatcher-state",
        "--quota",
        "5",
        "--output",
        "none",
      ],
      "dispatcher file share creation",
    );
  }

  if (
    !(await exists([
      "az",
      "containerapp",
      "env",
      "show",
      ...scope,
      "--name",
      environmentName,
      "--output",
      "none",
    ]))
  ) {
    await requireRun(
      [
        "az",
        "containerapp",
        "env",
        "create",
        ...scope,
        "--name",
        environmentName,
        "--location",
        region,
        "--output",
        "none",
      ],
      "Container Apps environment creation",
    );
  }

  const storageKey = await requireCapture(
    [
      "az",
      "storage",
      "account",
      "keys",
      "list",
      ...scope,
      "--account-name",
      storageName,
      "--query",
      "[0].value",
      "--output",
      "tsv",
    ],
    "storage key lookup",
  );
  await requireRun(
    [
      "az",
      "containerapp",
      "env",
      "storage",
      "set",
      ...scope,
      "--name",
      environmentName,
      "--storage-name",
      "brokerstate",
      "--access-mode",
      "ReadWrite",
      "--azure-file-account-name",
      storageName,
      "--azure-file-account-key",
      storageKey,
      "--azure-file-share-name",
      "broker-state",
      "--output",
      "none",
    ],
    "Container Apps storage attachment",
  );
  await requireRun(
    [
      "az",
      "containerapp",
      "env",
      "storage",
      "set",
      ...scope,
      "--name",
      environmentName,
      "--storage-name",
      "dispatcherstate",
      "--access-mode",
      "ReadWrite",
      "--azure-file-account-name",
      storageName,
      "--azure-file-account-key",
      storageKey,
      "--azure-file-share-name",
      "dispatcher-state",
      "--output",
      "none",
    ],
    "dispatcher storage attachment",
  );

  if (
    !(await exists([
      "az",
      "acr",
      "repository",
      "show",
      "--subscription",
      subscriptionId,
      "--name",
      registryName,
      "--image",
      `sand/omp:${IMAGE_TAG}`,
      "--output",
      "none",
    ]))
  ) {
    await requireRun(
      [
        "az",
        "acr",
        "build",
        "--subscription",
        subscriptionId,
        "--registry",
        registryName,
        "--image",
        `sand/omp:${IMAGE_TAG}`,
        "--platform",
        "linux/amd64",
        resolve("images/omp"),
      ],
      "OMP image build",
    );
  }

  const registryCredentials = JSON.parse(
    await requireCapture(
      [
        "az",
        "acr",
        "credential",
        "show",
        "--subscription",
        subscriptionId,
        "--name",
        registryName,
        "--output",
        "json",
      ],
      "registry credential lookup",
    ),
  ) as { username: string; passwords: Array<{ value: string }> };
  const registryPassword = registryCredentials.passwords[0]?.value;
  if (registryPassword === undefined) {
    throw new Error("registry returned no password");
  }

  const environmentId = await requireCapture(
    [
      "az",
      "containerapp",
      "env",
      "show",
      ...scope,
      "--name",
      environmentName,
      "--query",
      "id",
      "--output",
      "tsv",
    ],
    "Container Apps environment lookup",
  );
  const brokerToken =
    (await appSecret(subscriptionId, resourceGroup, brokerApp, "broker-token")) ?? token();

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sand-auth-"));
  try {
    const brokerFile = join(temporaryDirectory, "broker.json");
    await writeFile(
      brokerFile,
      JSON.stringify(
        containerAppDocument({
          name: brokerApp,
          environmentId,
          location: region,
          image,
          registryServer: `${registryName}.azurecr.io`,
          registryUsername: registryCredentials.username,
          registryPassword,
          targetPort: 8765,
          secrets: { "broker-token": brokerToken },
          env: [
            { name: "SAND_ROLE", value: "broker" },
            { name: "SAND_BROKER_TOKEN", secretRef: "broker-token" },
          ],
          volume: { storageName: "brokerstate", mountPath: "/state" },
        }),
      ),
      { mode: 0o600 },
    );
    await requireRun(
      [
        "az",
        "containerapp",
        "create",
        ...scope,
        "--name",
        brokerApp,
        "--yaml",
        brokerFile,
        "--output",
        "none",
      ],
      "auth broker deployment",
    );

    const brokerFqdn = await requireCapture(
      [
        "az",
        "containerapp",
        "show",
        ...scope,
        "--name",
        brokerApp,
        "--query",
        "properties.configuration.ingress.fqdn",
        "--output",
        "tsv",
      ],
      "auth broker endpoint lookup",
    );
    const brokerUrl = `https://${brokerFqdn}`;
    const gatewayToken =
      (await appSecret(subscriptionId, resourceGroup, gatewayApp, "gateway-token")) ?? token();
    const gatewayClientsFile = join(temporaryDirectory, "gateway-clients.json");
    await writeFile(gatewayClientsFile, "{}\n", { mode: 0o600 });
    if (
      !(await exists([
        "az",
        "storage",
        "file",
        "show",
        "--account-name",
        storageName,
        "--account-key",
        storageKey,
        "--share-name",
        "dispatcher-state",
        "--path",
        "gateway-clients.json",
        "--output",
        "none",
      ]))
    ) {
      await requireRun(
        [
          "az",
          "storage",
          "file",
          "upload",
          "--account-name",
          storageName,
          "--account-key",
          storageKey,
          "--share-name",
          "dispatcher-state",
          "--path",
          "gateway-clients.json",
          "--source",
          gatewayClientsFile,
          "--output",
          "none",
        ],
        "gateway client table initialization",
      );
    }
    const gatewayFile = join(temporaryDirectory, "gateway.json");
    await writeFile(
      gatewayFile,
      JSON.stringify(
        containerAppDocument({
          name: gatewayApp,
          environmentId,
          location: region,
          image,
          registryServer: `${registryName}.azurecr.io`,
          registryUsername: registryCredentials.username,
          registryPassword,
          targetPort: 4000,
          secrets: {
            "broker-token": brokerToken,
            "gateway-token": gatewayToken,
          },
          env: [
            { name: "SAND_ROLE", value: "gateway" },
            { name: "SAND_BROKER_URL", value: brokerUrl },
            { name: "SAND_BROKER_TOKEN", secretRef: "broker-token" },
            { name: "SAND_GATEWAY_TOKEN", secretRef: "gateway-token" },
            { name: "SAND_GATEWAY_CLIENTS_FILE", value: "/state/gateway-clients.json" },
          ],
          volume: { storageName: "dispatcherstate", mountPath: "/state" },
        }),
      ),
      { mode: 0o600 },
    );
    await requireRun(
      [
        "az",
        "containerapp",
        "create",
        ...scope,
        "--name",
        gatewayApp,
        "--yaml",
        gatewayFile,
        "--output",
        "none",
      ],
      "auth gateway deployment",
    );

    const gatewayFqdn = await requireCapture(
      [
        "az",
        "containerapp",
        "show",
        ...scope,
        "--name",
        gatewayApp,
        "--query",
        "properties.configuration.ingress.fqdn",
        "--output",
        "tsv",
      ],
      "auth gateway endpoint lookup",
    );
    config.services = {
      registryName,
      image,
      containerAppEnvironment: environmentName,
      brokerApp,
      brokerUrl,
      gatewayApp,
      gatewayUrl: `https://${gatewayFqdn}`,
    };
    await writeConfig(config, configPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function deployDispatcherInfrastructure(
  config: SandConfig,
  configPath: string,
): Promise<void> {
  const configured = config.services;
  if (configured === undefined || configured.workerDiskId === undefined) {
    throw new Error("worker disk is not registered");
  }
  const { subscriptionId, resourceGroup, sandboxGroup, region } = config.azure;
  const scope = ["--subscription", subscriptionId, "--resource-group", resourceGroup];
  const dispatcherApp = "sand-dispatcher";
  const dispatcherToken =
    (await appSecret(subscriptionId, resourceGroup, dispatcherApp, "dispatcher-token")) ?? token();
  const registryCredentials = JSON.parse(
    await requireCapture(
      [
        "az",
        "acr",
        "credential",
        "show",
        "--subscription",
        subscriptionId,
        "--name",
        configured.registryName,
        "--output",
        "json",
      ],
      "registry credential lookup",
    ),
  ) as { username: string; passwords: Array<{ value: string }> };
  const registryPassword = registryCredentials.passwords[0]?.value;
  if (registryPassword === undefined) {
    throw new Error("registry returned no password");
  }
  const environmentId = await requireCapture(
    [
      "az",
      "containerapp",
      "env",
      "show",
      ...scope,
      "--name",
      configured.containerAppEnvironment,
      "--query",
      "id",
      "--output",
      "tsv",
    ],
    "Container Apps environment lookup",
  );

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sand-dispatcher-"));
  try {
    const definition = join(temporaryDirectory, "dispatcher.json");
    await writeFile(
      definition,
      JSON.stringify(
        containerAppDocument({
          name: dispatcherApp,
          environmentId,
          location: region,
          image: configured.image,
          registryServer: `${configured.registryName}.azurecr.io`,
          registryUsername: registryCredentials.username,
          registryPassword,
          targetPort: 8080,
          identity: "SystemAssigned",
          minReplicas: 1,
          secrets: { "dispatcher-token": dispatcherToken },
          env: [
            { name: "SAND_ROLE", value: "dispatcher" },
            { name: "SAND_DISPATCHER_TOKEN", secretRef: "dispatcher-token" },
            { name: "SAND_SUBSCRIPTION_ID", value: subscriptionId },
            { name: "SAND_RESOURCE_GROUP", value: resourceGroup },
            { name: "SAND_REGION", value: region },
            { name: "SAND_SANDBOX_GROUP", value: sandboxGroup },
            { name: "SAND_WORKER_DISK_ID", value: configured.workerDiskId },
            { name: "SAND_GATEWAY_URL", value: configured.gatewayUrl },
            { name: "SAND_CHILD_CPU", value: config.defaults.cpu },
            { name: "SAND_CHILD_MEMORY", value: config.defaults.memory },
          ],
          volume: { storageName: "dispatcherstate", mountPath: "/state" },
        }),
      ),
      { mode: 0o600 },
    );
    await requireRun(
      [
        "az",
        "containerapp",
        "create",
        ...scope,
        "--name",
        dispatcherApp,
        "--yaml",
        definition,
        "--output",
        "none",
      ],
      "dispatcher deployment",
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const principalId = await requireCapture(
    [
      "az",
      "containerapp",
      "identity",
      "show",
      ...scope,
      "--name",
      dispatcherApp,
      "--query",
      "principalId",
      "--output",
      "tsv",
    ],
    "dispatcher identity lookup",
  );
  const sandboxGroupId =
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
    `/providers/Microsoft.App/sandboxGroups/${sandboxGroup}`;
  const role = await capture([
    "az",
    "role",
    "assignment",
    "create",
    "--subscription",
    subscriptionId,
    "--assignee-object-id",
    principalId,
    "--assignee-principal-type",
    "ServicePrincipal",
    "--role",
    "Container Apps SandboxGroup Data Owner",
    "--scope",
    sandboxGroupId,
    "--output",
    "none",
  ]);
  if (role.exitCode !== 0 && !role.stderr.includes("RoleAssignmentExists")) {
    throw new Error(`dispatcher role assignment failed:\n${role.stderr.trim()}`);
  }

  const fqdn = await requireCapture(
    [
      "az",
      "containerapp",
      "show",
      ...scope,
      "--name",
      dispatcherApp,
      "--query",
      "properties.configuration.ingress.fqdn",
      "--output",
      "tsv",
    ],
    "dispatcher endpoint lookup",
  );
  configured.dispatcherApp = dispatcherApp;
  configured.dispatcherUrl = `https://${fqdn}`;
  await writeConfig(config, configPath);
}

