import { scanFrames } from "./scan.mjs";

export const MAX_FILE_LINES = 800;
export const MAX_FUNCTION_LINES = 50;
export const MAX_CONTROL_DEPTH = 4;

const TEXT_RULES = [
  { id: "console.log", re: /console\.log\b/g, detail: "console.log statement" },
  {
    id: "mutation",
    re: /\.(?:push|splice|sort|reverse|fill|copyWithin|pop|shift|unshift)\s*\(/g,
    detail: "in-place mutating call",
  },
  { id: "delete", re: /\bdelete\s+[A-Za-z_$]/g, detail: "delete operator" },
  { id: "increment", re: /(?:\+\+|--)/g, detail: "increment/decrement operator" },
];

const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

const SECRET_RULES = [
  { id: "secret", re: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}\b/g, detail: "openai-style key" },
  { id: "secret", re: /\bghp_[A-Za-z0-9]{20,}\b/g, detail: "github token" },
  { id: "secret", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, detail: "github fine-grained token" },
  { id: "secret", re: /\bAKIA[0-9A-Z]{16}\b/g, detail: "aws access key id" },
];

function matchesWithLines(text, lineAt, re, id, detail) {
  return [...text.matchAll(re)].map((match) => ({
    rule: id,
    line: lineAt(match.index ?? 0),
    detail,
  }));
}

function textViolations(scan, source) {
  return [
    ...TEXT_RULES.flatMap((rule) => matchesWithLines(scan.clean, scan.lineAt, rule.re, rule.id, rule.detail)),
    ...matchesWithLines(scan.clean, scan.lineAt, EMPTY_CATCH, "empty-catch", "empty catch block"),
    // Secrets live inside strings, and sanitize() masks string contents, so secret rules read the raw source.
    ...SECRET_RULES.flatMap((rule) => matchesWithLines(source, scan.lineAt, rule.re, rule.id, rule.detail)),
  ];
}

function functionViolations(frames) {
  return frames
    .filter((frame) => (frame.kind === "function" || frame.kind === "callable") && frame.end !== null)
    .filter((frame) => frame.endLine - frame.startLine + 1 > MAX_FUNCTION_LINES)
    .map((frame) => ({
      rule: "function>50",
      line: frame.startLine,
      detail: `${frame.name || "(anon)"} spans ${frame.endLine - frame.startLine + 1} lines`,
    }));
}

function nestingViolations(frames) {
  return frames
    .filter((frame) => frame.kind === "control" && frame.controlDepth >= MAX_CONTROL_DEPTH)
    .map((frame) => ({
      rule: "nesting>4",
      line: frame.startLine,
      detail: `${frame.name} at control depth ${frame.controlDepth + 1}`,
    }));
}

function fileLengthViolations(source) {
  const lines = source.split("\n").length;
  if (lines <= MAX_FILE_LINES) return [];
  return [{ rule: "file>800", line: 1, detail: `${lines} lines` }];
}

export function auditSource(source, options = {}) {
  if (typeof source !== "string") {
    throw new TypeError(`auditSource expects source text, received ${typeof source}`);
  }
  const scan = scanFrames(source);
  const severity = options.owned === false ? "warn" : "error";
  const violations = [
    ...fileLengthViolations(source),
    ...textViolations(scan, source),
    ...functionViolations(scan.frames),
    ...nestingViolations(scan.frames),
  ];
  return violations
    .map((violation) => ({ ...violation, severity }))
    .toSorted((a, b) => (a.line === b.line ? a.rule.localeCompare(b.rule) : a.line - b.line));
}
