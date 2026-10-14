import { describe, expect, it } from "vitest";
import { claudeAcpModelSelector } from "../src/shared/model-compatibility.js";
import { pluginConfigZod, pluginManifestConfigSchema, startParamsZod } from "../src/shared/schema.js";
import { bulkSubmitZod } from "../src/advanced/types.js";
import { fingerprintStartRequest } from "../src/shared/turn-idempotency.js";
const base = { name: "parent", agent: "codex", directory: "/tmp/work", task: "task" };
const worker = { id: "refs", assignment: "check references", agent: "codex", modelProvider: { id: "local", kind: "codex-openai-compatible", model: "chat" } };
describe("advanced orchestration admission", () => {
  it("uses the advertised default selector for legacy Claude while preserving current native model IDs", () => { expect(claudeAcpModelSelector("claude-opus-4-7")).toBe("default"); expect(claudeAcpModelSelector("claude-fable-5-1")).toBe("claude-fable-5-1"); });
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
  it("accepts more than 128 worker configurations while retaining identity and harness checks", () => {
    const workers = Array.from({ length: 257 }, (_, index) => ({ ...worker, id: `worker-${index}` }));
    const request = { ...base, orchestration: { version: 1, revision: 1, workers } };
    expect(startParamsZod.parse(request).orchestration?.workers).toHaveLength(257);
    expect(startParamsZod.safeParse({ ...request, orchestration: { ...request.orchestration, workers: [...workers, workers[0]] } }).success).toBe(false);
  });
  it("accepts configured session and bulk capacities beyond former ceilings without unsafe numbers", () => {
    for (const limit of [101, 10001, Number.MAX_SAFE_INTEGER]) {
      expect(pluginConfigZod.parse({ maxSessions: limit }).maxSessions).toBe(limit);
      expect(bulkSubmitZod.parse({ configId: "refs", idempotencyKey: "test", items: [{ id: "one", input: "task" }], concurrency: limit }).concurrency).toBe(limit);
    }
    expect(pluginConfigZod.parse({}).maxSessions).toBe(5);
    expect(pluginManifestConfigSchema.properties.maxSessions.maximum).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(pluginConfigZod.safeParse({ maxSessions: value }).success).toBe(false);
      expect(bulkSubmitZod.safeParse({ configId: "refs", idempotencyKey: "test", items: [{ id: "one", input: "task" }], concurrency: value }).success).toBe(false);
    }
  });
});
