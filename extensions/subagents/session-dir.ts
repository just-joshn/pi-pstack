/**
 * Child session directory resolution: isolated mint, ephemeral, and fail-closed resume.
 * Split out of child-runner.ts so the runner stays inside the 800-line file budget.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ChildTaskInput } from "./child-runner.ts";

export function resolveSessionMode(input: ChildTaskInput): "ephemeral" | "isolated" {
  if (input.sessionMode === "ephemeral" || input.sessionMode === "isolated") return input.sessionMode;
  const env = process.env.PSTACK_CHILD_SESSION;
  if (env === "isolated" || env === "ephemeral") return env;
  // Prefer isolated: preserves tools/MCP discovery via normal Pi package load
  // (no --no-extensions) + dedicated --session-dir. Pi CLI cannot inherit parent
  // MCP bindings or conversation history into children.
  return "isolated";
}

/**
 * Resolve child session dir for isolated/resume paths.
 * Resume fails closed if path missing; resume+ephemeral is rejected.
 * Mint creates under cwd/.pi/pstack-child-sessions when not resuming.
 * `continueSession` is true only for true resume (resumeSessionDir) — argv must add -c/--continue.
 */
export function resolveChildSessionDir(
  input: ChildTaskInput,
  cwd: string,
): { sessionMode: "ephemeral" | "isolated"; sessionDir?: string; continueSession: boolean } {
  const sessionMode = resolveSessionMode(input);
  if (input.resumeSessionDir) {
    if (sessionMode === "ephemeral") {
      throw new Error(
        "resumeSessionDir conflicts with sessionMode=ephemeral; omit ephemeral to resume, or spawn fresh without resume",
      );
    }
    const sessionDir = isAbsolute(input.resumeSessionDir)
      ? input.resumeSessionDir
      : resolve(cwd, input.resumeSessionDir);
    if (!existsSync(sessionDir)) {
      throw new Error(`resumeSessionDir missing or unreadable: ${sessionDir}`);
    }
    try {
      if (!statSync(sessionDir).isDirectory()) {
        throw new Error(`resumeSessionDir is not a directory: ${sessionDir}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("resumeSessionDir")) throw err;
      throw new Error(`resumeSessionDir missing or unreadable: ${sessionDir}`);
    }
    return { sessionMode: "isolated", sessionDir, continueSession: true };
  }
  if (sessionMode === "ephemeral") return { sessionMode, continueSession: false };
  // Pre-resolved mint (enqueue): reuse dir without continue semantics.
  if (input.sessionDir) {
    const sessionDir = isAbsolute(input.sessionDir) ? input.sessionDir : resolve(cwd, input.sessionDir);
    return { sessionMode, sessionDir, continueSession: false };
  }
  const sessionDir = mintChildSessionDir(join(cwd, ".pi", "pstack-child-sessions"));
  return { sessionMode, sessionDir, continueSession: false };
}

/**
 * Mint a fresh, collision-free directory under `parentDir`. Date.now() alone
 * has millisecond resolution, so two spawns in one tick (a common case: a
 * parallel pstack_spawn batch mints all children synchronously before any
 * await) would otherwise share one directory. That breaks resume: Pi's
 * continueRecent picks the newest session file in --session-dir, so a shared
 * directory can attach the wrong child's transcript. A random suffix alone
 * only makes collision astronomically unlikely; mkdirSync without `recursive`
 * turns "unlikely" into "detected and retried", including across two Pi
 * processes racing on the same repo's .pi/pstack-child-sessions.
 */
function mintChildSessionDir(parentDir: string): string {
  mkdirSync(parentDir, { recursive: true });
  let attempt = 0;
  while (attempt < 20) {
    const dir = join(parentDir, `c-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        attempt = attempt + 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`failed to mint a unique child session dir under ${parentDir} after 20 attempts`);
}
