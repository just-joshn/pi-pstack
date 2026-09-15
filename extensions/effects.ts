/**
 * Pure effect descriptors + applier for state machine side-effects.
 * Keeps reducers pure and unit-testable; applier is the only place that calls Pi/UI.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Effect =
  | { type: "appendEntry"; entryType: string; payload: unknown }
  | { type: "setStatus"; statusId: string; value: string | undefined }
  | { type: "notify"; message: string; level: "info" | "warning" | "error" }
  | { type: "setActiveTools"; tools: string[]; guarded?: boolean };

export interface EffectContext {
  ui: {
    setStatus: (id: string, value: string | undefined) => void;
    notify?: (message: string, level: string) => void;
  };
}

function restoreToolsQuietly(pi: ExtensionAPI, tools: string[]): void {
  try {
    pi.setActiveTools(tools);
  } catch {
    // The session can be tearing down while readonly turns off; a rejected tool
    // write there is not actionable and must not abort the remaining effects.
    return;
  }
}

export function applyEffects(
  pi: ExtensionAPI,
  ctx: EffectContext,
  effects: readonly Effect[],
): void {
  for (const effect of effects) {
    if (effect.type === "appendEntry") {
      pi.appendEntry(effect.entryType, effect.payload);
    } else if (effect.type === "setStatus") {
      ctx.ui.setStatus(effect.statusId, effect.value);
    } else if (effect.type === "notify") {
      ctx.ui.notify?.(effect.message, effect.level);
    } else if (effect.type === "setActiveTools") {
      if (effect.guarded) restoreToolsQuietly(pi, effect.tools);
      else pi.setActiveTools(effect.tools);
    }
  }
}
