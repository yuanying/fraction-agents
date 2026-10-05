// The reply contract (fraction-agents ADR 0015, docs/extensions/reply/v1): the shape of the reply an agent submits
// with submit_reply and the host returns as an A2A data part. The one checker of the shape, used by the tool and by
// the host. It imports nothing, so the host can run it outside pi.

/** A reply in the shape of the contract: the answer in three lines, the details by section, and the sources. */
export interface Reply {
  summary: string;
  sections: { title: string; body: string }[];
  sources: { title: string; url: string }[];
}

/** The limits of `reply.schema.json`. Lengths are counted in characters (code points), as JSON Schema does. */
const SUMMARY_LIMIT = 500;
const SUMMARY_LINES = 3;
const SECTIONS_LIMIT = 50;
const SECTION_TITLE_LIMIT = 200;
const SECTION_BODY_LIMIT = 50_000;
const SOURCES_LIMIT = 100;
const SOURCE_TITLE_LIMIT = 300;
const URL_LIMIT = 2000;
const ONE_LINE = /^[^\r\n]+$/;
const HTTP_URL = /^https?:\/\/\S+$/;

/**
 * Checks a value against the reply contract, as `reply.schema.json` does. Returns what is wrong, or `undefined`
 * when the value is a {@link Reply}.
 */
export function checkReply(value: unknown): string | undefined {
  if (!isRecord(value)) return "the reply is not an object";
  const extra = Object.keys(value).filter((key) => !["summary", "sections", "sources"].includes(key));
  if (extra.length > 0) return `the reply has fields outside the contract: ${extra.join(", ")}`;
  const { summary, sections, sources } = value;

  if (typeof summary !== "string") return "summary is not a string";
  const summaryError = checkText("summary", summary, SUMMARY_LIMIT);
  if (summaryError) return summaryError;
  if (summary.split("\n").length > SUMMARY_LINES) return `summary is longer than ${SUMMARY_LINES} lines`;

  if (!Array.isArray(sections)) return "sections is not a list";
  if (sections.length > SECTIONS_LIMIT) return `more than ${SECTIONS_LIMIT} sections`;
  for (const [index, section] of sections.entries()) {
    const error = checkEntry(`sections[${index}]`, section, "body", (body) => checkText("body", body, SECTION_BODY_LIMIT), SECTION_TITLE_LIMIT);
    if (error) return error;
  }

  if (!Array.isArray(sources)) return "sources is not a list";
  if (sources.length > SOURCES_LIMIT) return `more than ${SOURCES_LIMIT} sources`;
  for (const [index, source] of sources.entries()) {
    const error = checkEntry(`sources[${index}]`, source, "url", checkUrl, SOURCE_TITLE_LIMIT);
    if (error) return error;
  }
  return undefined;
}

/** Checks a section or a source: an object of a one-line `title` and one more field. */
function checkEntry(
  where: string,
  value: unknown,
  field: string,
  checkField: (value: string) => string | undefined,
  titleLimit: number,
): string | undefined {
  if (!isRecord(value)) return `${where} is not an object`;
  const extra = Object.keys(value).filter((key) => key !== "title" && key !== field);
  if (extra.length > 0) return `${where} has fields outside the contract: ${extra.join(", ")}`;
  const { title } = value;
  const content = value[field];
  if (typeof title !== "string") return `${where}.title is not a string`;
  const titleError = checkText("title", title, titleLimit) ?? (ONE_LINE.test(title) ? undefined : "title is not one line");
  if (titleError) return `${where}.${titleError}`;
  if (typeof content !== "string") return `${where}.${field} is not a string`;
  const error = checkField(content);
  return error ? `${where}.${error}` : undefined;
}

function checkText(name: string, value: string, limit: number): string | undefined {
  const length = [...value].length;
  if (length === 0) return `${name} is empty`;
  if (length > limit) return `${name} is longer than ${limit} characters`;
  return undefined;
}

function checkUrl(url: string): string | undefined {
  if ([...url].length > URL_LIMIT) return `url is longer than ${URL_LIMIT} characters`;
  return HTTP_URL.test(url) ? undefined : "url is not an http or https URL";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
