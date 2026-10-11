/** Native Fable thinking blocks must never be replayed into another generation. */
export function requiresFreshClaudeTranscript(previous: string | undefined, next: string): boolean {
  const normalize = (value: string | undefined) => value?.trim().toLowerCase().replace(/\[.*\]$/, "");
  const before = normalize(previous);
  const after = normalize(next);
  return before !== after && Boolean(before?.includes("fable") || after?.includes("fable"));
}

/** ACP keeps the legacy Opus preset under its default selector. Provider identity remains unchanged. */
export function claudeAcpModelSelector(model: string): string { return model === "claude-opus-4-7" ? "default" : model; }
