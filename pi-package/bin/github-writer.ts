// The GitHub writer sidecar (ADR 0027): the one container of the pod with the GitHub App's key.
//
//   node github-writer.ts --config <github-writer.json>
//
// It listens on 127.0.0.1 at the settings' port, brings the mirrors up to date at start and then every
// syncIntervalSeconds, and stops on SIGTERM.
import { GitHubApp } from "../lib/github.ts";
import { loadWriterConfig } from "../lib/writer-config.ts";
import { createWriterServer } from "../lib/writer-server.ts";
import { GitHubWriter } from "../lib/writer.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--config");
const path = at >= 0 ? args[at + 1] : undefined;
if (!path) {
  process.stderr.write("usage: github-writer.ts --config <github-writer.json>\n");
  process.exit(2);
}
const config = loadWriterConfig(path);
const writer = new GitHubWriter({
  config,
  github: (repository) => new GitHubApp({ apiUrl: config.apiUrl, app: config.app, repository }),
});
const server = createWriterServer(writer, { config });
server.listen(config.port, "127.0.0.1", () => {
  console.error(`github-writer: listening on 127.0.0.1:${config.port} for ${config.repositories.map((r) => `${r.owner}/${r.name}`).join(", ")}`);
});
let syncing = writer.syncAll();
const timer = setInterval(() => {
  syncing = syncing.then(() => writer.syncAll());
}, config.syncIntervalSeconds * 1000);
process.on("SIGTERM", () => {
  clearInterval(timer);
  server.close(() => process.exit(0));
});
