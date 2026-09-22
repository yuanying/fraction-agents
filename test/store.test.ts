import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { Role, TaskState, type Task } from "@a2a-js/sdk";
import { ServerCallContext, type User } from "@a2a-js/sdk/server";

import { openStore } from "../src/store.ts";

function callerContext(name: string): ServerCallContext {
  const user: User = { isAuthenticated: true, userName: name };
  return new ServerCallContext({ user });
}

function task(id: string, contextId: string, state: TaskState, timestamp: string): Task {
  return {
    id,
    contextId,
    status: { state, message: undefined, timestamp },
    artifacts: [
      {
        artifactId: `${id}-result`,
        name: "response",
        description: "",
        parts: [{ content: { $case: "text", value: `result of ${id}` }, metadata: {}, filename: "", mediaType: "text/plain" }],
        metadata: {},
        extensions: [],
      },
    ],
    history: [
      {
        messageId: `${id}-m`,
        contextId,
        taskId: id,
        role: Role.ROLE_USER,
        parts: [{ content: { $case: "text", value: "hi" }, metadata: {}, filename: "", mediaType: "" }],
        metadata: {},
        extensions: [],
        referenceTaskIds: [],
      },
    ],
    metadata: {},
  };
}

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "fraction-agents-store-")), "state.db");
}

describe("SQLite task store", () => {
  const alice = callerContext("system:serviceaccount:ns:alice");
  const bob = callerContext("system:serviceaccount:ns:bob");

  it("loads only the caller's own tasks", async () => {
    const store = openStore(tempDb());
    await store.tasks.save(task("t1", "c1", TaskState.TASK_STATE_COMPLETED, "2026-09-22T00:00:00.000Z"), alice);
    assert.equal((await store.tasks.load("t1", alice))?.id, "t1");
    assert.equal(await store.tasks.load("t1", bob), undefined);
    store.close();
  });

  it("keeps tasks across a reopen", async () => {
    const path = tempDb();
    const first = openStore(path);
    const saved = task("t1", "c1", TaskState.TASK_STATE_COMPLETED, "2026-09-22T00:00:00.000Z");
    await first.tasks.save(saved, alice);
    first.close();
    const second = openStore(path);
    assert.deepEqual(await second.tasks.load("t1", alice), saved);
    second.close();
  });

  it("lists the caller's tasks newest first, filtered and paged", async () => {
    const store = openStore(tempDb());
    await store.tasks.save(task("t1", "c1", TaskState.TASK_STATE_COMPLETED, "2026-09-22T00:00:01.000Z"), alice);
    await store.tasks.save(task("t2", "c1", TaskState.TASK_STATE_FAILED, "2026-09-22T00:00:02.000Z"), alice);
    await store.tasks.save(task("t3", "c2", TaskState.TASK_STATE_COMPLETED, "2026-09-22T00:00:03.000Z"), alice);
    await store.tasks.save(task("t4", "c9", TaskState.TASK_STATE_COMPLETED, "2026-09-22T00:00:04.000Z"), bob);

    const all = await store.tasks.list(
      { tenant: "", contextId: "", status: TaskState.TASK_STATE_UNSPECIFIED, pageToken: "", statusTimestampAfter: undefined },
      alice,
    );
    assert.deepEqual(
      all.tasks.map((t) => t.id),
      ["t3", "t2", "t1"],
    );
    assert.equal(all.totalSize, 3);
    assert.deepEqual(all.tasks[0]?.artifacts, [], "artifacts are left out unless asked for");

    const withArtifacts = await store.tasks.list(
      { tenant: "", contextId: "c1", status: TaskState.TASK_STATE_UNSPECIFIED, pageToken: "", statusTimestampAfter: undefined, includeArtifacts: true },
      alice,
    );
    assert.deepEqual(
      withArtifacts.tasks.map((t) => t.id),
      ["t2", "t1"],
    );
    assert.equal(withArtifacts.tasks[0]?.artifacts.length, 1);

    const failed = await store.tasks.list(
      { tenant: "", contextId: "", status: TaskState.TASK_STATE_FAILED, pageToken: "", statusTimestampAfter: undefined },
      alice,
    );
    assert.deepEqual(
      failed.tasks.map((t) => t.id),
      ["t2"],
    );

    const recent = await store.tasks.list(
      { tenant: "", contextId: "", status: TaskState.TASK_STATE_UNSPECIFIED, pageToken: "", statusTimestampAfter: "2026-09-22T00:00:01.500Z" },
      alice,
    );
    assert.deepEqual(
      recent.tasks.map((t) => t.id),
      ["t3", "t2"],
    );

    const page1 = await store.tasks.list(
      { tenant: "", contextId: "", status: TaskState.TASK_STATE_UNSPECIFIED, pageToken: "", pageSize: 2, statusTimestampAfter: undefined },
      alice,
    );
    assert.deepEqual(
      page1.tasks.map((t) => t.id),
      ["t3", "t2"],
    );
    assert.notEqual(page1.nextPageToken, "");
    const page2 = await store.tasks.list(
      { tenant: "", contextId: "", status: TaskState.TASK_STATE_UNSPECIFIED, pageToken: page1.nextPageToken, pageSize: 2, statusTimestampAfter: undefined },
      alice,
    );
    assert.deepEqual(
      page2.tasks.map((t) => t.id),
      ["t1"],
    );
    assert.equal(page2.nextPageToken, "");
    store.close();
  });

  it("fails the tasks left running by a previous process", async () => {
    const path = tempDb();
    const first = openStore(path);
    await first.tasks.save(task("t1", "c1", TaskState.TASK_STATE_WORKING, "2026-09-22T00:00:00.000Z"), alice);
    await first.tasks.save(task("t2", "c1", TaskState.TASK_STATE_COMPLETED, "2026-09-22T00:00:01.000Z"), alice);
    first.close();
    const second = openStore(path);
    assert.equal(second.tasks.failUnfinished("the host restarted"), 1);
    const t1 = await second.tasks.load("t1", alice);
    assert.equal(t1?.status?.state, TaskState.TASK_STATE_FAILED);
    const reason = t1?.status?.message?.parts[0]?.content;
    assert.deepEqual(reason, { $case: "text", value: "the host restarted" });
    assert.equal((await second.tasks.load("t2", alice))?.status?.state, TaskState.TASK_STATE_COMPLETED);
    second.close();
  });
});

describe("context registry", () => {
  it("creates contexts owned by a caller, with a session file chosen by the server", () => {
    const store = openStore(tempDb());
    const context = store.contexts.create("alice", 1000);
    assert.match(context.contextId, /^[0-9a-f-]{36}$/);
    assert.match(context.sessionFile, /^[0-9a-f-]{36}\.jsonl$/);
    assert.notEqual(context.sessionFile, `${context.contextId}.jsonl`);
    assert.deepEqual(store.contexts.get(context.contextId, "alice"), { ...context, owner: "alice", lastUsedAt: 1000 });
    assert.equal(store.contexts.get(context.contextId, "bob"), undefined);
    store.close();
  });

  it("finds and removes contexts idle past a cutoff", async () => {
    const store = openStore(tempDb());
    const old = store.contexts.create("alice", 1000);
    const fresh = store.contexts.create("alice", 1000);
    store.contexts.touch(fresh.contextId, 5000);
    const stale = store.contexts.usedBefore(3000);
    assert.deepEqual(
      stale.map((c) => c.contextId),
      [old.contextId],
    );
    const alice = callerContext("alice");
    await store.tasks.save(task("t1", old.contextId, TaskState.TASK_STATE_COMPLETED, "2026-09-22T00:00:00.000Z"), alice);
    store.contexts.remove(old.contextId);
    assert.equal(store.contexts.get(old.contextId, "alice"), undefined);
    assert.equal(await store.tasks.load("t1", alice), undefined, "the context's tasks go with it");
    store.close();
  });
});
