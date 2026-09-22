import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { A2A_AUDIENCE, authenticate, KubernetesTokenReviewer, type TokenReviewer } from "../src/auth.ts";

const OWNER = "system:serviceaccount:fraction-agents:owner";
const STRANGER = "system:serviceaccount:default:stranger";

const fakeReviewer: TokenReviewer = {
  async review(token, audiences) {
    assert.deepEqual(audiences, [A2A_AUDIENCE]);
    switch (token) {
      case "owner-token":
        return { authenticated: true, username: OWNER, audiences: [A2A_AUDIENCE] };
      case "stranger-token":
        return { authenticated: true, username: STRANGER, audiences: [A2A_AUDIENCE] };
      case "apiserver-token":
        return { authenticated: true, username: OWNER, audiences: ["https://kubernetes.default.svc"] };
      default:
        return { authenticated: false };
    }
  },
};

describe("authenticate", () => {
  const allowed = [OWNER];

  it("accepts an allowed ServiceAccount and names it as the caller", async () => {
    assert.deepEqual(await authenticate("Bearer owner-token", fakeReviewer, allowed), { ok: true, caller: OWNER });
  });

  it("rejects a request without credentials", async () => {
    assert.deepEqual(await authenticate(undefined, fakeReviewer, allowed), {
      ok: false,
      status: 401,
      reason: "missing bearer token",
    });
    assert.equal((await authenticate("Basic abc", fakeReviewer, allowed)).ok, false);
  });

  it("rejects a token the apiserver does not authenticate", async () => {
    const result = await authenticate("Bearer forged", fakeReviewer, allowed);
    assert.deepEqual(result, { ok: false, status: 401, reason: "invalid token" });
  });

  it("rejects a token for another audience", async () => {
    const result = await authenticate("Bearer apiserver-token", fakeReviewer, allowed);
    assert.deepEqual(result, { ok: false, status: 401, reason: "invalid token" });
  });

  it("rejects a ServiceAccount that is not allowed", async () => {
    const result = await authenticate("Bearer stranger-token", fakeReviewer, allowed);
    assert.deepEqual(result, { ok: false, status: 403, reason: "caller not allowed" });
  });

  it("fails closed when the review itself fails", async () => {
    const broken: TokenReviewer = {
      async review() {
        throw new Error("apiserver down");
      },
    };
    const result = await authenticate("Bearer owner-token", broken, allowed);
    assert.deepEqual(result, { ok: false, status: 503, reason: "token review unavailable" });
  });
});

describe("KubernetesTokenReviewer", () => {
  let server: Server;
  let url: string;
  let seen: { method?: string; path?: string; authorization?: string; body?: unknown }[] = [];
  let reply: { status: number; body: unknown };
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "fraction-agents-auth-"));
    writeFileSync(join(dir, "token"), "sa-token\n");
    server = createServer(async (req: IncomingMessage, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  it("posts a TokenReview with its own ServiceAccount token and reads the status", async () => {
    seen = [];
    reply = {
      status: 201,
      body: {
        kind: "TokenReview",
        status: { authenticated: true, user: { username: OWNER }, audiences: [A2A_AUDIENCE] },
      },
    };
    const reviewer = new KubernetesTokenReviewer({ apiServer: url, tokenFile: join(dir, "token") });
    const result = await reviewer.review("caller-token", [A2A_AUDIENCE]);
    assert.deepEqual(result, { authenticated: true, username: OWNER, audiences: [A2A_AUDIENCE] });
    assert.deepEqual(seen, [
      {
        method: "POST",
        path: "/apis/authentication.k8s.io/v1/tokenreviews",
        authorization: "Bearer sa-token",
        body: {
          apiVersion: "authentication.k8s.io/v1",
          kind: "TokenReview",
          spec: { token: "caller-token", audiences: [A2A_AUDIENCE] },
        },
      },
    ]);
  });

  it("reports an unauthenticated token", async () => {
    reply = { status: 201, body: { kind: "TokenReview", status: { authenticated: false, error: "bad" } } };
    const reviewer = new KubernetesTokenReviewer({ apiServer: url, tokenFile: join(dir, "token") });
    assert.deepEqual(await reviewer.review("x", [A2A_AUDIENCE]), { authenticated: false });
  });

  it("throws when the apiserver refuses the review", async () => {
    reply = { status: 403, body: { kind: "Status", message: "forbidden" } };
    const reviewer = new KubernetesTokenReviewer({ apiServer: url, tokenFile: join(dir, "token") });
    await assert.rejects(reviewer.review("x", [A2A_AUDIENCE]), /403/);
  });
});
