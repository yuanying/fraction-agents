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

import type { ContextRegistry } from "./store.ts";

/**
 * Puts the host's rules on contexts in front of the SDK's request handler (ADR 0002, 0003):
 *
 * - Only the host numbers contexts. A message without a contextId starts a new context owned by the caller.
 * - A message with a contextId is accepted only if that context exists and belongs to the caller. Anything else,
 *   including someone else's context, is refused with the same error.
 * - A message addressed to an existing task is accepted only while that task waits for the caller's answer
 *   (INPUT_REQUIRED); the message is the answer. Any other follow-up belongs in a new task in the same context.
 */
export class ContextGuardHandler implements A2ARequestHandler {
  readonly #inner: A2ARequestHandler;
  readonly #contexts: ContextRegistry;
  readonly #tasks: TaskStore;
  readonly #now: () => number;

  constructor(inner: A2ARequestHandler, contexts: ContextRegistry, tasks: TaskStore, now: () => number) {
    this.#inner = inner;
    this.#contexts = contexts;
    this.#tasks = tasks;
    this.#now = now;
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    return this.#inner.sendMessage(await this.#resolveContext(params, context), context);
  }

  async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    yield* this.#inner.sendMessageStream(await this.#resolveContext(params, context), context);
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

  cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    return this.#inner.cancelTask(params, context);
  }

  resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext): AsyncGenerator<StreamResponse, void, undefined> {
    return this.#inner.resubscribe(params, context);
  }

  createTaskPushNotificationConfig(params: TaskPushNotificationConfig, context: ServerCallContext): Promise<TaskPushNotificationConfig> {
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

  async #resolveContext(params: SendMessageRequest, context: ServerCallContext): Promise<SendMessageRequest> {
    const message = params.message;
    if (!message) throw new RequestMalformedError("request.message is required.");
    const caller = context.user?.isAuthenticated ? context.user.userName : "";
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
