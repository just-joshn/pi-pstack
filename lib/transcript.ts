import { isRecord } from "./validation.ts";

function sessionMessages(raw: string) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line))
    .flatMap((entry) =>
      isRecord(entry) && entry.type === "message" && isRecord(entry.message) ? [entry.message] : [],
    );
}
export function blindTranscript(raw: string, model: string) {
  return sessionMessages(raw)
    .map((m) =>
      JSON.stringify({
        role: m.role,
        content: m.content,
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        isError: m.isError,
      })
        .replaceAll(model, "[redacted-model]")
        .replaceAll(model.split("/").slice(1).join("/"), "[redacted-model]"),
    )
    .join("\n");
}
export function readPaths(raw: string) {
  const messages = sessionMessages(raw);
  const succeeded = new Set(
    messages
      .filter((m) => m.role === "toolResult" && m.isError !== true && m.toolCallId)
      .map((m) => m.toolCallId),
  );
  const readPath = (call: unknown) =>
    isRecord(call) &&
    call.type === "toolCall" &&
    call.name === "read" &&
    isRecord(call.arguments) &&
    typeof call.arguments.path === "string" &&
    succeeded.has(call.id)
      ? [call.arguments.path]
      : [];
  return messages.flatMap((m) => (Array.isArray(m.content) ? m.content.flatMap(readPath) : []));
}
