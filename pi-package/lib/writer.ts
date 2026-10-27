import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { authEnv, git, runGit } from "./git.ts";
import type { GitHubClient, PullRequest } from "./github.ts";
import { checkChanges, underPath, type Change } from "./rules.ts";
import { mirrorPath, type WriterConfig, type WriterRepository } from "./writer-config.ts";

/** What the writer needs from GitHub for one repository. The real one is a `GitHubApp` for that repository. */
export type WriterGitHub = Pick<GitHubClient, "gitAuthorization" | "findPullRequest" | "createPullRequest" | "updatePullRequest"> & {
  latestPullRequest(head: string): Promise<PullRequest | undefined>;
};

/** A refusal or failure, with the HTTP status the sidecar answers with. Its message is written for the model. */
export class WriterError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PushResult {
  branch: string;
  sha: string;
  result: "pushed" | "unchanged";
}

/**
 * The GitHub writer (ADR 0027): the only holder of the App's key. It pushes branches other than the default
 * branch, fast-forward only, and opens or updates pull requests, for the repositories and within the rules of its
 * settings. Commits come in as bundles; git runs only in the writer's own mirrors, never in a repository the agent
 * can write to.
 */
export class GitHubWriter {
  readonly #config: WriterConfig;
  readonly #github: (repository: WriterRepository) => WriterGitHub;
  readonly #clients = new Map<WriterRepository, WriterGitHub>();
  readonly #locks = new Map<WriterRepository, Promise<unknown>>();

  constructor(options: { config: WriterConfig; github: (repository: WriterRepository) => WriterGitHub }) {
    this.#config = options.config;
    this.#github = options.github;
  }

  /** The repository of the settings, or a 404. */
  repository(owner: string, name: string): WriterRepository {
    const found = this.#config.repositories.find(
      (repository) => repository.owner.toLowerCase() === owner.toLowerCase() && repository.name.toLowerCase() === name.toLowerCase(),
    );
    if (!found) throw new WriterError(404, `${owner}/${name} is not a repository this writer may write to.`);
    return found;
  }

  /** Brings the repository's mirror up to date with GitHub. */
  async sync(repository: WriterRepository): Promise<{ defaultBranch: string; head: string }> {
    return this.#locked(repository, async () => {
      await this.#fetch(repository);
      const head = await runGit(mirrorPath(this.#config, repository), ["rev-parse", "--verify", "-q", `refs/heads/${repository.defaultBranch}`]);
      return { defaultBranch: repository.defaultBranch, head: head.stdout };
    });
  }

  /** Brings every mirror up to date, one after another. Failures are reported, not thrown. */
  async syncAll(log: (line: string) => void = console.error): Promise<void> {
    for (const repository of this.#config.repositories) {
      try {
        await this.sync(repository);
      } catch (error) {
        log(`github-writer: syncing ${repository.owner}/${repository.name} failed: ${message(error)}`);
      }
    }
  }

  /** Takes in the bundle, checks it against the rules, and pushes its one branch to GitHub. */
  async push(repository: WriterRepository, branch: string, bundle: Uint8Array): Promise<PushResult> {
    await this.#checkBranch(repository, branch);
    return this.#locked(repository, async () => {
      await this.#fetch(repository);
      const mirror = mirrorPath(this.#config, repository);
      const sha = await this.#takeIn(repository, branch, bundle);
      const base = `refs/heads/${repository.defaultBranch}`;
      const ahead = Number(await git(mirror, ["rev-list", "--count", `${base}..${sha}`]));
      if (ahead === 0) throw new WriterError(400, `Nothing to push: ${branch} has no commits that ${repository.defaultBranch} does not have.`);
      const diff = await runGit(mirror, ["diff", "--name-status", "--no-renames", `${base}...${sha}`]);
      if (diff.code !== 0) throw new WriterError(400, `${branch} shares no history with ${repository.defaultBranch}.`);
      const problems = checkRepositoryChanges(parseNameStatus(diff.stdout), repository);
      if (problems.length > 0) {
        throw new WriterError(403, `Not pushed. The branch changes files it may not:\n${problems.join("\n")}`);
      }
      const current = await runGit(mirror, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
      if (current.code === 0 && current.stdout === sha) return { branch, sha, result: "unchanged" };
      const pushed = await runGit(
        mirror,
        ["push", "--quiet", "--porcelain", "origin", `${sha}:refs/heads/${branch}`],
        await this.#auth(repository),
      );
      if (pushed.code !== 0) {
        const said = `${pushed.stdout}\n${pushed.stderr}`;
        if (/\[rejected\]|non-fast-forward|fetch first/.test(said)) {
          throw new WriterError(409, `GitHub rejected the push of ${branch}: it is not a fast-forward of the branch there. Push to a new branch instead.`);
        }
        throw new WriterError(502, `git push of ${branch} failed: ${said.trim()}`);
      }
      await git(mirror, ["update-ref", `refs/heads/${branch}`, sha]);
      return { branch, sha, result: "pushed" };
    });
  }

  /** Opens the branch's pull request against the default branch, or updates the open one it has. */
  async pullRequest(
    repository: WriterRepository,
    input: { branch: string; title?: string; body?: string },
  ): Promise<{ created: boolean; pull: PullRequest }> {
    await this.#checkBranch(repository, input.branch);
    const github = this.#client(repository);
    const existing = await this.#onGitHub(() => github.findPullRequest(input.branch));
    if (existing) {
      if (input.title === undefined && input.body === undefined) return { created: false, pull: existing };
      const pull = await this.#onGitHub(() =>
        github.updatePullRequest(existing.number, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
        }),
      );
      return { created: false, pull };
    }
    if (input.title === undefined || input.title.trim() === "") {
      throw new WriterError(400, "A new pull request needs a title.");
    }
    const pull = await this.#onGitHub(() =>
      github.createPullRequest({ title: input.title!, body: input.body ?? "", head: input.branch, base: repository.defaultBranch }),
    );
    return { created: true, pull };
  }

  /** The branch's most recent pull request, whatever its state. */
  async latestPullRequest(repository: WriterRepository, branch: string): Promise<PullRequest | undefined> {
    await this.#checkBranch(repository, branch);
    return this.#onGitHub(() => this.#client(repository).latestPullRequest(branch));
  }

  async #checkBranch(repository: WriterRepository, branch: string): Promise<void> {
    if (branch === repository.defaultBranch) {
      throw new WriterError(403, `The default branch (${branch}) may not be written to. Work on a branch starting with ${repository.branchPrefix}.`);
    }
    if (!branch.startsWith(repository.branchPrefix) || branch.length === repository.branchPrefix.length) {
      throw new WriterError(403, `Only branches starting with ${repository.branchPrefix} may be written to; ${branch} does not.`);
    }
    const valid = await runGit(tmpdir(), ["check-ref-format", `refs/heads/${branch}`]);
    if (valid.code !== 0) throw new WriterError(400, `${JSON.stringify(branch)} is not a valid branch name.`);
  }

  /** Fetches the bundle's one branch into the mirror and returns its commit. */
  async #takeIn(repository: WriterRepository, branch: string, bundle: Uint8Array): Promise<string> {
    const mirror = mirrorPath(this.#config, repository);
    const dir = mkdtempSync(join(tmpdir(), "github-writer-"));
    const file = join(dir, "push.bundle");
    const incoming = `refs/incoming/${randomUUID()}`;
    try {
      writeFileSync(file, bundle);
      const heads = await runGit(mirror, ["bundle", "list-heads", file]);
      if (heads.code !== 0) throw new WriterError(400, "The body is not a git bundle.");
      const refs = heads.stdout.split("\n").filter(Boolean).map((line) => line.split(" ")[1]);
      if (refs.length !== 1 || refs[0] !== `refs/heads/${branch}`) {
        throw new WriterError(400, `The bundle must hold exactly one ref, refs/heads/${branch}; it holds ${refs.join(", ") || "none"}.`);
      }
      const verified = await runGit(mirror, ["bundle", "verify", "--quiet", file]);
      if (verified.code !== 0) {
        throw new WriterError(400, `The bundle does not apply to the mirror of ${repository.owner}/${repository.name}: ${verified.stderr}`);
      }
      const fetched = await runGit(mirror, ["-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--no-tags", file, `refs/heads/${branch}:${incoming}`]);
      if (fetched.code !== 0) throw new WriterError(400, `The bundle could not be taken in: ${fetched.stderr}`);
      const sha = await git(mirror, ["rev-parse", incoming]);
      if ((await git(mirror, ["cat-file", "-t", sha])) !== "commit") throw new WriterError(400, `refs/heads/${branch} in the bundle is not a commit.`);
      return sha;
    } finally {
      await runGit(mirror, ["update-ref", "-d", incoming]);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Makes the mirror if it is missing, and fetches every branch from GitHub into it as is. */
  async #fetch(repository: WriterRepository): Promise<void> {
    const mirror = mirrorPath(this.#config, repository);
    if (!existsSync(join(mirror, "HEAD"))) {
      mkdirSync(dirname(mirror), { recursive: true });
      await git(dirname(mirror), ["init", "--quiet", "--bare", `--initial-branch=${repository.defaultBranch}`, mirror]);
      await git(mirror, ["remote", "add", "origin", repository.remoteUrl]);
    }
    await git(mirror, ["remote", "set-url", "origin", repository.remoteUrl]);
    const fetched = await runGit(
      mirror,
      ["fetch", "--quiet", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/heads/*"],
      await this.#auth(repository),
    );
    if (fetched.code !== 0) throw new WriterError(502, `Fetching ${repository.owner}/${repository.name} from GitHub failed: ${fetched.stderr}`);
  }

  /** The environment that lets one git command authenticate to the repository's remote. */
  async #auth(repository: WriterRepository): Promise<Record<string, string>> {
    try {
      return await authEnv(this.#client(repository), repository.remoteUrl);
    } catch (error) {
      throw new WriterError(502, `No GitHub token for ${repository.owner}/${repository.name}: ${message(error)}`);
    }
  }

  /** One client per repository: it keeps that repository's installation token in memory until it runs out. */
  #client(repository: WriterRepository): WriterGitHub {
    let client = this.#clients.get(repository);
    if (!client) {
      client = this.#github(repository);
      this.#clients.set(repository, client);
    }
    return client;
  }

  async #onGitHub<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof WriterError) throw error;
      throw new WriterError(502, message(error));
    }
  }

  /** Runs the git work on one repository's mirror one at a time. */
  async #locked<T>(repository: WriterRepository, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(repository) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#locks.set(repository, next);
    return next;
  }
}

/** The changes of `git diff --name-status --no-renames`. */
function parseNameStatus(output: string): Change[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });
}

/** What is wrong with the changes under the repository's path rules, one line per offending file. */
export function checkRepositoryChanges(changes: readonly Change[], repository: WriterRepository): string[] {
  const problems = checkChanges(changes, { ...repository, mechanicalConflictPaths: [] });
  if (repository.writablePaths.length > 0) {
    const allowed = repository.writablePaths.map((rule) => `${rule.replace(/\/+$/, "")}/`).join(", ");
    for (const { path } of changes) {
      if (!repository.writablePaths.some((rule) => underPath(path, rule))) problems.push(`${path}: only files under ${allowed} may be changed`);
    }
  }
  return problems;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
