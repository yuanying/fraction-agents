// The context workspace command for the fraction-agents host (`contextWorkspace` in its config):
//
//   node workspace.ts prepare <dir>   make <dir> the context's git worktree, or keep the one that is there
//   node workspace.ts remove <dir>    remove the worktree and the context's local branches
//
// The host runs it with pi's environment: the settings are `github-gate.json` in `PI_CODING_AGENT_DIR`, and the
// context is `FRACTION_AGENTS_CONTEXT_ID`.
import { basename } from "node:path";

import { defaultGateConfigPath, loadGateConfig } from "../lib/config.ts";
import { GitHubApp } from "../lib/github.ts";
import { prepareWorkspace, removeWorkspace } from "../lib/workspace.ts";

const [action, dir] = process.argv.slice(2);
const path = defaultGateConfigPath();
if ((action !== "prepare" && action !== "remove") || !dir || !path) {
  process.stderr.write("usage: PI_CODING_AGENT_DIR=<agent dir> workspace.ts prepare|remove <dir>\n");
  process.exit(2);
}
const config = loadGateConfig(path);
const contextId = process.env.FRACTION_AGENTS_CONTEXT_ID || basename(dir);
try {
  if (action === "prepare") {
    await prepareWorkspace({ config, github: new GitHubApp(config), dir, contextId });
  } else {
    await removeWorkspace({ config, dir, contextId });
  }
} catch (error) {
  process.stderr.write(`workspace ${action}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
