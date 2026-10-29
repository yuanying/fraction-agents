import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import type { TokenReviewer } from "../src/auth.ts";
import type { Config } from "../src/config.ts";
import { createHost } from "../src/host.ts";
import {
  CLAUDE,
  makeConfig,
  message,
  OWNER,
  post,
  resultText,
  send,
  start,
  stop,
  STRANGER,
  tempDir,
  waitForTask,
  type Json,
} from "./fixtures/host-harness.ts";

// The A2A listener behind gated (ADR 0030): a ServiceAccount token for gated's audience is checked by gated, which
// sends the request on with an assertion of the ServiceAccount instead of the token.

const ISSUER = "https://auth.example.test";
const AGENT_URL = "https://test-agent.example.test/";
const AUDIENCE = "test-agent.example.test";
const REPLY = { summary: "A report", sections: [{ title: "Body", body: "Text." }], sources: [] };

interface Key {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKey(kid: string): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "EdDSA" } };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** An assertion the way gated signs it (gated ADR 0034), for `sub`, with what a test changes. */
function assertion(sub: string, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = current): string {
  const seconds = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "EdDSA", typ: "gated-assertion+jwt", kid: key.kid, ...header });
  const body = b64({ iss: ISSUER, sub, aud: AUDIENCE, iat: seconds, exp: seconds + 60, ...claims });
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
}

const current = makeKey("key-1");
const jwks = { keys: [current] as Key[], fetches: 0 };
let jwksServer: Server;
let jwksUrl: string;

before(async () => {
  jwksServer = createServer((_req, res) => {
    jwks.fetches++;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
    res.end(JSON.stringify({ keys: jwks.keys.map((key) => key.jwk) }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/__gated/jwks.json`;
});

after(() => jwksServer.close());

beforeEach(() => {
  jwks.keys = [current];
  jwks.fetches = 0;
});

function gatedConfig(overrides: Record<string, unknown> = {}): Config {
  return makeConfig(tempDir(), { publicUrl: AGENT_URL, gated: { issuer: ISSUER, jwksUrl }, ...overrides });
}

/** A JSON-RPC call with whatever credentials a test gives: an assertion, a bearer token, both or none. */
async function call(
  url: string,
  credentials: { assertion?: string; token?: string },
  method = "SendMessage",
  params: Json = { message: message("hello") },
): Promise<{ status: number; body: Json; headers: Headers }> {
  return post(url, credentials.token, method, params, credentials.assertion === undefined ? {} : { "gated-assertion": credentials.assertion });
}

/** The status of a GET with an assertion and a `Host` of the test's choosing, which fetch would not send. */
function getWithHost(url: string, assertion: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}/reports`, { headers: { host, "gated-assertion": assertion } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function sendAs(url: string, sub: string, text = "hello"): Promise<Json> {
  const { status, body } = await call(url, { assertion: assertion(sub) }, "SendMessage", {
    message: message(text),
    configuration: { returnImmediately: true },
  });
  assert.equal(status, 200, JSON.stringify(body));
  return body.result.task;
}

async function taskAs(url: string, sub: string, id: string): Promise<Json> {
  for (let i = 0; i < 200; i++) {
    const { status, body } = await call(url, { assertion: assertion(sub) }, "GetTask", { id });
    assert.equal(status, 200, JSON.stringify(body));
    if (body.result.status.state === "TASK_STATE_COMPLETED") return body.result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`task ${id} did not finish`);
}

describe("gated's assertion on the A2A listener", () => {
  it("lets in a ServiceAccount in allowedCallers, named the way a TokenReview names it", async () => {
    const { url, config } = await start(gatedConfig());
    const task = await sendAs(url, CLAUDE);
    const done = await taskAs(url, CLAUDE, task.id);
    assert.equal(resultText(done), `echo:hello|turn=1|caller=${CLAUDE}|agentDir=${config.agentDir}`);
    // The same caller as by its bearer token: the task is the caller's either way.
    assert.equal((await waitForTask(url, "claude", task.id)).id, task.id);
  });

  it("refuses a subject that is not in allowedCallers with 403", async () => {
    const { url } = await start(gatedConfig());
    for (const sub of [STRANGER, "github:alice", "system:serviceaccount:fraction-agents"]) {
      const { status, body } = await call(url, { assertion: assertion(sub) });
      assert.equal(status, 403, sub);
      assert.deepEqual(body, { error: "caller not allowed" });
    }
  });

  it("refuses an assertion that fails any of the steps 1 to 7 with 401, without saying which", async () => {
    const { url } = await start(gatedConfig());
    const seconds = Math.floor(Date.now() / 1000);
    const forger = makeKey("key-1");
    const cases: Record<string, string> = {
      "empty": "",
      "not a JWS": "a.b.c",
      "alg none": assertion(OWNER, {}, { alg: "none" }),
      "alg HS256": assertion(OWNER, {}, { alg: "HS256" }),
      "another type": assertion(OWNER, {}, { typ: "JWT" }),
      "no kid": assertion(OWNER, {}, { kid: undefined }),
      "a key not in the JWKS": assertion(OWNER, {}, {}, makeKey("key-9")),
      "a key named in the assertion": assertion(OWNER, {}, { kid: "key-9", jwk: makeKey("key-9").jwk, jku: "https://evil.example/jwks" }),
      "a forged signature": assertion(OWNER, {}, {}, forger),
      "a signature with more after it": `${assertion(OWNER)}A`,
      "another issuer": assertion(OWNER, { iss: "https://login.example.test" }),
      "another host": assertion(OWNER, { aud: "other-agent.example.test" }),
      "the host with a port": assertion(OWNER, { aud: `${AUDIENCE}:443` }),
      "expired beyond the skew": assertion(OWNER, { iat: seconds - 100, exp: seconds - 35 }),
      "issued too far ahead": assertion(OWNER, { iat: seconds + 35, exp: seconds + 95 }),
      "no exp": assertion(OWNER, { exp: undefined }),
    };
    for (const [name, value] of Object.entries(cases)) {
      const { status, body, headers } = await call(url, { assertion: value });
      assert.equal(status, 401, name);
      assert.deepEqual(body, { error: "invalid assertion" }, name);
      assert.equal(headers.get("www-authenticate"), 'Bearer realm="a2a"', name);
    }
  });

  it("allows some 30 seconds of clock skew on exp and iat", async () => {
    const { url } = await start(gatedConfig());
    const seconds = Math.floor(Date.now() / 1000);
    assert.equal((await call(url, { assertion: assertion(OWNER, { iat: seconds - 85, exp: seconds - 25 }) })).status, 200);
    assert.equal((await call(url, { assertion: assertion(OWNER, { iat: seconds + 25, exp: seconds + 85 }) })).status, 200);
  });

  it("compares aud with its publicUrl, not with the request's Host", async () => {
    const { url } = await start(gatedConfig({ reports: {} }));
    const elsewhere = assertion(OWNER, { aud: "other-agent.example.test" });
    assert.equal(await getWithHost(url, elsewhere, "other-agent.example.test"), 401);
    assert.equal(await getWithHost(url, assertion(OWNER), "other-agent.example.test"), 200);
    assert.equal(await getWithHost(url, assertion(OWNER), AUDIENCE), 200);
  });

  it("fetches the keys again for an unknown kid only once a minute has passed since the last fetch", async () => {
    const { url } = await start(gatedConfig());
    assert.equal((await call(url, { assertion: assertion(OWNER) })).status, 200);
    assert.equal(jwks.fetches, 1);
    const next = makeKey("key-2");
    jwks.keys = [current, next];
    assert.equal((await call(url, { assertion: assertion(OWNER, {}, {}, next) })).status, 401);
    assert.equal((await call(url, { assertion: assertion(OWNER, {}, {}, next) })).status, 401);
    assert.equal(jwks.fetches, 1, "not fetched again so soon, however many requests come");
  });

  it("guards the images, the reports and every other way in the same as the bearer token does", async () => {
    const { url } = await start(gatedConfig({ reports: {} }));
    const task = await sendAs(url, OWNER, `reply:${JSON.stringify(REPLY)}`);
    await taskAs(url, OWNER, task.id);
    const get = (path: string, headers: Record<string, string>) => fetch(`${url}${path}`, { headers });
    const list = await get("/reports", { "gated-assertion": assertion(OWNER) });
    assert.equal(list.status, 200);
    const [report] = (await list.json()).reports;
    assert.equal(report.id, task.id);
    assert.equal(report.owner, OWNER, "the owner is the subject, as a TokenReview would name it");
    assert.equal((await get(`/reports/${task.id}.md`, { authorization: "Bearer owner" })).status, 200);
    assert.equal((await get(`/reports/${task.id}.md`, { "gated-assertion": assertion(CLAUDE) })).status, 404);
    assert.equal((await get("/reports", { "gated-assertion": assertion(STRANGER) })).status, 403);
    assert.equal((await get("/reports", { "gated-assertion": `${assertion(OWNER)}A` })).status, 401);
    assert.equal((await get(`/artifacts/${crypto.randomUUID()}`, { "gated-assertion": assertion(STRANGER) })).status, 403);
  });

  it("lets a caller in readAllCallers read every caller's reports by its assertion", async () => {
    const { url } = await start(gatedConfig({ reports: { readAllCallers: [CLAUDE] } }));
    const task = await send(url, "owner", `reply:${JSON.stringify(REPLY)}`);
    await waitForTask(url, "owner", task.id);
    const response = await fetch(`${url}/reports/${task.id}.md`, { headers: { "gated-assertion": assertion(CLAUDE) } });
    assert.equal(response.status, 200);
  });

  it("serves the Agent Card and the health check without credentials, and says the card takes either token", async () => {
    const { url } = await start(gatedConfig());
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    const card = await (await fetch(`${url}/.well-known/agent-card.json`)).json();
    assert.match(card.securitySchemes.bearer.httpAuthSecurityScheme.description, /a2a audience/);
    assert.match(card.securitySchemes.bearer.httpAuthSecurityScheme.description, /gated/);
  });
});

describe("an assertion and a bearer token together", () => {
  it("goes by the assertion and does not look at the bearer token", async () => {
    const { url, config } = await start(gatedConfig());
    const { status, body } = await call(url, { assertion: assertion(CLAUDE), token: "owner" }, "SendMessage", {
      message: message("hello"),
    });
    assert.equal(status, 200);
    assert.equal(resultText(body.result.task), `echo:hello|turn=1|caller=${CLAUDE}|agentDir=${config.agentDir}`);
  });

  it("does not fall back on the bearer token when the assertion fails", async () => {
    const { url } = await start(gatedConfig());
    assert.equal((await call(url, { assertion: `${assertion(OWNER)}A`, token: "owner" })).status, 401);
    assert.equal((await call(url, { assertion: assertion(OWNER, { aud: "other-agent.example.test" }), token: "owner" })).status, 401);
    assert.equal((await call(url, { assertion: assertion("github:alice"), token: "owner" })).status, 403);
  });

  it("takes an assertion without asking for a TokenReview", async () => {
    const broken: TokenReviewer = {
      async review() {
        throw new Error("apiserver down");
      },
    };
    const host = createHost({ config: gatedConfig(), tokenReviewer: broken });
    try {
      const url = await host.listen(0, "127.0.0.1");
      assert.equal((await call(url, { assertion: assertion(OWNER), token: "owner" })).status, 200);
      assert.equal((await call(url, { token: "owner" })).status, 503);
    } finally {
      await host.close();
    }
  });

  it("still takes a bearer token alone", async () => {
    const { url } = await start(gatedConfig());
    assert.equal((await call(url, { token: "owner" })).status, 200);
    assert.equal((await call(url, {})).status, 401);
  });
});

describe("the A2A listener without gated in the config", () => {
  it("ignores an assertion and goes by the bearer token alone, as before", async () => {
    const running = await start(makeConfig(tempDir(), { publicUrl: AGENT_URL }));
    const { url, config } = running;
    assert.equal((await call(url, { assertion: assertion(OWNER) })).status, 401);
    const { status, body } = await call(url, { assertion: assertion(OWNER), token: "claude" }, "SendMessage", {
      message: message("hello"),
    });
    assert.equal(status, 200);
    assert.equal(resultText(body.result.task), `echo:hello|turn=1|caller=${CLAUDE}|agentDir=${config.agentDir}`);
    assert.equal(jwks.fetches, 0, "gated's keys are never fetched");
    const card = await (await fetch(`${url}/.well-known/agent-card.json`)).json();
    assert.doesNotMatch(card.securitySchemes.bearer.httpAuthSecurityScheme.description, /gated/);
    await stop(running.host);
  });
});
