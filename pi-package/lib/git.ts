import { execFile } from "node:child_process";

import type { GitHubClient } from "./github.ts";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git and returns what it said, whatever the exit code. */
export function runGit(cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      },
    );
  });
}

/** Runs git and returns its output, or throws with what git said. */
export async function git(cwd: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> {
  const result = await runGit(cwd, args, env);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  return result.stdout;
}

/**
 * The environment that lets one git command authenticate to the remote. The header goes through git's
 * `GIT_CONFIG_*` variables of that child process only: it never reaches pi's environment, bash, a file or the
 * repository's config. For an http(s) remote it is scoped to the remote's origin.
 */
export async function authEnv(github: GitHubClient, remoteUrl: string): Promise<Record<string, string>> {
  const authorization = await github.gitAuthorization();
  const url = new URL(remoteUrl);
  const key = url.protocol === "https:" || url.protocol === "http:" ? `http.${url.origin}/.extraHeader` : "http.extraHeader";
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: `Authorization: ${authorization}` };
}
