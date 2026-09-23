import { describe, expect, it } from "vitest";

import {
  buildPluginManifest,
  effortLevelZod,
  pluginConfigZod,
  pluginSendParamsZod,
  pluginStartParamsZod,
  projectCreateParamsZod,
  reassessmentStartParamsZod,
  REMOTE_CONTROL_VERBS,
  sendParamsZod,
  startParamsZod,
  toolProjectCreateSchema,
  toolSendSchema,
  toolStartSchema
} from "../../src/shared/schema.js";

describe("plugin manifest and config schema", () => {
  it("emits orchestration config in the generated manifest", () => {
    const manifest = buildPluginManifest() as {
      description: string;
      configSchema: {
        properties: Record<string, unknown>;
      };
    };
    expect(manifest.description).toContain("Project-aware orchestration runtime");
    expect(manifest.configSchema.properties).toHaveProperty("orchestration");
  });

  it("fills orchestration defaults in parsed plugin config", () => {
    const parsed = pluginConfigZod.parse({});
    expect(parsed.orchestration.enabled).toBe(true);
    expect(parsed.orchestration.localWorker.id).toBe("local");
    expect(parsed.orchestration.allowLocalCommandExecution).toBe(true);
  });

  it("parses reassessment defaults and exposes remote verbs", () => {
    const parsed = reassessmentStartParamsZod.parse({
      projectId: "demo",
      workerId: "local",
      targetModel: "new-model"
    });
    expect(parsed.providers).toEqual(["puppenclaw", "codex", "claude"]);
    expect(parsed.limit).toBe(20);
    expect(REMOTE_CONTROL_VERBS).toContain("reassess");
    expect(REMOTE_CONTROL_VERBS).toContain("reassess-status");
    expect(REMOTE_CONTROL_VERBS).toContain("reassess-report");
    expect(REMOTE_CONTROL_VERBS).toContain("artifact-read");
    expect(REMOTE_CONTROL_VERBS).toContain("campaign-events");
  });

  it("keeps one-turn permission modes on the internal send boundary", () => {
    expect(
      sendParamsZod.parse({
        name: "demo",
        message: "Run the approved turn.",
        permissionMode: "approve-all"
      }).permissionMode
    ).toBe("approve-all");
    expect(
      sendParamsZod.safeParse({
        name: "demo",
        message: "Run the approved turn.",
        permissionMode: "unrestricted"
      }).success
    ).toBe(false);
    expect(
      pluginSendParamsZod.safeParse({
        name: "demo",
        message: "Try to elevate from the plugin.",
        permissionMode: "approve-all"
      }).success
    ).toBe(false);
    const toolProperties = (
      toolSendSchema as unknown as { properties: Record<string, unknown> }
    ).properties;
    expect(toolProperties).not.toHaveProperty("permissionMode");
    expect(
      sendParamsZod.parse({
        name: "demo",
        message: "Prepare a plan.",
        interactionMode: "plan"
      }).interactionMode
    ).toBe("plan");
    expect(
      pluginSendParamsZod.safeParse({
        name: "demo",
        message: "Try to choose an internal mode.",
        interactionMode: "execute"
      }).success
    ).toBe(false);
    expect(
      pluginStartParamsZod.safeParse({
        agent: "claude",
        name: "demo",
        directory: "/tmp/demo",
        task: "Try to choose an internal mode.",
        interactionMode: "plan"
      }).success
    ).toBe(false);
    expect(toolProperties).not.toHaveProperty("interactionMode");
    const startToolProperties = (
      toolStartSchema as unknown as { properties: Record<string, unknown> }
    ).properties;
    expect(startToolProperties).not.toHaveProperty("interactionMode");
    expect(startToolProperties).not.toHaveProperty("permissionMode");
    expect(
      pluginStartParamsZod.safeParse({
        agent: "claude",
        name: "demo",
        directory: "/tmp/demo",
        task: "Try to choose a permission baseline.",
        permissionMode: "approve-all"
      }).success
    ).toBe(false);
  });

  it("keeps lifecycle epochs on the authenticated daemon boundary", () => {
    expect(
      startParamsZod.parse({
        agent: "claude",
        name: "fenced-start",
        directory: "/tmp/fenced-start",
        task: "Resume the current lifecycle.",
        lifecycleEpoch: 7
      }).lifecycleEpoch
    ).toBe(7);
    expect(
      sendParamsZod.parse({
        name: "fenced-send",
        message: "Continue the current lifecycle.",
        lifecycleEpoch: 8
      }).lifecycleEpoch
    ).toBe(8);
    expect(
      pluginStartParamsZod.safeParse({
        agent: "claude",
        name: "fenced-start",
        directory: "/tmp/fenced-start",
        task: "Try to supply an internal lifecycle epoch.",
        lifecycleEpoch: 7
      }).success
    ).toBe(false);
    expect(
      pluginSendParamsZod.safeParse({
        name: "fenced-send",
        message: "Try to supply an internal lifecycle epoch.",
        lifecycleEpoch: 8
      }).success
    ).toBe(false);
    expect(
      (toolStartSchema as unknown as { properties: Record<string, unknown> }).properties
    ).not.toHaveProperty("lifecycleEpoch");
    expect(
      (toolSendSchema as unknown as { properties: Record<string, unknown> }).properties
    ).not.toHaveProperty("lifecycleEpoch");
  });

  it("keeps validated turn idempotency keys on the authenticated daemon boundary", () => {
    expect(
      startParamsZod.parse({
        agent: "claude",
        name: "keyed-start",
        directory: "/tmp/keyed-start",
        task: "Start exactly once.",
        turnKey: "queue:turn-1"
      }).turnKey
    ).toBe("queue:turn-1");
    expect(
      sendParamsZod.parse({
        name: "keyed-send",
        message: "Send exactly once.",
        turnKey: "queue.turn_2"
      }).turnKey
    ).toBe("queue.turn_2");
    expect(
      sendParamsZod.safeParse({
        name: "bad-key",
        message: "Reject unsafe key characters.",
        turnKey: "contains whitespace"
      }).success
    ).toBe(false);
    expect(
      pluginStartParamsZod.safeParse({
        agent: "claude",
        name: "plugin-key",
        directory: "/tmp/plugin-key",
        task: "Plugins cannot claim daemon keys.",
        turnKey: "not-trusted"
      }).success
    ).toBe(false);
    expect(
      pluginSendParamsZod.safeParse({
        name: "plugin-key",
        message: "Plugins cannot bypass recovery fences.",
        turnKey: "not-trusted"
      }).success
    ).toBe(false);
    expect(
      (toolStartSchema as unknown as { properties: Record<string, unknown> }).properties
    ).not.toHaveProperty("turnKey");
    expect(
      (toolSendSchema as unknown as { properties: Record<string, unknown> }).properties
    ).not.toHaveProperty("turnKey");
  });

  it("keeps follow-up model-provider refresh on the authenticated daemon boundary", () => {
    const refresh = {
      modelProviderId: "local-glm",
      modelProvider: {
        id: "local-glm",
        kind: "codex-openai-compatible" as const,
        model: "zai-org/GLM-5.2",
        baseUrl: "http://127.0.0.1:18000/v1",
        wireApi: "responses" as const
      }
    };
    expect(
      sendParamsZod.parse({
        name: "provider-refresh",
        message: "Continue with the current provider configuration.",
        ...refresh
      })
    ).toMatchObject(refresh);
    expect(
      pluginSendParamsZod.safeParse({
        name: "provider-refresh",
        message: "Try to refresh a provider from the plugin.",
        ...refresh
      }).success
    ).toBe(false);
    const toolProperties = (
      toolSendSchema as unknown as { properties: Record<string, unknown> }
    ).properties;
    expect(toolProperties).not.toHaveProperty("modelProviderId");
    expect(toolProperties).not.toHaveProperty("modelProvider");
  });

  describe("model provider subagent policy", () => {
    const provider = {
      id: "remote_langdock_gpt6_sol_medium",
      kind: "codex-openai-compatible" as const,
      model: "gpt-6-sol",
      baseUrl: "http://127.0.0.1:18161/v1",
      authTokenEnv: "LANGDOCK_API_KEY",
      wireApi: "responses" as const
    };
    const subagents = { model: "chat", effort: "xhigh" as const, maxConcurrentThreads: 6 };
    const start = (modelProvider: Record<string, unknown>) => ({
      agent: "codex" as const,
      name: "local-workers",
      directory: "/tmp/local-workers",
      task: "Plan with local workers.",
      modelProviderId: provider.id,
      modelProvider
    });
    const send = (modelProvider: Record<string, unknown>) => ({
      name: "local-workers",
      message: "Refresh the provider with local workers.",
      modelProviderId: provider.id,
      modelProvider
    });

    it("accepts and keeps a subagent policy on start and follow-up refreshes", () => {
      const modelProvider = { ...provider, subagents };
      expect(startParamsZod.parse(start(modelProvider)).modelProvider).toEqual(modelProvider);
      expect(pluginStartParamsZod.parse(start(modelProvider)).modelProvider).toEqual(
        modelProvider
      );
      expect(sendParamsZod.parse(send(modelProvider)).modelProvider).toEqual(modelProvider);
      for (const maxConcurrentThreads of [1, 16]) {
        expect(
          startParamsZod.safeParse(
            start({ ...provider, subagents: { ...subagents, maxConcurrentThreads } })
          ).success
        ).toBe(true);
      }
    });

    it("keeps providers without a subagent policy unchanged", () => {
      const parsed = startParamsZod.parse(start(provider)).modelProvider;
      expect(parsed).toEqual(provider);
      expect(parsed).not.toHaveProperty("subagents");
    });

    it.each([
      ["an unknown policy key", { ...subagents, fork: "all" }],
      ["a missing model", { effort: "xhigh", maxConcurrentThreads: 6 }],
      ["a blank model", { ...subagents, model: "  " }],
      ["a missing effort", { model: "chat", maxConcurrentThreads: 6 }],
      ["an unknown effort", { ...subagents, effort: "extreme" }],
      ["a missing thread cap", { model: "chat", effort: "xhigh" }],
      ["a zero thread cap", { ...subagents, maxConcurrentThreads: 0 }],
      ["a thread cap above 16", { ...subagents, maxConcurrentThreads: 17 }],
      ["a fractional thread cap", { ...subagents, maxConcurrentThreads: 2.5 }],
      ["a string thread cap", { ...subagents, maxConcurrentThreads: "6" }]
    ])("rejects %s", (_label, policy) => {
      expect(startParamsZod.safeParse(start({ ...provider, subagents: policy })).success).toBe(
        false
      );
      expect(sendParamsZod.safeParse(send({ ...provider, subagents: policy })).success).toBe(
        false
      );
    });

    it.each([
      ["codex-openai", { ...provider, kind: "codex-openai" }],
      ["claude-code", { ...provider, kind: "claude-code" }],
      ["an unspecified kind", { id: provider.id, model: provider.model }]
    ])("rejects a subagent policy on %s providers", (_label, modelProvider) => {
      const result = startParamsZod.safeParse(start({ ...modelProvider, subagents }));
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["modelProvider", "subagents"]);
      expect(sendParamsZod.safeParse(send({ ...modelProvider, subagents })).success).toBe(false);
    });

    it("mirrors the strict policy in the start tool schema", () => {
      const modelProviderSchema = (
        toolStartSchema as unknown as {
          properties: {
            modelProvider: {
              additionalProperties: boolean;
              required: string[];
              properties: Record<string, Record<string, unknown>>;
            };
          };
        }
      ).properties.modelProvider;
      expect(modelProviderSchema.required).not.toContain("subagents");
      const subagentSchema = modelProviderSchema.properties.subagents as {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: {
          model: Record<string, unknown>;
          effort: { anyOf: Array<{ const: string }> };
          maxConcurrentThreads: Record<string, unknown>;
        };
      };
      expect(subagentSchema.type).toBe("object");
      expect(subagentSchema.additionalProperties).toBe(false);
      expect([...subagentSchema.required].sort()).toEqual([
        "effort",
        "maxConcurrentThreads",
        "model"
      ]);
      expect(Object.keys(subagentSchema.properties).sort()).toEqual([
        "effort",
        "maxConcurrentThreads",
        "model"
      ]);
      expect(subagentSchema.properties.model).toEqual({ type: "string", minLength: 1 });
      expect(subagentSchema.properties.effort.anyOf.map((entry) => entry.const)).toEqual([
        ...effortLevelZod.options
      ]);
      expect(subagentSchema.properties.maxConcurrentThreads).toEqual({
        type: "integer",
        minimum: 1,
        maximum: 16
      });
    });
  });

  it.each(["xhigh", "max", "ultra"] as const)(
    "accepts the Codex %s reasoning level on start and follow-up turns",
    (effort) => {
      expect(
        startParamsZod.parse({
          agent: "codex",
          name: "demo",
          directory: "/tmp/demo",
          task: "Use the requested reasoning level.",
          effort
        }).effort
      ).toBe(effort);
      expect(
        sendParamsZod.parse({
          name: "demo",
          message: "Keep using the requested reasoning level.",
          effort
        }).effort
      ).toBe(effort);
    }
  );

  it("exposes a follow-up effort override through the send tool", () => {
    const toolProperties = (
      toolSendSchema as unknown as { properties: Record<string, unknown> }
    ).properties;
    expect(toolProperties).toHaveProperty("effort");
  });

  it.each(["none", "minimal", "ultracode"] as const)(
    "accepts and exposes provider-specific reasoning mode %s",
    (effort) => {
      expect(
        startParamsZod.parse({
          agent: "codex",
          name: "provider-demo",
          directory: "/tmp/provider-demo",
          task: "Use the provider-specific reasoning mode.",
          effort,
          modelProvider: {
            id: "local-glm",
            model: "zai-org/GLM-5.2",
            reasoningProfile: "glm-5.2"
          }
        }).effort
      ).toBe(effort);

      const startProperties = (
        toolStartSchema as unknown as {
          properties: { effort: { anyOf: Array<{ const: string }> } };
        }
      ).properties;
      expect(startProperties.effort.anyOf.map((entry) => entry.const)).toContain(effort);
    }
  );

  it.each(["none", "minimal", "ultracode"] as const)(
    "rejects provider-specific reasoning mode %s for mixed-agent projects",
    (effort) => {
      expect(
        projectCreateParamsZod.safeParse({
          name: "mixed-project",
          rootDir: "/tmp/mixed-project",
          effort
        }).success
      ).toBe(false);

      const projectProperties = (
        toolProjectCreateSchema as unknown as {
          properties: { effort: { anyOf: Array<{ const: string }> } };
        }
      ).properties;
      expect(projectProperties.effort.anyOf.map((entry) => entry.const)).not.toContain(
        effort
      );
    }
  );
});
