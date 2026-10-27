import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * One repository the GitHub writer may write to (ADR 0027): only branches starting with `branchPrefix`, never the
 * default branch, and only changes the path rules allow.
 */
export interface WriterRepository {
  owner: string;
  name: string;
  defaultBranch: string;
  /** Where the mirror fetches and the writer pushes. Defaults to `https://github.com/<owner>/<name>.git`. */
  remoteUrl: string;
  branchPrefix: string;
  /** When not empty, every changed file must be under one of these (e.g. `security/vex/`). */
  writablePaths: string[];
  /** New files may be added here; existing ones may not be changed or deleted (e.g. `raw/`). */
  appendOnlyPaths: string[];
  /** Nothing here may be added, changed or deleted (e.g. `Permanent-Notes/`). */
  readOnlyPaths: string[];
}

/**
 * The GitHub writer's settings, read by the sidecar and by the agent's Pi extension alike. They hold no secrets:
 * the App's private key is read from `app.privateKeyFile`, which only the sidecar's container has.
 */
export interface WriterConfig {
  /** The sidecar listens on 127.0.0.1 at this port. */
  port: number;
  /** The read-only mirrors, one bare repository per repository at `<mirrorDir>/<owner>/<name>.git`. Absolute. */
  mirrorDir: string;
  /** The REST API. Defaults to `https://api.github.com`. */
  apiUrl: string;
  app: { appId: string; installationId: string; privateKeyFile: string };
  /** How often the sidecar brings every mirror up to date with GitHub. */
  syncIntervalSeconds: number;
  /** The largest bundle the sidecar takes in one push. */
  maxBundleBytes: number;
  repositories: WriterRepository[];
}

/** The file name of the settings: in the agent directory for the extension, mounted beside it for the sidecar. */
export const WRITER_CONFIG_FILE = "github-writer.json";

/** The settings file in the agent directory pi runs with (`PI_CODING_AGENT_DIR`). */
export function defaultWriterConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const agentDir = env.PI_CODING_AGENT_DIR;
  return agentDir ? join(agentDir, WRITER_CONFIG_FILE) : undefined;
}

export function mirrorPath(config: WriterConfig, repository: WriterRepository): string {
  return join(config.mirrorDir, repository.owner, `${repository.name}.git`);
}

export function loadWriterConfig(path: string): WriterConfig {
  return parseWriterConfig(JSON.parse(readFileSync(path, "utf8")));
}

const BRANCH_PREFIX = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\/?$/;

export function parseWriterConfig(input: unknown): WriterConfig {
  const root = record(input, "config");
  const app = record(root.app, "app");
  if (!Array.isArray(root.repositories) || root.repositories.length === 0) {
    throw new Error("github-writer: repositories must list at least one repository");
  }
  const repositories = root.repositories.map((item, index) => repository(item, `repositories[${index}]`));
  const seen = new Set<string>();
  for (const { owner, name } of repositories) {
    const key = `${owner}/${name}`.toLowerCase();
    if (seen.has(key)) throw new Error(`github-writer: ${owner}/${name} is listed twice`);
    seen.add(key);
  }
  return {
    port: root.port === undefined ? 8091 : port(root.port),
    mirrorDir: absolute(root, "mirrorDir", "mirrorDir"),
    apiUrl: (root.apiUrl === undefined ? "https://api.github.com" : text(root, "apiUrl", "apiUrl")).replace(/\/+$/, ""),
    app: {
      appId: idText(app.appId, "app.appId"),
      installationId: idText(app.installationId, "app.installationId"),
      privateKeyFile: absolute(app, "privateKeyFile", "app.privateKeyFile"),
    },
    syncIntervalSeconds: root.syncIntervalSeconds === undefined ? 300 : positive(root.syncIntervalSeconds, "syncIntervalSeconds"),
    maxBundleBytes: root.maxBundleBytes === undefined ? 50 * 1024 * 1024 : positive(root.maxBundleBytes, "maxBundleBytes"),
    repositories,
  };
}

function repository(input: unknown, field: string): WriterRepository {
  const value = record(input, field);
  const owner = name(value, "owner", `${field}.owner`);
  const repo = name(value, "name", `${field}.name`);
  const defaultBranch = value.defaultBranch === undefined ? "main" : text(value, "defaultBranch", `${field}.defaultBranch`);
  const branchPrefix = text(value, "branchPrefix", `${field}.branchPrefix`);
  if (!BRANCH_PREFIX.test(branchPrefix) || branchPrefix.includes("..")) {
    throw new Error(`github-writer: ${field}.branchPrefix must be a plain branch name prefix`);
  }
  if (defaultBranch.startsWith(branchPrefix)) {
    throw new Error(`github-writer: ${field}: the default branch ${defaultBranch} starts with the branch prefix ${branchPrefix}`);
  }
  return {
    owner,
    name: repo,
    defaultBranch,
    remoteUrl: value.remoteUrl === undefined ? `https://github.com/${owner}/${repo}.git` : text(value, "remoteUrl", `${field}.remoteUrl`),
    branchPrefix,
    writablePaths: paths(value.writablePaths, "writablePaths"),
    appendOnlyPaths: paths(value.appendOnlyPaths, "appendOnlyPaths"),
    readOnlyPaths: paths(value.readOnlyPaths, "readOnlyPaths"),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`github-writer: ${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(input: Record<string, unknown>, key: string, field: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`github-writer: ${field} must be a non-empty string`);
  return value;
}

function name(input: Record<string, unknown>, key: string, field: string): string {
  const value = text(input, key, field);
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") throw new Error(`github-writer: ${field} must be a GitHub name`);
  return value;
}

function idText(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new Error(`github-writer: ${field} must be a numeric ID`);
}

function absolute(input: Record<string, unknown>, key: string, field: string): string {
  const value = text(input, key, field);
  if (!isAbsolute(value)) throw new Error(`github-writer: ${field} must be an absolute path`);
  return value;
}

function port(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("github-writer: port must be a port number");
  }
  return value;
}

function positive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`github-writer: ${field} must be a positive integer`);
  return value;
}

function paths(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`github-writer: ${field} must be a list of non-empty strings`);
  }
  const bad = (value as string[]).find((item) => isAbsolute(item) || item.split("/").includes(".."));
  if (bad !== undefined) throw new Error(`github-writer: ${field} must hold paths relative to the repository, got ${JSON.stringify(bad)}`);
  return value as string[];
}
