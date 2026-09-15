/**
 * Persist sticky poteto + matched playbook across session restarts (Pi appendEntry twin).
 * Pure helpers for restore/serialize — no ExtensionAPI import so tests stay light.
 */

export const STICKY_ENTRY_TYPE = "pstack-poteto-mode";
export const READONLY_ENTRY_TYPE = "pstack-session-readonly";

export interface StickySessionData {
  enabled: boolean;
  /** Last high-confidence matched playbook id (persisted for restore). */
  matchedPlaybookId?: string | null;
  /** Score at match time (informational). */
  matchedScore?: number;
  /** When sticky was last armed/updated (ms epoch). */
  updatedAt?: number;
}

export interface ReadonlySessionData {
  enabled: boolean;
  /** Why readonly was armed (e.g. investigation playbook). */
  reason?: string;
  updatedAt?: number;
}

export function parseStickyEntry(data: unknown): StickySessionData {
  const d = (data ?? {}) as Partial<StickySessionData>;
  return {
    enabled: d.enabled === true,
    matchedPlaybookId:
      typeof d.matchedPlaybookId === "string" && d.matchedPlaybookId.trim()
        ? d.matchedPlaybookId.trim()
        : d.matchedPlaybookId === null
          ? null
          : undefined,
    matchedScore: typeof d.matchedScore === "number" ? d.matchedScore : undefined,
    updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : undefined,
  };
}

export function parseReadonlyEntry(data: unknown): ReadonlySessionData {
  const d = (data ?? {}) as Partial<ReadonlySessionData>;
  return {
    enabled: d.enabled === true,
    reason: typeof d.reason === "string" ? d.reason : undefined,
    updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : undefined,
  };
}

/** Build sticky appendEntry payload. */
export function stickyEntryPayload(
  enabled: boolean,
  match?: { id: string; score: number } | null,
): StickySessionData {
  return {
    enabled,
    matchedPlaybookId: match?.id ?? (enabled ? undefined : null),
    matchedScore: match?.score,
    updatedAt: Date.now(),
  };
}

/**
 * Force poteto-mode skill invocation text for sendUserMessage.
 * Includes playbook id so expandPromptTemplates + skill body run (not inject-only).
 */
export function forcePotetoSkillMessage(
  task: string,
  playbookId?: string | null,
): string {
  const t = (task ?? "").trim();
  if (playbookId) {
    const pb = `playbooks/${playbookId}`;
    if (!t) return `/skill:poteto-mode ${pb}`;
    if (t.includes(pb) || t.includes(`/skill:poteto-mode`)) {
      return t.startsWith("/skill:poteto-mode") ? t : `/skill:poteto-mode ${t}`;
    }
    return `/skill:poteto-mode ${pb} ${t}`;
  }
  if (!t) return "/skill:poteto-mode";
  return t.startsWith("/skill:poteto-mode") || t.startsWith("/poteto-mode")
    ? t.replace(/^\/poteto-mode\b/, "/skill:poteto-mode")
    : `/skill:poteto-mode ${t}`;
}

/** Playbooks that should auto-arm session readonly when sticky-matched. */
export const AUTO_READONLY_PLAYBOOKS = new Set(["investigation"]);

export function shouldAutoArmReadonly(playbookId: string | undefined | null): boolean {
  return Boolean(playbookId && AUTO_READONLY_PLAYBOOKS.has(playbookId));
}

/** Explicit read-only-playbook invocation is the only skill text that arms readonly. */
export function shouldAutoArmFromSkillText(text: string): boolean {
  return /^\/skill:poteto-mode\s+playbooks\/investigation(?:\s|$)/.test(text.trim());
}
