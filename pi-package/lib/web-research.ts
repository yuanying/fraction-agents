import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The web research settings: where the agent searches. It searches only through a SearXNG instance, which the
 * environment runs and names here; the URL is its JSON search endpoint (`/search`). No secrets.
 */
export interface WebResearchConfig {
  searxng: {
    url: string;
    /** How long one search may take. */
    timeoutSeconds: number;
    /** The most results one search returns to the agent. */
    maxResults: number;
  };
}

/** The file name of the settings inside pi's agent directory. */
export const WEB_RESEARCH_CONFIG_FILE = "web-research.json";

export function defaultWebResearchConfigPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const agentDir = env.PI_CODING_AGENT_DIR;
  return agentDir ? join(agentDir, WEB_RESEARCH_CONFIG_FILE) : undefined;
}

export function loadWebResearchConfig(path: string): WebResearchConfig {
  return parseWebResearchConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function parseWebResearchConfig(input: unknown): WebResearchConfig {
  const root = record(input, "config");
  const searxng = record(root.searxng, "searxng");
  if (typeof searxng.url !== "string" || searxng.url === "") throw new Error("web-research: searxng.url is required");
  let url: URL;
  try {
    url = new URL(searxng.url);
  } catch {
    throw new Error("web-research: searxng.url is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("web-research: searxng.url must be http or https");
  if (url.username || url.password) throw new Error("web-research: searxng.url must not carry credentials");
  return {
    searxng: {
      url: url.toString(),
      timeoutSeconds: positiveInteger(searxng.timeoutSeconds, 20, "searxng.timeoutSeconds"),
      maxResults: positiveInteger(searxng.maxResults, 10, "searxng.maxResults"),
    },
  };
}

export type TimeRange = "day" | "week" | "month" | "year";

export interface SearchParams {
  query: string;
  page?: number;
  language?: string;
  timeRange?: TimeRange;
}

interface SearxngResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  engine?: unknown;
  engines?: unknown;
  publishedDate?: unknown;
}

/** The longest snippet shown per result. The page itself is read with fetch_content. */
const SNIPPET_CHARS = 300;

/** Searches SearXNG and returns the results as text for the model. */
export async function searchSearxng(
  config: WebResearchConfig,
  params: SearchParams,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
  const query = params.query.trim();
  if (!query) throw new Error("searxng_search: query is empty");
  const url = new URL(config.searxng.url);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  if (params.page !== undefined && params.page > 1) url.searchParams.set("pageno", String(Math.floor(params.page)));
  if (params.language) url.searchParams.set("language", params.language);
  if (params.timeRange) url.searchParams.set("time_range", params.timeRange);

  const timeout = AbortSignal.timeout(config.searxng.timeoutSeconds * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await (options.fetch ?? fetch)(url, { headers: { Accept: "application/json" }, signal, redirect: "error" });
  const body = await response.text();
  if (!response.ok) throw new Error(`SearXNG answered HTTP ${response.status}`);
  let data: { results?: unknown; unresponsive_engines?: unknown };
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("SearXNG did not answer JSON (is format=json enabled in its settings?)");
  }

  const results = (Array.isArray(data.results) ? (data.results as SearxngResult[]) : [])
    .filter((result) => typeof result.url === "string")
    .slice(0, config.searxng.maxResults);
  const lines: string[] = [];
  if (results.length === 0) {
    lines.push(`No results for "${query}".`);
  } else {
    lines.push(`Results for "${query}"${params.page && params.page > 1 ? ` (page ${params.page})` : ""}:`);
    results.forEach((result, index) => {
      lines.push(`${index + 1}. ${oneLine(result.title) || "(no title)"}`);
      lines.push(`   ${result.url}`);
      const snippet = oneLine(result.content);
      if (snippet) lines.push(`   ${snippet.length > SNIPPET_CHARS ? `${snippet.slice(0, SNIPPET_CHARS)}…` : snippet}`);
      const engines = Array.isArray(result.engines) ? result.engines.filter((e) => typeof e === "string") : typeof result.engine === "string" ? [result.engine] : [];
      const date = typeof result.publishedDate === "string" && result.publishedDate ? `, published: ${result.publishedDate}` : "";
      if (engines.length > 0 || date) lines.push(`   (engines: ${engines.join(", ") || "unknown"}${date})`);
    });
  }
  const unresponsive = Array.isArray(data.unresponsive_engines)
    ? data.unresponsive_engines
        .filter((entry): entry is unknown[] => Array.isArray(entry) && typeof entry[0] === "string")
        .map((entry) => (typeof entry[1] === "string" && entry[1] ? `${entry[0]} (${entry[1]})` : String(entry[0])))
    : [];
  if (unresponsive.length > 0) lines.push(`Search engines that did not answer: ${unresponsive.join(", ")}`);
  return lines.join("\n");
}

export interface UnreadablePage {
  url: string;
  /** What last found it unreadable: `fetch_content`, or `report` when the agent reported it. */
  via: string;
  reasons: string[];
}

/** The pages one task could not read (ADR 0013): fetch failures, and what the agent reports itself. */
export class UnreadablePages {
  private readonly pages = new Map<string, UnreadablePage>();

  add(url: string, via: string, reason: string): number {
    const page = this.pages.get(url);
    if (page) {
      page.via = via;
      if (!page.reasons.includes(reason)) page.reasons.push(reason);
    } else {
      this.pages.set(url, { url, via, reasons: [reason] });
    }
    return this.pages.size;
  }

  /** Takes the fetch failures out of a fetch_content result's details. */
  addFetchResult(details: unknown): void {
    const pages = details && typeof details === "object" ? (details as { pages?: unknown }).pages : undefined;
    if (!Array.isArray(pages)) return;
    for (const page of pages) {
      if (page && typeof page === "object" && typeof page.url === "string" && typeof page.error === "string" && page.error) {
        this.add(page.url, "fetch_content", page.error);
      }
    }
  }

  get count(): number {
    return this.pages.size;
  }

  list(): UnreadablePage[] {
    return [...this.pages.values()].map((page) => ({ ...page, reasons: [...page.reasons] }));
  }

  clear(): void {
    this.pages.clear();
  }
}

function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`web-research: ${name} must be an object`);
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`web-research: ${name} must be a positive integer`);
  return value;
}
