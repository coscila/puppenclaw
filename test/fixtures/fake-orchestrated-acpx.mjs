import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

const args = process.argv.slice(2);
const prompt = args.indexOf("prompt");
if (prompt < 0) {
  await import("./fake-acpx.mjs");
} else {
  const cwd = args[args.indexOf("--cwd") + 1];
  const name = args[args.indexOf("--session") + 1];
  const input = readFileSync(0, "utf8");
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const call = (path, value) => new Promise((resolve, reject) => {
    const req = request({ socketPath: process.env.PUPPENCLAW_ORCHESTRATION_SOCKET, path, method: value ? "POST" : "GET", headers: { "content-type": "application/json" } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(text)));
    }); req.on("error", reject); req.end(value ? JSON.stringify(value) : undefined);
  });
  let output;
  if (input.includes("Seed existing session")) {
    output = "Seeded existing session.";
  } else if (process.env.PUPPENCLAW_ORCHESTRATION_JOB_ID) {
    writeFileSync(join(cwd, "worker-started"), name);
    writeFileSync(join(cwd, "worker-permission"), args.includes("--approve-all") ? "approve-all" : "approve-reads");
    while (!existsSync(join(cwd, "release-worker"))) await new Promise((done) => setTimeout(done, 10));
    if (existsSync(join(cwd, "pause-worker"))) {
      emit({ type: "tool_call", title: "AskUserQuestion", _meta: { claudeCode: { toolName: "AskUserQuestion" } }, rawInput: { questions: [{ question: "Restore worker access?" }] } });
      output = "Please restore worker access?";
    } else output = "Verified worker findings.";
  } else if (input.includes("worker jobs submitted by this same approved turn")) {
    const jobs = (await call("/jobs")).jobs;
    if (jobs.some((job) => ["queued", "running", "cancelled"].includes(job.state))) throw new Error("Parent continued before worker settlement");
    writeFileSync(join(cwd, "parent-continuation"), input);
    writeFileSync(join(cwd, "parent-continuation-permission"), args.includes("--approve-all") ? "approve-all" : "approve-reads");
    output = jobs.some((job) => job.state === "paused") ? "The worker needs restored access." : "Integrated verified worker findings.";
  } else {
    const job = await call("/agent/submit", { configId: "refs", idempotencyKey: "held-worker", task: "Verify sources" });
    writeFileSync(join(cwd, "parent-submitted"), job.jobId);
    if (existsSync(join(cwd, "observe-worker"))) {
      while (["queued", "running"].includes((await call(`/jobs/${job.jobId}`)).state)) await new Promise((done) => setTimeout(done, 10));
    }
    // Execution progress is not a plan approval boundary.
    emit({ type: "plan", entries: [{ content: "Integrate worker findings", status: "in_progress" }] });
    output = "Workers are running; I am waiting for their findings.";
    if (existsSync(join(cwd, "approval-boundary"))) {
      emit({ type: "tool_call", title: "ExitPlanMode", _meta: { claudeCode: { toolName: "ExitPlanMode" } } });
    }
  }
  emit({ type: "agent_message_chunk", content: { type: "text", text: output } });
  emit({ type: "done", stopReason: "end_turn" });
}
