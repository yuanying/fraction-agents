// A stand-in for a context workspace hook: `fake-hook.ts <log> <prepare|remove> [fail] <dir>`.
// It logs every call as one JSON line, creates the directory on prepare and deletes it on remove.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [log, action, ...rest] = process.argv.slice(2);
const dir = rest.at(-1)!;
const fail = rest.includes("fail");
appendFileSync(
  log!,
  `${JSON.stringify({
    action,
    dir,
    contextId: process.env.FRACTION_AGENTS_CONTEXT_ID,
    caller: process.env.FRACTION_AGENTS_CALLER,
    env: Object.keys(process.env).sort(),
  })}\n`,
);
if (fail) {
  process.stderr.write("fake-hook: the clone is not reachable\n");
  process.exit(1);
}
if (action === "prepare") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prepared"), "yes\n");
} else if (action === "remove") {
  rmSync(dir, { recursive: true, force: true });
}
