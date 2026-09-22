import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import askCaller from "../extensions/ask-caller.ts";
import { createGitHubGate } from "../extensions/github-gate.ts";
import type { PiApi, ToolContext, ToolDefinition } from "../lib/pi.ts";
import { prepareWorkspace } from "../lib/workspace.ts";
import { FAKE_TOKEN, git, makeFixture, write } from "./fixtures/repo.ts";

const OWNER = "system:serviceaccount:fraction-agents:owner";
const NATSUMI = "system:serviceaccount:fraction-agents:natsumi";
const CONTEXT = "7d0f9a52-6c37-4a47-9a31-2f3f8f0e1d11";

class FakePi implements PiApi {
  readonly tools = new Map<string, ToolDefinition>();
  readonly handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  on(event: string, handler: (event: any, ctx: any) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
    const results = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
    return results;
  }

  async call(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const result = await tool.execute("call-1", params, undefined, undefined, ctx);
    return result.content.map((part) => part.text).join("");
  }
}

function context(cwd: string, ui: Partial<ToolContext["ui"]> = {}, hasUI = true): ToolContext {
  return { cwd, hasUI, ui: { input: async () => undefined, ...ui } };
}

async function setUp(caller: string) {
  const fixture = makeFixture({ skillPaths: [".claude/skills"] });
  const agentDir = join(fixture.dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "github-gate.json"), JSON.stringify({ placeholder: true }));
  const cwd = join(fixture.dir, "work", CONTEXT);
  await prepareWorkspace({ config: fixture.config, github: fixture.github, dir: cwd, contextId: CONTEXT });
  const pi = new FakePi();
  createGitHubGate({
    env: { PI_CODING_AGENT_DIR: agentDir, FRACTION_AGENTS_CALLER: caller, FRACTION_AGENTS_CONTEXT_ID: CONTEXT },
    loadConfig: () => fixture.config,
    github: () => fixture.github,
  })(pi);
  return { fixture, cwd, pi };
}

describe("GitHub gate extension", () => {
  it("gives a caller allowed to merge the push, pull request and merge tools", async () => {
    const { pi } = await setUp(OWNER);
    assert.deepEqual([...pi.tools.keys()].sort(), ["github_merge", "github_pull_request", "github_push"]);
  });

  it("does not give other callers the merge tool at all", async () => {
    const { pi } = await setUp(NATSUMI);
    assert.deepEqual([...pi.tools.keys()].sort(), ["github_pull_request", "github_push"]);
  });

  it("registers nothing when the agent has no gate settings", () => {
    const pi = new FakePi();
    createGitHubGate({ env: { PI_CODING_AGENT_DIR: "/nonexistent" } })(pi);
    assert.equal(pi.tools.size, 0);
    assert.equal(pi.handlers.size, 0);
  });

  it("opens a pull request and merges it through the tools", async () => {
    const { fixture, cwd, pi } = await setUp(OWNER);
    write(cwd, "raw/memos/2026/09/natsumi-talk-20260922.md", "a talk\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-q", "-m", "Add a memo");
    assert.match(await pi.call("github_pull_request", { title: "Add a memo", body: "From a talk" }, context(cwd)), /Opened pull request #1/);
    assert.match(await pi.call("github_merge", {}, context(cwd)), /Merged pull request #1/);
    assert.equal(fixture.github.merges.length, 1);
  });

  it("reports a refused push as a tool error", async () => {
    const { cwd, pi } = await setUp(OWNER);
    write(cwd, "Permanent-Notes/note.md", "changed\n");
    git(cwd, "commit", "-q", "-am", "change a permanent note");
    await assert.rejects(pi.call("github_push", {}, context(cwd)), /Permanent-Notes/);
  });

  it("stops the file tools and bash from changing protected paths or pushing", async () => {
    const { cwd, pi } = await setUp(NATSUMI);
    const block = async (toolName: string, input: Record<string, unknown>) => {
      const [result] = await pi.emit("tool_call", { toolName, toolCallId: "t", input }, context(cwd));
      return result as { block: true; reason: string } | undefined;
    };
    assert.match((await block("write", { path: "Permanent-Notes/x.md", content: "" }))?.reason ?? "", /read-only/);
    assert.match((await block("edit", { path: "raw/clips/old.md", edits: [] }))?.reason ?? "", /only new files/);
    assert.equal(await block("write", { path: "raw/memos/new.md", content: "new" }), undefined);
    assert.match((await block("bash", { command: "git push origin HEAD:main" }))?.reason ?? "", /github_push/);
    assert.match((await block("bash", { command: "gh pr merge 1" }))?.reason ?? "", /merge/);
    assert.match((await block("bash", { command: "rm raw/clips/old.md" }))?.reason ?? "", /raw\//);
    assert.equal(await block("bash", { command: "git status && git log --oneline" }), undefined);
    assert.equal(await block("read", { path: "Permanent-Notes/note.md" }), undefined);
  });

  it("points pi at the skills inside the workspace", async () => {
    const { cwd, pi } = await setUp(OWNER);
    const [result] = await pi.emit("resources_discover", { cwd, reason: "startup" }, context(cwd));
    assert.deepEqual(result, { skillPaths: [join(cwd, ".claude/skills")] });
  });

  it("leaves no token where bash could see it", async () => {
    const { cwd, pi } = await setUp(OWNER);
    write(cwd, "wiki/topics/a.md", "# A2\n");
    git(cwd, "commit", "-q", "-am", "edit");
    await pi.call("github_pull_request", { title: "Edit", body: "" }, context(cwd));
    // What pi's bash tool would start with: pi's own environment, in the worktree.
    const env = execFileSync("bash", ["-c", "env; git config --list"], { cwd, env: process.env, encoding: "utf8" });
    assert.equal(env.includes(FAKE_TOKEN), false);
    assert.equal(env.includes(Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString("base64")), false);
    assert.doesNotMatch(env, /extraheader/i);
  });
});

describe("ask_caller extension", () => {
  function tool(): FakePi {
    const pi = new FakePi();
    askCaller(pi);
    return pi;
  }

  it("puts the question to the caller and returns the answer", async () => {
    const asked: string[] = [];
    const answer = await tool().call("ask_caller", { question: "Which page?" }, context("/w", {
      input: async (title: string) => {
        asked.push(title);
        return "the index";
      },
    }));
    assert.deepEqual(asked, ["Which page?"]);
    assert.match(answer, /the index/);
  });

  it("says so when no answer came", async () => {
    const answer = await tool().call("ask_caller", { question: "Which page?" }, context("/w"));
    assert.match(answer, /No answer/);
  });

  it("fails where nobody can be asked", async () => {
    await assert.rejects(tool().call("ask_caller", { question: "Which page?" }, context("/w", {}, false)), /cannot ask/);
  });
});
