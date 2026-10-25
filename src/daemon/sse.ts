import type { ServerResponse } from "node:http";

/**
 * One SSE response with backpressure (plan H4).
 *
 * Frames go straight to the socket while it accepts them. Once `write()`
 * reports a full buffer, events wait in this stream's own queue until `drain`;
 * queued chunk deltas are coalesced (up to 64 KiB per frame). If the queue
 * would grow past `maxPendingBytes` (default 8 MiB), further live deltas
 * (`chunk`, `activity`) are dropped and replaced by one `gap` event carrying
 * the dropped counts. Every other event (final, question, complete, error,
 * result, done) is always delivered, in order. The producer (the runner's
 * stdout reader) is never blocked, so a slow consumer cannot stall a turn and
 * costs at most the cap in memory.
 */

export const DEFAULT_SSE_MAX_PENDING_BYTES = 8 * 1024 * 1024;
export const MIN_SSE_MAX_PENDING_BYTES = 64 * 1024;
export const MAX_COALESCED_CHUNK_CHARS = 64 * 1024;
const DROPPABLE_KINDS: ReadonlySet<string> = new Set(["chunk", "activity"]);
const FRAME_OVERHEAD_BYTES = 96;

export function sseMaxPendingBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PUPPENCLAW_SSE_MAX_PENDING_BYTES?.trim();
  return raw != null && /^\d{1,12}$/u.test(raw)
    ? Math.max(MIN_SSE_MAX_PENDING_BYTES, Number(raw))
    : DEFAULT_SSE_MAX_PENDING_BYTES;
}

export type SseEvent = { kind: string } & Record<string, unknown>;

type QueuedEvent = {
  event: SseEvent;
  /** Pre-rendered frame; chunk events are rendered when written so they can grow. */
  frame: string | null;
  bytes: number;
};

export type SseStreamStats = {
  writtenEvents: number;
  coalescedEvents: number;
  droppedEvents: number;
  droppedBytes: number;
  gaps: number;
  maxPendingBytesSeen: number;
};

function render(event: SseEvent): string {
  return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class SseEventStream {
  private readonly queue: QueuedEvent[] = [];
  private queuedBytes = 0;
  private waitingForDrain = false;
  private closed = false;
  private ended = false;
  private gap: { events: number; bytes: number } | null = null;
  readonly stats: SseStreamStats = {
    writtenEvents: 0,
    coalescedEvents: 0,
    droppedEvents: 0,
    droppedBytes: 0,
    gaps: 0,
    maxPendingBytesSeen: 0
  };

  constructor(
    private readonly raw: ServerResponse,
    private readonly options: { sessionName: string; maxPendingBytes: number }
  ) {
    raw.on("close", () => {
      this.closed = true;
      this.queue.length = 0;
      this.queuedBytes = 0;
    });
  }

  /** Events waiting for the socket to drain. */
  get pendingEvents(): number {
    return this.queue.length;
  }

  /** Bytes waiting in this stream's queue (not yet handed to the socket). */
  get pendingBytes(): number {
    return this.queuedBytes;
  }

  get isClosed(): boolean {
    return this.closed || this.raw.writableEnded || this.raw.destroyed;
  }

  send(event: SseEvent): void {
    if (this.ended || this.isClosed) {
      return;
    }
    if (this.waitingForDrain) {
      this.enqueue(event);
      return;
    }
    this.writeGapMarker();
    if (this.waitingForDrain) {
      this.enqueue(event);
      return;
    }
    this.writeFrame(render(event));
  }

  /** Writes an SSE comment only when nothing is waiting; a stalled client gets no filler. */
  heartbeat(): void {
    if (this.ended || this.isClosed || this.waitingForDrain || this.queue.length > 0) {
      return;
    }
    if (!this.raw.write(`: heartbeat ${Date.now()}\n\n`)) {
      this.waitingForDrain = true;
      this.raw.once("drain", this.onDrain);
    }
  }

  /**
   * Ends the response after everything queued, in order. Remaining frames are
   * handed to the socket at once; they are bounded by the cap plus the
   * never-dropped terminal events.
   */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.isClosed) {
      return;
    }
    if (this.gap != null) {
      this.raw.write(render(this.takeGapEvent()));
    }
    for (const item of this.queue.splice(0, this.queue.length)) {
      this.raw.write(item.frame ?? render(item.event));
      this.stats.writtenEvents += 1;
    }
    this.queuedBytes = 0;
    this.raw.end();
  }

  private enqueue(event: SseEvent): void {
    const droppable = DROPPABLE_KINDS.has(event.kind);
    const text = event.kind === "chunk" && typeof event.text === "string" ? event.text : null;
    const frame = text == null ? render(event) : null;
    const bytes = frame?.length ?? Buffer.byteLength(text ?? "") + FRAME_OVERHEAD_BYTES;
    if (droppable && this.queuedBytes + bytes > this.options.maxPendingBytes) {
      this.gap ??= { events: 0, bytes: 0 };
      this.gap.events += 1;
      this.gap.bytes += bytes;
      this.stats.droppedEvents += 1;
      this.stats.droppedBytes += bytes;
      return;
    }
    if (this.gap != null) {
      this.push({ event: this.takeGapEvent(), frame: null, bytes: FRAME_OVERHEAD_BYTES });
    }
    const last = this.queue.at(-1);
    if (
      text != null &&
      last != null &&
      last.event.kind === "chunk" &&
      last.event.sessionName === event.sessionName &&
      typeof last.event.text === "string" &&
      last.event.text.length + text.length <= MAX_COALESCED_CHUNK_CHARS
    ) {
      last.event = { ...last.event, text: `${last.event.text}${text}` };
      last.bytes += bytes - FRAME_OVERHEAD_BYTES;
      this.queuedBytes += bytes - FRAME_OVERHEAD_BYTES;
      this.stats.coalescedEvents += 1;
      this.notePending();
      return;
    }
    this.push({ event, frame, bytes });
  }

  private push(item: QueuedEvent): void {
    this.queue.push(item);
    this.queuedBytes += item.bytes;
    this.notePending();
  }

  private notePending(): void {
    this.stats.maxPendingBytesSeen = Math.max(this.stats.maxPendingBytesSeen, this.queuedBytes);
  }

  private takeGapEvent(): SseEvent {
    const gap = this.gap ?? { events: 0, bytes: 0 };
    this.gap = null;
    this.stats.gaps += 1;
    return {
      kind: "gap",
      sessionName: this.options.sessionName,
      droppedEvents: gap.events,
      droppedBytes: gap.bytes
    };
  }

  private writeGapMarker(): void {
    if (this.gap != null) {
      this.writeFrame(render(this.takeGapEvent()));
    }
  }

  private writeFrame(frame: string): void {
    this.stats.writtenEvents += 1;
    if (!this.raw.write(frame)) {
      this.waitingForDrain = true;
      this.raw.once("drain", this.onDrain);
    }
  }

  private readonly onDrain = (): void => {
    this.waitingForDrain = false;
    while (!this.waitingForDrain && this.queue.length > 0 && !this.isClosed) {
      const item = this.queue.shift()!;
      this.queuedBytes -= item.bytes;
      this.writeFrame(item.frame ?? render(item.event));
    }
  };
}
