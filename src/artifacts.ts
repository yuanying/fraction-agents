import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { ArtifactRecord, ArtifactRegistry } from "./store.ts";

/** The environment variable that tells pi (and the extensions in it) where to hand images over to the host. */
export const ARTIFACT_OUTBOX_ENV = "FRACTION_AGENTS_ARTIFACT_OUTBOX";

/** The limits of the images one task returns (ADR 0012). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_TASK = 8;

/** The shape of the IDs the host numbers artifacts with. Only such names are ever used as file names. */
const ARTIFACT_ID = /^[0-9a-f]{40}$/;
/** The shape of the context IDs the host numbers. */
const CONTEXT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A plain file name inside the outbox: no directories, nothing hidden. */
const OUTBOX_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_LIMIT = 100;
const DESCRIPTION_LIMIT = 500;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** The media type of a PNG, JPEG or WebP image, judged by its first bytes. `undefined` for anything else. */
export function imageMediaType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

/** An image a completed task returns: stored under its ID, with what the agent said about it. */
export interface ReturnedImage {
  id: string;
  mediaType: string;
  name: string;
  description: string;
}

export interface ArtifactsOptions {
  /** `<dataDir>/artifacts`: the stored images in `files/`, and each context's outbox in `outbox/<contextId>`. */
  dir: string;
  registry: ArtifactRegistry;
  now: () => number;
  retentionMs: number;
}

/**
 * The images tasks return (ADR 0012). While a task runs, pi hands images over by putting them in its context's
 * outbox, each as the image file and a `<stem>.json` manifest (`file`, `name`, `description`). When the task
 * completes, the host checks them, stores them under new IDs and serves them to the caller until they expire.
 * When it does not complete, they are dropped.
 */
export class Artifacts {
  readonly #options: ArtifactsOptions;
  readonly #filesDir: string;

  constructor(options: ArtifactsOptions) {
    this.#options = options;
    this.#filesDir = join(options.dir, "files");
    mkdirSync(this.#filesDir, { recursive: true, mode: 0o700 });
  }

  /** Where pi hands the context's images over. pi creates it when it has something to hand over. */
  outboxOf(contextId: string): string {
    return artifactOutbox(this.#options.dir, contextId);
  }

  /**
   * Stores the images in the context's outbox as the task's artifacts, in the order they were handed over, and
   * empties the outbox. Files that are not PNG, JPEG or WebP, are over the size limit or come after the eighth
   * image are left out. A failure to store them costs the images, not the task: what was stored is returned.
   */
  collect(contextId: string, owner: string, taskId: string): ReturnedImage[] {
    const outbox = this.outboxOf(contextId);
    if (!existsSync(outbox)) return [];
    const images: ReturnedImage[] = [];
    try {
      const manifests = readdirSync(outbox).filter((name) => name.endsWith(".json")).sort();
      for (const manifest of manifests) {
        const image = this.#take(outbox, manifest);
        if (typeof image === "string") {
          console.log(`task ${taskId}: left out ${manifest}: ${image}`);
          continue;
        }
        if (images.length === MAX_IMAGES_PER_TASK) {
          console.log(`task ${taskId}: left out ${manifest}: more than ${MAX_IMAGES_PER_TASK} images`);
          continue;
        }
        const { bytes, ...about } = image;
        const id = randomBytes(20).toString("hex");
        // The record first: a file without one would never be swept, a record without a file is just not found.
        this.#options.registry.add({
          id,
          owner,
          taskId,
          mediaType: image.mediaType,
          size: bytes.length,
          createdAt: this.#options.now(),
        });
        writeFileSync(join(this.#filesDir, id), bytes, { mode: 0o600 });
        images.push({ id, ...about, name: about.name || `image-${images.length + 1}.${EXTENSIONS[about.mediaType]}` });
      }
    } catch (error) {
      console.error(`task ${taskId}: storing the images failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rmSync(outbox, { recursive: true, force: true });
    }
    return images;
  }

  /** Drops whatever is in the context's outbox. */
  discard(contextId: string): void {
    rmSync(this.outboxOf(contextId), { recursive: true, force: true });
  }

  /** Drops every outbox. At start-up nothing is running, so nothing in them belongs to a task that can complete. */
  discardAll(): void {
    rmSync(join(this.#options.dir, "outbox"), { recursive: true, force: true });
  }

  /** The stored image, if it exists, belongs to the caller and has not expired. */
  open(id: string, owner: string): { record: ArtifactRecord; path: string } | undefined {
    if (!ARTIFACT_ID.test(id)) return undefined;
    const record = this.#options.registry.get(id, owner);
    if (!record || record.createdAt < this.#cutoff()) return undefined;
    const path = join(this.#filesDir, id);
    return existsSync(path) ? { record, path } : undefined;
  }

  /** Deletes the images past the retention period. */
  sweep(): void {
    for (const record of this.#options.registry.createdBefore(this.#cutoff())) {
      rmSync(join(this.#filesDir, record.id), { force: true });
      this.#options.registry.remove(record.id);
      console.log(`artifact ${record.id}: deleted after the retention period`);
    }
  }

  #cutoff(): number {
    return this.#options.now() - this.#options.retentionMs;
  }

  /** Reads one handed-over image, or says why it is left out. */
  #take(outbox: string, manifestName: string): (Omit<ReturnedImage, "id"> & { bytes: Buffer }) | string {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(join(outbox, manifestName), "utf8"));
    } catch {
      return "the manifest is not JSON";
    }
    if (typeof manifest !== "object" || manifest === null) return "the manifest is not an object";
    const { file, name, description } = manifest as Record<string, unknown>;
    if (typeof file !== "string" || !OUTBOX_FILE.test(file)) return "the manifest names no file in the outbox";
    const path = join(outbox, file);
    let size: number;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) return "not a regular file";
      size = stat.size;
    } catch {
      return "the file is missing";
    }
    if (size > MAX_IMAGE_BYTES) return `over ${MAX_IMAGE_BYTES} bytes`;
    const bytes = readFileSync(path);
    if (bytes.length > MAX_IMAGE_BYTES) return `over ${MAX_IMAGE_BYTES} bytes`;
    const mediaType = imageMediaType(bytes);
    if (!mediaType) return "not a PNG, JPEG or WebP image";
    return {
      mediaType,
      name: typeof name === "string" ? basename(name.trim()).slice(0, NAME_LIMIT) : "",
      description: typeof description === "string" ? description.trim().slice(0, DESCRIPTION_LIMIT) : "",
      bytes,
    };
  }
}

/** The outbox of a context under `<dataDir>/artifacts`. Only context IDs the host numbers are used as names. */
export function artifactOutbox(artifactsDir: string, contextId: string): string {
  if (!CONTEXT_ID.test(contextId)) throw new Error(`not a context ID: ${JSON.stringify(contextId)}`);
  return join(artifactsDir, "outbox", contextId);
}
