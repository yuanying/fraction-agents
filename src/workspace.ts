import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ContextWorkspaceConfig } from "./config.ts";

/** The shape of the context IDs the host numbers. Only such names are ever used as directory names. */
const CONTEXT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const HOOK_TIMEOUT_MS = 10 * 60_000;
const STDERR_LIMIT = 2_000;

export type HookResult = { ok: true } | { ok: false; error: string };

/**
 * The working directories pi runs in. Without a workspace config every context shares `workDir`; with one, each
 * context gets `<workDir>/<contextId>`, which the configured commands prepare before pi starts and remove when the
 * context is deleted.
 */
export class ContextWorkspaces {
  readonly #workDir: string;
  readonly #config: ContextWorkspaceConfig | undefined;

  constructor(workDir: string, config: ContextWorkspaceConfig | undefined) {
    this.#workDir = workDir;
    this.#config = config;
  }

  /** Where pi runs for the context. */
  dirOf(contextId: string): string {
    if (!this.#config) return this.#workDir;
    if (!CONTEXT_ID.test(contextId)) throw new Error(`not a context ID: ${JSON.stringify(contextId)}`);
    return join(this.#workDir, contextId);
  }

  /** Runs the prepare command for the context. Nothing to do without a workspace config. */
  async prepare(contextId: string, env: NodeJS.ProcessEnv): Promise<HookResult> {
    if (!this.#config) return { ok: true };
    const dir = this.dirOf(contextId);
    const result = await runHook([...this.#config.prepare, dir], this.#workDir, env);
    if (!result.ok) return result;
    if (!existsSync(dir)) return { ok: false, error: "the prepare command did not create the directory" };
    return result;
  }

  /** Runs the remove command for the context and deletes whatever is left of its directory. */
  async remove(contextId: string, env: NodeJS.ProcessEnv): Promise<HookResult> {
    if (!this.#config) return { ok: true };
    const dir = this.dirOf(contextId);
    let result: HookResult = { ok: true };
    if (this.#config.remove.length > 0 && existsSync(dir)) {
      result = await runHook([...this.#config.remove, dir], this.#workDir, env);
    }
    rmSync(dir, { recursive: true, force: true });
    return result;
  }

  /** Context IDs that have a directory under `workDir`. Other entries of `workDir` are not the host's. */
  present(): string[] {
    if (!this.#config || !existsSync(this.#workDir)) return [];
    return readdirSync(this.#workDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && CONTEXT_ID.test(entry.name))
      .map((entry) => entry.name);
  }
}

function runHook(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<HookResult> {
  const [program, ...args] = command;
  return new Promise((resolve) => {
    const child = spawn(program!, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"], timeout: HOOK_TIMEOUT_MS });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.once("error", (error) => resolve({ ok: false, error: `${program} could not be started: ${error.message}` }));
    child.once("close", (code, signal) => {
      if (code === 0) return resolve({ ok: true });
      const detail = stderr.trim().split("\n").at(-1) ?? "";
      resolve({ ok: false, error: `${program} ended with ${signal ?? `code ${code}`}${detail ? `: ${detail}` : ""}` });
    });
  });
}
