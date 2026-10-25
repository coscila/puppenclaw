import { describe, expect, it } from "vitest";

import { BulkResponseTransport, directUpstreamsFromEnvironment, IMAGE_OMISSION_TEXT, shapeLikeNamespaceProxy, TurnPolicyViolation } from "../../src/advanced/bulk-transport.js";
import { bulkRetryFromEnvironment, failureCodeForStatus, resumeAfterFromHeaders, retryDelayMs } from "../../src/advanced/retry.js";
import { canonicalJson, effectiveSettings, finishReasonOf, serverFingerprint, settingsSha256, sha256Hex } from "../../src/advanced/fingerprint.js";
import type { ModelProviderConfig } from "../../src/shared/types.js";

const bulkPayload = () => ({
  model: "chat",
  input: [{ role: "system", content: "policy" }, { role: "user", content: JSON.stringify({ assignment: "Check", messages: [{ role: "user", content: "OCSL_STATUS_NO_TOOLS\nquoted" }] }) }],
  stream: false, temperature: 0, reasoning: { effort: "none" }
});

describe("namespace-proxy request shaping for direct bulk calls", () => {
  it("leaves a tool-free broker payload byte for byte unchanged", () => {
    const payload = bulkPayload(), before = JSON.stringify(payload);
    expect(shapeLikeNamespaceProxy(payload)).toBe(false);
    expect(JSON.stringify(payload)).toBe(before);
  });

  it("applies a user no-tools marker of the latest user message exactly like the proxy", () => {
    const payload: Record<string, unknown> = { model: "chat", input: [{ role: "user", content: "OCSL_INITIAL_PLAN_NO_TOOLS\nplan this" }] };
    expect(shapeLikeNamespaceProxy(payload)).toBe(true);
    expect(payload).toEqual({ model: "chat", input: [{ role: "user", content: "OCSL_INITIAL_PLAN_NO_TOOLS\nplan this" }], tool_choice: "none" });
    const earlier: Record<string, unknown> = { model: "chat", input: [{ role: "user", content: "OCSL_STATUS_NO_TOOLS" }, { role: "assistant", content: "ok" }, { role: "user", content: "later" }] };
    expect(shapeLikeNamespaceProxy(earlier)).toBe(false);
    const block: Record<string, unknown> = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "OCSL_PLAN_FEEDBACK_TURN_NO_TOOLS\n" }] }], tool_choice: "none" };
    expect(shapeLikeNamespaceProxy(block)).toBe(false);
    const execution: Record<string, unknown> = { input: [{ role: "user", content: "OCSL_EXECUTION_TURN_TOOLS_ALLOWED" }] };
    expect(shapeLikeNamespaceProxy(execution)).toBe(false); expect(execution).not.toHaveProperty("tool_choice");
  });

  it("trusts markers only from instructions and fails closed like the proxy", () => {
    const strip: Record<string, unknown> = { instructions: "OCSL_TRUSTED_TURN_POLICY_PLAN_NO_TOOLS\nrest", input: [], tools: [{ type: "function", name: "x" }], parallel_tool_calls: true };
    expect(shapeLikeNamespaceProxy(strip)).toBe(true);
    expect(strip).toEqual({ instructions: "OCSL_TRUSTED_TURN_POLICY_PLAN_NO_TOOLS\nrest", input: [], tool_choice: "none" });
    expect(() => shapeLikeNamespaceProxy({ instructions: "OCSL_TRUSTED_TURN_POLICY_EXECUTION_TOOLS_ALLOWED", input: [] })).toThrow(TurnPolicyViolation);
    const developer: Record<string, unknown> = { input: [{ role: "developer", content: "OCSL_TRUSTED_TURN_POLICY_PLAN_NO_TOOLS" }], tools: [{ type: "function", name: "x" }] };
    expect(shapeLikeNamespaceProxy(developer)).toBe(false); expect(developer.tools).toHaveLength(1);
  });

  it("converts agent messages, repairs truncated replayed call arguments and keeps the four newest images", () => {
    const payload: Record<string, unknown> = { input: [
      { type: "agent_message", author: "w1", recipient: "main", content: [{ type: "input_text", text: "done" }, { type: "encrypted_content", encrypted_content: "task" }] },
      { type: "agent_message", author: "w2", content: [] },
      { type: "function_call", name: "f", arguments: "{\"a\":{\"b\":1}" },
      ...Array.from({ length: 6 }, (_, index) => ({ role: "user", content: [{ type: "input_image", image_url: `img${index}` }] }))
    ] };
    expect(shapeLikeNamespaceProxy(payload)).toBe(true);
    const input = payload.input as Record<string, unknown>[];
    expect(input[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "done\ntask" }] });
    expect(input[1]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "Agent message from w2 to this agent." }] });
    expect(input[2]).toEqual({ type: "function_call", name: "f", arguments: "{\"a\":{\"b\":1}}" });
    expect(input.slice(3).map((item) => (item.content as { type: string; text?: string }[])[0])).toEqual([
      { type: "input_text", text: IMAGE_OMISSION_TEXT }, { type: "input_text", text: IMAGE_OMISSION_TEXT },
      { type: "input_image", image_url: "img2" }, { type: "input_image", image_url: "img3" }, { type: "input_image", image_url: "img4" }, { type: "input_image", image_url: "img5" }
    ]);
  });
});

describe("direct upstream routing", () => {
  const provider = (baseUrl: string): ModelProviderConfig => ({ id: "remote_qwen38_none", model: "chat", kind: "codex-openai-compatible", baseUrl, authTokenEnv: "KEY" });

  it("maps a registered proxy URL to its upstream with one keep-alive pool per upstream and capacity group", async () => {
    const transport = new BulkResponseTransport(60_000, new Map([["http://127.0.0.1:18160/v1", "http://10.0.0.5:18000/v1"]]));
    try {
      const direct = transport.route(provider("http://127.0.0.1:18160/v1/"), "group-a", 60);
      expect(direct.direct).toBe(true);
      expect(direct.provider.baseUrl).toBe("http://10.0.0.5:18000/v1");
      expect(transport.route(provider("http://127.0.0.1:18160/v1"), "group-a", 60).dispatcher).toBe(direct.dispatcher);
      expect(transport.route(provider("http://127.0.0.1:18160/v1"), "group-b", 4).dispatcher).not.toBe(direct.dispatcher);
      const registered = transport.route(provider("http://127.0.0.1:18161/v1"), "group-a", 60);
      expect(registered).toMatchObject({ direct: false, provider: { baseUrl: "http://127.0.0.1:18161/v1" } });
      expect(transport.directTargets()).toEqual(["http://10.0.0.5:18000/v1"]);
    } finally { await transport.close(); }
  });

  it("validates the operator mapping", () => {
    expect(directUpstreamsFromEnvironment({})).toEqual(new Map());
    expect(directUpstreamsFromEnvironment({ PUPPENCLAW_BULK_DIRECT_UPSTREAMS: '{"http://127.0.0.1:18160/v1/":"http://h:18000/v1/"}' })).toEqual(new Map([["http://127.0.0.1:18160/v1", "http://h:18000/v1"]]));
    for (const value of ["[]", "{", '{"http://a/v1":1}', '{"ftp://a/v1":"http://b/v1"}', '{"http://a/v1":"http://u:p@b/v1"}', '{"http://a/v1":"http://b/v1?x=1"}']) {
      expect(() => directUpstreamsFromEnvironment({ PUPPENCLAW_BULK_DIRECT_UPSTREAMS: value })).toThrow();
    }
  });
});

describe("broker retry policy", () => {
  it("backs off exponentially with jitter and validates its settings", () => {
    const options = { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 };
    expect([1, 2, 3, 6].map((attempt) => retryDelayMs(options, attempt, () => 0.5))).toEqual([1_000, 2_000, 4_000, 30_000]);
    expect(retryDelayMs(options, 1, () => 0)).toBe(800); expect(retryDelayMs(options, 1, () => 1)).toBe(1_200);
    expect(bulkRetryFromEnvironment({})).toEqual({ attempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 });
    expect(bulkRetryFromEnvironment({ PUPPENCLAW_BULK_RETRY_ATTEMPTS: "1", PUPPENCLAW_BULK_RETRY_BASE_MS: "0" })).toMatchObject({ attempts: 1, baseDelayMs: 0 });
    for (const value of ["0", "11", "1.5", "x"]) expect(() => bulkRetryFromEnvironment({ PUPPENCLAW_BULK_RETRY_ATTEMPTS: value })).toThrow();
    expect([429, 401, 403, 404, 400, 500, 502].map(failureCodeForStatus)).toEqual(["PROVIDER_RATE_LIMITED", "PROVIDER_AUTH_REQUIRED", "PROVIDER_AUTH_REQUIRED", "MODEL_UNAVAILABLE", "INVALID_REQUEST", "PROVIDER_UNREACHABLE", "PROVIDER_UNREACHABLE"]);
  });

  it("derives resumeAfter from Retry-After or the latest provider reset", () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const headers = (values: Record<string, string>) => new Headers(values);
    expect(resumeAfterFromHeaders(headers({ "retry-after": "120" }), now)).toBe("2026-10-25T12:02:00.000Z");
    expect(resumeAfterFromHeaders(headers({ "retry-after": "Sun, 25 Oct 2026 12:05:00 GMT" }), now)).toBe("2026-10-25T12:05:00.000Z");
    expect(resumeAfterFromHeaders(headers({ "x-ratelimit-reset-requests": "6m0s", "x-ratelimit-reset-tokens": "1.5s" }), now)).toBe("2026-10-25T12:06:00.000Z");
    expect(resumeAfterFromHeaders(headers({ "x-ratelimit-reset-tokens": "20ms" }), now)).toBe("2026-10-25T12:00:00.020Z");
    expect(resumeAfterFromHeaders(headers({ "anthropic-ratelimit-requests-reset": "2026-10-25T12:01:30Z" }), now)).toBe("2026-10-25T12:01:30.000Z");
    expect(resumeAfterFromHeaders(headers({ "ratelimit-reset": "30" }), now)).toBe("2026-10-25T12:00:30.000Z");
    expect(resumeAfterFromHeaders(headers({ "retry-after": "never", "x-ratelimit-reset-requests": "soon" }), now)).toBeUndefined();
    expect(resumeAfterFromHeaders(headers({ "retry-after": "99999999" }), now)).toBeUndefined();
  });
});

describe("receipt provenance digests", () => {
  it("digests the effective settings canonically and fingerprints the server without ever returning an empty value", () => {
    const settings = effectiveSettings({ model: "chat", temperature: 0, seed: 7, reasoning: { effort: "none" }, max_output_tokens: 3000, text: { format: { type: "json_schema", schema: { b: 1, a: 2 } } }, input: [{ role: "system", content: "S" }, { role: "user", content: "U" }] });
    expect(settings).toEqual({ model: "chat", temperature: 0, seed: 7, reasoning: { effort: "none" }, max_tokens: 3000, response_format_sha256: sha256Hex(canonicalJson({ type: "json_schema", schema: { a: 2, b: 1 } })), system_prompt_sha256: sha256Hex("S") });
    expect(settingsSha256(settings)).toBe(sha256Hex('{"max_tokens":3000,"model":"chat","reasoning":{"effort":"none"},"response_format_sha256":"' + settings.response_format_sha256 + '","seed":7,"system_prompt_sha256":"' + sha256Hex("S") + '","temperature":0}'));
    expect(effectiveSettings({ model: "m", system: [{ type: "text", text: "A" }, { type: "text", text: "B" }], max_tokens: 5 })).toMatchObject({ system_prompt_sha256: sha256Hex("A\n\nB"), max_tokens: 5 });
    expect(serverFingerprint({ payload: { system_fingerprint: "fp_44709d6fcb" }, model: "chat" })).toBe("fp_44709d6fcb");
    const fromHeaders = serverFingerprint({ model: "nvidia/Qwen", headers: new Headers({ server: "uvicorn", "x-request-id": "varies" }) });
    expect(fromHeaders).toBe(`nvidia/Qwen@${sha256Hex(canonicalJson({ server: "uvicorn" })).slice(0, 16)}`);
    expect(serverFingerprint({ model: "", headers: null })).toMatch(/^unknown@[0-9a-f]{16}$/u);
    expect([
      { choices: [{ finish_reason: "length" }] }, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, { status: "completed" },
      { stop_reason: "end_turn" }, { stop_reason: "max_tokens" }, { status: "incomplete", incomplete_details: { reason: "content_filter" } }, {}
    ].map(finishReasonOf)).toEqual(["length", "length", "stop", "stop", "length", "content_filter", null]);
  });
});
