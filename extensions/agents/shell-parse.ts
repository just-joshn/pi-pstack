/**
 * Shell command parser for the policy guard.
 *
 * A command line is an ordered list of executions, not a string to split with
 * regexes. This module flattens shell wrappers, command substitutions, and
 * separators into that list. Constructs it cannot decompose become refusals so
 * the guard fails closed instead of allowing an uninspected command.
 */
import {
  ShellRefusalError,
  scanTokens,
  type RedirectToken,
  type ShellToken,
  type TokenScan,
  type WordToken,
} from "./shell-tokenize.ts";

export interface ShellArg {
  readonly value: string;
  readonly dynamic: boolean;
}

export interface ShellExecution {
  readonly name: string;
  readonly args: readonly ShellArg[];
}

export interface ShellRedirect {
  readonly operator: string;
  readonly target: string;
  readonly write: boolean;
}

export interface ShellParse {
  readonly executions: readonly ShellExecution[];
  readonly redirects: readonly ShellRedirect[];
  readonly refusals: readonly string[];
}

interface Segment {
  readonly words: readonly WordToken[];
  readonly redirects: readonly ShellRedirect[];
}

interface Subcommand {
  readonly sub?: string;
  readonly dynamic: boolean;
}

interface ResolveResult {
  readonly executions: readonly ShellExecution[];
  readonly redirects: readonly ShellRedirect[];
  readonly refusals: readonly string[];
}

type SafeScan =
  | { readonly ok: true; readonly scan: TokenScan }
  | { readonly ok: false; readonly refusal: string };

function setOf(source: string): ReadonlySet<string> {
  return new Set(source.split(/\s+/).filter((token) => token.length > 0));
}

const MAX_NESTING = 8;

const SHELL_NAMES: ReadonlySet<string> = setOf("bash sh zsh dash ksh ash fish csh tcsh");

const OPAQUE_NAMES: ReadonlySet<string> = setOf("eval exec . source");

/** Keywords that sit between a separator and the command they introduce. */
const KEYWORD_PREFIXES: ReadonlySet<string> = setOf("if then else elif while until do fi done esac ! { }");

const WRAPPER_NAMES: ReadonlySet<string> = setOf(
  "sudo doas env command nice nohup time xargs setsid stdbuf ionice taskset",
);

const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  sudo: setOf("--user -u --group -g --prompt -p --chdir -C --host -h --role -r --type -t --other-user -U"),
  doas: setOf("-u -C"),
  env: setOf("--unset -u --chdir -C --split-string -S"),
  nice: setOf("--adjustment -n"),
  time: setOf("--output -o --format -f"),
  xargs: setOf("--delimiter -d --max-args -n --max-procs -P --max-lines -L --arg-file -a --replace -I --eof -E --max-chars -s -i"),
  stdbuf: setOf("-i -o -e"),
  ionice: setOf("-c -n -p"),
  taskset: setOf("-c -p"),
});

const EMPTY_FLAGS: ReadonlySet<string> = new Set();

const EMPTY_RESULT: ResolveResult = Object.freeze({ executions: [], redirects: [], refusals: [] });

function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  const base = slash >= 0 ? token.slice(slash + 1) : token;
  return base.replace(/^[('"`]+/, "").replace(/[)'"`;,&|]+$/, "");
}

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function startsLikeFlag(token: string): boolean {
  return token.startsWith("-") && token !== "-" && token !== "--";
}

function skipAssignments(words: readonly WordToken[], start: number): number {
  let index = start;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined || !isAssignment(word.value)) break;
    index += 1;
  }
  return index;
}

function commandIndex(words: readonly WordToken[]): number {
  let index = skipAssignments(words, 0);
  while (index < words.length) {
    const word = words[index];
    if (word === undefined || word.dynamic || !KEYWORD_PREFIXES.has(word.value)) break;
    index = skipAssignments(words, index + 1);
  }
  return index;
}

function skipWrapperArgs(
  words: readonly WordToken[],
  start: number,
  valueFlags: ReadonlySet<string>,
): number {
  let index = start;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) return index;
    const token = word.value;
    if (token === "--") return index + 1;
    if (isAssignment(token)) {
      index += 1;
      continue;
    }
    if (!startsLikeFlag(token)) return index;
    index += valueFlags.has(token) ? 2 : 1;
  }
  return index;
}

function isShellCommandFlag(arg: ShellArg): boolean {
  return arg.value === "-c" || (/^-[A-Za-z]+$/.test(arg.value) && arg.value.includes("c"));
}

function refusalResult(construct: string): ResolveResult {
  return { executions: [], redirects: [], refusals: [construct] };
}

function resolveShell(name: string, args: readonly ShellArg[], depth: number): ResolveResult {
  const flagIndex = args.findIndex(isShellCommandFlag);
  if (flagIndex === -1) {
    return refusalResult(`\`${name}\` running a script from a file or stdin`);
  }
  const script = args[flagIndex + 1];
  if (!script || script.dynamic) {
    return refusalResult(`\`${name} -c\` with a command built from a variable`);
  }
  return parseScript(script.value, depth + 1);
}

function resolveEnvSplit(
  words: readonly WordToken[],
  index: number,
  depth: number,
): ResolveResult | undefined {
  const args = words.slice(index + 1);
  const inline = args.find((word) => word.value.startsWith("--split-string="));
  const flagIndex = args.findIndex((word) => word.value === "-S" || word.value === "--split-string");
  const script = inline ?? (flagIndex >= 0 ? args[flagIndex + 1] : undefined);
  if (!script) {
    return flagIndex >= 0 ? refusalResult("`env -S` with a command built from a variable") : undefined;
  }
  if (script.dynamic) return refusalResult("`env -S` with a command built from a variable");
  const literal = inline ? script.value.slice("--split-string=".length) : script.value;
  return literal.length > 0 ? parseScript(literal, depth + 1) : undefined;
}

function resolveWrapper(
  words: readonly WordToken[],
  index: number,
  name: string,
  depth: number,
): ResolveResult {
  if (name === "env") {
    const split = resolveEnvSplit(words, index, depth);
    if (split) return split;
  }
  const valueFlags = WRAPPER_VALUE_FLAGS[name] ?? EMPTY_FLAGS;
  const inner = skipWrapperArgs(words, index + 1, valueFlags);
  return inner >= words.length ? EMPTY_RESULT : resolveExecution(words.slice(inner), depth);
}

function resolveExecution(words: readonly WordToken[], depth: number): ResolveResult {
  const index = commandIndex(words);
  const token = words[index];
  if (token === undefined) return EMPTY_RESULT;
  if (token.dynamic) return refusalResult("a command name built from a variable or substitution");
  const name = basename(token.value);
  if (name.length === 0) return EMPTY_RESULT;
  if (OPAQUE_NAMES.has(name)) return refusalResult(`\`${name}\``);
  const args: readonly ShellArg[] = words
    .slice(index + 1)
    .map((word) => ({ value: word.value, dynamic: word.dynamic }));
  if (SHELL_NAMES.has(name)) return resolveShell(name, args, depth);
  if (WRAPPER_NAMES.has(name)) return resolveWrapper(words, index, name, depth);
  return { executions: [{ name, args }], redirects: [], refusals: [] };
}

function toSegment(tokens: readonly ShellToken[]): Segment {
  return {
    words: tokens.filter((token): token is WordToken => token.kind === "word"),
    redirects: tokens
      .filter((token): token is RedirectToken => token.kind === "redirect")
      .map((token) => ({ operator: token.operator, target: token.target, write: token.write })),
  };
}

function splitSegments(tokens: readonly ShellToken[]): readonly Segment[] {
  let groups: readonly (readonly ShellToken[])[] = [];
  let current: readonly ShellToken[] = [];
  for (const token of tokens) {
    if (token.kind === "op") {
      groups = [...groups, current];
      current = [];
      continue;
    }
    current = [...current, token];
  }
  return [...groups, current]
    .map(toSegment)
    .filter((segment) => segment.words.length > 0 || segment.redirects.length > 0);
}

function resolveSegment(segment: Segment, depth: number): ShellParse {
  const resolved = resolveExecution(segment.words, depth);
  return {
    executions: resolved.executions,
    redirects: [...segment.redirects, ...resolved.redirects],
    refusals: resolved.refusals,
  };
}

function mergeParses(parses: readonly ShellParse[]): ShellParse {
  return {
    executions: parses.flatMap((parse) => parse.executions),
    redirects: parses.flatMap((parse) => parse.redirects),
    refusals: parses.flatMap((parse) => parse.refusals),
  };
}

function scanTokensSafely(command: string): SafeScan {
  try {
    return { ok: true, scan: scanTokens(command) };
  } catch (err) {
    if (err instanceof ShellRefusalError) return { ok: false, refusal: err.construct };
    throw err;
  }
}

function parseScript(command: string, depth: number): ShellParse {
  if (depth > MAX_NESTING) {
    return { executions: [], redirects: [], refusals: [`shell nested deeper than ${MAX_NESTING} levels`] };
  }
  const scan = scanTokensSafely(command);
  if (!scan.ok) return { executions: [], redirects: [], refusals: [scan.refusal] };
  const resolved = splitSegments(scan.scan.tokens).map((segment) => resolveSegment(segment, depth));
  const substitutions = scan.scan.substitutions.map((script) => parseScript(script, depth + 1));
  return mergeParses([...resolved, ...substitutions]);
}

export function parseShellCommand(command: string): ShellParse {
  return parseScript(command, 0);
}

export function subcommandOf(args: readonly ShellArg[], valueFlags: ReadonlySet<string>): Subcommand {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === undefined) break;
    if (!arg.value.startsWith("-")) {
      return arg.dynamic ? { dynamic: true } : { sub: arg.value.toLowerCase(), dynamic: false };
    }
    index += valueFlags.has(arg.value) ? 2 : 1;
  }
  return { dynamic: false };
}
