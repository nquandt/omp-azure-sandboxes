import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { arch, homedir, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SandConfig } from "./config";
import { capture, runInteractive } from "./process";
import { WORKER_IMAGE_TAG } from "./worker-version";

const DUMBPIPE_VERSION = "0.40.1";
const DUMBPIPE_RELEASE =
  `https://github.com/n0-computer/dumbpipe/releases/download/v${DUMBPIPE_VERSION}`;
const DUMBPIPE_ASSETS: Record<string, { archive: string; sha256: string }> = {
  "darwin-arm64": {
    archive: `dumbpipe-v${DUMBPIPE_VERSION}-darwin-aarch64.tar.gz`,
    sha256: "e6bd3c9a98ba22e8233ae1f8ba5e2dceb4cbf132dc4d4332589295b702902a27",
  },
  "darwin-x64": {
    archive: `dumbpipe-v${DUMBPIPE_VERSION}-darwin-x86_64.tar.gz`,
    sha256: "eaa35e228528cbf5fc2a8a07646570f49af6ab1acd35c8f539f150a0cb5d4b0e",
  },
  "linux-arm64": {
    archive: `dumbpipe-v${DUMBPIPE_VERSION}-linux-aarch64.tar.gz`,
    sha256: "1529c49598ac15d9413bf7f29a09c04cf2f5dc3af1b9080a1b50855a77846c47",
  },
  "linux-x64": {
    archive: `dumbpipe-v${DUMBPIPE_VERSION}-linux-x86_64.tar.gz`,
    sha256: "66aee1e249890ee63678dfc8f18ce3671e691673c83bbd72bf9a54c4d32da85c",
  },
};

function acaScope(config: SandConfig): string[] {
  return [
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
    "--region",
    config.azure.region,
    "--group",
    config.azure.sandboxGroup,
  ];
}

function remoteExec(config: SandConfig, sandboxId: string, command: string): string[] {
  return [
    "aca",
    "sandbox",
    "exec",
    ...acaScope(config),
    "--id",
    sandboxId,
    "--command",
    command,
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function sshQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function stateRoot(configPath: string): string {
  return dirname(configPath);
}

function requireSshWorker(config: SandConfig): void {
  if (config.services?.image.endsWith(`:${WORKER_IMAGE_TAG}`) !== true) {
    throw new Error(
      "worker image does not include the Sand SSH transport\n" +
        "Run sand infra auth, then sand infra worker.",
    );
  }
}

async function ensureDumbpipe(configPath: string): Promise<string> {
  const root = stateRoot(configPath);
  const binary = join(root, "bin", "dumbpipe");
  if (await Bun.file(binary).exists()) {
    const installed = await capture([binary, "--version"]);
    if (installed.exitCode === 0 && installed.stdout.includes(DUMBPIPE_VERSION)) {
      return binary;
    }
  }

  const asset = DUMBPIPE_ASSETS[`${platform()}-${arch()}`];
  if (asset === undefined) {
    throw new Error(`dumbpipe is unsupported on ${platform()} ${arch()}`);
  }
  const response = await fetch(`${DUMBPIPE_RELEASE}/${asset.archive}`);
  if (!response.ok) {
    throw new Error(`dumbpipe download failed: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(`dumbpipe checksum mismatch: expected ${asset.sha256}, got ${digest}`);
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sand-dumbpipe-"));
  try {
    const archive = join(temporaryDirectory, asset.archive);
    await writeFile(archive, bytes, { mode: 0o600 });
    const extracted = await capture([
      "tar",
      "-xzf",
      archive,
      "-C",
      temporaryDirectory,
      "./dumbpipe",
    ]);
    if (extracted.exitCode !== 0) {
      throw new Error(`dumbpipe extraction failed:\n${extracted.stderr.trim()}`);
    }
    await mkdir(dirname(binary), { recursive: true });
    await chmod(join(temporaryDirectory, "dumbpipe"), 0o755);
    await rename(join(temporaryDirectory, "dumbpipe"), binary);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return binary;
}

async function ensureSshKey(configPath: string): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  const directory = join(stateRoot(configPath), "ssh");
  const privateKey = join(directory, "id_ed25519");
  const publicKey = `${privateKey}.pub`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await Bun.file(privateKey).exists())) {
    const result = await capture([
      "ssh-keygen",
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "sand",
      "-f",
      privateKey,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`SSH key generation failed:\n${result.stderr.trim()}`);
    }
  }
  await chmod(privateKey, 0o600);
  await chmod(publicKey, 0o644);
  return { privateKey, publicKey };
}

interface RemoteSshIdentity {
  ticket: string;
  hostKey: string;
}

async function remoteSshIdentity(
  config: SandConfig,
  sandboxId: string,
): Promise<RemoteSshIdentity> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await capture(
      remoteExec(
        config,
        sandboxId,
        "cat /state/ssh/dumbpipe.ticket && printf '\\n' && " +
          "cat /state/ssh/ssh_host_ed25519_key.pub",
      ),
    );
    if (result.exitCode === 0) {
      const lines = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");
      const ticket = lines.find((line) => line.startsWith("endpoint"));
      const hostKey = lines.find((line) => line.startsWith("ssh-ed25519 "));
      if (ticket !== undefined && hostKey !== undefined) {
        return { ticket, hostKey };
      }
    }
    await Bun.sleep(1_000);
  }
  throw new Error("sandbox SSH transport did not become ready");
}

function hostAlias(sandboxId: string): string {
  return `sand-${sandboxId}`;
}

async function pinHostKey(
  configPath: string,
  sandboxId: string,
  hostKey: string,
): Promise<string> {
  const path = join(stateRoot(configPath), "ssh", "known_hosts");
  const alias = hostAlias(sandboxId);
  const previous = (await Bun.file(path).exists()) ? await readFile(path, "utf8") : "";
  const retained = previous
    .split(/\r?\n/)
    .filter((line) => line !== "" && !line.startsWith(`${alias} `));
  retained.push(`${alias} ${hostKey}`);
  await writeFile(path, `${retained.join("\n")}\n`, { mode: 0o600 });
  return path;
}

async function sandExecutable(): Promise<string> {
  const result = await capture(["which", "sand"]);
  if (result.exitCode !== 0 || result.stdout.trim() === "") {
    throw new Error("installed sand executable was not found on PATH");
  }
  return result.stdout.trim();
}

async function installSshConfig(
  configPath: string,
  sandboxId: string,
  privateKey: string,
  knownHosts: string,
): Promise<string> {
  const root = stateRoot(configPath);
  const generatedConfig = join(root, "ssh", "config");
  const alias = hostAlias(sandboxId);
  const marker = `# sand session ${sandboxId}`;
  const endMarker = `# end sand session ${sandboxId}`;
  const previous = (await Bun.file(generatedConfig).exists())
    ? await readFile(generatedConfig, "utf8")
    : "";
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEndMarker = endMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutSession = previous.replace(
    new RegExp(`${escapedMarker}\\n[\\s\\S]*?${escapedEndMarker}\\n?`, "g"),
    "",
  );
  const proxy = [
    sshQuote(await sandExecutable()),
    "--config",
    sshQuote(configPath),
    "session",
    "proxy",
    sandboxId,
  ].join(" ");
  const block = [
    marker,
    `Host ${alias}`,
    `  HostName ${alias}`,
    "  User root",
    `  IdentityFile ${sshQuote(privateKey)}`,
    `  UserKnownHostsFile ${sshQuote(knownHosts)}`,
    `  HostKeyAlias ${alias}`,
    "  StrictHostKeyChecking yes",
    `  ProxyCommand ${proxy}`,
    endMarker,
    "",
  ].join("\n");
  await writeFile(generatedConfig, `${withoutSession.trimEnd()}\n${block}`, {
    mode: 0o600,
  });

  const sshDirectory = join(homedir(), ".ssh");
  const userConfig = join(sshDirectory, "config");
  await mkdir(sshDirectory, { recursive: true, mode: 0o700 });
  const include = `Include ${sshQuote(generatedConfig)}`;
  const userContents = (await Bun.file(userConfig).exists())
    ? await readFile(userConfig, "utf8")
    : "";
  if (!userContents.split(/\r?\n/).includes(include)) {
    await writeFile(userConfig, `${include}\n${userContents}`, { mode: 0o600 });
  }
  return alias;
}

const OMP_SETTINGS_MARKER = "/state/home/.sand/omp-startup-v1";
const OMP_STARTUP_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ["startup.quiet", "true"],
  ["startup.setupWizard", "false"],
  ["startup.changelogMode", "hidden"],
  ["startup.checkUpdate", "false"],
  ["update.auto", "false"],
];

export async function configureSshSession(
  config: SandConfig,
  configPath: string,
  sandboxId: string,
  model?: string,
): Promise<string> {
  const effectiveModel = model ?? config.defaults.model;
  requireSshWorker(config);
  const keys = await ensureSshKey(configPath);
  const publicKey = (await readFile(keys.publicKey, "utf8")).trim();
  const injection = await capture(
    remoteExec(
      config,
      sandboxId,
      "mkdir -p /state/home/.ssh && chmod 700 /state/home/.ssh && " +
        `printf '%s\\n' ${shellQuote(publicKey)} > /state/home/.ssh/authorized_keys && ` +
        "chmod 600 /state/home/.ssh/authorized_keys && " +
        "touch /state/home/.bashrc && " +
        "(grep -q '# >>> sand >>>' /state/home/.bashrc || " +
        "{ printf '%s\\n' '# >>> sand >>>' " +
        "'[ -f /state/sand.env ] && . /state/sand.env' " +
        "'case $- in *i*) [ \"$PWD\" = \"$HOME\" ] && cd /workspace 2>/dev/null;; esac' " +
        "'# <<< sand <<<' | cat - /state/home/.bashrc > /state/home/.bashrc.new && " +
        "mv /state/home/.bashrc.new /state/home/.bashrc; }) && " +
        `([ -f ${OMP_SETTINGS_MARKER} ] || (${OMP_STARTUP_SETTINGS.map(
          ([key, value]) => `omp config set ${key} ${value} >/dev/null`,
        ).join(" && ")} && touch ${OMP_SETTINGS_MARKER}))` +
        (effectiveModel === undefined
          ? ""
          : ` && printf '%s\\n' ${shellQuote(effectiveModel)} > /state/home/.sand/model`),
    ),
  );
  if (injection.exitCode !== 0) {
    throw new Error(`SSH key injection failed:\n${injection.stderr.trim()}`);
  }
  const identity = await remoteSshIdentity(config, sandboxId);
  const knownHosts = await pinHostKey(configPath, sandboxId, identity.hostKey);
  await ensureDumbpipe(configPath);
  return installSshConfig(
    configPath,
    sandboxId,
    keys.privateKey,
    knownHosts,
  );
}

export async function proxySshSession(
  config: SandConfig,
  configPath: string,
  sandboxId: string,
): Promise<number> {
  requireSshWorker(config);
  const [binary, identity] = await Promise.all([
    ensureDumbpipe(configPath),
    remoteSshIdentity(config, sandboxId),
  ]);
  const child = Bun.spawn([binary, "connect", identity.ticket], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const heartbeat = setInterval(() => {
    void capture(remoteExec(config, sandboxId, "true"));
  }, 240_000);
  try {
    return await child.exited;
  } finally {
    clearInterval(heartbeat);
  }
}

export async function sshSession(
  config: SandConfig,
  configPath: string,
  sandboxId: string,
  command: readonly string[],
  tty = false,
  model?: string,
): Promise<number> {
  const alias = await configureSshSession(config, configPath, sandboxId, model);
  return runInteractive(["ssh", ...(tty ? ["-t"] : []), alias, ...command]);
}

export async function attachOmpSession(
  config: SandConfig,
  configPath: string,
  sandboxId: string,
  model?: string,
): Promise<number> {
  return sshSession(config, configPath, sandboxId, ["sand-omp"], true, model);
}

export async function openCodeSession(
  config: SandConfig,
  configPath: string,
  sandboxId: string,
  model?: string,
): Promise<number> {
  const alias = await configureSshSession(config, configPath, sandboxId, model);
  return runInteractive(["code", "--remote", `ssh-remote+${alias}`, "/workspace"]);
}
