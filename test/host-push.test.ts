// Push notifications of task updates to the URLs the config allows (ADR 0032).
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { createHost, type Host } from "../src/host.ts";
import {
  makeConfig,
  message,
  reviewer,
  rpc,
  tempDir,
  waitForState,
  waitForTask,
  type Json,
} from "./fixtures/host-harness.ts";

const PUSH_URL = "https://natsumi.example.test/v1/a2a-push";
const PUSH = { pushNotifications: { allowedUrlPrefixes: ["https://natsumi.example.test/v1/a2a-push"] } };

interface Sent {
  url: string;
  authorization: string | undefined;
  redirect: RequestRedirect | undefined;
  body: Json;
}

const hosts: Host[] = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.close();
});

/** A host whose pushes are recorded instead of sent. */
async function startPushing(overrides: Record<string, unknown> = PUSH): Promise<{ url: string; sent: Sent[] }> {
  const sent: Sent[] = [];
  const pushFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(input),
      authorization: headers.get("authorization") ?? undefined,
      redirect: init?.redirect,
      body: JSON.parse(String(init?.body)),
    });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const host = createHost({ config: makeConfig(tempDir(), overrides), tokenReviewer: reviewer, pushFetch });
  hosts.push(host);
  return { url: await host.listen(0, "127.0.0.1"), sent };
}

function withPush(url: string, credentials: string | undefined = "token-1"): Json {
  return { url, ...(credentials === undefined ? {} : { authentication: { scheme: "Bearer", credentials } }) };
}

async function sendWithPush(url: string, token: string, text: string, push: Json, extra: Json = {}): Promise<Json> {
  const body = await rpc(url, token, "SendMessage", {
    message: message(text, extra),
    configuration: { returnImmediately: true, taskPushNotificationConfig: push },
  });
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result.task;
}

async function configsOf(url: string, token: string, taskId: string): Promise<Json[]> {
  const body = await rpc(url, token, "ListTaskPushNotificationConfigs", { taskId });
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result.configs ?? [];
}

/** Waits for the pushes to settle: none new for a while. */
async function settled(sent: Sent[]): Promise<void> {
  let count = -1;
  while (count !== sent.length) {
    count = sent.length;
    await sleep(100);
  }
}

function states(sent: Sent[]): string[] {
  return sent.map((each) => each.body.task?.status?.state ?? each.body.statusUpdate?.status?.state ?? (each.body.artifactUpdate ? "artifact" : "?"));
}

function logged(spy: { mock: { calls: { arguments: unknown[] }[] } }): string[] {
  return spy.mock.calls.map((call) => call.arguments.map(String).join(" "));
}

describe("the agent card and push notifications", () => {
  it("does not offer push notifications when the config allows no URL", async () => {
    const { url } = await startPushing({});
    const card = await (await fetch(`${url}/.well-known/agent-card.json`)).json();
    assert.equal(card.capabilities.pushNotifications ?? false, false);
  });

  it("offers push notifications when the config allows URLs", async () => {
    const { url } = await startPushing();
    const card = await (await fetch(`${url}/.well-known/agent-card.json`)).json();
    assert.equal(card.capabilities.pushNotifications, true);
  });
});

describe("push notifications (ADR 0032)", () => {
  it("posts every update of the task to the allowed URL with the caller's token, without following redirects", async () => {
    const { url, sent } = await startPushing();
    const task = await sendWithPush(url, "owner", "hello", withPush(PUSH_URL));
    assert.equal((await waitForTask(url, "owner", task.id)).status.state, "TASK_STATE_COMPLETED");
    await settled(sent);
    assert.ok(sent.length >= 3, JSON.stringify(states(sent)));
    assert.equal(states(sent).at(-1), "TASK_STATE_COMPLETED");
    for (const each of sent) {
      assert.equal(each.url, PUSH_URL);
      assert.equal(each.authorization, "Bearer token-1");
      assert.equal(each.redirect, "manual");
    }
  });

  it("forgets the config once the task finishes", async () => {
    const { url, sent } = await startPushing();
    const task = await sendWithPush(url, "owner", "hello", withPush(PUSH_URL));
    await waitForTask(url, "owner", task.id);
    await settled(sent);
    assert.deepEqual(await configsOf(url, "owner", task.id), []);
  });

  it("takes the task without the push config when the URL is not allowed, and logs why", async (t) => {
    const log = t.mock.method(console, "log");
    const { url, sent } = await startPushing();
    const task = await sendWithPush(url, "owner", "hello", withPush("https://natsumi.example.test.evil.test/v1/a2a-push", "secret-1"));
    assert.equal((await waitForTask(url, "owner", task.id)).status.state, "TASK_STATE_COMPLETED");
    await settled(sent);
    assert.deepEqual(sent, []);
    const lines = logged(log).filter((line) => line.includes("push"));
    assert.equal(lines.length, 1, JSON.stringify(logged(log)));
    assert.match(lines[0]!, new RegExp(task.id));
    assert.match(lines[0]!, /system:serviceaccount:fraction-agents:owner/);
    assert.match(lines[0]!, /not allowed/);
    assert.doesNotMatch(lines[0]!, /secret-1/);
    assert.doesNotMatch(lines[0]!, /natsumi\.example\.test\/v1/, "the allowed prefixes are not logged");
  });

  it("takes the task without the push config when it has no Bearer credentials", async (t) => {
    const log = t.mock.method(console, "log");
    const { url, sent } = await startPushing();
    const task = await sendWithPush(url, "owner", "hello", { url: PUSH_URL, token: "legacy" });
    await waitForTask(url, "owner", task.id);
    await settled(sent);
    assert.deepEqual(sent, []);
    const lines = logged(log).filter((line) => line.includes("push"));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /Bearer/);
    assert.doesNotMatch(lines[0]!, /legacy/);
  });

  it("refuses to create a config for a URL that is not allowed", async () => {
    const { url, sent } = await startPushing();
    const task = await sendWithPush(url, "owner", "ask:Which page?", withPush(PUSH_URL));
    await waitForState(url, "owner", task.id, "TASK_STATE_INPUT_REQUIRED");
    const body = await rpc(url, "owner", "CreateTaskPushNotificationConfig", {
      taskId: task.id,
      url: "http://10.0.0.1/metadata",
      authentication: { scheme: "Bearer", credentials: "token-2" },
    });
    assert.ok(body.error, "refused");
    assert.equal(body.error.code, -32602);
    const configs = await configsOf(url, "owner", task.id);
    assert.equal(configs.length, 1);
    assert.equal(configs[0].url, PUSH_URL);
    assert.ok(sent.every((each) => each.url === PUSH_URL));
  });

  it("refuses to create a config without Bearer credentials", async () => {
    const { url } = await startPushing();
    const task = await sendWithPush(url, "owner", "ask:Which page?", withPush(PUSH_URL));
    await waitForState(url, "owner", task.id, "TASK_STATE_INPUT_REQUIRED");
    const body = await rpc(url, "owner", "CreateTaskPushNotificationConfig", { taskId: task.id, url: PUSH_URL, token: "legacy" });
    assert.equal(body.error?.code, -32602);
  });

  it("creates a config for an allowed URL, in place of the task's config", async () => {
    const { url, sent } = await startPushing();
    const task = await sendWithPush(url, "owner", "ask:Which page?", withPush(PUSH_URL));
    await waitForState(url, "owner", task.id, "TASK_STATE_INPUT_REQUIRED");
    const body = await rpc(url, "owner", "CreateTaskPushNotificationConfig", {
      taskId: task.id,
      ...withPush(`${PUSH_URL}/second`, "token-2"),
    });
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    const configs = await configsOf(url, "owner", task.id);
    assert.deepEqual(
      configs.map((each) => each.authentication.credentials),
      ["token-2"],
    );
    await settled(sent);
    const before = sent.length;
    await rpc(url, "owner", "SendMessage", {
      message: message("the index", { contextId: task.contextId, taskId: task.id }),
      configuration: { returnImmediately: true },
    });
    await waitForTask(url, "owner", task.id);
    await settled(sent);
    assert.ok(sent.length > before);
    assert.ok(sent.slice(before).every((each) => each.authorization === "Bearer token-2"));
  });

  it("refuses to create a config for a finished task", async () => {
    const { url, sent } = await startPushing();
    const task = await sendWithPush(url, "owner", "hello", withPush(PUSH_URL));
    await waitForTask(url, "owner", task.id);
    await settled(sent);
    const body = await rpc(url, "owner", "CreateTaskPushNotificationConfig", { taskId: task.id, ...withPush(PUSH_URL, "token-2") });
    assert.ok(body.error, "refused");
    assert.deepEqual(await configsOf(url, "owner", task.id), []);
  });

  it("replaces the config with the one sent with the answer to a question", async () => {
    const { url, sent } = await startPushing();
    const task = await sendWithPush(url, "owner", "ask:Which page?", withPush(PUSH_URL, "token-1"));
    await waitForState(url, "owner", task.id, "TASK_STATE_INPUT_REQUIRED");
    await settled(sent);
    const before = sent.length;
    assert.ok(before > 0);
    assert.ok(sent.every((each) => each.authorization === "Bearer token-1"));
    await sendWithPush(url, "owner", "the index", withPush(PUSH_URL, "token-2"), { contextId: task.contextId, taskId: task.id });
    assert.equal((await waitForTask(url, "owner", task.id)).status.state, "TASK_STATE_COMPLETED");
    await settled(sent);
    assert.ok(sent.length > before);
    assert.ok(
      sent.slice(before).every((each) => each.authorization === "Bearer token-2"),
      JSON.stringify(sent.slice(before).map((each) => each.authorization)),
    );
    assert.deepEqual(await configsOf(url, "owner", task.id), []);
  });

  it("keeps the config when the answer to a question comes without one", async () => {
    const { url, sent } = await startPushing();
    const task = await sendWithPush(url, "owner", "ask:Which page?", withPush(PUSH_URL, "token-1"));
    await waitForState(url, "owner", task.id, "TASK_STATE_INPUT_REQUIRED");
    await settled(sent);
    const before = sent.length;
    await rpc(url, "owner", "SendMessage", {
      message: message("the index", { contextId: task.contextId, taskId: task.id }),
      configuration: { returnImmediately: true },
    });
    await waitForTask(url, "owner", task.id);
    await settled(sent);
    assert.ok(sent.length > before);
    assert.ok(sent.every((each) => each.authorization === "Bearer token-1"));
  });

  it("does not show a caller's config to another caller", async () => {
    const { url } = await startPushing();
    const task = await sendWithPush(url, "owner", "ask:Which page?", withPush(PUSH_URL));
    await waitForState(url, "owner", task.id, "TASK_STATE_INPUT_REQUIRED");
    const body = await rpc(url, "claude", "ListTaskPushNotificationConfigs", { taskId: task.id });
    assert.ok(body.error, "another caller's task is not found");
    const created = await rpc(url, "claude", "CreateTaskPushNotificationConfig", { taskId: task.id, ...withPush(PUSH_URL, "token-2") });
    assert.ok(created.error, "nor can another caller add one");
  });

  it("forgets the config of a task canceled while it waits for an answer", async () => {
    const { url, sent } = await startPushing();
    const task = await sendWithPush(url, "owner", "ask:Which page?", withPush(PUSH_URL));
    await waitForState(url, "owner", task.id, "TASK_STATE_INPUT_REQUIRED");
    await rpc(url, "owner", "CancelTask", { id: task.id });
    await settled(sent);
    assert.deepEqual(await configsOf(url, "owner", task.id), []);
  });

  it("forgets the config of a task whose question nobody answers in time", async () => {
    const { url, sent } = await startPushing({ ...PUSH, inputTimeoutSeconds: 0.3 });
    const task = await sendWithPush(url, "owner", "ask:Which page?", withPush(PUSH_URL));
    await waitForState(url, "owner", task.id, "TASK_STATE_INPUT_REQUIRED");
    assert.equal((await waitForTask(url, "owner", task.id)).status.state, "TASK_STATE_FAILED");
    await settled(sent);
    assert.deepEqual(await configsOf(url, "owner", task.id), []);
  });
});

describe("an agent without push notifications", () => {
  it("ignores the push config of a message, as before", async () => {
    const { url, sent } = await startPushing({});
    const task = await sendWithPush(url, "owner", "hello", withPush(PUSH_URL));
    assert.equal((await waitForTask(url, "owner", task.id)).status.state, "TASK_STATE_COMPLETED");
    await settled(sent);
    assert.deepEqual(sent, []);
  });

  it("refuses the push config methods", async () => {
    const { url } = await startPushing({});
    const task = await sendWithPush(url, "owner", "hello", withPush(PUSH_URL));
    const body = await rpc(url, "owner", "CreateTaskPushNotificationConfig", { taskId: task.id, ...withPush(PUSH_URL) });
    assert.equal(body.error?.code, -32003);
  });
});
