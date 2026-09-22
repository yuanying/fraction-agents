import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { A2A_AUDIENCE, type TokenReviewer } from "../src/auth.ts";
import { parseConfig, type Config } from "../src/config.ts";
import { createHost, type Host } from "../src/host.ts";
import { PI_BASE_ENV } from "../src/sessions.ts";

const OWNER = "system:serviceaccount:fraction-agents:owner";
const CLAUDE = "system:serviceaccount:fraction-agents:claude";
const STRANGER = "system:serviceaccount:default:stranger";
const FAKE_PI = resolve(import.meta.dirname, "fixtures/fake-pi.ts");

const reviewer: TokenReviewer = {
  async review(token) {
    const users: Record<string, string> = { owner: OWNER, claude: CLAUDE, stranger: STRANGER };
    if (token === "apiserver") {
      return { authenticated: true, username: OWNER, audiences: ["https://kubernetes.default.svc"] };
    }
    const username = users[token];
    return username ? { authenticated: true, username, audiences: [A2A_AUDIENCE] } : { authenticated: false };
  },
};

type Json = any;

interface Running {
  host: Host;
  url: string;
  config: Config;
}

const running: Host[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close();
});

function makeConfig(dir: string, overrides: Record<string, unknown> = {}): Config {
  mkdirSync(join(dir, "agent"), { recursive: true });
  return parseConfig({
    name: "test-agent",
    description: "An agent for tests.",
    agentDir: join(dir, "agent"),
    dataDir: join(dir, "data"),
    allowedCallers: [OWNER, CLAUDE],
    publicUrl: "https://agents.example.test/test-agent",
    piCommand: [process.execPath, FAKE_PI],
    skills: [{ id: "echo", name: "Echo", description: "Echoes the request." }],
    ...overrides,
  });
}

async function start(config: Config, now?: () => number): Promise<Running> {
  const host = createHost({ config, tokenReviewer: reviewer, ...(now ? { now } : {}) });
  running.push(host);
  const url = await host.listen(0, "127.0.0.1");
  return { host, url, config };
}

async function post(url: string, token: string | undefined, method: string, params: Json): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { "content-type": "application/json", "a2a-version": "1.0" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function rpc(url: string, token: string, method: string, params: Json): Promise<Json> {
  const { status, body } = await post(url, token, method, params);
  assert.equal(status, 200, JSON.stringify(body));
  return body;
}

function message(text: string, extra: Record<string, unknown> = {}): Json {
  return { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], ...extra };
}

async function send(url: string, token: string, text: string, extra: Record<string, unknown> = {}): Promise<Json> {
  const body = await rpc(url, token, "SendMessage", { message: message(text, extra), configuration: { returnImmediately: true } });
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result.task;
}

const TERMINAL = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"]);

async function waitForTask(url: string, token: string, id: string): Promise<Json> {
  for (let i = 0; i < 200; i++) {
    const body = await rpc(url, token, "GetTask", { id });
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    if (TERMINAL.has(body.result.status.state)) return body.result;
    await sleep(25);
  }
  throw new Error(`task ${id} did not finish`);
}

function resultText(task: Json): string {
  return task.artifacts?.[0]?.parts?.[0]?.text;
}

function statusText(task: Json): string {
  return task.status?.message?.parts?.[0]?.text ?? "";
}

function spawns(config: Config): string[] {
  const log = join(config.workDir, "spawns.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fraction-agents-host-"));
}

describe("agent card", () => {
  it("is served without credentials and describes the agent from the config", async () => {
    const { url } = await start(makeConfig(tempDir()));
    const response = await fetch(`${url}/.well-known/agent-card.json`);
    assert.equal(response.status, 200);
    const card = await response.json();
    assert.equal(card.name, "test-agent");
    assert.equal(card.description, "An agent for tests.");
    assert.deepEqual(card.supportedInterfaces, [
      { url: "https://agents.example.test/test-agent", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ]);
    assert.equal(card.skills[0].id, "echo");
    assert.deepEqual(card.securitySchemes, { bearer: { httpAuthSecurityScheme: { scheme: "Bearer", bearerFormat: "JWT", description: card.securitySchemes.bearer.httpAuthSecurityScheme.description } } });
    // Scopes as a plain list, the form a2a-go (the official a2a-cli) reads.
    assert.deepEqual(card.securityRequirements, [{ schemes: { bearer: [] } }]);
  });

  it("answers the health check without credentials", async () => {
    const { url } = await start(makeConfig(tempDir()));
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
  });
});

describe("authentication", () => {
  it("rejects a request without a token", async () => {
    const { url } = await start(makeConfig(tempDir()));
    assert.equal((await post(url, undefined, "SendMessage", { message: message("hi") })).status, 401);
  });

  it("rejects a token for another audience", async () => {
    const { url } = await start(makeConfig(tempDir()));
    assert.equal((await post(url, "apiserver", "SendMessage", { message: message("hi") })).status, 401);
  });

  it("rejects a ServiceAccount that is not allowed", async () => {
    const { url, config } = await start(makeConfig(tempDir()));
    assert.equal((await post(url, "stranger", "SendMessage", { message: message("hi") })).status, 403);
    assert.deepEqual(spawns(config), [], "no pi process is started");
  });
});

describe("tasks and contexts", () => {
  it("returns at once and completes the task with the last assistant text", async () => {
    const { url, config } = await start(makeConfig(tempDir()));
    const task = await send(url, "owner", "hello");
    assert.match(task.id, /^[0-9a-f-]{36}$/);
    assert.match(task.contextId, /^[0-9a-f-]{36}$/);
    const done = await waitForTask(url, "owner", task.id);
    assert.equal(done.status.state, "TASK_STATE_COMPLETED");
    assert.equal(resultText(done), `echo:hello|turn=1|caller=${OWNER}|agentDir=${config.agentDir}`);
  });

  it("waits for the result when the caller does not ask to return at once", async () => {
    const { url } = await start(makeConfig(tempDir()));
    const body = await rpc(url, "owner", "SendMessage", { message: message("hello") });
    assert.equal(body.result.task.status.state, "TASK_STATE_COMPLETED");
    assert.match(resultText(body.result.task), /^echo:hello\|turn=1/);
  });

  it("numbers contexts itself and refuses one the caller made up", async () => {
    const { url, config } = await start(makeConfig(tempDir()));
    const body = await rpc(url, "owner", "SendMessage", {
      message: message("hello", { contextId: "my-own-context" }),
      configuration: { returnImmediately: true },
    });
    assert.ok(body.error, "an unknown contextId is an error");
    assert.equal(body.result, undefined);
    assert.deepEqual(spawns(config), []);
  });

  it("refuses to continue another caller's context", async () => {
    const { url, config } = await start(makeConfig(tempDir()));
    const first = await send(url, "owner", "hello");
    await waitForTask(url, "owner", first.id);
    const body = await rpc(url, "claude", "SendMessage", {
      message: message("let me in", { contextId: first.contextId }),
      configuration: { returnImmediately: true },
    });
    assert.ok(body.error, "someone else's context is an error");
    assert.equal(spawns(config).length, 1);
  });

  it("refuses a message addressed to an existing task", async () => {
    const { url } = await start(makeConfig(tempDir()));
    const first = await send(url, "owner", "wait:300");
    const body = await rpc(url, "owner", "SendMessage", {
      message: message("more", { contextId: first.contextId, taskId: first.id }),
      configuration: { returnImmediately: true },
    });
    assert.ok(body.error);
  });

  it("continues a context in the same session file and process", async () => {
    const { url, config } = await start(makeConfig(tempDir()));
    const first = await send(url, "owner", "one");
    await waitForTask(url, "owner", first.id);
    const second = await send(url, "owner", "two", { contextId: first.contextId });
    assert.equal(second.contextId, first.contextId);
    const done = await waitForTask(url, "owner", second.id);
    assert.match(resultText(done), /^echo:two\|turn=2\|/);
    const started = spawns(config);
    assert.equal(started.length, 1, "the same process takes the second task");
    assert.equal(resolve(started[0]!).startsWith(resolve(config.dataDir, "sessions")), true);
  });

  it("keeps separate contexts in separate sessions", async () => {
    const { url, config } = await start(makeConfig(tempDir()));
    const a = await send(url, "owner", "a");
    const b = await send(url, "owner", "b");
    assert.notEqual(a.contextId, b.contextId);
    assert.match(resultText(await waitForTask(url, "owner", a.id)), /turn=1/);
    assert.match(resultText(await waitForTask(url, "owner", b.id)), /turn=1/);
    const started = spawns(config);
    assert.equal(started.length, 2);
    assert.notEqual(started[0], started[1]);
  });

  it("stops an idle process and resumes the context from the same file", async () => {
    const { url, config } = await start(makeConfig(tempDir(), { idleTimeoutSeconds: 0.2 }));
    const first = await send(url, "owner", "one");
    await waitForTask(url, "owner", first.id);
    await sleep(600);
    const second = await send(url, "owner", "two", { contextId: first.contextId });
    const done = await waitForTask(url, "owner", second.id);
    assert.match(resultText(done), /^echo:two\|turn=2\|/);
    const started = spawns(config);
    assert.equal(started.length, 2, "a new process was started after the idle stop");
    assert.equal(started[0], started[1], "on the same session file");
  });

  it("fails the task when pi reports an error", async () => {
    const { url } = await start(makeConfig(tempDir()));
    const task = await send(url, "owner", "fail");
    const done = await waitForTask(url, "owner", task.id);
    assert.equal(done.status.state, "TASK_STATE_FAILED");
    assert.match(statusText(done), /model exploded/);
  });

  it("fails the task when pi exits, and restarts it for the next task", async () => {
    const { url, config } = await start(makeConfig(tempDir()));
    const task = await send(url, "owner", "crash");
    const done = await waitForTask(url, "owner", task.id);
    assert.equal(done.status.state, "TASK_STATE_FAILED");
    const next = await send(url, "owner", "again", { contextId: task.contextId });
    assert.equal((await waitForTask(url, "owner", next.id)).status.state, "TASK_STATE_COMPLETED");
    const started = spawns(config);
    assert.equal(started.length, 2);
    assert.equal(started[0], started[1]);
  });

  it("passes pi only the minimal environment, the agent's variables and the configured names", async () => {
    const planted = { HF_TOKEN: "hf-secret", OPENAI_API_KEY: "sk-secret", EXTRA_ALLOWED: "yes", EXTRA_DENIED: "no" };
    Object.assign(process.env, planted);
    try {
      const { url } = await start(makeConfig(tempDir(), { passEnv: ["EXTRA_ALLOWED"] }));
      const task = await send(url, "owner", "env");
      const names: string[] = JSON.parse(resultText(await waitForTask(url, "owner", task.id)));
      for (const name of ["HF_TOKEN", "OPENAI_API_KEY", "EXTRA_DENIED"]) {
        assert.equal(names.includes(name), false, `${name} must not reach pi`);
      }
      for (const name of ["EXTRA_ALLOWED", "PI_CODING_AGENT_DIR", "FRACTION_AGENTS_CALLER", "PATH", "HOME"]) {
        assert.equal(names.includes(name), true, `${name} reaches pi`);
      }
      const allowed = new Set(["EXTRA_ALLOWED", "PI_CODING_AGENT_DIR", "FRACTION_AGENTS_CALLER", ...PI_BASE_ENV]);
      assert.deepEqual(
        names.filter((name) => !allowed.has(name)),
        [],
        "nothing else reaches pi",
      );
    } finally {
      for (const name of Object.keys(planted)) delete process.env[name];
    }
  });

  it("rejects a second task while the context is busy", async () => {
    const { url } = await start(makeConfig(tempDir()));
    const first = await send(url, "owner", "wait:400");
    const second = await send(url, "owner", "two", { contextId: first.contextId });
    const rejected = await waitForTask(url, "owner", second.id);
    assert.equal(rejected.status.state, "TASK_STATE_REJECTED");
    assert.match(statusText(rejected), /busy/);
    assert.equal((await waitForTask(url, "owner", first.id)).status.state, "TASK_STATE_COMPLETED");
  });

  it("cancels a running task", async () => {
    const { url } = await start(makeConfig(tempDir()));
    const task = await send(url, "owner", "wait:5000");
    await sleep(100);
    const body = await rpc(url, "owner", "CancelTask", { id: task.id });
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.equal(body.result.status.state, "TASK_STATE_CANCELED");
    assert.equal((await waitForTask(url, "owner", task.id)).status.state, "TASK_STATE_CANCELED");
  });

  it("keeps tasks and contexts across a restart of the host", async () => {
    const dir = tempDir();
    const config = makeConfig(dir);
    const first = await start(config);
    const task = await send(first.url, "owner", "one");
    await waitForTask(first.url, "owner", task.id);
    await first.host.close();
    running.splice(running.indexOf(first.host), 1);

    const second = await start(config);
    const again = await rpc(second.url, "owner", "GetTask", { id: task.id });
    assert.equal(again.result.status.state, "TASK_STATE_COMPLETED");
    assert.match(resultText(again.result), /^echo:one\|turn=1/);
    const next = await send(second.url, "owner", "two", { contextId: task.contextId });
    assert.match(resultText(await waitForTask(second.url, "owner", next.id)), /^echo:two\|turn=2/);
  });

  it("lists only the caller's own tasks", async () => {
    const { url } = await start(makeConfig(tempDir()));
    const mine = await send(url, "owner", "mine");
    const theirs = await send(url, "claude", "theirs");
    await waitForTask(url, "owner", mine.id);
    await waitForTask(url, "claude", theirs.id);
    const owner = await rpc(url, "owner", "ListTasks", {});
    assert.deepEqual(
      owner.result.tasks.map((t: Json) => t.id),
      [mine.id],
    );
    const claude = await rpc(url, "claude", "ListTasks", {});
    assert.deepEqual(
      claude.result.tasks.map((t: Json) => t.id),
      [theirs.id],
    );
    const notFound = await rpc(url, "claude", "GetTask", { id: mine.id });
    assert.ok(notFound.error, "another caller's task is not found");
  });

  it("deletes sessions past the retention period and forgets their contexts", async () => {
    let clock = Date.parse("2026-09-22T00:00:00Z");
    const { url, host, config } = await start(makeConfig(tempDir(), { sessionRetentionSeconds: 3600 }), () => clock);
    const task = await send(url, "owner", "one");
    await waitForTask(url, "owner", task.id);
    const sessionFile = spawns(config)[0]!;
    assert.equal(existsSync(sessionFile), true);

    clock += 3599_000;
    await host.sweep();
    assert.equal(existsSync(sessionFile), true, "still within the retention period");

    clock += 2_000;
    await host.sweep();
    assert.equal(existsSync(sessionFile), false);
    const body = await rpc(url, "owner", "SendMessage", {
      message: message("two", { contextId: task.contextId }),
      configuration: { returnImmediately: true },
    });
    assert.ok(body.error, "the expired context cannot be continued");
  });
});
