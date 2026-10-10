import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { createGmail } from "../extensions/gmail.ts";
import type { CheckData } from "../lib/gmail-check.ts";
import type { PiApi, ToolContext, ToolDefinition } from "../lib/pi.ts";
import { checkReply } from "../lib/reply.ts";
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

function setUp(google: FakeGoogle, options: { replyFile?: boolean; config?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gmail-ext-"));
  const agentDir = join(dir, "agent");
  const credentials = writeCredentials(dir);
  const replyFile = join(dir, "replies", "context.json");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "gmail.json"),
    JSON.stringify({ credentialsFile: credentials, stateDir: join(dir, "state"), timeZone: "Asia/Tokyo", ...options.config }),
  );
  const pi = new FakePi();
  const logs: string[] = [];
  createGmail({
    env: { PI_CODING_AGENT_DIR: agentDir, ...(options.replyFile === false ? {} : { FRACTION_AGENTS_REPLY_FILE: replyFile }) },
    tokenUrl: `${google.base}/token`,
    apiBase: `${google.base}/gmail/v1`,
    now: () => NOW,
    sleep: async () => {},
    log: (line) => logs.push(line),
  })(pi);
  return { pi, logs, replyFile, agentDir };
}

function replyData(file: string): CheckData {
  const reply = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(checkReply(reply), undefined);
  const body = reply.sections.find((s: { title: string }) => s.title === "gmail-check").body as string;
  return JSON.parse(body.replace(/^```json\n/, "").replace(/\n```$/, ""));
}

const TOOLS = [
  "gmail_check_ack",
  "gmail_check_begin",
  "gmail_check_next",
  "gmail_check_record",
  "gmail_check_reply",
  "gmail_read_attachment",
  "gmail_read_message",
  "gmail_search",
];

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

  it("offers reading tools only: nothing that sends, labels, archives or deletes", () => {
    const { pi } = setUp(google);
    assert.deepEqual([...pi.tools.keys()].sort(), TOOLS);
    for (const tool of pi.tools.values()) assert.doesNotMatch(tool.name, /send|modify|label|trash|delete|archive/);
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
    assert.match(listed, /setup\.exe .*executable/);
    const notes = await pi.call("gmail_read_attachment", { messageId: "m1", partId: "1" });
    assert.match(notes, /hello notes/);
    assert.match(notes, /untrusted/);
    await assert.rejects(pi.call("gmail_read_attachment", { messageId: "m1", partId: "2" }), /executable/);
    assert.equal(google.apiRequests().filter((r) => r.url.pathname.includes("att-exe")).length, 0);
  });

  it("runs a check through the tools and hands natsumi the canonical reply and acknowledgement", async () => {
    google.add(message("m1", "2026-10-10T01:00:00Z", { subject: "Bill" }), message("m2", "2026-10-10T02:00:00Z"));
    const { pi, replyFile } = setUp(google);
    const begun = await pi.call("gmail_check_begin", { requestKey: "daily-2026-10-11" });
    const checkId = /checkId: (gmc-[\w-]+)/.exec(begun)![1]!;
    const next = await pi.call("gmail_check_next", { checkId });
    assert.match(next, /untrusted/);
    // A message whose body was not read, or was cut where it matters, is not skipped as if it had been read.
    assert.match(next, /not retrieved.*candidate/i);
    const batchId = /batchId: (\S+)/.exec(next)![1]!;
    const recorded = await pi.call("gmail_check_record", {
      checkId,
      batchId,
      decisions: [
        { messageId: "m1", verdict: "candidate", priority: "high", summary: "A bill is due.", reason: "Payment by Friday." },
        { messageId: "m2", verdict: "skip", reason: "newsletter" },
      ],
    });
    assert.match(recorded, /complete/i);
    const replied = await pi.call("gmail_check_reply", { checkId });
    assert.match(replied, /End with one short line/);
    const data = replyData(replyFile);
    assert.equal(data.status, "complete");
    assert.equal(data.candidates[0]!.subject, "Bill");
    const acked = await pi.call("gmail_check_ack", { checkId, reportedMessageIds: ["m1"] });
    assert.match(acked, /acknowledged/i);
    assert.deepEqual(replyData(replyFile).reportedMessageIds, ["m1"]);
  });

  it("returns the check's reply as text where there is no host to hand it to", async () => {
    const { pi } = setUp(google, { replyFile: false });
    const begun = await pi.call("gmail_check_begin", {});
    const checkId = /checkId: (gmc-[\w-]+)/.exec(begun)![1]!;
    await pi.call("gmail_check_next", { checkId });
    const replied = await pi.call("gmail_check_reply", { checkId });
    assert.match(replied, /"contract"/);
  });

  it("says in the check's reply that the authorization must be renewed, when Google refused it", async () => {
    google.add(message("m1", "2026-10-10T01:00:00Z"));
    const { pi, replyFile } = setUp(google);
    const begun = await pi.call("gmail_check_begin", { requestKey: "daily-2026-10-11" });
    const checkId = /checkId: (gmc-[\w-]+)/.exec(begun)![1]!;
    google.refreshTokenValid = false;
    await assert.rejects(pi.call("gmail_check_next", { checkId }), /authori[sz]e again/i);
    await pi.call("gmail_check_reply", { checkId });
    const data = replyData(replyFile);
    assert.equal(data.status, "scanning");
    assert.match(data.problem ?? "", /再認可/);
    // Once Gmail answers again, the note goes.
    google.refreshTokenValid = true;
    await pi.call("gmail_check_next", { checkId });
    await pi.call("gmail_check_reply", { checkId });
    assert.equal(replyData(replyFile).problem, null);
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
