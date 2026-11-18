export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function capture(
  command: string[],
  environment?: Record<string, string>,
): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

export async function runInteractive(
  command: string[],
  environment?: Record<string, string>,
): Promise<number> {
  const child = Bun.spawn(command, {
    ...(environment === undefined ? {} : { env: { ...process.env, ...environment } }),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

export async function captureWithInput(
  command: string[],
  input: string,
): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(input);
  child.stdin.end();

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

