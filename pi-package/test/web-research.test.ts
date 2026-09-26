import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createWebResearch } from "../extensions/web-research.ts";
import type { PiApi, ToolContext, ToolDefinition } from "../lib/pi.ts";
import { parseWebResearchConfig } from "../lib/web-research.ts";

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

  async emit(event: string, payload: unknown): Promise<unknown[]> {
    const results = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, context()));
    return results;
  }

  async call(name: string, params: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const result = await tool.execute("call-1", params, undefined, undefined, context());
    return result.content.map((part) => part.text).join("");
  }
}

function context(): ToolContext {
  return { cwd: "/work", hasUI: false, ui: { input: async () => undefined } };
}

/** A stand-in for SearXNG: answers /search with whatever the test sets, and records the requests. */
class FakeSearxng {
  server!: Server;
  requests: URL[] = [];
  status = 200;
  body: unknown = { results: [] };

  async start(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res) => {
      this.requests.push(new URL(req.url ?? "/", "http://searxng.test"));
      res.writeHead(this.status, { "content-type": "application/json" });
      res.end(typeof this.body === "string" ? this.body : JSON.stringify(this.body));
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/search`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function setUp(config: unknown) {
  const agentDir = mkdtempSync(join(tmpdir(), "web-research-"));
  writeFileSync(join(agentDir, "web-research.json"), JSON.stringify(config));
  const pi = new FakePi();
  const logs: string[] = [];
  createWebResearch({
    env: { PI_CODING_AGENT_DIR: agentDir, FRACTION_AGENTS_CONTEXT_ID: CONTEXT },
    log: (line) => logs.push(line),
  })(pi);
  return { pi, logs };
}

function unreadableLog(logs: string[]): { contextId: string; count: number; pages: { url: string; via: string; reasons: string[] }[] } {
  const lines = logs.filter((line) => line.startsWith("web-research: "));
  assert.equal(lines.length, 1, `one log line per task: ${JSON.stringify(logs)}`);
  const entry = JSON.parse(lines[0]!.slice("web-research: ".length));
  assert.equal(entry.event, "unreadable-pages");
  return entry;
}

describe("web research settings", () => {
  it("takes the SearXNG search URL and defaults the rest", () => {
    const config = parseWebResearchConfig({ searxng: { url: "http://searxng.searxng.svc.cluster.local/search" } });
    assert.equal(config.searxng.url, "http://searxng.searxng.svc.cluster.local/search");
    assert.equal(config.searxng.timeoutSeconds, 20);
    assert.equal(config.searxng.maxResults, 10);
  });

  it("refuses a URL that is not http(s) or carries credentials", () => {
    assert.throws(() => parseWebResearchConfig({ searxng: { url: "file:///etc/passwd" } }), /http/);
    assert.throws(() => parseWebResearchConfig({ searxng: { url: "http://user:secret@searxng.test/search" } }), /credentials/);
    assert.throws(() => parseWebResearchConfig({ searxng: {} }), /searxng\.url/);
    assert.throws(() => parseWebResearchConfig({}), /searxng/);
  });

  it("refuses limits out of range", () => {
    assert.throws(() => parseWebResearchConfig({ searxng: { url: "http://s.test/search", maxResults: 0 } }), /maxResults/);
    assert.throws(() => parseWebResearchConfig({ searxng: { url: "http://s.test/search", timeoutSeconds: -1 } }), /timeoutSeconds/);
  });
});

describe("web research extension", () => {
  const searxng = new FakeSearxng();
  let url = "";
  before(async () => {
    url = await searxng.start();
  });
  after(async () => {
    await searxng.stop();
  });

  it("registers nothing when the agent has no web research settings", () => {
    const pi = new FakePi();
    createWebResearch({ env: { PI_CODING_AGENT_DIR: "/nonexistent" } })(pi);
    assert.equal(pi.tools.size, 0);
    assert.equal(pi.handlers.size, 0);
  });

  it("warns and registers nothing when the settings are not usable", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "web-research-"));
    writeFileSync(join(agentDir, "web-research.json"), "{ not json");
    const pi = new FakePi();
    const warnings: string[] = [];
    createWebResearch({ env: { PI_CODING_AGENT_DIR: agentDir }, log: (line) => warnings.push(line) })(pi);
    assert.equal(pi.tools.size, 0);
    assert.match(warnings.join("\n"), /web-research\.json is not usable/);
  });

  it("gives the search and report tools", () => {
    const { pi } = setUp({ searxng: { url } });
    assert.deepEqual([...pi.tools.keys()].sort(), ["report_unreadable", "searxng_search"]);
  });

  it("searches SearXNG for JSON and lists the results with their URLs", async () => {
    searxng.requests = [];
    searxng.status = 200;
    searxng.body = {
      query: "node test runner",
      results: [
        { url: "https://nodejs.org/api/test.html", title: "Test runner | Node.js", content: "The node:test module.", engines: ["duckduckgo", "brave"] },
        { url: "https://example.com/blog", title: "A blog", content: "x".repeat(1000), engine: "bing" },
      ],
      unresponsive_engines: [["google", "CAPTCHA"]],
    };
    const { pi } = setUp({ searxng: { url } });
    const out = await pi.call("searxng_search", { query: "node test runner", language: "ja", timeRange: "month", page: 2 });

    const request = searxng.requests.at(-1)!;
    assert.equal(request.pathname, "/search");
    assert.equal(request.searchParams.get("q"), "node test runner");
    assert.equal(request.searchParams.get("format"), "json");
    assert.equal(request.searchParams.get("language"), "ja");
    assert.equal(request.searchParams.get("time_range"), "month");
    assert.equal(request.searchParams.get("pageno"), "2");

    assert.match(out, /1\. Test runner \| Node\.js\n\s+https:\/\/nodejs\.org\/api\/test\.html\n\s+The node:test module\./);
    assert.match(out, /engines: duckduckgo, brave/);
    assert.match(out, /2\. A blog\n\s+https:\/\/example\.com\/blog/);
    assert.ok(!out.includes("x".repeat(400)), "long snippets are cut");
    assert.match(out, /google \(CAPTCHA\)/);
  });

  it("returns at most maxResults results", async () => {
    searxng.status = 200;
    searxng.body = {
      results: Array.from({ length: 5 }, (_, i) => ({ url: `https://example.com/${i}`, title: `Page ${i}`, content: "" })),
    };
    const { pi } = setUp({ searxng: { url, maxResults: 2 } });
    const out = await pi.call("searxng_search", { query: "pages" });
    assert.match(out, /example\.com\/1/);
    assert.doesNotMatch(out, /example\.com\/2/);
  });

  it("says so when nothing is found", async () => {
    searxng.status = 200;
    searxng.body = { results: [] };
    const { pi } = setUp({ searxng: { url } });
    assert.match(await pi.call("searxng_search", { query: "nothing" }), /No results/);
  });

  it("fails the tool when SearXNG answers with an error or not JSON", async () => {
    const { pi } = setUp({ searxng: { url } });
    searxng.status = 503;
    searxng.body = { error: "down" };
    await assert.rejects(pi.call("searxng_search", { query: "q" }), /SearXNG.*503/);
    searxng.status = 200;
    searxng.body = "<html>not json</html>";
    await assert.rejects(pi.call("searxng_search", { query: "q" }), /SearXNG.*JSON/);
  });

  it("refuses an empty query", async () => {
    const { pi } = setUp({ searxng: { url } });
    await assert.rejects(pi.call("searxng_search", { query: "  " }), /query/);
  });

  it("blocks the other search tools so queries go only through SearXNG", async () => {
    const { pi } = setUp({ searxng: { url } });
    for (const toolName of ["web_search", "agent_browser_web_search"]) {
      const [result] = (await pi.emit("tool_call", { toolName, toolCallId: "t", input: { query: "q" } })) as { block?: boolean; reason?: string }[];
      assert.equal(result?.block, true, toolName);
      assert.match(result?.reason ?? "", /searxng_search/);
    }
    const [other] = (await pi.emit("tool_call", { toolName: "fetch_content", toolCallId: "t", input: { url: "https://example.com" } })) as unknown[];
    assert.equal(other, undefined);
  });

  it("counts pages that fetch_content could not read, and logs the count once per task", async () => {
    const { pi, logs } = setUp({ searxng: { url } });
    await pi.emit("agent_start", { type: "agent_start" });
    await pi.emit("tool_result", {
      toolName: "fetch_content",
      toolCallId: "t1",
      input: {},
      content: [],
      isError: false,
      details: {
        responseId: "r1",
        pages: [
          { url: "https://blocked.example/", finalUrl: "https://blocked.example/", error: "HTTP 403 Forbidden", chars: 0 },
          { url: "https://ok.example/", finalUrl: "https://ok.example/", chars: 1200 },
          { url: "https://down.example/", finalUrl: "https://down.example/", error: "fetch failed", chars: 0 },
        ],
      },
    });
    await pi.emit("agent_end", { type: "agent_end", messages: [] });

    const entry = unreadableLog(logs);
    assert.equal(entry.contextId, CONTEXT);
    assert.equal(entry.count, 2);
    assert.deepEqual(
      entry.pages.map((page) => [page.url, page.via, page.reasons]),
      [
        ["https://blocked.example/", "fetch_content", ["HTTP 403 Forbidden"]],
        ["https://down.example/", "fetch_content", ["fetch failed"]],
      ],
    );
  });

  it("counts the pages the agent reports, once per URL, and starts again for the next task", async () => {
    const { pi, logs } = setUp({ searxng: { url } });
    await pi.emit("agent_start", { type: "agent_start" });
    await pi.emit("tool_result", {
      toolName: "fetch_content",
      toolCallId: "t1",
      input: {},
      content: [],
      isError: false,
      details: { pages: [{ url: "https://blocked.example/", error: "HTTP 403 Forbidden" }] },
    });
    const answer = await pi.call("report_unreadable", { url: "https://blocked.example/", reason: "Cloudflare の確認画面（ブラウザでも）" });
    assert.match(answer, /1/);
    await pi.call("report_unreadable", { url: "https://captcha.example/", reason: "CAPTCHA" });
    await pi.emit("agent_end", { type: "agent_end", messages: [] });

    const first = unreadableLog(logs);
    assert.equal(first.count, 2);
    assert.deepEqual(first.pages[0], {
      url: "https://blocked.example/",
      via: "report",
      reasons: ["HTTP 403 Forbidden", "Cloudflare の確認画面（ブラウザでも）"],
    });

    logs.length = 0;
    await pi.emit("agent_start", { type: "agent_start" });
    await pi.emit("agent_end", { type: "agent_end", messages: [] });
    assert.equal(unreadableLog(logs).count, 0);
  });
});
