#!/usr/bin/env bun

import {
  defaultConfigPath,
  readConfig,
  type SandConfig,
  writeConfig,
} from "./config";
import {
  deployAuthInfrastructure,
  deployDispatcherInfrastructure,
} from "./auth-infra";
import { capture, runInteractive } from "./process";
import {
  createOmpSandbox,
  latestOmpSandbox,
  registerWorkerImage,
  startOmpSession,
} from "./worker";
import {
  attachOmpSession,
  openCodeSession,
  proxySshSession,
  sshSession,
} from "./ssh";
import {
  agentResult,
  agentStatus,
  cancelAgent,
  spawnAgent,
  waitForAgent,
} from "./dispatcher-client";

const HELP = `sand — Azure Container Apps Sandboxes for coding agents

Usage:
  sand init --subscription ID --resource-group NAME --sandbox-group NAME --region REGION
  sand infra create --subscription ID --resource-group NAME --sandbox-group NAME --region REGION
  sand infra auth
  sand infra worker
  sand auth status
  sand auth login PROVIDER
  sand auth import --from-local [--include-env] [--apply]
  sand models [PATTERN]
  sand omp [--model PROVIDER/MODEL] [--repo URL] [--prompt TEXT]
  sand session list
  sand session attach SANDBOX_ID [--model PROVIDER/MODEL]
  sand code [new] [--id SANDBOX_ID] [--repo URL] [--model PROVIDER/MODEL]
  sand ssh [new] [--id SANDBOX_ID] [--repo URL] [--model PROVIDER/MODEL] [-- COMMAND...]
  sand session ssh SANDBOX_ID
  sand session exec SANDBOX_ID -- COMMAND [ARG...]
  sand session code SANDBOX_ID
  sand session stop SANDBOX_ID
  sand agent spawn --task TEXT --model PROVIDER/MODEL [--repo URL] [--max-cost USD] [--max-time SECONDS]
  sand agent status ID
  sand agent wait ID [--poll-seconds SECONDS]
  sand agent result ID
  sand agent cancel ID
  sand doctor
  sand config show
  sand config model [PROVIDER/MODEL | --unset]
  sand sandbox create [--disk NAME] [--cpu CPU] [--memory MEMORY] [--label KEY=VALUE]
  sand sandbox shell ID [--command COMMAND]

Global options:
  --config PATH   Configuration file (default: $SAND_CONFIG or ~/.config/sand/config.json)
  -h, --help      Show help
`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  args.splice(index, 2);
  return value;
}

function takeOptions(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const value = takeOption(args, name);
    if (value === undefined) {
      return values;
    }
    values.push(value);
  }
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) {
    return false;
  }
  args.splice(index, 1);
  return true;
}

function requireOption(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(`missing required option ${name}`);
  }
  return value;
}

function assertNoArguments(args: readonly string[]): void {
  if (args.length > 0) {
    throw new Error(`unexpected argument: ${args[0]}`);
  }
}

function positiveNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function acaScope(config: SandConfig): string[] {
  return [
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--region",
    config.azure.region,
  ];
}

async function init(args: string[], configPath: string): Promise<number> {
  const force = takeFlag(args, "--force");
  const config: SandConfig = {
    version: 1,
    azure: {
      subscriptionId: requireOption(takeOption(args, "--subscription"), "--subscription"),
      resourceGroup: requireOption(takeOption(args, "--resource-group"), "--resource-group"),
      sandboxGroup: requireOption(takeOption(args, "--sandbox-group"), "--sandbox-group"),
      region: requireOption(takeOption(args, "--region"), "--region"),
    },
    defaults: {
      disk: takeOption(args, "--disk") ?? "ubuntu",
      cpu: takeOption(args, "--cpu") ?? "2500m",
      memory: takeOption(args, "--memory") ?? "4096Mi",
    },
  };
  assertNoArguments(args);

  if (!force && (await Bun.file(configPath).exists())) {
    throw new Error(`configuration already exists: ${configPath}\nPass --force to replace it.`);
  }

  await writeConfig(config, configPath);
  console.log(`Wrote ${configPath}`);
  console.log("Next: sand doctor");
  return 0;
}

async function createInfrastructure(args: string[], configPath: string): Promise<number> {
  const force = takeFlag(args, "--force");
  const subscriptionId = requireOption(takeOption(args, "--subscription"), "--subscription");
  const resourceGroup = requireOption(takeOption(args, "--resource-group"), "--resource-group");
  const sandboxGroup = requireOption(takeOption(args, "--sandbox-group"), "--sandbox-group");
  const region = requireOption(takeOption(args, "--region"), "--region");
  assertNoArguments(args);

  if (!force && (await Bun.file(configPath).exists())) {
    throw new Error(`configuration already exists: ${configPath}\nPass --force to replace it.`);
  }

  const groupExit = await runInteractive([
    "az",
    "group",
    "create",
    "--subscription",
    subscriptionId,
    "--name",
    resourceGroup,
    "--location",
    region,
    "--output",
    "none",
  ]);
  if (groupExit !== 0) {
    return groupExit;
  }

  const scope = [
    "--subscription",
    subscriptionId,
    "--resource-group",
    resourceGroup,
  ];
  const existing = await capture([
    "aca",
    "sandboxgroup",
    "get",
    ...scope,
    "--name",
    sandboxGroup,
    "--output",
    "json",
  ]);
  if (existing.exitCode !== 0) {
    const createExit = await runInteractive([
      "aca",
      "sandboxgroup",
      "create",
      ...scope,
      "--name",
      sandboxGroup,
      "--location",
      region,
    ]);
    if (createExit !== 0) {
      return createExit;
    }
  } else {
    console.log(`Using existing sandbox group ${sandboxGroup}`);
  }

  await writeConfig(
    {
      version: 1,
      azure: { subscriptionId, resourceGroup, sandboxGroup, region },
      defaults: { disk: "ubuntu", cpu: "2500m", memory: "4096Mi" },
    },
    configPath,
  );
  console.log(`Wrote ${configPath}`);
  return 0;
}

async function authEnvironment(config: SandConfig): Promise<Record<string, string>> {
  if (config.services === undefined) {
    throw new Error("credential plane is not deployed\nRun sand infra auth first.");
  }
  const tokenResult = await capture([
    "az",
    "containerapp",
    "secret",
    "show",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    config.services.brokerApp,
    "--secret-name",
    "broker-token",
    "--query",
    "value",
    "--output",
    "tsv",
  ]);
  if (tokenResult.exitCode !== 0 || tokenResult.stdout.trim() === "") {
    throw new Error(`broker token lookup failed:\n${tokenResult.stderr.trim()}`);
  }
  return {
    OMP_AUTH_BROKER_URL: config.services.brokerUrl,
    OMP_AUTH_BROKER_TOKEN: tokenResult.stdout.trim(),
  };
}

async function waitForBroker(config: SandConfig): Promise<Record<string, string>> {
  const environment = await authEnvironment(config);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const result = await capture(["omp", "auth-broker", "status"], environment);
    if (result.exitCode === 0) {
      return environment;
    }
    await Bun.sleep(2_000);
  }
  throw new Error("auth broker did not become ready after scaling from zero");
}

async function deployAuth(args: string[], configPath: string): Promise<number> {
  assertNoArguments(args);
  const config = await readConfig(configPath);
  await deployAuthInfrastructure(config, configPath);
  console.log("Credential plane deployed.");
  return 0;
}

async function deployWorker(args: string[], configPath: string): Promise<number> {
  assertNoArguments(args);
  const config = await readConfig(configPath);
  await registerWorkerImage(config, configPath);
  await deployDispatcherInfrastructure(config, configPath);
  console.log("OMP worker image registered.");
  console.log("Sandbox dispatcher deployed.");
  return 0;
}

async function authStatus(args: string[], configPath: string): Promise<number> {
  assertNoArguments(args);
  const config = await readConfig(configPath);
  const environment = await waitForBroker(config);
  return runInteractive(["omp", "auth-broker", "status"], environment);
}

async function authImport(args: string[], configPath: string): Promise<number> {
  const fromLocal = takeFlag(args, "--from-local");
  const includeEnvironment = takeFlag(args, "--include-env");
  const apply = takeFlag(args, "--apply");
  if (!fromLocal) {
    throw new Error("auth import currently requires --from-local");
  }
  assertNoArguments(args);

  const command = [
    "omp",
    "auth-broker",
    "migrate",
    "--from-local",
    "--include-oauth",
  ];
  if (includeEnvironment) {
    command.push("--include-env");
  }
  if (!apply) {
    command.push("--dry-run");
    console.log("Preview only. Re-run with --apply to upload these credentials.");
  }
  const config = await readConfig(configPath);
  return runInteractive(command, await waitForBroker(config));
}

async function authLogin(args: string[], configPath: string): Promise<number> {
  const provider = args.shift();
  if (provider === undefined) {
    throw new Error("auth login requires a provider ID");
  }
  assertNoArguments(args);
  const loginExit = await runInteractive(["omp", "auth-broker", "login", provider]);
  if (loginExit !== 0) {
    return loginExit;
  }
  const config = await readConfig(configPath);
  return runInteractive(
    [
      "omp",
      "auth-broker",
      "migrate",
      "--from-local",
      "--include-oauth",
    ],
    await waitForBroker(config),
  );
}

async function listModels(args: string[], configPath: string): Promise<number> {
  const pattern = args.shift();
  assertNoArguments(args);
  const command = ["omp", "models"];
  if (pattern !== undefined) {
    command.push("find", pattern);
  }
  const config = await readConfig(configPath);
  return runInteractive(command, await waitForBroker(config));
}

async function doctor(configPath: string): Promise<number> {
  const config = await readConfig(configPath);

  const azVersion = await capture(["az", "version", "--output", "none"]);
  if (azVersion.exitCode !== 0) {
    throw new Error("Azure CLI is unavailable. Install it from https://aka.ms/azure-cli");
  }

  const acaVersion = await capture(["aca", "--version"]);
  if (acaVersion.exitCode !== 0) {
    throw new Error("ACA CLI is unavailable. Install it from https://aka.ms/aca-cli-install");
  }

  const account = await capture([
    "az",
    "account",
    "show",
    "--subscription",
    config.azure.subscriptionId,
    "--query",
    "id",
    "--output",
    "tsv",
  ]);
  if (account.exitCode !== 0) {
    throw new Error(`Azure authentication failed:\n${account.stderr.trim()}\nRun az login.`);
  }

  const resourceGroup = await capture([
    "az",
    "group",
    "show",
    "--subscription",
    config.azure.subscriptionId,
    "--name",
    config.azure.resourceGroup,
    "--output",
    "none",
  ]);
  if (resourceGroup.exitCode !== 0) {
    throw new Error(`resource group check failed:\n${resourceGroup.stderr.trim()}`);
  }

  const sandboxGroup = await capture([
    "aca",
    "sandboxgroup",
    "get",
    ...acaScope(config),
    "--name",
    config.azure.sandboxGroup,
    "--output",
    "json",
  ]);
  if (sandboxGroup.exitCode !== 0) {
    throw new Error(`sandbox group check failed:\n${sandboxGroup.stderr.trim()}`);
  }

  const dataPlane = await capture([
    "aca",
    "sandboxgroup",
    "disk",
    "list-public",
    ...acaScope(config),
    "--group",
    config.azure.sandboxGroup,
    "--output",
    "json",
  ]);
  if (dataPlane.exitCode !== 0) {
    throw new Error(`sandbox data-plane check failed:\n${dataPlane.stderr.trim()}`);
  }

  console.log(`✓ Azure CLI authenticated for ${config.azure.subscriptionId}`);
  console.log(`✓ Resource group ${config.azure.resourceGroup}`);
  console.log(`✓ Sandbox group ${config.azure.sandboxGroup} (${config.azure.region})`);
  console.log("✓ Sandbox data-plane access");
  console.log(`✓ Config ${configPath}`);
  return 0;
}

async function showConfig(args: string[], configPath: string): Promise<number> {
  assertNoArguments(args);
  console.log(JSON.stringify(await readConfig(configPath), null, 2));
  return 0;
}

async function configModel(args: string[], configPath: string): Promise<number> {
  const config = await readConfig(configPath);
  const unset = takeFlag(args, "--unset");
  const model = args.shift();
  assertNoArguments(args);
  if (unset) {
    if (model !== undefined) {
      throw new Error("--unset does not take a model");
    }
    delete config.defaults.model;
    await writeConfig(config, configPath);
    console.log("Default model cleared.");
    return 0;
  }
  if (model === undefined) {
    console.log(config.defaults.model ?? "(none)");
    return 0;
  }
  if (!model.includes("/")) {
    throw new Error("model must be PROVIDER/MODEL, for example github-copilot/gpt-6-luna");
  }
  config.defaults.model = model;
  await writeConfig(config, configPath);
  console.log(`Default model: ${model}`);
  return 0;
}

async function createSandbox(args: string[], configPath: string): Promise<number> {
  const config = await readConfig(configPath);
  const disk = takeOption(args, "--disk") ?? config.defaults.disk;
  const cpu = takeOption(args, "--cpu") ?? config.defaults.cpu;
  const memory = takeOption(args, "--memory") ?? config.defaults.memory;
  const labels = takeOptions(args, "--label");
  assertNoArguments(args);

  const command = [
    "aca",
    "sandbox",
    "create",
    ...acaScope(config),
    "--group",
    config.azure.sandboxGroup,
    "--disk",
    disk,
    "--cpu",
    cpu,
    "--memory",
    memory,
  ];
  for (const label of labels) {
    command.push("--label", label);
  }
  return runInteractive(command);
}

async function shellSandbox(args: string[], configPath: string): Promise<number> {
  const config = await readConfig(configPath);
  const command = takeOption(args, "--command");
  const sandboxId = args.shift();
  if (sandboxId === undefined) {
    throw new Error("sandbox shell requires a sandbox ID");
  }
  assertNoArguments(args);

  return runInteractive([
    "aca",
    "sandbox",
    command === undefined ? "shell" : "exec",
    ...acaScope(config),
    "--group",
    config.azure.sandboxGroup,
    "--id",
    sandboxId,
    "--command",
    command ?? "/bin/bash",
  ]);
}

async function agentCommand(
  operation: string | undefined,
  args: string[],
  configPath: string,
): Promise<number> {
  const config = await readConfig(configPath);
  let value: Record<string, unknown>;
  if (operation === "spawn") {
    const task = requireOption(takeOption(args, "--task"), "--task");
    const model = requireOption(takeOption(args, "--model"), "--model");
    const repository = takeOption(args, "--repo");
    const maxCost = positiveNumber(takeOption(args, "--max-cost"), "--max-cost");
    const maxTime = positiveNumber(takeOption(args, "--max-time"), "--max-time");
    if (maxTime !== undefined && !Number.isInteger(maxTime)) {
      throw new Error("--max-time must be an integer");
    }
    assertNoArguments(args);
    const request: {
      task: string;
      model: string;
      repository?: string;
      maxCost?: number;
      maxTimeSeconds?: number;
    } = { task, model };
    if (repository !== undefined) request.repository = repository;
    if (maxCost !== undefined) request.maxCost = maxCost;
    if (maxTime !== undefined) request.maxTimeSeconds = maxTime;
    value = await spawnAgent(config, request);
  } else {
    const jobId = args.shift();
    if (jobId === undefined) {
      throw new Error(`agent ${operation ?? "command"} requires a job ID`);
    }
    if (operation === "status") {
      assertNoArguments(args);
      value = await agentStatus(config, jobId);
    } else if (operation === "wait") {
      const pollSeconds =
        positiveNumber(takeOption(args, "--poll-seconds"), "--poll-seconds") ?? 5;
      if (!Number.isInteger(pollSeconds)) {
        throw new Error("--poll-seconds must be an integer");
      }
      assertNoArguments(args);
      value = await waitForAgent(config, jobId, pollSeconds);
    } else if (operation === "result") {
      assertNoArguments(args);
      value = await agentResult(config, jobId);
    } else if (operation === "cancel") {
      assertNoArguments(args);
      value = await cancelAgent(config, jobId);
    } else {
      throw new Error(`unknown agent operation: ${operation ?? ""}`);
    }
  }
  console.log(JSON.stringify(value, null, 2));
  return 0;
}

async function devBoxCommand(
  kind: "code" | "ssh",
  args: string[],
  configPath: string,
): Promise<number> {
  const config = await readConfig(configPath);
  const createNew = args[0] === "new";
  if (createNew) {
    args.shift();
  }
  const requestedId = takeOption(args, "--id");
  const model = takeOption(args, "--model");
  const repository = takeOption(args, "--repo");
  if (args[0] === "--") {
    args.shift();
  }
  if (kind === "code") {
    assertNoArguments(args);
  }

  let sandboxId = requestedId;
  if (sandboxId === undefined && !createNew) {
    sandboxId = await latestOmpSandbox(config);
    if (sandboxId !== undefined) {
      console.log(`Using sandbox ${sandboxId} (run sand ${kind} new for a new one)`);
    }
  }
  if (sandboxId === undefined) {
    const options: { model?: string; repository?: string } = {};
    if (model !== undefined) options.model = model;
    if (repository !== undefined) options.repository = repository;
    sandboxId = await createOmpSandbox(config, options);
  }
  return kind === "code"
    ? openCodeSession(config, configPath, sandboxId, model)
    : sshSession(config, configPath, sandboxId, args, false, model);
}

async function sessionCommand(
  operation: string | undefined,
  args: string[],
  configPath: string,
): Promise<number> {
  const config = await readConfig(configPath);
  if (operation === "list") {
    assertNoArguments(args);
    return runInteractive([
      "aca",
      "sandbox",
      "list",
      ...acaScope(config),
      "--group",
      config.azure.sandboxGroup,
      "--selector",
      "runtime=omp",
    ]);
  }

  const sandboxId = args.shift();
  if (sandboxId === undefined) {
    throw new Error(`session ${operation ?? "command"} requires a sandbox ID`);
  }
  if (operation === "attach") {
    const model = takeOption(args, "--model");
    assertNoArguments(args);
    return attachOmpSession(config, configPath, sandboxId, model);
  }
  if (operation === "proxy") {
    assertNoArguments(args);
    return proxySshSession(config, configPath, sandboxId);
  }
  if (operation === "code") {
    assertNoArguments(args);
    return openCodeSession(config, configPath, sandboxId);
  }
  if (operation === "stop") {
    assertNoArguments(args);
    return runInteractive([
      "aca",
      "sandbox",
      "delete",
      ...acaScope(config),
      "--group",
      config.azure.sandboxGroup,
      "--id",
      sandboxId,
      "--yes",
    ]);
  }
  if (operation === "ssh" || operation === "exec") {
    if (args[0] === "--") {
      args.shift();
    }
    if (operation === "exec" && args.length === 0) {
      throw new Error("session exec requires a command after --");
    }
    return sshSession(config, configPath, sandboxId, args);
  }
  throw new Error(`unknown session operation: ${operation ?? ""}`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const configPath = takeOption(args, "--config") ?? defaultConfigPath();
  if (takeFlag(args, "--help") || takeFlag(args, "-h") || args.length === 0) {
    console.log(HELP);
    return 0;
  }

  const command = args.shift();
  if (command === "init") {
    return init(args, configPath);
  }
  if (command === "infra") {
    const operation = args.shift();
    if (operation === "create") {
      return createInfrastructure(args, configPath);
    }
    if (operation === "auth") {
      return deployAuth(args, configPath);
    }
    if (operation === "worker") {
      return deployWorker(args, configPath);
    }
  }
  if (command === "auth") {
    const operation = args.shift();
    if (operation === "status") {
      return authStatus(args, configPath);
    }
    if (operation === "login") {
      return authLogin(args, configPath);
    }
    if (operation === "import") {
      return authImport(args, configPath);
    }
  }
  if (command === "models") {
    return listModels(args, configPath);
  }
  if (command === "agent") {
    return agentCommand(args.shift(), args, configPath);
  }
  if (command === "code" || command === "ssh") {
    return devBoxCommand(command, args, configPath);
  }
  if (command === "session") {
    return sessionCommand(args.shift(), args, configPath);
  }
  if (command === "doctor") {
    assertNoArguments(args);
    return doctor(configPath);
  }
  if (command === "config") {
    const operation = args.shift();
    if (operation === "show") {
      return showConfig(args, configPath);
    }
    if (operation === "model") {
      return configModel(args, configPath);
    }
  }
  if (command === "sandbox") {
    const operation = args.shift();
    if (operation === "create") {
      return createSandbox(args, configPath);
    }
    if (operation === "shell") {
      return shellSandbox(args, configPath);
    }
  }
  if (command === "omp") {
    const model = takeOption(args, "--model");
    const repository = takeOption(args, "--repo");
    const prompt = takeOption(args, "--prompt");
    assertNoArguments(args);
    const options: { model?: string; repository?: string; prompt?: string } = {};
    if (model !== undefined) {
      options.model = model;
    }
    if (repository !== undefined) {
      options.repository = repository;
    }
    if (prompt !== undefined) {
      options.prompt = prompt;
    }
    return startOmpSession(await readConfig(configPath), configPath, options);
  }

  throw new Error(`unknown command\n\n${HELP}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`sand: ${message}`);
  process.exitCode = 1;
}
