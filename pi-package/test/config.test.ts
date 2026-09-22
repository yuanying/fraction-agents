import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultGateConfigPath, parseGateConfig } from "../lib/config.ts";

const minimal = {
  repository: { owner: "example", name: "wiki" },
  app: { appId: "1", installationId: 2, privateKeyFile: "/secrets/github-app/private-key.pem" },
  clone: "/data/wiki.git",
  branchPrefix: "wiki-keeper/",
  commitIdentity: { name: "wiki-keeper[bot]", email: "bot@example.test" },
};

describe("gate config", () => {
  it("fills in the defaults", () => {
    const config = parseGateConfig(minimal);
    assert.equal(config.repository.defaultBranch, "main");
    assert.equal(config.repository.remoteUrl, "https://github.com/example/wiki.git");
    assert.equal(config.apiUrl, "https://api.github.com");
    assert.equal(config.app.installationId, "2");
    assert.equal(config.mergeMethod, "merge");
    assert.deepEqual([config.appendOnlyPaths, config.readOnlyPaths, config.mechanicalConflictPaths, config.mergeCallers, config.skillPaths], [[], [], [], [], []]);
  });

  it("rejects values that would be unsafe to use", () => {
    assert.throws(() => parseGateConfig({ ...minimal, clone: "data/wiki.git" }), /clone/);
    assert.throws(() => parseGateConfig({ ...minimal, repository: { owner: "a/b", name: "wiki" } }), /owner/);
    assert.throws(() => parseGateConfig({ ...minimal, branchPrefix: "../x" }), /branchPrefix/);
    assert.throws(() => parseGateConfig({ ...minimal, readOnlyPaths: ["../etc"] }), /readOnlyPaths/);
    assert.throws(() => parseGateConfig({ ...minimal, mergeMethod: "force" }), /mergeMethod/);
    assert.throws(() => parseGateConfig({ ...minimal, app: { ...minimal.app, appId: "x" } }), /appId/);
  });

  it("is looked for in pi's agent directory", () => {
    assert.equal(defaultGateConfigPath({ PI_CODING_AGENT_DIR: "/agent" }), "/agent/github-gate.json");
    assert.equal(defaultGateConfigPath({}), undefined);
  });
});
