import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

import { createGmail } from "../extensions/gmail.ts";
import type { PiApi, ToolContext, ToolDefinition } from "../lib/pi.ts";
import {
  attachmentPart,
  CLIENT_SECRET,
  FakeGoogle,
  message,
  multipart,
  REFRESH_TOKEN,
  textPart,
  writeCredentials,
} from "./fixtures/gmail.ts";

// 2026-10-11 (Sun) 08:00 in Tokyo.
const NOW = new Date("2026-10-10T23:00:00Z");

class FakePi implements PiApi {
  readonly tools = new Map<string, ToolDefinition>();

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  on(): void {}

  async call(name: string, params: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    assert.ok(tool, `tool ${name} is registered`);
    const ctx: ToolContext = { cwd: "/work", hasUI: false, ui: { input: async () => undefined } };
    const result = await tool.execute("call-1", params, undefined, undefined, ctx);
    return result.content.map((part) => part.text).join("");
  }
}

function setUp(google: FakeGoogle, options: { config?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gmail-ext-"));
  const agentDir = join(dir, "agent");
  const credentials = writeCredentials(dir);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "gmail.json"), JSON.stringify({ credentialsFile: credentials, timeZone: "Asia/Tokyo", ...options.config }));
  const pi = new FakePi();
  const logs: string[] = [];
  createGmail({
    env: { PI_CODING_AGENT_DIR: agentDir },
    tokenUrl: `${google.base}/token`,
    apiBase: `${google.base}/gmail/v1`,
    now: () => NOW,
    sleep: async () => {},
    log: (line) => logs.push(line),
  })(pi);
  return { pi, logs, agentDir };
}

/** The Gmail agent's instructions, which name the tools it may use. */
const AGENTS_MD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents", "gmail-agent", "AGENTS.md");

const TOOLS = ["gmail_read_attachment", "gmail_read_message", "gmail_search"];

describe("Gmail extension", () => {
  const google = new FakeGoogle();
  before(() => google.start());
  after(() => google.stop());
  beforeEach(() => google.reset());

  it("registers nothing without gmail.json, and nothing with a broken one", () => {
    const pi = new FakePi();
    createGmail({ env: { PI_CODING_AGENT_DIR: "/nonexistent" } })(pi);
    assert.equal(pi.tools.size, 0);
    const { pi: broken, logs } = setUp(google, { config: { timeZone: "Nowhere/None" } });
    assert.equal(broken.tools.size, 0);
    assert.match(logs.join("\n"), /gmail.*not usable/);
  });

  it("offers reading tools only: nothing that sends, labels, archives or deletes, and no checks", () => {
    const { pi } = setUp(google);
    assert.deepEqual([...pi.tools.keys()].sort(), TOOLS);
    for (const tool of pi.tools.values()) assert.doesNotMatch(tool.name, /send|modify|label|trash|delete|archive|check/);
  });

  it("is told only about the tools it has", () => {
    const { pi } = setUp(google);
    const named = new Set([...readFileSync(AGENTS_MD, "utf8").matchAll(/\b(gmail_\w+)/g)].map((m) => m[1]!));
    assert.ok(named.size > 0);
    for (const name of named) assert.ok(pi.tools.has(name), `AGENTS.md names ${name}, which is not a tool`);
    assert.doesNotMatch(readFileSync(AGENTS_MD, "utf8"), /requestKey|checkId|\back\b/);
  });

  it("searches, starting with the current time, and says when there are more results", async () => {
    google.add(
      message("m1", "2026-10-10T01:00:00Z", { subject: "Invoice October" }),
      message("m2", "2026-10-10T02:00:00Z", { subject: "Invoice November" }),
      message("m3", "2026-10-10T03:00:00Z", { subject: "Party" }),
    );
    const { pi } = setUp(google);
    const result = await pi.call("gmail_search", { query: "invoice", maxResults: 1 });
    assert.match(result, /^Now: 2026-10-11 \(Sun\) 08:00, time zone Asia\/Tokyo/);
    assert.match(result, /m2 .*Invoice November/s);
    assert.doesNotMatch(result, /Invoice October/);
    // How many there are, and that only part of them is shown, is never left out.
    assert.match(result, /Showing 1 message\(s\); Gmail estimates about 2 match/);
    assert.match(result, /pageToken: p1/);
    const rest = await pi.call("gmail_search", { query: "invoice", maxResults: 1, pageToken: "p1" });
    assert.match(rest, /Invoice October/);
    assert.match(rest, /No more results/);
    await assert.rejects(pi.call("gmail_search", { query: "x", maxResults: 51 }), /50/);
  });

  it("reads a message in bounded pieces", async () => {
    google.add(message("m1", "2026-10-10T01:00:00Z", { payload: textPart("a".repeat(15_000) + "TAIL") }));
    const { pi } = setUp(google);
    const first = await pi.call("gmail_read_message", { messageId: "m1" });
    assert.match(first, /chars 1–12000 of 15004/);
    assert.doesNotMatch(first, /TAIL/);
    const rest = await pi.call("gmail_read_message", { messageId: "m1", offset: 12_000 });
    assert.match(rest, /TAIL/);
    assert.match(rest, /chars 12001–15004 of 15004/);
  });

  it("reads a text attachment, and never fetches an executable one", async () => {
    google.add(
      message("m1", "2026-10-10T01:00:00Z", {
        payload: multipart("multipart/mixed", [
          textPart("see attached"),
          attachmentPart("notes.txt", "text/plain", "att-notes", 11),
          attachmentPart("setup.exe", "application/x-msdownload", "att-exe", 2_000_000),
        ]),
      }),
    );
    google.attachments.set("m1/att-notes", Buffer.from("hello notes"));
    const { pi } = setUp(google);
    const listed = await pi.call("gmail_read_message", { messageId: "m1" });
    assert.match(listed, /notes\.txt .*partId: 1/);
    // Reading the message names the attachments; only gmail_read_attachment, when asked, opens one.
    assert.equal(google.apiRequests().filter((r) => r.url.pathname.includes("/attachments/")).length, 0);
    assert.match(listed, /setup\.exe .*executable/);
    const notes = await pi.call("gmail_read_attachment", { messageId: "m1", partId: "1" });
    assert.match(notes, /hello notes/);
    assert.match(notes, /untrusted/);
    await assert.rejects(pi.call("gmail_read_attachment", { messageId: "m1", partId: "2" }), /executable/);
    assert.equal(google.apiRequests().filter((r) => r.url.pathname.includes("att-exe")).length, 0);
  });

  it("searches old mail with the dates in the query, as Gmail does", async () => {
    google.add(
      message("old", "2019-06-01T03:00:00Z", { subject: "Lease contract" }),
      message("new", "2026-10-01T03:00:00Z", { subject: "Lease renewal" }),
    );
    const { pi } = setUp(google);
    const result = await pi.call("gmail_search", { query: "lease after:2019/01/01 before:2020/01/01" });
    assert.match(result, /old .*2019-06-01.*Lease contract/s);
    assert.doesNotMatch(result, /Lease renewal/);
    const list = google.apiRequests().find((r) => r.url.pathname.endsWith("/messages"));
    assert.equal(list?.url.searchParams.get("q"), "lease after:2019/01/01 before:2020/01/01");
    assert.match(pi.tools.get("gmail_search")!.description, /older_than/);
  });

  it("reads one message in full for the details: headers, labels, link and attachments by name", async () => {
    google.add(
      message("m1", "2026-10-10T01:00:00Z", {
        from: "Clinic <desk@clinic.example.test>",
        subject: "Appointment",
        labels: ["INBOX", "IMPORTANT"],
        payload: multipart("multipart/mixed", [textPart("Your appointment is on Monday."), attachmentPart("map.pdf", "application/pdf", "att-map", 900)]),
      }),
    );
    const { pi } = setUp(google);
    const result = await pi.call("gmail_read_message", { messageId: "m1" });
    assert.match(result, /From: Clinic <desk@clinic\.example\.test>/);
    assert.match(result, /Labels: INBOX, IMPORTANT/);
    assert.match(result, /Link: https:\/\/mail\.google\.com\/mail\/\?authuser=owner%40example\.test#all\/m1/);
    assert.match(result, /map\.pdf .*name and type only/);
    assert.match(result, /appointment is on Monday/);
  });

  it("asks for a new authorization when Gmail answers 401, without retrying", async () => {
    google.fail(/\/messages$/, 401);
    const { pi } = setUp(google);
    await assert.rejects(pi.call("gmail_search", { query: "x" }), /HTTP 401.*authori[sz]e again/i);
    assert.equal(google.apiRequests().filter((r) => r.url.pathname.endsWith("/messages")).length, 1);
  });

  it("never shows the credentials, even when Google refuses them", async () => {
    google.refreshTokenValid = false;
    const { pi } = setUp(google);
    await assert.rejects(pi.call("gmail_search", { query: "x" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /authori[sz]e again/i);
      assert.doesNotMatch(error.message, new RegExp(`${REFRESH_TOKEN}|${CLIENT_SECRET}`));
      return true;
    });
  });
});
