import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { Check } from "typebox/schema";

import { checkReply as checkReplyInTool } from "../pi-package/lib/reply.ts";
import { REPLY_EXTENSION_URI, checkReply, renderReply } from "../src/reply.ts";

const SCHEMA_PATH = resolve(import.meta.dirname, "../docs/extensions/reply/v1/reply.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

const valid = { summary: "Yes.", sections: [], sources: [] };
const section = { title: "Details", body: "Some **Markdown**.\n\n- a list" };
const source = { title: "Example", url: "https://example.com/a?b=c" };

/** Replies the schema accepts, and replies it refuses. Both validators must agree with it on every one. */
const ACCEPTED: Record<string, unknown> = {
  "the smallest reply": valid,
  "a summary of three lines": { ...valid, summary: "one\ntwo\nthree" },
  "a summary of 500 characters": { ...valid, summary: "あ".repeat(500) },
  "sections and sources": { summary: "Found it.", sections: [section, { title: "More", body: "x" }], sources: [source, { title: "Plain", url: "http://example.org" }] },
  "50 sections": { ...valid, sections: Array.from({ length: 50 }, () => section) },
  "100 sources": { ...valid, sources: Array.from({ length: 100 }, () => source) },
};

const REFUSED: Record<string, unknown> = {
  "not an object": "Yes.",
  null: null,
  "an array": [valid],
  "no summary": { sections: [], sources: [] },
  "no sections": { summary: "Yes.", sources: [] },
  "no sources": { summary: "Yes.", sections: [] },
  "an empty summary": { ...valid, summary: "" },
  "a summary of four lines": { ...valid, summary: "one\ntwo\nthree\nfour" },
  "a summary over 500 characters": { ...valid, summary: "あ".repeat(501) },
  "a summary that is not a string": { ...valid, summary: 3 },
  "a field of its own": { ...valid, extra: true },
  "sections that are not an array": { ...valid, sections: section },
  "a section without a body": { ...valid, sections: [{ title: "Details" }] },
  "a section with an empty body": { ...valid, sections: [{ title: "Details", body: "" }] },
  "a section with an empty title": { ...valid, sections: [{ title: "", body: "x" }] },
  "a section title on two lines": { ...valid, sections: [{ title: "a\nb", body: "x" }] },
  "a section title over 200 characters": { ...valid, sections: [{ title: "t".repeat(201), body: "x" }] },
  "a section body over 50000 characters": { ...valid, sections: [{ title: "t", body: "b".repeat(50001) }] },
  "a section with a field of its own": { ...valid, sections: [{ ...section, level: 2 }] },
  "51 sections": { ...valid, sections: Array.from({ length: 51 }, () => section) },
  "a source without a URL": { ...valid, sources: [{ title: "Example" }] },
  "a source that is not http": { ...valid, sources: [{ title: "Example", url: "ftp://example.com" }] },
  "a source URL with a space": { ...valid, sources: [{ title: "Example", url: "https://example.com/a b" }] },
  "a source title on two lines": { ...valid, sources: [{ title: "a\r\nb", url: "https://example.com" }] },
  "a source with a field of its own": { ...valid, sources: [{ ...source, note: "x" }] },
  "101 sources": { ...valid, sources: Array.from({ length: 101 }, () => source) },
};

describe("the reply v1 contract", () => {
  it("names the extension by a versioned URI in this repository", () => {
    assert.equal(REPLY_EXTENSION_URI, "https://github.com/yuanying/fraction-agents/tree/main/docs/extensions/reply/v1");
    assert.ok(schema.description.includes(REPLY_EXTENSION_URI), "the schema names the extension it belongs to");
  });

  for (const [name, value] of Object.entries(ACCEPTED)) {
    it(`accepts ${name}, as the JSON Schema does, in the host and in the tool`, () => {
      assert.equal(Check(schema, value), true, "the JSON Schema accepts it");
      const checked = checkReply(value);
      assert.ok(checked.ok, `the host accepts it: ${checked.ok ? "" : checked.error}`);
      assert.deepEqual(checked.reply, value);
      assert.equal(checkReplyInTool(value), undefined, "the tool accepts it");
    });
  }

  for (const [name, value] of Object.entries(REFUSED)) {
    it(`refuses ${name}, as the JSON Schema does, in the host and in the tool`, () => {
      assert.equal(Check(schema, value), false, "the JSON Schema refuses it");
      const checked = checkReply(value);
      assert.equal(checked.ok, false, "the host refuses it");
      assert.ok(!checked.ok && checked.error.length > 0, "the host says why");
      const error = checkReplyInTool(value);
      assert.equal(typeof error, "string", "the tool refuses it and says why");
    });
  }
});

describe("the reply as text", () => {
  it("puts the summary first, a heading per section and the sources as a list", () => {
    const text = renderReply({
      summary: "Tokyo is sunny today.\nTomorrow it rains.",
      sections: [
        { title: "Today", body: "Sunny, 25°C." },
        { title: "Tomorrow", body: "Rain from the morning.\n\n- umbrella" },
      ],
      sources: [
        { title: "Weather service", url: "https://weather.example/tokyo" },
        { title: "News", url: "https://news.example/a" },
      ],
    });
    assert.equal(
      text,
      [
        "Tokyo is sunny today.\nTomorrow it rains.",
        "## Today\n\nSunny, 25°C.",
        "## Tomorrow\n\nRain from the morning.\n\n- umbrella",
        "## Sources\n\n- [Weather service](https://weather.example/tokyo)\n- [News](https://news.example/a)",
      ].join("\n\n"),
    );
  });

  it("is only the summary when there are no sections or sources", () => {
    assert.equal(renderReply({ summary: "Yes.", sections: [], sources: [] }), "Yes.");
  });
});
