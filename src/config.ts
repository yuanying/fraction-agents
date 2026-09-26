import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
}

/**
 * Commands that give each context a working directory of its own (for example a git worktree). The context's
 * directory is appended as the last argument; the commands run with the same environment as pi.
 */
export interface ContextWorkspaceConfig {
  /** Run before pi starts for a context. Must leave the directory in place, ready for pi to run in. */
  prepare: string[];
  /** Run when the context is deleted, before the host deletes what is left of the directory. May be empty. */
  remove: string[];
}

/** The one configuration file of a generic host. It holds no secrets. */
export interface Config {
  /** Name, description, version and skills shown in the Agent Card. */
  name: string;
  description: string;
  version: string;
  skills: SkillConfig[];
  /** The URL callers reach this agent at, advertised in the Agent Card. */
  publicUrl: string;
  port: number;
  /** ServiceAccounts allowed to call, as `system:serviceaccount:<namespace>:<name>`. */
  allowedCallers: string[];
  /** Pi's agent directory (`PI_CODING_AGENT_DIR`): AGENTS.md, settings.json, auth.json. */
  agentDir: string;
  /** Where the host keeps its state: the task database and the session files. */
  dataDir: string;
  /** The working directory pi runs in. Defaults to `<dataDir>/work`. */
  workDir: string;
  /** How long an unused pi process lives before it is stopped. */
  idleTimeoutSeconds: number;
  /** How long an unused context's session file is kept before it is deleted. */
  sessionRetentionSeconds: number;
  /** How long a task waits for the caller's answer to the agent's question before it fails. */
  inputTimeoutSeconds: number;
  /** How long an image returned as an artifact is served before it is deleted. */
  artifactRetentionSeconds: number;
  /** The command that starts pi. `--mode rpc --session <file>` is appended. */
  piCommand: string[];
  /**
   * Names of further environment variables to pass from the host to pi, on top of the minimal set. Only names:
   * the values come from the host's environment.
   */
  passEnv: string[];
  /**
   * When set, each context runs pi in `<workDir>/<contextId>`, prepared and removed by these commands. When not,
   * every context runs pi in `workDir` itself.
   */
  contextWorkspace?: ContextWorkspaceConfig;
}

const SERVICE_ACCOUNT = /^system:serviceaccount:[^:]+:[^:]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadConfig(path: string): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseConfig(input: unknown): Config {
  if (!isRecord(input)) throw new Error("config: expected a JSON object");
  const dataDir = absolutePath(input, "dataDir");
  return {
    name: text(input, "name"),
    description: text(input, "description"),
    version: input.version === undefined ? "0.0.0" : text(input, "version"),
    skills: skills(input.skills),
    publicUrl: url(input, "publicUrl"),
    port: input.port === undefined ? 8080 : port(input.port),
    allowedCallers: callers(input.allowedCallers),
    agentDir: absolutePath(input, "agentDir"),
    dataDir,
    workDir: input.workDir === undefined ? join(dataDir, "work") : absolutePath(input, "workDir"),
    idleTimeoutSeconds: input.idleTimeoutSeconds === undefined ? 1800 : duration(input, "idleTimeoutSeconds"),
    sessionRetentionSeconds:
      input.sessionRetentionSeconds === undefined ? 604800 : duration(input, "sessionRetentionSeconds"),
    inputTimeoutSeconds: input.inputTimeoutSeconds === undefined ? 86400 : duration(input, "inputTimeoutSeconds"),
    artifactRetentionSeconds:
      input.artifactRetentionSeconds === undefined ? 604800 : duration(input, "artifactRetentionSeconds"),
    piCommand: input.piCommand === undefined ? ["pi"] : command(input.piCommand),
    passEnv: input.passEnv === undefined ? [] : envNames(input.passEnv),
    ...(input.contextWorkspace === undefined ? {} : { contextWorkspace: contextWorkspace(input.contextWorkspace) }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`config: ${field} must be a non-empty string`);
  return value;
}

function absolutePath(input: Record<string, unknown>, field: string): string {
  const value = text(input, field);
  if (!isAbsolute(value)) throw new Error(`config: ${field} must be an absolute path`);
  return value;
}

function url(input: Record<string, unknown>, field: string): string {
  const value = text(input, field);
  if (!URL.canParse(value)) throw new Error(`config: ${field} must be a URL`);
  return value;
}

function port(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("config: port must be an integer between 1 and 65535");
  }
  return value;
}

function duration(input: Record<string, unknown>, field: string): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`config: ${field} must be a positive number of seconds`);
  }
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`config: ${field} must be a list of non-empty strings`);
  }
  return value as string[];
}

function callers(value: unknown): string[] {
  const list = stringList(value, "allowedCallers");
  const bad = list.find((caller) => !SERVICE_ACCOUNT.test(caller));
  if (bad !== undefined) {
    throw new Error(`config: allowedCallers must be system:serviceaccount:<namespace>:<name>, got ${JSON.stringify(bad)}`);
  }
  return list;
}

function envNames(value: unknown): string[] {
  const list = stringList(value, "passEnv");
  const bad = list.find((name) => !ENV_NAME.test(name));
  if (bad !== undefined) throw new Error(`config: passEnv must hold environment variable names, got ${JSON.stringify(bad)}`);
  return list;
}

function command(value: unknown, field = "piCommand"): string[] {
  const list = stringList(value, field);
  if (list.length === 0) throw new Error(`config: ${field} must not be empty`);
  return list;
}

function contextWorkspace(value: unknown): ContextWorkspaceConfig {
  if (!isRecord(value)) throw new Error("config: contextWorkspace must be an object");
  return {
    prepare: command(value.prepare, "contextWorkspace.prepare"),
    remove: value.remove === undefined ? [] : stringList(value.remove, "contextWorkspace.remove"),
  };
}

function skills(value: unknown): SkillConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("config: skills must be a list");
  return value.map((skill, index) => {
    if (!isRecord(skill)) throw new Error(`config: skills[${index}] must be an object`);
    return {
      id: text(skill, "id"),
      name: text(skill, "name"),
      description: text(skill, "description"),
      tags: skill.tags === undefined ? [] : stringList(skill.tags, `skills[${index}].tags`),
      examples: skill.examples === undefined ? [] : stringList(skill.examples, `skills[${index}].examples`),
    };
  });
}
