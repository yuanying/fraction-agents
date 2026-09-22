import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { parseGateConfig, type GateConfig } from "../lib/config.ts";
import { GitHubApp } from "../lib/github.ts";

interface Seen {
  method: string;
  path: string;
  authorization: string;
  body: unknown;
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const seen: Seen[] = [];
let issued = 0;
let server: Server;
let apiUrl = "";

function pullJson(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    html_url: `https://github.example.test/example/wiki/pull/${number}`,
    state: "open",
    merged: false,
    title: "T",
    body: null,
    head: { ref: "wiki-keeper/x" },
    base: { ref: "main" },
    ...extra,
  };
}

function verifyJwt(authorization: string): Record<string, unknown> {
  const token = authorization.replace(/^Bearer /, "");
  const [header, payload, signature] = token.split(".");
  const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, "base64url"));
  assert.equal(ok, true, "the JWT is signed with the App's key");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  return JSON.parse(Buffer.from(payload!, "base64url").toString());
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text === "" ? undefined : JSON.parse(text);
}

before(async () => {
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = req.url ?? "";
    seen.push({ method: req.method ?? "", path, authorization: req.headers.authorization ?? "", body });
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && path === "/app/installations/22/access_tokens") {
      const claims = verifyJwt(req.headers.authorization ?? "");
      assert.equal(claims.iss, "11");
      issued++;
      return send(201, { token: `ghs_issued_${issued}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (!(req.headers.authorization ?? "").startsWith("Bearer ghs_issued_")) return send(401, { message: "Bad credentials" });
    if (req.method === "GET" && path.startsWith("/repos/example/wiki/pulls?")) return send(200, [pullJson(3)]);
    if (req.method === "GET" && path === "/repos/example/wiki/pulls/3") return send(200, pullJson(3, { state: "closed", merged: true }));
    if (req.method === "POST" && path === "/repos/example/wiki/pulls") return send(201, pullJson(4));
    if (req.method === "PATCH" && path === "/repos/example/wiki/pulls/4") return send(200, pullJson(4, { title: "New title" }));
    if (req.method === "PUT" && path === "/repos/example/wiki/pulls/4/merge") return send(200, { merged: true, message: "Pull Request successfully merged" });
    if (req.method === "PUT" && path === "/repos/example/wiki/pulls/5/merge") return send(405, { message: "Pull Request is not mergeable" });
    return send(404, { message: "Not Found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

function config(): GateConfig {
  const dir = mkdtempSync(join(tmpdir(), "fraction-agents-app-"));
  const keyFile = join(dir, "private-key.pem");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs1", format: "pem" }));
  return parseGateConfig({
    repository: { owner: "example", name: "wiki" },
    apiUrl,
    app: { appId: 11, installationId: "22", privateKeyFile: keyFile },
    clone: "/data/wiki.git",
    branchPrefix: "wiki-keeper/",
    commitIdentity: { name: "bot", email: "bot@example.test" },
  });
}

describe("GitHub App client", () => {
  it("buys an installation token for the one repository with contents and pull requests only", async () => {
    seen.length = 0;
    const app = new GitHubApp(config());
    const header = await app.gitAuthorization();
    assert.equal(Buffer.from(header.replace(/^Basic /, ""), "base64").toString(), `x-access-token:ghs_issued_${issued}`);
    assert.deepEqual(seen[0]!.body, { repositories: ["wiki"], permissions: { contents: "write", pull_requests: "write" } });
  });

  it("reuses the token until it is close to expiring", async () => {
    let now = Date.now();
    const app = new GitHubApp(config(), { now: () => now });
    const before = issued;
    await app.gitAuthorization();
    await app.getPullRequest(3);
    await app.findPullRequest("wiki-keeper/x");
    assert.equal(issued, before + 1);
    now += 56 * 60_000;
    await app.gitAuthorization();
    assert.equal(issued, before + 2, "a new token when less than five minutes are left");
  });

  it("finds, reads, opens and updates pull requests", async () => {
    seen.length = 0;
    const app = new GitHubApp(config());
    const found = await app.findPullRequest("wiki-keeper/x");
    assert.equal(found?.number, 3);
    const query = new URLSearchParams(seen.find((s) => s.path.startsWith("/repos/example/wiki/pulls?"))!.path.split("?")[1]);
    assert.equal(query.get("head"), "example:wiki-keeper/x");
    assert.equal(query.get("state"), "open");
    const merged = await app.getPullRequest(3);
    assert.deepEqual([merged.state, merged.merged], ["closed", true]);
    const created = await app.createPullRequest({ title: "T", body: "B", head: "wiki-keeper/x", base: "main" });
    assert.equal(created.url, "https://github.example.test/example/wiki/pull/4");
    assert.deepEqual(seen.at(-1)!.body, { title: "T", body: "B", head: "wiki-keeper/x", base: "main" });
    assert.equal((await app.updatePullRequest(4, { title: "New title" })).title, "New title");
  });

  it("merges with the expected head, and reports a refusal as not merged", async () => {
    const app = new GitHubApp(config());
    assert.deepEqual(await app.mergePullRequest(4, { sha: "abc", method: "merge" }), {
      merged: true,
      message: "Pull Request successfully merged",
    });
    assert.deepEqual(seen.at(-1)!.body, { sha: "abc", merge_method: "merge" });
    assert.deepEqual(await app.mergePullRequest(5, { sha: "abc", method: "merge" }), {
      merged: false,
      message: "Pull Request is not mergeable",
    });
  });

  it("reports API errors without the token", async () => {
    const app = new GitHubApp(config());
    await assert.rejects(app.getPullRequest(99), (error: Error) => {
      assert.match(error.message, /HTTP 404 Not Found/);
      assert.doesNotMatch(error.message, /ghs_/);
      return true;
    });
  });
});
