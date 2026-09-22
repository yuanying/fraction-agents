import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkBash, checkChanges, checkFileTool, onlyMechanical, type PathRules } from "../lib/rules.ts";

const rules: PathRules = {
  appendOnlyPaths: ["raw/"],
  readOnlyPaths: ["Permanent-Notes/"],
  mechanicalConflictPaths: ["wiki/index.md", "wiki/log.md"],
};

describe("changes to push", () => {
  it("allows adding files under an append-only path and changing anything elsewhere", () => {
    assert.deepEqual(
      checkChanges(
        [
          { status: "A", path: "raw/memos/2026/09/natsumi-talk-20260922.md" },
          { status: "M", path: "wiki/index.md" },
          { status: "D", path: "wiki/topics/old.md" },
          { status: "A", path: "rawish/notes.md" },
        ],
        rules,
      ),
      [],
    );
  });

  it("refuses changing, deleting or retyping a file under an append-only path", () => {
    assert.deepEqual(
      checkChanges(
        [
          { status: "M", path: "raw/clips/a.md" },
          { status: "D", path: "raw/clips/b.md" },
          { status: "T", path: "raw/clips/c.md" },
        ],
        rules,
      ),
      [
        "raw/clips/a.md: existing files under raw/ may not be changed (only new files may be added)",
        "raw/clips/b.md: existing files under raw/ may not be deleted (only new files may be added)",
        "raw/clips/c.md: existing files under raw/ may not be changed (only new files may be added)",
      ],
    );
  });

  it("refuses any change under a read-only path", () => {
    assert.deepEqual(
      checkChanges(
        [
          { status: "A", path: "Permanent-Notes/new.md" },
          { status: "M", path: "Permanent-Notes/x.md" },
          { status: "D", path: "Permanent-Notes/y.md" },
        ],
        rules,
      ),
      [
        "Permanent-Notes/new.md: files under Permanent-Notes/ may not be added",
        "Permanent-Notes/x.md: files under Permanent-Notes/ may not be changed",
        "Permanent-Notes/y.md: files under Permanent-Notes/ may not be deleted",
      ],
    );
  });

  it("treats a path without a trailing slash as a file or a directory", () => {
    const strict: PathRules = { ...rules, readOnlyPaths: ["docs", "_access.yml"] };
    assert.equal(checkChanges([{ status: "M", path: "docs/adr/1.md" }], strict).length, 1);
    assert.equal(checkChanges([{ status: "M", path: "_access.yml" }], strict).length, 1);
    assert.equal(checkChanges([{ status: "M", path: "docsite/x.md" }], strict).length, 0);
  });
});

describe("merge conflicts", () => {
  it("knows when every conflict is in a file that may be resolved mechanically", () => {
    assert.equal(onlyMechanical(["wiki/index.md", "wiki/log.md"], rules), true);
    assert.equal(onlyMechanical(["wiki/index.md", "wiki/topics/k8s.md"], rules), false);
    assert.equal(onlyMechanical([], rules), true);
  });
});

describe("file tools", () => {
  const exists = (path: string) => path === "/work/raw/clips/old.md";

  it("blocks writing or editing under a read-only path", () => {
    assert.match(checkFileTool("write", "Permanent-Notes/x.md", "/work", rules, exists) ?? "", /Permanent-Notes\/ is read-only/);
    assert.match(checkFileTool("edit", "/work/Permanent-Notes/x.md", "/work", rules, exists) ?? "", /read-only/);
  });

  it("allows writing a new file under an append-only path but not overwriting or editing one", () => {
    assert.equal(checkFileTool("write", "raw/memos/new.md", "/work", rules, exists), undefined);
    assert.match(checkFileTool("write", "raw/clips/old.md", "/work", rules, exists) ?? "", /only new files/);
    assert.match(checkFileTool("edit", "raw/clips/old.md", "/work", rules, exists) ?? "", /only new files/);
    assert.match(checkFileTool("write", "@raw/clips/old.md", "/work", rules, exists) ?? "", /only new files/);
  });

  it("leaves other paths and paths outside the workspace alone", () => {
    assert.equal(checkFileTool("write", "wiki/index.md", "/work", rules, exists), undefined);
    assert.equal(checkFileTool("edit", "/tmp/raw/x.md", "/work", rules, exists), undefined);
    assert.equal(checkFileTool("read", "Permanent-Notes/x.md", "/work", rules, exists), undefined);
  });
});

describe("bash", () => {
  const exists = (path: string) => path === "/work/raw/clips/old.md";
  const blocked = (command: string) => checkBash(command, "/work", rules, exists);

  it("blocks git push, so pushes go through the push tool", () => {
    assert.match(blocked("git push origin HEAD:main") ?? "", /github_push/);
    assert.match(blocked("git -C . push") ?? "", /github_push/);
    assert.match(blocked("cd x && git push --force") ?? "", /github_push/);
  });

  it("blocks merging pull requests from the shell", () => {
    assert.match(blocked("gh pr merge 12 --merge") ?? "", /merge/);
    assert.match(blocked("gh api -X PUT repos/o/r/pulls/12/merge") ?? "", /merge/);
    assert.match(blocked("curl -X PUT https://api.github.com/repos/o/r/pulls/1/merge") ?? "", /merge/);
  });

  it("blocks commands that would change a read-only path", () => {
    for (const command of [
      "rm -rf Permanent-Notes",
      "mv Permanent-Notes/a.md wiki/",
      "echo x > Permanent-Notes/a.md",
      "sed -i s/a/b/ Permanent-Notes/a.md",
      "git rm Permanent-Notes/a.md",
      "git checkout -- Permanent-Notes/",
    ]) {
      assert.match(blocked(command) ?? "", /Permanent-Notes\//, command);
    }
  });

  it("blocks commands that would change an existing file under an append-only path", () => {
    for (const command of ["rm raw/clips/old.md", "echo x >> raw/clips/old.md", "sed -i s/a/b/ ./raw/clips/old.md", "git mv raw/clips/old.md raw/x.md"]) {
      assert.match(blocked(command) ?? "", /raw\//, command);
    }
  });

  it("lets reading commands and additions through", () => {
    for (const command of [
      "cat Permanent-Notes/a.md raw/clips/old.md",
      "grep -r kubernetes Permanent-Notes raw",
      "git log -- raw/",
      "git status",
      "cp /tmp/talk.md raw/memos/2026/09/natsumi-talk-20260922.md",
      "git add raw/memos/2026/09/natsumi-talk-20260922.md && git commit -m 'Add a memo'",
      "git diff origin/main -- wiki/",
    ]) {
      assert.equal(blocked(command), undefined, command);
    }
  });
});
