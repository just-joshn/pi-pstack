const CONTROL = new Set(["if", "for", "while", "switch", "catch", "with", "else", "try", "finally", "do"]);

function maskRange(text) {
  return text.replace(/[^\n]/g, " ");
}

function endOfString(src, start) {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return src.length;
}

function endOfTemplate(src, start) {
  let i = start + 1;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (depth === 0 && c === "`") return i + 1;
    if (depth === 0 && c === "$" && src[i + 1] === "{") {
      depth = 1;
      i += 2;
      continue;
    }
    if (depth > 0) {
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === '"' || c === "'" || c === "`") i = endOfString(src, i) - 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return src.length;
}

function endOfRegex(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    else if (c === "\n") return start;
    i += 1;
  }
  return start;
}

function looksLikeRegex(prev) {
  return prev !== "" && /[=(,:;[!&|?{}]/.test(prev);
}

export function sanitize(src) {
  let out = "";
  let i = 0;
  let prev = "";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += maskRange(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += maskRange(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const stop = endOfString(src, i);
      out += maskRange(src.slice(i, stop));
      i = stop;
      prev = c;
      continue;
    }
    if (c === "`") {
      const stop = endOfTemplate(src, i);
      out += maskRange(src.slice(i, stop));
      i = stop;
      prev = c;
      continue;
    }
    if (c === "/" && looksLikeRegex(prev)) {
      const stop = endOfRegex(src, i);
      if (stop > i) {
        out += maskRange(src.slice(i, stop));
        i = stop;
        prev = "/";
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

export function makeLineIndex(src) {
  let starts = [0];
  let i = 0;
  while (i < src.length) {
    if (src[i] === "\n") starts = [...starts, i + 1];
    i += 1;
  }
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function previousSignificant(text, from) {
  let i = from;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  return i;
}

function matchingOpen(text, closeIndex, open, close) {
  let depth = 0;
  let i = closeIndex;
  while (i >= 0) {
    if (text[i] === close) depth += 1;
    else if (text[i] === open) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i -= 1;
  }
  return -1;
}

function wordBefore(text, index) {
  let i = index;
  while (i >= 0 && /[\w$]/.test(text[i])) i -= 1;
  return text.slice(i + 1, index + 1);
}

function wordAt(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  let end = i;
  while (end < text.length && /[\w$]/.test(text[end])) end += 1;
  return text.slice(i, end);
}

function arrowName(text, equalsIndex) {
  let i = previousSignificant(text, equalsIndex - 1);
  if (i >= 0 && text[i] === ")") {
    const open = matchingOpen(text, i, "(", ")");
    if (open >= 0) i = previousSignificant(text, open - 1);
  }
  if (i >= 0 && (text[i] === "=" || text[i] === ":")) i = previousSignificant(text, i - 1);
  return i >= 0 ? wordBefore(text, i) : "";
}

function calleeName(text, head) {
  if (head < 0) return "";
  if (text[head] === ">") {
    const open = matchingOpen(text, head, "<", ">");
    if (open >= 0) return wordBefore(text, previousSignificant(text, open - 1));
    return "";
  }
  return wordBefore(text, head);
}

function signatureBrace(text, braceIndex) {
  let i = braceIndex - 1;
  while (i >= 0) {
    const c = text[i];
    if (c === ")") {
      const open = matchingOpen(text, i, "(", ")");
      const head = open > 0 ? previousSignificant(text, open - 1) : -1;
      const word = calleeName(text, head);
      if (CONTROL.has(word)) return { kind: "control", name: word };
      if (word === "function") return { kind: "function", name: open >= 0 ? wordAt(text, open + 1) : "" };
      return { kind: "callable", name: word };
    }
    if (c === "\n") return null;
    if (/[\w$.<>,[\]|&?'"`*:=\s]/.test(c)) {
      i -= 1;
      continue;
    }
    return null;
  }
  return null;
}

function classifyBrace(text, braceIndex) {
  const prev = previousSignificant(text, braceIndex - 1);
  if (prev < 0) return { kind: "block", name: "" };
  const c = text[prev];
  if (c === ">") {
    const before = previousSignificant(text, prev - 1);
    if (before >= 0 && text[before] === "=") {
      return { kind: "function", name: arrowName(text, before) };
    }
    return signatureBrace(text, braceIndex) ?? { kind: "block", name: "" };
  }
  if (c === ")") {
    const open = matchingOpen(text, prev, "(", ")");
    const head = open > 0 ? previousSignificant(text, open - 1) : -1;
    const word = calleeName(text, head);
    if (CONTROL.has(word)) return { kind: "control", name: word };
    if (word === "function") return { kind: "function", name: open >= 0 ? wordAt(text, open + 1) : "" };
    return { kind: "callable", name: word };
  }
  const word = wordBefore(text, prev);
  if (CONTROL.has(word)) return { kind: "control", name: word };
  return signatureBrace(text, braceIndex) ?? { kind: "block", name: word };
}

function controlDepthOf(frame, frames) {
  let depth = 0;
  let cursor = frame.parent;
  while (cursor !== null && cursor !== undefined) {
    const parent = frames[cursor];
    if (parent.kind === "control") depth += 1;
    cursor = parent.parent;
  }
  return depth;
}

export function scanFrames(src) {
  const clean = sanitize(src);
  const lineAt = makeLineIndex(clean);
  let frames = [];
  let stack = [];
  let i = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (c === "{") {
      const meta = classifyBrace(clean, i);
      const parent = stack.length > 0 ? stack[stack.length - 1] : null;
      frames = [...frames, { ...meta, start: i, startLine: lineAt(i), parent, end: null }];
      stack = [...stack, frames.length - 1];
    } else if (c === "}") {
      const top = stack.length > 0 ? stack[stack.length - 1] : null;
      if (top !== null) {
        frames = frames.map((frame, index) =>
          index === top ? { ...frame, end: i, endLine: lineAt(i) } : frame,
        );
        stack = stack.slice(0, -1);
      }
    }
    i += 1;
  }
  return {
    clean,
    lineAt,
    frames: frames.map((frame) => ({ ...frame, controlDepth: controlDepthOf(frame, frames) })),
  };
}
