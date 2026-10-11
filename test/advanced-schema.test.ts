import { describe, expect, it } from "vitest";
import { startParamsZod } from "../src/shared/schema.js";
import { fingerprintStartRequest } from "../src/shared/turn-idempotency.js";
const base = { name: "parent", agent: "codex", directory: "/tmp/work", task: "task" };
const worker = { id: "refs", assignment: "check references", agent: "codex", modelProvider: { id: "local", kind: "codex-openai-compatible", model: "chat" } };
describe("advanced orchestration admission", () => {
  it("rejects duplicate configurations and incompatible harnesses", () => {
    expect(startParamsZod.safeParse({ ...base, orchestration: { version: 1, revision: 1, workers: [worker, worker] } }).success).toBe(false);
    expect(startParamsZod.safeParse({ ...base, orchestration: { version: 1, revision: 1, workers: [{ ...worker, agent: "claude" }] } }).success).toBe(false);
  });
  it("includes configuration in durable dispatch fingerprints", () => {
    const plain = startParamsZod.parse(base);
    const advanced = startParamsZod.parse({ ...base, orchestration: { version: 1, revision: 1, workers: [worker] } });
    expect(fingerprintStartRequest(plain)).not.toBe(fingerprintStartRequest(advanced));
    expect(fingerprintStartRequest(advanced)).not.toBe(fingerprintStartRequest({ ...advanced, orchestration: { ...advanced.orchestration!, revision: 2 } }));
  });
});
