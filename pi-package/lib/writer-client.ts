import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { git, runGit } from "./git.ts";
import { mirrorPath, type WriterConfig, type WriterRepository } from "./writer-config.ts";

export interface PullRequestSummary {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  title: string;
  head: string;
  base: string;
}

const REQUEST_TIMEOUT_MS = 120_000;

/** Calls the GitHub writer sidecar (ADR 0027). It holds no credentials: the sidecar does. */
export class WriterClient {
  readonly #url: string;
  readonly #fetch: typeof fetch;

  constructor(url: string, options: { fetch?: typeof fetch } = {}) {
    this.#url = url.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
  }

  async sync(repository: Pick<WriterRepository, "owner" | "name">): Promise<{ defaultBranch: string; head: string }> {
    return (await this.#call("POST", `${repoPath(repository)}/sync`)) as { defaultBranch: string; head: string };
  }

  async push(repository: Pick<WriterRepository, "owner" | "name">, branch: string, bundle: Uint8Array<ArrayBuffer>): Promise<{ branch: string; sha: string; result: "pushed" | "unchanged" }> {
    return (await this.#call("POST", `${repoPath(repository)}/push?${new URLSearchParams({ branch })}`, bundle, "application/x-git-bundle")) as {
      branch: string;
      sha: string;
      result: "pushed" | "unchanged";
    };
  }

  async pullRequest(
    repository: Pick<WriterRepository, "owner" | "name">,
    input: { branch: string; title?: string; body?: string },
  ): Promise<{ created: boolean; pull: PullRequestSummary }> {
    return (await this.#call("POST", `${repoPath(repository)}/pulls`, JSON.stringify(input), "application/json")) as {
      created: boolean;
      pull: PullRequestSummary;
    };
  }

  /** The branch's latest pull request, or `undefined` if it never had one. */
  async latestPullRequest(repository: Pick<WriterRepository, "owner" | "name">, branch: string): Promise<PullRequestSummary | undefined> {
    const response = await this.#request("GET", `${repoPath(repository)}/pulls?${new URLSearchParams({ branch })}`);
    if (response.status === 404) return undefined;
    return ((await answer(response)) as { pull: PullRequestSummary }).pull;
  }

  async #call(method: string, path: string, body?: Uint8Array<ArrayBuffer> | string, contentType?: string): Promise<unknown> {
    return answer(await this.#request(method, path, body, contentType));
  }

  async #request(method: string, path: string, body?: Uint8Array<ArrayBuffer> | string, contentType?: string): Promise<Response> {
    try {
      return await this.#fetch(`${this.#url}${path}`, {
        method,
        ...(contentType ? { headers: { "content-type": contentType } } : {}),
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`The GitHub writer is not reachable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function answer(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = (body as { error?: unknown } | undefined)?.error;
    throw new Error(typeof error === "string" ? error : `The GitHub writer answered HTTP ${response.status}.`);
  }
  return body;
}

function repoPath(repository: Pick<WriterRepository, "owner" | "name">): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

/** The URL of the sidecar in the pod. */
export function writerUrl(config: WriterConfig): string {
  return `http://127.0.0.1:${config.port}`;
}

/** The repository whose mirror the clone at `cwd` was made from (its `origin`). */
export async function repositoryOf(config: WriterConfig, cwd: string): Promise<WriterRepository> {
  const origin = await runGit(cwd, ["remote", "get-url", "origin"]);
  const notAClone = `${cwd} is not a clone of a github-writer mirror. Clone one with git clone file://${config.mirrorDir}/<owner>/<name>.git, and work there.`;
  if (origin.code !== 0 || origin.stdout === "") throw new Error(notAClone);
  let path = origin.stdout;
  if (path.startsWith("file://")) path = fileURLToPath(path);
  const found = config.repositories.find((repository) => resolve(cwd, path).replace(/\/+$/, "") === mirrorPath(config, repository));
  if (!found) throw new Error(notAClone);
  return found;
}

/** Checks the clone, brings its `origin` up to date through the sidecar, and returns the branch to push. */
async function prepare(config: WriterConfig, client: WriterClient, cwd: string): Promise<{ repository: WriterRepository; branch: string }> {
  const repository = await repositoryOf(config, cwd);
  const current = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (current.code !== 0 || current.stdout === "") throw new Error("HEAD is detached. Switch to the branch to push first.");
  const branch = current.stdout;
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  if (status !== "") throw new Error(`There are uncommitted changes. Commit them first:\n${status}`);
  await client.sync(repository);
  await git(cwd, ["fetch", "--quiet", "--prune", "origin"]);
  return { repository, branch };
}

async function pushBranch(client: WriterClient, cwd: string, repository: WriterRepository, branch: string): Promise<"pushed" | "unchanged"> {
  const base = `origin/${repository.defaultBranch}`;
  const ahead = Number(await git(cwd, ["rev-list", "--count", `${base}..HEAD`]));
  if (ahead === 0) throw new Error(`Nothing to push: ${branch} has no commits that ${base} does not have. Commit your changes first.`);
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const remote = await runGit(cwd, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`]);
  if (remote.code === 0 && remote.stdout === head) return "unchanged";
  const dir = mkdtempSync(join(tmpdir(), "github-writer-bundle-"));
  try {
    const file = join(dir, "push.bundle");
    // Only what the mirror does not have yet: the sidecar has everything under origin.
    await git(cwd, ["bundle", "create", "--quiet", file, `refs/heads/${branch}`, "--not", "--remotes=origin"]);
    const result = await client.push(repository, branch, readFileSync(file));
    await git(cwd, ["update-ref", `refs/remotes/origin/${branch}`, result.sha]);
    return result.result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Pushes the current branch of the clone at `cwd` through the sidecar. */
export async function pushWorkspace(config: WriterConfig, client: WriterClient, cwd: string): Promise<string> {
  const { repository, branch } = await prepare(config, client, cwd);
  const result = await pushBranch(client, cwd, repository, branch);
  const where = `${repository.owner}/${repository.name}`;
  return result === "unchanged" ? `The branch ${branch} of ${where} on GitHub is already up to date.` : `Pushed ${branch} to ${where}.`;
}

/** Pushes the current branch and opens its pull request, or updates the open one it has. */
export async function pullRequestWorkspace(
  config: WriterConfig,
  client: WriterClient,
  cwd: string,
  input: { title?: string; body?: string },
): Promise<string> {
  const { repository, branch } = await prepare(config, client, cwd);
  await pushBranch(client, cwd, repository, branch);
  const { created, pull } = await client.pullRequest(repository, { branch, ...input });
  if (created) return `Opened pull request #${pull.number}: ${pull.url}`;
  return `Pull request #${pull.number} (${pull.url}) now has the latest commits of ${branch}.`;
}

/** Brings the mirror of one repository (`owner/name`), or of every repository, up to date with GitHub. */
export async function syncMirrors(config: WriterConfig, client: WriterClient, name?: string): Promise<string> {
  const repositories =
    name === undefined
      ? config.repositories
      : config.repositories.filter((repository) => `${repository.owner}/${repository.name}`.toLowerCase() === name.toLowerCase());
  if (repositories.length === 0) {
    throw new Error(`${name} is not one of the repositories: ${config.repositories.map((r) => `${r.owner}/${r.name}`).join(", ")}.`);
  }
  const lines: string[] = [];
  for (const repository of repositories) {
    const { defaultBranch, head } = await client.sync(repository);
    lines.push(
      `${repository.owner}/${repository.name}: the mirror file://${mirrorPath(config, repository)} is up to date (${defaultBranch} at ${head.slice(0, 12)}). Run git fetch origin in its clones.`,
    );
  }
  return lines.join("\n");
}
