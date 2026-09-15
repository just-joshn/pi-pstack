/**
 * Pure effect descriptors + applier for state machine side-effects.
 * Keeps reducers pure and unit-testable; applier is the only place that calls Pi/UI.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Effect =
  | { type: "appendEntry"; entryType: string; payload: unknown }
  | { type: "setStatus"; statusId: string; value: string | undefined }
  | { type: "notify"; message: string; level: "info" | "warning" | "error" }
  | { type: "setActiveTools"; tools: string[] };

export interface EffectContext {
  ui: {
    setStatus: (id: string, value: string | undefined) => void;
    notify?: (message: string, level: string) => void;
  };
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
      pi.setActiveTools(effect.tools);
    }
  }
}
