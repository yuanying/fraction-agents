import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import { TaskState, type StreamResponse, type Task, type TaskPushNotificationConfig } from "@a2a-js/sdk";
import { ServerCallContext, type User } from "@a2a-js/sdk/server";

import { allowedPushUrl, pushConfigProblem, PushConfigs, PushSender } from "../src/push.ts";

const OWNER = "system:serviceaccount:fraction-agents:owner";
const OTHER = "system:serviceaccount:fraction-agents:other";

function as(name: string): ServerCallContext {
  const user: User = { isAuthenticated: true, userName: name };
  return new ServerCallContext({ user });
}

function pushConfig(url: string, overrides: Partial<TaskPushNotificationConfig> = {}): TaskPushNotificationConfig {
  return {
    tenant: "",
    id: "",
    taskId: "task-1",
    url,
    token: "",
    authentication: { scheme: "Bearer", credentials: "secret-token" },
    ...overrides,
  };
}

function statusUpdate(taskId: string, state: TaskState): StreamResponse {
  return {
    payload: {
      $case: "statusUpdate",
      value: { taskId, contextId: "context-1", status: { state, message: undefined, timestamp: new Date().toISOString() }, metadata: {} },
    },
  };
}

function task(id: string, state: TaskState): Task {
  return {
    id,
    contextId: "context-1",
    status: { state, message: undefined, timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    metadata: {},
  };
}

describe("allowed push URLs (ADR 0032)", () => {
  const prefixes = ["https://a.example/v1/a2a-push", "https://b.example:8443/"];

  it("allows the prefix itself and the paths under it", () => {
    assert.equal(allowedPushUrl("https://a.example/v1/a2a-push", prefixes), true);
    assert.equal(allowedPushUrl("https://a.example/v1/a2a-push/task", prefixes), true);
    assert.equal(allowedPushUrl("https://A.EXAMPLE:443/v1/a2a-push", prefixes), true, "the URL is normalized");
    assert.equal(allowedPushUrl("https://b.example:8443/anything", prefixes), true);
  });

  it("compares the host name as a whole, not as a prefix of the string", () => {
    assert.equal(allowedPushUrl("https://a.example.evil.test/v1/a2a-push", prefixes), false);
    assert.equal(allowedPushUrl("https://evila.example/v1/a2a-push", prefixes), false);
  });

  it("compares the path by its segments", () => {
    assert.equal(allowedPushUrl("https://a.example/v1/a2a-pushes", prefixes), false);
    assert.equal(allowedPushUrl("https://a.example/v1", prefixes), false);
    assert.equal(allowedPushUrl("https://a.example/v1/a2a-push/../../admin", prefixes), false, "dot segments are resolved first");
  });

  it("requires the same scheme and port", () => {
    assert.equal(allowedPushUrl("http://a.example/v1/a2a-push", prefixes), false);
    assert.equal(allowedPushUrl("https://a.example:8443/v1/a2a-push", prefixes), false);
    assert.equal(allowedPushUrl("https://b.example/anything", prefixes), false);
  });

  it("refuses a URL with a user name or password, or one that is not a URL", () => {
    assert.equal(allowedPushUrl("https://user@a.example/v1/a2a-push", prefixes), false);
    assert.equal(allowedPushUrl("https://user:pass@a.example/v1/a2a-push", prefixes), false);
    assert.equal(allowedPushUrl("/v1/a2a-push", prefixes), false);
    assert.equal(allowedPushUrl("", prefixes), false);
  });
});

describe("push configs taken (ADR 0032)", () => {
  const prefixes = ["https://a.example/v1/a2a-push"];

  it("takes an allowed URL with Bearer credentials", () => {
    assert.equal(pushConfigProblem(pushConfig("https://a.example/v1/a2a-push"), prefixes), undefined);
    assert.equal(
      pushConfigProblem(pushConfig("https://a.example/v1/a2a-push", { authentication: { scheme: "bearer", credentials: "x" } }), prefixes),
      undefined,
      "the scheme is case-insensitive",
    );
  });

  it("refuses a URL that is not allowed", () => {
    assert.match(pushConfigProblem(pushConfig("https://a.example.evil.test/v1/a2a-push"), prefixes)!, /not allowed/);
  });

  it("refuses a config without Bearer credentials", () => {
    const url = "https://a.example/v1/a2a-push";
    for (const authentication of [undefined, { scheme: "Basic", credentials: "x" }, { scheme: "Bearer", credentials: "" }]) {
      assert.match(pushConfigProblem(pushConfig(url, { authentication }), prefixes)!, /Bearer/);
    }
    assert.match(pushConfigProblem(pushConfig(url, { authentication: undefined, token: "legacy" }), prefixes)!, /Bearer/);
  });
});

describe("the push config store", () => {
  it("keeps one config per task, the last one saved", async () => {
    const configs = new PushConfigs();
    const first = pushConfig("https://a.example/one");
    await configs.save("task-1", as(OWNER), first);
    assert.notEqual(first.id, "", "an id is given in place");
    await configs.save("task-1", as(OWNER), pushConfig("https://a.example/two"));
    const loaded = await configs.load("task-1", as(OWNER));
    assert.deepEqual(
      loaded.map((each) => each.url),
      ["https://a.example/two"],
    );
  });

  it("keeps each caller's configs apart", async () => {
    const configs = new PushConfigs();
    await configs.save("task-1", as(OWNER), pushConfig("https://a.example/one"));
    assert.deepEqual(await configs.load("task-1", as(OTHER)), []);
    await configs.delete("task-1", as(OTHER), (await configs.load("task-1", as(OWNER)))[0]!.id);
    assert.equal((await configs.load("task-1", as(OWNER))).length, 1, "another caller cannot delete it");
  });

  it("deletes a config by its id, and forgets a task's config", async () => {
    const configs = new PushConfigs();
    await configs.save("task-1", as(OWNER), pushConfig("https://a.example/one"));
    await configs.delete("task-1", as(OWNER), "another-id");
    assert.equal((await configs.load("task-1", as(OWNER))).length, 1);
    await configs.delete("task-1", as(OWNER), (await configs.load("task-1", as(OWNER)))[0]!.id);
    assert.deepEqual(await configs.load("task-1", as(OWNER)), []);
    await configs.save("task-1", as(OWNER), pushConfig("https://a.example/one"));
    configs.forget("task-1", OWNER);
    assert.deepEqual(await configs.load("task-1", as(OWNER)), []);
    assert.equal(configs.size, 0);
  });
});

interface Received {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

const servers: Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** An HTTP receiver answering each POST with `status` (and `location`), recording what it got. */
async function receiver(status = 204, location?: string, delayMs = 0): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body });
      setTimeout(() => {
        if (location) res.setHeader("Location", location);
        res.statusCode = status;
        res.end();
      }, delayMs);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

describe("the push sender (ADR 0032)", () => {
  async function setup(url: string, options: { timeoutMs?: number } = {}) {
    const configs = new PushConfigs();
    const logs: string[] = [];
    // The receivers here are plain HTTP on the loopback; the config only takes https prefixes.
    const sender = new PushSender({ configs, prefixes: [url], log: (line) => logs.push(line), ...options });
    return { configs, sender, logs };
  }

  it("posts each event to the task's config with the caller's credentials", async () => {
    const target = await receiver();
    const { configs, sender, logs } = await setup(target.url);
    await configs.save("task-1", as(OWNER), pushConfig(`${target.url}/v1/a2a-push`));
    await sender.send(statusUpdate("task-1", TaskState.TASK_STATE_WORKING), as(OWNER), task("task-1", TaskState.TASK_STATE_WORKING));
    assert.equal(target.received.length, 1);
    const [got] = target.received;
    assert.equal(got!.path, "/v1/a2a-push");
    assert.equal(got!.headers.authorization, "Bearer secret-token");
    assert.equal(got!.headers["content-type"], "application/a2a+json");
    assert.equal(JSON.parse(got!.body).statusUpdate.taskId, "task-1");
    assert.deepEqual(logs, []);
  });

  it("sends nothing for a task without a config, or for another caller's", async () => {
    const target = await receiver();
    const { configs, sender } = await setup(target.url);
    await configs.save("task-1", as(OWNER), pushConfig(`${target.url}/v1/a2a-push`));
    await sender.send(statusUpdate("task-2", TaskState.TASK_STATE_WORKING), as(OWNER));
    await sender.send(statusUpdate("task-1", TaskState.TASK_STATE_WORKING), as(OTHER));
    assert.equal(target.received.length, 0);
  });

  it("does not follow a redirect, and counts it as a failure", async () => {
    const elsewhere = await receiver();
    const target = await receiver(302, `${elsewhere.url}/internal`);
    const { configs, sender, logs } = await setup(target.url);
    await configs.save("task-1", as(OWNER), pushConfig(`${target.url}/v1/a2a-push`));
    await sender.send(statusUpdate("task-1", TaskState.TASK_STATE_WORKING), as(OWNER));
    assert.equal(target.received.length, 1);
    assert.equal(elsewhere.received.length, 0, "the redirect is not followed");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /task-1/);
    assert.match(logs[0]!, /302/);
    assert.doesNotMatch(logs[0]!, /secret-token/);
  });

  it("sends once, without retrying a failure, and keeps the credentials out of the log", async () => {
    const target = await receiver(500);
    const { configs, sender, logs } = await setup(target.url);
    await configs.save("task-1", as(OWNER), pushConfig(`${target.url}/v1/a2a-push`));
    await sender.send(statusUpdate("task-1", TaskState.TASK_STATE_WORKING), as(OWNER));
    assert.equal(target.received.length, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, new RegExp(`${target.url}/v1/a2a-push`));
    assert.match(logs[0]!, /500/);
    assert.doesNotMatch(logs[0]!, /secret-token/);
  });

  it("gives up on a receiver that does not answer in time", async () => {
    const target = await receiver(204, undefined, 1000);
    const { configs, sender, logs } = await setup(target.url, { timeoutMs: 100 });
    await configs.save("task-1", as(OWNER), pushConfig(`${target.url}/v1/a2a-push`));
    const started = Date.now();
    await sender.send(statusUpdate("task-1", TaskState.TASK_STATE_WORKING), as(OWNER));
    assert.ok(Date.now() - started < 900, "the sender does not wait for the receiver");
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0]!, /secret-token/);
  });

  it("forgets the config once the task's last event is sent", async () => {
    const target = await receiver();
    const { configs, sender } = await setup(target.url);
    await configs.save("task-1", as(OWNER), pushConfig(`${target.url}/v1/a2a-push`));
    await sender.send(statusUpdate("task-1", TaskState.TASK_STATE_COMPLETED), as(OWNER));
    assert.equal(target.received.length, 1, "the last event is still sent");
    assert.deepEqual(await configs.load("task-1", as(OWNER)), []);
  });

  it("forgets the config when the task is a finished one", async () => {
    const target = await receiver();
    const { configs, sender } = await setup(target.url);
    await configs.save("task-1", as(OWNER), pushConfig(`${target.url}/v1/a2a-push`));
    const event: StreamResponse = { payload: { $case: "task", value: task("task-1", TaskState.TASK_STATE_FAILED) } };
    await sender.send(event, as(OWNER), task("task-1", TaskState.TASK_STATE_FAILED));
    assert.deepEqual(await configs.load("task-1", as(OWNER)), []);
  });

  it("keeps the config while the task waits for the caller's answer", async () => {
    const target = await receiver();
    const { configs, sender } = await setup(target.url);
    await configs.save("task-1", as(OWNER), pushConfig(`${target.url}/v1/a2a-push`));
    await sender.send(statusUpdate("task-1", TaskState.TASK_STATE_INPUT_REQUIRED), as(OWNER));
    assert.equal((await configs.load("task-1", as(OWNER))).length, 1);
  });

  it("forgets a task's config after the events already on their way", async () => {
    const target = await receiver(204, undefined, 50);
    const { configs, sender } = await setup(target.url);
    await configs.save("task-1", as(OWNER), pushConfig(`${target.url}/v1/a2a-push`));
    const sent = sender.send(statusUpdate("task-1", TaskState.TASK_STATE_CANCELED), as(OWNER));
    await sender.forget("task-1", OWNER);
    await sent;
    assert.equal(target.received.length, 1);
    assert.deepEqual(await configs.load("task-1", as(OWNER)), []);
  });

  it("does not send to a URL that is not allowed, whatever the store holds", async () => {
    const target = await receiver();
    const { configs, sender, logs } = await setup(`${target.url}/v1/a2a-push`);
    await configs.save("task-1", as(OWNER), pushConfig(`${target.url}/elsewhere`));
    await sender.send(statusUpdate("task-1", TaskState.TASK_STATE_WORKING), as(OWNER));
    assert.equal(target.received.length, 0);
    assert.equal(logs.length, 1);
  });
});
