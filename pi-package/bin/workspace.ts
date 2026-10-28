// The context workspace command for the fraction-agents host (`contextWorkspace` in its config):
//
//   node workspace.ts prepare <dir>   make <dir> the context's git worktree, or keep the one that is there
//   node workspace.ts remove <dir>    remove the worktree and the context's local branches
//   node workspace.ts add <dir> <owner>/<name>
//                                     with github-writer.json: add the context's worktree of one more repository
//
// The host runs it with pi's environment: the settings are in `PI_CODING_AGENT_DIR`, and the context is
// `FRACTION_AGENTS_CONTEXT_ID`. With `github-gate.json` (ADR 0009), <dir> is the worktree of the gate's repository.
// With `github-writer.json` instead (ADR 0028), <dir> holds a worktree of each of the repositories of the writer's
// `workspace.repositories`; the agent adds the others from its shell, where the same environment is set.
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

import { defaultGateConfigPath, loadGateConfig } from "../lib/config.ts";
import { GitHubApp } from "../lib/github.ts";
import { prepareWorkspace, removeWorkspace } from "../lib/workspace.ts";
import { defaultWriterConfigPath, loadWriterConfig } from "../lib/writer-config.ts";
import { addWriterWorktree, prepareWriterWorkspace, removeWriterWorkspace } from "../lib/writer-workspace.ts";

const [action, path, repository] = process.argv.slice(2);
const gatePath = defaultGateConfigPath();
if ((action !== "prepare" && action !== "remove" && action !== "add") || !path || (action === "add") !== (repository !== undefined) || !gatePath) {
  process.stderr.write("usage: PI_CODING_AGENT_DIR=<agent dir> workspace.ts prepare|remove <dir>, or add <dir> <owner>/<name>\n");
  process.exit(2);
}
const dir = resolve(path);
const writerPath = defaultWriterConfigPath();
const contextId = process.env.FRACTION_AGENTS_CONTEXT_ID || basename(dir);
try {
  if (!existsSync(gatePath) && writerPath && existsSync(writerPath)) {
    const config = loadWriterConfig(writerPath);
    if (action === "add") {
      const worktree = await addWriterWorktree({ config, dir, contextId, repository: repository! });
      process.stdout.write(`The worktree of ${repository} is at ${worktree}, on the branch of this context.\n`);
    } else if (action === "prepare") {
      await prepareWriterWorkspace({ config, dir, contextId });
    } else {
      await removeWriterWorkspace({ config, dir, contextId });
    }
  } else if (action === "add") {
    throw new Error("add needs github-writer.json in the agent directory.");
  } else {
    const config = loadGateConfig(gatePath);
    if (action === "prepare") {
      await prepareWorkspace({ config, github: new GitHubApp(config), dir, contextId });
    } else {
      await removeWorkspace({ config, dir, contextId });
    }
  }
} catch (error) {
  process.stderr.write(`workspace ${action}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
