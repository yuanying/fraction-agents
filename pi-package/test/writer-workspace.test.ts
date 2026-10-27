import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { repositoryOf } from "../lib/writer-client.ts";
import { mirrorPath, parseWriterConfig, type WriterConfig } from "../lib/writer-config.ts";
import { prepareWriterWorkspace, removeWriterWorkspace } from "../lib/writer-workspace.ts";
import { git, write } from "./fixtures/repo.ts";

const CLI = resolve(import.meta.dirname, "../bin/workspace.ts");
const CONTEXT = "vuln-src-yuanying-hshelf";
const run = promisify(execFile);

interface Setup {
  dir: string;
  config: WriterConfig;
  /** Stands in for the repository on GitHub, which the sidecar's mirror follows. */
  seed: string;
  /** Brings the mirror up to date with the seed, as the sidecar does. */
  sync(): void;
}

/** A mirror the way the sidecar keeps it, of a repository with one commit on main. */
function setUp(workspace: Record<string, unknown> | null = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), "fraction-agents-writer-workspace-"));
  const remote = join(dir, "infra.git");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  const seed = join(dir, "seed");
  execFileSync("git", ["clone", "--quiet", remote, seed], { stdio: "ignore" });
  write(seed, "security/vex/README.md", "vex\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const config = parseWriterConfig({
    mirrorDir: join(dir, "mirror"),
    app: { appId: "1", installationId: "2", privateKeyFile: join(dir, "no-key.pem") },
    repositories: [{ owner: "example", name: "infra", remoteUrl: `file://${remote}`, branchPrefix: "vuln-responder/", writablePaths: ["security/vex/"] }],
    ...(workspace === null
      ? {}
      : { workspace: { cloneDir: join(dir, "repos"), commitIdentity: { name: "vuln-responder[bot]", email: "bot@example.test" }, ...workspace } }),
  });
  const mirror = mirrorPath(config, config.repositories[0]!);
  mkdirSync(join(config.mirrorDir, "example"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", "--mirror", remote, mirror], { stdio: "ignore" });
  return {
    dir,
    config,
    seed,
    sync: () => void git(mirror, "fetch", "--quiet", "--prune", "origin"),
  };
}

function worktreeOf(setup: Setup, dir: string): string {
  return join(dir, "example", "infra");
}

describe("the context's workspace with the GitHub writer", () => {
  it("makes a worktree of each repository at <owner>/<name>, on the context's branch from the latest default branch", async () => {
    const setup = setUp();
    git(setup.seed, "commit", "-q", "--allow-empty", "-m", "newer");
    git(setup.seed, "push", "-q", "origin", "HEAD:main");
    setup.sync();
    const dir = join(setup.dir, "work", CONTEXT);
    await prepareWriterWorkspace({ config: setup.config, dir, contextId: CONTEXT });
    const worktree = worktreeOf(setup, dir);
    assert.equal(git(worktree, "branch", "--show-current"), `vuln-responder/${CONTEXT}`);
    assert.equal(git(worktree, "rev-parse", "HEAD"), git(setup.seed, "rev-parse", "HEAD"));
    assert.equal(git(worktree, "config", "user.name"), "vuln-responder[bot]");
    assert.equal(git(worktree, "config", "user.email"), "bot@example.test");
    // The persistent clone is on the volume, outside the context's directory.
    assert.ok(existsSync(join(setup.dir, "repos", "example", "infra.git", "HEAD")));
    // github_push and github_pull_request find the repository from the worktree's origin, the mirror.
    assert.equal((await repositoryOf(setup.config, worktree)).name, "infra");
  });

  it("keeps a worktree that is there, so a context picks up where it stopped", async () => {
    const setup = setUp();
    const dir = join(setup.dir, "work", CONTEXT);
    await prepareWriterWorkspace({ config: setup.config, dir, contextId: CONTEXT });
    const worktree = worktreeOf(setup, dir);
    write(worktree, "security/vex/a.openvex.json", "{}\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-q", "-m", "vex");
    const head = git(worktree, "rev-parse", "HEAD");
    writeFileSync(join(worktree, "notes.txt"), "unfinished\n");
    await prepareWriterWorkspace({ config: setup.config, dir, contextId: CONTEXT });
    assert.equal(git(worktree, "rev-parse", "HEAD"), head);
    assert.ok(existsSync(join(worktree, "notes.txt")));
  });

  it("makes a lost worktree again on the context's branch", async () => {
    const setup = setUp();
    const dir = join(setup.dir, "work", CONTEXT);
    await prepareWriterWorkspace({ config: setup.config, dir, contextId: CONTEXT });
    const worktree = worktreeOf(setup, dir);
    git(worktree, "commit", "-q", "--allow-empty", "-m", "work");
    const head = git(worktree, "rev-parse", "HEAD");
    rmSync(dir, { recursive: true, force: true });
    await prepareWriterWorkspace({ config: setup.config, dir, contextId: CONTEXT });
    assert.equal(git(worktree, "branch", "--show-current"), `vuln-responder/${CONTEXT}`);
    assert.equal(git(worktree, "rev-parse", "HEAD"), head);
  });

  it("removes the worktrees and the context's local branches", async () => {
    const setup = setUp();
    const dir = join(setup.dir, "work", CONTEXT);
    await prepareWriterWorkspace({ config: setup.config, dir, contextId: CONTEXT });
    const worktree = worktreeOf(setup, dir);
    // A later branch of the same context, after its first pull request was merged.
    git(worktree, "switch", "-q", "-c", `vuln-responder/${CONTEXT}-2`);
    const clone = join(setup.dir, "repos", "example", "infra.git");
    await removeWriterWorkspace({ config: setup.config, dir, contextId: CONTEXT });
    assert.equal(existsSync(dir), false);
    assert.equal(git(clone, "for-each-ref", "--format=%(refname:short)", "refs/heads/"), "");
    assert.equal(git(clone, "worktree", "list", "--porcelain").includes(dir), false);
  });

  it("says so when the mirror is not there yet", async () => {
    const setup = setUp();
    rmSync(setup.config.mirrorDir, { recursive: true, force: true });
    await assert.rejects(
      prepareWriterWorkspace({ config: setup.config, dir: join(setup.dir, "work", CONTEXT), contextId: CONTEXT }),
      /mirror .* is not there yet/,
    );
  });

  it("needs the workspace settings, and a plain context ID", async () => {
    const without = setUp(null);
    await assert.rejects(
      prepareWriterWorkspace({ config: without.config, dir: join(without.dir, "work", CONTEXT), contextId: CONTEXT }),
      /github-writer\.json has no workspace/,
    );
    const setup = setUp();
    await assert.rejects(prepareWriterWorkspace({ config: setup.config, dir: join(setup.dir, "work", "x"), contextId: "../x" }), /not a usable context ID/);
  });

  it("is what the workspace command does when the agent has github-writer.json", async () => {
    const setup = setUp();
    const agentDir = join(setup.dir, "agent");
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, "github-writer.json"),
      JSON.stringify({
        mirrorDir: setup.config.mirrorDir,
        app: setup.config.app,
        repositories: setup.config.repositories,
        workspace: setup.config.workspace,
      }),
    );
    const dir = join(setup.dir, "work", CONTEXT);
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, PI_CODING_AGENT_DIR: agentDir, FRACTION_AGENTS_CONTEXT_ID: CONTEXT };
    await run(process.execPath, [CLI, "prepare", dir], { env });
    assert.equal(git(worktreeOf(setup, dir), "branch", "--show-current"), `vuln-responder/${CONTEXT}`);
    await run(process.execPath, [CLI, "remove", dir], { env });
    assert.equal(existsSync(dir), false);
  });
});
