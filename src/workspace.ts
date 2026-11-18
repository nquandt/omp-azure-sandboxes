import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SandConfig } from "./config";
import { capture } from "./process";

const CONTAINER = "workspaces";

interface WorkspaceMetadata {
  branch: string | null;
  repository: string | null;
}

export interface UploadedWorkspace {
  url: string;
  sha256: string;
  dispose(): Promise<void>;
}

async function requireCapture(
  command: string[],
  description: string,
  environment?: Record<string, string>,
): Promise<string> {
  const result = await capture(command, environment);
  if (result.exitCode !== 0) {
    throw new Error(`${description} failed:\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function requireRawCapture(command: string[], description: string): Promise<string> {
  const result = await capture(command);
  if (result.exitCode !== 0) {
    throw new Error(`${description} failed:\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function storageAccount(config: SandConfig): string {
  const suffix = config.azure.subscriptionId.replaceAll("-", "").slice(0, 12).toLowerCase();
  return `stsand${suffix}`;
}

async function optionalGitValue(command: string[]): Promise<string | null> {
  const result = await capture(command);
  return result.exitCode === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null;
}

async function createPackage(path: string): Promise<{
  archive: string;
  directory: string;
}> {
  const requestedPath = resolve(path);
  const root = await requireCapture(
    ["git", "-C", requestedPath, "rev-parse", "--show-toplevel"],
    `workspace lookup for ${requestedPath}`,
  );
  await requireCapture(
    ["git", "-C", root, "rev-parse", "--verify", "HEAD"],
    "workspace HEAD lookup",
  );
  const submodules = await requireCapture(
    ["git", "-C", root, "ls-files", "--stage"],
    "workspace index inspection",
  );
  if (submodules.split("\n").some((line) => line.startsWith("160000 "))) {
    throw new Error("workspace transfer does not support Git submodules");
  }

  const [listed, deleted, branch, repository] = await Promise.all([
    requireRawCapture(
      ["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      "workspace file listing",
    ),
    requireRawCapture(
      ["git", "-C", root, "ls-files", "-z", "--deleted"],
      "workspace deletion listing",
    ),
    optionalGitValue(["git", "-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"]),
    optionalGitValue(["git", "-C", root, "remote", "get-url", "origin"]),
  ]);
  const deletedFiles = new Set(deleted.split("\0").filter(Boolean));
  const files = listed.split("\0").filter((file) => file !== "" && !deletedFiles.has(file));

  const directory = await mkdtemp(join(tmpdir(), "sand-workspace-"));
  try {
    const bundle = join(directory, "repository.bundle");
    const tree = join(directory, "tree.tar.gz");
    const fileList = join(directory, "files.list");
    const metadata = join(directory, "metadata.json");
    const archive = join(directory, "workspace.tar.gz");
    await writeFile(fileList, files.length === 0 ? "" : `${files.join("\0")}\0`, {
      mode: 0o600,
    });
    await requireCapture(
      ["git", "-C", root, "bundle", "create", bundle, "HEAD"],
      "workspace repository bundle creation",
    );
    await requireCapture(
      ["tar", "-czf", tree, "-C", root, "--null", "-T", fileList],
      "workspace tree archive creation",
      { COPYFILE_DISABLE: "1" },
    );
    const value: WorkspaceMetadata = { branch, repository };
    await writeFile(metadata, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await requireCapture(
      [
        "tar",
        "-czf",
        archive,
        "-C",
        directory,
        "repository.bundle",
        "tree.tar.gz",
        "metadata.json",
      ],
      "workspace package creation",
      { COPYFILE_DISABLE: "1" },
    );
    return { archive, directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function uploadWorkspace(
  config: SandConfig,
  path: string,
): Promise<UploadedWorkspace> {
  const workspace = await createPackage(path);
  const account = storageAccount(config);
  const blob = `${randomUUID()}.tar.gz`;
  const scope = [
    "--subscription",
    config.azure.subscriptionId,
    "--resource-group",
    config.azure.resourceGroup,
  ];
  let key: string;
  try {
    key = await requireCapture(
      [
        "az",
        "storage",
        "account",
        "keys",
        "list",
        ...scope,
        "--account-name",
        account,
        "--query",
        "[0].value",
        "--output",
        "tsv",
      ],
      "workspace storage key lookup",
    );
  } catch (error) {
    await rm(workspace.directory, { recursive: true, force: true });
    throw error;
  }
  const storageEnvironment = { AZURE_STORAGE_KEY: key };
  let uploaded = false;
  try {
    await requireCapture(
      [
        "az",
        "storage",
        "container",
        "create",
        "--account-name",
        account,
        "--name",
        CONTAINER,
        "--public-access",
        "off",
        "--output",
        "none",
      ],
      "workspace container creation",
      storageEnvironment,
    );
    await requireCapture(
      [
        "az",
        "storage",
        "blob",
        "upload",
        "--account-name",
        account,
        "--container-name",
        CONTAINER,
        "--name",
        blob,
        "--file",
        workspace.archive,
        "--overwrite",
        "false",
        "--no-progress",
        "--output",
        "none",
      ],
      "workspace package upload",
      storageEnvironment,
    );
    uploaded = true;
    const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const url = await requireCapture(
      [
        "az",
        "storage",
        "blob",
        "generate-sas",
        "--account-name",
        account,
        "--container-name",
        CONTAINER,
        "--name",
        blob,
        "--permissions",
        "r",
        "--expiry",
        expiry,
        "--https-only",
        "--full-uri",
        "--output",
        "tsv",
      ],
      "workspace download URL creation",
      storageEnvironment,
    );
    const sha256 = await sha256File(workspace.archive);
    return {
      url,
      sha256,
      async dispose(): Promise<void> {
        const result = await capture(
          [
            "az",
            "storage",
            "blob",
            "delete",
            "--account-name",
            account,
            "--container-name",
            CONTAINER,
            "--name",
            blob,
            "--output",
            "none",
          ],
          storageEnvironment,
        );
        await rm(workspace.directory, { recursive: true, force: true });
        if (result.exitCode !== 0) {
          console.warn(`Could not delete workspace package ${blob}: ${result.stderr.trim()}`);
        }
      },
    };
  } catch (error) {
    if (uploaded) {
      await capture(
        [
          "az",
          "storage",
          "blob",
          "delete",
          "--account-name",
          account,
          "--container-name",
          CONTAINER,
          "--name",
          blob,
          "--output",
          "none",
        ],
        storageEnvironment,
      );
    }
    await rm(workspace.directory, { recursive: true, force: true });
    throw error;
  }
}
