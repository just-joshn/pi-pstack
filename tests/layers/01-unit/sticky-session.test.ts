import { expect, test } from "vitest";
import {
  AUTO_READONLY_PLAYBOOKS,
  PLAYBOOK_ASSIGN_SCORE,
  forcePotetoSkillMessage,
  parseReadonlyEntry,
  parseStickyEntry,
  shouldAssignPlaybook,
  shouldAutoArmFromPlaybookMatch,
  shouldAutoArmFromSkillText,
  shouldAutoArmReadonly,
  shouldMatchStickyInput,
  stickyEntryPayload,
} from "../../../extensions/sticky-session.ts";

test("shouldAssignPlaybook keeps an ongoing playbook until a strong match arrives", () => {
  expect(shouldAssignPlaybook(null, 2), "first assignment may be weak").toBe(true);
  expect(shouldAssignPlaybook("babysit", 2), "a casual turn must not reassign").toBe(false);
  expect(shouldAssignPlaybook("babysit", PLAYBOOK_ASSIGN_SCORE - 1)).toBe(false);
  expect(shouldAssignPlaybook("babysit", PLAYBOOK_ASSIGN_SCORE)).toBe(true);
  expect(shouldAssignPlaybook("babysit", 9)).toBe(true);
});

test("stickyEntryPayload round-trips enabled match through parseStickyEntry", () => {
  const payload = stickyEntryPayload(true, { id: "bug-fix", score: 7 });
  expect(payload.enabled).toBe(true);
  expect(payload.matchedPlaybookId).toBe("bug-fix");
  expect(payload.matchedScore).toBe(7);
  expect(typeof payload.updatedAt).toBe("number");

  const restored = parseStickyEntry(payload);
  expect(restored.enabled).toBe(true);
  expect(restored.matchedPlaybookId).toBe("bug-fix");
  expect(restored.matchedScore).toBe(7);
  expect(restored.updatedAt).toBe(payload.updatedAt);
});

test("stickyEntryPayload(false) clears the matched playbook id to null", () => {
  const payload = stickyEntryPayload(false);
  expect(payload.enabled).toBe(false);
  expect(payload.matchedPlaybookId).toBe(null);
  expect(payload.matchedScore).toBe(undefined);

  const restored = parseStickyEntry(payload);
  expect(restored.enabled).toBe(false);
  expect(restored.matchedPlaybookId).toBe(null);
});

test("parseStickyEntry returns a disabled entry for garbage input instead of throwing", () => {
  const disabled = {
    enabled: false,
    matchedPlaybookId: undefined,
    matchedScore: undefined,
    updatedAt: undefined,
  };
  expect(parseStickyEntry(null)).toEqual(disabled);
  expect(parseStickyEntry(undefined)).toEqual(disabled);
  expect(parseStickyEntry({})).toEqual(disabled);
  expect(parseStickyEntry({ enabled: "yes" })).toEqual(disabled);
  expect(parseStickyEntry("garbage")).toEqual(disabled);
  expect(parseStickyEntry(0)).toEqual(disabled);
});

test("parseStickyEntry keeps only typed fields and trims the playbook id", () => {
  expect(parseStickyEntry({ enabled: true, matchedPlaybookId: "  bug-fix  " })).toEqual({
    enabled: true,
    matchedPlaybookId: "bug-fix",
    matchedScore: undefined,
    updatedAt: undefined,
  });
  expect(parseStickyEntry({ enabled: true, matchedPlaybookId: 42 })).toEqual({
    enabled: true,
    matchedPlaybookId: undefined,
    matchedScore: undefined,
    updatedAt: undefined,
  });
  expect(parseStickyEntry({ enabled: true, matchedScore: "7" })).toEqual({
    enabled: true,
    matchedPlaybookId: undefined,
    matchedScore: undefined,
    updatedAt: undefined,
  });
});

test("parseReadonlyEntry round-trips an armed entry", () => {
  expect(parseReadonlyEntry({ enabled: true, reason: "command" })).toEqual({
    enabled: true,
    reason: "command",
    updatedAt: undefined,
  });
});

test("parseReadonlyEntry returns a disabled entry for garbage input", () => {
  expect(parseReadonlyEntry(null)).toEqual({
    enabled: false,
    reason: undefined,
    updatedAt: undefined,
  });
  expect(parseReadonlyEntry({ enabled: "yes", reason: 7 })).toEqual({
    enabled: false,
    reason: undefined,
    updatedAt: undefined,
  });
});

test("shouldMatchStickyInput accepts interactive, rpc, and unknown provenance only", () => {
  expect(shouldMatchStickyInput("interactive")).toBe(true);
  expect(shouldMatchStickyInput("rpc")).toBe(true);
  expect(shouldMatchStickyInput(undefined)).toBe(true);
  expect(shouldMatchStickyInput("extension")).toBe(false);
  expect(shouldMatchStickyInput("")).toBe(false);
});

test("shouldAutoArmReadonly arms only the investigation playbook", () => {
  expect([...AUTO_READONLY_PLAYBOOKS]).toEqual(["investigation"]);
  expect(shouldAutoArmReadonly("investigation")).toBe(true);
  expect(shouldAutoArmReadonly("bug-fix")).toBe(false);
  expect(shouldAutoArmReadonly(undefined)).toBe(false);
  expect(shouldAutoArmReadonly(null)).toBe(false);
});

test("shouldAutoArmFromPlaybookMatch requires investigation, a short text, and arm or score >= 5", () => {
  expect(shouldAutoArmFromPlaybookMatch("investigation", false, 1, "short ask")).toBe(false);
  expect(shouldAutoArmFromPlaybookMatch("investigation", false, 4, "short ask")).toBe(false);
  expect(shouldAutoArmFromPlaybookMatch("investigation", false, 5, "short ask")).toBe(true);
  expect(shouldAutoArmFromPlaybookMatch("investigation", true, 0, "short ask")).toBe(true);
  expect(shouldAutoArmFromPlaybookMatch("bug-fix", true, 9, "short ask")).toBe(false);
  expect(shouldAutoArmFromPlaybookMatch("investigation", true, 9, "x".repeat(401))).toBe(false);
});

test("shouldAutoArmFromSkillText arms only an explicit investigation skill invocation", () => {
  expect(shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/investigation")).toBe(true);
  expect(shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/investigation dig in")).toBe(true);
  expect(shouldAutoArmFromSkillText("  /skill:poteto-mode playbooks/investigation  ")).toBe(true);
  expect(shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/bug-fix")).toBe(false);
  expect(shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/investigation-extra")).toBe(false);
  expect(shouldAutoArmFromSkillText("please /skill:poteto-mode playbooks/investigation")).toBe(false);
});

test("forcePotetoSkillMessage prefixes the playbook path and keeps an existing invocation", () => {
  expect(forcePotetoSkillMessage("fix the parser", "bug-fix")).toBe("/skill:poteto-mode playbooks/bug-fix fix the parser");
  expect(forcePotetoSkillMessage("", "bug-fix")).toBe("/skill:poteto-mode playbooks/bug-fix");
  expect(forcePotetoSkillMessage("/skill:poteto-mode playbooks/bug-fix do it", "bug-fix")).toBe("/skill:poteto-mode playbooks/bug-fix do it");
  const withoutPlaybook = forcePotetoSkillMessage("investigate the flake");
  expect(withoutPlaybook).toBe("/skill:poteto-mode investigate the flake");

  const output = forcePotetoSkillMessage("fix the parser", "bug-fix");
  expect(output.includes("/skill:poteto-mode"), `missing skill marker in ${output}`).toBeTruthy();
  expect(output.includes("bug-fix"), `missing playbook id in ${output}`).toBeTruthy();
});
