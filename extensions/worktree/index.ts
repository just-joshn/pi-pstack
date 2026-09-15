/**
 * Worktree helpers for arena/swarm isolation.
 * TODO: deepen git worktree create/cleanup automation; skill playbooks still own policy.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function registerWorktree(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_worktree",
    label: "Pstack Worktree",
    description:
      "Create or list a git worktree path for isolated arena/swarm writes. Thin helper; prefer playbook worktree-cleanup for teardown.",
    promptSnippet: "Allocate an isolated git worktree path",
    parameters: Type.Object({
      action: Type.String({ description: "create | list" }),
      name: Type.Optional(Type.String({ description: "Worktree/branch slug for create" })),
      base: Type.Optional(Type.String({ description: "Base ref (default HEAD)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.action === "list") {
        const listed = await pi.exec("git", ["worktree", "list", "--porcelain"], { signal });
        return {
          content: [{ type: "text", text: listed.stdout || listed.stderr || "(no worktrees)" }],
          details: { code: listed.code },
        };
      }
      if (params.action !== "create") throw new Error("action must be create or list");
      const slug = params.name ?? `pstack-${Date.now()}`;
      const path = `${ctx.cwd}/.pstack-worktrees/${slug}`;
      const base = params.base ?? "HEAD";
      const branch = `pstack/${slug}`;
      // TODO: harden for dirty trees / existing branches
      const add = await pi.exec(
        "git",
        ["worktree", "add", "-b", branch, path, base],
        { signal },
      );
      if (add.code !== 0) {
        throw new Error(`git worktree add failed: ${add.stderr || add.stdout}`);
      }
      return {
        content: [{ type: "text", text: `Created worktree ${path} on ${branch}` }],
        details: { path, branch },
      };
    },
  });
}
