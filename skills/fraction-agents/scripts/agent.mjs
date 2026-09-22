#!/usr/bin/env node
// Runs the a2a CLI against a fraction-agents agent picked by name.
//
//   node agent.mjs --list
//   node agent.mjs <agent> <a2a arguments...>
//
// The agent's URL and the caller's token come from a local config file
// ($FRACTION_AGENTS_CLIENT_CONFIG, else $XDG_CONFIG_HOME/fraction-agents/agents.json,
// else ~/.config/fraction-agents/agents.json). They reach a2a only through the
// environment (A2ACLI_AGENT_CARD and A2ACLI_AUTH), never through its command line,
// and this script never prints the token.

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const usage = `usage: agent.mjs --list
       agent.mjs <agent> <a2a arguments...>   e.g. agent.mjs wiki-keeper send --async "..."`;

class UserError extends Error {
  constructor(message, status = 1) {
    super(message);
    this.status = status;
  }
}

function configPath() {
  if (process.env.FRACTION_AGENTS_CLIENT_CONFIG) return process.env.FRACTION_AGENTS_CLIENT_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "fraction-agents", "agents.json");
}

function expandPath(path, base) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}

function loadConfig() {
  const path = configPath();
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new UserError(`cannot read the agents config ${path}: ${error.code ?? error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new UserError(`the agents config ${path} is not valid JSON: ${error.message}`);
  }
  if (typeof raw !== "object" || raw === null || typeof raw.agents !== "object" || raw.agents === null) {
    throw new UserError(`the agents config ${path} needs an "agents" object`);
  }
  const base = dirname(path);
  const agents = new Map();
  for (const [name, entry] of Object.entries(raw.agents)) {
    if (typeof entry?.url !== "string" || !URL.canParse(entry.url)) {
      throw new UserError(`agent "${name}" in ${path} needs a "url" with an absolute URL`);
    }
    const tokenFile = entry.tokenFile ?? raw.tokenFile;
    agents.set(name, {
      url: entry.url,
      tokenFile: typeof tokenFile === "string" ? expandPath(tokenFile, base) : undefined,
    });
  }
  return { path, agents };
}

function readToken(name, agent, config) {
  if (!agent.tokenFile) {
    throw new UserError(`agent "${name}" has no "tokenFile" in ${config.path} (set it on the agent or at the top level)`);
  }
  let stat;
  try {
    stat = statSync(agent.tokenFile);
  } catch (error) {
    throw new UserError(`cannot read the token file ${agent.tokenFile}: ${error.code ?? error.message}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new UserError(
      `the token file ${agent.tokenFile} can be read by others; make it private with chmod 0600 and try again`,
    );
  }
  const token = readFileSync(agent.tokenFile, "utf8").trim();
  if (token === "") throw new UserError(`the token file ${agent.tokenFile} is empty`);
  return token;
}

function list(config) {
  const width = Math.max(0, ...[...config.agents.keys()].map((name) => name.length));
  for (const [name, agent] of config.agents) {
    process.stdout.write(`${name.padEnd(width)}  ${agent.url}\n`);
  }
}

function run(name, args, config) {
  const agent = config.agents.get(name);
  if (!agent) {
    const known = [...config.agents.keys()].join(", ") || "(none)";
    throw new UserError(`no agent named "${name}" in ${config.path}; known agents: ${known}`);
  }
  const token = readToken(name, agent, config);
  const child = spawn("a2a", args, {
    stdio: "inherit",
    env: { ...process.env, A2ACLI_AGENT_CARD: agent.url, A2ACLI_AUTH: `Bearer ${token}` },
  });
  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      process.stderr.write(
        "agent.mjs: the a2a command is not on PATH. Install a2a-cli v0.2.0 (see the fraction-agents README).\n",
      );
      process.exit(127);
    }
    process.stderr.write(`agent.mjs: cannot start a2a: ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

function main(argv) {
  if (argv[0] === "--list" && argv.length === 1) {
    list(loadConfig());
    return;
  }
  if (argv.length < 2 || argv[0].startsWith("-")) throw new UserError(usage, 2);
  const [name, ...args] = argv;
  run(name, args, loadConfig());
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UserError)) throw error;
  process.stderr.write(`agent.mjs: ${error.message}\n`);
  process.exit(error.status);
}
