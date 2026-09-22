import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const script = join(import.meta.dirname, "..", "skills", "fraction-agents", "scripts", "agent.mjs");

const token = "eyJhbGciOiJSUzI1NiJ9.c2VjcmV0LXRva2VuLWZvci10ZXN0cw.c2lnbmF0dXJl";

// A stand-in for the a2a CLI: it records how it was started and prints something of its own.
const fakeA2a = `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_A2A_RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  auth: process.env.A2ACLI_AUTH ?? null,
  agentCard: process.env.A2ACLI_AGENT_CARD ?? null,
}));
process.stdout.write("Task ID: task-1\\nContext ID: ctx-1\\nState: TASK_STATE_SUBMITTED\\n");
process.stderr.write("fake a2a stderr\\n");
process.exit(Number(process.env.FAKE_A2A_EXIT ?? "0"));
`;

interface Env {
  home: string;
  configDir: string;
  record: string;
  env: Record<string, string>;
}

function setup(options: { withA2a?: boolean } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), "skill-agent-"));
  const home = join(root, "home");
  const configDir = join(home, ".config", "fraction-agents");
  mkdirSync(join(configDir, "tokens"), { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  if (options.withA2a !== false) {
    writeFileSync(join(bin, "a2a"), fakeA2a);
    chmodSync(join(bin, "a2a"), 0o755);
  }
  const record = join(root, "record.json");
  return {
    home,
    configDir,
    record,
    env: {
      HOME: home,
      PATH: `${bin}:${dirname(process.execPath)}`,
      FAKE_A2A_RECORD: record,
    },
  };
}

function writeToken(path: string, value = `${token}\n`, mode = 0o600): void {
  writeFileSync(path, value);
  chmodSync(path, mode);
}

function writeConfig(e: Env, config: unknown, path = join(e.configDir, "agents.json")): void {
  writeFileSync(path, JSON.stringify(config));
}

function standard(e: Env): void {
  writeToken(join(e.configDir, "tokens", "claude"));
  writeConfig(e, {
    tokenFile: "~/.config/fraction-agents/tokens/claude",
    agents: {
      "wiki-keeper": { url: "https://agents.example.test/wiki-keeper/" },
      reviewer: { url: "https://agents.example.test/reviewer/" },
    },
  });
}

function run(e: Env, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...e.env, ...extraEnv },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function recorded(e: Env): { argv: string[]; auth: string | null; agentCard: string | null } {
  return JSON.parse(readFileSync(e.record, "utf8"));
}

function invoked(e: Env): boolean {
  try {
    readFileSync(e.record);
    return true;
  } catch {
    return false;
  }
}

describe("skills/fraction-agents/scripts/agent.mjs", () => {
  it("runs a2a against the named agent with its URL and token in the environment", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["wiki-keeper", "send", "--async", "この記事を取り込んで"]);
    assert.equal(result.status, 0, result.stderr);
    const r = recorded(e);
    assert.deepEqual(r.argv, ["send", "--async", "この記事を取り込んで"]);
    assert.equal(r.agentCard, "https://agents.example.test/wiki-keeper/");
    assert.equal(r.auth, `Bearer ${token}`);
  });

  it("never puts the token on a2a's command line or in its own output", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["reviewer", "task", "get", "task-1", "--wait"]);
    assert.equal(result.status, 0, result.stderr);
    const r = recorded(e);
    assert.equal(r.agentCard, "https://agents.example.test/reviewer/");
    assert.ok(!r.argv.join(" ").includes(token));
    assert.ok(!r.argv.some((arg) => /bearer|--auth/i.test(arg)));
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));
  });

  it("passes a2a's output and exit status through", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["wiki-keeper", "task", "get", "task-1", "--wait"], { FAKE_A2A_EXIT: "5" });
    assert.equal(result.status, 5);
    assert.match(result.stdout, /Task ID: task-1/);
    assert.match(result.stderr, /fake a2a stderr/);
  });

  it("replaces an A2ACLI_AUTH or A2ACLI_AGENT_CARD already in the environment", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["wiki-keeper", "card", "get"], {
      A2ACLI_AUTH: "Bearer someone-else",
      A2ACLI_AGENT_CARD: "https://elsewhere.example.test/",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(recorded(e).auth, `Bearer ${token}`);
    assert.equal(recorded(e).agentCard, "https://agents.example.test/wiki-keeper/");
  });

  it("lets an agent use its own token file", () => {
    const e = setup();
    writeToken(join(e.configDir, "tokens", "claude"));
    writeToken(join(e.configDir, "tokens", "owner"), "owner-token\n");
    writeConfig(e, {
      tokenFile: "tokens/claude",
      agents: {
        "wiki-keeper": { url: "https://agents.example.test/wiki-keeper/", tokenFile: "tokens/owner" },
      },
    });
    const result = run(e, ["wiki-keeper", "task", "list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(recorded(e).auth, "Bearer owner-token");
  });

  it("reads the config from XDG_CONFIG_HOME, or from FRACTION_AGENTS_CLIENT_CONFIG", () => {
    const e = setup();
    const xdg = join(e.home, "xdg");
    mkdirSync(join(xdg, "fraction-agents"), { recursive: true });
    writeToken(join(xdg, "fraction-agents", "token"));
    writeConfig(
      e,
      { tokenFile: "token", agents: { a: { url: "https://agents.example.test/a/" } } },
      join(xdg, "fraction-agents", "agents.json"),
    );
    assert.equal(run(e, ["a", "card", "get"], { XDG_CONFIG_HOME: xdg }).status, 0);
    assert.equal(recorded(e).agentCard, "https://agents.example.test/a/");

    const other = join(e.home, "elsewhere.json");
    writeConfig(e, { tokenFile: join(xdg, "fraction-agents", "token"), agents: { b: { url: "https://agents.example.test/b/" } } }, other);
    assert.equal(run(e, ["b", "card", "get"], { FRACTION_AGENTS_CLIENT_CONFIG: other }).status, 0);
    assert.equal(recorded(e).agentCard, "https://agents.example.test/b/");
  });

  it("lists the configured agents without reading or showing tokens", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["--list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /wiki-keeper\s+https:\/\/agents\.example\.test\/wiki-keeper\//);
    assert.match(result.stdout, /reviewer\s+https:\/\/agents\.example\.test\/reviewer\//);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!invoked(e));
  });

  it("refuses an unknown agent and names the known ones", () => {
    const e = setup();
    standard(e);
    const result = run(e, ["nobody", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nobody/);
    assert.match(result.stderr, /wiki-keeper/);
    assert.ok(!invoked(e));
  });

  it("refuses a token file that others can read, without showing the token", () => {
    const e = setup();
    standard(e);
    chmodSync(join(e.configDir, "tokens", "claude"), 0o644);
    const result = run(e, ["wiki-keeper", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /0600/);
    assert.ok(!result.stderr.includes(token));
    assert.ok(!result.stdout.includes(token));
    assert.ok(!invoked(e));
  });

  it("refuses a missing or empty token file", () => {
    const e = setup();
    standard(e);
    writeToken(join(e.configDir, "tokens", "claude"), "\n");
    let result = run(e, ["wiki-keeper", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /empty/);

    writeConfig(e, { tokenFile: "tokens/missing", agents: { a: { url: "https://agents.example.test/a/" } } });
    result = run(e, ["a", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tokens\/missing/);
    assert.ok(!invoked(e));
  });

  it("explains a missing or broken config", () => {
    const e = setup();
    let result = run(e, ["wiki-keeper", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /agents\.json/);

    writeConfig(e, { agents: { a: { url: "https://agents.example.test/a/" } } });
    result = run(e, ["a", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tokenFile/);

    writeToken(join(e.configDir, "tokens", "claude"));
    writeConfig(e, { tokenFile: "tokens/claude", agents: { a: { url: "not a url" } } });
    result = run(e, ["a", "send", "hello"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /url/);
    assert.ok(!invoked(e));
  });

  it("explains how to install a2a when it is not on PATH", () => {
    const e = setup({ withA2a: false });
    standard(e);
    const result = run(e, ["wiki-keeper", "send", "hello"]);
    assert.equal(result.status, 127);
    assert.match(result.stderr, /a2a/);
    assert.ok(!result.stderr.includes(token));
  });

  it("prints usage when called without an agent or a2a arguments", () => {
    const e = setup();
    standard(e);
    for (const args of [[], ["wiki-keeper"]]) {
      const result = run(e, args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /usage/i);
    }
    assert.ok(!invoked(e));
  });
});
