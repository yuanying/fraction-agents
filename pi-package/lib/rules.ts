import { isAbsolute, relative, resolve } from "node:path";

/** Which paths of the repository the agent may touch, and how. Paths are relative to the repository root. */
export interface PathRules {
  /** New files may be added here; existing ones may not be changed or deleted (e.g. `raw/`). */
  appendOnlyPaths: string[];
  /** Nothing here may be added, changed or deleted (e.g. `Permanent-Notes/`). */
  readOnlyPaths: string[];
  /** Merge conflicts in these files may be resolved by the agent (e.g. `wiki/index.md`, `wiki/log.md`). */
  mechanicalConflictPaths: string[];
}

/** One line of `git diff --name-status --no-renames`: A(dded), M(odified), D(eleted), T(ype changed). */
export interface Change {
  status: string;
  path: string;
}

/**
 * A path rule matches the path itself and everything under it. `raw/` and `raw` both match `raw/x.md`, and
 * neither matches `rawish/x.md`.
 */
export function underPath(path: string, rule: string): boolean {
  const base = rule.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

function matching(path: string, rules: readonly string[]): string | undefined {
  return rules.find((rule) => underPath(path, rule));
}

function display(rule: string): string {
  return `${rule.replace(/\/+$/, "")}/`;
}

const VERB: Record<string, string> = { A: "added", D: "deleted" };

/** What is wrong with a set of changes, one line per offending file. Empty when the changes may be pushed. */
export function checkChanges(changes: readonly Change[], rules: PathRules): string[] {
  const problems: string[] = [];
  for (const { status, path } of changes) {
    const verb = VERB[status[0] ?? ""] ?? "changed";
    const readOnly = matching(path, rules.readOnlyPaths);
    if (readOnly !== undefined) {
      problems.push(`${path}: files under ${display(readOnly)} may not be ${verb}`);
      continue;
    }
    const appendOnly = matching(path, rules.appendOnlyPaths);
    if (appendOnly !== undefined && !status.startsWith("A")) {
      problems.push(`${path}: existing files under ${display(appendOnly)} may not be ${verb} (only new files may be added)`);
    }
  }
  return problems;
}

/** Whether every conflicted file is one the agent may resolve itself. */
export function onlyMechanical(conflicts: readonly string[], rules: PathRules): boolean {
  return conflicts.every((path) => matching(path, rules.mechanicalConflictPaths) !== undefined);
}

/** The path relative to the workspace root, or `undefined` if it lies outside. */
function inWorkspace(path: string, cwd: string): string | undefined {
  const cleaned = path.replace(/^@/, "");
  const rel = relative(cwd, resolve(cwd, cleaned));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return rel === "" ? "." : undefined;
  return rel;
}

/**
 * Why pi's `write` or `edit` tool may not touch the path, or `undefined` if it may. `exists` answers for
 * absolute paths.
 */
export function checkFileTool(
  tool: string,
  path: string,
  cwd: string,
  rules: PathRules,
  exists: (absolutePath: string) => boolean,
): string | undefined {
  if (tool !== "write" && tool !== "edit") return undefined;
  const rel = inWorkspace(path, cwd);
  if (rel === undefined) return undefined;
  const readOnly = matching(rel, rules.readOnlyPaths);
  if (readOnly !== undefined) return `${display(readOnly)} is read-only: ${rel} may not be written.`;
  const appendOnly = matching(rel, rules.appendOnlyPaths);
  if (appendOnly !== undefined && (tool === "edit" || exists(resolve(cwd, rel)))) {
    return `Under ${display(appendOnly)} only new files may be added: ${rel} already exists and may not be changed.`;
  }
  return undefined;
}

/** Commands that change the files they are given. */
const MUTATING = new Set(["rm", "rmdir", "mv", "cp", "tee", "truncate", "chmod", "chown", "ln", "touch", "dd", "install", "rsync", "unlink", "shred"]);
/** Git subcommands that change files in the working tree. */
const GIT_MUTATING = new Set(["rm", "mv", "checkout", "restore", "reset", "clean", "apply", "stash"]);
/** Git options that take a separate argument before the subcommand. */
const GIT_OPTIONS_WITH_ARGUMENT = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

const PUSH_REFUSAL = "git push is not available in the shell. Use the github_push tool (or github_pull_request) to push the branch.";
const MERGE_REFUSAL = "Merging pull requests from the shell is not allowed. Use the github_merge tool when the caller asked for a merge.";

function tokens(segment: string): string[] {
  return segment
    .split(/\s+/)
    .filter((token) => token !== "")
    .map((token) => token.replace(/^['"]+|['"]+$/g, ""));
}

function gitSubcommand(words: readonly string[]): string | undefined {
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (GIT_OPTIONS_WITH_ARGUMENT.has(word)) {
      i++;
      continue;
    }
    if (!word.startsWith("-")) return word;
  }
  return undefined;
}

/**
 * Why pi's `bash` tool may not run the command, or `undefined` if it may. This is a second line of defence after
 * the missing credentials: it catches the obvious forms (git push, merging from the shell, rm/mv/sed -i/redirects
 * into protected paths), not every way a shell can write a file.
 */
export function checkBash(
  command: string,
  cwd: string,
  rules: PathRules,
  exists: (absolutePath: string) => boolean,
): string | undefined {
  if (/\/pulls\/[^\s/]+\/merge\b/.test(command) || /\/merges\b/.test(command)) return MERGE_REFUSAL;
  // Split into simple commands; a redirection is kept with its command.
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const redirects = [...segment.matchAll(/\d*>{1,2}\|?\s*([^\s;&|]+)/g)].map((match) => match[1]!.replace(/^['"]+|['"]+$/g, ""));
    const words = tokens(segment.replace(/\d*>{1,2}\|?\s*[^\s;&|]+/g, " "));
    while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || words[0] === "sudo" || words[0] === "env")) words.shift();
    const program = words[0]?.split("/").at(-1);
    let targets: string[] = redirects;
    if (program === "git") {
      const sub = gitSubcommand(words);
      if (sub === "push") return PUSH_REFUSAL;
      if (sub !== undefined && GIT_MUTATING.has(sub)) targets = [...targets, ...words.slice(1)];
    } else if (program === "gh") {
      const rest = words.slice(1);
      const pr = rest.indexOf("pr");
      if (pr >= 0 && rest[pr + 1] === "merge") return MERGE_REFUSAL;
    } else if (program !== undefined) {
      const inPlace = (program === "sed" || program === "perl") && words.some((word) => /^-[a-zA-Z]*i/.test(word));
      if (MUTATING.has(program) || inPlace) targets = [...targets, ...words.slice(1)];
    }
    for (const target of targets) {
      if (target.startsWith("-")) continue;
      const rel = inWorkspace(target, cwd);
      if (rel === undefined) continue;
      const readOnly = matching(rel, rules.readOnlyPaths);
      if (readOnly !== undefined) return `${display(readOnly)} is read-only; this command would change ${rel}.`;
      const appendOnly = matching(rel, rules.appendOnlyPaths);
      if (appendOnly !== undefined && exists(resolve(cwd, rel))) {
        return `Under ${display(appendOnly)} only new files may be added; this command would change the existing ${rel}.`;
      }
    }
  }
  return undefined;
}
