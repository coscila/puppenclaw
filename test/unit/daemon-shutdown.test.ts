import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemonServer } from "../../src/daemon/main.js";
import {
  installShutdownHandlers,
  shutdownTimeoutFromEnv,
  type ShutdownTarget
} from "../../src/daemon/shutdown.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");

class FakeProcess extends EventEmitter implements ShutdownTarget {
  readonly exits: number[] = [];

  exit(code: number): void {
    this.exits.push(code);
  }
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false
  );
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address == null || typeof address === "string") {
          reject(new Error("no port"));
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return await check();
}

function killRecordedTurnGroup(state: string): void {
  const parsed = JSON.parse(state) as {
    sessions: Record<string, { activeTurn?: { processGroupId?: number; pid?: number } }>;
  };
  for (const session of Object.values(parsed.sessions)) {
    const group = session.activeTurn?.processGroupId ?? session.activeTurn?.pid;
    if (group != null) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

describe("daemon shutdown signals", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes on the first SIGTERM or SIGINT and exits cleanly", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const target = new FakeProcess();
      const close = vi.fn(async () => undefined);
      const handlers = installShutdownHandlers({ close, target, log: () => undefined });
      target.emit(signal);
      expect(handlers.isShuttingDown()).toBe(true);
      await vi.waitFor(() => expect(target.exits).toEqual([0]));
      expect(close).toHaveBeenCalledOnce();
      handlers.uninstall();
      expect(target.listenerCount("SIGTERM") + target.listenerCount("SIGINT")).toBe(0);
    }
  });

  it("forces exit on a second signal, a failed close or a close past the timeout", async () => {
    const pending = new FakeProcess();
    installShutdownHandlers({
      close: () => new Promise<void>(() => undefined),
      target: pending,
      log: () => undefined
    });
    pending.emit("SIGTERM");
    pending.emit("SIGINT");
    expect(pending.exits).toEqual([1]);

    const failing = new FakeProcess();
    installShutdownHandlers({
      close: async () => {
        throw new Error("store busy");
      },
      target: failing,
      log: () => undefined
    });
    failing.emit("SIGTERM");
    await vi.waitFor(() => expect(failing.exits).toEqual([1]));

    vi.useFakeTimers();
    const slow = new FakeProcess();
    installShutdownHandlers({
      close: () => new Promise<void>(() => undefined),
      target: slow,
      timeoutMs: 5_000,
      log: () => undefined
    });
    slow.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(slow.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(slow.exits).toEqual([1]);
  });

  it("reads the shutdown timeout from the environment with a floor", () => {
    expect(shutdownTimeoutFromEnv({})).toBe(20_000);
    expect(shutdownTimeoutFromEnv({ PUPPENCLAW_SHUTDOWN_TIMEOUT_MS: "45000" })).toBe(45_000);
    expect(shutdownTimeoutFromEnv({ PUPPENCLAW_SHUTDOWN_TIMEOUT_MS: "10" })).toBe(1_000);
    expect(shutdownTimeoutFromEnv({ PUPPENCLAW_SHUTDOWN_TIMEOUT_MS: "soon" })).toBe(20_000);
  });

  it.runIf(process.platform === "linux")(
    "close() ends an in-flight SSE turn after the grace period and releases the owner lease",
    async () => {
      const dataDir = await createTempDir("puppenclaw-shutdown-sse-");
      const workspace = await createTempDir("puppenclaw-shutdown-workspace-");
      const daemon = await startDaemonServer({
        port: 0,
        dataDir,
        connectionGraceMs: 200,
        config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand() })
      });
      const url = new URL("/session/start/stream", daemon.url);
      const streamEnded = new Promise<void>((resolveStream) => {
        const req = request(
          url,
          { method: "POST", headers: { "content-type": "application/json" } },
          (res) => {
            res.resume();
            res.once("close", () => resolveStream());
          }
        );
        req.once("error", () => resolveStream());
        req.end(
          JSON.stringify({
            agent: "claude",
            name: "shutdown-sse",
            directory: workspace,
            task: "SLOW_TURN keep the stream open"
          })
        );
      });
      const marker = join(workspace, ".fake-acpx-state", "shutdown-sse.slow");
      expect(await waitFor(() => exists(marker), 10_000)).toBe(true);
      expect(await exists(join(dataDir, ".state-owner.json"))).toBe(true);

      const startedAt = Date.now();
      await daemon.close();
      const elapsedMs = Date.now() - startedAt;
      await streamEnded;
      const state = await readFile(join(dataDir, "state.json"), "utf8");
      killRecordedTurnGroup(state);

      expect(elapsedMs).toBeLessThan(5_000);
      expect(await exists(join(dataDir, ".state-owner.json"))).toBe(false);
    },
    20_000
  );

  it.runIf(process.platform === "linux")(
    "the daemon CLI exits 0 on SIGTERM after closing its stores",
    async () => {
      const outDir = await createTempDir("puppenclaw-shutdown-cli-");
      const cliPath = join(outDir, "cli.mjs");
      await build({
        entryPoints: [join(repoRoot, "src", "daemon", "cli.ts")],
        outfile: cliPath,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        external: ["openclaw"],
        banner: {
          js: "import { createRequire as __pcCreateRequire } from 'node:module'; const require = __pcCreateRequire(import.meta.url);"
        },
        logLevel: "silent"
      });
      const dataDir = await createTempDir("puppenclaw-shutdown-cli-data-");
      const configPath = join(outDir, "config.json");
      await writeFile(configPath, JSON.stringify({ daemonAuthToken: "cli-shutdown-token" }), "utf8");
      const port = await freePort();
      const child = spawn(
        process.execPath,
        [cliPath, "start", "--port", String(port), "--data-dir", dataDir, "--config", configPath],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveExit) => {
          child.once("exit", (code, signal) => resolveExit({ code, signal }));
        }
      );
      try {
        const healthy = await waitFor(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
          return response?.ok === true;
        }, 15_000);
        expect(healthy, output).toBe(true);
        expect(await exists(join(dataDir, ".state-owner.json"))).toBe(true);

        child.kill("SIGTERM");
        const result = await Promise.race([
          exited,
          new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 10_000))
        ]);
        expect(result, output).toEqual({ code: 0, signal: null });
        expect(output).toContain("Received SIGTERM; closing the daemon");
        expect(await exists(join(dataDir, ".state-owner.json"))).toBe(false);
      } finally {
        if (child.exitCode == null && child.signalCode == null) {
          child.kill("SIGKILL");
        }
      }
    },
    40_000
  );
});
