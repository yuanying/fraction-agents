// ask_caller: lets the agent put a question to whoever called it. In pi's RPC mode the question becomes a dialog
// request; the fraction-agents host turns it into an A2A task waiting for input (INPUT_REQUIRED) and hands the
// caller's answer back.
import { Type } from "typebox";

import { text, type PiApi, type ToolContext } from "../lib/pi.ts";

export default function askCaller(pi: PiApi): void {
  pi.registerTool({
    name: "ask_caller",
    label: "Ask the caller",
    description:
      "Ask the caller a question and wait for the answer. The work pauses until the caller answers, which may take a long time.",
    promptSnippet: "Ask the caller a question and wait for the answer",
    promptGuidelines: [
      "Use ask_caller only when the request is unclear, contradicts itself or what is already there, or a judgement is doubtful. Otherwise go ahead without asking.",
      "Put everything the caller needs to answer into the ask_caller question: what you found, the options, and what you would choose.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "The question, complete enough to answer without other context." }),
    }),
    async execute(_toolCallId: string, params: { question: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContext) {
      if (!ctx.hasUI) throw new Error("This session cannot ask the caller anything. Decide conservatively and say what you assumed.");
      const answer = await ctx.ui.input(params.question, "Answer");
      if (answer === undefined) {
        return text("No answer came. Do not guess: stop the part of the work that needed the answer and say what you needed.");
      }
      return text(`The caller answered: ${answer}`);
    },
  });
}
