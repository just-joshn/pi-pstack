/**
 * Worktree helpers for arena/swarm isolation + session_shutdown safe cleanup.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

export function registerWorktree(pi: ExtensionAPI): void {
  // Auto-cleanup pstack-owned empty/merged worktrees when the session ends.
  pi.on("session_shutdown", async () => {
    try {
      const cwd = process.cwd();
      await cleanupPstackWorktreesOnShutdown(cwd);
    } catch {
      // Best-effort cleanup must never block shutdown.
      return;
    }
  });

  pi.registerTool({
    name: "pstack_worktree",
    label: "Pstack Worktree",
    description:
      `Create/list/remove/prune git worktrees for isolated arena/swarm writes. Create rejects path/option injection and enforces a session cap of ${MAX_PSTACK_WORKTREES}. On session_shutdown, empty/merged pstack-owned trees under .pstack-worktrees are auto-removed (dirty/unmerged skipped).`,
    promptSnippet: "Allocate an isolated git worktree path",
    parameters: Type.Object({
      action: Type.String({ description: "create | list | remove | prune | cleanup" }),
      name: Type.Optional(Type.String({ description: "Worktree/branch slug for create/remove" })),
      base: Type.Optional(Type.String({ description: "Base ref (default HEAD)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.action === "list") {
        const listed = await pi.exec("git", ["worktree", "list", "--porcelain"], { signal });
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
      if (params.action === "prune") {
        const out = await pruneWorktrees(ctx.cwd);
        return { content: [{ type: "text", text: out }], details: {} };
      }
      if (params.action === "cleanup") {
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
      if (params.action === "remove") {
        if (!params.name) throw new Error("name required for remove");
        const path = await removeWorktree(ctx.cwd, params.name);
        return {
          content: [{ type: "text", text: `Removed worktree ${path}` }],
          details: { path },
        };
      }
      if (params.action !== "create") {
        throw new Error("action must be create|list|remove|prune|cleanup");
      }
      if (params.name) sanitizeWorktreeName(params.name);
      if (params.base) sanitizeBaseRef(params.base);
      const slug = params.name ?? `pstack-${Date.now()}`;
      const { path, branch } = await createIsolatedWorktree(ctx.cwd, slug, params.base ?? "HEAD");
      return {
        content: [{ type: "text", text: `Created worktree ${path} on ${branch}` }],
        details: { path, branch },
      };
    },
  });
}
