// The owner's authorization of the Gmail Agent (ADR 0016), run by the owner on a machine with a browser:
//
//   node gmail-authorize.ts --client <client_secret.json> --out <token.json> [--port <port>] [--force]
//
// It prints a URL to open in the browser, takes Google's answer on 127.0.0.1, and writes the credentials
// (the OAuth client and the refresh token, gmail.readonly only) to --out, readable by the owner only. The token is
// never printed. The file then goes into the agent's Secret; see agents/gmail-agent/README.md.
import { parseArgs } from "node:util";

import { GmailClient } from "../lib/gmail.ts";
import { authorize, loadClientSecrets, writeCredentialsFile } from "../lib/gmail-oauth.ts";

const USAGE = "usage: node gmail-authorize.ts --client <client_secret.json> --out <token.json> [--port <port>] [--force]\n";

let values: { client?: string; out?: string; port?: string; force?: boolean };
try {
  ({ values } = parseArgs({
    options: { client: { type: "string" }, out: { type: "string" }, port: { type: "string" }, force: { type: "boolean" } },
  }));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  process.exit(2);
}
if (!values.client || !values.out) {
  process.stderr.write(USAGE);
  process.exit(2);
}
const port = values.port === undefined ? 0 : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`--port must be a port number\n${USAGE}`);
  process.exit(2);
}

try {
  const client = loadClientSecrets(values.client);
  const credentials = await authorize({
    client,
    port,
    openUrl: (url) => {
      process.stderr.write(`Open this URL in a browser on this machine (or one forwarded to its port) and allow read-only access to Gmail:\n\n${url}\n\n`);
    },
  });
  writeCredentialsFile(values.out, credentials, { force: values.force ?? false });
  // Reads the profile with the new credentials: the token works, and this is the account it reads.
  const account = await new GmailClient(values.out).account();
  process.stderr.write(
    [
      `Authorized read-only access to ${account}. The credentials are in ${values.out} (mode 0600).`,
      "Put them into the agent's Secret, then delete the local file:",
      `  kubectl create secret generic gmail-agent-google -n <namespace> --from-file=token.json=${values.out}`,
      "",
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(`gmail-authorize: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
