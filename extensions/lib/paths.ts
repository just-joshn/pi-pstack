/**
 * Path argument normalization shared by tools that accept a path.
 * Some models include the `@` prefix; built-in tools strip it, so custom tools
 * must strip it too before the value reaches any path resolver.
 */
export function stripAtPrefix<T extends string | undefined>(value: T): T {
  return (typeof value === "string" && value.startsWith("@") ? value.slice(1) : value) as T;
}

export function stripAtPrefixes(value: string[] | undefined): string[] | undefined {
  return value?.map((entry) => stripAtPrefix(entry));
}
