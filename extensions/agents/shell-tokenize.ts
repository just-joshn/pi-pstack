/**
 * Quote-aware shell tokenizer.
 *
 * Splitting a command line with regexes loses quoting, wrappers, and nested
 * substitutions. This module walks the string once and emits typed tokens, so
 * the parser above it can reason about executions instead of text.
 */

export type ShellOperator = "&&" | "||" | ";" | "|" | "&" | "\n" | "(" | ")";

export interface WordToken {
  readonly kind: "word";
  readonly value: string;
  readonly dynamic: boolean;
}

export interface OpToken {
  readonly kind: "op";
  readonly value: ShellOperator;
}

export interface RedirectToken {
  readonly kind: "redirect";
  readonly operator: string;
  readonly target: string;
  readonly write: boolean;
}

export type ShellToken = WordToken | OpToken | RedirectToken;

export interface TokenScan {
  readonly tokens: readonly ShellToken[];
  readonly substitutions: readonly string[];
}

interface WordPiece {
  readonly value: string;
  readonly dynamic: boolean;
  readonly substitutions: readonly string[];
  readonly next: number;
}

interface OperatorScan {
  readonly token: ShellToken;
  readonly substitutions: readonly string[];
  readonly next: number;
}

export class ShellRefusalError extends Error {
  readonly construct: string;
  constructor(construct: string) {
    super(`cannot decompose shell construct: ${construct}`);
    this.construct = construct;
  }
}

const WORD_END: ReadonlySet<string> = new Set([
  " ",
  "\t",
  "\r",
  "\n",
  ";",
  "&",
  "|",
  "(",
  ")",
  "<",
  ">",
]);

const SEPARATOR_OPERATORS: ReadonlySet<string> = new Set(["&&", "||", ";", "|", "|&", "&", "(", ")"]);

const OPERATOR_PATTERN = /^(&&|\|\||>>|>\||&>>|&>|<<<|<<|<&|<>|>&|\|&|;|&|\||\(|\)|<|>)/;

const FD_REDIRECT_PATTERN = /^(\d+)(&>>|&>|>>|>\||>&|<>|<|>)/;

function skipSpaces(input: string, start: number): number {
  let index = start;
  while (index < input.length && (input[index] === " " || input[index] === "\t")) {
    index += 1;
  }
  return index;
}

function skipLine(input: string, start: number): number {
  const end = input.indexOf("\n", start);
  return end === -1 ? input.length : end;
}

function findMatchingParen(input: string, openIndex: number): number {
  let depth = 0;
  let index = openIndex;
  while (index < input.length) {
    const char = input[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "'") {
      const close = input.indexOf("'", index + 1);
      if (close === -1) return -1;
      index = close + 1;
      continue;
    }
    if (char === '"') {
      const close = findClosingDoubleQuote(input, index + 1);
      if (close === -1) return -1;
      index = close;
      continue;
    }
    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      if (depth === 0) return -1;
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
      continue;
    }
    index += 1;
  }
  return -1;
}

function findClosingDoubleQuote(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    if (input[index] === "\\") {
      index += 2;
      continue;
    }
    if (input[index] === '"') return index + 1;
    index += 1;
  }
  return -1;
}

function findClosingBacktick(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    if (input[index] === "\\") {
      index += 2;
      continue;
    }
    if (input[index] === "`") return index;
    index += 1;
  }
  return -1;
}

function scanBracedParameter(input: string, index: number): WordPiece {
  let cursor = index + 2;
  let depth = 1;
  let substitutions: readonly string[] = [];
  while (cursor < input.length) {
    const char = input[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { value: input.slice(index, cursor + 1), dynamic: true, substitutions, next: cursor + 1 };
      }
      cursor += 1;
      continue;
    }
    if (char === "$" && input[cursor + 1] === "{") {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (char === "$" && input[cursor + 1] === "(") {
      const close = findMatchingParen(input, cursor + 1);
      if (close === -1) throw new ShellRefusalError("unbalanced command substitution `$(`");
      substitutions = [...substitutions, input.slice(cursor + 2, close)];
      cursor = close + 1;
      continue;
    }
    if (char === "`") {
      const close = findClosingBacktick(input, cursor + 1);
      if (close === -1) throw new ShellRefusalError("unbalanced backtick substitution");
      substitutions = [...substitutions, input.slice(cursor + 1, close)];
      cursor = close + 1;
      continue;
    }
    cursor += 1;
  }
  throw new ShellRefusalError("unbalanced parameter expansion `${`");
}

function scanDollar(input: string, index: number): WordPiece {
  const next = input[index + 1];
  if (next === "(") {
    const close = findMatchingParen(input, index + 1);
    if (close === -1) throw new ShellRefusalError("unbalanced command substitution `$(`");
    return { value: "", dynamic: true, substitutions: [input.slice(index + 2, close)], next: close + 1 };
  }
  if (next === "{") return scanBracedParameter(input, index);
  if (next === "'" || next === '"') {
    const close = input.indexOf(next, index + 2);
    if (close === -1) throw new ShellRefusalError("unbalanced ANSI-C quote");
    return { value: input.slice(index + 2, close), dynamic: true, substitutions: [], next: close + 1 };
  }
  if (next !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(next)) {
    const match = /^[A-Za-z0-9_@*#?$!-]+/.exec(input.slice(index + 1));
    const name = match ? match[0] : next;
    const end = index + 1 + name.length;
    return { value: input.slice(index, end), dynamic: true, substitutions: [], next: end };
  }
  return { value: "$", dynamic: false, substitutions: [], next: index + 1 };
}

function pieceFromLiteral(input: string, index: number): WordPiece {
  const close = input.indexOf("'", index + 1);
  if (close === -1) throw new ShellRefusalError("unbalanced single quote");
  return { value: input.slice(index + 1, close), dynamic: false, substitutions: [], next: close + 1 };
}

function pieceFromBacktick(input: string, index: number): WordPiece {
  const close = findClosingBacktick(input, index + 1);
  if (close === -1) throw new ShellRefusalError("unbalanced backtick substitution");
  return { value: "", dynamic: true, substitutions: [input.slice(index + 1, close)], next: close + 1 };
}

function pieceFromDouble(input: string, index: number): WordPiece {
  let cursor = index + 1;
  let value = "";
  let dynamic = false;
  let substitutions: readonly string[] = [];
  while (cursor < input.length) {
    const char = input[cursor];
    if (char === '"') return { value, dynamic, substitutions, next: cursor + 1 };
    if (char === "\\" && cursor + 1 < input.length) {
      const escaped = input[cursor + 1];
      value += escaped === "\n" ? "" : /[$"`\\]/.test(escaped) ? escaped : `\\${escaped}`;
      cursor += 2;
      continue;
    }
    if (char === "$") {
      const expansion = scanDollar(input, cursor);
      value += expansion.value;
      dynamic = true;
      substitutions = [...substitutions, ...expansion.substitutions];
      cursor = expansion.next;
      continue;
    }
    if (char === "`") {
      const expansion = pieceFromBacktick(input, cursor);
      substitutions = [...substitutions, ...expansion.substitutions];
      dynamic = true;
      cursor = expansion.next;
      continue;
    }
    value += char;
    cursor += 1;
  }
  throw new ShellRefusalError("unbalanced double quote");
}

function pieceFromEscape(input: string, index: number): WordPiece {
  const escaped = input[index + 1];
  if (escaped === undefined) return { value: "", dynamic: false, substitutions: [], next: input.length };
  return { value: escaped === "\n" ? "" : escaped, dynamic: false, substitutions: [], next: index + 2 };
}

function scanWordPiece(input: string, index: number): WordPiece {
  const char = input[index];
  if (char === "'") return pieceFromLiteral(input, index);
  if (char === '"') return pieceFromDouble(input, index);
  if (char === "\\") return pieceFromEscape(input, index);
  if (char === "$") return scanDollar(input, index);
  if (char === "`") return pieceFromBacktick(input, index);
  return { value: char, dynamic: false, substitutions: [], next: index + 1 };
}

function scanWord(input: string, start: number): WordPiece {
  let index = start;
  let value = "";
  let dynamic = false;
  let substitutions: readonly string[] = [];
  while (index < input.length && !WORD_END.has(input[index])) {
    const piece = scanWordPiece(input, index);
    value += piece.value;
    dynamic = dynamic || piece.dynamic;
    substitutions = [...substitutions, ...piece.substitutions];
    index = piece.next;
  }
  return { value, dynamic, substitutions, next: index };
}

function redirectWrites(operator: string, target: string): boolean {
  if (operator === "<" || operator === "<&") return false;
  return !/^\d+$|^-$/.test(target);
}

function scanRedirectTarget(input: string, start: number): WordPiece {
  const index = skipSpaces(input, start);
  if (index >= input.length) throw new ShellRefusalError("redirection without a target");
  const piece = scanWord(input, index);
  if (piece.value.length === 0 && piece.substitutions.length === 0) {
    throw new ShellRefusalError("redirection without a target");
  }
  return {
    value: piece.value.length > 0 ? piece.value : "<substitution>",
    dynamic: piece.dynamic,
    substitutions: piece.substitutions,
    next: piece.next,
  };
}

function scanOperator(input: string, index: number): OperatorScan | undefined {
  const rest = input.slice(index);
  const fd = FD_REDIRECT_PATTERN.exec(rest);
  const match = fd ?? OPERATOR_PATTERN.exec(rest);
  if (!match) return undefined;
  const operator = fd ? fd[2] : match[1];
  if (operator === "<<" || operator === "<<<") throw new ShellRefusalError("here-doc or here-string");
  const next = index + (fd ? fd[0].length : operator.length);
  if (!fd && SEPARATOR_OPERATORS.has(operator)) {
    const value = (operator === "|&" ? "|" : operator) as ShellOperator;
    return { token: { kind: "op", value }, substitutions: [], next };
  }
  const target = scanRedirectTarget(input, next);
  return {
    token: {
      kind: "redirect",
      operator,
      target: target.value,
      write: redirectWrites(operator, target.value),
    },
    substitutions: target.substitutions,
    next: target.next,
  };
}

export function scanTokens(input: string): TokenScan {
  let index = 0;
  let tokens: readonly ShellToken[] = [];
  let substitutions: readonly string[] = [];
  while (index < input.length) {
    const char = input[index];
    if (char === "\n") {
      tokens = [...tokens, { kind: "op", value: "\n" }];
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "#") {
      index = skipLine(input, index);
      continue;
    }
    if ((char === "<" || char === ">") && input[index + 1] === "(") {
      throw new ShellRefusalError("process substitution, which runs an uninspected command");
    }
    const operator = scanOperator(input, index);
    if (operator) {
      tokens = [...tokens, operator.token];
      substitutions = [...substitutions, ...operator.substitutions];
      index = operator.next;
      continue;
    }
    const word = scanWord(input, index);
    tokens = [...tokens, { kind: "word", value: word.value, dynamic: word.dynamic }];
    substitutions = [...substitutions, ...word.substitutions];
    index = word.next;
  }
  return { tokens, substitutions };
}
