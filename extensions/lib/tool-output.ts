/**
 * Shared tool output cap. Wraps the exported Pi truncation helpers so every
 * tool caps bytes and lines the same way, and so a truncated result always
 * names where the full text lives.
 *
 * The cap is bytes, because that is the unit the host truncates in and the unit
 * its 50KB limit is stated in. The trailer that points at the full-output file
 * is part of the capped result, so the body is fitted into `cap - trailer`
 * instead of truncating to the cap and appending the trailer afterwards.
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

const LINE_MARKER = "... [truncated]";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Byte-exact prefix; a split trailing UTF-8 sequence is dropped, not kept whole. */
function headBytes(text: string, budget: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= budget) return text;
  let end = Math.max(0, Math.floor(budget));
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end = end - 1;
  return buf.subarray(0, end).toString("utf8");
}

/** Byte-exact suffix; a split leading UTF-8 sequence is dropped, not kept whole. */
function tailBytes(text: string, budget: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= budget) return text;
  let start = buf.length - Math.max(0, Math.floor(budget));
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start = start + 1;
  return buf.subarray(start).toString("utf8");
}

/**
 * Pi's truncateLine counts UTF-16 code units (the installed declaration calls
 * the argument `maxChars`) while the docs describe it as bytes, so it cannot
 * hold a byte budget for a line of astral characters. This trims the line
 * against bytes and keeps the marker inside the budget.
 */
function lineSnippet(line: string, keep: "head" | "tail", budget: number): string {
  if (byteLength(line) <= budget) return line;
  const markerBytes = byteLength(LINE_MARKER);
  if (budget <= markerBytes) return headBytes(LINE_MARKER, budget);
  return keep === "head"
    ? `${headBytes(line, budget - markerBytes)}${LINE_MARKER}`
    : `${LINE_MARKER}${tailBytes(line, budget - markerBytes)}`;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/** A trailing blank line is not the snippet a tail truncation is after. */
function lastContentLine(text: string): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index = index - 1) {
    const line = lines[index];
    if (line !== undefined && line.length > 0) return line;
  }
  return "";
}

interface BodySlice {
  content: string;
  outputLines: number;
}

function bodyWithin(text: string, keep: "head" | "tail", maxLines: number, budget: number): BodySlice {
  if (budget <= 0) return { content: "", outputLines: 0 };
  const limits = { maxBytes: budget, maxLines };
  const truncation = keep === "tail" ? truncateTail(text, limits) : truncateHead(text, limits);
  if (truncation.content.length > 0) {
    return { content: truncation.content, outputLines: truncation.outputLines };
  }
  const line = keep === "tail" ? lastContentLine(text) : firstLine(text);
  return { content: lineSnippet(line, keep, budget), outputLines: 1 };
}

interface Totals {
  totalLines: number;
  totalBytes: number;
}

interface Frame extends BodySlice {
  trailer: string;
}

function trailerFor(where: string, slice: BodySlice, totals: Totals): string {
  return (
    `\n\n[Output truncated: ${slice.outputLines} of ${totals.totalLines} lines ` +
    `(${formatSize(byteLength(slice.content))} of ${formatSize(totals.totalBytes)}).${where}]`
  );
}

function frameBytes(frame: Frame): number {
  return byteLength(frame.content) + byteLength(frame.trailer);
}

function frameAt(
  text: string,
  keep: "head" | "tail",
  maxLines: number,
  where: string,
  totals: Totals,
  budget: number,
): Frame {
  const slice = bodyWithin(text, keep, maxLines, budget);
  return { ...slice, trailer: trailerFor(where, slice, totals) };
}

/**
 * The body budget depends on the trailer length and the trailer reports the
 * body size, so the frame is solved to a fixed point. Each pass only shrinks
 * the budget, and the final pass drops the body entirely, which fits because
 * the trailer is shortest when it reports an empty body.
 */
function fitFrame(
  text: string,
  keep: "head" | "tail",
  maxLines: number,
  maxBytes: number,
  where: string,
  totals: Totals,
): Frame {
  let frame = frameAt(text, keep, maxLines, where, totals, maxBytes);
  for (let attempt = 0; attempt < 4 && frameBytes(frame) > maxBytes; attempt = attempt + 1) {
    frame = frameAt(text, keep, maxLines, where, totals, Math.max(0, maxBytes - byteLength(frame.trailer)));
  }
  return frameBytes(frame) <= maxBytes ? frame : frameAt(text, keep, maxLines, where, totals, 0);
}

export function capToolOutput(text: string, caps: ToolOutputCaps): CappedToolOutput {
  const maxBytes = caps.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = caps.maxLines ?? DEFAULT_MAX_LINES;
  const limits = { maxBytes, maxLines };
  const truncation =
    caps.keep === "tail" ? truncateTail(text, limits) : truncateHead(text, limits);
  if (!truncation.truncated) return { text, truncated: false };
  const outputPath = writeFullOutput(text, caps.label);
  const where = outputPath ? ` Full output saved to: ${outputPath}.` : "";
  const totals = { totalLines: truncation.totalLines, totalBytes: truncation.totalBytes };
  const frame = fitFrame(text, caps.keep, maxLines, maxBytes, where, totals);
  return { text: `${frame.content}${frame.trailer}`, truncated: true, outputPath };
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
