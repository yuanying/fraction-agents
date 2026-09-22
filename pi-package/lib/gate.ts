import { existsSync } from "node:fs";

import type { GateConfig } from "./config.ts";
import { authEnv, git, runGit } from "./git.ts";
import type { GitHubClient, PullRequest } from "./github.ts";
import { checkChanges, onlyMechanical, type Change } from "./rules.ts";
import { recordContextBranch } from "./workspace.ts";

export interface GateOptions {
  config: GateConfig;
  github: GitHubClient;
  /** The context's worktree. */
  cwd: string;
  /** Who called, as the host passed it (`FRACTION_AGENTS_CALLER`). */
  caller: string;
}

/** A refusal the agent can act on. Its message is written for the model. */
export class GateError extends Error {}

/**
 * The only way the agent writes to GitHub (ADR 0009): push the context's branch, open or update the context's
 * one pull request, and merge it for callers allowed to merge. Every push is checked against the path rules on
 * the whole branch, and never goes to the default branch.
 */
export class Gate {
  readonly #config: GateConfig;
  readonly #github: GitHubClient;
  readonly #cwd: string;
  readonly #caller: string;

  constructor(options: GateOptions) {
    this.#config = options.config;
    this.#github = options.github;
    this.#cwd = options.cwd;
    this.#caller = options.caller;
  }

  get canMerge(): boolean {
    return this.#config.mergeCallers.includes(this.#caller);
  }

  /** Pushes the context's branch. */
  async push(): Promise<string> {
    const { branch, note } = await this.#prepareBranch();
    const pushed = await this.#pushBranch(branch);
    if (pushed === "unchanged") return join(note, `The branch ${branch} on GitHub is already up to date.`);
    return join(note, `Pushed ${branch}.`);
  }

  /** Pushes the context's branch and opens its pull request, or updates the one it has. */
  async pullRequest(input: { title?: string; body?: string }): Promise<string> {
    const { branch, note } = await this.#prepareBranch();
    await this.#pushBranch(branch);
    const existing = await this.#openPullRequest(branch);
    if (existing) {
      const updated =
        input.title !== undefined || input.body !== undefined
          ? await this.#github.updatePullRequest(existing.number, {
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.body !== undefined ? { body: input.body } : {}),
            })
          : existing;
      return join(note, `Pull request #${updated.number} (${updated.url}) now has the latest commits of ${branch}.`);
    }
    if (input.title === undefined || input.title.trim() === "") {
      throw new GateError("A new pull request needs a title. Call github_pull_request again with a title and a body.");
    }
    const created = await this.#github.createPullRequest({
      title: input.title,
      body: input.body ?? "",
      head: branch,
      base: this.#config.repository.defaultBranch,
    });
    await this.#setBranchConfig(branch, "agentPullRequest", String(created.number));
    return join(note, `Opened pull request #${created.number}: ${created.url}`);
  }

  /**
   * Merges the context's pull request after taking in the latest default branch. Conflicts only in the files the
   * agent may resolve are left for it to resolve (then it calls again); any other conflict stops the merge.
   */
  async merge(): Promise<string> {
    if (!this.canMerge) throw new GateError("This caller may not merge. Leave the pull request open for the owner to review.");
    const branch = await this.#currentBranch();
    const pull = await this.#openPullRequest(branch);
    if (!pull) {
      throw new GateError(`${branch} has no open pull request. Open one with github_pull_request first.`);
    }
    await this.#fetch();
    const base = `origin/${this.#config.repository.defaultBranch}`;
    if (existsSync(await this.#gitPath("MERGE_HEAD"))) {
      const conflicts = await this.#conflicts();
      if (conflicts.length > 0) {
        throw new GateError(`The merge of ${base} still has conflicts in: ${conflicts.join(", ")}. Resolve them, git add them, and call github_merge again.`);
      }
      await git(this.#cwd, ["commit", "--quiet", "--no-edit"]);
    } else {
      await this.#requireClean();
      const upToDate = (await runGit(this.#cwd, ["merge-base", "--is-ancestor", base, "HEAD"])).code === 0;
      if (!upToDate) {
        const merged = await runGit(this.#cwd, ["merge", "--no-edit", "--no-ff", base]);
        if (merged.code !== 0) {
          const conflicts = await this.#conflicts();
          if (conflicts.length > 0 && onlyMechanical(conflicts, this.#config)) {
            return [
              `Taking in the latest ${base} conflicted in: ${conflicts.join(", ")}.`,
              "These files may be resolved here: keep the entries of both sides in the order the file's rules ask for,",
              "remove the conflict markers, git add the files, and call github_merge again. Do not commit; github_merge does.",
            ].join(" ");
          }
          await runGit(this.#cwd, ["merge", "--abort"]);
          if (conflicts.length === 0) throw new GateError(`Taking in ${base} failed: ${merged.stderr || merged.stdout}`);
          throw new GateError(
            `Not merged: taking in the latest ${base} conflicts in ${conflicts.join(", ")}, which may not be resolved without the caller. ` +
              "The branch is as it was. Ask the caller how to resolve it.",
          );
        }
      }
    }
    await this.#pushBranch(branch);
    const head = await git(this.#cwd, ["rev-parse", "HEAD"]);
    const result = await this.#github.mergePullRequest(pull.number, { sha: head, method: this.#config.mergeMethod });
    if (!result.merged) throw new GateError(`GitHub did not merge pull request #${pull.number}: ${result.message}`);
    return `Merged pull request #${pull.number} (${pull.url}) into ${this.#config.repository.defaultBranch}.`;
  }

  /** Checks the branch and the tree, fetches, and moves to a new branch if the last pull request is finished. */
  async #prepareBranch(): Promise<{ branch: string; note: string }> {
    const branch = await this.#currentBranch();
    await this.#requireClean();
    await this.#fetch();
    return this.#rotateIfFinished(branch);
  }

  async #currentBranch(): Promise<string> {
    const current = await runGit(this.#cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (current.code !== 0 || current.stdout === "") {
      throw new GateError("HEAD is detached. Switch back to the context's branch before pushing.");
    }
    const branch = current.stdout;
    if (branch === this.#config.repository.defaultBranch) {
      throw new GateError(`Pushing the default branch (${branch}) is not allowed. Work on the context's branch.`);
    }
    if (!branch.startsWith(this.#config.branchPrefix)) {
      throw new GateError(`Only branches starting with ${this.#config.branchPrefix} may be pushed; ${branch} does not.`);
    }
    return branch;
  }

  async #requireClean(): Promise<void> {
    if (existsSync(await this.#gitPath("MERGE_HEAD"))) {
      throw new GateError("A merge is in progress. Finish it (github_merge) or abort it (git merge --abort) first.");
    }
    const status = await git(this.#cwd, ["status", "--porcelain", "--untracked-files=no"]);
    if (status !== "") throw new GateError(`There are uncommitted changes. Commit them first:\n${status}`);
  }

  async #fetch(): Promise<void> {
    await git(this.#cwd, ["fetch", "--quiet", "--prune", "origin"], await authEnv(this.#github, this.#config.repository.remoteUrl));
  }

  /**
   * A merged or closed pull request is finished: new work goes on a new branch from the latest default branch,
   * taking along only the commits made after the last push, and gets a new pull request.
   */
  async #rotateIfFinished(branch: string): Promise<{ branch: string; note: string }> {
    const recorded = await this.#branchConfig(branch, "agentPullRequest");
    if (recorded === undefined) return { branch, note: "" };
    const pull = await this.#github.getPullRequest(Number(recorded));
    if (pull.state === "open") return { branch, note: "" };
    const contextId = await this.#branchConfig(branch, "agentContext");
    const stem = contextId !== undefined ? `${this.#config.branchPrefix}${contextId}` : branch;
    let next = "";
    for (let n = 2; ; n++) {
      next = `${stem}-${n}`;
      const local = await runGit(this.#cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${next}`]);
      const remote = await runGit(this.#cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${next}`]);
      if (local.code !== 0 && remote.code !== 0) break;
    }
    const pushed = (await this.#branchConfig(branch, "agentPushed")) ?? "HEAD";
    const base = `origin/${this.#config.repository.defaultBranch}`;
    await git(this.#cwd, ["switch", "--quiet", "-c", next]);
    const rebased = await runGit(this.#cwd, ["rebase", "--quiet", "--onto", base, pushed]);
    if (rebased.code !== 0) {
      await runGit(this.#cwd, ["rebase", "--abort"]);
      await git(this.#cwd, ["switch", "--quiet", branch]);
      await runGit(this.#cwd, ["branch", "--quiet", "-D", next]);
      throw new GateError(
        `Pull request #${pull.number} is ${pull.merged ? "merged" : "closed"}, and the commits made since do not apply to the latest ${base}. Ask the caller how to go on.`,
      );
    }
    if (contextId !== undefined) await recordContextBranch(this.#config, contextId, next);
    const how = pull.merged ? "merged" : "closed";
    return { branch: next, note: `Pull request #${pull.number} was ${how}, so this work goes on a new branch, ${next}.` };
  }

  /** Checks the whole branch against the path rules and pushes it. Never forces. */
  async #pushBranch(branch: string): Promise<"pushed" | "unchanged"> {
    const base = `origin/${this.#config.repository.defaultBranch}`;
    const ahead = Number(await git(this.#cwd, ["rev-list", "--count", `${base}..HEAD`]));
    if (ahead === 0) throw new GateError(`Nothing to push: ${branch} has no commits that ${base} does not have. Commit your changes first.`);
    const diff = await git(this.#cwd, ["diff", "--name-status", "--no-renames", `${base}...HEAD`]);
    const changes: Change[] = diff
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status = "", ...rest] = line.split("\t");
        return { status, path: rest.join("\t") };
      });
    const problems = checkChanges(changes, this.#config);
    if (problems.length > 0) {
      throw new GateError(`Not pushed. The branch changes files it may not:\n${problems.join("\n")}\nUndo these changes in new commits (or rewrite the unpushed ones) and try again.`);
    }
    const head = await git(this.#cwd, ["rev-parse", "HEAD"]);
    const remote = await runGit(this.#cwd, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`]);
    if (remote.code === 0 && remote.stdout === head) {
      await this.#setBranchConfig(branch, "agentPushed", head);
      return "unchanged";
    }
    const pushed = await runGit(
      this.#cwd,
      ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`],
      await authEnv(this.#github, this.#config.repository.remoteUrl),
    );
    if (pushed.code !== 0) throw new GateError(`git push failed: ${pushed.stderr || pushed.stdout}`);
    await git(this.#cwd, ["update-ref", `refs/remotes/origin/${branch}`, head]);
    await this.#setBranchConfig(branch, "agentPushed", head);
    return "pushed";
  }

  /** The branch's open pull request: the recorded one, or one found on GitHub. */
  async #openPullRequest(branch: string): Promise<PullRequest | undefined> {
    const recorded = await this.#branchConfig(branch, "agentPullRequest");
    if (recorded !== undefined) {
      const pull = await this.#github.getPullRequest(Number(recorded));
      if (pull.state === "open") return pull;
    }
    const found = await this.#github.findPullRequest(branch);
    if (found) await this.#setBranchConfig(branch, "agentPullRequest", String(found.number));
    return found;
  }

  async #conflicts(): Promise<string[]> {
    return (await git(this.#cwd, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
  }

  async #gitPath(name: string): Promise<string> {
    return git(this.#cwd, ["rev-parse", "--path-format=absolute", "--git-path", name]);
  }

  async #branchConfig(branch: string, key: string): Promise<string | undefined> {
    const result = await runGit(this.#cwd, ["config", "--get", `branch.${branch}.${key}`]);
    return result.code === 0 && result.stdout !== "" ? result.stdout : undefined;
  }

  async #setBranchConfig(branch: string, key: string, value: string): Promise<void> {
    await git(this.#cwd, ["config", `branch.${branch}.${key}`, value]);
  }
}

function join(note: string, message: string): string {
  return note === "" ? message : `${note}\n${message}`;
}
