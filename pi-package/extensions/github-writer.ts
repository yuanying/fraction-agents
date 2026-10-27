// The GitHub writer's tools (ADR 0027): push a branch and open or update its pull request through the sidecar that
// holds the GitHub App's key, tell the state of that pull request (ADR 0028), and bring the read-only mirrors up to
// date. The agent has no GitHub credentials; the sidecar decides what may be written. Settings: `github-writer.json`
// in the agent directory, the same file the sidecar reads. Off when the agent has the GitHub gate (ADR 0009) instead,
// whose tools have the same names.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { Type } from "typebox";

import { GATE_CONFIG_FILE } from "../lib/config.ts";
import { text, type PiApi, type ToolContext } from "../lib/pi.ts";
import { WriterClient, pullRequestStatusWorkspace, pullRequestWorkspace, pushWorkspace, syncMirrors, writerUrl } from "../lib/writer-client.ts";
import { defaultWriterConfigPath, loadWriterConfig, type WriterConfig } from "../lib/writer-config.ts";

export interface GitHubWriterOptions {
  env?: NodeJS.ProcessEnv;
  loadConfig?: (path: string) => WriterConfig;
  client?: (config: WriterConfig) => WriterClient;
  warn?: (message: string) => void;
}

export function createGitHubWriterExtension(options: GitHubWriterOptions = {}): (pi: PiApi) => void {
  return (pi) => {
    const env = options.env ?? process.env;
    const warn = options.warn ?? console.error;
    const path = defaultWriterConfigPath(env);
    if (!path || (!options.loadConfig && !existsSync(path))) return;
    if (existsSync(join(env.PI_CODING_AGENT_DIR ?? "", GATE_CONFIG_FILE))) {
      warn(`github-writer: the agent directory has both ${GATE_CONFIG_FILE} and github-writer.json; the GitHub gate's tools are used, and these are off.`);
      return;
    }
    let config: WriterConfig;
    try {
      config = (options.loadConfig ?? loadWriterConfig)(path);
    } catch (error) {
      // Bad settings leave the agent without GitHub tools, not without pi.
      warn(`github-writer: ${path} is not usable, so the GitHub tools are off: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const client = (options.client ?? ((c: WriterConfig) => new WriterClient(writerUrl(c))))(config);
    const repositories = config.repositories.map((r) => `${r.owner}/${r.name} (branches ${r.branchPrefix}*)`).join(", ");
    const where = (ctx: ToolContext, params: { path?: string }) => resolve(ctx.cwd, params.path ?? ".");
    const pathParameter = Type.Optional(
      Type.String({ description: "The clone to work on, relative to the working directory. Defaults to the working directory." }),
    );

    pi.registerTool({
      name: "github_push",
      label: "Push to GitHub",
      description:
        `Push the current branch of a clone to GitHub. The clone must be made from a mirror (git clone file://${config.mirrorDir}/<owner>/<name>.git). ` +
        `Only these repositories and branches can be pushed: ${repositories}. The default branch never; a push that changes files outside the repository's rules is refused, and pushes are never forced.`,
      promptSnippet: "Push the committed work of a clone to GitHub",
      promptGuidelines: [
        "Commit with git, then publish with github_push or github_pull_request. git push does not work in bash: there are no GitHub credentials there.",
      ],
      parameters: Type.Object({ path: pathParameter }),
      async execute(_id: string, params: { path?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContext) {
        return text(await pushWorkspace(config, client, where(ctx, params)));
      },
    });

    pi.registerTool({
      name: "github_pull_request",
      label: "Open or update the pull request",
      description:
        "Push the current branch of a clone and open its pull request against the default branch, or update the open one it has. The title is required for a new pull request. It cannot merge.",
      promptSnippet: "Push and open (or update) the pull request of a clone",
      promptGuidelines: [
        "Every change is published as a pull request: after committing, call github_pull_request with a title and a body saying what changed and why.",
      ],
      parameters: Type.Object({
        path: pathParameter,
        title: Type.Optional(Type.String({ description: "The pull request's title." })),
        body: Type.Optional(Type.String({ description: "What changed and why, in Markdown." })),
      }),
      async execute(
        _id: string,
        params: { path?: string; title?: string; body?: string },
        _signal: unknown,
        _onUpdate: unknown,
        ctx: ToolContext,
      ) {
        const { path: _path, ...input } = params;
        return text(await pullRequestWorkspace(config, client, where(ctx, params), input));
      },
    });

    pi.registerTool({
      name: "github_pull_request_status",
      label: "State of the pull request",
      description:
        "Tell whether the latest pull request of a clone's current branch is open, merged, or closed without merging, or that it has none. A merged or closed pull request takes no more commits: work on a new branch from the latest default branch.",
      promptSnippet: "Tell the state of the pull request of a clone's branch",
      parameters: Type.Object({ path: pathParameter }),
      async execute(_id: string, params: { path?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContext) {
        return text(await pullRequestStatusWorkspace(config, client, where(ctx, params)));
      },
    });

    pi.registerTool({
      name: "github_sync",
      label: "Update the mirrors",
      description: `Bring the read-only mirror of a repository (owner/name), or of every repository, up to date with GitHub. Then git fetch origin in the clone. Repositories: ${repositories}.`,
      promptSnippet: "Bring the read-only mirrors up to date with GitHub",
      parameters: Type.Object({
        repository: Type.Optional(Type.String({ description: "owner/name. Every repository when left out." })),
      }),
      async execute(_id: string, params: { repository?: string }) {
        return text(await syncMirrors(config, client, params.repository));
      },
    });
  };
}

export default createGitHubWriterExtension();
