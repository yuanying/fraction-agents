// Decides the weekly release (ADR 0024) and the release right after a vulnerability fix is merged (ADR 0029). The next
// patch version is released only when every commit since the latest vX.Y.Z tag, merge commits aside, is Renovate's or
// vuln-responder's, and they changed something outside .github/ and renovate.json. Anything else is left to a release
// by hand.
//
// Run as a script, it prints the reason, and in GitHub Actions writes version and message to $GITHUB_OUTPUT;
// version is empty when nothing is released. The reason goes to the job summary as well, and when a person's commits
// held the release back, so do those commits and the commands to release by hand.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const RENOVATE = "renovate[bot]";
export const VULN_RESPONDER = "fraction-vuln-responder[bot]";

// The authors whose commits alone are released without a person, with the name the tag message gives each.
const bots = new Map([
  [RENOVATE, "Renovate"],
  [VULN_RESPONDER, "vuln-responder"],
]);

export interface Commit {
  sha: string;
  author: string;
  subject: string;
}

// What a release by hand would be: the version next to the latest tag, on the commit the plan looked at, and the
// commits of people that kept it from being released on its own.
export interface Held {
  version: string;
  sha: string;
  commits: Commit[];
}

export interface Plan {
  version?: string;
  message?: string;
  reason: string;
  held?: Held;
}

const versionTag = /^v(\d+)\.(\d+)\.(\d+)$/;

export function latestVersionTag(tags: string[]): string | undefined {
  let latest: { tag: string; parts: number[] } | undefined;
  for (const tag of tags) {
    const match = versionTag.exec(tag);
    if (!match) continue;
    const parts = match.slice(1).map(Number);
    if (!latest || compare(parts, latest.parts) > 0) latest = { tag, parts };
  }
  return latest?.tag;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function nextPatch(tag: string): string {
  const [major, minor, patch] = tag.slice(1).split(".").map(Number);
  return `v${major}.${minor}.${(patch ?? 0) + 1}`;
}

// Changes to these alone do not reach the images or the manifests a release names.
function outsideRelease(path: string): boolean {
  return path.startsWith(".github/") || path === "renovate.json";
}

function lines(output: string): string[] {
  return output.split("\n").filter((line) => line !== "");
}

export function planRelease(cwd: string): Plan {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

  const tag = latestVersionTag(lines(git("tag", "--list", "--merged", "HEAD")));
  if (!tag) return { reason: "HEAD から届く vX.Y.Z のタグがないので、リリースしない" };

  const commits: Commit[] = lines(
    git("log", "--no-merges", "--topo-order", "--reverse", "--format=%H%x00%an%x00%s", `${tag}..HEAD`),
  ).map((line) => {
    const [sha = "", author = "", subject = ""] = line.split("\0");
    return { sha, author, subject };
  });
  if (commits.length === 0) return { reason: `${tag} からマージ以外のコミットがないので、リリースしない` };

  // A run that waited for another may find its commit released already, or its version taken by a tag the commit does
  // not reach; releasing again would push older images over that version.
  const version = nextPatch(tag);
  const released = lines(git("tag", "--list", "--contains", "HEAD")).filter((t) => versionTag.test(t));
  if (released.length > 0) return { reason: `HEAD は既に ${released.join("、")} に入っているので、リリースしない` };
  if (lines(git("tag", "--list", version)).length > 0) {
    return { reason: `次の版 ${version} のタグが既にあるので、リリースしない` };
  }

  const botNames = [...bots.keys()].join(" と ");
  const people = commits.filter((c) => !bots.has(c.author));
  if (people.length > 0) {
    const others = [...new Set(people.map((c) => c.author))];
    return {
      reason: `${tag} から ${botNames} 以外のコミット（${others.join("、")}）があるので、手のリリースに任せる`,
      held: { version, sha: git("rev-parse", "HEAD").trim(), commits: people },
    };
  }

  const changed = lines(git("diff", "--name-only", tag, "HEAD")).filter((path) => !outsideRelease(path));
  if (changed.length === 0) {
    return { reason: `${tag} からの ${botNames} の変更は .github/ と renovate.json だけなので、リリースしない` };
  }

  const labels = [...bots].filter(([author]) => commits.some((c) => c.author === author)).map(([, label]) => label);
  return {
    version,
    message: [`${version}: 依存の更新（${labels.join("・")}）`, "", ...commits.map((c) => `- ${c.subject}`)].join("\n"),
    reason: `${tag} から ${botNames} のコミットだけで、リリースの中身が変わった（${changed.join("、")}）ので、${version} を出す`,
  };
}

// Markdown for the job summary: why nothing was released, and when people's commits held it back, which commits and
// how to release by hand. A tag pushed by hand releases the images through image.yml.
export function heldSummary(reason: string, held?: Held): string {
  const out = [reason];
  if (held) {
    out.push(
      "",
      "止めたコミット:",
      "",
      ...held.commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.author}: ${c.subject}`),
      "",
      "中身を確かめてから、手で出すには:",
      "",
      "```sh",
      `git fetch origin --tags`,
      `git tag -a ${held.version} ${held.sha} -m '${held.version}: <何を入れたか>'`,
      `git push origin ${held.version}`,
      "```",
    );
  }
  return `${out.join("\n")}\n`;
}

if (import.meta.main) {
  const plan = planRelease(process.cwd());
  console.log(plan.reason);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, heldSummary(plan.reason, plan.held));
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const delimiter = `EOF-${process.pid}-${Date.now()}`;
    appendFileSync(output, `version=${plan.version ?? ""}\nmessage<<${delimiter}\n${plan.message ?? ""}\n${delimiter}\n`);
  }
}
