/**
 * Graceful shutdown for the daemon process.
 *
 * The first SIGTERM or SIGINT calls `close()` (stop accepting requests, close
 * the stores, release the state owner lease) and exits with code 0 once it
 * resolves. A second signal, a failing close, or a close that outlasts the
 * timeout exits with code 1, so a supervisor's stop request can never hang on
 * a stuck connection. Runner process groups are not touched here: they are
 * detached, and the boot reaper or the service manager handles them.
 */

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

export type ShutdownTarget = {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): void;
};

export type ShutdownHandlers = {
  uninstall: () => void;
  isShuttingDown: () => boolean;
};

export function shutdownTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PUPPENCLAW_SHUTDOWN_TIMEOUT_MS?.trim();
  if (raw == null || !/^\d{1,9}$/u.test(raw)) {
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
  return Math.max(1_000, Number(raw));
}

export function installShutdownHandlers(params: {
  close: () => Promise<void>;
  timeoutMs?: number;
  signals?: readonly NodeJS.Signals[];
  log?: (message: string) => void;
  target?: ShutdownTarget;
}): ShutdownHandlers {
  const target: ShutdownTarget = params.target ?? process;
  const log = params.log ?? ((message: string) => console.error(message));
  const timeoutMs = params.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const signals = params.signals ?? (["SIGTERM", "SIGINT"] as const);
  let shuttingDown = false;
  let exited = false;
  const exit = (code: number): void => {
    if (exited) {
      return;
    }
    exited = true;
    target.exit(code);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      log(`Received ${signal} during shutdown; exiting immediately.`);
      exit(1);
      return;
    }
    shuttingDown = true;
    log(`Received ${signal}; closing the daemon (timeout ${timeoutMs} ms).`);
    const timer = setTimeout(() => {
      log(`Daemon shutdown did not finish within ${timeoutMs} ms; exiting.`);
      exit(1);
    }, timeoutMs);
    timer.unref?.();
    void params.close().then(
      () => {
        clearTimeout(timer);
        log("Daemon closed.");
        exit(0);
      },
      (error: unknown) => {
        clearTimeout(timer);
        log(`Daemon shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        exit(1);
      }
    );
  };

  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const listener = (): void => onSignal(signal);
    listeners.set(signal, listener);
    target.on(signal, listener);
  }
  return {
    uninstall: () => {
      for (const [signal, listener] of listeners) {
        target.removeListener(signal, listener);
      }
      listeners.clear();
    },
    isShuttingDown: () => shuttingDown
  };
}
