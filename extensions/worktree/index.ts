/**
 * Worktree helpers for arena/swarm isolation + session_shutdown safe cleanup.
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { execOptions } from "../lib/exec-options.ts";
import {
  MAX_PSTACK_WORKTREES,
  cleanupPstackWorktreesOnShutdown,
  createIsolatedWorktree,
  countPstackWorktrees,
  pruneWorktrees,
  removeWorktree,
  sanitizeBaseRef,
  sanitizeWorktreeName,
} from "./helpers.ts";

export {
  MAX_PSTACK_WORKTREES,
  cleanupPstackWorktreesOnShutdown,
  createIsolatedWorktree,
  ensureAlwaysIsolated,
  ensureWriterIsolation,
  pruneWorktrees,
  removeWorktree,
  sanitizeBaseRef,
  sanitizeWorktreeName,
} from "./helpers.ts";

type WorktreeParams = {
  action: string;
  name?: string;
  base?: string;
};

async function executeWorktreeList(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<{ code: number; count: number }>> {
  const listed = await pi.exec("git", ["worktree", "list", "--porcelain"], execOptions({ signal }));
  const count = countPstackWorktrees(ctx.cwd);
  return {
    content: [
      {
        type: "text",
        text: `${listed.stdout || listed.stderr || "(no worktrees)"}\n\npstack-managed under .pstack-worktrees: ${count}/${MAX_PSTACK_WORKTREES}`,
      },
    ],
    details: { code: listed.code, count },
  };
}

async function executeWorktreePrune(ctx: ExtensionContext): Promise<AgentToolResult<Record<string, never>>> {
  const out = await pruneWorktrees(ctx.cwd);
  return { content: [{ type: "text", text: out }], details: {} };
}

async function executeWorktreeCleanup(ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
  const result = await cleanupPstackWorktreesOnShutdown(ctx.cwd);
  return {
    content: [
      {
        type: "text",
        text: `cleanup removed=[${result.removed.join(", ")}] skipped=${result.skipped.length} prune=${result.pruned}`,
      },
    ],
    details: result,
  };
}

async function executeWorktreeRemove(
  ctx: ExtensionContext,
  name: string | undefined,
): Promise<AgentToolResult<unknown>> {
  if (!name) throw new Error("name required for remove");
  const path = await removeWorktree(ctx.cwd, name);
  return {
    content: [{ type: "text", text: `Removed worktree ${path}` }],
    details: { path },
  };
}

async function executeWorktreeCreate(
  ctx: ExtensionContext,
  params: WorktreeParams,
): Promise<AgentToolResult<unknown>> {
  if (params.name) sanitizeWorktreeName(params.name);
  if (params.base) sanitizeBaseRef(params.base);
  const slug = params.name ?? `pstack-${Date.now()}`;
  const { path, branch } = await createIsolatedWorktree(ctx.cwd, slug, params.base ?? "HEAD");
  return {
    content: [{ type: "text", text: `Created worktree ${path} on ${branch}` }],
    details: { path, branch },
  };
}

async function executeWorktree(
  pi: ExtensionAPI,
  params: WorktreeParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  if (params.action === "list") return await executeWorktreeList(pi, ctx, signal);
  if (params.action === "prune") return await executeWorktreePrune(ctx);
  if (params.action === "cleanup") return await executeWorktreeCleanup(ctx);
  if (params.action === "remove") return await executeWorktreeRemove(ctx, params.name);
  if (params.action !== "create") {
    throw new Error("action must be create|list|remove|prune|cleanup");
  }
  return await executeWorktreeCreate(ctx, params);
}

function registerWorktreeShutdown(pi: ExtensionAPI): void {
  // Auto-cleanup pstack-owned empty/merged worktrees when the session ends.
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await cleanupPstackWorktreesOnShutdown(ctx.cwd);
    } catch {
      return;
    }
  });
}

function registerWorktreeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_worktree",
    label: "Pstack Worktree",
    description:
      `Create/list/remove/prune git worktrees for isolated arena/swarm writes. Create rejects path/option injection and enforces a session cap of ${MAX_PSTACK_WORKTREES}. On session_shutdown, empty/merged pstack-owned trees under .pstack-worktrees are auto-removed (dirty/unmerged skipped).`,
    promptSnippet: "Allocate an isolated git worktree path",
    parameters: Type.Object({
      action: StringEnum(["create", "list", "remove", "prune", "cleanup"] as const, {
        description: "create | list | remove | prune | cleanup",
      }),
      name: Type.Optional(Type.String({ description: "Worktree/branch slug for create/remove" })),
      base: Type.Optional(Type.String({ description: "Base ref (default HEAD)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      return await executeWorktree(pi, params, signal, ctx);
    },
  });
}

export function registerWorktree(pi: ExtensionAPI): void {
  registerWorktreeShutdown(pi);
  registerWorktreeTool(pi);
}
