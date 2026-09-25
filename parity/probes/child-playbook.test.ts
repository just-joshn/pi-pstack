import { expect, test } from "bun:test";
import { isNonPotetoChild } from "../../extensions/pstack-guards.ts";
test("only non-poteto Task children are fenced off poteto-mode playbooks", () => {
  expect(isNonPotetoChild({})).toBe(false);
  expect(isNonPotetoChild({ PSTACK_AGENTS_DEPTH: "0" })).toBe(false);
  expect(isNonPotetoChild({ PSTACK_AGENTS_DEPTH: "1", PSTACK_AGENTS_AGENT: "poteto-agent" })).toBe(false);
  expect(isNonPotetoChild({ PSTACK_AGENTS_DEPTH: "1", PSTACK_AGENTS_AGENT: "pstack-general" })).toBe(true);
  expect(isNonPotetoChild({ PSTACK_AGENTS_DEPTH: "2", PSTACK_AGENTS_AGENT: "pstack-reader" })).toBe(true);
});
