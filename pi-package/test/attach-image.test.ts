import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createAttachImage } from "../extensions/attach-image.ts";
import type { PiApi, ToolContext, ToolDefinition } from "../lib/pi.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg body")]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 body")]);

class FakePi implements PiApi {
  readonly tools = new Map<string, ToolDefinition>();

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  on(): void {}

  async call(params: Record<string, unknown>, cwd: string): Promise<string> {
    const tool = this.tools.get("attach_image");
    assert.ok(tool, "attach_image is registered");
    const ctx: ToolContext = { cwd, hasUI: true, ui: { input: async () => undefined } };
    const result = await tool.execute("call-1", params, undefined, undefined, ctx);
    return result.content.map((part) => part.text).join("");
  }
}

function setUp() {
  const dir = mkdtempSync(join(tmpdir(), "fraction-agents-attach-"));
  const cwd = join(dir, "work");
  const outbox = join(dir, "outbox", "context");
  mkdirSync(cwd, { recursive: true });
  const pi = new FakePi();
  createAttachImage({ env: { FRACTION_AGENTS_ARTIFACT_OUTBOX: outbox } })(pi);
  return { dir, cwd, outbox, pi };
}

/** What the host will pick up: each manifest with the bytes of the file it names. */
function handedOver(outbox: string): { name: string; description: string; bytes: Buffer }[] {
  return readdirSync(outbox)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const manifest = JSON.parse(readFileSync(join(outbox, name), "utf8"));
      return { name: manifest.name, description: manifest.description, bytes: readFileSync(join(outbox, manifest.file)) };
    });
}

describe("attach_image extension", () => {
  it("registers nothing outside the host, where there is nowhere to hand images over", () => {
    const pi = new FakePi();
    createAttachImage({ env: {} })(pi);
    assert.equal(pi.tools.size, 0);
  });

  it("hands a PNG, a JPEG and a WebP over to the host with their descriptions", async () => {
    const { cwd, outbox, pi } = setUp();
    writeFileSync(join(cwd, "top.png"), PNG);
    writeFileSync(join(cwd, "photo.jpg"), JPEG);
    writeFileSync(join(cwd, "banner.webp"), WEBP);
    const answer = await pi.call({ path: "top.png", description: "The top page of example.com" }, cwd);
    assert.match(answer, /top\.png/);
    await pi.call({ path: join(cwd, "photo.jpg"), description: "A photo", name: "photo-1.jpg" }, cwd);
    await pi.call({ path: "banner.webp", description: "A banner" }, cwd);
    assert.deepEqual(handedOver(outbox), [
      { name: "top.png", description: "The top page of example.com", bytes: PNG },
      { name: "photo-1.jpg", description: "A photo", bytes: JPEG },
      { name: "banner.webp", description: "A banner", bytes: WEBP },
    ]);
  });

  it("copies the file, so changing it afterwards does not change what is returned", async () => {
    const { cwd, outbox, pi } = setUp();
    writeFileSync(join(cwd, "shot.png"), PNG);
    await pi.call({ path: "shot.png", description: "A shot" }, cwd);
    writeFileSync(join(cwd, "shot.png"), JPEG);
    assert.deepEqual(handedOver(outbox)[0]!.bytes, PNG);
  });

  it("keeps only the last part of a name that looks like a path", async () => {
    const { cwd, outbox, pi } = setUp();
    writeFileSync(join(cwd, "shot.png"), PNG);
    await pi.call({ path: "shot.png", description: "A shot", name: "../../etc/passwd.png" }, cwd);
    assert.equal(handedOver(outbox)[0]!.name, "passwd.png");
  });

  it("refuses a file that is not a PNG, JPEG or WebP, judged by its content", async () => {
    const { cwd, outbox, pi } = setUp();
    writeFileSync(join(cwd, "fake.png"), "just some text");
    await assert.rejects(pi.call({ path: "fake.png", description: "Not really" }, cwd), /PNG, JPEG or WebP/);
    assert.deepEqual(handedOver(mkdirp(outbox)), []);
  });

  it("refuses an image over 10 MiB", async () => {
    const { cwd, pi } = setUp();
    writeFileSync(join(cwd, "huge.png"), Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    await assert.rejects(pi.call({ path: "huge.png", description: "Huge" }, cwd), /10 MiB/);
  });

  it("refuses a ninth image in one task", async () => {
    const { cwd, outbox, pi } = setUp();
    writeFileSync(join(cwd, "shot.png"), PNG);
    for (let i = 0; i < 8; i++) await pi.call({ path: "shot.png", description: `Shot ${i + 1}` }, cwd);
    await assert.rejects(pi.call({ path: "shot.png", description: "One too many" }, cwd), /8 images/);
    assert.equal(handedOver(outbox).length, 8);
  });

  it("refuses a missing file, a directory and a symbolic link", async () => {
    const { dir, cwd, pi } = setUp();
    await assert.rejects(pi.call({ path: "missing.png", description: "Missing" }, cwd), /no file/i);
    await assert.rejects(pi.call({ path: ".", description: "A directory" }, cwd), /not a regular file/);
    writeFileSync(join(dir, "real.png"), PNG);
    symlinkSync(join(dir, "real.png"), join(cwd, "link.png"));
    await assert.rejects(pi.call({ path: "link.png", description: "A link" }, cwd), /not a regular file/);
  });

  it("asks for a description", async () => {
    const { cwd, pi } = setUp();
    writeFileSync(join(cwd, "shot.png"), PNG);
    await assert.rejects(pi.call({ path: "shot.png", description: "  " }, cwd), /description/);
  });
});

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
