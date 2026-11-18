import { type SandConfig } from "./config";
import { capture } from "./process";

interface DispatcherRequest {
  task: string;
  model: string;
  repository?: string;
  maxCost?: number;
  maxTimeSeconds?: number;
}

async function connection(config: SandConfig): Promise<{ url: string; token: string }> {
  const services = config.services;
  if (
    services?.dispatcherApp === undefined ||
    services.dispatcherUrl === undefined
  ) {
    throw new Error("sandbox dispatcher is not deployed\nRun sand infra worker first.");
  }
  const result = await capture([
    "az",
    "containerapp",
    "secret",
    "show",
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--name",
    services.dispatcherApp,
    "--secret-name",
    "dispatcher-token",
    "--query",
    "value",
    "--output",
    "tsv",
  ]);
  if (result.exitCode !== 0 || result.stdout.trim() === "") {
    throw new Error(`dispatcher token lookup failed:\n${result.stderr.trim()}`);
  }
  return { url: services.dispatcherUrl.replace(/\/$/, ""), token: result.stdout.trim() };
}

async function request(
  config: SandConfig,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const { url, token } = await connection(config);
  const response = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const value = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof value.error === "string"
        ? value.error
        : `dispatcher returned HTTP ${response.status}`,
    );
  }
  return value;
}

export async function spawnAgent(
  config: SandConfig,
  value: DispatcherRequest,
): Promise<Record<string, unknown>> {
  return request(config, "/v1/jobs", {
    method: "POST",
    body: JSON.stringify(value),
  });
}

export async function agentStatus(
  config: SandConfig,
  jobId: string,
): Promise<Record<string, unknown>> {
  return request(config, `/v1/jobs/${jobId}`);
}

export async function waitForAgent(
  config: SandConfig,
  jobId: string,
  pollSeconds: number,
): Promise<Record<string, unknown>> {
  for (;;) {
    const value = await agentStatus(config, jobId);
    if (["completed", "failed", "cancelled", "expired"].includes(String(value.state))) {
      return value;
    }
    await Bun.sleep(pollSeconds * 1000);
  }
}

export async function agentResult(
  config: SandConfig,
  jobId: string,
): Promise<Record<string, unknown>> {
  return request(config, `/v1/jobs/${jobId}/result`);
}

export async function cancelAgent(
  config: SandConfig,
  jobId: string,
): Promise<Record<string, unknown>> {
  return request(config, `/v1/jobs/${jobId}`, { method: "DELETE" });
}
