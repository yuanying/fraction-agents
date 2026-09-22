// A stand-in for `pi --mode rpc --session <file>` that speaks just enough of the RPC protocol for the host's tests.
// It remembers the conversation by appending one line per prompt to the session file, so a restarted process
// on the same file continues the count. Every start is logged to `spawns.log` in the working directory.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const sessionIndex = process.argv.indexOf("--session");
const sessionFile = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;
if (process.argv[2] !== "--mode" || process.argv[3] !== "rpc" || !sessionFile) {
  process.stderr.write(`fake-pi: unexpected arguments ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(2);
}
appendFileSync("spawns.log", `${sessionFile}\n`);

let aborted = false;
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
    const command = JSON.parse(line) as { id?: string; type: string; message?: string };
    const respond = (data?: unknown) => emit({ id: command.id, type: "response", command: command.type, success: true, data });
    switch (command.type) {
      case "prompt":
        respond();
        prompt(command.message ?? "");
        break;
      case "abort":
        aborted = true;
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
