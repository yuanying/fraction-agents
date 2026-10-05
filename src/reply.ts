import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { checkReply as checkReplyShape, type Reply } from "../pi-package/lib/reply.ts";

export type { Reply };

/**
 * The A2A extension of the reply contract (ADR 0015). A caller that activates it gets the agent's reply as a data
 * part in the shape of `docs/extensions/reply/v1/reply.schema.json`, next to the text.
 */
export const REPLY_EXTENSION_URI = "https://github.com/yuanying/fraction-agents/tree/main/docs/extensions/reply/v1";

/** The environment variable that tells pi (and the submit_reply tool in it) where to hand the reply over. */
export const REPLY_FILE_ENV = "FRACTION_AGENTS_REPLY_FILE";

export type CheckedReply = { ok: true; reply: Reply } | { ok: false; error: string };

/** Checks a value against the reply contract, as `reply.schema.json` does, and says what is wrong if it is not. */
export function checkReply(value: unknown): CheckedReply {
  const error = checkReplyShape(value);
  return error === undefined ? { ok: true, reply: value as Reply } : { ok: false, error };
}

/**
 * The reply as Markdown, for the text part: the summary as the first paragraph, a heading per section, and the
 * sources as a list of links. A caller that reads text alone gets all of it.
 */
export function renderReply(reply: Reply): string {
  const blocks = [reply.summary];
  for (const section of reply.sections) blocks.push(`## ${section.title}\n\n${section.body}`);
  if (reply.sources.length > 0) {
    blocks.push(`## Sources\n\n${reply.sources.map((source) => `- [${source.title}](${source.url})`).join("\n")}`);
  }
  return blocks.join("\n\n");
}

/**
 * The replies tasks submit (ADR 0015). While a task runs, the submit_reply tool writes the reply to the context's
 * reply file; when the task completes, the host takes it from there. When it does not complete, it is dropped.
 */
export class Replies {
  readonly #dir: string;

  /** `<dataDir>/replies`. */
  constructor(dir: string) {
    this.#dir = dir;
  }

  /** The context's reply file. Only context IDs the host numbers are used as names. */
  fileOf(contextId: string): string {
    return replyFile(this.#dir, contextId);
  }

  /**
   * The reply submitted in the context, if there is one in the shape of the contract, and removes it. A reply that
   * breaks the contract is logged and left out: the task completes with its text alone.
   */
  take(contextId: string, taskId: string): Reply | undefined {
    const file = this.fileOf(contextId);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return undefined;
    } finally {
      rmSync(file, { force: true });
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      console.log(`task ${taskId}: left out the reply: not JSON`);
      return undefined;
    }
    const checked = checkReply(value);
    if (!checked.ok) {
      console.log(`task ${taskId}: left out the reply: ${checked.error}`);
      return undefined;
    }
    return checked.reply;
  }

  /** Drops the reply submitted in the context, if any. */
  discard(contextId: string): void {
    rmSync(this.fileOf(contextId), { force: true });
  }

  /** Drops every reply. At start-up nothing is running, so none of them belongs to a task that can complete. */
  discardAll(): void {
    rmSync(this.#dir, { recursive: true, force: true });
  }
}

const CONTEXT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The reply file of a context under `<dataDir>/replies`. */
export function replyFile(repliesDir: string, contextId: string): string {
  if (!CONTEXT_ID.test(contextId)) throw new Error(`not a context ID: ${JSON.stringify(contextId)}`);
  return join(repliesDir, `${contextId}.json`);
}
