import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_READONLY_PLAYBOOKS,
  forcePotetoSkillMessage,
  parseReadonlyEntry,
  parseStickyEntry,
  shouldAutoArmFromPlaybookMatch,
  shouldAutoArmFromSkillText,
  shouldAutoArmReadonly,
  shouldMatchStickyInput,
  stickyEntryPayload,
} from "../../../extensions/sticky-session.ts";

test("stickyEntryPayload round-trips enabled match through parseStickyEntry", () => {
  const payload = stickyEntryPayload(true, { id: "bug-fix", score: 7 });
  assert.equal(payload.enabled, true);
  assert.equal(payload.matchedPlaybookId, "bug-fix");
  assert.equal(payload.matchedScore, 7);
  assert.equal(typeof payload.updatedAt, "number");

  const restored = parseStickyEntry(payload);
  assert.equal(restored.enabled, true);
  assert.equal(restored.matchedPlaybookId, "bug-fix");
  assert.equal(restored.matchedScore, 7);
  assert.equal(restored.updatedAt, payload.updatedAt);
});

test("stickyEntryPayload(false) clears the matched playbook id to null", () => {
  const payload = stickyEntryPayload(false);
  assert.equal(payload.enabled, false);
  assert.equal(payload.matchedPlaybookId, null);
  assert.equal(payload.matchedScore, undefined);

  const restored = parseStickyEntry(payload);
  assert.equal(restored.enabled, false);
  assert.equal(restored.matchedPlaybookId, null);
});

test("parseStickyEntry returns a disabled entry for garbage input instead of throwing", () => {
  const disabled = {
    enabled: false,
    matchedPlaybookId: undefined,
    matchedScore: undefined,
    updatedAt: undefined,
  };
  assert.deepEqual(parseStickyEntry(null), disabled);
  assert.deepEqual(parseStickyEntry(undefined), disabled);
  assert.deepEqual(parseStickyEntry({}), disabled);
  assert.deepEqual(parseStickyEntry({ enabled: "yes" }), disabled);
  assert.deepEqual(parseStickyEntry("garbage"), disabled);
  assert.deepEqual(parseStickyEntry(0), disabled);
});

test("parseStickyEntry keeps only typed fields and trims the playbook id", () => {
  assert.deepEqual(parseStickyEntry({ enabled: true, matchedPlaybookId: "  bug-fix  " }), {
    enabled: true,
    matchedPlaybookId: "bug-fix",
    matchedScore: undefined,
    updatedAt: undefined,
  });
  assert.deepEqual(parseStickyEntry({ enabled: true, matchedPlaybookId: 42 }), {
    enabled: true,
    matchedPlaybookId: undefined,
    matchedScore: undefined,
    updatedAt: undefined,
  });
  assert.deepEqual(parseStickyEntry({ enabled: true, matchedScore: "7" }), {
    enabled: true,
    matchedPlaybookId: undefined,
    matchedScore: undefined,
    updatedAt: undefined,
  });
});

test("parseReadonlyEntry round-trips an armed entry", () => {
  assert.deepEqual(parseReadonlyEntry({ enabled: true, reason: "command" }), {
    enabled: true,
    reason: "command",
    updatedAt: undefined,
  });
});

test("parseReadonlyEntry returns a disabled entry for garbage input", () => {
  assert.deepEqual(parseReadonlyEntry(null), {
    enabled: false,
    reason: undefined,
    updatedAt: undefined,
  });
  assert.deepEqual(parseReadonlyEntry({ enabled: "yes", reason: 7 }), {
    enabled: false,
    reason: undefined,
    updatedAt: undefined,
  });
});

test("shouldMatchStickyInput accepts interactive, rpc, and unknown provenance only", () => {
  assert.equal(shouldMatchStickyInput("interactive"), true);
  assert.equal(shouldMatchStickyInput("rpc"), true);
  assert.equal(shouldMatchStickyInput(undefined), true);
  assert.equal(shouldMatchStickyInput("extension"), false);
  assert.equal(shouldMatchStickyInput(""), false);
});

test("shouldAutoArmReadonly arms only the investigation playbook", () => {
  assert.deepEqual([...AUTO_READONLY_PLAYBOOKS], ["investigation"]);
  assert.equal(shouldAutoArmReadonly("investigation"), true);
  assert.equal(shouldAutoArmReadonly("bug-fix"), false);
  assert.equal(shouldAutoArmReadonly(undefined), false);
  assert.equal(shouldAutoArmReadonly(null), false);
});

test("shouldAutoArmFromPlaybookMatch requires investigation, a short text, and arm or score >= 5", () => {
  assert.equal(shouldAutoArmFromPlaybookMatch("investigation", false, 1, "short ask"), false);
  assert.equal(shouldAutoArmFromPlaybookMatch("investigation", false, 4, "short ask"), false);
  assert.equal(shouldAutoArmFromPlaybookMatch("investigation", false, 5, "short ask"), true);
  assert.equal(shouldAutoArmFromPlaybookMatch("investigation", true, 0, "short ask"), true);
  assert.equal(shouldAutoArmFromPlaybookMatch("bug-fix", true, 9, "short ask"), false);
  assert.equal(shouldAutoArmFromPlaybookMatch("investigation", true, 9, "x".repeat(401)), false);
});

test("shouldAutoArmFromSkillText arms only an explicit investigation skill invocation", () => {
  assert.equal(shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/investigation"), true);
  assert.equal(shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/investigation dig in"), true);
  assert.equal(shouldAutoArmFromSkillText("  /skill:poteto-mode playbooks/investigation  "), true);
  assert.equal(shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/bug-fix"), false);
  assert.equal(shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/investigation-extra"), false);
  assert.equal(shouldAutoArmFromSkillText("please /skill:poteto-mode playbooks/investigation"), false);
});

test("forcePotetoSkillMessage prefixes the playbook path and keeps an existing invocation", () => {
  assert.equal(
    forcePotetoSkillMessage("fix the parser", "bug-fix"),
    "/skill:poteto-mode playbooks/bug-fix fix the parser",
  );
  assert.equal(forcePotetoSkillMessage("", "bug-fix"), "/skill:poteto-mode playbooks/bug-fix");
  assert.equal(
    forcePotetoSkillMessage("/skill:poteto-mode playbooks/bug-fix do it", "bug-fix"),
    "/skill:poteto-mode playbooks/bug-fix do it",
  );
  const withoutPlaybook = forcePotetoSkillMessage("investigate the flake");
  assert.equal(withoutPlaybook, "/skill:poteto-mode investigate the flake");

  const output = forcePotetoSkillMessage("fix the parser", "bug-fix");
  assert.ok(output.includes("/skill:poteto-mode"), `missing skill marker in ${output}`);
  assert.ok(output.includes("bug-fix"), `missing playbook id in ${output}`);
});
