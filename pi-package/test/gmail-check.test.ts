import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { checkReply } from "../lib/reply.ts";
import { GmailClient } from "../lib/gmail.ts";
import { CHECK_CONTRACT, GmailChecks, type CheckData, type Decision } from "../lib/gmail-check.ts";
import { ACCOUNT, attachmentPart, FakeGoogle, message, multipart, textPart, writeCredentials } from "./fixtures/gmail.ts";

const HOUR = 3_600_000;

class Clock {
  value: number;
  constructor(iso: string) {
    this.value = Date.parse(iso);
  }
  now = () => new Date(this.value);
  advance(ms: number) {
    this.value += ms;
  }
}

interface Setup {
  google: FakeGoogle;
  stateDir: string;
  credentials: string;
  clock: Clock;
}

function checks(s: Setup, options: { batchSize?: number; listPageSize?: number } = {}): GmailChecks {
  const client = new GmailClient(s.credentials, {
    tokenUrl: `${s.google.base}/token`,
    apiBase: `${s.google.base}/gmail/v1`,
    now: s.clock.now,
    sleep: async () => {},
  });
  return new GmailChecks({ stateDir: s.stateDir, client, timeZone: "Asia/Tokyo", now: s.clock.now, ...options });
}

/** The machine-readable part of a check's reply. */
function data(reply: unknown): CheckData {
  assert.equal(checkReply(reply), undefined, "the reply is in the shape of the reply contract");
  const section = (reply as { sections: { title: string; body: string }[] }).sections.find((s) => s.title === "gmail-check");
  assert.ok(section, "the reply has the gmail-check section");
  const match = /^```json\n([\s\S]*)\n```$/.exec(section.body);
  assert.ok(match, "the section is one JSON code block");
  const parsed = JSON.parse(match[1]!) as CheckData;
  assert.equal(parsed.contract, CHECK_CONTRACT);
  return parsed;
}

/** Goes through the whole check, deciding each message; candidates are the IDs in `pick`. */
async function runThrough(c: GmailChecks, checkId: string, pick: string[] = []): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const next = await c.next(checkId);
    if (!next.batch) return seen;
    const decisions: Decision[] = next.batch.messages.map((m) =>
      pick.includes(m.id)
        ? { messageId: m.id, verdict: "candidate", priority: "high", summary: `summary of ${m.id}`, reason: `reason for ${m.id}` }
        : { messageId: m.id, verdict: "skip", reason: "newsletter" },
    );
    seen.push(...next.batch.messages.map((m) => m.id));
    await c.record(checkId, next.batch.batchId, decisions);
  }
  throw new Error("the check did not end");
}

describe("Gmail checks", () => {
  const google = new FakeGoogle();
  let s: Setup;
  before(() => google.start());
  after(() => google.stop());
  beforeEach(() => {
    google.reset();
    const dir = mkdtempSync(join(tmpdir(), "gmail-check-"));
    s = { google, stateDir: join(dir, "state"), credentials: writeCredentials(dir), clock: new Clock("2026-10-10T23:00:00Z") };
  });

  it("checks the last 24 hours the first time: read or not, archived or not, but not spam, trash, sent or drafts", async () => {
    google.add(
      message("old", "2026-10-09T22:00:00Z"),
      message("inbox", "2026-10-10T01:00:00Z"),
      message("read-archived", "2026-10-10T02:00:00Z", { labels: ["CATEGORY_UPDATES"] }),
      message("spam", "2026-10-10T03:00:00Z", { labels: ["SPAM"] }),
      message("trash", "2026-10-10T03:00:00Z", { labels: ["TRASH"] }),
      message("sent", "2026-10-10T03:00:00Z", { labels: ["SENT"] }),
      message("draft", "2026-10-10T03:00:00Z", { labels: ["DRAFT"] }),
    );
    const c = checks(s);
    const check = await c.begin("daily-2026-10-11");
    assert.equal(check.from, "2026-10-09T23:00:00.000Z");
    assert.equal(check.to, "2026-10-10T23:00:00.000Z");
    assert.equal(check.status, "scanning");
    assert.deepEqual((await runThrough(c, check.checkId)).sort(), ["inbox", "read-archived"]);
    const query = google.apiRequests().find((r) => r.url.pathname.endsWith("/messages"))!.url.searchParams.get("q")!;
    for (const part of ["-in:spam", "-in:trash", "-in:sent", "-in:drafts"]) assert.ok(query.includes(part), query);
  });

  it("hands out the messages in batches and does not move on until every message of a batch is decided", async () => {
    for (let i = 1; i <= 5; i += 1) google.add(message(`m${i}`, `2026-10-10T0${i}:00:00Z`));
    const c = checks(s, { batchSize: 2 });
    const { checkId } = await c.begin();
    const first = await c.next(checkId);
    assert.equal(first.batch!.messages.length, 2);
    assert.equal(first.check.counts.remaining, 5);
    // Asking again without deciding gives the same batch: nothing is skipped.
    const again = await c.next(checkId);
    assert.equal(again.batch!.batchId, first.batch!.batchId);
    assert.deepEqual(
      again.batch!.messages.map((m) => m.id),
      first.batch!.messages.map((m) => m.id),
    );
    const [a, b] = first.batch!.messages.map((m) => m.id) as [string, string];
    await assert.rejects(c.record(checkId, first.batch!.batchId, [{ messageId: a, verdict: "skip" }]), /every message.*missing/);
    await assert.rejects(
      c.record(checkId, first.batch!.batchId, [
        { messageId: a, verdict: "skip" },
        { messageId: b, verdict: "skip" },
        { messageId: "m9", verdict: "skip" },
      ]),
      /not in this batch/,
    );
    await assert.rejects(c.record(checkId, "other", [{ messageId: a, verdict: "skip" }]), /batch/);
    await assert.rejects(
      c.record(checkId, first.batch!.batchId, [
        { messageId: a, verdict: "candidate", reason: "r" },
        { messageId: b, verdict: "skip" },
      ]),
      /summary/,
    );
    await assert.rejects(c.reply(checkId).then(() => c.ack(checkId, [])), /not complete/);
    const recorded = await c.record(checkId, first.batch!.batchId, [
      { messageId: a, verdict: "skip" },
      { messageId: b, verdict: "skip" },
    ]);
    assert.equal(recorded.completed, false);
    assert.equal(recorded.check.counts.remaining, 3);
    assert.equal(recorded.check.counts.checked, 2);
  });

  it("completes when everything is decided, and returns the candidates with what Gmail says about them", async () => {
    google.add(
      message("m1", "2026-10-10T01:00:00Z", { subject: "Invoice", from: "Shop <shop@example.test>" }),
      message("m2", "2026-10-10T02:00:00Z"),
    );
    const c = checks(s);
    const { checkId } = await c.begin("daily-2026-10-11");
    await runThrough(c, checkId, ["m1"]);
    const result = data(await c.reply(checkId));
    assert.equal(result.status, "complete");
    assert.equal(result.checkId, checkId);
    assert.deepEqual(result.requestKeys, ["daily-2026-10-11"]);
    assert.deepEqual(result.counts, { checked: 2, candidates: 1, skipped: 1, gone: 0, excluded: 0, remaining: 0, listingDone: true });
    assert.deepEqual(result.candidates, [
      {
        messageId: "m1",
        threadId: "t-m1",
        receivedAt: "2026-10-10T01:00:00.000Z",
        from: "Shop <shop@example.test>",
        subject: "Invoice",
        priority: "high",
        summary: "summary of m1",
        reason: "reason for m1",
        link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(ACCOUNT)}#all/m1`,
        attachments: [],
      },
    ]);
    assert.equal(result.candidatesTotal, 1);
    assert.equal(result.nextOffset, null);
    assert.equal(result.ackRequired, true);
    const reply = (await c.reply(checkId)) as { summary: string; sources: { url: string }[] };
    assert.match(reply.summary, /候補 1 件/);
    assert.equal(reply.sources[0]!.url, result.candidates[0]!.link);
  });

  it("keeps a completed check's candidates until it is acknowledged, and records what was reported", async () => {
    google.add(message("m1", "2026-10-10T01:00:00Z"), message("m2", "2026-10-10T02:00:00Z"));
    const c = checks(s);
    const { checkId } = await c.begin();
    await runThrough(c, checkId, ["m1", "m2"]);
    // Fetching the result again does not mark anything reported.
    assert.equal(data(await c.reply(checkId)).status, "complete");
    assert.equal(data(await c.reply(checkId)).candidatesTotal, 2);
    await assert.rejects(c.ack(checkId, ["m1", "elsewhere"]), /elsewhere/);
    const acked = data(await c.ack(checkId, ["m1"]));
    assert.equal(acked.status, "acknowledged");
    assert.deepEqual(acked.reportedMessageIds, ["m1"]);
    // A resent acknowledgement changes nothing and does not fail.
    assert.deepEqual(data(await c.ack(checkId, ["m1"])).reportedMessageIds, ["m1"]);
    // An acknowledgement with nothing reported (no important mail that day) is valid too.
    assert.equal(data(await c.reply(checkId)).status, "acknowledged");
    await assert.rejects(c.ack("gmc-unknown", []), /no check/);
  });

  it("returns the same check for the same request key, so a retried request does not start over", async () => {
    google.add(message("m1", "2026-10-10T01:00:00Z"));
    const c = checks(s);
    const first = await c.begin("daily-2026-10-11");
    await runThrough(c, first.checkId, ["m1"]);
    s.clock.advance(HOUR);
    google.add(message("m2", "2026-10-10T23:30:00Z"));
    const retried = await c.begin("daily-2026-10-11");
    assert.equal(retried.checkId, first.checkId);
    assert.equal(retried.status, "complete");
    assert.equal(retried.resumed, true);
  });

  it("starts the next check where the last completed one ended, and does not hand out a message twice", async () => {
    google.add(message("m1", "2026-10-10T22:30:00Z"));
    const c = checks(s);
    const first = await c.begin("day-1");
    assert.deepEqual(await runThrough(c, first.checkId), ["m1"]);
    await c.ack(first.checkId, []);
    s.clock.advance(24 * HOUR);
    // A message that reached the mailbox late, with a time just before the last check's end.
    google.add(message("late", "2026-10-10T22:50:00Z"), message("m2", "2026-10-11T10:00:00Z"));
    const second = await c.begin("day-2");
    assert.notEqual(second.checkId, first.checkId);
    assert.equal(second.from, first.to);
    assert.equal(second.to, "2026-10-11T23:00:00.000Z");
    assert.deepEqual((await runThrough(c, second.checkId)).sort(), ["late", "m2"]);
  });

  it("lists every page, and starts the listing over when Gmail no longer takes a page token", async () => {
    for (let i = 1; i <= 7; i += 1) google.add(message(`m${i}`, `2026-10-10T0${i}:00:00Z`));
    const c = checks(s, { batchSize: 3, listPageSize: 2 });
    const { checkId } = await c.begin();
    const first = await c.next(checkId);
    assert.equal(first.check.counts.remaining, 7);
    assert.equal(first.check.counts.listingDone, true);
    const decided = await runThrough(c, checkId);
    assert.equal(new Set(decided).size, 7);
    const pages = google.apiRequests().filter((r) => r.url.pathname.endsWith("/messages"));
    assert.equal(pages.length, 4);

    // The next check, where Gmail refuses a page token part way through the listing.
    s.clock.advance(HOUR);
    google.add(...[8, 9, 10, 11].map((i) => message(`n${i}`, `2026-10-10T23:${10 + i}:00Z`)));
    google.expiredPageTokens.add("p2");
    const second = await c.begin("x");
    assert.deepEqual((await runThrough(c, second.checkId)).sort(), ["n10", "n11", "n8", "n9"]);
  });

  it("does not lose its place when Gmail fails part way, and moves nothing forward until it succeeds", async () => {
    for (let i = 1; i <= 4; i += 1) google.add(message(`m${i}`, `2026-10-10T0${i}:00:00Z`));
    const c = checks(s, { batchSize: 2, listPageSize: 2 });
    const { checkId } = await c.begin();
    for (let i = 0; i < 4; i += 1) google.fail(/\/messages$/, 503);
    await assert.rejects(c.next(checkId), /503/);
    const failed = data(await c.reply(checkId));
    assert.equal(failed.status, "scanning");
    assert.equal(failed.counts.checked, 0);

    const first = await c.next(checkId);
    for (let i = 0; i < 4; i += 1) google.fail(/\/messages\/m\d$/, 500);
    await assert.rejects(c.next(checkId), /500/);
    const same = await c.next(checkId);
    assert.equal(same.batch!.batchId, first.batch!.batchId);
    await c.record(checkId, same.batch!.batchId, same.batch!.messages.map((m) => ({ messageId: m.id, verdict: "skip" as const })));
    assert.equal(data(await c.reply(checkId)).status, "scanning");
    await runThrough(c, checkId);
    assert.equal(data(await c.reply(checkId)).counts.checked, 4);
  });

  it("carries on after a restart from what is on disk", async () => {
    for (let i = 1; i <= 4; i += 1) google.add(message(`m${i}`, `2026-10-10T0${i}:00:00Z`));
    const before = checks(s, { batchSize: 2 });
    const { checkId } = await before.begin("daily");
    const outstanding = await before.next(checkId);
    // The process ends here, before the batch is recorded.
    const afterRestart = checks(s, { batchSize: 2 });
    const resumed = await afterRestart.begin("daily");
    assert.equal(resumed.checkId, checkId);
    const again = await afterRestart.next(checkId);
    assert.equal(again.batch!.batchId, outstanding.batch!.batchId);
    assert.equal((await runThrough(afterRestart, checkId)).length, 4);
  });

  it("extends an unfinished check to now when a new request comes, rather than leaving a gap", async () => {
    google.add(message("m1", "2026-10-10T01:00:00Z"), message("m2", "2026-10-10T02:00:00Z"));
    const c = checks(s, { batchSize: 1 });
    const first = await c.begin("day-1");
    const batch = await c.next(first.checkId);
    await c.record(first.checkId, batch.batch!.batchId, [{ messageId: batch.batch!.messages[0]!.id, verdict: "skip" }]);
    s.clock.advance(24 * HOUR);
    google.add(message("m3", "2026-10-11T12:00:00Z"));
    const second = await c.begin("day-2");
    assert.equal(second.checkId, first.checkId);
    assert.equal(second.to, "2026-10-11T23:00:00.000Z");
    assert.deepEqual(second.requestKeys, ["day-1", "day-2"]);
    assert.equal((await runThrough(c, first.checkId)).length, 2);
    assert.equal(data(await c.reply(first.checkId)).counts.checked, 3);
  });

  it("decides on its own the messages that are gone or have since moved to spam or trash", async () => {
    google.add(message("m1", "2026-10-10T01:00:00Z"), message("m2", "2026-10-10T02:00:00Z"), message("m3", "2026-10-10T03:00:00Z"));
    const c = checks(s);
    const { checkId } = await c.begin();
    // Listed, then deleted or moved before the bodies are read.
    await c.next(checkId).then(() => {});
    const state = JSON.parse(readFileSync(join(s.stateDir, "checks.json"), "utf8"));
    assert.ok(state.checks[0].batch);
    google.messages.delete("m1");
    google.messages.get("m2")!.labelIds = ["TRASH"];
    const c2 = checks(s);
    // A new process reads the batch again.
    const next = await c2.next(checkId);
    assert.deepEqual(next.batch!.messages.map((m) => m.id), ["m3"]);
    await c2.record(checkId, next.batch!.batchId, [{ messageId: "m3", verdict: "skip" }]);
    const result = data(await c2.reply(checkId));
    assert.equal(result.status, "complete");
    assert.deepEqual(result.counts, { checked: 3, candidates: 0, skipped: 1, gone: 1, excluded: 1, remaining: 0, listingDone: true });
  });

  it("completes a check with no mail at all", async () => {
    const c = checks(s);
    const { checkId } = await c.begin();
    const next = await c.next(checkId);
    assert.equal(next.batch, undefined);
    assert.equal(next.check.status, "complete");
    const reply = (await c.reply(checkId)) as { summary: string };
    assert.match(reply.summary, /候補 0 件/);
  });

  it("names the earlier checks that were never acknowledged", async () => {
    google.add(message("m1", "2026-10-10T01:00:00Z"));
    const c = checks(s);
    const first = await c.begin("day-1");
    await runThrough(c, first.checkId, ["m1"]);
    s.clock.advance(24 * HOUR);
    const second = await c.begin("day-2");
    await runThrough(c, second.checkId);
    assert.deepEqual(data(await c.reply(second.checkId)).unacknowledgedChecks, [first.checkId]);
    await c.ack(first.checkId, ["m1"]);
    assert.deepEqual(data(await c.reply(second.checkId)).unacknowledgedChecks, []);
  });

  it("adds a short note of a problem to the reply, without changing the status", async () => {
    const c = checks(s);
    const { checkId } = await c.begin();
    const reply = (await c.reply(checkId, 0, "Gmail の再認可が必要です（invalid_grant）。")) as { summary: string };
    assert.match(reply.summary, /^問題: Gmail の再認可が必要です/);
    const result = data(reply);
    assert.equal(result.status, "scanning");
    assert.equal(result.problem, "Gmail の再認可が必要です（invalid_grant）。");
    assert.equal(data(await c.reply(checkId)).problem, null);
    await assert.rejects(c.reply(checkId, 0, "x".repeat(301)), /300/);
  });

  it("pages the candidates of a large check", async () => {
    for (let i = 0; i < 35; i += 1) google.add(message(`m${String(i).padStart(2, "0")}`, new Date(Date.parse("2026-10-10T01:00:00Z") + i * 60_000).toISOString()));
    const c = checks(s, { batchSize: 20 });
    const { checkId } = await c.begin();
    await runThrough(c, checkId, [...google.messages.keys()]);
    const first = data(await c.reply(checkId));
    assert.equal(first.candidatesTotal, 35);
    assert.equal(first.candidates.length, 30);
    assert.equal(first.nextOffset, 30);
    const rest = data(await c.reply(checkId, 30));
    assert.equal(rest.candidates.length, 5);
    assert.equal(rest.offset, 30);
    assert.equal(rest.nextOffset, null);
  });

  it("keeps every reply within the reply contract, even with many attachments, and reaches every candidate by nextOffset", async () => {
    for (let i = 0; i < 35; i += 1) {
      const id = `m${String(i).padStart(2, "0")}`;
      const attachments = Array.from({ length: 10 }, (_, j) => attachmentPart(`${"a".repeat(54)}-${id}${j}.txt`.slice(0, 60), "text/plain", `${id}-a${j}`, 10));
      google.add(
        message(id, new Date(Date.parse("2026-10-10T01:00:00Z") + i * 60_000).toISOString(), {
          payload: multipart("multipart/mixed", [textPart("body"), ...attachments]),
        }),
      );
    }
    const c = checks(s, { batchSize: 20 });
    const { checkId } = await c.begin();
    await runThrough(c, checkId, [...google.messages.keys()]);
    const reached: string[] = [];
    let offset: number | null = 0;
    for (let page = 0; offset !== null && page < 10; page += 1) {
      const reply = await c.reply(checkId, offset);
      const body = (reply as { sections: { title: string; body: string }[] }).sections[0]!.body;
      assert.ok([...body].length <= 50_000, `the gmail-check section has ${[...body].length} characters`);
      const result = data(reply);
      assert.equal(result.candidates[0]!.attachments.length, 10);
      reached.push(...result.candidates.map((candidate) => candidate.messageId));
      offset = result.nextOffset;
    }
    assert.equal(offset, null);
    assert.deepEqual(reached.sort(), [...google.messages.keys()].sort());
  });

  it("refuses summaries and reasons that are too long rather than cutting them", async () => {
    google.add(message("m1", "2026-10-10T01:00:00Z"));
    const c = checks(s);
    const { checkId } = await c.begin();
    const next = await c.next(checkId);
    await assert.rejects(
      c.record(checkId, next.batch!.batchId, [{ messageId: "m1", verdict: "candidate", summary: "x".repeat(401), reason: "r" }]),
      /summary.*400/,
    );
  });

  it("lets only one check scan at a time, even with two processes", async () => {
    google.add(message("m1", "2026-10-10T01:00:00Z"));
    const [a, b] = await Promise.all([checks(s).begin("k1"), checks(s).begin("k2")]);
    assert.equal(a.checkId, b.checkId);
  });

  it("loses no change when processes change the state at the same time", async () => {
    const c = checks(s);
    const { checkId } = await c.begin("k-0");
    const lib = join(import.meta.dirname, "..", "lib", "gmail-check.ts");
    const script = `
      const { GmailChecks } = await import(${JSON.stringify(lib)});
      const checks = new GmailChecks({ stateDir: process.argv[1], client: {}, timeZone: "UTC", now: () => new Date(${JSON.stringify(s.clock.now().toISOString())}) });
      for (let i = 0; i < 25; i += 1) await checks.begin("k-" + process.argv[2] + "-" + i);
    `;
    const run = (n: number) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, s.stateDir, String(n)], { stdio: "inherit" });
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${n} exited with ${code}`))));
      });
    await Promise.all([run(1), run(2), run(3)]);
    const state = JSON.parse(readFileSync(join(s.stateDir, "checks.json"), "utf8"));
    assert.equal(state.checks.length, 1);
    assert.equal(state.checks[0].checkId, checkId);
    assert.equal(state.checks[0].requestKeys.length, 76);
  });

  it("takes over a lock left behind by a process that died", async () => {
    const c = checks(s);
    await c.begin();
    const lock = join(s.stateDir, "checks.lock");
    writeFileSync(lock, "12345");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    await c.begin();
    assert.equal(existsSync(lock), false);
  });

  it("keeps its state readable only by itself", async () => {
    await checks(s).begin();
    assert.equal(statSync(s.stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(s.stateDir, "checks.json")).mode & 0o777, 0o600);
  });

  it("forgets acknowledged checks after 30 days", async () => {
    const c = checks(s);
    const first = await c.begin("day-1");
    await runThrough(c, first.checkId);
    await c.ack(first.checkId, []);
    s.clock.advance(31 * 24 * HOUR);
    const later = await c.begin("day-32");
    await runThrough(c, later.checkId);
    await assert.rejects(c.reply(first.checkId), /no check/);
  });
});
