// submit_reply: lets the agent return its answer in the shape of the reply contract (a summary of up to three lines,
// sections of Markdown and sources). The reply goes into the file the fraction-agents host names in
// FRACTION_AGENTS_REPLY_FILE; when the task completes, the host returns it as the text of the result and, to a caller
// that activated the reply extension, as an A2A data part (ADR 0015).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Type } from "typebox";

import { text, type PiApi } from "../lib/pi.ts";
import { checkReply, type Reply } from "../lib/reply.ts";

export interface SubmitReplyOptions {
  env?: NodeJS.ProcessEnv;
}

interface Params {
  summary: string;
  sections?: { title: string; body: string }[];
  sources?: { title: string; url: string }[];
}

export function createSubmitReply(options: SubmitReplyOptions = {}): (pi: PiApi) => void {
  return (pi) => {
    const file = (options.env ?? process.env).FRACTION_AGENTS_REPLY_FILE;
    // Outside the host nobody would pick the reply up.
    if (!file) return;
    pi.registerTool({
      name: "submit_reply",
      label: "Submit the reply",
      description:
        "Submit your answer to the caller as a reply: a summary of up to three lines, the details as sections of Markdown, and the sources. The caller receives this reply as your answer. Submitting again replaces the reply.",
      promptSnippet: "Submit the answer to the caller as a summary, sections and sources",
      promptGuidelines: [
        "Use submit_reply once your answer is ready: put the answer itself in the summary (at most three lines), the details in sections (a short title and a Markdown body each), and every page you relied on in sources.",
        "After submit_reply, end with one short line. The caller receives the submitted reply, not your last words.",
      ],
      parameters: Type.Object({
        summary: Type.String({ description: "The answer in at most three lines, up to 500 characters." }),
        sections: Type.Optional(
          Type.Array(
            Type.Object({
              title: Type.String({ description: "A short title on one line, e.g. 'Details' or 'Unreadable pages'." }),
              body: Type.String({ description: "The section's text in Markdown." }),
            }),
            { description: "The details, one section each, in the order to read them. Up to 50." },
          ),
        ),
        sources: Type.Optional(
          Type.Array(
            Type.Object({
              title: Type.String({ description: "The page's title on one line." }),
              url: Type.String({ description: "The page's http or https URL." }),
            }),
            { description: "The pages the answer relies on. Up to 100." },
          ),
        ),
      }),
      async execute(_toolCallId: string, params: Params) {
        const reply: Reply = {
          summary: params.summary.trim(),
          sections: (params.sections ?? []).map((section) => ({ title: section.title.trim(), body: section.body })),
          sources: (params.sources ?? []).map((source) => ({ title: source.title.trim(), url: source.url.trim() })),
        };
        const error = checkReply(reply);
        if (error) throw new Error(`The reply was not submitted: ${error}. Fix it and submit again.`);
        mkdirSync(dirname(file), { recursive: true });
        // Written whole and then moved into place, so the host never reads half a reply.
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(reply));
        renameSync(temporary, file);
        return text(
          `Submitted the reply: ${count(reply.sections.length, "section")}, ${count(reply.sources.length, "source")}. End with one short line; the caller receives this reply.`,
        );
      },
    });
  };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export default createSubmitReply();
