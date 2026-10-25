import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AcpxSessionManager } from "../../src/manager/acpx.js";
import { OrchestratorRuntime } from "../../src/orchestrator/runtime.js";
import { OrchestratorStore } from "../../src/orchestrator/store.js";
import type { CampaignSpecRecord, RunRecord } from "../../src/orchestrator/types.js";
import { OutputRouter } from "../../src/plugin/output-router.js";
import {
  createTempDir,
  makeConfig,
  nodeFileExistsCommand,
  nodePrintCommand,
  nodeStdinToNullAndPrintCommand,
  resolveFakeAcpxCommand
} from "../helpers.js";
import { SessionStore } from "../../src/shared/store.js";

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Puppenclaw Test",
      GIT_AUTHOR_EMAIL: "puppenclaw@example.com",
      GIT_COMMITTER_NAME: "Puppenclaw Test",
      GIT_COMMITTER_EMAIL: "puppenclaw@example.com"
    }
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function processMayExist(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("OrchestratorRuntime", () => {
  it("reconciles dead, verified, unidentified, cancelling, and ambiguous command runs on restart", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-recovery-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const sessionStore = await SessionStore.open(workspaceDir);
    const config = makeConfig({ acpxCommand });
    const manager = new AcpxSessionManager({
      config,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store: sessionStore,
      outputRouter: new OutputRouter({ info() {}, warn() {}, error() {}, debug() {} })
    });
    const store = await OrchestratorStore.open(join(workspaceDir, ".orchestrator"));
    const runtime = new OrchestratorRuntime({
      config,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      sessionStore,
      store,
      sessionManager: manager
    });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore"
    });
    expect(child.pid).toBeTruthy();
    const childPid = child.pid as number;
    const unidentifiedChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore"
    });
    expect(unidentifiedChild.pid).toBeTruthy();
    const unidentifiedChildPid = unidentifiedChild.pid as number;
    let childIdentity: string | null = null;
    const identityDeadline = Date.now() + 2_000;
    while (childIdentity == null && Date.now() < identityDeadline) {
      const stat = await readFile(`/proc/${childPid}/stat`, "utf8").catch(() => null);
      if (stat != null) {
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
        childIdentity = fields[19] != null ? `${childPid}:${fields[19]}` : null;
      }
      if (childIdentity == null) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
      }
    }
    expect(childIdentity).toBeTruthy();

    const seed = (
      id: string,
      state: CampaignSpecRecord["state"],
      process?: Pick<RunRecord, "pid" | "processGroupId" | "processStartIdentity">
    ) => {
      const timestamp = "2026-01-01T00:00:00.000Z";
      const runId = `run-${id}`;
      store.upsertCampaign({
        id,
        projectId: "recovery-project",
        workerId: "local",
        name: id,
        template: "custom",
        experimentCommands: [],
        experimentParallelism: 1,
        iterations: 1,
        steps: [
          {
            id: "step-1",
            title: "Interrupted command",
            kind: "experiment",
            executor: "command",
            command: "long-running-command",
            contextFiles: [],
            approvalRequired: false,
            sessionScope: "campaign",
            env: {},
            retryLimit: 0
          }
        ],
        currentStepIndex: 0,
        currentRunId: runId,
        lastProgressAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        state
      });
      store.upsertRun({
        id: runId,
        campaignId: id,
        projectId: "recovery-project",
        workerId: "local",
        stepId: "step-1",
        stepTitle: "Interrupted command",
        stepIndex: 0,
        kind: "experiment",
        executor: "command",
        state: "running",
        startedAt: timestamp,
        updatedAt: timestamp,
        lastProgressAt: timestamp,
        attempts: 1,
        ...(process ?? {})
      });
    };
    seed("dead-campaign", "running", {
      pid: 999_999_999,
      processGroupId: 999_999_999,
      processStartIdentity: "999999999:1"
    });
    seed("cancelling-campaign", "cancelling", {
      pid: 999_999_998,
      processGroupId: 999_999_998,
      processStartIdentity: "999999998:1"
    });
    seed("ambiguous-campaign", "running");
    seed("surviving-campaign", "running", {
      pid: childPid,
      processGroupId: childPid,
      processStartIdentity: childIdentity as string
    });
    seed("unidentified-surviving-campaign", "running", {
      pid: unidentifiedChildPid,
      processGroupId: unidentifiedChildPid
    });

    try {
      await runtime.recoverInterruptedCampaigns();
      expect(store.getCampaign("dead-campaign")?.state).toBe("failed");
      expect(store.getRun("run-dead-campaign")?.failureCode).toBe("CAMPAIGN_INTERRUPTED");
      expect(store.getCampaign("cancelling-campaign")?.state).toBe("cancelled");
      expect(store.getRun("run-cancelling-campaign")?.state).toBe("cancelled");
      expect(store.getCampaign("ambiguous-campaign")?.state).toBe("recovery_required");
      expect(store.getCampaign("surviving-campaign")?.state).toBe("failed");
      expect(store.getRun("run-surviving-campaign")?.failureCode).toBe("CAMPAIGN_INTERRUPTED");
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(store.getCampaign("unidentified-surviving-campaign")?.state).toBe(
        "recovery_required"
      );
      expect(store.getCampaign("unidentified-surviving-campaign")?.failureCode).toBe(
        "CAMPAIGN_RECOVERY_REQUIRED"
      );
      expect(store.getRun("run-unidentified-surviving-campaign")?.state).toBe("running");
      expect(processMayExist(unidentifiedChildPid)).toBe(true);
    } finally {
      try {
        process.kill(-childPid, "SIGKILL");
      } catch {
        // The recovery sweep normally terminated it already.
      }
      try {
        process.kill(-unidentifiedChildPid, "SIGKILL");
      } catch {
        // The unidentified survivor must remain untouched until operator recovery.
      }
    }
  });

  it.skipIf(process.platform !== "linux")(
    "fences a persisted process group whose recorded leader exited before restart",
    async () => {
      const workspaceDir = await createTempDir("puppenclaw-orch-leader-exited-");
      const processFile = join(workspaceDir, "surviving-process.json");
      const leaderScript = join(workspaceDir, "exited-leader.cjs");
      await writeFile(
        leaderScript,
        [
          'const { spawn } = require("node:child_process");',
          'const { readFileSync, writeFileSync } = require("node:fs");',
          'const raw = readFileSync(`/proc/${process.pid}/stat`, "utf8");',
          'const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\\s+/u);',
          'const grandchild = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });',
          'writeFileSync(process.argv[2], JSON.stringify({ leaderPid: process.pid, processStartIdentity: `${process.pid}:${fields[19]}`, grandchildPid: grandchild.pid }));',
          "setTimeout(() => process.exit(0), 100);"
        ].join("\n"),
        "utf8"
      );
      const leader = spawn(process.execPath, [leaderScript, processFile], {
        detached: true,
        stdio: "ignore"
      });
      let processRecord:
        | { leaderPid: number; processStartIdentity: string; grandchildPid: number }
        | undefined;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && processRecord == null) {
        const raw = await readFile(processFile, "utf8").catch(() => "");
        if (raw.length > 0) {
          processRecord = JSON.parse(raw) as typeof processRecord;
          break;
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
      }
      expect(processRecord).toBeDefined();
      const recorded = processRecord as NonNullable<typeof processRecord>;
      while (Date.now() < deadline && processMayExist(recorded.leaderPid)) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
      }
      expect(processMayExist(recorded.leaderPid)).toBe(false);
      expect(processMayExist(recorded.grandchildPid)).toBe(true);

      const sessionStore = await SessionStore.open(workspaceDir);
      const config = makeConfig({ acpxCommand: await resolveFakeAcpxCommand() });
      const manager = new AcpxSessionManager({
        config,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        store: sessionStore,
        outputRouter: new OutputRouter({ info() {}, warn() {}, error() {}, debug() {} })
      });
      const store = await OrchestratorStore.open(join(workspaceDir, ".orchestrator"));
      const runtime = new OrchestratorRuntime({
        config,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        sessionStore,
        store,
        sessionManager: manager
      });
      const timestamp = "2026-01-01T00:00:00.000Z";
      store.upsertCampaign({
        id: "leader-exited-campaign",
        projectId: "recovery-project",
        workerId: "local",
        name: "leader-exited-campaign",
        template: "custom",
        experimentCommands: [],
        experimentParallelism: 1,
        iterations: 1,
        steps: [
          {
            id: "step-1",
            title: "Detached survivor",
            kind: "experiment",
            executor: "command",
            command: "detached-survivor",
            contextFiles: [],
            approvalRequired: false,
            sessionScope: "campaign",
            env: {},
            retryLimit: 0
          }
        ],
        currentStepIndex: 0,
        currentRunId: "run-leader-exited",
        lastProgressAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
        state: "running"
      });
      store.upsertRun({
        id: "run-leader-exited",
        campaignId: "leader-exited-campaign",
        projectId: "recovery-project",
        workerId: "local",
        stepId: "step-1",
        stepTitle: "Detached survivor",
        stepIndex: 0,
        kind: "experiment",
        executor: "command",
        state: "running",
        startedAt: timestamp,
        updatedAt: timestamp,
        lastProgressAt: timestamp,
        attempts: 1,
        pid: recorded.leaderPid,
        processGroupId: recorded.leaderPid,
        processStartIdentity: recorded.processStartIdentity
      });

      try {
        await runtime.recoverInterruptedCampaigns();
        expect(store.getCampaign("leader-exited-campaign")?.state).toBe("recovery_required");
        expect(store.getCampaign("leader-exited-campaign")?.failureCode).toBe(
          "CAMPAIGN_RECOVERY_REQUIRED"
        );
        expect(processMayExist(recorded.grandchildPid)).toBe(true);
      } finally {
        try {
          process.kill(-recorded.leaderPid, "SIGKILL");
        } catch {
          // already gone
        }
        try {
          process.kill(recorded.grandchildPid, "SIGKILL");
        } catch {
          // already gone
        }
        try {
          leader.kill("SIGKILL");
        } catch {
          // already gone
        }
        store.close();
        await sessionStore.close();
      }
    }
  );

  it("keeps cancellation terminal when a command exits concurrently", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-cancel-");
    const startedFile = join(workspaceDir, "started.txt");
    const commandFile = join(workspaceDir, "cancel-command.cjs");
    await writeFile(
      commandFile,
      [
        'const { spawn } = require("node:child_process");',
        'const grandchild = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });',
        'require("node:fs").writeFileSync(process.argv[2], String(grandchild.pid));',
        'process.on("SIGTERM", () => process.exit(0));',
        "setInterval(() => {}, 1000);"
      ].join("\n"),
      "utf8"
    );
    const acpxCommand = await resolveFakeAcpxCommand();
    const sessionStore = await SessionStore.open(workspaceDir);
    const config = makeConfig({ acpxCommand });
    const manager = new AcpxSessionManager({
      config,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store: sessionStore,
      outputRouter: new OutputRouter({ info() {}, warn() {}, error() {}, debug() {} })
    });
    const store = await OrchestratorStore.open(join(workspaceDir, ".orchestrator"));
    const runtime = new OrchestratorRuntime({
      config,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      sessionStore,
      store,
      sessionManager: manager
    });
    await runtime.createProject({ name: "cancel-project", rootDir: workspaceDir });

    const execution = runtime.runCampaign({
      projectId: "cancel-project",
      workerId: "local",
      name: "cancel-race",
      template: "custom",
      experimentCommands: [],
      experimentParallelism: 1,
      iterations: 1,
      steps: [
        {
          title: "Cancellable command",
          kind: "experiment",
          executor: "command",
          command: `node ${JSON.stringify(commandFile)} ${JSON.stringify(startedFile)}`,
          contextFiles: [],
          approvalRequired: false,
          env: {},
          retryLimit: 0
        }
      ]
    });
    const deadline = Date.now() + 5_000;
    let campaignId: string | undefined;
    while (Date.now() < deadline) {
      campaignId = store.listCampaigns().find((campaign) => campaign.name === "cancel-race")?.id;
      const started = await import("node:fs/promises").then(({ stat }) =>
        stat(startedFile).then(() => true, () => false)
      );
      if (campaignId != null && started) {
        break;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
    }
    expect(campaignId).toBeTruthy();
    const grandchildPid = Number.parseInt(await readFile(startedFile, "utf8"), 10);
    expect(grandchildPid).toBeGreaterThan(0);

    try {
      const cancellation = await runtime.cancel({ campaignId: campaignId as string });
      const finished = await execution;
      expect((cancellation.details as { campaign: { state: string } }).campaign.state).toBe(
        "cancelled"
      );
      expect((finished.details as { campaign: { state: string } }).campaign.state).toBe(
        "cancelled"
      );
      expect(processMayExist(grandchildPid)).toBe(false);
      const snapshot = store.getCampaignSnapshot(campaignId as string)!;
      expect(snapshot.campaign.state).toBe("cancelled");
      expect(snapshot.runs).toHaveLength(1);
      expect(snapshot.runs[0]?.state).toBe("cancelled");
      expect(snapshot.artifacts).toHaveLength(0);
    } finally {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // The cancellation escalation normally terminated it already.
      }
    }
  });

  it("keeps approval and cancellation monotonic in both orderings", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-approval-cancel-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const sessionStore = await SessionStore.open(workspaceDir);
    const config = makeConfig({ acpxCommand });
    const manager = new AcpxSessionManager({
      config,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store: sessionStore,
      outputRouter: new OutputRouter({ info() {}, warn() {}, error() {}, debug() {} })
    });
    const store = await OrchestratorStore.open(join(workspaceDir, ".orchestrator"));
    const runtime = new OrchestratorRuntime({
      config,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      sessionStore,
      store,
      sessionManager: manager
    });
    const startSpy = vi.spyOn(manager, "start");
    await runtime.createProject({ name: "approval-cancel-project", rootDir: workspaceDir });

    const startWaitingCampaign = async (name: string): Promise<string> => {
      const result = await runtime.runCampaign({
        projectId: "approval-cancel-project",
        workerId: "local",
        name,
        template: "custom",
        experimentCommands: [],
        experimentParallelism: 1,
        iterations: 1,
        steps: [
          {
            title: "Approved launch",
            kind: "plan",
            executor: "acp",
            instruction: "Do not launch after cancellation.",
            approvalRequired: true,
            contextFiles: [],
            env: {},
            retryLimit: 0
          }
        ]
      });
      const campaign = (result.details as { campaign: { id: string; state: string } }).campaign;
      expect(campaign.state).toBe("waiting_approval");
      return campaign.id;
    };

    try {
      const cancelledFirstId = await startWaitingCampaign("cancel-before-approval");
      const cancelledFirst = await runtime.cancel({ campaignId: cancelledFirstId });
      expect(
        (cancelledFirst.details as { campaign: { state: string } }).campaign.state
      ).toBe("cancelled");
      await expect(runtime.approve({ campaignId: cancelledFirstId })).rejects.toMatchObject({
        code: "CAMPAIGN_NOT_WAITING_APPROVAL"
      });
      expect(startSpy).not.toHaveBeenCalled();

      const approvedFirstId = await startWaitingCampaign("approval-before-cancel");
      let releasePrompt: () => void = () => {};
      const promptGate = new Promise<void>((resolveGate) => {
        releasePrompt = resolveGate;
      });
      let signalPromptEntered: () => void = () => {};
      const promptEntered = new Promise<void>((resolveEntered) => {
        signalPromptEntered = resolveEntered;
      });
      const runtimeInternals = runtime as unknown as {
        buildStepPrompt: (...args: unknown[]) => Promise<string>;
      };
      const originalBuildStepPrompt = runtimeInternals.buildStepPrompt.bind(runtime);
      runtimeInternals.buildStepPrompt = async (...args: unknown[]) => {
        signalPromptEntered();
        await promptGate;
        return originalBuildStepPrompt(...args);
      };

      const approval = runtime.approve({ campaignId: approvedFirstId });
      await promptEntered;
      expect(store.getCampaign(approvedFirstId)?.state).toBe("running");
      const cancellation = runtime.cancel({ campaignId: approvedFirstId });
      const cancellingDeadline = Date.now() + 1_000;
      while (
        store.getCampaign(approvedFirstId)?.state !== "cancelling" &&
        Date.now() < cancellingDeadline
      ) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 5));
      }
      expect(store.getCampaign(approvedFirstId)?.state).toBe("cancelling");
      expect(startSpy).not.toHaveBeenCalled();
      releasePrompt();

      const [approvalResult, cancellationResult] = await Promise.all([approval, cancellation]);
      expect(
        (approvalResult.details as { campaign: { state: string } }).campaign.state
      ).toBe("cancelled");
      expect(
        (cancellationResult.details as { campaign: { state: string } }).campaign.state
      ).toBe("cancelled");
      expect(store.getCampaign(approvedFirstId)?.state).toBe("cancelled");
      expect(store.listRuns(approvedFirstId)).toMatchObject([{ state: "cancelled" }]);
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      store.close();
      await sessionStore.close();
    }
  });

  it("terminalizes the campaign and active run when artifact persistence fails", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-artifact-failure-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const sessionStore = await SessionStore.open(workspaceDir);
    const config = makeConfig({ acpxCommand });
    const manager = new AcpxSessionManager({
      config,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      store: sessionStore,
      outputRouter: new OutputRouter({ info() {}, warn() {}, error() {}, debug() {} })
    });
    const store = await OrchestratorStore.open(join(workspaceDir, ".orchestrator"));
    const runtime = new OrchestratorRuntime({
      config,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      sessionStore,
      store,
      sessionManager: manager
    });
    await runtime.createProject({ name: "artifact-failure-project", rootDir: workspaceDir });
    const writableStore = store as OrchestratorStore & {
      upsertArtifact: OrchestratorStore["upsertArtifact"];
    };
    writableStore.upsertArtifact = () => {
      throw new Error("injected artifact persistence failure");
    };

    await expect(
      runtime.runCampaign({
        projectId: "artifact-failure-project",
        workerId: "local",
        name: "artifact-failure",
        template: "custom",
        experimentCommands: [],
        experimentParallelism: 1,
        iterations: 1,
        steps: [
          {
            title: "Successful command",
            kind: "experiment",
            executor: "command",
            command: nodePrintCommand("command succeeded\\n"),
            contextFiles: [],
            approvalRequired: false,
            env: {},
            retryLimit: 0
          }
        ]
      })
    ).rejects.toThrow("injected artifact persistence failure");

    const snapshot = store.getCampaignSnapshot(store.listCampaigns()[0]!.id)!;
    expect(snapshot.campaign.state).toBe("failed");
    expect(snapshot.campaign.failureCode).toBe("CAMPAIGN_EXECUTION_ERROR");
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.state).toBe("failed");
    expect(snapshot.artifacts).toHaveLength(0);
  });

  it("creates projects, syncs context, and runs a baseline campaign", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-");
    await writeFile(join(workspaceDir, "AGENTS.md"), "Follow the repo conventions.\n", "utf8");
    await writeFile(join(workspaceDir, "README.md"), "# Demo\n", "utf8");

    const acpxCommand = await resolveFakeAcpxCommand();
    const sessionStore = await SessionStore.open(workspaceDir);
    const outputRouter = new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: sessionStore,
      outputRouter
    });
    const runtime = new OrchestratorRuntime({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      sessionStore,
      store: await OrchestratorStore.open(join(workspaceDir, ".orchestrator")),
      sessionManager: manager
    });

    const project = await runtime.createProject({
      name: "demo-project",
      rootDir: workspaceDir,
      defaultAgent: "codex",
      planningProfile: "deep",
      permissionMode: "approve-all",
      effort: "high",
      model: "openai/gpt-5.4"
    });
    expect(project.content[0]?.text).toContain("Created project");

    const sync = await runtime.syncContext({
      projectId: "demo-project",
      includeFiles: ["AGENTS.md", "README.md"],
      memoryText: "Remember the local build commands."
    });
    expect(sync.content[0]?.text).toContain("Synchronized context");

    const campaign = await runtime.runCampaign({
      projectId: "demo-project",
      workerId: "local",
      name: "baseline",
      template: "baseline_from_scratch",
      task: "Implement the first baseline for this project.",
      evaluationCommand: nodePrintCommand("tests-ok\n"),
      experimentCommands: [],
      experimentParallelism: 1,
      iterations: 1,
      steps: []
    });

    const details = campaign.details as {
      campaign: {
        state: string;
      };
      runs: Array<{
        state: string;
        sessionName?: string;
      }>;
      artifacts: Array<{
        kind: string;
        sha256: string;
        siteId: string;
        stepId?: string;
        files?: Array<{
          sha256: string;
        }>;
      }>;
      progress: {
        completedSteps: number;
        experimentParallelism: number;
      };
    };
    expect(details.campaign.state).toBe("completed");
    expect(details.runs.some((run) => run.state === "completed")).toBe(true);
    expect(details.artifacts.some((artifact) => artifact.kind === "command-output")).toBe(true);
    expect(details.progress.completedSteps).toBe(details.runs.length);
    expect(details.progress.experimentParallelism).toBe(1);
    const commandArtifact = details.artifacts.find((artifact) => artifact.kind === "command-output");
    expect(commandArtifact?.sha256).toBeTruthy();
    expect(commandArtifact?.siteId).toBe("local");
    expect(commandArtifact?.stepId).toBeTruthy();
    expect(commandArtifact?.files?.[0]?.sha256).toBeTruthy();
    const projectArtifacts = await runtime.listArtifacts({
      projectId: "demo-project"
    });
    const artifactDetails = projectArtifacts.details as {
      artifacts: Array<{
        id: string;
        kind: string;
        sha256: string;
      }>;
    };
    expect(artifactDetails.artifacts.some((artifact) => artifact.kind === "context")).toBe(true);
    expect(artifactDetails.artifacts.every((artifact) => artifact.sha256.length > 0)).toBe(true);
    const readableArtifact = artifactDetails.artifacts.find((artifact) => artifact.kind === "context");
    expect(readableArtifact?.id).toBeTruthy();
    const artifactRead = await runtime.readArtifact({
      artifactId: readableArtifact?.id as string,
      limitChars: 5_000
    });
    const artifactReadDetails = artifactRead.details as {
      text: string;
      truncated: boolean;
      limitChars: number;
    };
    expect(artifactReadDetails.text).toContain("AGENTS.md");
    expect(artifactReadDetails.truncated).toBe(false);
    expect(artifactReadDetails.limitChars).toBe(5_000);
    const campaignEvents = await runtime.campaignEvents({
      campaignId: (campaign.details as { campaign: { id: string } }).campaign.id,
      limit: 10
    });
    expect((campaignEvents.details as { events: unknown[] }).events).toEqual([]);

    const siteStatus = await runtime.siteStatus({
      verbose: true
    });
    const siteDetails = siteStatus.details as {
      siteId: string;
      sessions: {
        total: number;
        items?: Array<{
          name: string;
        }>;
      };
      campaigns: {
        total: number;
      };
      workers: Array<{
        id: string;
      }>;
    };
    expect(siteDetails.siteId).toBe("local");
    expect(siteDetails.sessions.total).toBeGreaterThanOrEqual(1);
    expect(siteDetails.campaigns.total).toBe(1);
    expect(siteDetails.workers.some((worker) => worker.id === "local")).toBe(true);

    const sessionName = details.runs.find((run) => run.sessionName != null)?.sessionName;
    expect(sessionName).toBeTruthy();
    const sessionLogs = await runtime.logs({
      sessionName: sessionName as string,
      limitChars: 2_000,
      follow: false
    });
    const sessionLogDetails = sessionLogs.details as {
      scope: string;
      text: string;
    };
    expect(sessionLogDetails.scope).toBe("session");
    expect(sessionLogDetails.text.length).toBeGreaterThan(0);

    const campaignLogs = await runtime.logs({
      campaignId: (campaign.details as { campaign: { id: string } }).campaign.id,
      limitChars: 2_000,
      follow: false
    });
    const campaignLogDetails = campaignLogs.details as {
      scope: string;
      entries: Array<{
        id: string;
      }>;
    };
    expect(campaignLogDetails.scope).toBe("campaign");
    expect(campaignLogDetails.entries.length).toBe(details.runs.length);

    const orchestratedSession = sessionStore.listSessions().find((session) => session.name === sessionName);
    expect(orchestratedSession?.agent).toBe("codex");
    expect(orchestratedSession?.planningProfile).toBe("deep");
    expect(orchestratedSession?.permissionMode).toBe("approve-reads");
    expect(orchestratedSession?.effort).toBe("high");
    expect(orchestratedSession?.model).toBe("openai/gpt-5.4");
    expect(
      orchestratedSession?.transcript.some((entry) =>
        entry.role === "user" && entry.text.includes("deep planning pass first")
      )
    ).toBe(true);
  });

  it("reassesses prior sessions on an isolated branch and records a report", async () => {
    const workspaceDir = await createTempDir("puppenclaw-reassess-");
    await writeFile(join(workspaceDir, "README.md"), "# Reassess Demo\n", "utf8");
    await writeFile(
      join(workspaceDir, ".gitignore"),
      [".orchestrator/", "state.json", "spool.json", ".state-owner.json", ".fake-acpx-state/"].join("\n") + "\n",
      "utf8"
    );
    runGit(workspaceDir, ["init"]);
    runGit(workspaceDir, ["add", "."]);
    runGit(workspaceDir, ["commit", "-m", "initial"]);

    const acpxCommand = await resolveFakeAcpxCommand();
    const sessionStore = await SessionStore.open(workspaceDir);
    await sessionStore.upsertSession({
      name: "old-codex-session",
      agent: "codex",
      directory: workspaceDir,
      state: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivity: "2026-01-01T00:10:00.000Z",
      permissionMode: "approve-all",
      model: "old-model",
      warnings: [],
      transcript: [
        {
          role: "user",
          text: "Please implement the missing reassessment fix.",
          createdAt: "2026-01-01T00:00:00.000Z"
        },
        {
          role: "assistant",
          text: "I misunderstood and did not add the required file.",
          createdAt: "2026-01-01T00:05:00.000Z"
        }
      ]
    });
    const outputRouter = new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: sessionStore,
      outputRouter
    });
    const runtime = new OrchestratorRuntime({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      sessionStore,
      store: await OrchestratorStore.open(join(workspaceDir, ".orchestrator")),
      sessionManager: manager
    });

    await runtime.createProject({
      name: "reassess-project",
      rootDir: workspaceDir,
      defaultAgent: "codex",
      permissionMode: "approve-all"
    });

    const result = await runtime.startReassessment({
      projectId: "reassess-project",
      workerId: "local",
      targetModel: "new-model",
      providers: ["puppenclaw"],
      validationCommand: nodeFileExistsCommand("reassessment-fix.txt"),
      limit: 10
    });
    const details = result.details as {
      id: string;
      state: string;
      branch: string;
      worktreePath: string;
      validationExitCode: number;
      patchCommit?: string;
      importedSessions: Array<{
        provider: string;
      }>;
      artifactIds: {
        report?: string;
        patch?: string;
        validation?: string;
      };
    };

    expect(details.state).toBe("completed");
    expect(details.branch).toContain("puppenclaw-reassess-");
    expect(details.validationExitCode).toBe(0);
    expect(details.patchCommit).toBeTruthy();
    expect(details.importedSessions.some((session) => session.provider === "puppenclaw")).toBe(true);
    expect(details.artifactIds.report).toBeTruthy();
    expect(details.artifactIds.patch).toBeTruthy();
    expect(details.artifactIds.validation).toBeTruthy();
    expect(runGit(workspaceDir, ["status", "--porcelain=v1"])).toBe("");
    expect(runGit(details.worktreePath, ["branch", "--show-current"])).toBe(details.branch);

    const report = await runtime.reassessmentReport({
      reassessmentId: details.id
    });
    expect(report.content[0]?.text).toContain("Model Reassessment Output");
    expect(report.content[0]?.text).toContain("old-model mistake");

    const repeat = await runtime.startReassessment({
      projectId: "reassess-project",
      workerId: "local",
      targetModel: "new-model",
      providers: ["puppenclaw"],
      validationCommand: nodePrintCommand("ok\n"),
      limit: 10
    });
    const repeatDetails = repeat.details as {
      importedSessions: unknown[];
      warnings: string[];
    };
    expect(repeatDetails.importedSessions).toHaveLength(0);
    expect(repeatDetails.warnings.some((warning) => warning.includes("already reassessed"))).toBe(true);
  });

  it("runs puppenfusion in isolated worktrees and produces fusion artifacts", async () => {
    const workspaceDir = await createTempDir("puppenclaw-fusion-");
    await writeFile(join(workspaceDir, "AGENTS.md"), "Follow the repo conventions.\n", "utf8");
    await writeFile(join(workspaceDir, "README.md"), "# Fusion Demo\n", "utf8");
    await writeFile(join(workspaceDir, "src.ts"), "export const value = 1;\n", "utf8");
    await writeFile(
      join(workspaceDir, ".gitignore"),
      [".orchestrator/", "state.json", "spool.json", ".state-owner.json", ".fake-acpx-state/"].join("\n") + "\n",
      "utf8"
    );
    runGit(workspaceDir, ["init"]);
    runGit(workspaceDir, ["add", "."]);
    runGit(workspaceDir, ["commit", "-m", "initial"]);

    const acpxCommand = await resolveFakeAcpxCommand();
    const sessionStore = await SessionStore.open(workspaceDir);
    const outputRouter = new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand,
        defaultAgent: "claude"
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: sessionStore,
      outputRouter
    });
    const runtime = new OrchestratorRuntime({
      config: makeConfig({
        acpxCommand,
        defaultAgent: "claude"
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      sessionStore,
      store: await OrchestratorStore.open(join(workspaceDir, ".orchestrator")),
      sessionManager: manager
    });

    await runtime.createProject({
      name: "fusion-project",
      rootDir: workspaceDir,
      defaultAgent: "claude",
      fusionPreferredAgent: "codex",
      planningProfile: "deep"
    });
    await runtime.syncContext({
      projectId: "fusion-project",
      includeFiles: ["AGENTS.md", "README.md"]
    });

    const campaign = await runtime.runCampaign({
      projectId: "fusion-project",
      workerId: "local",
      name: "fusion-run",
      template: "puppenfusion",
      task: "Implement the feature cleanly from the sealed bundle.",
      fusionPreferredAgent: "codex",
      evaluationCommand: nodePrintCommand("tests-ok\n"),
      experimentCommands: [],
      experimentParallelism: 1,
      iterations: 1,
      steps: []
    });

    const startedDetails = campaign.details as {
      campaign: {
        id: string;
        state: string;
        template: string;
        waitingApprovalStepId?: string;
        fusion: {
          baseCommit: string;
          preferredAgent: string;
          bundleArtifactId: string;
          planArtifactId?: string;
          dossierArtifactId?: string;
          approvalState: string;
          currentPhase: string;
          worktrees: {
            codex: { path: string; branch: string };
            claude: { path: string; branch: string };
            merged: { path: string; branch: string };
          };
        };
      };
      runs: Array<{
        state: string;
        sessionName?: string;
        stepId: string;
      }>;
      artifacts: Array<{
        id: string;
        kind: string;
        stepId?: string;
        sha256: string;
      }>;
    };

    expect(startedDetails.campaign.template).toBe("puppenfusion");
    expect(startedDetails.campaign.state).toBe("waiting_approval");
    expect(startedDetails.campaign.waitingApprovalStepId).toBe("fusion-plan-approval");
    expect(startedDetails.campaign.fusion.preferredAgent).toBe("codex");
    expect(startedDetails.campaign.fusion.bundleArtifactId).toBeTruthy();
    expect(startedDetails.campaign.fusion.planArtifactId).toBeTruthy();
    expect(startedDetails.campaign.fusion.approvalState).toBe("waiting");
    expect(startedDetails.campaign.fusion.currentPhase).toBe("plan");
    expect(startedDetails.runs).toHaveLength(2);
    expect(startedDetails.runs.filter((run) => run.sessionName != null)).toHaveLength(2);
    expect(startedDetails.artifacts.filter((artifact) => artifact.kind === "fusion-plan-review")).toHaveLength(2);
    expect(startedDetails.artifacts.some((artifact) => artifact.kind === "fusion-plan")).toBe(true);

    const approved = await runtime.approve({
      campaignId: startedDetails.campaign.id
    });
    const details = approved.details as {
      campaign: {
        id: string;
        state: string;
        lastError?: string;
        fusion: {
          baseCommit: string;
          preferredAgent: string;
          bundleArtifactId: string;
          planArtifactId?: string;
          dossierArtifactId?: string;
          approvalState: string;
          integrationState: string;
          resolverUsed: boolean;
          currentPhase: string;
          lastCompletedPhase?: string;
          candidateStates: Record<string, {
            status: string;
            candidateCommit?: string;
            validationArtifactId?: string;
          }>;
          phaseSummaries: Array<{
            phase: string;
          }>;
          events: Array<{
            type: string;
          }>;
          worktrees: {
            codex: { path: string; branch: string };
            claude: { path: string; branch: string };
            merged: { path: string; branch: string };
          };
        };
      };
      runs: Array<{
        state: string;
        sessionName?: string;
        stepId: string;
      }>;
      artifacts: Array<{
        id: string;
        kind: string;
        stepId?: string;
        sha256: string;
      }>;
    };

    expect(details.campaign.state, details.campaign.lastError).toBe("completed");
    expect(details.campaign.fusion.approvalState).toBe("approved");
    expect(details.campaign.fusion.integrationState).toBe("succeeded");
    expect(details.campaign.fusion.resolverUsed).toBe(false);
    expect(details.campaign.fusion.dossierArtifactId).toBeTruthy();
    expect(details.campaign.fusion.lastCompletedPhase).toBe("merged_eval");
    expect(details.runs.length).toBe(11);
    expect(details.runs.filter((run) => run.sessionName != null)).toHaveLength(6);
    expect(details.runs.some((run) => run.stepId.startsWith("fusion-merge-"))).toBe(false);
    expect(details.artifacts.some((artifact) => artifact.kind === "fusion-bundle")).toBe(true);
    expect(details.artifacts.filter((artifact) => artifact.kind === "fusion-plan-review")).toHaveLength(2);
    expect(details.artifacts.some((artifact) => artifact.kind === "fusion-plan")).toBe(true);
    expect(details.artifacts.filter((artifact) => artifact.kind === "implementation-memo")).toHaveLength(2);
    expect(details.artifacts.filter((artifact) => artifact.kind === "fusion-candidate")).toHaveLength(4);
    expect(details.artifacts.filter((artifact) => artifact.kind === "peer-review")).toHaveLength(2);
    expect(details.artifacts.some((artifact) => artifact.kind === "fusion-dossier")).toBe(true);
    expect(details.artifacts.some((artifact) => artifact.kind === "integration-report")).toBe(true);
    expect(details.artifacts.every((artifact) => artifact.sha256.length > 0)).toBe(true);

    const codexCommit = details.campaign.fusion.candidateStates.codex?.candidateCommit;
    const claudeCommit = details.campaign.fusion.candidateStates.claude?.candidateCommit;
    expect(codexCommit).toBeTruthy();
    expect(claudeCommit).toBeTruthy();
    expect(details.campaign.fusion.candidateStates.codex?.validationArtifactId).toBeTruthy();
    expect(details.campaign.fusion.candidateStates.claude?.validationArtifactId).toBeTruthy();
    expect(details.campaign.fusion.phaseSummaries.map((summary) => summary.phase).sort()).toEqual([
      "candidate_eval",
      "implement",
      "integration",
      "merged_eval",
      "peer_review",
      "plan"
    ]);
    expect(details.campaign.fusion.events.some((event) => event.type === "fusion_plan_ready")).toBe(true);
    expect(details.campaign.fusion.events.some((event) => event.type === "fusion_approved")).toBe(true);
    expect(details.campaign.fusion.events.some((event) => event.type === "fusion_integration_succeeded")).toBe(true);

    expect(runGit(details.campaign.fusion.worktrees.codex.path, ["rev-parse", "HEAD"])).toBe(codexCommit);
    expect(runGit(details.campaign.fusion.worktrees.claude.path, ["rev-parse", "HEAD"])).toBe(claudeCommit);
    const mergedHead = runGit(details.campaign.fusion.worktrees.merged.path, ["rev-parse", "HEAD"]);
    expect(mergedHead).not.toBe(details.campaign.fusion.baseCommit);
    runGit(details.campaign.fusion.worktrees.merged.path, [
      "merge-base",
      "--is-ancestor",
      codexCommit as string,
      mergedHead
    ]);
    runGit(details.campaign.fusion.worktrees.merged.path, [
      "merge-base",
      "--is-ancestor",
      claudeCommit as string,
      mergedHead
    ]);

    const sessions = sessionStore.listSessions();
    expect(sessions.filter((session) => session.name.includes("fusion-plan"))).toHaveLength(2);
    expect(sessions.filter((session) => session.name.includes("fusion-implement"))).toHaveLength(2);
    expect(sessions.filter((session) => session.name.includes("fusion-review"))).toHaveLength(2);
    expect(sessions.some((session) => session.name.includes("fusion-merge"))).toBe(false);
  }, 15_000);

  it("pauses for approval and resumes when approved", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-approval-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const sessionStore = await SessionStore.open(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: sessionStore,
      outputRouter: new OutputRouter({
        info() {},
        warn() {},
        error() {},
        debug() {}
      })
    });
    const runtime = new OrchestratorRuntime({
      config: makeConfig({
        acpxCommand
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      sessionStore,
      store: await OrchestratorStore.open(join(workspaceDir, ".orchestrator")),
      sessionManager: manager
    });

    await runtime.createProject({
      name: "approval-project",
      rootDir: workspaceDir
    });

    const started = await runtime.runCampaign({
      projectId: "approval-project",
      workerId: "local",
      name: "gated",
      template: "custom",
      experimentCommands: [],
      experimentParallelism: 1,
      iterations: 1,
      steps: [
        {
          title: "Get approval first",
          kind: "plan",
          executor: "acp",
          instruction: "Outline the next action.",
          approvalRequired: true,
          contextFiles: [],
          env: {},
          retryLimit: 0
        },
        {
          title: "Continue work",
          kind: "code",
          executor: "acp",
          instruction: "Continue after approval.",
          contextFiles: [],
          approvalRequired: false,
          env: {},
          retryLimit: 0
        }
      ]
    });
    const startedDetails = started.details as {
      campaign: {
        id: string;
        state: string;
        waitingApprovalStepId?: string;
      };
    };
    expect(startedDetails.campaign.state).toBe("waiting_approval");
    expect(startedDetails.campaign.waitingApprovalStepId).toBeTruthy();

    const approved = await runtime.approve({
      campaignId: startedDetails.campaign.id
    });
    const approvedDetails = approved.details as {
      campaign: {
        state: string;
      };
    };
    expect(approvedDetails.campaign.state).toBe("completed");
  });

  it("uses the configured research command for literature-review campaigns", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-research-");
    const sessionStore = await SessionStore.open(workspaceDir);
    const outputRouter = new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    });
    const manager = new AcpxSessionManager({
      config: makeConfig({
        orchestration: {
          gptResearcherCommand: nodeStdinToNullAndPrintCommand("research dossier ready\n")
        }
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: sessionStore,
      outputRouter
    });
    const runtime = new OrchestratorRuntime({
      config: makeConfig({
        orchestration: {
          gptResearcherCommand: nodeStdinToNullAndPrintCommand("research dossier ready\n")
        }
      }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      sessionStore,
      store: await OrchestratorStore.open(join(workspaceDir, ".orchestrator")),
      sessionManager: manager
    });

    await runtime.createProject({
      name: "research-project",
      rootDir: workspaceDir
    });

    const campaign = await runtime.runCampaign({
      projectId: "research-project",
      workerId: "local",
      name: "literature-review",
      template: "literature_review",
      task: "Map the current project constraints and prior art.",
      experimentCommands: [],
      experimentParallelism: 1,
      iterations: 1,
      steps: []
    });
    const details = campaign.details as {
      campaign: {
        state: string;
      };
      artifacts: Array<{
        kind: string;
      }>;
    };
    expect(details.campaign.state).toBe("completed");
    expect(details.artifacts.some((artifact) => artifact.kind === "research-dossier")).toBe(true);
    expect(sessionStore.listSessions()).toHaveLength(0);
  });

  it("confines context files and step working directories to the project root", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-confine-");
    await writeFile(join(workspaceDir, "AGENTS.md"), "In-root context file.\n", "utf8");
    const outsideDir = await createTempDir("puppenclaw-orch-outside-");
    await writeFile(join(outsideDir, "secret.txt"), "outside the root\n", "utf8");

    const acpxCommand = await resolveFakeAcpxCommand();
    const sessionStore = await SessionStore.open(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: sessionStore,
      outputRouter: new OutputRouter({
        info() {},
        warn() {},
        error() {},
        debug() {}
      })
    });
    const runtime = new OrchestratorRuntime({
      config: makeConfig({ acpxCommand }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      sessionStore,
      store: await OrchestratorStore.open(join(workspaceDir, ".orchestrator")),
      sessionManager: manager
    });

    await runtime.createProject({
      name: "confined-project",
      rootDir: workspaceDir
    });

    await expect(
      runtime.syncContext({
        projectId: "confined-project",
        includeFiles: ["../escape.md"]
      })
    ).rejects.toMatchObject({ code: "CONTEXT_FILE_OUTSIDE_ROOT" });

    await expect(
      runtime.syncContext({
        projectId: "confined-project",
        includeFiles: [join(outsideDir, "secret.txt")]
      })
    ).rejects.toMatchObject({ code: "CONTEXT_FILE_OUTSIDE_ROOT" });

    const sync = await runtime.syncContext({
      projectId: "confined-project",
      includeFiles: ["AGENTS.md"]
    });
    expect(sync.content[0]?.text).toContain("Synchronized context");

    const escaped = await runtime.runCampaign({
      projectId: "confined-project",
      workerId: "local",
      name: "escape-cwd",
      template: "custom",
      experimentCommands: [],
      experimentParallelism: 1,
      iterations: 1,
      steps: [
        {
          title: "Escape working directory",
          kind: "experiment",
          executor: "command",
          command: nodePrintCommand("should-not-run\n"),
          contextFiles: [],
          approvalRequired: false,
          env: {},
          retryLimit: 0,
          workingDirectory: "../"
        }
      ]
    });
    const escapedDetails = escaped.details as {
      campaign: { state: string; lastError?: string };
      runs: Array<{ state: string; failureCode?: string }>;
    };
    expect(escapedDetails.campaign.state).toBe("failed");
    expect(escapedDetails.runs.some((run) => run.failureCode === "STEP_CWD_OUTSIDE_ROOT")).toBe(true);

    const escapedAbsolute = await runtime.runCampaign({
      projectId: "confined-project",
      workerId: "local",
      name: "escape-cwd-absolute",
      template: "custom",
      experimentCommands: [],
      experimentParallelism: 1,
      iterations: 1,
      steps: [
        {
          title: "Escape working directory with an absolute path",
          kind: "experiment",
          executor: "command",
          command: nodePrintCommand("should-not-run\n"),
          contextFiles: [],
          approvalRequired: false,
          env: {},
          retryLimit: 0,
          workingDirectory: outsideDir
        }
      ]
    });
    const escapedAbsoluteDetails = escapedAbsolute.details as {
      campaign: { state: string };
      runs: Array<{ failureCode?: string }>;
    };
    expect(escapedAbsoluteDetails.campaign.state).toBe("failed");
    expect(
      escapedAbsoluteDetails.runs.some((run) => run.failureCode === "STEP_CWD_OUTSIDE_ROOT")
    ).toBe(true);

    await mkdir(join(workspaceDir, "sub"), { recursive: true });
    const inRoot = await runtime.runCampaign({
      projectId: "confined-project",
      workerId: "local",
      name: "in-root-cwd",
      template: "custom",
      experimentCommands: [],
      experimentParallelism: 1,
      iterations: 1,
      steps: [
        {
          title: "Run inside the project root",
          kind: "experiment",
          executor: "command",
          command: nodePrintCommand("ran-in-sub\n"),
          contextFiles: [],
          approvalRequired: false,
          env: {},
          retryLimit: 0,
          workingDirectory: "sub"
        }
      ]
    });
    const inRootDetails = inRoot.details as { campaign: { state: string } };
    expect(inRootDetails.campaign.state).toBe("completed");
  });

  it("refuses context sync when orchestration is disabled", async () => {
    const workspaceDir = await createTempDir("puppenclaw-orch-disabled-");
    const acpxCommand = await resolveFakeAcpxCommand();
    const sessionStore = await SessionStore.open(workspaceDir);
    const manager = new AcpxSessionManager({
      config: makeConfig({ acpxCommand, orchestration: { enabled: false } }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      store: sessionStore,
      outputRouter: new OutputRouter({
        info() {},
        warn() {},
        error() {},
        debug() {}
      })
    });
    const runtime = new OrchestratorRuntime({
      config: makeConfig({ acpxCommand, orchestration: { enabled: false } }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {}
      },
      sessionStore,
      store: await OrchestratorStore.open(join(workspaceDir, ".orchestrator")),
      sessionManager: manager
    });

    await expect(
      runtime.syncContext({
        projectId: "any-project",
        includeFiles: []
      })
    ).rejects.toMatchObject({ code: "ORCHESTRATION_DISABLED" });
  });
});
