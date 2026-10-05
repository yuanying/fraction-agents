import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { createSubmitReply } from "../extensions/submit-reply.ts";
import type { PiApi, ToolContext, ToolDefinition } from "../lib/pi.ts";

class FakePi implements PiApi {
  readonly tools = new Map<string, ToolDefinition>();

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  on(): void {}

  async call(params: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get("submit_reply");
    assert.ok(tool, "submit_reply is registered");
    const ctx: ToolContext = { cwd: tmpdir(), hasUI: true, ui: { input: async () => undefined } };
    const result = await tool.execute("call-1", params, undefined, undefined, ctx);
    return result.content.map((part) => part.text).join("");
  }
}

function setUp() {
  const dir = mkdtempSync(join(tmpdir(), "fraction-agents-reply-"));
  const file = join(dir, "replies", "context.json");
  const pi = new FakePi();
  createSubmitReply({ env: { FRACTION_AGENTS_REPLY_FILE: file } })(pi);
  return { file, pi };
}

function submitted(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("submit_reply extension", () => {
  it("registers nothing outside the host, where nobody would pick the reply up", () => {
    const pi = new FakePi();
    createSubmitReply({ env: {} })(pi);
    assert.equal(pi.tools.size, 0);
  });

  it("hands the reply over to the host in the shape of the contract", async () => {
    const { file, pi } = setUp();
    const result = await pi.call({
      summary: "Found it.",
      sections: [{ title: "Details", body: "Some **Markdown**." }],
      sources: [{ title: "Example", url: "https://example.com/" }],
    });
    assert.match(result, /1 section/);
    assert.match(result, /1 source/);
    assert.deepEqual(submitted(file), {
      summary: "Found it.",
      sections: [{ title: "Details", body: "Some **Markdown**." }],
      sources: [{ title: "Example", url: "https://example.com/" }],
    });
  });

  it("takes a reply without sections or sources as empty lists", async () => {
    const { file, pi } = setUp();
    await pi.call({ summary: "Yes." });
    assert.deepEqual(submitted(file), { summary: "Yes.", sections: [], sources: [] });
  });

  it("trims the text around the summary and the titles", async () => {
    const { file, pi } = setUp();
    await pi.call({
      summary: "\n  Found it.  \n",
      sections: [{ title: "  Details ", body: "body\n" }],
      sources: [{ title: " Example ", url: " https://example.com/ " }],
    });
    assert.deepEqual(submitted(file), {
      summary: "Found it.",
      sections: [{ title: "Details", body: "body\n" }],
      sources: [{ title: "Example", url: "https://example.com/" }],
    });
  });

  it("refuses a summary longer than three lines and tells the model, handing nothing over", async () => {
    const { file, pi } = setUp();
    await assert.rejects(pi.call({ summary: "one\ntwo\nthree\nfour" }), /summary/);
    assert.equal(existsSync(file), false);
  });

  it("refuses a source that is not an http URL", async () => {
    const { file, pi } = setUp();
    await assert.rejects(pi.call({ summary: "Yes.", sources: [{ title: "Local", url: "file:///etc/passwd" }] }), /url/);
    assert.equal(existsSync(file), false);
  });

  it("keeps the last reply when it is submitted again, and leaves no other files behind", async () => {
    const { file, pi } = setUp();
    await pi.call({ summary: "First." });
    await pi.call({ summary: "Second." });
    assert.deepEqual(submitted(file), { summary: "Second.", sections: [], sources: [] });
    assert.deepEqual(readdirSync(dirname(file)), ["context.json"]);
  });
});
