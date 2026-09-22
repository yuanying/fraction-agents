import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Gate } from "../lib/gate.ts";
import { prepareWorkspace, removeWorkspace } from "../lib/workspace.ts";
import { FAKE_TOKEN, containsInFiles, git, makeFixture, write, type Fixture } from "./fixtures/repo.ts";

const OWNER = "system:serviceaccount:fraction-agents:owner";
const NATSUMI = "system:serviceaccount:fraction-agents:natsumi";
const CONTEXT = "3f1c9a52-6c37-4a47-9a31-2f3f8f0e1d11";

async function workspace(fixture: Fixture, contextId = CONTEXT): Promise<string> {
  const dir = join(fixture.dir, "work", contextId);
  await prepareWorkspace({ config: fixture.config, github: fixture.github, dir, contextId });
  return dir;
}

function gate(fixture: Fixture, cwd: string, caller = OWNER): Gate {
  return new Gate({ config: fixture.config, github: fixture.github, cwd, caller });
}

function commit(cwd: string, files: Record<string, string | null>, message: string): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(cwd, path));
    else write(cwd, path, content);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}

function remoteBranch(fixture: Fixture, branch: string): string | undefined {
  try {
    return git(fixture.remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
  } catch {
    return undefined;
  }
}

describe("workspace", () => {
  it("makes a worktree of the persistent clone on the context's own branch from the latest default branch", async () => {
    const fixture = makeFixture();
    fixture.commitToMain({ "wiki/topics/b.md": "# B\n" }, "add b");
    const dir = await workspace(fixture);
    assert.equal(git(dir, "branch", "--show-current"), `wiki-keeper/${CONTEXT}`);
    assert.equal(existsSync(join(dir, "wiki/topics/b.md")), true);
    assert.equal(git(dir, "config", "user.name"), "wiki-keeper[bot]");
    assert.equal(git(dir, "rev-parse", "--show-toplevel"), dir);
  });

  it("keeps the work of a context when prepared again", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    write(dir, "wiki/topics/draft.md", "draft\n");
    await workspace(fixture);
    assert.equal(readFileSync(join(dir, "wiki/topics/draft.md"), "utf8"), "draft\n");
  });

  it("recreates a worktree whose directory was lost, on the same branch", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    commit(dir, { "wiki/topics/c.md": "# C\n" }, "add c");
    rmSync(dir, { recursive: true, force: true });
    await workspace(fixture);
    assert.equal(readFileSync(join(dir, "wiki/topics/c.md"), "utf8"), "# C\n");
  });

  it("removes the worktree and its local branch", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    await removeWorkspace({ config: fixture.config, dir });
    assert.equal(existsSync(dir), false);
    assert.equal(git(fixture.config.clone, "branch", "--list", `wiki-keeper/${CONTEXT}`), "");
    assert.equal(git(fixture.config.clone, "worktree", "list").split("\n").length, 1);
  });

  it("refuses a context ID that is not a plain identifier", async () => {
    const fixture = makeFixture();
    await assert.rejects(
      prepareWorkspace({ config: fixture.config, github: fixture.github, dir: join(fixture.dir, "x"), contextId: "../main" }),
      /context ID/,
    );
  });
});

describe("push", () => {
  it("pushes a new file under raw/ to the context's branch", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    commit(dir, { "raw/memos/2026/09/natsumi-talk-20260922.md": "what we talked about\n" }, "Add a memo");
    const result = await gate(fixture, dir).push();
    assert.match(result, /Pushed/);
    assert.equal(remoteBranch(fixture, `wiki-keeper/${CONTEXT}`), git(dir, "rev-parse", "HEAD"));
  });

  it("refuses to push the default branch", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    git(dir, "switch", "-q", "-c", "main", "origin/main");
    commit(dir, { "wiki/topics/a.md": "# A2\n" }, "edit");
    await assert.rejects(gate(fixture, dir).push(), /default branch/);
    assert.notEqual(remoteBranch(fixture, "main"), git(dir, "rev-parse", "HEAD"));
  });

  it("refuses to push a branch that is not the agent's", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    git(dir, "switch", "-q", "-c", "feature/x");
    commit(dir, { "wiki/topics/a.md": "# A2\n" }, "edit");
    await assert.rejects(gate(fixture, dir).push(), /wiki-keeper\//);
    assert.equal(remoteBranch(fixture, "feature/x"), undefined);
  });

  it("refuses to push from a detached HEAD", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    git(dir, "switch", "-q", "--detach");
    await assert.rejects(gate(fixture, dir).push(), /branch/);
  });

  for (const [name, files] of [
    ["changing a file under raw/", { "raw/clips/old.md": "rewritten\n" }],
    ["deleting a file under raw/", { "raw/clips/old.md": null }],
    ["adding a file under Permanent-Notes/", { "Permanent-Notes/new.md": "new\n" }],
    ["changing a file under Permanent-Notes/", { "Permanent-Notes/note.md": "changed\n" }],
    ["deleting a file under Permanent-Notes/", { "Permanent-Notes/note.md": null }],
    ["moving a file out of raw/", { "raw/clips/old.md": null, "wiki/old.md": "an old clip\n" }],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const fixture = makeFixture();
      const dir = await workspace(fixture);
      commit(dir, { "wiki/topics/a.md": "# A, revised\n", ...files }, name);
      await assert.rejects(gate(fixture, dir).push(), /may not be/);
      assert.equal(remoteBranch(fixture, `wiki-keeper/${CONTEXT}`), undefined, "nothing was pushed");
    });
  }

  it("judges the branch as a whole, including commits pushed before", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    commit(dir, { "wiki/topics/a.md": "# A2\n" }, "fine");
    await gate(fixture, dir).push();
    commit(dir, { "raw/clips/old.md": "rewritten\n" }, "not fine");
    await assert.rejects(gate(fixture, dir).push(), /raw\/clips\/old.md/);
  });

  it("refuses to push uncommitted changes", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    write(dir, "wiki/topics/a.md", "# dirty\n");
    await assert.rejects(gate(fixture, dir).push(), /commit/i);
  });

  it("says so when there is nothing to push", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    await assert.rejects(gate(fixture, dir).push(), /nothing to push/i);
  });

  it("keeps the token out of the environment, the repository and its config", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    commit(dir, { "wiki/topics/a.md": "# A2\n" }, "edit");
    await gate(fixture, dir).pullRequest({ title: "Edit A", body: "" });
    assert.ok(fixture.github.tokensIssued > 0, "a token was used");
    const encoded = Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString("base64");
    for (const value of Object.values(process.env)) {
      assert.equal(value?.includes(FAKE_TOKEN) || value?.includes(encoded), false);
    }
    assert.deepEqual(containsInFiles(fixture.config.clone, FAKE_TOKEN), []);
    assert.deepEqual(containsInFiles(fixture.config.clone, encoded), []);
    assert.deepEqual(containsInFiles(dir, encoded), []);
    assert.equal(git(dir, "remote", "get-url", "origin"), fixture.config.repository.remoteUrl);
    assert.doesNotMatch(git(dir, "config", "--list", "--show-origin"), /extraheader|x-access-token/i);
  });
});

describe("pull requests", () => {
  it("opens one pull request per context and stacks later pushes on it", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    commit(dir, { "wiki/topics/a.md": "# A2\n" }, "first");
    const first = await gate(fixture, dir).pullRequest({ title: "Update A", body: "Why" });
    assert.match(first, /#1/);
    commit(dir, { "wiki/topics/a.md": "# A3\n" }, "second");
    const second = await gate(fixture, dir).pullRequest({ title: "Update A again", body: "More" });
    assert.match(second, /#1/);
    assert.equal(fixture.github.pulls.length, 1);
    assert.equal(fixture.github.pulls[0]!.title, "Update A again");
    assert.equal(fixture.github.pulls[0]!.head, `wiki-keeper/${CONTEXT}`);
    assert.equal(fixture.github.pulls[0]!.base, "main");
    assert.equal(remoteBranch(fixture, `wiki-keeper/${CONTEXT}`), git(dir, "rev-parse", "HEAD"));
  });

  it("needs a title for a new pull request", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    commit(dir, { "wiki/topics/a.md": "# A2\n" }, "first");
    await assert.rejects(gate(fixture, dir).pullRequest({}), /title/);
  });

  it("starts a new branch and pull request for writes after the earlier one was merged", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    commit(dir, { "wiki/topics/a.md": "# A2\n" }, "first");
    await gate(fixture, dir).pullRequest({ title: "First", body: "" });
    await gate(fixture, dir).merge();
    commit(dir, { "wiki/topics/b.md": "# B\n" }, "second");
    const result = await gate(fixture, dir).pullRequest({ title: "Second", body: "" });
    assert.match(result, /#2/);
    assert.match(result, /#1 was merged/);
    const branch = git(dir, "branch", "--show-current");
    assert.equal(branch, `wiki-keeper/${CONTEXT}-2`);
    assert.equal(fixture.github.pulls[1]!.head, branch);
    assert.equal(git(dir, "rev-list", "--count", "origin/main..HEAD"), "1", "only the new commit is on the new branch");
  });

  it("starts a new branch for writes after the earlier pull request was closed", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    commit(dir, { "wiki/topics/a.md": "# A2\n" }, "first");
    await gate(fixture, dir).pullRequest({ title: "First", body: "" });
    fixture.github.close(1);
    commit(dir, { "wiki/topics/b.md": "# B\n" }, "second");
    const result = await gate(fixture, dir).pullRequest({ title: "Second", body: "" });
    assert.match(result, /#1 was closed/);
    assert.equal(git(dir, "rev-list", "--count", "origin/main..HEAD"), "1", "the closed PR's commits are left behind");
    assert.equal(existsSync(join(dir, "wiki/topics/b.md")), true);
    assert.equal(readFileSync(join(dir, "wiki/topics/a.md"), "utf8"), "# A\n");
  });
});

describe("merge", () => {
  it("is refused to a caller who may not merge", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    commit(dir, { "wiki/topics/a.md": "# A2\n" }, "first");
    await gate(fixture, dir, NATSUMI).pullRequest({ title: "First", body: "" });
    assert.equal(gate(fixture, dir, NATSUMI).canMerge, false);
    await assert.rejects(gate(fixture, dir, NATSUMI).merge(), /may not merge/);
    assert.equal(fixture.github.merges.length, 0);
  });

  it("needs a pull request", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    await assert.rejects(gate(fixture, dir).merge(), /pull request/);
  });

  it("merges the context's pull request after taking in the latest default branch", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    commit(dir, { "wiki/topics/a.md": "# A2\n" }, "first");
    await gate(fixture, dir).pullRequest({ title: "First", body: "" });
    fixture.commitToMain({ "wiki/topics/other.md": "# Other\n" }, "someone else's PR");
    const result = await gate(fixture, dir).merge();
    assert.match(result, /Merged pull request #1/);
    assert.equal(fixture.github.merges.length, 1);
    const main = git(fixture.remote, "rev-parse", "refs/heads/main");
    assert.equal(git(fixture.remote, "show", `${main}:wiki/topics/other.md`), "# Other");
    assert.equal(git(fixture.remote, "show", `${main}:wiki/topics/a.md`), "# A2");
  });

  it("hands conflicts only in the index and log to the agent, and merges once they are resolved", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    const index = readFileSync(join(dir, "wiki/index.md"), "utf8");
    commit(dir, { "wiki/index.md": index + "- [[topics/b]] — B\n", "wiki/topics/b.md": "# B\n" }, "add b");
    await gate(fixture, dir).pullRequest({ title: "Add B", body: "" });
    fixture.commitToMain({ "wiki/index.md": index + "- [[topics/c]] — C\n", "wiki/topics/c.md": "# C\n" }, "add c");

    const first = await gate(fixture, dir).merge();
    assert.match(first, /wiki\/index\.md/);
    assert.match(first, /github_merge again/);
    assert.equal(fixture.github.merges.length, 0);
    assert.equal(existsSync(join(dir, ".git")), true);
    assert.equal(git(dir, "diff", "--name-only", "--diff-filter=U"), "wiki/index.md");

    await assert.rejects(gate(fixture, dir).merge(), /still has conflicts/);

    writeFileSync(join(dir, "wiki/index.md"), index + "- [[topics/b]] — B\n- [[topics/c]] — C\n");
    git(dir, "add", "wiki/index.md");
    const second = await gate(fixture, dir).merge();
    assert.match(second, /Merged pull request #1/);
    const main = git(fixture.remote, "rev-parse", "refs/heads/main");
    assert.match(git(fixture.remote, "show", `${main}:wiki/index.md`), /topics\/b.*\n.*topics\/c/);
  });

  it("does not merge when other files conflict, and leaves the branch as it was", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    commit(dir, { "wiki/topics/a.md": "# A from the agent\n" }, "edit a");
    await gate(fixture, dir).pullRequest({ title: "Edit A", body: "" });
    const before = git(dir, "rev-parse", "HEAD");
    fixture.commitToMain({ "wiki/topics/a.md": "# A from someone else\n" }, "edit a too");
    await assert.rejects(gate(fixture, dir).merge(), /wiki\/topics\/a\.md/);
    assert.equal(git(dir, "rev-parse", "HEAD"), before);
    assert.equal(git(dir, "status", "--porcelain"), "");
    assert.equal(fixture.github.merges.length, 0);
    assert.equal(fixture.github.pulls[0]!.state, "open");
  });

  it("does not merge a resolution that breaks the path rules", async () => {
    const fixture = makeFixture();
    const dir = await workspace(fixture);
    const log = readFileSync(join(dir, "wiki/log.md"), "utf8");
    commit(dir, { "wiki/log.md": log + "## mine\n" }, "log");
    await gate(fixture, dir).pullRequest({ title: "Log", body: "" });
    fixture.commitToMain({ "wiki/log.md": log + "## theirs\n" }, "their log");
    await gate(fixture, dir).merge();
    writeFileSync(join(dir, "wiki/log.md"), log + "## mine\n## theirs\n");
    writeFileSync(join(dir, "Permanent-Notes/note.md"), "sneaked in\n");
    git(dir, "add", "-A");
    await assert.rejects(gate(fixture, dir).merge(), /Permanent-Notes/);
    assert.equal(fixture.github.merges.length, 0);
  });
});
