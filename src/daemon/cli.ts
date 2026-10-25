#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readPluginConfig } from "../shared/config.js";
import { DAEMON_PORT } from "../shared/schema.js";
import { startDaemonServer } from "./main.js";
import { installShutdownHandlers, shutdownTimeoutFromEnv } from "./shutdown.js";

type CliOptions = {
  host?: string;
  port: number;
  dataDir?: string;
  configPath?: string;
};

function parseArgs(argv: string[]): {
  command: "start" | "status" | "stop";
  options: CliOptions;
} {
  const [commandRaw, ...rest] = argv;
  const command =
    commandRaw === "status" || commandRaw === "stop" ? commandRaw : ("start" as const);
  const options: CliOptions = {
    port: DAEMON_PORT
  };
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    const next = rest[index + 1];
    if ((current === "--port" || current === "-p") && next != null) {
      options.port = Number(next);
      index += 1;
      continue;
    }
    if ((current === "--host" || current === "-h") && next != null) {
      options.host = next;
      index += 1;
      continue;
    }
    if (current === "--data-dir" && next != null) {
      options.dataDir = resolve(next);
      index += 1;
      continue;
    }
    if (current === "--config" && next != null) {
      options.configPath = resolve(next);
      index += 1;
    }
  }
  return { command, options };
}

async function loadConfig(path: string | undefined): Promise<unknown> {
  if (path == null) {
    return {};
  }
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const baseUrl = `http://${parsed.options.host ?? "127.0.0.1"}:${parsed.options.port}`;

  if (parsed.command === "status") {
    const response = await fetch(new URL("/health", baseUrl));
    console.log(await response.text());
    return;
  }
  if (parsed.command === "stop") {
    // POST /shutdown is auth-protected when the daemon runs with a
    // daemonAuthToken, so read the configured token (same --config file the
    // daemon was started with) and send it as a bearer header.
    const config = readPluginConfig(await loadConfig(parsed.options.configPath));
    const authToken = config.daemonAuthToken?.trim() ?? "";
    const response = await fetch(new URL("/shutdown", baseUrl), {
      method: "POST",
      ...(authToken.length > 0
        ? { headers: { authorization: `Bearer ${authToken}` } }
        : {})
    });
    console.log(await response.text());
    return;
  }

  const config = await loadConfig(parsed.options.configPath);
  const daemon = await startDaemonServer({
    ...(parsed.options.host != null ? { host: parsed.options.host } : {}),
    port: parsed.options.port,
    ...(parsed.options.dataDir != null ? { dataDir: parsed.options.dataDir } : {}),
    ...(config != null ? { config } : {})
  });
  installShutdownHandlers({
    close: daemon.close,
    timeoutMs: shutdownTimeoutFromEnv()
  });
  const entryDir = dirname(fileURLToPath(import.meta.url));
  console.log(
    `Orchestrator daemon listening on ${baseUrl} (entry: ${join(entryDir, "main.js")})`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
