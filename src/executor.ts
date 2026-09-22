import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Role, TaskState, type Message } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";

import type { PiSessions } from "./sessions.ts";
import type { ContextRegistry } from "./store.ts";

export interface PiAgentExecutorOptions {
  contexts: ContextRegistry;
  sessions: PiSessions;
  sessionsDir: string;
  now: () => number;
}

/** Runs each A2A task as one prompt in its context's pi session and reports the last assistant text as the result. */
export class PiAgentExecutor implements AgentExecutor {
  readonly #options: PiAgentExecutorOptions;

  constructor(options: PiAgentExecutorOptions) {
    this.#options = options;
  }

  async execute(request: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = request;
    const caller = request.context.user?.userName ?? "";
    // The request handler has already checked or created the context for this caller.
    const context = this.#options.contexts.get(contextId, caller);
    if (!context) throw new Error(`context ${contextId} does not belong to ${caller}`);

    bus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: timestamp() },
        artifacts: [],
        history: [userMessage],
        metadata: {},
      }),
    );
    const status = (state: TaskState, text?: string) =>
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: { state, message: text === undefined ? undefined : agentMessage(taskId, contextId, text), timestamp: timestamp() },
          metadata: {},
        }),
      );

    const text = userMessage.parts
      .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
      .filter((value) => value !== "")
      .join("\n\n");
    if (text === "") {
      status(TaskState.TASK_STATE_REJECTED, "This agent accepts text parts only.");
      return;
    }

    const running = this.#options.sessions.run(
      { contextId, caller, sessionPath: join(this.#options.sessionsDir, context.sessionFile) },
      taskId,
      text,
    );
    if (!running) {
      status(TaskState.TASK_STATE_REJECTED, "This context is busy with another task. Wait for it to finish and send again.");
      return;
    }
    console.log(`task ${taskId}: started in context ${contextId} for ${caller}`);
    status(TaskState.TASK_STATE_WORKING);
    const outcome = await running;
    this.#options.contexts.touch(contextId, this.#options.now());
    console.log(`task ${taskId}: ${outcome.status}`);

    switch (outcome.status) {
      case "completed":
        bus.publish(
          AgentEvent.artifactUpdate({
            taskId,
            contextId,
            artifact: {
              artifactId: randomUUID(),
              name: "response",
              description: "",
              parts: [{ content: { $case: "text", value: outcome.text }, metadata: {}, filename: "", mediaType: "text/plain" }],
              metadata: {},
              extensions: [],
            },
            append: false,
            lastChunk: true,
            metadata: {},
          }),
        );
        status(TaskState.TASK_STATE_COMPLETED);
        return;
      case "failed":
        status(TaskState.TASK_STATE_FAILED, outcome.error);
        return;
      case "aborted":
        status(TaskState.TASK_STATE_CANCELED, "The task was canceled.");
        return;
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    // A running task settles as aborted and `execute` reports it canceled.
    if (await this.#options.sessions.abort(taskId)) return;
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: "",
        status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: timestamp() },
        metadata: {},
      }),
    );
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [{ content: { $case: "text", value: text }, metadata: {}, filename: "", mediaType: "text/plain" }],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}
