import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { git, makeFixture } from "./fixtures/repo.ts";

const CLI = resolve(import.meta.dirname, "../bin/workspace.ts");
const CONTEXT = "5a2e9a52-6c37-4a47-9a31-2f3f8f0e1d11";
const run = promisify(execFile);

describe("workspace command", () => {
  it("prepares and removes a context's worktree with the agent directory's settings", async () => {
    let tokens = 0;
    const server = createServer((req, res) => {
      tokens++;
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "ghs_cli", expires_at: new Date(Date.now() + 3600_000).toISOString() }));
      req.resume();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const fixture = makeFixture();
      const keyFile = join(fixture.dir, "key.pem");
      writeFileSync(keyFile, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }));
      const agentDir = join(fixture.dir, "agent");
      mkdirSync(agentDir);
      writeFileSync(
        join(agentDir, "github-gate.json"),
        JSON.stringify({
          ...fixture.config,
          apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          app: { ...fixture.config.app, privateKeyFile: keyFile },
        }),
      );
      const dir = join(fixture.dir, "work", CONTEXT);
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, PI_CODING_AGENT_DIR: agentDir, FRACTION_AGENTS_CONTEXT_ID: CONTEXT };
      await run(process.execPath, [CLI, "prepare", dir], { env });
      assert.equal(git(dir, "branch", "--show-current"), `wiki-keeper/${CONTEXT}`);
      assert.ok(tokens > 0);
      await run(process.execPath, [CLI, "remove", dir], { env });
      assert.equal(existsSync(dir), false);
    } finally {
      server.close();
    }
  });

  it("fails with a message when it cannot do its job", async () => {
    await assert.rejects(run(process.execPath, [CLI, "prepare"], { env: { PATH: process.env.PATH } }), /usage/);
  });
});
