import { join } from "node:path";

import { PLUGIN_ID } from "../shared/schema.js";
import { ensureDir } from "../shared/utils.js";
import { readPluginConfig } from "../shared/config.js";
import { createDaemonServer } from "./server.js";

/**
 * After close() starts, in-flight requests get this long to finish before
 * their connections are destroyed. Long SSE turns would otherwise keep the
 * server (and the store owner lease) open until the turn ends.
 */
export const DEFAULT_CONNECTION_GRACE_MS = 2_000;

export async function startDaemonServer(params: {
  host?: string;
  port: number;
  dataDir?: string;
  config?: unknown;
  connectionGraceMs?: number;
}): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const config = readPluginConfig(params.config ?? {});
  const dataDir = params.dataDir ?? join(process.cwd(), ".puppenclaw-daemon", PLUGIN_ID);
  await ensureDir(dataDir);
  const { app } = await createDaemonServer({
    config,
    dataDir
  });
  const url = await app.listen({
    host: params.host ?? "127.0.0.1",
    port: params.port
  });
  let closing: Promise<void> | null = null;
  return {
    url,
    close: async () => {
      closing ??= (async () => {
        const closed = app.close();
        const force = setTimeout(() => {
          app.server.closeAllConnections();
        }, params.connectionGraceMs ?? DEFAULT_CONNECTION_GRACE_MS);
        force.unref();
        try {
          await closed;
        } finally {
          clearTimeout(force);
        }
      })();
      await closing;
    }
  };
}
