import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { PullRequest } from "./github.ts";
import type { WriterConfig } from "./writer-config.ts";
import { WriterError, type GitHubWriter } from "./writer.ts";

/** The largest JSON body the sidecar reads (a pull request's title and body). */
const MAX_JSON_BYTES = 1024 * 1024;

const REPOSITORY_ROUTE = /^\/repos\/([^/]+)\/([^/]+)\/(sync|push|pulls)$/;

/**
 * The GitHub writer's HTTP API (ADR 0027). It listens inside the pod only; what it allows is the writer's settings,
 * not who calls. There is no route that merges, deletes or changes a repository's settings.
 *
 *   GET  /healthz
 *   POST /repos/<owner>/<name>/sync                bring the mirror up to date with GitHub
 *   POST /repos/<owner>/<name>/push?branch=<b>     body: a git bundle holding refs/heads/<b> only
 *   POST /repos/<owner>/<name>/pulls               body: {"branch", "title"?, "body"?}; opens or updates
 *   GET  /repos/<owner>/<name>/pulls?branch=<b>    the branch's latest pull request
 *
 * Answers are JSON; a refusal is `{"error": "<message>"}` with a 4xx, a failure on GitHub's side a 502.
 */
export function createWriterServer(
  writer: GitHubWriter,
  options: { config: WriterConfig; log?: (line: string) => void },
): Server {
  const log = options.log ?? ((line: string) => console.error(line));
  return createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    handle(writer, options.config, req, url)
      .then(({ status, body }) => {
        send(res, status, body);
        log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
      })
      .catch((error: unknown) => {
        const status = error instanceof WriterError ? error.status : 500;
        const message = error instanceof WriterError ? error.message : "Internal error.";
        send(res, status, { error: message });
        const detail = error instanceof Error ? error.message : String(error);
        log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms: ${detail.split("\n")[0]}`);
        req.resume();
      });
  });
}

async function handle(
  writer: GitHubWriter,
  config: WriterConfig,
  req: IncomingMessage,
  url: URL,
): Promise<{ status: number; body: unknown }> {
  if (url.pathname === "/healthz") {
    if (req.method !== "GET") throw new WriterError(405, "Method not allowed.");
    return { status: 200, body: { ok: true } };
  }
  const match = REPOSITORY_ROUTE.exec(url.pathname);
  if (!match) throw new WriterError(404, "Not found.");
  const [, owner = "", name = "", action] = match;
  const repository = writer.repository(decodeURIComponent(owner), decodeURIComponent(name));
  if (action === "sync") {
    if (req.method !== "POST") throw new WriterError(405, "Method not allowed.");
    return { status: 200, body: await writer.sync(repository) };
  }
  if (action === "push") {
    if (req.method !== "POST") throw new WriterError(405, "Method not allowed.");
    const branch = url.searchParams.get("branch") ?? "";
    if (branch === "") throw new WriterError(400, "Name the branch with ?branch=.");
    const bundle = await readBody(req, config.maxBundleBytes);
    return { status: 200, body: await writer.push(repository, branch, bundle) };
  }
  if (req.method === "GET") {
    const branch = url.searchParams.get("branch") ?? "";
    if (branch === "") throw new WriterError(400, "Name the branch with ?branch=.");
    const pull = await writer.latestPullRequest(repository, branch);
    if (!pull) throw new WriterError(404, `${branch} has no pull request.`);
    return { status: 200, body: { pull: summary(pull) } };
  }
  if (req.method !== "POST") throw new WriterError(405, "Method not allowed.");
  let input: unknown;
  try {
    input = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString("utf8"));
  } catch (error) {
    if (error instanceof WriterError) throw error;
    throw new WriterError(400, "The body must be JSON.");
  }
  const { branch, title, body } = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if (typeof branch !== "string" || branch === "") throw new WriterError(400, "branch must be a non-empty string.");
  if (title !== undefined && typeof title !== "string") throw new WriterError(400, "title must be a string.");
  if (body !== undefined && typeof body !== "string") throw new WriterError(400, "body must be a string.");
  const result = await writer.pullRequest(repository, {
    branch,
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
  });
  return { status: result.created ? 201 : 200, body: { created: result.created, pull: summary(result.pull) } };
}

function summary(pull: PullRequest) {
  return { number: pull.number, url: pull.url, state: pull.state, merged: pull.merged, title: pull.title, head: pull.head, base: pull.base };
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > limit) throw new WriterError(413, `The body is larger than ${limit} bytes.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new WriterError(413, `The body is larger than ${limit} bytes.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
