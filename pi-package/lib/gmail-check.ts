// The Gmail Agent's checks (ADR 0016): the mail received in a window of time, gone through in batches that the
// model decides one by one, with the state on disk so that a failure, a restart or a page of the listing never
// loses a message. A check is complete when every message of its window is decided; it is acknowledged when the
// caller (natsumi) says which candidates it reported. The two are kept apart: fetching the result never marks
// anything reported. The contract the caller follows is docs/gmail-agent/check-contract.md.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { formatInstant } from "./calendar.ts";
import {
  attachmentsOf,
  GmailApiError,
  gmailLink,
  type GmailClient,
  type GmailMessage,
  messageHeader,
  receivedAt,
} from "./gmail.ts";
import type { Reply } from "./reply.ts";

/** The name of the machine-readable part of a check's reply. */
export const CHECK_CONTRACT = "fraction-agents/gmail-check/v1";
/** The title of the reply's section that holds the machine-readable part. */
export const CHECK_SECTION = "gmail-check";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The window of the first check. Older mail is found by searching. */
const FIRST_WINDOW_MS = DAY;
/** How far back past the last check's end a listing starts, for mail that reaches the mailbox late. */
const OVERLAP_MS = HOUR;
const LIST_PAGE_SIZE = 500;
/** Pages listed in one call of next; the listing carries on in the next call. */
const LIST_PAGES_PER_CALL = 20;
const BATCH_SIZE = 10;
const CANDIDATES_PER_REPLY = 30;
/** The reply contract's limit of a section's body, which holds the machine-readable part in its fence. */
const SECTION_CHARS_LIMIT = 50_000;
const CHECK_RETENTION_MS = 30 * DAY;
const SEEN_RETENTION_MS = 7 * DAY;
const REPORTED_RETENTION_MS = 90 * DAY;
const SUMMARY_LIMIT = 400;
const REASON_LIMIT = 300;
const FIELD_LIMIT = 200;
const ATTACHMENTS_LIMIT = 10;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 15_000;

export type CheckStatus = "scanning" | "complete" | "acknowledged";
export type Priority = "high" | "normal" | "low";

/** The model's decision on one message of a batch. */
export interface Decision {
  messageId: string;
  verdict: "candidate" | "skip";
  priority?: Priority;
  summary?: string;
  reason?: string;
}

interface MessageMeta {
  threadId: string;
  receivedAt: string;
  from: string;
  subject: string;
  link: string;
  attachments: { filename: string; mimeType: string; size: number }[];
}

interface Decided {
  messageId: string;
  /** gone: deleted before it was read; excluded: moved to spam or trash, or a sent message or a draft. */
  verdict: "candidate" | "skip" | "gone" | "excluded";
  priority?: Priority;
  summary?: string;
  reason?: string;
  meta?: MessageMeta;
}

interface Segment {
  after: string;
  before: string;
  pageToken?: string;
  done: boolean;
}

interface StoredCheck {
  checkId: string;
  requestKeys: string[];
  status: CheckStatus;
  createdAt: string;
  completedAt?: string;
  acknowledgedAt?: string;
  from: string;
  to: string;
  segments: Segment[];
  queue: string[];
  batch?: { batchId: string; ids: string[]; meta: Record<string, MessageMeta> };
  decided: Decided[];
  reportedMessageIds?: string[];
}

interface State {
  version: 1;
  /** The end of the last completed check. The next check starts here. */
  checkedThrough?: string;
  checks: StoredCheck[];
  /** Messages decided in completed checks, so that the overlap does not hand them out again. */
  seen: { id: string; at: string }[];
  /** Messages the caller said it reported. */
  reported: { id: string; at: string; checkId: string }[];
}

export interface CheckCounts {
  checked: number;
  candidates: number;
  skipped: number;
  gone: number;
  excluded: number;
  remaining: number;
  listingDone: boolean;
}

export interface CheckView {
  checkId: string;
  status: CheckStatus;
  requestKeys: string[];
  from: string;
  to: string;
  counts: CheckCounts;
  /** True when an existing check was returned rather than a new one started. */
  resumed: boolean;
}

export interface Candidate extends MessageMeta {
  messageId: string;
  priority: Priority;
  summary: string;
  reason: string;
}

/** The machine-readable part of a check's reply (docs/gmail-agent/check-contract.md). */
export interface CheckData {
  contract: typeof CHECK_CONTRACT;
  checkId: string;
  requestKeys: string[];
  status: CheckStatus;
  window: { from: string; to: string };
  counts: CheckCounts;
  candidates: Candidate[];
  candidatesTotal: number;
  offset: number;
  nextOffset: number | null;
  ackRequired: boolean;
  reportedMessageIds: string[];
  unacknowledgedChecks: string[];
  /** What went wrong in this request, as the agent noted it (e.g. the authorization must be renewed). */
  problem: string | null;
}

export interface GmailChecksOptions {
  stateDir: string;
  client: GmailClient;
  timeZone: string;
  now?: () => Date;
  batchSize?: number;
  listPageSize?: number;
}

export class GmailChecks {
  readonly #dir: string;
  readonly #file: string;
  readonly #lock: string;
  readonly #client: GmailClient;
  readonly #timeZone: string;
  readonly #now: () => Date;
  readonly #batchSize: number;
  readonly #listPageSize: number;

  constructor(options: GmailChecksOptions) {
    this.#dir = options.stateDir;
    this.#file = join(options.stateDir, "checks.json");
    this.#lock = join(options.stateDir, "checks.lock");
    this.#client = options.client;
    this.#timeZone = options.timeZone;
    this.#now = options.now ?? (() => new Date());
    this.#batchSize = options.batchSize ?? BATCH_SIZE;
    this.#listPageSize = options.listPageSize ?? LIST_PAGE_SIZE;
  }

  /**
   * The check for a request. The same request key always gives the same check, so a retried request carries on
   * rather than starting over. Otherwise an unfinished check is carried on (and stretched to now, so that no time
   * is left out), or a new one starts where the last completed one ended (the last 24 hours the first time).
   */
  async begin(requestKey?: string): Promise<CheckView> {
    const key = requestKey?.trim() || undefined;
    if (key !== undefined && (key.length > FIELD_LIMIT || /\s/.test(key))) throw new Error(`requestKey must be one word of at most ${FIELD_LIMIT} characters`);
    return this.#update((state) => {
      const now = this.#now();
      prune(state, now);
      if (key) {
        const known = state.checks.find((c) => c.requestKeys.includes(key));
        if (known) return view(known, true);
      }
      const open = state.checks.find((c) => c.status === "scanning");
      if (open) {
        if (key) open.requestKeys.push(key);
        if (now.getTime() > Date.parse(open.to)) {
          open.segments.push({ after: iso(Date.parse(open.to) - OVERLAP_MS), before: now.toISOString(), done: false });
          open.to = now.toISOString();
        }
        return view(open, true);
      }
      const from = state.checkedThrough ?? iso(now.getTime() - FIRST_WINDOW_MS);
      const after = state.checkedThrough ? iso(Date.parse(from) - OVERLAP_MS) : from;
      const check: StoredCheck = {
        checkId: newCheckId(now),
        requestKeys: key ? [key] : [],
        status: "scanning",
        createdAt: now.toISOString(),
        from,
        to: now.toISOString(),
        segments: [{ after, before: now.toISOString(), done: false }],
        queue: [],
        decided: [],
      };
      state.checks.push(check);
      return view(check, false);
    });
  }

  /**
   * The open batch of a check: its messages, read from Gmail. The same batch comes back until every message of
   * it is recorded; nothing is skipped. Lists the window first. Messages that are gone or have moved to spam or
   * trash are decided here. When nothing is left, the check completes and no batch is returned.
   */
  async next(checkId: string, signal?: AbortSignal): Promise<{ check: CheckView; batch?: { batchId: string; messages: GmailMessage[] } }> {
    await this.#list(checkId, signal);
    for (let round = 0; round < 100; round += 1) {
      const opened = this.#update((state) => {
        const check = find(state, checkId);
        if (check.status !== "scanning") return { check: view(check, true) };
        if (!check.batch && check.queue.length > 0) {
          check.batch = { batchId: `b-${randomBytes(6).toString("hex")}`, ids: check.queue.splice(0, this.#batchSize), meta: {} };
        }
        if (!check.batch) {
          if (check.segments.every((s) => s.done)) complete(state, check, this.#now());
          return { check: view(check, true) };
        }
        return { check: view(check, true), batch: { batchId: check.batch.batchId, ids: [...check.batch.ids] } };
      });
      if (!opened.batch) return { check: opened.check };

      const account = await this.#client.account(signal);
      const messages: GmailMessage[] = [];
      const settled: Decided[] = [];
      for (const id of opened.batch.ids) {
        let message: GmailMessage;
        try {
          message = await this.#client.getMessage(id, "full", signal);
        } catch (error) {
          if (error instanceof GmailApiError && error.status === 404) {
            settled.push({ messageId: id, verdict: "gone" });
            continue;
          }
          throw error;
        }
        if ((message.labelIds ?? []).some((label) => ["SPAM", "TRASH", "SENT", "DRAFT"].includes(label))) {
          settled.push({ messageId: id, verdict: "excluded" });
          continue;
        }
        messages.push(message);
      }
      const result = this.#update((state) => {
        const check = find(state, checkId);
        const batch = check.batch;
        // Another process recorded this batch meanwhile: start over with what is there now.
        if (check.status !== "scanning" || !batch || batch.batchId !== opened.batch.batchId) return undefined;
        for (const decided of settled) {
          if (!check.decided.some((d) => d.messageId === decided.messageId)) check.decided.push(decided);
        }
        batch.ids = batch.ids.filter((id) => !settled.some((d) => d.messageId === id));
        for (const message of messages) batch.meta[message.id] = metaOf(message, account);
        if (batch.ids.length === 0) {
          delete check.batch;
          return undefined;
        }
        return { check: view(check, true), batch: { batchId: batch.batchId, messages: messages.filter((m) => batch.ids.includes(m.id)) } };
      });
      if (result) return result;
    }
    throw new Error("The check could not settle on a batch; call gmail_check_next again.");
  }

  /** Records the decision on every message of the open batch. The check completes when nothing is left. */
  async record(checkId: string, batchId: string, decisions: Decision[]): Promise<{ check: CheckView; completed: boolean }> {
    return this.#update((state) => {
      const check = find(state, checkId);
      const decidedIds = new Set(check.decided.map((d) => d.messageId));
      const batch = check.batch;
      if (!batch || batch.batchId !== batchId) {
        // A resent record of a batch already recorded: nothing to do.
        if (decisions.length > 0 && decisions.every((d) => decidedIds.has(d.messageId))) {
          return { check: view(check, true), completed: check.status !== "scanning" };
        }
        throw new Error(`${batchId} is not the open batch of ${checkId}. Call gmail_check_next for it.`);
      }
      const given = decisions.map((d) => d.messageId);
      const strangers = given.filter((id) => !batch.ids.includes(id));
      if (strangers.length > 0) throw new Error(`These messages are not in this batch: ${strangers.join(", ")}`);
      const twice = given.filter((id, i) => given.indexOf(id) !== i);
      if (twice.length > 0) throw new Error(`These messages are decided twice: ${twice.join(", ")}`);
      const missing = batch.ids.filter((id) => !given.includes(id));
      if (missing.length > 0) throw new Error(`Decide every message of the batch; missing: ${missing.join(", ")}`);
      const unread = batch.ids.filter((id) => !batch.meta[id]);
      if (unread.length > 0) throw new Error(`The batch's messages were not read yet; call gmail_check_next first.`);
      const entries = decisions.map((d) => decide(d, batch.meta[d.messageId]!));
      check.decided.push(...entries);
      delete check.batch;
      const completed = check.queue.length === 0 && check.segments.every((s) => s.done);
      if (completed) complete(state, check, this.#now());
      return { check: view(check, true), completed };
    });
  }

  /**
   * The check's result as a reply in the shape of the reply contract. Reading it marks nothing reported. A problem
   * (one line) is shown to the caller, but changes nothing of the check.
   */
  async reply(checkId: string, offset = 0, problem?: string): Promise<Reply> {
    const note = (problem ?? "").replace(/\s+/g, " ").trim();
    if ([...note].length > REASON_LIMIT) throw new Error(`problem is longer than ${REASON_LIMIT} characters; write it shorter.`);
    const state = this.#read();
    return buildReply(state, find(state, checkId), offset, this.#timeZone, note || null);
  }

  /**
   * Records which messages of a completed check the caller reported (none is fine). Resending it is harmless:
   * the IDs are added to those already recorded.
   */
  async ack(checkId: string, reportedMessageIds: string[]): Promise<Reply> {
    return this.#update((state) => {
      const check = find(state, checkId);
      if (check.status === "scanning") throw new Error(`${checkId} is not complete yet, so it cannot be acknowledged. Finish it first.`);
      const known = new Set(check.decided.map((d) => d.messageId));
      const strangers = reportedMessageIds.filter((id) => !known.has(id));
      if (strangers.length > 0) throw new Error(`These are not messages of ${checkId}: ${strangers.join(", ")}`);
      const now = this.#now().toISOString();
      const reported = check.reportedMessageIds ?? [];
      for (const id of reportedMessageIds) {
        if (reported.includes(id)) continue;
        reported.push(id);
        state.reported.push({ id, at: now, checkId });
      }
      check.reportedMessageIds = reported;
      check.status = "acknowledged";
      check.acknowledgedAt ??= now;
      return buildReply(state, check, 0, this.#timeZone, null);
    });
  }

  /** Lists the windows of a check, a page at a time, until every page is listed or the call's pages are used. */
  async #list(checkId: string, signal?: AbortSignal): Promise<void> {
    for (let page = 0; page < LIST_PAGES_PER_CALL; page += 1) {
      const todo = this.#update((state) => {
        const check = find(state, checkId);
        if (check.status !== "scanning") return undefined;
        const index = check.segments.findIndex((s) => !s.done);
        return index < 0 ? undefined : { index, segment: { ...check.segments[index]! } };
      });
      if (!todo) return;
      let result: { ids: string[]; nextPageToken?: string };
      try {
        result = await this.#client.listMessages(
          { query: windowQuery(todo.segment), pageToken: todo.segment.pageToken, maxResults: this.#listPageSize },
          signal,
        );
      } catch (error) {
        // Gmail no longer takes the page token: list the window again from its start. The IDs already in hand are
        // not taken twice.
        if (error instanceof GmailApiError && error.status === 400 && todo.segment.pageToken) {
          this.#update((state) => {
            delete find(state, checkId).segments[todo.index]!.pageToken;
          });
          continue;
        }
        throw error;
      }
      this.#update((state) => {
        const check = find(state, checkId);
        const segment = check.segments[todo.index];
        if (!segment || segment.done || segment.pageToken !== todo.segment.pageToken) return;
        const known = new Set([...check.queue, ...(check.batch?.ids ?? []), ...check.decided.map((d) => d.messageId), ...state.seen.map((s) => s.id)]);
        for (const id of result.ids) {
          if (known.has(id)) continue;
          known.add(id);
          check.queue.push(id);
        }
        if (result.nextPageToken) segment.pageToken = result.nextPageToken;
        else {
          delete segment.pageToken;
          segment.done = true;
        }
      });
    }
  }

  // --- The state on disk ---------------------------------------------------------------------------------------

  #read(): State {
    if (!existsSync(this.#file)) return { version: 1, checks: [], seen: [], reported: [] };
    // A file that cannot be read stops the checks rather than being replaced: it holds the window's progress.
    const state = JSON.parse(readFileSync(this.#file, "utf8")) as State;
    if (state.version !== 1 || !Array.isArray(state.checks)) throw new Error(`${this.#file} is not a Gmail check state this agent knows`);
    return state;
  }

  #write(state: State): void {
    const temporary = `${this.#file}.${process.pid}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.#file);
  }

  /** Reads, changes and writes the state under the lock. Synchronous, so nothing else runs in between. */
  #update<T>(change: (state: State) => T): T {
    if (!existsSync(this.#dir)) {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      chmodSync(this.#dir, 0o700);
    }
    this.#acquire();
    try {
      const state = this.#read();
      const result = change(state);
      this.#write(state);
      return result;
    } finally {
      try {
        unlinkSync(this.#lock);
      } catch {
        // Taken over as stale meanwhile; nothing to release.
      }
    }
  }

  /** A lock file shared with the other pi processes of the agent. One left by a process that died is taken over. */
  #acquire(): void {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(this.#lock, "wx", 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      try {
        if (Date.now() - statSync(this.#lock).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(this.#lock);
          continue;
        }
      } catch {
        // Released meanwhile.
        continue;
      }
      if (Date.now() > deadline) throw new Error("The Gmail check state is busy; try again shortly.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function newCheckId(now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `gmc-${stamp}-${randomBytes(3).toString("hex")}`;
}

function find(state: State, checkId: string): StoredCheck {
  const check = state.checks.find((c) => c.checkId === checkId);
  if (!check) throw new Error(`There is no check ${checkId} (it may have been forgotten after 30 days). Start one with gmail_check_begin.`);
  return check;
}

/** The query of a window: everything received in it but spam, trash, sent mail, drafts and chats. */
function windowQuery(segment: Segment): string {
  const after = Math.floor(Date.parse(segment.after) / 1000);
  const before = Math.floor(Date.parse(segment.before) / 1000);
  return `after:${after} before:${before} -in:spam -in:trash -in:sent -in:drafts -in:chats`;
}

function complete(state: State, check: StoredCheck, now: Date): void {
  check.status = "complete";
  check.completedAt = now.toISOString();
  if (!state.checkedThrough || Date.parse(state.checkedThrough) < Date.parse(check.to)) state.checkedThrough = check.to;
  const at = now.toISOString();
  const seen = new Set(state.seen.map((s) => s.id));
  for (const d of check.decided) if (!seen.has(d.messageId)) state.seen.push({ id: d.messageId, at });
}

function prune(state: State, now: Date): void {
  const t = now.getTime();
  state.checks = state.checks.filter((c) => c.status === "scanning" || Date.parse(c.completedAt ?? c.createdAt) > t - CHECK_RETENTION_MS);
  state.seen = state.seen.filter((s) => Date.parse(s.at) > t - SEEN_RETENTION_MS);
  state.reported = state.reported.filter((r) => Date.parse(r.at) > t - REPORTED_RETENTION_MS);
}

function cut(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
}

function metaOf(message: GmailMessage, account: string): MessageMeta {
  const received = receivedAt(message);
  return {
    threadId: message.threadId ?? message.id,
    receivedAt: received ? received.toISOString() : "",
    from: cut(messageHeader(message, "From"), FIELD_LIMIT),
    subject: cut(messageHeader(message, "Subject") || "(no subject)", FIELD_LIMIT),
    link: gmailLink(account, message.id),
    attachments: attachmentsOf(message.payload)
      .slice(0, ATTACHMENTS_LIMIT)
      .map((a) => ({ filename: cut(a.filename, 100), mimeType: a.mimeType, size: a.size })),
  };
}

function decide(d: Decision, meta: MessageMeta): Decided {
  const oneLine = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const summary = oneLine(d.summary);
  const reason = oneLine(d.reason);
  const limit = (name: string, value: string, max: number) => {
    if ([...value].length > max) throw new Error(`${d.messageId}: ${name} is longer than ${max} characters; write it shorter.`);
  };
  if (d.verdict === "candidate") {
    if (!summary) throw new Error(`${d.messageId}: a candidate needs a summary`);
    if (!reason) throw new Error(`${d.messageId}: a candidate needs a reason`);
    limit("summary", summary, SUMMARY_LIMIT);
    limit("reason", reason, REASON_LIMIT);
    const priority = d.priority ?? "normal";
    if (!["high", "normal", "low"].includes(priority)) throw new Error(`${d.messageId}: priority is high, normal or low`);
    return { messageId: d.messageId, verdict: "candidate", priority, summary, reason, meta };
  }
  if (d.verdict !== "skip") throw new Error(`${d.messageId}: verdict is candidate or skip`);
  limit("reason", reason, REASON_LIMIT);
  return { messageId: d.messageId, verdict: "skip", ...(reason ? { reason } : {}) };
}

function counts(check: StoredCheck): CheckCounts {
  const count = (verdict: Decided["verdict"]) => check.decided.filter((d) => d.verdict === verdict).length;
  return {
    checked: check.decided.length,
    candidates: count("candidate"),
    skipped: count("skip"),
    gone: count("gone"),
    excluded: count("excluded"),
    remaining: check.queue.length + (check.batch?.ids.length ?? 0),
    listingDone: check.segments.every((s) => s.done),
  };
}

function view(check: StoredCheck, resumed: boolean): CheckView {
  return {
    checkId: check.checkId,
    status: check.status,
    requestKeys: [...check.requestKeys],
    from: check.from,
    to: check.to,
    counts: counts(check),
    resumed,
  };
}

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

function candidatesOf(check: StoredCheck): Candidate[] {
  return check.decided
    .filter((d): d is Decided & { meta: MessageMeta } => d.verdict === "candidate" && !!d.meta)
    .map((d) => ({
      messageId: d.messageId,
      threadId: d.meta.threadId,
      receivedAt: d.meta.receivedAt,
      from: d.meta.from,
      subject: d.meta.subject,
      priority: d.priority ?? "normal",
      summary: d.summary ?? "",
      reason: d.reason ?? "",
      link: d.meta.link,
      attachments: d.meta.attachments,
    }))
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.receivedAt.localeCompare(b.receivedAt));
}

function checkData(state: State, check: StoredCheck, offset: number, problem: string | null): CheckData {
  const all = candidatesOf(check);
  const start = Math.min(Math.max(0, Math.floor(offset)), all.length);
  const data: CheckData = {
    contract: CHECK_CONTRACT,
    checkId: check.checkId,
    requestKeys: [...check.requestKeys],
    status: check.status,
    window: { from: check.from, to: check.to },
    counts: counts(check),
    candidates: [],
    candidatesTotal: all.length,
    offset: start,
    nextOffset: null,
    ackRequired: check.status === "complete",
    reportedMessageIds: [...(check.reportedMessageIds ?? [])],
    unacknowledgedChecks: state.checks.filter((c) => c.status === "complete" && c.checkId !== check.checkId).map((c) => c.checkId),
    problem,
  };
  // As many candidates as fit, up to the page's size; the rest are a call with nextOffset away. Measured as it is
  // sent: the indented JSON in its fence (with this page's nextOffset), counted in code points as the contract counts.
  for (const candidate of all.slice(start, start + CANDIDATES_PER_REPLY)) {
    data.candidates.push(candidate);
    const end = start + data.candidates.length;
    data.nextOffset = end < all.length ? end : null;
    if (data.candidates.length > 1 && [...dataSection(data)].length > SECTION_CHARS_LIMIT) {
      data.candidates.pop();
      data.nextOffset = start + data.candidates.length;
      break;
    }
  }
  return data;
}

/** The body of the gmail-check section: the data as indented JSON in a json fence. */
function dataSection(data: CheckData): string {
  return `\`\`\`json\n${JSON.stringify(data, null, 1)}\n\`\`\``;
}

function buildReply(state: State, check: StoredCheck, offset: number, timeZone: string, problem: string | null): Reply {
  const data = checkData(state, check, offset, problem);
  const c = data.counts;
  const more = data.nextOffset === null ? "" : ` この返事は候補 ${data.offset + 1}〜${data.nextOffset} 件目。続きは offset ${data.nextOffset} で依頼してください。`;
  let summary: string;
  if (check.status === "scanning") {
    summary = `Gmail チェック ${check.checkId} は途中です: ${c.checked} 件を確認、残り ${c.remaining} 件${c.listingDone ? "" : "以上"}。同じ requestKey で続きを依頼してください。`;
  } else if (check.status === "complete") {
    summary = `Gmail チェック ${check.checkId} 完了: ${c.checked} 件を確認、候補 ${data.candidatesTotal} 件。報告したメールの ID で ack してください。${more}`;
  } else {
    summary = `Gmail チェック ${check.checkId} は ack 済み: 候補 ${data.candidatesTotal} 件、報告済み ${data.reportedMessageIds.length} 件。${more}`;
  }
  const sections = [{ title: CHECK_SECTION, body: dataSection(data) }];
  for (const candidate of data.candidates) {
    const received = candidate.receivedAt ? formatInstant(new Date(candidate.receivedAt), timeZone) : "(unknown)";
    const attachments = candidate.attachments.map((a) => `${a.filename} (${a.mimeType})`).join(", ");
    sections.push({
      title: cut(`[${candidate.priority}] ${candidate.subject}`.replace(/\s+/g, " "), 200),
      body: [
        `- 差出人: ${candidate.from}`,
        `- 受信: ${received}`,
        `- 要約: ${candidate.summary}`,
        `- 理由: ${candidate.reason}`,
        ...(attachments ? [`- 添付: ${attachments}`] : []),
        `- Gmail: ${candidate.link}`,
        `- messageId: ${candidate.messageId}`,
      ].join("\n"),
    });
  }
  const sources = data.candidates.map((candidate) => ({ title: cut(candidate.subject.replace(/\s+/g, " "), 300), url: candidate.link }));
  return { summary: cut(problem ? `問題: ${problem}\n${summary}` : summary, 500), sections, sources };
}
