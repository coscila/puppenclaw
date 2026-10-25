import { access, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdvancedStore } from "../src/advanced/store.js";

describe("advanced.sqlite connection settings", () => {
  it("opens in WAL mode with synchronous=NORMAL and secure_delete=FAST, keeping the files private", async () => {
    const dir = await mkdtemp(join(tmpdir(), "advanced-pragmas-"));
    const store = await AdvancedStore.open(dir);
    try {
      // synchronous: 1 = NORMAL; secure_delete: 2 = FAST.
      expect(store.pragmas()).toEqual({ journalMode: "wal", synchronous: 1, secureDelete: 2 });
      expect(store.countJobsByState().running).toBe(0);
      await access(join(dir, "advanced.sqlite-wal"));
      if (process.platform !== "win32") {
        expect((await stat(join(dir, "advanced.sqlite"))).mode & 0o777).toBe(0o600);
        expect((await stat(join(dir, "advanced.sqlite-wal"))).mode & 0o777).toBe(0o600);
      }
    } finally {
      store.close();
    }
    // The mode is persistent and a plain connection (as an older daemon opens it) still works.
    const { DatabaseSync } = await import(`node${":sqlite"}`);
    const plain = new DatabaseSync(join(dir, "advanced.sqlite"));
    try {
      expect(plain.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(plain.prepare("SELECT count(*) AS jobs FROM jobs").get()).toEqual({ jobs: 0 });
    } finally {
      plain.close();
    }
  });
});
