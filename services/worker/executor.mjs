/**
 * Default worker executor. Spawns a Pi subprocess with the same argv shape the
 * local child runner uses for a fresh isolated child:
 *
 *   pi --mode json -p --model <model> --session-dir <stateDir>/sessions/<runId> <prompt>
 *
 * The compiled policy arrives as PSTACK_CHILD_POLICY, exactly as the local
 * runner passes it. `executor.mjs` stays a thin boundary: argv construction is
 * pure and unit-tested; spawning is the only side effect.
 *
 * secretRefs are names only. This module never resolves or logs a secret value.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

export const WORKER_SESSION_SUBDIR = "sessions";

export function buildWorkerPiArgs(opts) {
  const base = ["--mode", "json", "-p", "--model", opts.model, "--session-dir", opts.sessionDir];
  const thinking = opts.thinkingLevel ? ["--thinking", opts.thinkingLevel] : [];
  return [...base, ...thinking, opts.prompt];
}

/**
 * Resolve the pi binary. `PSTACK_WORKER_PI_BIN` wins so an operator can pin an
 * absolute path. When the worker runs inside the pi process (argv[1] is the pi
 * entry script) we reuse child-runner's process.execPath trick. A standalone
 * worker (`node services/worker/server.mjs`) does not have pi as argv[1], so it
 * falls back to `pi` on PATH.
 */
export function resolvePiInvocation(env = process.env, argv = process.argv) {
  const override = env.PSTACK_WORKER_PI_BIN?.trim();
  if (override) return { command: override, args: [] };
  const script = argv[1];
  const looksLikePi = Boolean(script) && basename(script) === "pi" && !script.startsWith("/$bunfs/root/");
  if (looksLikePi) return { command: process.execPath, args: [script] };
  return { command: "pi", args: [] };
}

export function createPiExecutor({ store }) {
  return async function execute(context) {
    const envelope = context.envelope;
    const sessionDir = join(store.sessionsDir, envelope.runId);
    mkdirSync(sessionDir, { recursive: true });
    const invocation = resolvePiInvocation();
    const args = buildWorkerPiArgs({
      model: envelope.model,
      sessionDir,
      thinkingLevel: envelope.thinkingLevel,
      prompt: envelope.task,
    });
    const child = spawn(invocation.command, [...invocation.args, ...args], {
      cwd: envelope.parentOwnership.cwd || process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PSTACK_CHILD_ROLE: envelope.role,
        PSTACK_CHILD_POLICY: JSON.stringify(envelope.policy),
        PSTACK_HOSTED_RUN_ID: envelope.runId,
      },
    });
    child.stdout.on("data", (chunk) => context.writeStdout(chunk.toString()));
    child.stderr.on("data", (chunk) => context.writeStderr(chunk.toString()));
    let forceKill;
    const onAbort = () => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKill.unref?.();
    };
    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener("abort", onAbort, { once: true });
    const exitCode = await new Promise((resolve) => {
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
    });
    context.signal.removeEventListener("abort", onAbort);
    if (forceKill) clearTimeout(forceKill);
    return { exitCode, stopReason: exitCode === 0 ? "end" : "error" };
  };
}
