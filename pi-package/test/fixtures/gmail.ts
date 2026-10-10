// A stand-in for Google in the Gmail tests: the OAuth token endpoint (refresh tokens and authorization codes) and the
// parts of the Gmail API the tools use. Everything here is made up; no real mail or account goes into this public
// repository.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export const ACCOUNT = "owner@example.test";
export const CLIENT_ID = "1234567890-fake.apps.googleusercontent.example.test";
export const CLIENT_SECRET = "fake-client-secret";
export const REFRESH_TOKEN = "fake-refresh-token";
export const ACCESS_TOKEN = "fake-access-token";
export const READONLY = "https://www.googleapis.com/auth/gmail.readonly";

export interface FakePart {
  partId?: string;
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: FakePart[];
}

export interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: string;
  snippet: string;
  payload: FakePart;
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A failure the next matching request gets instead of the answer. */
export interface Failure {
  /** Only requests whose path matches. */
  path: RegExp;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Writes made-up credentials as the authorization command does, and returns the path. */
export function writeCredentials(dir: string, overrides: Record<string, unknown> = {}): string {
  const path = join(dir, "token.json");
  writeFileSync(
    path,
    JSON.stringify({ type: "authorized_user", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN, scope: READONLY, ...overrides }),
    { mode: 0o600 },
  );
  return path;
}

/** Base64url of the bytes, as Gmail puts a body in `body.data`. */
export function b64(content: string | Buffer): string {
  return (typeof content === "string" ? Buffer.from(content, "utf8") : content).toString("base64url");
}

export function textPart(text: string, mimeType = "text/plain", charset = "utf-8"): FakePart {
  const data = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  return {
    mimeType,
    headers: [{ name: "Content-Type", value: `${mimeType}; charset="${charset}"` }],
    body: { size: data.length, data: b64(data) },
  };
}

export function bytesPart(bytes: Buffer, mimeType: string, charset: string): FakePart {
  return {
    mimeType,
    headers: [{ name: "Content-Type", value: `${mimeType}; charset=${charset}` }],
    body: { size: bytes.length, data: b64(bytes) },
  };
}

export function attachmentPart(filename: string, mimeType: string, attachmentId: string, size: number): FakePart {
  return {
    mimeType,
    filename,
    headers: [
      { name: "Content-Type", value: `${mimeType}; name="${filename}"` },
      { name: "Content-Disposition", value: `attachment; filename="${filename}"` },
    ],
    body: { size, attachmentId },
  };
}

export function multipart(mimeType: string, parts: FakePart[]): FakePart {
  return { mimeType, headers: [{ name: "Content-Type", value: `${mimeType}; boundary="b"` }], body: { size: 0 }, parts };
}

/** Numbers the parts as Gmail does: "" for the top, then "0", "1", and "1.0" inside "1". */
function numberParts(part: FakePart, id: string): FakePart {
  return {
    ...part,
    partId: id,
    ...(part.parts ? { parts: part.parts.map((child, i) => numberParts(child, id === "" ? String(i) : `${id}.${i}`)) } : {}),
  };
}

/** A message with the usual headers around a payload. */
export function message(
  id: string,
  receivedAt: string,
  options: { from?: string; subject?: string; labels?: string[]; payload?: FakePart; threadId?: string } = {},
): FakeMessage {
  const payload = numberParts(options.payload ?? textPart(`Body of ${id}.`), "");
  const headers = [
    { name: "From", value: options.from ?? "Sender <sender@example.test>" },
    { name: "To", value: ACCOUNT },
    { name: "Subject", value: options.subject ?? `Subject ${id}` },
    { name: "Date", value: new Date(receivedAt).toUTCString() },
    ...(payload.headers ?? []),
  ];
  return {
    id,
    threadId: options.threadId ?? `t-${id}`,
    labelIds: options.labels ?? ["INBOX"],
    internalDate: String(Date.parse(receivedAt)),
    snippet: `Snippet of ${id}`,
    payload: { ...payload, headers },
  };
}

export class FakeGoogle {
  server!: Server;
  base = "";
  requests: RecordedRequest[] = [];
  messages = new Map<string, FakeMessage>();
  attachments = new Map<string, Buffer>();
  failures: Failure[] = [];
  /** The scope the token endpoint reports. */
  grantedScope = READONLY;
  refreshTokenValid = true;
  tokensIssued = 0;
  /** The authorization codes the token endpoint accepts, with the PKCE challenge they were issued for. */
  codes = new Map<string, { challenge: string; redirectUri: string }>();
  /** Page tokens the list endpoint refuses, once each. */
  expiredPageTokens = new Set<string>();

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://google.test");
        this.requests.push({ method: req.method ?? "GET", url, headers: req.headers, body });
        const failure = this.failures.findIndex((f) => f.path.test(url.pathname));
        if (failure >= 0) {
          const [f] = this.failures.splice(failure, 1);
          res.writeHead(f!.status, { "content-type": "application/json", ...(f!.headers ?? {}) });
          res.end(JSON.stringify(f!.body ?? { error: { code: f!.status, message: `fake failure ${f!.status}` } }));
          return;
        }
        const [status, payload] = this.route(req.method ?? "GET", url, req.headers, body);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload === undefined ? "" : JSON.stringify(payload));
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.requests = [];
    this.messages = new Map();
    this.attachments = new Map();
    this.failures = [];
    this.grantedScope = READONLY;
    this.refreshTokenValid = true;
    this.tokensIssued = 0;
    this.codes = new Map();
    this.expiredPageTokens = new Set();
  }

  add(...messages: FakeMessage[]): void {
    for (const m of messages) this.messages.set(m.id, m);
  }

  fail(path: RegExp, status: number, headers?: Record<string, string>, body?: unknown): void {
    this.failures.push({ path, status, ...(headers ? { headers } : {}), ...(body ? { body } : {}) });
  }

  apiRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url.pathname.startsWith("/gmail/"));
  }

  private route(method: string, url: URL, headers: IncomingMessage["headers"], body: string): [number, unknown] {
    if (url.pathname === "/token") return this.token(method, body);
    if (headers.authorization !== `Bearer ${ACCESS_TOKEN}`) return [401, { error: { code: 401, message: "Invalid Credentials" } }];
    if (method !== "GET") return [405, { error: { code: 405, message: "read only" } }];
    const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
    if (path === "/profile") return [200, { emailAddress: ACCOUNT, messagesTotal: this.messages.size }];
    if (path === "/messages") return this.list(url);
    const attachment = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (attachment) {
      const data = this.attachments.get(`${attachment[1]}/${attachment[2]}`);
      if (!data) return [404, { error: { code: 404, message: "Not Found" } }];
      return [200, { size: data.length, data: b64(data) }];
    }
    const single = /^\/messages\/([^/]+)$/.exec(path);
    if (single) {
      const found = this.messages.get(decodeURIComponent(single[1]!));
      if (!found) return [404, { error: { code: 404, message: "Requested entity was not found." } }];
      if (url.searchParams.get("format") === "metadata") {
        const wanted = url.searchParams.getAll("metadataHeaders").map((h) => h.toLowerCase());
        const kept = (found.payload.headers ?? []).filter((h) => wanted.length === 0 || wanted.includes(h.name.toLowerCase()));
        return [200, { ...found, payload: { mimeType: found.payload.mimeType, headers: kept } }];
      }
      return [200, found];
    }
    return [404, { error: { code: 404, message: "Not Found" } }];
  }

  /** messages.list: newest first, with the parts of the query the tools use. */
  private list(url: URL): [number, unknown] {
    const q = url.searchParams.get("q") ?? "";
    const pageToken = url.searchParams.get("pageToken");
    if (pageToken && this.expiredPageTokens.delete(pageToken)) return [400, { error: { code: 400, message: "Invalid pageToken" } }];
    const max = Number(url.searchParams.get("maxResults") ?? "100");
    const after = /(?:^|\s)after:(\d+)/.exec(q);
    const before = /(?:^|\s)before:(\d+)/.exec(q);
    const includeSpamTrash = url.searchParams.get("includeSpamTrash") === "true";
    const excluded = [...q.matchAll(/-in:(\w+)/g)].map((m) => m[1]!.toUpperCase());
    const words = q
      .split(/\s+/)
      .filter((w) => w && !/^(-?in:|after:|before:)/.test(w))
      .map((w) => w.toLowerCase());
    const all = [...this.messages.values()]
      .filter((m) => {
        const seconds = Number(m.internalDate) / 1000;
        if (after && seconds < Number(after[1])) return false;
        if (before && seconds >= Number(before[1])) return false;
        if (!includeSpamTrash && (m.labelIds.includes("SPAM") || m.labelIds.includes("TRASH"))) return false;
        for (const label of excluded) {
          const name = label === "DRAFTS" ? "DRAFT" : label;
          if (m.labelIds.includes(name)) return false;
        }
        const subject = (m.payload.headers ?? []).find((h) => h.name === "Subject")?.value.toLowerCase() ?? "";
        return words.every((w) => subject.includes(w) || m.snippet.toLowerCase().includes(w));
      })
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
    const start = pageToken ? Number(pageToken.replace(/^p/, "")) : 0;
    const page = all.slice(start, start + max);
    const next = start + max < all.length ? `p${start + max}` : undefined;
    return [
      200,
      {
        ...(page.length > 0 ? { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}),
        ...(next ? { nextPageToken: next } : {}),
        resultSizeEstimate: all.length,
      },
    ];
  }

  private token(method: string, body: string): [number, unknown] {
    const form = new URLSearchParams(body);
    if (method !== "POST") return [405, { error: "invalid_request" }];
    if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) return [401, { error: "invalid_client" }];
    if (form.get("grant_type") === "refresh_token") {
      if (!this.refreshTokenValid || form.get("refresh_token") !== REFRESH_TOKEN) {
        return [400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }];
      }
      this.tokensIssued += 1;
      return [200, { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3599, scope: this.grantedScope }];
    }
    if (form.get("grant_type") === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      if (!code) return [400, { error: "invalid_grant" }];
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (challenge !== code.challenge) return [400, { error: "invalid_grant", error_description: "code_verifier mismatch" }];
      if (form.get("redirect_uri") !== code.redirectUri) return [400, { error: "redirect_uri_mismatch" }];
      this.tokensIssued += 1;
      return [
        200,
        { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, token_type: "Bearer", expires_in: 3599, scope: this.grantedScope },
      ];
    }
    return [400, { error: "unsupported_grant_type" }];
  }
}
