export const MAX_REGEX_LINE_LENGTH = 4096;

const MAX_PATTERN_LENGTH = 1024;
const MAX_REPEAT = MAX_REGEX_LINE_LENGTH;

function quantifierAt(source, index) {
  const character = source[index];
  if (character === "*" || character === "+") return { end: index + 1, unbounded: true, quantified: true };
  if (character === "?") return { end: index + 1, unbounded: false, quantified: true };
  if (character !== "{") return undefined;

  const close = source.indexOf("}", index + 1);
  if (close === -1) return undefined;
  const range = source.slice(index + 1, close);
  const comma = range.indexOf(",");
  if (comma === -1) {
    const count = Number(range);
    if (!Number.isSafeInteger(count)) return undefined;
    if (count > MAX_REPEAT) return { end: close + 1, issue: "bounded repetitions cannot exceed 4096" };
    return { end: close + 1, unbounded: false, quantified: true };
  }

  const minimum = Number(range.slice(0, comma));
  const maximumText = range.slice(comma + 1);
  const maximum = maximumText === "" ? undefined : Number(maximumText);
  if (!Number.isSafeInteger(minimum) || (maximum !== undefined && !Number.isSafeInteger(maximum))) return undefined;
  if (minimum > MAX_REPEAT || (maximum !== undefined && maximum > MAX_REPEAT)) {
    return { end: close + 1, issue: "bounded repetitions cannot exceed 4096" };
  }
  return { end: close + 1, unbounded: maximum === undefined, quantified: true };
}

function groupBodyStart(source, index) {
  let cursor = index + 1;
  if (source[cursor] !== "?") return cursor;
  if ([":", "=", "!"].includes(source[cursor + 1])) return cursor + 2;
  if (source[cursor + 1] === "<" && ["=", "!"].includes(source[cursor + 2])) return cursor + 3;
  if (source[cursor + 1] === "<") {
    const close = source.indexOf(">", cursor + 2);
    return close === -1 ? cursor + 1 : close + 1;
  }
  return cursor + 1;
}

function scanCharacterClass(source, index) {
  let cursor = index + 1;
  if (source[cursor] === "^") cursor++;
  while (cursor < source.length) {
    if (source[cursor] === "\\") cursor += 2;
    else if (source[cursor] === "]") return cursor + 1;
    else cursor++;
  }
  return cursor;
}

function escapedAtom(source, index) {
  const escaped = source[index + 1];
  if ((escaped >= "1" && escaped <= "9") || (escaped === "k" && source[index + 2] === "<")) {
    return { issue: "backreferences are not supported" };
  }
  let end = index + 2;
  if ((escaped === "p" || escaped === "P") && source[end] === "{") {
    const close = source.indexOf("}", end + 1);
    if (close !== -1) end = close + 1;
  }
  const literal = escaped !== undefined && !/[A-Za-z0-9]/.test(escaped) && escaped !== "\\" ? true : escaped === "\\";
  return { end, literalSeparator: literal };
}

function scanSequence(source, start, state, depth = 0) {
  if (depth > 64) return { issue: "group nesting cannot exceed 64 levels" };
  let index = start;
  let hasUnbounded = false;
  let hasQuantifier = false;
  let hasAlternation = false;
  let adjacentUnbounded = false;
  let adjacentQuantifier = false;

  while (index < source.length) {
    const character = source[index];
    if (character === ")") return { end: index + 1, hasUnbounded, hasQuantifier, hasAlternation };
    if (character === "|") {
      hasAlternation = true;
      adjacentUnbounded = false;
      adjacentQuantifier = false;
      index++;
      continue;
    }
    if (character === "^" || character === "$") {
      index++;
      continue;
    }

    let atom;
    if (character === "(") {
      const inner = scanSequence(source, groupBodyStart(source, index), state, depth + 1);
      if (inner.issue) return inner;
      atom = { end: inner.end, hasUnbounded: inner.hasUnbounded, hasQuantifier: inner.hasQuantifier, hasAlternation: inner.hasAlternation, literalSeparator: false };
    } else if (character === "[") {
      atom = { end: scanCharacterClass(source, index), hasUnbounded: false, hasQuantifier: false, hasAlternation: false, literalSeparator: false };
    } else if (character === "\\") {
      const escaped = escapedAtom(source, index);
      if (escaped.issue) return escaped;
      atom = { ...escaped, hasUnbounded: false, hasQuantifier: false, hasAlternation: false };
    } else {
      atom = {
        end: index + 1,
        hasUnbounded: false,
        hasQuantifier: false,
        hasAlternation: false,
        literalSeparator: character !== "." && !"*+?{}[]()|^$".includes(character),
      };
    }

    const quantifier = quantifierAt(source, atom.end);
    if (quantifier?.issue) return { issue: quantifier.issue };
    if (quantifier?.quantified) {
      if (atom.hasUnbounded && quantifier.unbounded) return { issue: "nested unbounded quantifiers are not supported" };
      if (atom.hasQuantifier) return { issue: "nested quantifiers are not supported" };
      if (atom.hasAlternation) return { issue: "repetition of alternation groups is not supported" };
      if (adjacentUnbounded && quantifier.unbounded) return { issue: "adjacent unbounded quantifiers are not supported" };
      if (adjacentQuantifier) return { issue: "adjacent quantified atoms are not supported" };
      if (quantifier.unbounded) {
        state.unboundedCount++;
        if (state.unboundedCount > 1) return { issue: "patterns can contain at most one unbounded quantifier" };
        hasUnbounded = true;
        adjacentUnbounded = true;
      } else {
        adjacentUnbounded = false;
      }
      hasQuantifier = true;
      adjacentQuantifier = true;
    } else {
      if (atom.hasUnbounded) {
        hasUnbounded = true;
        adjacentUnbounded = true;
      }
      if (atom.hasQuantifier) {
        hasQuantifier = true;
        adjacentQuantifier = true;
      } else if (atom.literalSeparator) {
        adjacentUnbounded = false;
        adjacentQuantifier = false;
      }
    }
    index = quantifier?.end ?? atom.end;
    if (quantifier?.quantified && source[index] === "?") index++;
  }

  return { end: index, hasUnbounded, hasQuantifier, hasAlternation };
}

function regexIssue(source) {
  const state = { unboundedCount: 0 };
  return scanSequence(source, 0, state).issue;
}

export function compileSafeRegex(source, label, flags = "") {
  if (source.length > MAX_PATTERN_LENGTH) throw new Error(`${label} must be a regular expression of at most 1024 characters`);
  let expression;
  try {
    expression = new RegExp(source, flags);
  } catch {
    throw new Error(`${label} must be a valid regular expression`);
  }
  const issue = regexIssue(source);
  if (issue) throw new Error(`${label} is an unsafe regular expression: ${issue}`);
  return expression;
}

export function regexMatchesLine(expression, line) {
  expression.lastIndex = 0;
  return expression.test(line.slice(0, MAX_REGEX_LINE_LENGTH));
}
