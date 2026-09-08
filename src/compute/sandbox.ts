import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { ComputeJobSpec } from "./types.js";

function trustedFile(value: string | undefined, label: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${label} must be configured as an absolute controller-owned file.`);
  const file = resolve(value);
  const info = lstatSync(file);
  if (!info.isFile() || realpathSync(file) !== file || (info.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw new Error(`${label} is not a trusted controller-owned file.`);
  }
  const parent = lstatSync(dirname(file));
  if (!parent.isDirectory() || (parent.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && parent.uid !== process.getuid())) {
    throw new Error(`${label} requires a controller-owned parent directory without group/world write access; choose a private configuration directory.`);
  }
  return file;
}

/** Job arguments/environment never select a launcher, config, or host mounts. */
export function resolveComputeSandbox(env: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== "linux") throw new Error("Managed compute requires Linux Bubblewrap isolation.");
  const launcher = trustedFile(env.PUPPENCLAW_COMPUTE_SANDBOX_WRAPPER, "Compute sandbox launcher");
  const configPath = trustedFile(env.LAB_SANDBOX_CONFIG, "Compute sandbox config");
  const payload = JSON.parse(readFileSync(configPath, "utf8"));
  const config = payload?.sandbox ?? payload;
  if (config?.mode !== "bubblewrap" || typeof config.workspaceRoot !== "string" || !isAbsolute(config.workspaceRoot)) {
    throw new Error("Compute sandbox requires an enforced Bubblewrap workspace policy.");
  }
  const roots = [config.workspaceRoot, ...(Array.isArray(config.legacyWorkspaceRoots) ? config.legacyWorkspaceRoots : [])];
  for (const root of roots) {
    if (typeof root !== "string" || !isAbsolute(root)) throw new Error("Invalid compute sandbox workspace root.");
    const canonical = realpathSync(root);
    if ([launcher, configPath].some((file) => file === canonical || file.startsWith(`${canonical}${sep}`))) {
      throw new Error("Compute launcher/config cannot be supplied from a writable workspace.");
    }
  }
  return { launcher, configPath };
}

export function computeSandboxAvailable(): boolean {
  try {
    const { launcher } = resolveComputeSandbox();
    const probe = spawnSync(process.execPath, [launcher, "--compute-protocol"], {
      encoding: "utf8", timeout: 3000, windowsHide: true,
    });
    return probe.status === 0 && probe.stdout.trim() === "ocsl-compute-sandbox-v1";
  } catch { return false; }
}

export function computeSandboxLaunch(spec: ComputeJobSpec, env: NodeJS.ProcessEnv = process.env) {
  if (spec.executor !== "bubblewrap-local") throw new Error(`Executor ${spec.executor} is not implemented.`);
  const trusted = resolveComputeSandbox(env);
  const jobEnv = {
    ...spec.env,
    OMP_NUM_THREADS: spec.env.OMP_NUM_THREADS ?? String(spec.resources.cpuCores),
    OPENBLAS_NUM_THREADS: spec.env.OPENBLAS_NUM_THREADS ?? String(spec.resources.cpuCores),
    MKL_NUM_THREADS: spec.env.MKL_NUM_THREADS ?? String(spec.resources.cpuCores),
  };
  for (const [name, value] of Object.entries(jobEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || value.includes("\0") || Buffer.byteLength(value) > 16 * 1024) {
      throw new Error("Invalid compute environment entry.");
    }
  }
  const serializedEnv = JSON.stringify(jobEnv);
  if (Object.keys(jobEnv).length > 256 || Buffer.byteLength(serializedEnv) > 64 * 1024) throw new Error("Compute environment exceeds its size limit.");
  const childEnv: NodeJS.ProcessEnv = { ...env, LAB_SANDBOX_CONFIG: trusted.configPath };
  return {
    command: process.execPath,
    args: [trusted.launcher, "--compute-env-fd", "3", "--cwd", spec.cwd, "--", ...spec.command],
    // Only controller environment reaches the host-side wrapper; it applies
    // its normal least-privilege policy before exec. User env travels on FD3.
    env: childEnv,
    serializedEnv,
  };
}
