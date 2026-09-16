/**
 * Shared tool output cap. Wraps the exported Pi truncation helpers so every
 * tool caps bytes and lines the same way, and so a truncated result always
 * names where the full text lives.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateLine,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

export interface ToolOutputCaps {
  keep: "head" | "tail";
  label: string;
  maxBytes?: number;
  maxLines?: number;
}

export interface CappedToolOutput {
  text: string;
  truncated: boolean;
  outputPath?: string | undefined;
}

function writeFullOutput(text: string, label: string): string | undefined {
  const safe = label.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "tool-output";
  for (let attempt = 0; attempt < 20; attempt = attempt + 1) {
    const path = join(
      tmpdir(),
      `pstack-${safe}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.txt`,
    );
    try {
      writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      return undefined;
    }
  }
  return undefined;
}

export function capToolOutput(text: string, caps: ToolOutputCaps): CappedToolOutput {
  const maxBytes = caps.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = caps.maxLines ?? DEFAULT_MAX_LINES;
  const limits = { maxBytes, maxLines };
  const truncation =
    caps.keep === "tail" ? truncateTail(text, limits) : truncateHead(text, limits);
  if (!truncation.truncated) return { text, truncated: false };
  // truncateHead drops a first line longer than the byte cap entirely, and
  // truncateTail can drop a whole oversized line; fall back to truncateLine so a
  // single-line body still yields a visible snippet.
  const degenerates = caps.keep === "head" ? truncation.firstLineExceedsLimit : truncation.outputBytes === 0;
  const content = degenerates ? truncateLine(text, maxBytes).text : truncation.content;
  const outputPath = writeFullOutput(text, caps.label);
  const where = outputPath ? ` Full output saved to: ${outputPath}.` : "";
  const outputLines = degenerates ? Math.max(1, truncation.outputLines) : truncation.outputLines;
  const trailer =
    `\n\n[Output truncated: ${outputLines} of ${truncation.totalLines} lines ` +
    `(${formatSize(Buffer.byteLength(content, "utf8"))} of ${formatSize(truncation.totalBytes)}).${where}]`;
  return { text: `${content}${trailer}`, truncated: true, outputPath };
}
