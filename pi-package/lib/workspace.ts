import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";

import type { GateConfig } from "./config.ts";
import { authEnv, git, runGit } from "./git.ts";
import type { GitHubClient } from "./github.ts";

/** Context IDs come from the host; still, only plain identifiers become branch names and paths. */
const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export function checkContextId(contextId: string): string {
  if (!CONTEXT_ID.test(contextId)) throw new Error(`not a usable context ID: ${JSON.stringify(contextId)}`);
  return contextId;
}

/** The branch a context works on: the first one is `<prefix><contextId>`, later ones are recorded in the clone. */
export async function contextBranch(config: GateConfig, contextId: string): Promise<string> {
  const recorded = await runGit(config.clone, ["config", "--get", `context.${contextId}.branch`]);
  return recorded.code === 0 && recorded.stdout !== "" ? recorded.stdout : `${config.branchPrefix}${contextId}`;
}

/** Records that the context now works on the branch. */
export async function recordContextBranch(config: GateConfig, contextId: string, branch: string): Promise<void> {
  await git(config.clone, ["config", `context.${contextId}.branch`, branch]);
  await git(config.clone, ["config", `branch.${branch}.agentContext`, contextId]);
}

/**
 * Makes sure the persistent clone exists and is up to date. It is a bare repository: the contexts' worktrees are
 * the only checkouts, so no branch is ever held by the clone itself.
 */
async function ensureClone(config: GateConfig, github: GitHubClient): Promise<void> {
  const { clone, repository, commitIdentity } = config;
  if (!existsSync(`${clone}/HEAD`)) {
    mkdirSync(dirname(clone), { recursive: true });
    await git(dirname(clone), ["init", "--quiet", "--bare", clone]);
    await git(clone, ["remote", "add", "origin", repository.remoteUrl]);
    await git(clone, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  }
  await git(clone, ["remote", "set-url", "origin", repository.remoteUrl]);
  await git(clone, ["config", "user.name", commitIdentity.name]);
  await git(clone, ["config", "user.email", commitIdentity.email]);
  await git(clone, ["fetch", "--quiet", "--prune", "origin"], await authEnv(github, repository.remoteUrl));
  await git(clone, ["worktree", "prune"]);
}

async function isWorktreeRoot(dir: string): Promise<boolean> {
  if (!existsSync(`${dir}/.git`)) return false;
  const top = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  return top.code === 0 && top.stdout === realpathSync(dir);
}

/**
 * Readies `dir` as the context's worktree. An existing worktree is left as it is, so a context picks up where it
 * stopped. A lost one is made again on the context's branch, or on a new branch from the latest default branch.
 */
export async function prepareWorkspace(options: {
  config: GateConfig;
  github: GitHubClient;
  dir: string;
  contextId: string;
}): Promise<void> {
  const { config, github, dir } = options;
  const contextId = checkContextId(options.contextId);
  await ensureClone(config, github);
  if (await isWorktreeRoot(dir)) return;
  rmSync(dir, { recursive: true, force: true });
  await git(config.clone, ["worktree", "prune"]);
  mkdirSync(dirname(dir), { recursive: true });
  const branch = await contextBranch(config, contextId);
  const exists = (await runGit(config.clone, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  if (exists) {
    await git(config.clone, ["worktree", "add", "--quiet", dir, branch]);
  } else {
    await git(config.clone, ["worktree", "add", "--quiet", "--no-track", "-b", branch, dir, `origin/${config.repository.defaultBranch}`]);
  }
  await recordContextBranch(config, contextId, branch);
}

/** Removes the context's worktree and its local branches. What was pushed stays on the remote. */
export async function removeWorkspace(options: { config: GateConfig; dir: string; contextId?: string }): Promise<void> {
  const { config, dir } = options;
  const contextId = checkContextId(options.contextId ?? basename(dir));
  if (!existsSync(`${config.clone}/HEAD`)) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  await runGit(config.clone, ["worktree", "remove", "--force", dir]);
  rmSync(dir, { recursive: true, force: true });
  await git(config.clone, ["worktree", "prune"]);
  const refs = await git(config.clone, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${config.branchPrefix}${contextId}`, `refs/heads/${config.branchPrefix}${contextId}-*`]);
  for (const branch of refs.split("\n").filter(Boolean)) {
    await runGit(config.clone, ["branch", "--quiet", "-D", branch]);
    await runGit(config.clone, ["config", "--remove-section", `branch.${branch}`]);
  }
  await runGit(config.clone, ["config", "--remove-section", `context.${contextId}`]);
}
