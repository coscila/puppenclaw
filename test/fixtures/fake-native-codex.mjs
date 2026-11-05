import { readFileSync, writeSync } from "node:fs";
import { request } from "node:http";

// A broker-routed Codex client for one-shot turns: it calls the broker's native Responses route, retries a 429 twice,
// and then fails its turn with the error text of the answer it gave up on.
readFileSync(0, "utf8");
const emit = (value) => writeSync(1, `${JSON.stringify(value)}\n`);
const call = () => new Promise((resolve, reject) => {
  const req = request({ socketPath: process.env.PUPPENCLAW_ORCHESTRATION_SOCKET, path: "/native/v1/responses", agent: false, method: "POST", headers: { "content-type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  req.on("error", reject); req.end(JSON.stringify({ model: "synthetic-model", input: "Review" }));
});
emit({ type: "thread.started", thread_id: "fixture-thread" });
emit({ type: "turn.started" });
let status = await call();
for (let retry = 0; retry < 2 && status === 429; retry++) status = await call();
emit({ type: "turn.failed", error: { message: `exceeded retry limit, last status: ${status} Too Many Requests` } });
