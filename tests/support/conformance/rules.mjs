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

/**
 * Shared-state mutation detection.
 *
 * AGENTS.md says "ALWAYS create new objects, NEVER mutate". The container-call
 * rule above enforces that on every receiver, which is deliberately crude: it
 * flags `const acc = []; acc.push(x)` inside a function and misses the shape
 * the house rule names, a module-level object written from several call paths. The rules below cover the missing write forms and pay for the
 * extra precision with a scope test.
 *
 * Receiver resolution, stated exactly:
 * - A mutation site is `ROOT(.field|[...])*.prop OP`, `ROOT(.field|[...])*[...] OP`,
 *   or `ROOT(.field|[...])*.{set|add|delete|clear}(` where OP is `=`, `=>`-free,
 *   or one of the compound operators.
 * - ROOT must be an identifier bound by a module-level declaration in this same
 *   file: `const`/`let`/`var` (with or without a type annotation, destructured
 *   or not), `function`, `class`, or an import clause binding. Chains are
 *   followed to their root, so `config.timeout = 5` is flagged when `config` is
 *   module-level.
 * - The mutation site must sit inside a function or callable frame. Module
 *   top-level writes are module initialization: they run once, on the single
 *   import path, so there is no second call path to alias against.
 *
 * Reported writes carry `scope: "module"`, so a caller can separate them from
 * the unconditional container-call rule above.
 *
 * Deliberate limits, so the rule does not read as more than it is:
 * - `this.x =` is not a violation. `this` binds per call to the instance that
 *   owns the field; an object writing its own field is not the aliasing hazard,
 *   which needs one shared object reachable from independent call paths.
 * - Assigning `lastIndex` on a module-level `/g` RegExp is not flagged. It is
 *   the language's only way to reset an iteration cursor and carries no shared
 *   business state, so it is not the hazard the rule exists to catch.
 * - The receiver must be reachable from a bare identifier. A write through a
 *   call result or an optional chain (`getMap().set(k, v)`, `x?.y = 1`) is not
 *   resolved, because the checker cannot know what that expression returns.
 * - `set`, `add`, `delete`, and `clear` are matched by name, not by type. With
 *   no type information the checker cannot tell a Map from a module-level
 *   object that happens to expose a method with one of those names; it reports
 *   both, which is the same hazard class.
 * - An imported binding is treated like a locally declared one. A foreign
 *   module was not read, so which of its exports are safe to write is unknown.
 */
const ASSIGNMENT_OPERATOR = "(?:=(?!=|>)|[+\\-*/%&|^]=|\\*\\*=|\\?\\?=|&&=|\\|\\|=|<<=|>>>?=)";
const RECEIVER_CHAIN = "[A-Za-z_$][\\w$]*(?:\\s*(?:\\.\\s*[A-Za-z_$][\\w$]*|\\[[^\\]\\n]*\\]))*";
const PROPERTY_ASSIGNMENT = new RegExp(
  `\\b(${RECEIVER_CHAIN})\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*(${ASSIGNMENT_OPERATOR})(?!=)`,
  "g",
);
const INDEX_ASSIGNMENT = new RegExp(`\\b(${RECEIVER_CHAIN})\\s*\\[[^\\]\\n]*\\]\\s*(${ASSIGNMENT_OPERATOR})(?!=)`, "g");
const COLLECTION_CALL = new RegExp(`\\b(${RECEIVER_CHAIN})\\s*\\.\\s*(set|add|delete|clear)\\s*\\(`, "g");

const DECLARATION = /\b(?:export\s+)?(?:declare\s+)?(?:const|let|var|function|class)\s+/g;
const IMPORT_CLAUSE = /\bimport\s+(?:type\s+)?([\s\S]*?)\s*from\s*["'][^"']*["']/g;
const DECLARED_NAME = /^([A-Za-z_$][\w$]*)/;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Enclosing `{`/`}` nesting per offset; 0 is module top level. */
function braceDepths(clean) {
  const depths = new Array(clean.length);
  let depth = 0;
  for (let i = 0; i < clean.length; i += 1) {
    depths[i] = depth;
    if (clean[i] === "{") depth += 1;
    else if (clean[i] === "}") depth = Math.max(0, depth - 1);
  }
  return depths;
}

/** True when only `export`/`declare` separates `index` from the start of its line. */
function startsDeclarationLine(clean, index) {
  const lineStart = clean.lastIndexOf("\n", index - 1) + 1;
  return /^\s*(?:export\s+)?(?:declare\s+)?$/.test(clean.slice(lineStart, index));
}

/** Offset of the declaration's initializer, or -1 when the statement has none. */
function initializerOffset(rest, from) {
  for (let i = from; i < rest.length; i += 1) {
    const char = rest[i];
    if (char === "\n" || char === ";") return -1;
    if (char !== "=") continue;
    const before = rest[i - 1];
    const after = rest[i + 1];
    if (after === "=" || after === ">" || before === "!" || before === "<" || before === ">" || before === "=") continue;
    return i + 1;
  }
  return -1;
}

function declarationNames(rest, raw, bindings) {
  const trimmed = rest.replace(/^\s+/, "");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const close = trimmed.startsWith("{") ? "}" : "]";
    const end = trimmed.indexOf(close);
    if (end < 0) return;
    for (const name of trimmed.slice(1, end).match(IDENTIFIER) ?? []) bindings.set(name, false);
    return;
  }
  const name = DECLARED_NAME.exec(rest)?.[1];
  if (!name) return;
  const offset = initializerOffset(rest, rest.indexOf(name) + name.length);
  bindings.set(name, offset >= 0 && isRegexLiteral(raw, offset));
}

/**
 * The masked text cannot answer this: `sanitize` blanks a regex literal's own
 * delimiters, so the initializer is read from the raw source at the same offset.
 */
function isRegexLiteral(raw, offset) {
  const end = raw.indexOf("\n", offset);
  const line = raw.slice(offset, end < 0 ? raw.length : end).trimStart();
  return line.startsWith("/") && !line.startsWith("//") && !line.startsWith("/*");
}

function importNames(clause, bindings) {
  const braced = clause.match(/\{([\s\S]*)\}/);
  for (const name of braced?.[1].match(IDENTIFIER) ?? []) bindings.set(name, false);
  const outside = clause.replace(/\{[\s\S]*\}/, " ");
  for (const match of outside.matchAll(/([A-Za-z_$][\w$]*)\s*(?=,|$)/g)) bindings.set(match[1], false);
  const namespace = outside.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/);
  if (namespace) bindings.set(namespace[1], false);
}

/** Module-scope bindings to `true` when the binding holds a regular expression literal. */
function moduleScopeBindings(clean, source) {
  const depths = braceDepths(clean);
  const bindings = new Map();
  for (const match of clean.matchAll(DECLARATION)) {
    if (depths[match.index] !== 0 || !startsDeclarationLine(clean, match.index)) continue;
    const end = match.index + match[0].length;
    declarationNames(clean.slice(end), source.slice(end), bindings);
  }
  for (const match of clean.matchAll(IMPORT_CLAUSE)) {
    if (depths[match.index] === 0) importNames(match[1], bindings);
  }
  return bindings;
}

function receiverRoot(chain) {
  return /^[A-Za-z_$][\w$]*/.exec(chain.trim())?.[0];
}

function innermostFrame(frames, offset) {
  let best = null;
  for (const frame of frames) {
    if (frame.start > offset) continue;
    if (frame.end !== null && frame.end < offset) continue;
    if (best === null || frame.start >= best.start) best = frame;
  }
  return best;
}

function insideCallable(frames, offset) {
  let frame = innermostFrame(frames, offset);
  while (frame) {
    if (frame.kind === "function" || frame.kind === "callable") return true;
    frame = frame.parent === null || frame.parent === undefined ? null : frames[frame.parent];
  }
  return false;
}

function assignmentDetail(root, operator, kind) {
  const compound = operator.startsWith("=") ? "" : "compound ";
  return `${compound}${kind} on module-level ${root}`;
}

function propertyAssignments(clean) {
  return [...clean.matchAll(PROPERTY_ASSIGNMENT)].map((match) => ({
    root: receiverRoot(match[1]),
    index: match.index,
    property: match[2],
    operator: match[3],
    detail: assignmentDetail(receiverRoot(match[1]), match[3], "property assignment"),
  }));
}

function indexAssignments(clean) {
  return [...clean.matchAll(INDEX_ASSIGNMENT)].map((match) => ({
    root: receiverRoot(match[1]),
    index: match.index,
    property: "",
    operator: match[2],
    detail: assignmentDetail(receiverRoot(match[1]), match[2], "index assignment"),
  }));
}

function collectionCalls(clean) {
  return [...clean.matchAll(COLLECTION_CALL)].map((match) => ({
    root: receiverRoot(match[1]),
    index: match.index,
    property: match[2],
    operator: "",
    detail: `${match[2]}() on module-level collection ${receiverRoot(match[1])}`,
  }));
}

function isSharedStateWrite(scan, bindings, site) {
  if (!site.root || !bindings.has(site.root)) return false;
  if (site.property === "lastIndex" && bindings.get(site.root) === true) return false;
  return insideCallable(scan.frames, site.index);
}

function sharedStateViolations(scan, source) {
  const bindings = moduleScopeBindings(scan.clean, source);
  const sites = [...propertyAssignments(scan.clean), ...indexAssignments(scan.clean), ...collectionCalls(scan.clean)];
  return sites
    .filter((site) => isSharedStateWrite(scan, bindings, site))
    .map((site) => ({
      rule: "mutation",
      line: scan.lineAt(site.index),
      detail: site.detail,
      scope: "module",
    }));
}

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
    ...sharedStateViolations(scan, source),
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
