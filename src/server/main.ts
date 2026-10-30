/** Server entry point: `bun src/server/main.ts [config]` (defaults to ARCA_CONFIG or ./config.json). */
import { loadConfig } from "./config";
import { makeHandler } from "./http";
import { Service } from "./service";
import { VERSION_STRING } from "../version";

const path = process.argv[2] ?? process.env.ARCA_CONFIG ?? "config.json";
const cfg = await loadConfig(path);
const svc = new Service(cfg, (m) => console.log(`${new Date().toISOString()} ${m}`));

if (cfg.tokens.length === 0) console.warn("Warning: the config has no tokens — the API and MCP are inaccessible to everyone");

const server = Bun.serve({
  hostname: cfg.listen.host,
  port: cfg.listen.port,
  idleTimeout: 255, // MCP calls with wait can take a long time
  fetch: makeHandler(svc),
});
svc.startScheduler();
console.log(
  `Arca ${VERSION_STRING} listening on http://${cfg.listen.host}:${server.port} (sources: ${Object.keys(cfg.sources).length}, repositories: ${Object.keys(cfg.repos).length})`,
);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    console.log("Stopping…");
    server.stop();
    await svc.stop();
    process.exit(0);
  });
}
