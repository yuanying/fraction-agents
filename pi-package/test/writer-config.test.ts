import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mirrorPath, parseWriterConfig } from "../lib/writer-config.ts";

const MINIMAL = {
  mirrorDir: "/var/run/github-writer/mirror",
  app: { appId: 123, installationId: "456", privateKeyFile: "/var/run/secrets/github-app/private-key.pem" },
  repositories: [{ owner: "yuanying", name: "fleet-infra", branchPrefix: "vuln-responder/" }],
};

function withRepository(overrides: Record<string, unknown>) {
  return { ...MINIMAL, repositories: [{ ...MINIMAL.repositories[0], ...overrides }] };
}

describe("github-writer settings", () => {
  it("fills in the defaults", () => {
    const config = parseWriterConfig(MINIMAL);
    assert.equal(config.port, 8091);
    assert.equal(config.apiUrl, "https://api.github.com");
    assert.equal(config.syncIntervalSeconds, 300);
    assert.equal(config.maxBundleBytes, 50 * 1024 * 1024);
    assert.deepEqual(config.app, { appId: "123", installationId: "456", privateKeyFile: "/var/run/secrets/github-app/private-key.pem" });
    assert.deepEqual(config.repositories, [
      {
        owner: "yuanying",
        name: "fleet-infra",
        defaultBranch: "main",
        remoteUrl: "https://github.com/yuanying/fleet-infra.git",
        branchPrefix: "vuln-responder/",
        writablePaths: [],
        appendOnlyPaths: [],
        readOnlyPaths: [],
      },
    ]);
  });

  it("keeps the path rules of each repository", () => {
    const config = parseWriterConfig(
      withRepository({ writablePaths: ["security/vex/"], appendOnlyPaths: ["raw/"], readOnlyPaths: ["Permanent-Notes/"], defaultBranch: "master" }),
    );
    const [repository] = config.repositories;
    assert.deepEqual(repository?.writablePaths, ["security/vex/"]);
    assert.deepEqual(repository?.appendOnlyPaths, ["raw/"]);
    assert.deepEqual(repository?.readOnlyPaths, ["Permanent-Notes/"]);
    assert.equal(repository?.defaultBranch, "master");
  });

  it("puts each repository's mirror under the mirror directory", () => {
    const config = parseWriterConfig(MINIMAL);
    assert.equal(mirrorPath(config, config.repositories[0]!), "/var/run/github-writer/mirror/yuanying/fleet-infra.git");
  });

  it("refuses settings without any repository", () => {
    assert.throws(() => parseWriterConfig({ ...MINIMAL, repositories: [] }), /repositories must list at least one repository/);
  });

  it("refuses the same repository twice", () => {
    assert.throws(
      () => parseWriterConfig({ ...MINIMAL, repositories: [MINIMAL.repositories[0], MINIMAL.repositories[0]] }),
      /yuanying\/fleet-infra is listed twice/,
    );
  });

  it("refuses a repository without a branch prefix, or with one the default branch starts with", () => {
    assert.throws(() => parseWriterConfig(withRepository({ branchPrefix: undefined })), /branchPrefix must be a non-empty string/);
    assert.throws(() => parseWriterConfig(withRepository({ branchPrefix: "../x" })), /branchPrefix must be a plain branch name prefix/);
    assert.throws(() => parseWriterConfig(withRepository({ branchPrefix: "ma" })), /the default branch main starts with the branch prefix/);
  });

  it("refuses paths that are not relative to the repository", () => {
    assert.throws(() => parseWriterConfig(withRepository({ writablePaths: ["/etc"] })), /writablePaths must hold paths relative to the repository/);
    assert.throws(() => parseWriterConfig(withRepository({ readOnlyPaths: ["a/../b"] })), /readOnlyPaths must hold paths relative to the repository/);
  });

  it("reads the agent's workspace: where the clones go and who commits", () => {
    assert.equal(parseWriterConfig(MINIMAL).workspace, undefined);
    const config = parseWriterConfig({
      ...MINIMAL,
      workspace: { cloneDir: "/data/repos", commitIdentity: { name: "vuln-responder[bot]", email: "1+vuln-responder[bot]@users.noreply.github.com" } },
    });
    assert.deepEqual(config.workspace, {
      cloneDir: "/data/repos",
      commitIdentity: { name: "vuln-responder[bot]", email: "1+vuln-responder[bot]@users.noreply.github.com" },
    });
    assert.throws(() => parseWriterConfig({ ...MINIMAL, workspace: { cloneDir: "repos", commitIdentity: { name: "a", email: "b" } } }), /workspace\.cloneDir must be an absolute path/);
    assert.throws(() => parseWriterConfig({ ...MINIMAL, workspace: { cloneDir: "/data/repos" } }), /workspace\.commitIdentity must be an object/);
  });

  it("reads which repositories every context gets a worktree of", () => {
    const identity = { name: "vuln-responder[bot]", email: "bot@example.test" };
    const two = {
      ...MINIMAL,
      repositories: [...MINIMAL.repositories, { owner: "yuanying", name: "hshelf", branchPrefix: "vuln-responder/" }],
    };
    assert.equal(parseWriterConfig({ ...two, workspace: { cloneDir: "/data/repos", commitIdentity: identity } }).workspace?.repositories, undefined);
    const config = parseWriterConfig({ ...two, workspace: { cloneDir: "/data/repos", commitIdentity: identity, repositories: ["Yuanying/Fleet-Infra"] } });
    assert.deepEqual(config.workspace?.repositories, ["Yuanying/Fleet-Infra"]);
    assert.throws(
      () => parseWriterConfig({ ...two, workspace: { cloneDir: "/data/repos", commitIdentity: identity, repositories: ["yuanying/llm-wiki"] } }),
      /workspace\.repositories: yuanying\/llm-wiki is not one of the repositories/,
    );
    assert.throws(
      () => parseWriterConfig({ ...two, workspace: { cloneDir: "/data/repos", commitIdentity: identity, repositories: "yuanying/fleet-infra" } }),
      /workspace\.repositories must be a list of owner\/name/,
    );
  });

  it("refuses a relative mirror directory or key file, and a bad port", () => {
    assert.throws(() => parseWriterConfig({ ...MINIMAL, mirrorDir: "mirror" }), /mirrorDir must be an absolute path/);
    assert.throws(() => parseWriterConfig({ ...MINIMAL, app: { ...MINIMAL.app, privateKeyFile: "key.pem" } }), /app\.privateKeyFile must be an absolute path/);
    assert.throws(() => parseWriterConfig({ ...MINIMAL, port: 70000 }), /port must be a port number/);
  });
});
