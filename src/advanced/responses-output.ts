const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** Extract the final answer, excluding reasoning, refusals and tool results. */
export function responseOutputText(payload: unknown): string {
  const response = object(payload);
  if (typeof response?.output_text === "string") return response.output_text;
  if (!Array.isArray(response?.output)) return "";
  return response.output.flatMap((item: unknown) => {
    const message = object(item);
    if (message?.type !== "message" || message.role !== "assistant" || !Array.isArray(message.content)) return [];
    return message.content.flatMap((part: unknown) => {
      const content = object(part);
      return content?.type === "output_text" && typeof content.text === "string" ? [content.text] : [];
    });
  }).join("");
}

/** The final answer of a chat completion: the first choice's message content, without reasoning or refusals. */
export function chatCompletionOutputText(payload: unknown): string {
  const content = chatCompletionContent(payload);
  return typeof content === "string" ? content : "";
}

/**
 * The first choice's message content of a chat completion: its text, null when the message carries no content
 * (an empty completion), or undefined when the payload holds no first choice with a message whose content is text
 * or null (no chat completion at all).
 */
export function chatCompletionContent(payload: unknown): string | null | undefined {
  const choices = object(payload)?.choices;
  const message = Array.isArray(choices) ? object(object(choices[0])?.message) : null;
  if (!message) return undefined;
  const content = message.content;
  return typeof content === "string" ? content : content === null || content === undefined ? null : undefined;
}
