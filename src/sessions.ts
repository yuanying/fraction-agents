import { PiRpcProcess, type PromptOutcome } from "./pi-rpc.ts";

/** The environment variable that tells pi (and the extensions in it) who called. */
export const CALLER_ENV = "FRACTION_AGENTS_CALLER";

export interface SessionTarget {
  contextId: string;
  /** Absolute path of the context's session file. */
  sessionPath: string;
  caller: string;
}

export interface PiSessionsOptions {
  piCommand: readonly string[];
  agentDir: string;
  workDir: string;
  idleTimeoutMs: number;
}

interface Entry {
  process: PiRpcProcess;
  /** The task running in this context, if any. One at a time. */
  taskId?: string;
  idleTimer?: NodeJS.Timeout;
}

/**
 * The pi processes of the contexts, one per context. A process is started on the first task of a context (or
 * of a context whose process has stopped) on the context's session file, and stopped when unused for a while.
 */
export class PiSessions {
  readonly #options: PiSessionsOptions;
  readonly #entries = new Map<string, Entry>();

  constructor(options: PiSessionsOptions) {
    this.#options = options;
  }

  isBusy(contextId: string): boolean {
    return this.#entries.get(contextId)?.taskId !== undefined;
  }

  /**
   * Runs one prompt in the context's pi process. Returns `undefined` at once, without running anything, if another
   * task is running in the context.
   */
  run(target: SessionTarget, taskId: string, text: string): Promise<PromptOutcome> | undefined {
    let entry = this.#entries.get(target.contextId);
    if (entry?.taskId !== undefined) return undefined;
    if (!entry || !entry.process.alive) {
      entry = { process: this.#start(target) };
      this.#entries.set(target.contextId, entry);
    }
    clearTimeout(entry.idleTimer);
    entry.taskId = taskId;
    const current = entry;
    return current.process.prompt(text).finally(() => {
      current.taskId = undefined;
      if (!current.process.alive) {
        if (this.#entries.get(target.contextId) === current) this.#entries.delete(target.contextId);
        return;
      }
      current.idleTimer = setTimeout(() => void this.stop(target.contextId), this.#options.idleTimeoutMs);
      current.idleTimer.unref();
    });
  }

  /** Aborts the task if it is running. Returns whether it was. */
  async abort(taskId: string): Promise<boolean> {
    for (const entry of this.#entries.values()) {
      if (entry.taskId === taskId) {
        await entry.process.abort().catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  /** Stops the context's process, if one is running. The session file stays. */
  async stop(contextId: string): Promise<void> {
    const entry = this.#entries.get(contextId);
    if (!entry) return;
    this.#entries.delete(contextId);
    clearTimeout(entry.idleTimer);
    await entry.process.stop();
  }

  async close(): Promise<void> {
    await Promise.all([...this.#entries.keys()].map((contextId) => this.stop(contextId)));
  }

  #start(target: SessionTarget): PiRpcProcess {
    const process_ = new PiRpcProcess({
      command: this.#options.piCommand,
      sessionPath: target.sessionPath,
      cwd: this.#options.workDir,
      env: { ...process.env, PI_CODING_AGENT_DIR: this.#options.agentDir, [CALLER_ENV]: target.caller },
      logPrefix: `[pi ${target.contextId.slice(0, 8)}]`,
    });
    void process_.exited.then((reason) => {
      const entry = this.#entries.get(target.contextId);
      if (entry?.process === process_ && entry.taskId === undefined) {
        clearTimeout(entry.idleTimer);
        this.#entries.delete(target.contextId);
      }
      console.log(`context ${target.contextId}: ${reason}`);
    });
    console.log(`context ${target.contextId}: started pi for ${target.caller}`);
    return process_;
  }
}
