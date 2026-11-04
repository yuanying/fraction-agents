// Push notifications of task updates to the URLs the config allows (ADR 0032).
import { randomUUID } from "node:crypto";

import { TaskState, type StreamResponse, type Task, type TaskPushNotificationConfig } from "@a2a-js/sdk";
import {
  V1PushNotificationSerializer,
  type PushNotificationSender,
  type PushNotificationStore,
  type ServerCallContext,
} from "@a2a-js/sdk/server";

/** How long a receiver has to answer one push, the SDK's own default. */
export const PUSH_TIMEOUT_MS = 5000;

const FINISHED = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

export function isFinished(state: TaskState | undefined): boolean {
  return state !== undefined && FINISHED.has(state);
}

/**
 * Why a prefix of the config cannot be one, or undefined when it can: an absolute https URL, without a user name,
 * password, query or fragment.
 */
export function pushPrefixProblem(prefix: string): string | undefined {
  if (!URL.canParse(prefix)) return "is not a URL";
  const url = new URL(prefix);
  if (url.protocol !== "https:") return "must be https";
  if (url.username !== "" || url.password !== "") return "must not hold a user name or password";
  // An empty query or fragment ("?" or "#" alone) leaves no trace in the parsed URL.
  if (url.search !== "" || prefix.includes("?")) return "must not hold a query";
  if (url.hash !== "" || prefix.includes("#")) return "must not hold a fragment";
  return undefined;
}

/**
 * Whether a push may be sent to `target`: its scheme, host name and port are those of one of the prefixes, and its
 * path is the prefix's or under it, segment by segment. Host names are compared whole, never as strings' prefixes.
 */
export function allowedPushUrl(target: string, prefixes: readonly string[]): boolean {
  if (!URL.canParse(target)) return false;
  const url = new URL(target);
  if (url.username !== "" || url.password !== "") return false;
  return prefixes.some((prefix) => {
    const allowed = new URL(prefix);
    if (url.protocol !== allowed.protocol || url.hostname !== allowed.hostname || url.port !== allowed.port) return false;
    const base = allowed.pathname.endsWith("/") ? allowed.pathname : `${allowed.pathname}/`;
    return url.pathname === allowed.pathname || url.pathname.startsWith(base);
  });
}

/**
 * Why a push config is not taken, or undefined when it is: its URL must be allowed, and it must carry Bearer
 * credentials in `authentication`. The legacy `token` is not used. The reason holds neither the credentials nor
 * the prefixes, so that it may be logged and returned.
 */
export function pushConfigProblem(config: TaskPushNotificationConfig, prefixes: readonly string[]): string | undefined {
  if (!allowedPushUrl(config.url, prefixes)) return "the URL is not allowed";
  const authentication = config.authentication;
  if (!authentication || authentication.scheme.toLowerCase() !== "bearer" || authentication.credentials === "") {
    return "it has no Bearer credentials in authentication";
  }
  return undefined;
}

function callerOf(context: ServerCallContext): string {
  return context.user?.userName ?? "";
}

/**
 * The push configs, in memory, kept apart by caller (the same name the task store owns tasks by). A task has one
 * config at most: saving another replaces it, as the answer to a question brings a new token.
 */
export class PushConfigs implements PushNotificationStore {
  readonly #byCaller = new Map<string, Map<string, TaskPushNotificationConfig>>();

  async save(taskId: string, context: ServerCallContext, config: TaskPushNotificationConfig): Promise<void> {
    if (!config.id) config.id = randomUUID();
    const caller = callerOf(context);
    let tasks = this.#byCaller.get(caller);
    if (!tasks) {
      tasks = new Map();
      this.#byCaller.set(caller, tasks);
    }
    tasks.set(taskId, structuredClone(config));
  }

  async load(taskId: string, context: ServerCallContext): Promise<TaskPushNotificationConfig[]> {
    const config = this.get(taskId, callerOf(context));
    return config ? [config] : [];
  }

  async delete(taskId: string, context: ServerCallContext, configId?: string): Promise<void> {
    const config = this.#byCaller.get(callerOf(context))?.get(taskId);
    if (config && config.id === (configId ?? taskId)) this.forget(taskId, callerOf(context));
  }

  get(taskId: string, caller: string): TaskPushNotificationConfig | undefined {
    const config = this.#byCaller.get(caller)?.get(taskId);
    return config ? structuredClone(config) : undefined;
  }

  forget(taskId: string, caller: string): void {
    const tasks = this.#byCaller.get(caller);
    if (!tasks) return;
    tasks.delete(taskId);
    if (tasks.size === 0) this.#byCaller.delete(caller);
  }

  /** How many tasks have a config. */
  get size(): number {
    let count = 0;
    for (const tasks of this.#byCaller.values()) count += tasks.size;
    return count;
  }
}

export interface PushSenderOptions {
  configs: PushConfigs;
  /** The URL prefixes pushes may go to. Checked again before each push. */
  prefixes: readonly string[];
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Where failures are written. Never given the credentials. */
  log?: (line: string) => void;
}

/**
 * Sends the task's updates to its push config, in place of the SDK's DefaultPushNotificationSender: the same body,
 * content type, Authorization header and timeout, but it follows no redirect, sends to allowed URLs only, and
 * forgets the config once the task's last update is sent. A push that fails is logged and not sent again.
 */
export class PushSender implements PushNotificationSender {
  readonly #configs: PushConfigs;
  readonly #prefixes: readonly string[];
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #log: (line: string) => void;
  readonly #serializer = new V1PushNotificationSerializer();
  /** The pushes on their way, per caller and task, so that a task's pushes go in order and its config goes last. */
  readonly #chains = new Map<string, Promise<void>>();

  constructor(options: PushSenderOptions) {
    this.#configs = options.configs;
    this.#prefixes = options.prefixes;
    this.#timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;
    this.#fetch = options.fetch ?? fetch;
    this.#log = options.log ?? ((line) => console.error(line));
  }

  send(update: StreamResponse, context: ServerCallContext, task?: Task): Promise<void> {
    const taskId = taskIdOf(update);
    if (!taskId) return Promise.resolve();
    const caller = callerOf(context);
    const finished = isFinished(stateOf(update) ?? task?.status?.state);
    return this.#enqueue(taskId, caller, async () => {
      const config = this.#configs.get(taskId, caller);
      if (config) await this.#post(taskId, config, update, task);
      if (finished) this.#configs.forget(taskId, caller);
    });
  }

  /** Forgets the task's config once the pushes already on their way are sent, for a task finished without one. */
  forget(taskId: string, caller: string): Promise<void> {
    return this.#enqueue(taskId, caller, async () => this.#configs.forget(taskId, caller));
  }

  #enqueue(taskId: string, caller: string, step: () => Promise<void>): Promise<void> {
    const key = `${caller}\n${taskId}`;
    const next = (this.#chains.get(key) ?? Promise.resolve()).catch(() => {}).then(step);
    this.#chains.set(key, next);
    return next.finally(() => {
      if (this.#chains.get(key) === next) this.#chains.delete(key);
    });
  }

  async #post(taskId: string, config: TaskPushNotificationConfig, update: StreamResponse, task: Task | undefined): Promise<void> {
    const failed = (reason: string) => this.#log(`task ${taskId}: the push notification to ${config.url} failed: ${reason}`);
    if (pushConfigProblem(config, this.#prefixes) !== undefined) {
      failed("the URL is not allowed");
      return;
    }
    const { body, contentType } = this.#serializer.serialize(update, task);
    try {
      const response = await this.#fetch(config.url, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          Authorization: `${config.authentication!.scheme} ${config.authentication!.credentials}`,
        },
        body,
        // A redirect would lead the push to a URL nobody allowed.
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      await response.body?.cancel();
      if (response.type === "opaqueredirect") failed("the receiver answered with a redirect");
      else if (!response.ok) failed(`HTTP ${response.status}`);
    } catch (error) {
      failed(error instanceof Error ? error.message : String(error));
    }
  }
}

function taskIdOf(update: StreamResponse): string {
  const payload = update.payload;
  switch (payload?.$case) {
    case "task":
      return payload.value.id;
    case "statusUpdate":
    case "artifactUpdate":
    case "message":
      return payload.value.taskId;
    default:
      return "";
  }
}

function stateOf(update: StreamResponse): TaskState | undefined {
  const payload = update.payload;
  if (payload?.$case === "task") return payload.value.status?.state;
  if (payload?.$case === "statusUpdate") return payload.value.status?.state;
  return undefined;
}
