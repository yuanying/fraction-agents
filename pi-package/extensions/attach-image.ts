// attach_image: lets the agent return an image (a screenshot, a picture it found) to whoever called it. The image
// goes into the outbox the fraction-agents host names in FRACTION_AGENTS_ARTIFACT_OUTBOX; when the task completes,
// the host returns it as an A2A artifact the caller fetches by URL (ADR 0012).
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { Type } from "typebox";

import { text, type PiApi, type ToolContext } from "../lib/pi.ts";

/** The host's limits (ADR 0012). The host checks again; these are here to tell the model at once. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES_PER_TASK = 8;
const NAME_LIMIT = 100;

/** Orders the images attached within the same millisecond. One pi process serves one context. */
let sequence = 0;

export interface AttachImageOptions {
  env?: NodeJS.ProcessEnv;
}

export function createAttachImage(options: AttachImageOptions = {}): (pi: PiApi) => void {
  return (pi) => {
    const outbox = (options.env ?? process.env).FRACTION_AGENTS_ARTIFACT_OUTBOX;
    // Outside the host nobody would pick the image up.
    if (!outbox) return;
    pi.registerTool({
      name: "attach_image",
      label: "Attach an image",
      description:
        "Attach an image file (PNG, JPEG or WebP, up to 10 MiB) to your reply. The caller receives it alongside your final answer. Up to 8 images per request.",
      promptSnippet: "Attach an image file to the reply for the caller",
      promptGuidelines: [
        "Use attach_image to return a screenshot or another picture to the caller: save it to a file first, then attach it with a one-line description of what it shows.",
        "In your final answer, mention each attached image by its name.",
      ],
      parameters: Type.Object({
        path: Type.String({ description: "The image file. A relative path starts from the working directory." }),
        description: Type.String({ description: "One line on what the image shows, e.g. 'The top page of example.com'." }),
        name: Type.Optional(Type.String({ description: "A short file name to show the caller. Defaults to the file's own name." })),
      }),
      async execute(
        _toolCallId: string,
        params: { path: string; description: string; name?: string },
        _signal: unknown,
        _onUpdate: unknown,
        ctx: ToolContext,
      ) {
        const description = params.description.trim();
        if (description === "") throw new Error("Give a description: one line on what the image shows.");
        const path = resolve(ctx.cwd, params.path);
        let size: number;
        try {
          const stat = lstatSync(path);
          if (!stat.isFile()) throw new Error(`${params.path} is not a regular file. Attach the image file itself.`);
          size = stat.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`There is no file at ${params.path}.`);
          throw error;
        }
        if (size > MAX_IMAGE_BYTES) throw new Error(`${params.path} is over 10 MiB. Make it smaller (e.g. a smaller viewport or JPEG).`);
        const bytes = readFileSync(path);
        const extension = imageExtension(bytes);
        if (!extension) throw new Error(`${params.path} is not a PNG, JPEG or WebP image.`);

        mkdirSync(outbox, { recursive: true });
        if (readdirSync(outbox).filter((entry) => entry.endsWith(".json")).length >= MAX_IMAGES_PER_TASK) {
          throw new Error(`You have already attached 8 images, the most one reply can carry.`);
        }
        const name = basename((params.name ?? "").trim() || params.path).slice(0, NAME_LIMIT);
        // Named by time and sequence first, so the host returns the images in the order they were attached.
        const stem = `${String(Date.now()).padStart(15, "0")}-${String(sequence++).padStart(6, "0")}-${randomUUID()}`;
        writeFileSync(join(outbox, `${stem}.${extension}`), bytes);
        writeFileSync(join(outbox, `${stem}.json`), JSON.stringify({ file: `${stem}.${extension}`, name, description }));
        return text(`Attached ${name}. The caller receives it with your final answer.`);
      },
    });
  };
}

function imageExtension(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return undefined;
}

export default createAttachImage();
