// Web research (ADR 0013): the agent searches only through SearXNG, and each task logs the pages it could not
// read. It adds searxng_search and report_unreadable, and blocks the search tools of other packages, whose
// queries would go straight to outside search services. Settings: `web-research.json` in the agent directory.
import { existsSync } from "node:fs";

import { Type } from "typebox";

import { text, type PiApi } from "../lib/pi.ts";
import {
  defaultWebResearchConfigPath,
  loadWebResearchConfig,
  searchSearxng,
  UnreadablePages,
  type SearchParams,
  type WebResearchConfig,
} from "../lib/web-research.ts";

/** Search tools of the packages the agent loads (@kvidzibo/pi-web-access, pi-agent-browser-native). */
const BLOCKED_SEARCH_TOOLS = ["web_search", "agent_browser_web_search"];

export interface WebResearchOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Where the per-task count and warnings go. pi's stderr, which the host keeps in its log. */
  log?: (line: string) => void;
}

export function createWebResearch(options: WebResearchOptions = {}): (pi: PiApi) => void {
  return (pi) => {
    const env = options.env ?? process.env;
    const log = options.log ?? ((line: string) => console.error(line));
    const path = defaultWebResearchConfigPath(env);
    if (!path || !existsSync(path)) return;
    let config: WebResearchConfig;
    try {
      config = loadWebResearchConfig(path);
    } catch (error) {
      // Like the GitHub gate: bad settings leave the agent without these tools, not without pi.
      const message = error instanceof Error ? error.message : String(error);
      log(`web-research: ${path} is not usable, so searxng_search is off: ${message}`);
      return;
    }
    const unreadable = new UnreadablePages();

    pi.registerTool({
      name: "searxng_search",
      label: "Search the web",
      description:
        "Search the web through SearXNG, which asks several search engines. Returns titles, URLs and short snippets; read a page with fetch_content.",
      promptSnippet: "Search the web (SearXNG)",
      promptGuidelines: [
        "Search with searxng_search. It is the only search tool; do not open search engines in the browser.",
        "Snippets are not sources. Read the page with fetch_content before relying on it.",
      ],
      parameters: Type.Object({
        query: Type.String({ description: "The search query." }),
        page: Type.Optional(Type.Integer({ minimum: 1, description: "Result page, from 1." })),
        language: Type.Optional(Type.String({ description: "Language code such as ja or en. Omit for all languages." })),
        timeRange: Type.Optional(
          Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
            description: "Only results from this recent period.",
          }),
        ),
      }),
      async execute(_id: string, params: SearchParams, signal: AbortSignal | undefined) {
        return text(await searchSearxng(config, params, { fetch: options.fetch, signal }));
      },
    });

    pi.registerTool({
      name: "report_unreadable",
      label: "Report an unreadable page",
      description:
        "Record a page you could not read: a check or CAPTCHA screen, a bot block, a login wall, or a browser failure. The count is kept per task.",
      promptSnippet: "Record a page that could not be read",
      promptGuidelines: [
        "Call report_unreadable for every page you could not read in the end, and for every check or CAPTCHA screen you met, even if another way worked.",
      ],
      parameters: Type.Object({
        url: Type.String({ description: "The page's URL." }),
        reason: Type.String({ description: "What stopped you, in a few words." }),
      }),
      async execute(_id: string, params: { url: string; reason: string }) {
        const count = unreadable.add(params.url, "report", params.reason);
        return text(`Recorded. Pages not read in this task so far: ${count}.`);
      },
    });

    pi.on("tool_call", (event: { toolName: string }) => {
      if (BLOCKED_SEARCH_TOOLS.includes(event.toolName)) {
        return { block: true, reason: `${event.toolName} is not available here. Search with searxng_search.` };
      }
      return undefined;
    });

    pi.on("tool_result", (event: { toolName: string; details?: unknown }) => {
      if (event.toolName === "fetch_content") unreadable.addFetchResult(event.details);
      return undefined;
    });

    pi.on("agent_start", () => {
      unreadable.clear();
    });

    pi.on("agent_end", () => {
      const entry = {
        event: "unreadable-pages",
        contextId: env.FRACTION_AGENTS_CONTEXT_ID ?? "",
        count: unreadable.count,
        pages: unreadable.list(),
      };
      log(`web-research: ${JSON.stringify(entry)}`);
      unreadable.clear();
    });
  };
}

export default createWebResearch();
