import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { git, runGit } from "./git.ts";
import { checkContextId } from "./workspace.ts";
import { findRepository, mirrorPath, type WriterConfig, type WriterRepository, type WriterWorkspace } from "./writer-config.ts";

// The context's workspace with the GitHub writer (ADR 0028). Like the GitHub gate's (ADR 0009), a persistent clone
// of each repository lives on the volume and every context works on worktrees of it; here the clones follow the
// sidecar's read-only mirrors, so they need no credentials. The context's directory holds one worktree per
// repository, at <owner>/<name>, so that the agent can clone other repositories beside them. Only the repositories
// of `workspace.repositories` are made ready with the context; the agent adds a worktree of another when it is to
// change it (ADR 0028, the fixes), so that a context does not check out every repository the writer may write to.

function settings(config: WriterConfig): WriterWorkspace {
  if (!config.workspace) throw new Error("github-writer.json has no workspace (cloneDir and commitIdentity), so contexts get no worktrees.");
  return config.workspace;
}

function clonePath(workspace: WriterWorkspace, repository: WriterRepository): string {
  return join(workspace.cloneDir, repository.owner, `${repository.name}.git`);
}

/** Where the repository's worktree is in the context's directory. */
export function worktreePath(dir: string, repository: WriterRepository): string {
  return join(dir, repository.owner, repository.name);
}

/** Makes sure the persistent bare clone of the mirror exists and has what the mirror has. */
async function ensureClone(config: WriterConfig, workspace: WriterWorkspace, repository: WriterRepository): Promise<string> {
  const mirror = mirrorPath(config, repository);
  if (!existsSync(join(mirror, "HEAD"))) {
    throw new Error(`The mirror ${mirror} of ${repository.owner}/${repository.name} is not there yet; the GitHub writer makes it when it starts. Try again shortly.`);
  }
  const clone = clonePath(workspace, repository);
  if (!existsSync(join(clone, "HEAD"))) {
    mkdirSync(dirname(clone), { recursive: true });
    await git(dirname(clone), ["init", "--quiet", "--bare", clone]);
    await git(clone, ["remote", "add", "origin", pathToFileURL(mirror).href]);
    await git(clone, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  }
  await git(clone, ["remote", "set-url", "origin", pathToFileURL(mirror).href]);
  await git(clone, ["config", "user.name", workspace.commitIdentity.name]);
  await git(clone, ["config", "user.email", workspace.commitIdentity.email]);
  await git(clone, ["fetch", "--quiet", "--prune", "origin"]);
  await git(clone, ["worktree", "prune"]);
  return clone;
}

/** Whether `dir` is the root of a worktree of `clone` (and not, say, a clone of the repository made from GitHub). */
async function isWorktreeOf(dir: string, clone: string): Promise<boolean> {
  if (!existsSync(join(dir, ".git"))) return false;
  const top = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || top.stdout !== realpathSync(dir)) return false;
  const common = await runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common.code === 0 && common.stdout === realpathSync(clone);
}

/**
 * Makes the context's worktree of the repository, or keeps the one that is there. A lost one is made again on the
 * context's branch, or on a new branch from the latest default branch.
 */
async function ensureWorktree(config: WriterConfig, workspace: WriterWorkspace, dir: string, contextId: string, repository: WriterRepository): Promise<string> {
  const clone = await ensureClone(config, workspace, repository);
  const worktree = worktreePath(dir, repository);
  if (await isWorktreeOf(worktree, clone)) return worktree;
  rmSync(worktree, { recursive: true, force: true });
  await git(clone, ["worktree", "prune"]);
  mkdirSync(dirname(worktree), { recursive: true });
  const branch = `${repository.branchPrefix}${contextId}`;
  const exists = (await runGit(clone, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  if (exists) {
    await git(clone, ["worktree", "add", "--quiet", worktree, branch]);
  } else {
    await git(clone, ["worktree", "add", "--quiet", "--no-track", "-b", branch, worktree, `origin/${repository.defaultBranch}`]);
  }
  return worktree;
}

/**
 * Readies the context's directory: a worktree of each repository of `workspace.repositories` (of every repository
 * when it is left out). A worktree that is there is left as it is, so a context picks up where it stopped.
 */
export async function prepareWriterWorkspace(options: { config: WriterConfig; dir: string; contextId: string }): Promise<void> {
  const { config, dir } = options;
  const workspace = settings(config);
  const contextId = checkContextId(options.contextId);
  mkdirSync(dir, { recursive: true });
  const repositories =
    workspace.repositories === undefined ? config.repositories : workspace.repositories.map((name) => findRepository(config, name)!);
  for (const repository of repositories) await ensureWorktree(config, workspace, dir, contextId, repository);
}

/**
 * Adds the context's worktree of one more of the writer's repositories (`owner/name`), at <owner>/<name> in the
 * context's directory, the same way as those made with the context. Returns where it is.
 */
export async function addWriterWorktree(options: { config: WriterConfig; dir: string; contextId: string; repository: string }): Promise<string> {
  const { config, dir } = options;
  const workspace = settings(config);
  const contextId = checkContextId(options.contextId);
  const repository = findRepository(config, options.repository);
  if (!repository) {
    throw new Error(`${options.repository} is not one of the repositories: ${config.repositories.map((r) => `${r.owner}/${r.name}`).join(", ")}.`);
  }
  mkdirSync(dir, { recursive: true });
  return ensureWorktree(config, workspace, dir, contextId, repository);
}

/** Removes the context's worktrees and its local branches. What was pushed stays on GitHub. */
export async function removeWriterWorkspace(options: { config: WriterConfig; dir: string; contextId?: string }): Promise<void> {
  const { config, dir } = options;
  const workspace = settings(config);
  const contextId = checkContextId(options.contextId ?? basename(dir));
  for (const repository of config.repositories) {
    const clone = clonePath(workspace, repository);
    if (!existsSync(join(clone, "HEAD"))) continue;
    await runGit(clone, ["worktree", "remove", "--force", worktreePath(dir, repository)]);
    await git(clone, ["worktree", "prune"]);
    const prefix = `refs/heads/${repository.branchPrefix}${contextId}`;
    const refs = await git(clone, ["for-each-ref", "--format=%(refname:short)", prefix, `${prefix}-*`]);
    for (const branch of refs.split("\n").filter(Boolean)) await runGit(clone, ["branch", "--quiet", "-D", branch]);
  }
  rmSync(dir, { recursive: true, force: true });
}
