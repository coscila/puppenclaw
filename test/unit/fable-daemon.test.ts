import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDaemonServer } from "../../src/daemon/server.js";
import { createTempDir, makeConfig, resolveFakeAcpxCommand } from "../helpers.js";

describe("hermetic Fable daemon HTTP smoke", () => {
  it("authenticates isolated requests and carries all native presets through the runner", async () => {
    const root = await createTempDir("puppenclaw-fable-http-");
    const token = randomBytes(32).toString("base64url");
    const { app } = await createDaemonServer({
      config: makeConfig({ acpxCommand: await resolveFakeAcpxCommand(), daemonAuthToken: token }),
      dataDir: join(root, "daemon-state")
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const unauthorized = await fetch(new URL("/sessions", address));
      expect(unauthorized.status).toBe(401);
      const capabilities = await fetch(new URL("/capabilities", address)).then((response) => response.json());
      expect(capabilities).toMatchObject({ claudeWorkflows: { version: 1, runtimeVerified: true, configId: "ocsl_workflow_v1" } });
      const provider = { id: "claude_code_anthropic_fable51", kind: "claude-code", model: "claude-fable-5-1" };
      const settings = (name: string, key: string) => readFile(join(root, ".fake-acpx-state", `${name}.${key}.setting`), "utf8");
      for (const effort of ["ultracode", "max", "high"]) {
        const name = `fable-http-${effort}`;
        const response = await fetch(new URL("/session/start", address), {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ agent: "claude", name, directory: root, task: "Return the canary marker.", contextFiles: [], effort, model: provider.model, modelProviderId: provider.id, modelProvider: provider, ownerKey: "fable-http-owner", interactionMode: "execute" })
        });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result).toMatchObject({ details: { session: { model: provider.model, effort, state: "idle" } } });
        expect(await settings(name, "model")).toBe("claude-fable-5-1\n");
        expect(await settings(name, "effort")).toBe(`${effort === "ultracode" ? "xhigh" : effort}\n`);
        expect(await settings(name, "ocsl_workflow_v1")).toBe(effort === "ultracode" ? "ultracode\n" : "off\n");
      }
      const opus = await fetch(new URL("/session/start", address), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ agent: "claude", name: "opus-http-canary", directory: root, task: "Return the existing canary marker.", contextFiles: [], effort: "max", model: "claude-opus-5" })
      });
      expect(opus.status).toBe(200);
      expect(await settings("opus-http-canary", "model")).toBe("claude-opus-5\n");
      await expect(settings("opus-http-canary", "ocsl_workflow_v1")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
