/**
 * Child process for the crash tests of the P1 AdvancedStore (bundled with esbuild).
 *
 *   node child.js <dir> <jobId> <first> <count> <batches> <crashAt|0>
 *
 * Settles items <first>..<first+count-1> of an existing job in <batches> group
 * commits. With crashAt > 0 a temporary trigger SIGKILLs this process on the
 * crashAt-th outbox insert, i.e. inside a batch transaction after some of its
 * results, receipts and outbox rows are already written but before COMMIT.
 */
import { AdvancedStore } from "../../src/advanced/store.js";
import type { UsageReceipt } from "../../src/advanced/types.js";

const [dir, jobArg, firstRaw, countRaw, batchesRaw, crashRaw] = process.argv.slice(2);
const jobId = jobArg!;
const first = Number(firstRaw), count = Number(countRaw), batches = Number(batchesRaw), crashAt = Number(crashRaw);

let inserts = 0;
const store = await AdvancedStore.open(dir!, {
  commitWindowMs: 50,
  onConnection: (db) => {
    db.function("crash_point", () => {
      inserts += 1;
      if (crashAt > 0 && inserts >= crashAt) {
        process.kill(process.pid, "SIGKILL");
        for (;;) { /* the signal ends the process inside the open transaction */ }
      }
      return 0;
    });
    db.exec("CREATE TEMP TRIGGER crash_on_outbox AFTER INSERT ON outbox BEGIN SELECT crash_point(); END;");
  }
});

const perBatch = Math.ceil(count / batches);
for (let batch = 0; batch < batches; batch += 1) {
  const writes: Promise<void>[] = [];
  for (let index = first + batch * perBatch; index < Math.min(first + count, first + (batch + 1) * perBatch); index += 1) {
    const itemId = `i${index}`;
    const receipt: UsageReceipt = {
      version: 1, requestId: `${jobId}-${itemId}`, parentSessionName: "parent", sessionName: "parent", attemptId: "attempt", jobId, itemId,
      providerId: "local", model: "served-model", role: "subagent", promptSha256: "a".repeat(64), state: "completed",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 12, quality: "measured" },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempt: 1, serverFingerprint: "fp_child", settingsSha256: "c".repeat(64)
    };
    writes.push(store.settleItem(jobId, { id: itemId, state: "completed", output: `answer ${index}`, providerId: "local", model: "served-model", promptSha256: "a".repeat(64), usage: receipt.usage, attempts: 1 },
      { receipt, event: true, persist: true, fallbackFingerprint: "unused", fallbackSettingsSha256: "unused", instrumentDigest: null }));
  }
  store.flush();
  await Promise.all(writes);
}
store.close();
process.exit(0);
