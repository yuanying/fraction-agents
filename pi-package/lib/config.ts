import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { PathRules } from "./rules.ts";

/**
 * The GitHub gate's settings: which repository the agent writes to, with which GitHub App, and what it may
 * change. It holds no secrets: the App's private key is read from `app.privateKeyFile`.
 */
export interface GateConfig extends PathRules {
  repository: {
    owner: string;
    name: string;
    defaultBranch: string;
    /** Where git fetches and pushes. Defaults to `https://github.com/<owner>/<name>.git`. */
    remoteUrl: string;
  };
  /** The REST API. Defaults to `https://api.github.com`. */
  apiUrl: string;
  app: { appId: string; installationId: string; privateKeyFile: string };
  /** The persistent clone the contexts' worktrees are made from. Absolute. */
  clone: string;
  /** Every branch the agent pushes starts with this. */
  branchPrefix: string;
  /** Author and committer of the agent's commits. */
  commitIdentity: { name: string; email: string };
  /** Callers (`system:serviceaccount:<namespace>:<name>`) who get the merge tool. */
  mergeCallers: string[];
  mergeMethod: "merge" | "squash" | "rebase";
  /** Skill directories inside the workspace, relative to it, that pi should load (e.g. `.claude/skills`). */
  skillPaths: string[];
}

/** The file name of the gate's settings inside pi's agent directory. */
export const GATE_CONFIG_FILE = "github-gate.json";

/** The settings file in the agent directory pi runs with (`PI_CODING_AGENT_DIR`). */
export function defaultGateConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const agentDir = env.PI_CODING_AGENT_DIR;
  return agentDir ? join(agentDir, GATE_CONFIG_FILE) : undefined;
}

export function loadGateConfig(path: string): GateConfig {
  return parseGateConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseGateConfig(input: unknown): GateConfig {
  const root = record(input, "config");
  const repository = record(root.repository, "repository");
  const app = record(root.app, "app");
  const identity = record(root.commitIdentity, "commitIdentity");
  const owner = name(repository, "owner", "repository.owner");
  const repo = name(repository, "name", "repository.name");
  const mergeMethod = root.mergeMethod === undefined ? "merge" : text(root, "mergeMethod", "mergeMethod");
  if (mergeMethod !== "merge" && mergeMethod !== "squash" && mergeMethod !== "rebase") {
    throw new Error("github-gate: mergeMethod must be merge, squash or rebase");
  }
  const branchPrefix = text(root, "branchPrefix", "branchPrefix");
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\/?$/.test(branchPrefix) || branchPrefix.includes("..")) {
    throw new Error("github-gate: branchPrefix must be a plain branch name prefix");
  }
  return {
    repository: {
      owner,
      name: repo,
      defaultBranch: repository.defaultBranch === undefined ? "main" : text(repository, "defaultBranch", "repository.defaultBranch"),
      remoteUrl:
        repository.remoteUrl === undefined
          ? `https://github.com/${owner}/${repo}.git`
          : text(repository, "remoteUrl", "repository.remoteUrl"),
    },
    apiUrl: (root.apiUrl === undefined ? "https://api.github.com" : text(root, "apiUrl", "apiUrl")).replace(/\/+$/, ""),
    app: {
      appId: idText(app.appId, "app.appId"),
      installationId: idText(app.installationId, "app.installationId"),
      privateKeyFile: absolute(app, "privateKeyFile", "app.privateKeyFile"),
    },
    clone: absolute(root, "clone", "clone"),
    branchPrefix,
    commitIdentity: { name: text(identity, "name", "commitIdentity.name"), email: text(identity, "email", "commitIdentity.email") },
    appendOnlyPaths: paths(root.appendOnlyPaths, "appendOnlyPaths"),
    readOnlyPaths: paths(root.readOnlyPaths, "readOnlyPaths"),
    mechanicalConflictPaths: paths(root.mechanicalConflictPaths, "mechanicalConflictPaths"),
    mergeCallers: list(root.mergeCallers, "mergeCallers"),
    mergeMethod,
    skillPaths: paths(root.skillPaths, "skillPaths"),
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`github-gate: ${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(input: Record<string, unknown>, key: string, field: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`github-gate: ${field} must be a non-empty string`);
  return value;
}

function name(input: Record<string, unknown>, key: string, field: string): string {
  const value = text(input, key, field);
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`github-gate: ${field} must be a GitHub name`);
  return value;
}

function idText(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  throw new Error(`github-gate: ${field} must be a numeric ID`);
}

function absolute(input: Record<string, unknown>, key: string, field: string): string {
  const value = text(input, key, field);
  if (!isAbsolute(value)) throw new Error(`github-gate: ${field} must be an absolute path`);
  return value;
}

function list(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`github-gate: ${field} must be a list of non-empty strings`);
  }
  return value as string[];
}

function paths(value: unknown, field: string): string[] {
  const items = list(value, field);
  const bad = items.find((item) => isAbsolute(item) || item.split("/").includes(".."));
  if (bad !== undefined) throw new Error(`github-gate: ${field} must hold paths relative to the repository, got ${JSON.stringify(bad)}`);
  return items;
}
