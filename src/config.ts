import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SandConfig {
  version: 1;
  azure: {
    subscriptionId: string;
    resourceGroup: string;
    sandboxGroup: string;
    region: string;
  };
  defaults: {
    disk: string;
    cpu: string;
    memory: string;
    model?: string;
  };
  services?: {
    registryName: string;
    image: string;
    containerAppEnvironment: string;
    brokerApp: string;
    brokerUrl: string;
    gatewayApp: string;
    gatewayUrl: string;
    dispatcherApp?: string;
    dispatcherUrl?: string;
    workerDiskId?: string;
  };
}

export function defaultConfigPath(): string {
  return process.env.SAND_CONFIG ?? join(homedir(), ".config", "sand", "config.json");
}

function requireString(
  object: Record<string, unknown>,
  key: string,
  location: string,
): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location}.${key} must be a non-empty string`);
  }
  return value;
}

function requireObject(
  object: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = object[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseConfig(value: unknown): SandConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("configuration must be a JSON object");
  }

  const root = value as Record<string, unknown>;
  if (root.version !== 1) {
    throw new Error("configuration version must be 1");
  }

  const azure = requireObject(root, "azure");
  const defaults = requireObject(root, "defaults");

  const config: SandConfig = {
    version: 1,
    azure: {
      subscriptionId: requireString(azure, "subscriptionId", "azure"),
      resourceGroup: requireString(azure, "resourceGroup", "azure"),
      sandboxGroup: requireString(azure, "sandboxGroup", "azure"),
      region: requireString(azure, "region", "azure"),
    },
    defaults: {
      disk: requireString(defaults, "disk", "defaults"),
      cpu: requireString(defaults, "cpu", "defaults"),
      memory: requireString(defaults, "memory", "defaults"),
    },
  };

  const defaultModel = defaults.model;
  if (defaultModel !== undefined) {
    if (typeof defaultModel !== "string" || defaultModel.trim() === "") {
      throw new Error("defaults.model must be a non-empty string");
    }
    config.defaults.model = defaultModel;
  }

  if (root.services !== undefined) {
    const services = requireObject(root, "services");
    config.services = {
      registryName: requireString(services, "registryName", "services"),
      image: requireString(services, "image", "services"),
      containerAppEnvironment: requireString(
        services,
        "containerAppEnvironment",
        "services",
      ),
      brokerApp: requireString(services, "brokerApp", "services"),
      brokerUrl: requireString(services, "brokerUrl", "services"),
      gatewayApp: requireString(services, "gatewayApp", "services"),
      gatewayUrl: requireString(services, "gatewayUrl", "services"),
    };
    const dispatcherApp = services.dispatcherApp;
    const dispatcherUrl = services.dispatcherUrl;
    if (dispatcherApp !== undefined || dispatcherUrl !== undefined) {
      if (typeof dispatcherApp !== "string" || dispatcherApp.trim() === "") {
        throw new Error("services.dispatcherApp must be a non-empty string");
      }
      if (typeof dispatcherUrl !== "string" || dispatcherUrl.trim() === "") {
        throw new Error("services.dispatcherUrl must be a non-empty string");
      }
      config.services.dispatcherApp = dispatcherApp;
      config.services.dispatcherUrl = dispatcherUrl;
    }
    const workerDiskId = services.workerDiskId;
    if (workerDiskId !== undefined) {
      if (typeof workerDiskId !== "string" || workerDiskId.trim() === "") {
        throw new Error("services.workerDiskId must be a non-empty string");
      }
      config.services.workerDiskId = workerDiskId;
    }
  }

  return config;
}

export async function readConfig(path = defaultConfigPath()): Promise<SandConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`configuration not found: ${path}\nRun sand init first.`);
  }

  try {
    return parseConfig(await file.json());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid configuration ${path}: ${detail}`);
  }
}

export async function writeConfig(config: SandConfig, path = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
