import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { authorizationUrl, authorize, createPkce, loadClientSecrets, writeCredentialsFile } from "../lib/gmail-oauth.ts";
import { CLIENT_ID, CLIENT_SECRET, FakeGoogle, READONLY, REFRESH_TOKEN } from "./fixtures/gmail.ts";

function clientFile(dir: string, kind = "installed"): string {
  const path = join(dir, "client_secret.json");
  writeFileSync(
    path,
    JSON.stringify({
      [kind]: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        redirect_uris: ["http://localhost"],
      },
    }),
  );
  return path;
}

describe("Gmail OAuth: the client", () => {
  it("takes a Desktop app client", () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-oauth-"));
    assert.deepEqual(loadClientSecrets(clientFile(dir)), { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  });

  it("refuses other kinds of client without echoing the secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-oauth-"));
    assert.throws(
      () => loadClientSecrets(clientFile(dir, "web")),
      (error: unknown) => error instanceof Error && /Desktop/.test(error.message) && !error.message.includes(CLIENT_SECRET),
    );
  });
});

describe("Gmail OAuth: the authorization request", () => {
  it("uses PKCE with S256", () => {
    const { verifier, challenge } = createPkce();
    assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
    assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
    assert.notEqual(createPkce().verifier, verifier);
  });

  it("asks for gmail.readonly only, offline, with state and a loopback redirect", () => {
    const url = new URL(
      authorizationUrl({ clientId: CLIENT_ID, redirectUri: "http://127.0.0.1:8765", state: "s1", challenge: "c1" }),
    );
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    assert.equal(p.get("scope"), READONLY);
    assert.equal(p.get("response_type"), "code");
    assert.equal(p.get("client_id"), CLIENT_ID);
    assert.equal(p.get("redirect_uri"), "http://127.0.0.1:8765");
    assert.equal(p.get("state"), "s1");
    assert.equal(p.get("code_challenge"), "c1");
    assert.equal(p.get("code_challenge_method"), "S256");
    assert.equal(p.get("access_type"), "offline");
    assert.equal(p.get("prompt"), "consent");
    assert.equal(p.get("include_granted_scopes"), null);
    assert.doesNotMatch(url.toString(), /oob/);
  });
});

describe("Gmail OAuth: the loopback flow", () => {
  const google = new FakeGoogle();
  before(() => google.start());
  after(() => google.stop());
  beforeEach(() => google.reset());

  /** Plays the browser and Google's consent screen: issues a code for the request and follows the redirect. */
  function consent(answer: (params: URLSearchParams) => Record<string, string>) {
    const pages: { status: number; body: string }[] = [];
    let host = "";
    const openUrl = async (url: string) => {
      const params = new URL(url).searchParams;
      const redirect = new URL(params.get("redirect_uri")!);
      host = redirect.hostname;
      const query = answer(params);
      if (query.code) google.codes.set(query.code, { challenge: params.get("code_challenge")!, redirectUri: params.get("redirect_uri")! });
      // A stray request first, as a browser makes for the icon.
      await fetch(new URL("/favicon.ico", redirect));
      const response = await fetch(`${redirect}?${new URLSearchParams(query)}`);
      pages.push({ status: response.status, body: await response.text() });
    };
    return { openUrl, pages, host: () => host };
  }

  function run(openUrl: (url: string) => Promise<void>) {
    return authorize({
      client: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      tokenUrl: `${google.base}/token`,
      openUrl,
      timeoutMs: 5000,
    });
  }

  it("listens on 127.0.0.1, checks the state, and exchanges the code with the PKCE verifier", async () => {
    const browser = consent((params) => ({ code: "code-1", state: params.get("state")!, scope: READONLY }));
    const credentials = await run(browser.openUrl);
    assert.equal(browser.host(), "127.0.0.1");
    assert.deepEqual(credentials, {
      type: "authorized_user",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      scope: READONLY,
    });
    assert.equal(browser.pages[0]!.status, 200);
    assert.doesNotMatch(browser.pages[0]!.body, new RegExp(REFRESH_TOKEN));
  });

  it("refuses an answer with another state, without exchanging the code", async () => {
    const browser = consent(() => ({ code: "code-1", state: "forged" }));
    await assert.rejects(run(browser.openUrl), /state/);
    assert.equal(google.tokensIssued, 0);
    assert.equal(browser.pages[0]!.status, 400);
  });

  it("reports the owner's refusal", async () => {
    const browser = consent((params) => ({ error: "access_denied", state: params.get("state")! }));
    await assert.rejects(run(browser.openUrl), /access_denied/);
  });

  it("refuses a grant with more than gmail.readonly", async () => {
    google.grantedScope = `${READONLY} https://www.googleapis.com/auth/gmail.modify`;
    const browser = consent((params) => ({ code: "code-1", state: params.get("state")! }));
    await assert.rejects(run(browser.openUrl), /scope/);
  });

  it("gives up when nobody answers in time", async () => {
    await assert.rejects(
      authorize({ client: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, tokenUrl: `${google.base}/token`, openUrl: () => {}, timeoutMs: 50 }),
      /time/,
    );
  });
});

describe("Gmail OAuth: the credentials file", () => {
  const credentials = {
    type: "authorized_user" as const,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    scope: READONLY,
  };

  it("is written readable by the owner only, and is not overwritten unless asked", () => {
    const dir = mkdtempSync(join(tmpdir(), "gmail-oauth-"));
    const path = join(dir, "token.json");
    writeCredentialsFile(path, { ...credentials, account: "owner@example.test" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).refresh_token, REFRESH_TOKEN);
    assert.throws(() => writeCredentialsFile(path, credentials), /exists/);
    writeCredentialsFile(path, { ...credentials, refresh_token: "newer" }, { force: true });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).refresh_token, "newer");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe("gmail-authorize command", () => {
  it("prints its usage without arguments", () => {
    const script = join(import.meta.dirname, "..", "bin", "gmail-authorize.ts");
    assert.throws(
      () => execFileSync(process.execPath, [script], { stdio: "pipe" }),
      (error: { status?: number; stderr?: Buffer }) => error.status === 2 && /--client/.test(String(error.stderr)),
    );
  });
});
