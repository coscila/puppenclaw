import { readFileSync } from "node:fs";
import { request } from "node:http";

// A broker-routed Claude client: its prompt calls the broker's native Messages route and retries a 429 or 503 as
// Claude Code does (here at most twice, and not at all after a Retry-After beyond 60 s unless the prompt says
// RETRY_ANY). It then ends as Claude Code ends: with its reply, or with the error text of the answer it gave up on.
// FAIL_AFTER_REPLY makes it fail with an unrelated error after a successful call.
const args = process.argv.slice(2);
if (args.indexOf("prompt") < 0) {
  await import("./fake-acpx.mjs");
} else {
  const input = readFileSync(0, "utf8");
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const call = () => new Promise((resolve, reject) => {
    const req = request({ socketPath: process.env.PUPPENCLAW_ORCHESTRATION_SOCKET, path: "/native/v1/messages", agent: false, method: "POST", headers: { "content-type": "application/json", authorization: "Bearer subscription-fixture" } }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode, retryAfter: Number(res.headers["retry-after"] ?? 0), text }));
    });
    req.on("error", reject); req.end(JSON.stringify({ model: "synthetic-model", max_tokens: 16, messages: [{ role: "user", content: "Review" }] }));
  });
  let answer = await call();
  for (let retry = 0; retry < 2 && [429, 503].includes(answer.status) && (answer.retryAfter <= 60 || input.includes("RETRY_ANY")); retry++) answer = await call();
  if (answer.status === 200 && input.includes("FAIL_AFTER_REPLY")) {
    emit({ type: "error", code: "SIM_FAIL", message: "Simulated turn failure" });
  } else if (answer.status === 200) {
    emit({ type: "agent_message_chunk", content: { type: "text", text: "Reviewed." } });
    emit({ type: "done", stopReason: "end_turn" });
  } else {
    emit({ type: "error", code: "INTERNAL_ERROR", message: answer.status === 409 ? `Internal error: API Error: 409 ${answer.text}` : `Internal error: API Error: Request rejected (${answer.status}) · rate limited` });
  }
}
