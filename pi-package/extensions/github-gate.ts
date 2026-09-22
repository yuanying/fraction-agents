// The GitHub gate (ADR 0009): the only way the agent writes to GitHub. It adds tools to push the context's
// branch, open or update its pull request and, for callers allowed to, merge it; and it stops pi's write, edit and
// bash tools from pushing, merging or changing protected paths. Settings: `github-gate.json` in the agent directory.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { Type } from "typebox";

import { defaultGateConfigPath, loadGateConfig, type GateConfig } from "../lib/config.ts";
import { Gate } from "../lib/gate.ts";
import { GitHubApp, type GitHubClient } from "../lib/github.ts";
import { text, type PiApi, type ToolCallEvent, type ToolContext } from "../lib/pi.ts";
import { checkBash, checkFileTool } from "../lib/rules.ts";

export interface GitHubGateOptions {
  env?: NodeJS.ProcessEnv;
  loadConfig?: (path: string) => GateConfig;
  github?: (config: GateConfig) => GitHubClient;
}

export function createGitHubGate(options: GitHubGateOptions = {}): (pi: PiApi) => void {
  return (pi) => {
    const env = options.env ?? process.env;
    const path = defaultGateConfigPath(env);
    if (!path || (!options.loadConfig && !existsSync(path))) return;
    const config = (options.loadConfig ?? loadGateConfig)(path);
    // One client per pi process: it keeps the installation token in memory until it runs out.
    const github = (options.github ?? ((c: GateConfig) => new GitHubApp(c)))(config);
    const caller = env.FRACTION_AGENTS_CALLER ?? "";
    const gate = (ctx: ToolContext) => new Gate({ config, github, cwd: ctx.cwd, caller });

    pi.registerTool({
      name: "github_push",
      label: "Push to GitHub",
      description:
        "Push the current branch of this workspace to GitHub. Only the context's branch can be pushed, never the default branch, and the push is refused if the branch changes files it may not.",
      promptSnippet: "Push the committed work of this workspace to GitHub",
      promptGuidelines: [
        "Commit with git, then publish with github_push or github_pull_request. git push does not work in bash.",
      ],
      parameters: Type.Object({}),
      async execute(_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: ToolContext) {
        return text(await gate(ctx).push());
      },
    });

    pi.registerTool({
      name: "github_pull_request",
      label: "Open or update the pull request",
      description:
        "Push the current branch and open its pull request, or update the one it already has. A conversation has one pull request; later changes are added to it. The title is required for a new pull request.",
      promptSnippet: "Push and open (or update) the pull request of this workspace",
      promptGuidelines: [
        "Every change is published as a pull request: after committing, call github_pull_request with a title and a body saying what changed and why.",
      ],
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: "The pull request's title." })),
        body: Type.Optional(Type.String({ description: "What changed and why, in Markdown." })),
      }),
      async execute(_id: string, params: { title?: string; body?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContext) {
        return text(await gate(ctx).pullRequest(params));
      },
    });

    if (config.mergeCallers.includes(caller)) {
      pi.registerTool({
        name: "github_merge",
        label: "Merge the pull request",
        description:
          "Merge this workspace's pull request into the default branch, after taking in the latest default branch. If only files that may be resolved here conflict, it says which: resolve them, git add them, and call it again. Other conflicts stop the merge.",
        promptSnippet: "Merge the pull request of this workspace",
        promptGuidelines: ["Use github_merge only when the caller asked for the change to be merged."],
        parameters: Type.Object({}),
        async execute(_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: ToolContext) {
          return text(await gate(ctx).merge());
        },
      });
    }

    pi.on("tool_call", (event: ToolCallEvent, ctx: ToolContext) => {
      const input = event.input;
      let reason: string | undefined;
      if (event.toolName === "bash" && typeof input.command === "string") {
        reason = checkBash(input.command, ctx.cwd, config, existsSync);
      } else if (typeof input.path === "string") {
        reason = checkFileTool(event.toolName, input.path, ctx.cwd, config, existsSync);
      }
      return reason === undefined ? undefined : { block: true, reason };
    });

    if (config.skillPaths.length > 0) {
      pi.on("resources_discover", (event: { cwd: string }) => ({
        skillPaths: config.skillPaths.map((path) => resolve(event.cwd, path)),
      }));
    }
  };
}

export default createGitHubGate();
