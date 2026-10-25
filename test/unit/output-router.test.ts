import { describe, expect, it } from "vitest";

import { OutputRouter } from "../../src/plugin/output-router.js";
import type { OutputRouteEvent } from "../../src/plugin/output-router.js";

describe("OutputRouter", () => {
  it("buffers until newline and flushes trailing text on completion", async () => {
    const events: OutputRouteEvent[] = [];
    const router = new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    });
    router.attach("demo", async (event) => {
      events.push(event);
    });

    await router.onChunk("demo", "hello");
    await router.onChunk("demo", " world\nnext");
    await router.onComplete("demo", "Turn completed.");

    expect(events).toEqual([
      {
        kind: "chunk",
        sessionName: "demo",
        text: "hello world\n"
      },
      {
        kind: "chunk",
        sessionName: "demo",
        text: "next"
      },
      {
        kind: "complete",
        sessionName: "demo",
        text: "Turn completed."
      }
    ]);
  });

  it("fans out to concurrent dispatchers and detaches only by subscription identity", async () => {
    const router = new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    });
    const first: string[] = [];
    const second: string[] = [];
    const firstSubscription = router.attach("demo", (event) => {
      if (event.kind === "chunk") {
        first.push(event.text);
      }
    });
    const secondSubscription = router.attach("demo", (event) => {
      if (event.kind === "chunk") {
        second.push(event.text);
      }
    });

    await router.onChunk("demo", "one\n");
    expect(first).toEqual(["one\n"]);
    expect(second).toEqual(["one\n"]);

    // A stale/foreign token must not remove either active subscription.
    router.detach({ sessionName: "demo", dispatcher: () => undefined });
    await router.onChunk("demo", "two\n");
    expect(first).toEqual(["one\n", "two\n"]);
    expect(second).toEqual(["one\n", "two\n"]);

    // Detaching one subscription leaves the other receiving events.
    router.detach(secondSubscription);
    await router.onChunk("demo", "three\n");
    expect(first).toEqual(["one\n", "two\n", "three\n"]);
    expect(second).toEqual(["one\n", "two\n"]);

    // Double-detach is a no-op; removing the last subscription stops dispatch.
    router.detach(secondSubscription);
    router.detach(firstSubscription);
    await router.onChunk("demo", "four\n");
    expect(first).toEqual(["one\n", "two\n", "three\n"]);
    expect(second).toEqual(["one\n", "two\n"]);
  });

  it("routes structured activity and clean final text separately from legacy chunks", async () => {
    const events: OutputRouteEvent[] = [];
    const router = new OutputRouter({
      info() {},
      warn() {},
      error() {},
      debug() {}
    });
    router.attach("demo", (event) => {
      events.push(event);
    });

    await router.onActivity("demo", {
      type: "tool_call",
      title: "exec_command",
      toolCallId: "call-1"
    });
    await router.onFinal("demo", "Final answer.");

    expect(events).toEqual([
      {
        kind: "activity",
        sessionName: "demo",
        activity: {
          type: "tool_call",
          title: "exec_command",
          toolCallId: "call-1"
        }
      },
      {
        kind: "final",
        sessionName: "demo",
        text: "Final answer."
      }
    ]);
  });

  it("delivers turn-scoped subscriptions only the events of their own keyed turn", async () => {
    const router = new OutputRouter({ info() {}, warn() {}, error() {}, debug() {} });
    let executing: string | null = null;
    router.setTurnKeyResolver(() => executing);
    const session: string[] = [];
    const turnA: string[] = [];
    const turnB: string[] = [];
    router.attach("demo", (event) => {
      if (event.kind === "final") session.push(event.text);
    });
    router.attach("demo", (event) => {
      if (event.kind === "final") turnA.push(event.text);
    }, { turnKey: "a" });
    router.attach("demo", (event) => {
      if (event.kind === "final") turnB.push(event.text);
    }, { turnKey: "b" });

    await router.onFinal("demo", "unkeyed turn");
    executing = "a";
    await router.onFinal("demo", "turn a");
    executing = "b";
    await router.onFinal("demo", "turn b");
    executing = null;

    expect(session).toEqual(["unkeyed turn", "turn a", "turn b"]);
    expect(turnA).toEqual(["turn a"]);
    expect(turnB).toEqual(["turn b"]);
  });
});

