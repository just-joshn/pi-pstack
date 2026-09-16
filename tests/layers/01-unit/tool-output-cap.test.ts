import { expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { capToolOutput } from "../../../extensions/lib/tool-output.ts";

const CAP = 51200;
const TRAILER = "\n\n[Output truncated:";
const MARKER = "... [truncated]";

type WriteFailure = "none" | "eexist-once" | "eexist-always" | "deny";
let writeFailure: WriteFailure = "none";

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

// capToolOutput hides no seam for the full-output write, so the write itself has
// to fail for the retry and no-pointer paths to be observable.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (writeFailure === "deny") throw fsError("EACCES");
      if (writeFailure === "eexist-always") throw fsError("EEXIST");
      if (writeFailure === "eexist-once") {
        writeFailure = "none";
        throw fsError("EEXIST");
      }
      return actual.writeFileSync(...args);
    },
  };
});

function withWriteFailure(kind: WriteFailure, run: () => void): void {
  writeFailure = kind;
  try {
    run();
  } finally {
    writeFailure = "none";
  }
}

const BODIES: Record<string, string> = {
  "60KB single-line ascii": "a".repeat(60000),
  "astral emoji single line": "\u{1F600}".repeat(20000),
  "near-cap multi-line": Array.from(
    { length: 1200 },
    (_unused, index) => `line-${String(index).padStart(4, "0")}-${"y".repeat(40)}`,
  ).join("\n"),
  "one byte over the cap": "b".repeat(CAP + 1),
};

const SINGLE_LINE = new Set(["60KB single-line ascii", "astral emoji single line", "one byte over the cap"]);

function frameOf(text: string): { content: string; trailer: string } {
  const at = text.indexOf(TRAILER);
  return { content: text.slice(0, at), trailer: text.slice(at) };
}

for (const keep of ["head", "tail"] as const) {
  for (const [name, body] of Object.entries(BODIES)) {
    test(`capToolOutput keeps ${name} within ${CAP} bytes (${keep})`, () => {
      const out = capToolOutput(body, { keep, label: `cap-${keep}` });
      const bytes = Buffer.byteLength(out.text, "utf8");
      expect(out.truncated).toBe(true);
      expect(bytes <= CAP, `${name}/${keep} returned ${bytes} bytes against the ${CAP}-byte cap`).toBeTruthy();
      expect(bytes >= (SINGLE_LINE.has(name) ? CAP - 8 : CAP - 64), `${name}/${keep} returned ${bytes} bytes and left the budget unfilled`).toBeTruthy();
      const { content, trailer } = frameOf(out.text);
      expect(trailer.startsWith(TRAILER), `${name}/${keep} lost the truncation trailer`).toBeTruthy();
      expect(typeof out.outputPath).toBe("string");
      expect(trailer.includes(out.outputPath as string), `${name}/${keep} trailer does not name the full-output file`).toBeTruthy();
      expect(readFileSync(out.outputPath as string, "utf8")).toBe(body);
      expect(content.includes("\uFFFD"), `${name}/${keep} split a UTF-8 sequence`).toBe(false);
    });
  }
}

test("capToolOutput fills the byte budget exactly when the body is ascii", () => {
  const out = capToolOutput("a".repeat(60000), { keep: "head", label: "cap-exact" });
  expect(Buffer.byteLength(out.text, "utf8")).toBe(CAP);
});

test("capToolOutput returns a body at or under the cap untouched", () => {
  expect(capToolOutput("small", { keep: "head", label: "cap-small" })).toEqual({
    text: "small",
    truncated: false,
  });
  const exact = "c".repeat(CAP);
  expect(capToolOutput(exact, { keep: "head", label: "cap-exact-ok" })).toEqual({
    text: exact,
    truncated: false,
  });
});

test("capToolOutput drops the body and names the fallback label when the cap is only as wide as the marker", () => {
  const body = "x".repeat(40);
  const out = capToolOutput(body, { keep: "head", label: "", maxBytes: MARKER.length, maxLines: 0 });
  expect(out.truncated).toBe(true);
  expect(out.text).toBe(`${TRAILER} 0 of 1 lines (0B of 40B). Full output saved to: ${out.outputPath}.]`);
  expect(out.outputPath?.includes("pstack-tool-output-")).toBe(true);
  expect(readFileSync(out.outputPath as string, "utf8")).toBe(body);
});

test("capToolOutput trims a head line whose cut lands inside a multi-byte character", () => {
  const body = `a${"\u{1F600}".repeat(10)}`;
  const out = capToolOutput(body, { keep: "head", label: "head-cont", maxBytes: 18, maxLines: 0 });
  expect(out.truncated).toBe(true);
  expect(out.text).toBe(`${TRAILER} 0 of 1 lines (0B of 41B). Full output saved to: ${out.outputPath}.]`);
  expect(out.text.includes("\uFFFD")).toBe(false);
  expect(readFileSync(out.outputPath as string, "utf8")).toBe(body);
});

test("capToolOutput drops a head cut that would split the first character", () => {
  const body = `\u00e9${"\u{1F600}".repeat(10)}`;
  const out = capToolOutput(body, { keep: "head", label: "head-zero", maxBytes: 16, maxLines: 0 });
  expect(out.truncated).toBe(true);
  expect(out.text).toBe(`${TRAILER} 0 of 1 lines (0B of 42B). Full output saved to: ${out.outputPath}.]`);
  expect(out.text.includes("\uFFFD")).toBe(false);
  expect(readFileSync(out.outputPath as string, "utf8")).toBe(body);
});

test("capToolOutput keeps the tail of one long line and never splits a character", () => {
  const body = `a${"\u{1F600}".repeat(100)}`;
  const out = capToolOutput(body, { keep: "tail", label: "tail-long", maxBytes: 300, maxLines: 0 });
  const { content } = frameOf(out.text);
  expect(out.truncated).toBe(true);
  expect(content.startsWith(MARKER)).toBe(true);
  expect(content.length > MARKER.length).toBe(true);
  expect(out.text.includes("of 401B")).toBe(true);
  expect(out.text.includes("\uFFFD")).toBe(false);
  expect(Buffer.byteLength(out.text, "utf8") <= 300, `returned ${Buffer.byteLength(out.text, "utf8")} bytes`).toBe(true);
  expect(readFileSync(out.outputPath as string, "utf8")).toBe(body);
});

test("capToolOutput drops a tail cut that would start inside the last character", () => {
  const body = `a${"\u{1F600}".repeat(4)}`;
  const out = capToolOutput(body, { keep: "tail", label: "tail-zero", maxBytes: 16, maxLines: 0 });
  expect(out.truncated).toBe(true);
  expect(out.text).toBe(`${TRAILER} 0 of 1 lines (0B of 17B). Full output saved to: ${out.outputPath}.]`);
  expect(out.text.includes("\uFFFD")).toBe(false);
  expect(readFileSync(out.outputPath as string, "utf8")).toBe(body);
});

test("capToolOutput keeps a short last line whole when the cap cannot hold the full text", () => {
  const body = `${"a".repeat(500)}\nshort`;
  const out = capToolOutput(body, { keep: "tail", label: "tail-short", maxBytes: 600, maxLines: 0 });
  expect(out.truncated).toBe(true);
  expect(out.text.startsWith("short")).toBe(true);
  expect(out.text.includes("1 of 2 lines (5B of 506B)")).toBe(true);
  expect(readFileSync(out.outputPath as string, "utf8")).toBe(body);
});

test("capToolOutput skips the trailing blank line when it has to keep a tail line", () => {
  const body = `${"x".repeat(600)}\nshort\n`;
  const out = capToolOutput(body, { keep: "tail", label: "tail-blank", maxBytes: 700, maxLines: 0 });
  expect(out.truncated).toBe(true);
  expect(out.text.startsWith("short")).toBe(true);
  expect(out.text.includes("1 of 2 lines (5B of 607B)")).toBe(true);
  expect(readFileSync(out.outputPath as string, "utf8")).toBe(body);
});

test("capToolOutput returns only the trailer for a body of blank lines", () => {
  const body = "\n\n";
  const out = capToolOutput(body, { keep: "tail", label: "tail-blank-only", maxBytes: 600, maxLines: 0 });
  expect(out.truncated).toBe(true);
  expect(out.text).toBe(`${TRAILER} 1 of 2 lines (0B of 2B). Full output saved to: ${out.outputPath}.]`);
  expect(readFileSync(out.outputPath as string, "utf8")).toBe(body);
});

test("capToolOutput reports truncation without a file pointer when the full-output write is denied", () => {
  withWriteFailure("deny", () => {
    const body = "d".repeat(60000);
    const out = capToolOutput(body, { keep: "head", label: "denied" });
    expect(out.truncated).toBe(true);
    expect(out.outputPath).toBe(undefined);
    expect(out.text.includes(TRAILER)).toBe(true);
    expect(out.text.endsWith(").]")).toBe(true);
    expect(out.text.includes("Full output saved")).toBe(false);
    expect(Buffer.byteLength(out.text, "utf8") <= CAP).toBe(true);
  });
});

test("capToolOutput retries the full-output write after a filename collision", () => {
  withWriteFailure("eexist-once", () => {
    const body = "e".repeat(60000);
    const out = capToolOutput(body, { keep: "head", label: "collision" });
    expect(out.truncated).toBe(true);
    expect(typeof out.outputPath).toBe("string");
    expect(readFileSync(out.outputPath as string, "utf8")).toBe(body);
  });
});

test("capToolOutput gives up and omits the file pointer after twenty colliding filenames", () => {
  withWriteFailure("eexist-always", () => {
    const body = "f".repeat(60000);
    const out = capToolOutput(body, { keep: "head", label: "always-collide" });
    expect(out.truncated).toBe(true);
    expect(out.outputPath).toBe(undefined);
    expect(out.text.includes("Full output saved")).toBe(false);
  });
});
