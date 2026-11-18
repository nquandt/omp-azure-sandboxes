async function settings(): Promise<{ url: string; token: string }> {
  const url = process.env.SAND_DISPATCHER_URL?.replace(/\/$/, "");
  const token =
    process.env.SAND_DISPATCHER_TOKEN ??
    (await Bun.file(`${process.env.HOME}/.sand/dispatcher.token`).text()).trim();
  if (!url || !token) {
    throw new Error("sandbox dispatch is unavailable in this session");
  }
  return { url, token };
}

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const { url, token } = await settings();
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
    throw new Error(typeof value.error === "string" ? value.error : `dispatcher returned ${response.status}`);
  }
  return value;
}

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

export default function sandExtension(pi: any) {
  const z = pi.zod;

  pi.registerTool({
    name: "sand_spawn",
    label: "Spawn Sandbox Agent",
    description:
      "Start one isolated depth-1 OMP agent in Azure. Returns immediately with a job ID. Use sand_wait or sand_status before sand_result.",
    loadMode: "essential",
    approval: "exec",
    parameters: z.object({
      task: z.string().describe("Complete, self-contained assignment for the child agent"),
      model: z.string().describe("Provider-qualified model ID, for example cursor/gpt-5.6-sol"),
      repository: z.string().optional().describe("Optional public Git repository URL to clone"),
      maxCost: z.number().positive().max(100).optional(),
      maxTimeSeconds: z.number().int().min(60).max(14400).optional(),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      return result(
        await request("/v1/jobs", { method: "POST", body: JSON.stringify(params) }),
      );
    },
  });

  pi.registerTool({
    name: "sand_status",
    label: "Sandbox Agent Status",
    description: "Read the current state of an Azure sandbox agent job.",
    loadMode: "essential",
    approval: "read",
    parameters: z.object({ jobId: z.string() }),
    async execute(_id: string, params: { jobId: string }) {
      return result(await request(`/v1/jobs/${params.jobId}`));
    },
  });

  pi.registerTool({
    name: "sand_wait",
    label: "Wait for Sandbox Agent",
    description: "Wait until an Azure sandbox agent job completes, fails, or expires.",
    loadMode: "essential",
    approval: "read",
    parameters: z.object({
      jobId: z.string(),
      pollSeconds: z.number().int().min(2).max(30).optional(),
    }),
    async execute(
      _id: string,
      params: { jobId: string; pollSeconds?: number },
      signal?: AbortSignal,
    ) {
      for (;;) {
        if (signal?.aborted) {
          throw new Error("wait cancelled");
        }
        const value = await request(`/v1/jobs/${params.jobId}`);
        if (["completed", "failed", "cancelled", "expired"].includes(String(value.state))) {
          return result(value);
        }
        await Bun.sleep((params.pollSeconds ?? 5) * 1000);
      }
    },
  });

  pi.registerTool({
    name: "sand_result",
    label: "Sandbox Agent Result",
    description: "Read the final output from a completed Azure sandbox agent job.",
    loadMode: "essential",
    approval: "read",
    parameters: z.object({ jobId: z.string() }),
    async execute(_id: string, params: { jobId: string }) {
      return result(await request(`/v1/jobs/${params.jobId}/result`));
    },
  });

  pi.registerTool({
    name: "sand_cancel",
    label: "Cancel Sandbox Agent",
    description: "Stop an Azure sandbox agent job and revoke its model capability.",
    loadMode: "essential",
    approval: "exec",
    parameters: z.object({ jobId: z.string() }),
    async execute(_id: string, params: { jobId: string }) {
      return result(await request(`/v1/jobs/${params.jobId}`, { method: "DELETE" }));
    },
  });
}
