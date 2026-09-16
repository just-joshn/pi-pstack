/**
 * Build the ExecOptions object Pi accepts.
 *
 * Pi declares `signal?: AbortSignal` without `| undefined`, and this repo runs
 * with exactOptionalPropertyTypes, so `{ signal }` where signal is
 * `AbortSignal | undefined` is a type error even though it is correct at
 * runtime. Callers hold that union from an optional context all over the tree,
 * so the omission rule lives here once instead of at every exec site.
 */
export interface ExecOptionInput {
  readonly signal?: AbortSignal | undefined;
  readonly timeout?: number | undefined;
  readonly cwd?: string | undefined;
}

export function execOptions(input: ExecOptionInput = {}): {
  signal?: AbortSignal;
  timeout?: number;
  cwd?: string;
} {
  return {
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  };
}
