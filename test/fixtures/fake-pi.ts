// A stand-in for `pi --mode rpc --session <file>` that speaks just enough of the RPC protocol for the host's tests.
// It remembers the conversation by appending one line per prompt to the session file, so a restarted process
// on the same file continues the count. Every start is logged to `spawns.log` in the working directory.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { IMAGES } from "./images.ts";

const sessionIndex = process.argv.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;
if (process.argv[2] !== "--mode" || process.argv[3] !== "rpc" || !sessionFile) {
  process.stderr.write(`fake-pi: unexpected arguments ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(2);
}
appendFileSync("spawns.log", `${sessionFile}\n`);

let aborted = false;
let nextDialog = 1;
const dialogs = new Map<string, (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void>();

/** Opens a dialog the way an extension's `ctx.ui.*` does in RPC mode, and waits for the host's response. */
function dialog(method: string, fields: Record<string, unknown>): Promise<{ value?: string; confirmed?: boolean; cancelled?: boolean }> {
  const id = `ui-${nextDialog++}`;
  emit({ type: "extension_ui_request", id, method, ...fields });
  return new Promise((resolve) => dialogs.set(id, resolve));
}

function describeAnswer(response: { value?: string; confirmed?: boolean; cancelled?: boolean }): string {
  if (response.cancelled) return "<cancelled>";
  if (response.confirmed !== undefined) return `confirmed=${response.confirmed}`;
  return response.value ?? "<none>";
}
let pending: NodeJS.Timeout | undefined;
let finishPending: (() => void) | undefined;

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function turns(): number {
  return existsSync(sessionFile!) ? readFileSync(sessionFile!, "utf8").split("\n").filter(Boolean).length : 0;
}

function settle(message: Record<string, unknown>): void {
  emit({ type: "message_end", message });
  emit({ type: "agent_end", messages: [message], willRetry: false });
  emit({ type: "agent_settled" });
}

function assistant(text: string, stopReason = "stop", errorMessage?: string): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "text", text }], stopReason, ...(errorMessage ? { errorMessage } : {}) };
}

function prompt(message: string): void {
  aborted = false;
  appendFileSync(sessionFile!, `${JSON.stringify({ role: "user", message })}\n`);
  emit({ type: "agent_start" });
  if (message === "crash") {
    process.exit(3);
  }
  if (message === "fail") {
    settle(assistant("", "error", "model exploded"));
    return;
  }
  const reply = () =>
    settle(
      assistant(
        `echo:${message}|turn=${turns()}|caller=${process.env.FRACTION_AGENTS_CALLER}|agentDir=${process.env.PI_CODING_AGENT_DIR}`,
      ),
    );
  if (message === "env") {
    settle(assistant(JSON.stringify(Object.keys(process.env).sort())));
    return;
  }
  if (message === "cwd") {
    settle(assistant(JSON.stringify({ cwd: process.cwd(), contextId: process.env.FRACTION_AGENTS_CONTEXT_ID })));
    return;
  }
  // "ask:<q1>|<q2>" asks each question in turn through an input dialog, then replies with the answers.
  const ask = /^ask:(.*)$/.exec(message);
  if (ask) {
    void (async () => {
      emit({ type: "extension_ui_request", id: "status-1", method: "setStatus", statusKey: "fake", statusText: "asking" });
      const answers: string[] = [];
      for (const question of ask[1]!.split("|")) {
        answers.push(describeAnswer(await dialog("input", { title: question, placeholder: "your answer" })));
        if (aborted) {
          settle(assistant("", "aborted"));
          return;
        }
      }
      settle(assistant(`answers:${answers.join("|")}`));
    })();
    return;
  }
  const confirm = /^confirm:(.*)$/.exec(message);
  if (confirm) {
    void (async () => {
      const chosen = await dialog("select", { title: confirm[1], options: ["yes", "no"] });
      const confirmed = await dialog("confirm", { title: confirm[1], message: "Sure?" });
      settle(assistant(`select=${describeAnswer(chosen)}|confirm=${describeAnswer(confirmed)}`));
    })();
    return;
  }
  // "images:<kind>,<kind>" hands images to the host the way the attach_image tool does, then replies (or fails
  // with "images-then-fail:"). Kinds: png, jpeg, webp, big (over 10 MiB), text (not an image).
  const images = /^images(-then-fail)?:(.*)$/.exec(message);
  if (images) {
    const outbox = process.env.FRACTION_AGENTS_ARTIFACT_OUTBOX;
    if (!outbox) {
      settle(assistant("", "error", "no outbox"));
      return;
    }
    mkdirSync(outbox, { recursive: true });
    images[2]!.split(",").forEach((kind, index) => {
      const stem = `${String(Date.now()).padStart(15, "0")}-${String(index).padStart(3, "0")}`;
      writeFileSync(join(outbox, `${stem}.img`), IMAGES[kind]!());
      writeFileSync(
        join(outbox, `${stem}.json`),
        JSON.stringify({ file: `${stem}.img`, name: `shot-${index + 1}.${kind}`, description: `picture ${index + 1} (${kind})` }),
      );
    });
    if (images[1]) settle(assistant("", "error", "model exploded after the pictures"));
    else settle(assistant(`attached:${images[2]}`));
    return;
  }
  const wait = /^wait:(\d+)$/.exec(message);
  if (wait) {
    finishPending = () => settle(assistant("", "aborted"));
    pending = setTimeout(() => {
      finishPending = undefined;
      reply();
    }, Number(wait[1]));
    return;
  }
  reply();
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const command = JSON.parse(line) as { id?: string; type: string; message?: string } & Record<string, unknown>;
    if (command.type === "extension_ui_response") {
      const resolve = dialogs.get(command.id ?? "");
      dialogs.delete(command.id ?? "");
      resolve?.(command as { value?: string; confirmed?: boolean; cancelled?: boolean });
      continue;
    }
    const respond = (data?: unknown) => emit({ id: command.id, type: "response", command: command.type, success: true, data });
    switch (command.type) {
      case "prompt":
        respond();
        prompt(command.message ?? "");
        break;
      case "abort":
        aborted = true;
        for (const [id, resolve] of dialogs) {
          dialogs.delete(id);
          resolve({ cancelled: true });
        }
        if (pending) {
          clearTimeout(pending);
          pending = undefined;
          finishPending?.();
          finishPending = undefined;
        }
        respond();
        break;
      case "get_state":
        respond({ sessionFile, isStreaming: false, aborted });
        break;
      default:
        emit({ id: command.id, type: "response", command: command.type, success: false, error: "unsupported" });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
