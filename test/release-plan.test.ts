import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { heldSummary, latestVersionTag, planRelease } from "../.github/release/plan.ts";

const user = "OTSUKA, Yuanying";
const renovate = "renovate[bot]";
const vulnResponder = "fraction-vuln-responder[bot]";

function git(dir: string, args: string[], author = user): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author}@example.com`,
      GIT_COMMITTER_NAME: author,
      GIT_COMMITTER_EMAIL: `${author}@example.com`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

function repository(): string {
  const dir = mkdtempSync(join(tmpdir(), "release-plan-"));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  commit(dir, user, "feat: first", { Dockerfile: "FROM node:24.21.0-bookworm-slim\n" });
  return dir;
}

function commit(dir: string, author: string, subject: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, ["add", "--all"], author);
  git(dir, ["commit", "--quiet", "-m", subject], author);
}

function tag(dir: string, name: string): void {
  git(dir, ["tag", "-a", name, "-m", `${name}: release`]);
}

describe("latestVersionTag", () => {
  it("compares vX.Y.Z tags as versions, not as text", () => {
    assert.equal(latestVersionTag(["v0.9.0", "v0.10.0", "v0.2.1"]), "v0.10.0");
  });

  it("ignores tags of another shape", () => {
    assert.equal(latestVersionTag(["v0.8.0", "v0.17.0.1", "v1.0.0-rc.1", "release-2", "0.9.0"]), "v0.8.0");
  });

  it("finds none among no tags", () => {
    assert.equal(latestVersionTag([]), undefined);
  });
});

describe("planRelease", () => {
  it("releases the next patch when only Renovate committed and the release's content changed", () => {
    const dir = repository();
    tag(dir, "v0.8.0");
    commit(dir, renovate, "chore(deps): update node to v24.22.0", { Dockerfile: "FROM node:24.22.0-bookworm-slim\n" });
    commit(dir, renovate, "chore(deps): update github-actions", { ".github/workflows/test.yml": "name: test\n" });

    const plan = planRelease(dir);

    assert.equal(plan.version, "v0.8.1");
    assert.match(plan.reason, /v0\.8\.0/);
    assert.equal(
      plan.message,
      [
        "v0.8.1: 依存の更新（Renovate）",
        "",
        "- chore(deps): update node to v24.22.0",
        "- chore(deps): update github-actions",
      ].join("\n"),
    );
  });

  it("leaves a merge commit out of the authors", () => {
    const dir = repository();
    tag(dir, "v0.8.0");
    git(dir, ["checkout", "--quiet", "-b", "renovate/express"]);
    commit(dir, renovate, "chore(deps): update dependency express to v5.3.1", { "package.json": "{}\n" });
    git(dir, ["checkout", "--quiet", "main"]);
    git(dir, ["merge", "--quiet", "--no-ff", "-m", "Merge pull request #1 from yuanying/renovate/express", "renovate/express"]);

    assert.equal(planRelease(dir).version, "v0.8.1");
  });

  it("releases nothing when a commit of someone other than Renovate is among them", () => {
    const dir = repository();
    tag(dir, "v0.8.0");
    commit(dir, renovate, "chore(deps): update node to v24.22.0", { Dockerfile: "FROM node:24.22.0-bookworm-slim\n" });
    commit(dir, user, "feat(host): something new", { "src/host.ts": "export {};\n" });

    const plan = planRelease(dir);

    assert.equal(plan.version, undefined);
    assert.match(plan.reason, /OTSUKA, Yuanying/);
  });

  it("releases the next patch when only vuln-responder committed", () => {
    const dir = repository();
    tag(dir, "v0.8.0");
    commit(dir, vulnResponder, "fix(deps): update undici to v7.18.2 (CVE-2026-0001)", { "package-lock.json": "{}\n" });

    const plan = planRelease(dir);

    assert.equal(plan.version, "v0.8.1");
    assert.equal(plan.held, undefined);
    assert.equal(
      plan.message,
      ["v0.8.1: 依存の更新（vuln-responder）", "", "- fix(deps): update undici to v7.18.2 (CVE-2026-0001)"].join("\n"),
    );
  });

  it("releases the next patch when Renovate and vuln-responder committed, merged from their branches", () => {
    const dir = repository();
    tag(dir, "v0.8.0");
    commit(dir, renovate, "chore(deps): update node to v24.22.0", { Dockerfile: "FROM node:24.22.0-bookworm-slim\n" });
    git(dir, ["checkout", "--quiet", "-b", "vuln-responder/vuln-src-yuanying-fraction-agents"]);
    commit(dir, vulnResponder, "fix(deps): update undici to v7.18.2 (CVE-2026-0001)", { "package-lock.json": "{}\n" });
    git(dir, ["checkout", "--quiet", "main"]);
    git(dir, [
      "merge",
      "--quiet",
      "--no-ff",
      "-m",
      "Merge pull request #2 from yuanying/vuln-responder/vuln-src-yuanying-fraction-agents",
      "vuln-responder/vuln-src-yuanying-fraction-agents",
    ]);

    const plan = planRelease(dir);

    assert.equal(plan.version, "v0.8.1");
    assert.equal(
      plan.message,
      [
        "v0.8.1: 依存の更新（Renovate・vuln-responder）",
        "",
        "- chore(deps): update node to v24.22.0",
        "- fix(deps): update undici to v7.18.2 (CVE-2026-0001)",
      ].join("\n"),
    );
  });

  it("holds the release back and says how to release by hand when a person committed among vuln-responder's", () => {
    const dir = repository();
    tag(dir, "v0.8.0");
    commit(dir, vulnResponder, "fix(deps): update undici to v7.18.2 (CVE-2026-0001)", { "package-lock.json": "{}\n" });
    commit(dir, user, "feat(host): something new", { "src/host.ts": "export {};\n" });
    const human = git(dir, ["rev-parse", "HEAD"]).trim();

    const plan = planRelease(dir);

    assert.equal(plan.version, undefined);
    assert.match(plan.reason, /OTSUKA, Yuanying/);
    assert.deepEqual(plan.held?.commits, [{ sha: human, author: user, subject: "feat(host): something new" }]);
    assert.equal(plan.held?.version, "v0.8.1");
    assert.equal(plan.held?.sha, human);
  });

  it("writes the held commits and the command to release by hand as a summary", () => {
    const summary = heldSummary("v0.8.0 から人のコミットがある", {
      version: "v0.8.1",
      sha: "0123456789abcdef0123456789abcdef01234567",
      commits: [
        { sha: "fedcba9876543210fedcba9876543210fedcba98", author: user, subject: "feat(host): something new" },
      ],
    });

    assert.match(summary, /v0\.8\.0 から人のコミットがある/);
    assert.match(summary, /fedcba9 .*OTSUKA, Yuanying.*feat\(host\): something new/);
    assert.match(summary, /git tag -a v0\.8\.1 0123456789abcdef0123456789abcdef01234567 -m /);
    assert.match(summary, /git push origin v0\.8\.1/);
  });

  it("releases nothing when Renovate changed only .github/ and renovate.json", () => {
    const dir = repository();
    tag(dir, "v0.8.0");
    commit(dir, renovate, "chore(deps): update github-actions", { ".github/workflows/image.yml": "name: image\n" });
    commit(dir, renovate, "chore(config): migrate renovate config", { "renovate.json": "{}\n" });

    const plan = planRelease(dir);

    assert.equal(plan.version, undefined);
    assert.match(plan.reason, /\.github\/ と renovate\.json/);
  });

  it("releases nothing when nothing was committed since the tag", () => {
    const dir = repository();
    tag(dir, "v0.8.0");

    const plan = planRelease(dir);

    assert.equal(plan.version, undefined);
    assert.match(plan.reason, /コミットがない/);
  });

  it("counts from the latest vX.Y.Z tag and ignores a four-part one", () => {
    const dir = repository();
    tag(dir, "v0.8.0");
    commit(dir, user, "feat: by hand", { "src/host.ts": "export {};\n" });
    tag(dir, "v0.8.0.1");
    commit(dir, renovate, "chore(deps): update node to v24.22.0", { Dockerfile: "FROM node:24.22.0-bookworm-slim\n" });

    const plan = planRelease(dir);

    assert.equal(plan.version, undefined);
    assert.match(plan.reason, /v0\.8\.0\b/);
  });

  it("reads a tag the checkout's HEAD does not reach as no tag of its own", () => {
    const dir = repository();
    git(dir, ["checkout", "--quiet", "-b", "elsewhere"]);
    commit(dir, user, "feat: elsewhere", { "src/host.ts": "export {};\n" });
    tag(dir, "v9.0.0");
    git(dir, ["checkout", "--quiet", "main"]);
    tag(dir, "v0.8.0");
    commit(dir, renovate, "chore(deps): update node to v24.22.0", { Dockerfile: "FROM node:24.22.0-bookworm-slim\n" });

    assert.equal(planRelease(dir).version, "v0.8.1");
  });

  it("releases nothing when a later commit was already released, as when a run waited for another", () => {
    const dir = repository();
    tag(dir, "v0.8.0");
    commit(dir, vulnResponder, "fix(deps): update undici to v7.18.2 (CVE-2026-0001)", { "package-lock.json": "{}\n" });
    const merged = git(dir, ["rev-parse", "HEAD"]).trim();
    commit(dir, user, "feat(host): something new", { "src/host.ts": "export {};\n" });
    tag(dir, "v0.8.1");
    git(dir, ["checkout", "--quiet", "--detach", merged]);

    const plan = planRelease(dir);

    assert.equal(plan.version, undefined);
    assert.equal(plan.held, undefined);
    assert.match(plan.reason, /v0\.8\.1/);
  });

  it("releases nothing when the next version is already a tag elsewhere", () => {
    const dir = repository();
    tag(dir, "v0.8.0");
    git(dir, ["checkout", "--quiet", "-b", "elsewhere"]);
    commit(dir, user, "fix: elsewhere", { "src/host.ts": "export {};\n" });
    tag(dir, "v0.8.1");
    git(dir, ["checkout", "--quiet", "main"]);
    commit(dir, vulnResponder, "fix(deps): update undici to v7.18.2 (CVE-2026-0001)", { "package-lock.json": "{}\n" });

    const plan = planRelease(dir);

    assert.equal(plan.version, undefined);
    assert.match(plan.reason, /v0\.8\.1/);
  });

  it("releases nothing when there is no vX.Y.Z tag", () => {
    const dir = repository();
    commit(dir, renovate, "chore(deps): update node to v24.22.0", { Dockerfile: "FROM node:24.22.0-bookworm-slim\n" });

    const plan = planRelease(dir);

    assert.equal(plan.version, undefined);
    assert.match(plan.reason, /vX\.Y\.Z のタグがない/);
  });
});
