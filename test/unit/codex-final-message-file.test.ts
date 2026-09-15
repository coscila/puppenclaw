import { execFileSync } from "node:child_process";
import {
  appendFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CODEX_FINAL_MESSAGE_BYTES,
  readCodexFinalMessageFile,
  unlinkCodexFinalMessageFile,
} from "../../src/manager/turn-diagnostics.js";

const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: string, flags: string | number) => void) | undefined,
  afterOpen: undefined as ((path: string, fd: number, flags: string | number) => void) | undefined,
  afterRead: undefined as (() => void) | undefined,
  readCalls: 0,
  bytesRead: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((path, flags, mode) => {
      hooks.beforeOpen?.(String(path), flags);
      const fd = actual.openSync(path, flags, mode);
      hooks.afterOpen?.(String(path), fd, flags);
      return fd;
    }) as typeof actual.openSync,
    readSync: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
      const count = actual.readSync(fd, buffer, offset, length, position);
      hooks.readCalls += 1;
      hooks.bytesRead += count;
      hooks.afterRead?.();
      return count;
    },
  };
});

const roots: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "puppenclaw-safe-final-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  hooks.beforeOpen = undefined;
  hooks.afterOpen = undefined;
  hooks.afterRead = undefined;
  hooks.readCalls = 0;
  hooks.bytesRead = 0;
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded Codex final-message reader", () => {
  it("reads ordinary UTF-8 and empty final files without stripping content", async () => {
    const root = directory();
    const file = join(root, "final.txt");
    writeFileSync(file, "Full verified answer — αβγ\n");
    await expect(readCodexFinalMessageFile(file)).resolves.toBe("Full verified answer — αβγ\n");
    writeFileSync(file, "");
    await expect(readCodexFinalMessageFile(file)).resolves.toBe("");
  });

  it("accepts exactly 2 MiB but rejects larger byte lengths before any read, never truncating", async () => {
    const file = join(directory(), "final.txt");
    const content = "é".repeat(MAX_CODEX_FINAL_MESSAGE_BYTES / 2);
    writeFileSync(file, content);
    await expect(readCodexFinalMessageFile(file)).resolves.toBe(content);
    hooks.readCalls = 0;
    appendFileSync(file, "x");
    await expect(readCodexFinalMessageFile(file)).rejects.toMatchObject({ code: "EFBIG" });
    expect(hooks.readCalls).toBe(0);
  });

  it("rejects absent files, directories, leaf symlinks and hardlinks without exposing target text", async () => {
    const root = directory();
    const secret = join(directory(), "private-key.txt");
    writeFileSync(secret, "SECRET-OUTSIDE-WORKSPACE");
    await expect(readCodexFinalMessageFile(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readCodexFinalMessageFile(root)).rejects.toMatchObject({ code: "EUNSAFEFILE" });
    symlinkSync(secret, join(root, "symlink"));
    await expect(readCodexFinalMessageFile(join(root, "symlink"))).rejects.toMatchObject({ code: "EUNSAFEFILE" });
    linkSync(secret, join(root, "hardlink"));
    await expect(readCodexFinalMessageFile(join(root, "hardlink"))).rejects.toMatchObject({ code: "EUNSAFEFILE" });
    expect(hooks.readCalls).toBe(0);
    expect(readFileSync(secret, "utf8")).toBe("SECRET-OUTSIDE-WORKSPACE");
  });

  it.skipIf(process.platform !== "linux")("rejects a symlink at any ancestor, not only the final file", async () => {
    const root = directory();
    const outside = directory();
    mkdirSync(join(outside, "child"));
    writeFileSync(join(outside, "child", "final.txt"), "SECRET");
    symlinkSync(outside, join(root, "linked-parent"));
    await expect(readCodexFinalMessageFile(join(root, "linked-parent", "child", "final.txt"))).rejects.toThrow();
    expect(hooks.readCalls).toBe(0);
  });

  it.skipIf(process.platform !== "linux")("rejects FIFOs without waiting for a writer or opening a blocking read", async () => {
    const fifo = join(directory(), "final.pipe");
    execFileSync("mkfifo", [fifo]);
    expect(lstatSync(fifo).isFIFO()).toBe(true);
    await expect(readCodexFinalMessageFile(fifo)).rejects.toMatchObject({ code: "EUNSAFEFILE" });
    expect(hooks.readCalls).toBe(0);
  });

  it.skipIf(process.platform !== "linux")("pins the original safe directory when a parent becomes an outside symlink after open", async () => {
    const root = directory();
    const outside = directory();
    const parent = join(root, "parent");
    mkdirSync(parent);
    writeFileSync(join(parent, "final.txt"), "SAFE ORIGINAL ANSWER");
    writeFileSync(join(outside, "final.txt"), "SECRET OUTSIDE ANSWER");
    hooks.afterOpen = (path) => {
      if (!path.endsWith("/parent")) return;
      hooks.afterOpen = undefined;
      renameSync(parent, join(root, "pinned-original"));
      symlinkSync(outside, parent);
    };
    await expect(readCodexFinalMessageFile(join(parent, "final.txt"))).resolves.toBe("SAFE ORIGINAL ANSWER");
    expect(readFileSync(join(outside, "final.txt"), "utf8")).toBe("SECRET OUTSIDE ANSWER");
  });

  it.skipIf(process.platform !== "linux")("rejects a leaf swapped to a symlink between lstat and open", async () => {
    const root = directory();
    const file = join(root, "final.txt");
    const secret = join(directory(), "secret.txt");
    writeFileSync(file, "SAFE");
    writeFileSync(secret, "SECRET");
    hooks.beforeOpen = (path) => {
      if (!path.endsWith("/final.txt")) return;
      hooks.beforeOpen = undefined;
      renameSync(file, join(root, "old-final.txt"));
      symlinkSync(secret, file);
    };
    await expect(readCodexFinalMessageFile(file)).rejects.toMatchObject({ code: "ELOOP" });
    expect(hooks.readCalls).toBe(0);
  });

  it.skipIf(process.platform !== "linux")("does not follow a leaf replaced by a symlink after its descriptor was opened", async () => {
    const root = directory();
    const file = join(root, "final.txt");
    const secret = join(directory(), "secret.txt");
    writeFileSync(file, "SAFE ORIGINAL");
    writeFileSync(secret, "SECRET");
    hooks.afterOpen = (path) => {
      if (!path.endsWith("/final.txt")) return;
      hooks.afterOpen = undefined;
      renameSync(file, join(root, "old-final.txt"));
      symlinkSync(secret, file);
    };
    await expect(readCodexFinalMessageFile(file)).resolves.toBe("SAFE ORIGINAL");
  });

  it("rejects a file that grows after the size check with at most 2 MiB plus one byte read", async () => {
    const file = join(directory(), "final.txt");
    writeFileSync(file, "initial answer");
    hooks.afterRead = () => {
      hooks.afterRead = undefined;
      appendFileSync(file, "x".repeat(MAX_CODEX_FINAL_MESSAGE_BYTES));
    };
    await expect(readCodexFinalMessageFile(file)).rejects.toMatchObject({ code: "EFBIG" });
    expect(hooks.bytesRead).toBe(MAX_CODEX_FINAL_MESSAGE_BYTES + 1);
  });

  it("rejects below-limit changes during reading instead of returning a mixed answer", async () => {
    const file = join(directory(), "final.txt");
    writeFileSync(file, "initial answer");
    hooks.afterRead = () => {
      hooks.afterRead = undefined;
      appendFileSync(file, " added concurrently");
    };
    await expect(readCodexFinalMessageFile(file)).rejects.toMatchObject({ code: "EFILECHANGED" });
  });

  it("retains bounded ordinary-file reads on a non-Linux host", async () => {
    const file = join(directory(), "final.txt");
    writeFileSync(file, "PORTABLE ANSWER");
    vi.stubGlobal("process", { ...process, platform: "win32" });
    await expect(readCodexFinalMessageFile(file)).resolves.toBe("PORTABLE ANSWER");
    writeFileSync(file, "x".repeat(MAX_CODEX_FINAL_MESSAGE_BYTES + 1));
    await expect(readCodexFinalMessageFile(file)).rejects.toMatchObject({ code: "EFBIG" });
  });

  it("does not expose supplied private paths in surfaced read errors", async () => {
    const path = join(directory(), "SECRET-PATH-NAME");
    await expect(readCodexFinalMessageFile(path)).rejects.toMatchObject({
      code: "ENOENT", message: "Final assistant message could not be safely read (ENOENT).",
    });
  });

  it.skipIf(process.platform !== "linux")("cleans a regular final file, but retains symlinked and hardlinked targets", async () => {
    const root = directory();
    const file = join(root, "final.txt");
    const outside = join(directory(), "secret.txt");
    writeFileSync(file, "SAFE");
    await expect(unlinkCodexFinalMessageFile(file)).resolves.toBe(true);
    await expect(unlinkCodexFinalMessageFile(file)).resolves.toBe(false);
    writeFileSync(outside, "SECRET");
    symlinkSync(outside, file);
    await expect(unlinkCodexFinalMessageFile(file)).resolves.toBe(false);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    rmSync(file);
    linkSync(outside, file);
    await expect(unlinkCodexFinalMessageFile(file)).resolves.toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("SECRET");
  });

  it.skipIf(process.platform !== "linux")("does not unlink an outside file if the parent was replaced after reading", async () => {
    const root = directory();
    const outside = directory();
    const parent = join(root, "parent");
    mkdirSync(parent);
    writeFileSync(join(parent, "final.txt"), "SAFE");
    writeFileSync(join(outside, "final.txt"), "SECRET");
    await expect(readCodexFinalMessageFile(join(parent, "final.txt"))).resolves.toBe("SAFE");
    renameSync(parent, join(root, "old-parent"));
    symlinkSync(outside, parent);
    await expect(unlinkCodexFinalMessageFile(join(parent, "final.txt"))).resolves.toBe(false);
    expect(readFileSync(join(outside, "final.txt"), "utf8")).toBe("SECRET");
    expect(readFileSync(join(root, "old-parent", "final.txt"), "utf8")).toBe("SAFE");
  });

  it.skipIf(process.platform !== "linux")("pins cleanup to the original directory during a concurrent parent swap", async () => {
    const root = directory();
    const outside = directory();
    const parent = join(root, "parent");
    mkdirSync(parent);
    writeFileSync(join(parent, "final.txt"), "SAFE");
    writeFileSync(join(outside, "final.txt"), "SECRET");
    hooks.afterOpen = (path) => {
      if (!path.endsWith("/parent")) return;
      hooks.afterOpen = undefined;
      renameSync(parent, join(root, "old-parent"));
      symlinkSync(outside, parent);
    };
    await expect(unlinkCodexFinalMessageFile(join(parent, "final.txt"))).resolves.toBe(true);
    expect(readFileSync(join(outside, "final.txt"), "utf8")).toBe("SECRET");
    expect(() => lstatSync(join(root, "old-parent", "final.txt"))).toThrow();
  });

  it("retains files on non-Linux platforms when safe descriptor-relative cleanup is unavailable", async () => {
    const file = join(directory(), "final.txt");
    writeFileSync(file, "PORTABLE ANSWER");
    vi.stubGlobal("process", { ...process, platform: "win32" });
    await expect(unlinkCodexFinalMessageFile(file)).resolves.toBe(false);
    expect(readFileSync(file, "utf8")).toBe("PORTABLE ANSWER");
  });
});
