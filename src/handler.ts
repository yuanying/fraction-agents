import type {
  AgentCard,
  CancelTaskRequest,
  DeleteTaskPushNotificationConfigRequest,
  GetExtendedAgentCardRequest,
  GetTaskPushNotificationConfigRequest,
  GetTaskRequest,
  ListTaskPushNotificationConfigsRequest,
  ListTaskPushNotificationConfigsResponse,
  ListTasksRequest,
  ListTasksResponse,
  Message,
  SendMessageRequest,
  StreamResponse,
  SubscribeToTaskRequest,
  Task,
  TaskPushNotificationConfig,
} from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import type { A2ARequestHandler, ServerCallContext, TaskStore } from "@a2a-js/sdk/server";

import { isFinished, pushConfigProblem, type PushSender } from "./push.ts";
import type { ContextRegistry } from "./store.ts";

/** What the guard needs of push notifications, on an agent that takes them (ADR 0032). */
export interface PushGuard {
  /** The URL prefixes push configs may point to. */
  prefixes: readonly string[];
  sender: PushSender;
  /** Where dropped push configs are written. */
  log?: (line: string) => void;
}

/**
 * Puts the host's rules on contexts in front of the SDK's request handler (ADR 0002, 0003):
 *
 * - Only the host numbers contexts. A message without a contextId starts a new context owned by the caller.
 * - A message with a contextId is accepted only if that context exists and belongs to the caller. Anything else,
 *   including someone else's context, is refused with the same error.
 * - A message addressed to an existing task is accepted only while that task waits for the caller's answer
 *   (INPUT_REQUIRED); the message is the answer. Any other follow-up belongs in a new task in the same context.
 *
 * And, on an agent that takes push notifications, the rules on push configs (ADR 0032): a message's push config
 * that is not allowed is dropped, and the message taken without it; a push config created on its own that is not
 * allowed is refused.
 */
export class ContextGuardHandler implements A2ARequestHandler {
  readonly #inner: A2ARequestHandler;
  readonly #contexts: ContextRegistry;
  readonly #tasks: TaskStore;
  readonly #now: () => number;
  readonly #push: PushGuard | undefined;

  constructor(inner: A2ARequestHandler, contexts: ContextRegistry, tasks: TaskStore, now: () => number, push?: PushGuard) {
    this.#inner = inner;
    this.#contexts = contexts;
    this.#tasks = tasks;
    this.#now = now;
    this.#push = push;
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    const { request, dropped } = this.#checkPush(await this.#resolveContext(params, context));
    if (dropped === undefined) return this.#inner.sendMessage(request, context);
    // The task's ID is known once the SDK has taken the message, unless the message answers a question.
    let taskId = request.message?.taskId ?? "";
    try {
      const result = await this.#inner.sendMessage(request, context);
      taskId = "messageId" in result ? result.taskId : result.id;
      return result;
    } finally {
      this.#logDropped(taskId, context, dropped);
    }
  }

  async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    const { request, dropped } = this.#checkPush(await this.#resolveContext(params, context));
    if (dropped !== undefined) this.#logDropped(request.message?.taskId ?? "", context, dropped);
    yield* this.#inner.sendMessageStream(request, context);
  }

  getAgentCard(): Promise<AgentCard> {
    return this.#inner.getAgentCard();
  }

  getAuthenticatedExtendedAgentCard(params: GetExtendedAgentCardRequest, context: ServerCallContext): Promise<AgentCard> {
    return this.#inner.getAuthenticatedExtendedAgentCard(params, context);
  }

  getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    return this.#inner.getTask(params, context);
  }

  listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    return this.#inner.listTasks(params, context);
  }

  async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    const task = await this.#inner.cancelTask(params, context);
    // A task canceled while no request runs it sends no update, so its config is forgotten here.
    if (this.#push && isFinished(task.status?.state)) void this.#push.sender.forget(task.id, callerOf(context));
    return task;
  }

  resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    return this.#inner.resubscribe(params, context);
  }

  async createTaskPushNotificationConfig(params: TaskPushNotificationConfig, context: ServerCallContext): Promise<TaskPushNotificationConfig> {
    if (this.#push) {
      // Nothing is left to take once the config is dropped, so the call is refused.
      const problem = pushConfigProblem(params, this.#push.prefixes);
      if (problem !== undefined) throw new RequestMalformedError(`The push notification config is not taken: ${problem}.`);
      const task = params.taskId ? await this.#tasks.load(params.taskId, context) : undefined;
      if (task && isFinished(task.status?.state)) {
        throw new UnsupportedOperationError("The task has finished, and sends no more updates.");
      }
    }
    return this.#inner.createTaskPushNotificationConfig(params, context);
  }

  getTaskPushNotificationConfig(params: GetTaskPushNotificationConfigRequest, context: ServerCallContext): Promise<TaskPushNotificationConfig> {
    return this.#inner.getTaskPushNotificationConfig(params, context);
  }

  listTaskPushNotificationConfigs(
    params: ListTaskPushNotificationConfigsRequest,
    context: ServerCallContext,
  ): Promise<ListTaskPushNotificationConfigsResponse> {
    return this.#inner.listTaskPushNotificationConfigs(params, context);
  }

  deleteTaskPushNotificationConfig(params: DeleteTaskPushNotificationConfigRequest, context: ServerCallContext): Promise<void> {
    return this.#inner.deleteTaskPushNotificationConfig(params, context);
  }

  /** Drops a message's push config that is not allowed, and says why. The SDK ignores it on an agent without push. */
  #checkPush(request: SendMessageRequest): { request: SendMessageRequest; dropped?: string } {
    const config = request.configuration?.taskPushNotificationConfig;
    if (!this.#push || !config) return { request };
    const problem = pushConfigProblem(config, this.#push.prefixes);
    if (problem === undefined) return { request };
    return { request: { ...request, configuration: { ...request.configuration!, taskPushNotificationConfig: undefined } }, dropped: problem };
  }

  /** Neither the credentials nor the allowed prefixes are written. */
  #logDropped(taskId: string, context: ServerCallContext, reason: string): void {
    const log = this.#push?.log ?? ((line: string) => console.log(line));
    log(`task ${taskId || "(none)"}: dropped the push notification config of ${callerOf(context) || "(unknown)"}: ${reason}`);
  }

  async #resolveContext(params: SendMessageRequest, context: ServerCallContext): Promise<SendMessageRequest> {
    const message = params.message;
    if (!message) throw new RequestMalformedError("request.message is required.");
    const caller = callerOf(context);
    if (caller === "") throw new UnsupportedOperationError("The caller is not authenticated.");
    const now = this.#now();
    if (message.taskId) {
      // The store only finds the caller's own tasks.
      const task = await this.#tasks.load(message.taskId, context);
      if (!task) throw new TaskNotFoundError(`Task not found: ${message.taskId}`);
      if (task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
        throw new UnsupportedOperationError(
          "Only a task waiting for your answer (TASK_STATE_INPUT_REQUIRED) takes a message. Send a new message with the same contextId instead.",
        );
      }
      this.#contexts.touch(task.contextId, now);
      return params;
    }
    if (message.contextId) {
      if (!this.#contexts.get(message.contextId, caller)) {
        throw new RequestMalformedError(
          "Unknown contextId. Leave contextId out to start a new context; this agent numbers contexts itself.",
        );
      }
      this.#contexts.touch(message.contextId, now);
      return params;
    }
    const created = this.#contexts.create(caller, now);
    return { ...params, message: { ...message, contextId: created.contextId } };
  }
}

function callerOf(context: ServerCallContext): string {
  return context.user?.isAuthenticated ? context.user.userName : "";
}
