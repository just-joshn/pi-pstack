import { expect, test } from "bun:test";
import { modelMatchesScope } from "./agents.ts";
const policy = { enforce: true, allow: ["openai-codex/gpt-6-luna", "anthropic/claude-opus-5-5:low", "inherit"] };
test("opus only at low", () => {
  expect(modelMatchesScope("anthropic/claude-opus-5-5:low", policy, false)).toBe(true);
  expect(modelMatchesScope("anthropic/claude-opus-5-5:max", policy, false)).toBe(false);
  expect(modelMatchesScope("anthropic/claude-opus-5-5", policy, false)).toBe(false);
  expect(modelMatchesScope("anthropic/claude-fable-5-1:low", policy, false)).toBe(false);
  expect(modelMatchesScope("openai-codex/gpt-6-luna:max", policy, false)).toBe(true);
});
