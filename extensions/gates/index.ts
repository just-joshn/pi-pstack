/**
 * Gates: light pre-commit / pre-ship reminders via commands.
 * Full watch-pr scripts remain under skills/poteto-mode/scripts (gh-only v1).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerGates(pi: ExtensionAPI): void {
  pi.registerCommand("pstack-gates", {
    description: "Remind pre-ship gates (unslop, no-comments, prove-it-works)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "Pre-ship: /skill:unslop → /skill:no-comments → prove-it-works on the real artifact. Use scripts/watch-pr for GitHub PR babysit (gh-only).",
        "info",
      );
      pi.sendUserMessage(
        "Run pstack pre-ship gates: unslop the prose surfaces, no-comments on the diff, then verify against the real artifact per principle-prove-it-works.",
      );
    },
  });
}
