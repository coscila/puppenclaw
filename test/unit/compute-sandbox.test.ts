import { chmod, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeSandboxLaunch, resolveComputeSandbox } from "../../src/compute/sandbox.js";
import { computeJobSpecZod } from "../../src/compute/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(mode = "bubblewrap") {
  const root = await mkdtemp(join(tmpdir(), "compute-sandbox-config-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspaces");
  const cwd = join(workspaceRoot, "chat-one");
  const launcher = join(root, "launcher.mjs");
  const configPath = join(root, "sandbox.json");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await writeFile(launcher, "// controller launcher\n", { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ mode, workspaceRoot }), { mode: 0o600 });
  const env = { PUPPENCLAW_COMPUTE_SANDBOX_WRAPPER: launcher, LAB_SANDBOX_CONFIG: configPath };
  const spec = computeJobSpecZod.parse({ jobId: "test-job", executor: "bubblewrap-local", cwd, command: ["python", "analysis.py"], resources: { cpuCores: 3, memoryMiB: 128, wallTimeSeconds: 30 } });
  return { root, cwd, launcher, configPath, workspaceRoot, env, spec };
}

describe.runIf(process.platform === "linux")("trusted managed compute sandbox", () => {
  it("fails closed without an enforced controller sandbox", async () => {
    expect(() => resolveComputeSandbox({})).toThrow(/controller-owned/);
    const f = await fixture("passthrough");
    expect(() => computeSandboxLaunch(f.spec, f.env)).toThrow(/enforced Bubblewrap/);
  });

  it("does not let job environment select the host launcher or config", async () => {
    const f = await fixture();
    const spec = { ...f.spec, env: { LAB_SANDBOX_CONFIG: "/attacker/config", PUPPENCLAW_COMPUTE_SANDBOX_WRAPPER: "/attacker/launcher", NODE_OPTIONS: "--require=/attacker/code", SCIENTIFIC_PARAMETER: "value" } };
    const launch = computeSandboxLaunch(spec, { ...f.env, NODE_OPTIONS: "--host-trusted" });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([f.launcher, "--compute-env-fd", "3", "--cwd", f.cwd, "--", "python", "analysis.py"]);
    expect(launch.env.LAB_SANDBOX_CONFIG).toBe(f.configPath);
    expect(launch.env.PUPPENCLAW_COMPUTE_SANDBOX_WRAPPER).toBe(f.launcher);
    expect(launch.env.NODE_OPTIONS).toBe("--host-trusted");
    expect(JSON.parse(launch.serializedEnv)).toEqual({ ...spec.env, OMP_NUM_THREADS: "3", OPENBLAS_NUM_THREADS: "3", MKL_NUM_THREADS: "3" });
  });

  it("rejects writable workspace launcher/config and oversized or invalid environment", async () => {
    const f = await fixture();
    const forged = join(f.cwd, "launcher.mjs");
    await writeFile(forged, "// untrusted", { mode: 0o600 });
    expect(() => resolveComputeSandbox({ ...f.env, PUPPENCLAW_COMPUTE_SANDBOX_WRAPPER: forged })).toThrow(/writable workspace/);
    for (const env of [{ "BAD=KEY": "value" }, { BAD: "nul\0value" }, { BAD: "x".repeat(20_000) }]) {
      expect(() => computeSandboxLaunch({ ...f.spec, env }, f.env)).toThrow(/environment/);
    }
  });

  it("rejects group-writable controller parents even when the file is private", async () => {
    const f = await fixture();
    await chmod(f.root, 0o770);
    expect(() => resolveComputeSandbox(f.env)).toThrow(/private configuration directory/);
  });
});
