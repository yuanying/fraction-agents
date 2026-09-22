// A local stand-in for GitHub: a bare repository as the remote, and an in-memory pull request API that merges
// by moving the bare repository's default branch.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseGateConfig, type GateConfig } from "../../lib/config.ts";
import type { GitHubClient, PullRequest } from "../../lib/github.ts";

export const FAKE_TOKEN = "ghs_FAKEinstallationTOKEN0123456789";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Owner", GIT_AUTHOR_EMAIL: "owner@example.test", GIT_COMMITTER_NAME: "Owner", GIT_COMMITTER_EMAIL: "owner@example.test" },
  }).trim();
}

export function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export interface Fixture {
  dir: string;
  remote: string;
  config: GateConfig;
  github: FakeGitHub;
  /** Commits to the remote's default branch directly, as if someone else merged a PR. */
  commitToMain(files: Record<string, string>, message: string): void;
}

const INDEX = "# Wiki インデックス\n\n## Topics\n- [[topics/a]] — A\n";
const LOG = "# Log\n\n## [2026-09-01] ingest | A\n";

export function makeFixture(overrides: Record<string, unknown> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "fraction-agents-gate-"));
  const remote = join(dir, "origin.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote]);
  const seed = join(dir, "seed");
  execFileSync("git", ["clone", "-q", remote, seed]);
  write(seed, "raw/clips/old.md", "an old clip\n");
  write(seed, "Permanent-Notes/note.md", "a permanent note\n");
  write(seed, "wiki/index.md", INDEX);
  write(seed, "wiki/log.md", LOG);
  write(seed, "wiki/topics/a.md", "# A\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "HEAD:main");

  const config = parseGateConfig({
    repository: { owner: "example", name: "wiki", remoteUrl: `file://${remote}` },
    app: { appId: "1", installationId: "2", privateKeyFile: join(dir, "no-key.pem") },
    clone: join(dir, "clone"),
    branchPrefix: "wiki-keeper/",
    commitIdentity: { name: "wiki-keeper[bot]", email: "bot@example.test" },
    appendOnlyPaths: ["raw/"],
    readOnlyPaths: ["Permanent-Notes/"],
    mechanicalConflictPaths: ["wiki/index.md", "wiki/log.md"],
    mergeCallers: ["system:serviceaccount:fraction-agents:owner", "system:serviceaccount:fraction-agents:claude"],
    ...overrides,
  });
  const github = new FakeGitHub(remote);
  return {
    dir,
    remote,
    config,
    github,
    commitToMain(files, message) {
      git(seed, "pull", "-q", "origin", "main");
      for (const [path, content] of Object.entries(files)) write(seed, path, content);
      git(seed, "add", ".");
      git(seed, "commit", "-q", "-m", message);
      git(seed, "push", "-q", "origin", "HEAD:main");
    },
  };
}

/** Every file under the directory, recursively. */
export function allFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) out.push(...allFiles(path));
    else out.push(path);
  }
  return out;
}

export function containsInFiles(root: string, needle: string): string[] {
  return allFiles(root).filter((path) => readFileSync(path).includes(needle));
}

export class FakeGitHub implements GitHubClient {
  readonly pulls: PullRequest[] = [];
  readonly merges: { number: number; sha: string; method: string }[] = [];
  tokensIssued = 0;
  readonly #remote: string;

  constructor(remote: string) {
    this.#remote = remote;
  }

  async gitAuthorization(): Promise<string> {
    this.tokensIssued++;
    return `Basic ${Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString("base64")}`;
  }

  async findPullRequest(head: string): Promise<PullRequest | undefined> {
    return this.pulls.find((pull) => pull.head === head && pull.state === "open");
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    const pull = this.pulls.find((candidate) => candidate.number === number);
    if (!pull) throw new Error(`no pull request #${number}`);
    return { ...pull };
  }

  async createPullRequest(input: { title: string; body: string; head: string; base: string }): Promise<PullRequest> {
    const pull: PullRequest = {
      number: this.pulls.length + 1,
      url: `https://github.example.test/example/wiki/pull/${this.pulls.length + 1}`,
      state: "open",
      merged: false,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
    };
    this.pulls.push(pull);
    return { ...pull };
  }

  async updatePullRequest(number: number, input: { title?: string; body?: string }): Promise<PullRequest> {
    const pull = this.pulls.find((candidate) => candidate.number === number)!;
    if (input.title !== undefined) pull.title = input.title;
    if (input.body !== undefined) pull.body = input.body;
    return { ...pull };
  }

  async mergePullRequest(number: number, input: { sha: string; method: string }): Promise<{ merged: boolean; message: string }> {
    const pull = this.pulls.find((candidate) => candidate.number === number)!;
    const head = execFileSync("git", ["rev-parse", `refs/heads/${pull.head}`], { cwd: this.#remote, encoding: "utf8" }).trim();
    if (head !== input.sha) return { merged: false, message: "Head branch was modified" };
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", "refs/heads/main", head], { cwd: this.#remote });
    } catch {
      return { merged: false, message: "Pull Request is not mergeable" };
    }
    execFileSync("git", ["update-ref", "refs/heads/main", head], { cwd: this.#remote });
    pull.state = "closed";
    pull.merged = true;
    this.merges.push({ number, sha: input.sha, method: input.method });
    return { merged: true, message: "Pull Request successfully merged" };
  }

  close(number: number): void {
    this.pulls.find((candidate) => candidate.number === number)!.state = "closed";
  }
}
