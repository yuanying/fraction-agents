// The owner's first authorization of the Gmail Agent (ADR 0016): OAuth 2.0 for a Desktop app client, with the
// answer coming back to a loopback address on the owner's machine, a state value against forged answers, and PKCE
// (S256) so that the code is useless to anyone who sees it. Only gmail.readonly is asked for and accepted. The
// out-of-band flow is not used (Google has stopped it).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import { GMAIL_SCOPE, GOOGLE_TOKEN_URL, isReadonlyScope, type StoredCredentials } from "./gmail.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export interface ClientSecrets {
  clientId: string;
  clientSecret: string;
}

/** The OAuth client as Google Cloud's console downloads it. Only a Desktop app client ("installed") is taken. */
export function loadClientSecrets(path: string): ClientSecrets {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof SyntaxError ? "not JSON" : error instanceof Error && "code" in error ? String(error.code) : "unreadable";
    throw new Error(`The OAuth client (${path}) cannot be read: ${reason}`);
  }
  const root = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const installed = root.installed as Record<string, unknown> | undefined;
  if (!installed || typeof installed !== "object") {
    throw new Error(`The OAuth client (${path}) is not a Desktop app client. Create one of the type "Desktop app" in Google Cloud.`);
  }
  if (typeof installed.client_id !== "string" || typeof installed.client_secret !== "string") {
    throw new Error(`The OAuth client (${path}) has no client_id or client_secret`);
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

/** A PKCE verifier (64 unreserved characters) and its S256 challenge. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizationUrl(options: { clientId: string; redirectUri: string; state: string; challenge: string; authUrl?: string }): string {
  const url = new URL(options.authUrl ?? GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    // A refresh token, and asked again each time so that a new one is always issued.
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return url.toString();
}

export interface AuthorizeOptions {
  client: ClientSecrets;
  /** The loopback port. 0 picks a free one; give one to forward it over SSH. */
  port?: number;
  authUrl?: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
  /** Shows the owner the URL to open in a browser on this machine (or one that reaches the port). */
  openUrl(url: string): void | Promise<void>;
  /** How long to wait for the browser's answer. */
  timeoutMs?: number;
}

const PAGE_OK = "The Gmail Agent is authorized. You can close this tab and go back to the terminal.";

/**
 * Runs the flow: listens on 127.0.0.1, has the owner open Google's consent page, takes the answer, checks its
 * state, and exchanges the code (with the PKCE verifier) for a refresh token. Refuses a grant beyond gmail.readonly.
 */
export async function authorize(options: AuthorizeOptions): Promise<StoredCredentials> {
  const state = randomBytes(24).toString("base64url");
  const pkce = createPkce();
  const fetchFn = options.fetch ?? fetch;
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const answer = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  let answered = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, text: string) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end(text);
    };
    if (url.pathname !== "/" || !url.searchParams.has("state") || answered) return reply(404, "Not found");
    answered = true;
    const given = Buffer.from(url.searchParams.get("state") ?? "");
    const expected = Buffer.from(state);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      reply(400, "The answer does not match the request (state). Nothing was authorized.");
      return settle.reject(new Error("The browser's answer has another state, so it was refused (it may be forged). Nothing was authorized."));
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      reply(400, `Google did not authorize: ${error ?? "no code"}.`);
      return settle.reject(new Error(`Google did not authorize: ${error ?? "no code in the answer"}`));
    }
    reply(200, PAGE_OK);
    settle.resolve(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const timer = setTimeout(() => settle.reject(new Error("No answer came from the browser in time.")), options.timeoutMs ?? 5 * 60_000);
  const opened = Promise.resolve().then(() =>
    options.openUrl(authorizationUrl({ clientId: options.client.clientId, redirectUri, state, challenge: pkce.challenge, ...(options.authUrl ? { authUrl: options.authUrl } : {}) })),
  );
  opened.catch((error: unknown) => settle.reject(error instanceof Error ? error : new Error(String(error))));
  try {
    const code = await answer;
    const response = await fetchFn(options.tokenUrl ?? GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: pkce.verifier,
        client_id: options.client.clientId,
        client_secret: options.client.clientSecret,
        redirect_uri: redirectUri,
      }),
      redirect: "error",
    });
    const body = (await response.json().catch(() => ({}))) as { refresh_token?: unknown; scope?: unknown; error?: unknown };
    if (!response.ok) throw new Error(`Google refused the code: HTTP ${response.status}${typeof body.error === "string" ? ` ${body.error}` : ""}`);
    const scope = typeof body.scope === "string" ? body.scope : "";
    if (!isReadonlyScope(scope)) {
      throw new Error(
        `Google granted the scope "${scope}", not gmail.readonly alone, so nothing is saved. Remove the app's access in the Google Account (Security > Third-party access) and run again.`,
      );
    }
    if (typeof body.refresh_token !== "string" || body.refresh_token === "") {
      throw new Error("Google returned no refresh token. Remove the app's access in the Google Account and run again.");
    }
    return {
      type: "authorized_user",
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      refresh_token: body.refresh_token,
      scope,
    };
  } finally {
    clearTimeout(timer);
    await opened.catch(() => {});
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

/** Writes the credentials readable by the owner only (0600), whole or not at all. An existing file is kept unless forced. */
export function writeCredentialsFile(path: string, credentials: StoredCredentials, options: { force?: boolean } = {}): void {
  if (existsSync(path) && !options.force) throw new Error(`${path} exists. Pass --force to replace it.`);
  const temporary = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(credentials, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Already moved or never made.
    }
    throw error;
  }
}
