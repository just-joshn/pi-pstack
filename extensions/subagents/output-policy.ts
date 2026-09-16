/**
 * Child output caps, truncation trailer, and persist-to-disk policy. Split out
 * of child-runner.ts so the runner keeps its file-size budget.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_LINES, formatSize, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";

export function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Default output cap. Env: PSTACK_MAX_OUTPUT_BYTES (4KiB–2MiB). */
export const MAX_OUTPUT_BYTES = parsePositiveInt(
  process.env.PSTACK_MAX_OUTPUT_BYTES,
  50 * 1024,
  4 * 1024,
  2 * 1024 * 1024,
);

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Persist full text under outDir; return path.
 * Two children sharing a role (a common parallel-spawn pattern) finish in the
 * same millisecond and would mint the same `${tag}-${timestamp}.txt`, so a
 * plain write would silently clobber the first child's persisted output. Write
 * exclusively (`wx`) and retry on EEXIST instead of overwriting.
 */
export function persistOutputSummary(fullText: string, outDir: string, tag: string): string {
  mkdirSync(outDir, { recursive: true });
  const safe = tag.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "child";
  let attempt = 0;
  while (attempt < 20) {
    const path = join(outDir, `${safe}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.txt`);
    try {
      writeFileSync(path, fullText, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        attempt = attempt + 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`failed to mint a unique output path under ${outDir} after 20 attempts`);
}

export function truncate(
  text: string,
  opts?: { maxBytes?: number; persistDir?: string; tag?: string },
): { text: string; outputPath?: string } {
  const max = opts?.maxBytes ?? MAX_OUTPUT_BYTES;
  const truncation = truncateHead(text, { maxBytes: max, maxLines: DEFAULT_MAX_LINES });
  if (!truncation.truncated) return { text };
  // truncateHead drops a first line longer than the byte cap entirely; fall back
  // to truncateLine so a single-line child answer still yields a visible snippet.
  const content = truncation.firstLineExceedsLimit ? truncateLine(text, max).text : truncation.content;
  let outputPath: string | undefined;
  if (opts?.persistDir) {
    try {
      outputPath = persistOutputSummary(text, opts.persistDir, opts.tag ?? "out");
    } catch {
      /* ignore disk errors; still truncate and return path-less result */
      outputPath = undefined;
    }
  }
  const outputLines = truncation.firstLineExceedsLimit ? Math.max(1, truncation.outputLines) : truncation.outputLines;
  const counts = `${outputLines} of ${truncation.totalLines} lines (${formatSize(Buffer.byteLength(content, "utf8"))} of ${formatSize(truncation.totalBytes)})`;
  const trailer = outputPath
    ? `\n\n[Output truncated: ${counts}. Full output: ${outputPath}]`
    : `\n\n[Output truncated: ${counts}. Set persistOutput:true or PSTACK_PERSIST_OUTPUT=1 to save full text under .pi/pstack-child-output/.]`;
  return { text: `${content}${trailer}`, outputPath };
}

export function appendCapped(current: string, chunk: string, max = MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(current, "utf8") >= max) return current;
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= max) return next;
  return truncate(next, { maxBytes: max }).text;
}

/** Persist full output when explicitly requested, env on, or long-running child (timeout >= 5m). Default-on for long children. */
export function shouldPersistOutput(input: { persistOutput?: boolean; timeoutMs?: number }): boolean {
  if (input.persistOutput === true) return true;
  if (input.persistOutput === false) return false;
  const env = process.env.PSTACK_PERSIST_OUTPUT;
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return timeout >= 5 * 60 * 1000;
}
