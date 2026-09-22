import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

import type { GateConfig } from "./config.ts";

export interface PullRequest {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  title: string;
  body: string;
  head: string;
  base: string;
}

/**
 * What the gate needs from GitHub. The real one is {@link GitHubApp}; tests use a fake. Nothing here hands the
 * token itself out: git gets an Authorization header value for one command, the REST calls use it internally.
 */
export interface GitHubClient {
  /** The `Authorization` header value git sends to the remote. */
  gitAuthorization(): Promise<string>;
  /** The open pull request from the branch, if any. */
  findPullRequest(head: string): Promise<PullRequest | undefined>;
  getPullRequest(number: number): Promise<PullRequest>;
  createPullRequest(input: { title: string; body: string; head: string; base: string }): Promise<PullRequest>;
  updatePullRequest(number: number, input: { title?: string; body?: string }): Promise<PullRequest>;
  /** Merges only if the pull request's head is still `sha`. */
  mergePullRequest(number: number, input: { sha: string; method: string }): Promise<{ merged: boolean; message: string }>;
}

/** Refresh the installation token when less than this is left of its hour. */
const TOKEN_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

interface RawPull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  title: string;
  body: string | null;
  head: { ref: string };
  base: { ref: string };
}

/**
 * GitHub as a GitHub App installation (ADR 0009). The App's private key signs a JWT, which buys an installation
 * token for the one repository, limited to contents and pull requests. The token lives only in this object's
 * memory, in the pi process: never in the environment, a file or git's config.
 */
export class GitHubApp implements GitHubClient {
  readonly #config: GateConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #token: { value: string; expiresAt: number } | undefined;

  constructor(config: GateConfig, options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async gitAuthorization(): Promise<string> {
    return `Basic ${Buffer.from(`x-access-token:${await this.#installationToken()}`).toString("base64")}`;
  }

  async findPullRequest(head: string): Promise<PullRequest | undefined> {
    const { owner } = this.#config.repository;
    const query = new URLSearchParams({ head: `${owner}:${head}`, state: "open" });
    const pulls = (await this.#api("GET", `${this.#repoPath()}/pulls?${query}`)) as RawPull[];
    return pulls[0] ? pull(pulls[0]) : undefined;
  }

  async getPullRequest(number: number): Promise<PullRequest> {
    return pull((await this.#api("GET", `${this.#repoPath()}/pulls/${number}`)) as RawPull);
  }

  async createPullRequest(input: { title: string; body: string; head: string; base: string }): Promise<PullRequest> {
    return pull((await this.#api("POST", `${this.#repoPath()}/pulls`, input)) as RawPull);
  }

  async updatePullRequest(number: number, input: { title?: string; body?: string }): Promise<PullRequest> {
    return pull((await this.#api("PATCH", `${this.#repoPath()}/pulls/${number}`, input)) as RawPull);
  }

  async mergePullRequest(number: number, input: { sha: string; method: string }): Promise<{ merged: boolean; message: string }> {
    const response = await this.#request("PUT", `${this.#repoPath()}/pulls/${number}/merge`, {
      sha: input.sha,
      merge_method: input.method,
    });
    const body = (await response.json().catch(() => ({}))) as { merged?: boolean; message?: string };
    if (response.ok) return { merged: body.merged === true, message: body.message ?? "" };
    // 405: not mergeable, 409: head moved. Both are answers, not failures of the call.
    if (response.status === 405 || response.status === 409) return { merged: false, message: body.message ?? `HTTP ${response.status}` };
    throw new Error(`GitHub refused the merge: HTTP ${response.status}${body.message ? ` ${body.message}` : ""}`);
  }

  #repoPath(): string {
    const { owner, name } = this.#config.repository;
    return `/repos/${owner}/${name}`;
  }

  async #api(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.#request(method, path, body);
    const text = await response.text();
    if (!response.ok) {
      let message = "";
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? "";
      } catch {
        // Not JSON; the status says enough.
      }
      throw new Error(`GitHub ${method} ${path.split("?")[0]} failed: HTTP ${response.status}${message ? ` ${message}` : ""}`);
    }
    return text === "" ? undefined : JSON.parse(text);
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    return this.#fetch(`${this.#config.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.#installationToken()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async #installationToken(): Promise<string> {
    if (this.#token && this.#token.expiresAt - TOKEN_MARGIN_MS > this.#now()) return this.#token.value;
    const { app, repository } = this.#config;
    const response = await this.#fetch(`${this.#config.apiUrl}/app/installations/${app.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#jwt()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ repositories: [repository.name], permissions: { contents: "write", pull_requests: "write" } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub did not issue an installation token: HTTP ${response.status}`);
    const issued = (await response.json()) as { token: string; expires_at: string };
    this.#token = { value: issued.token, expiresAt: Date.parse(issued.expires_at) };
    return issued.token;
  }

  /** A JWT for the App, signed with its private key, valid for nine minutes (GitHub allows ten). */
  #jwt(): string {
    const now = Math.floor(this.#now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.#config.app.appId })}`;
    const key = readFileSync(this.#config.app.privateKeyFile, "utf8");
    const signature = createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url");
    return `${unsigned}.${signature}`;
  }
}

function pull(raw: RawPull): PullRequest {
  return {
    number: raw.number,
    url: raw.html_url,
    state: raw.state,
    merged: raw.merged === true || (raw.merged_at !== undefined && raw.merged_at !== null),
    title: raw.title,
    body: raw.body ?? "",
    head: raw.head.ref,
    base: raw.base.ref,
  };
}
