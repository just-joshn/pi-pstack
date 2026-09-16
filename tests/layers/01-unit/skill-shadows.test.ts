import { expect, test } from "vitest";
import { registerSkillCommands } from "../../../extensions/commands/skill-commands.ts";

function fakePi() {
  const registered = new Map<string, boolean>();
  return {
    registered,
    registerCommand: (name: string) => {
      registered.set(name, true);
    },
    sendUserMessage: () => {},
  };
}

test("commands-07 the models command keeps sole ownership of the setup-pstack slash name", () => {
  const pi = fakePi();
  registerSkillCommands(pi as never);
  const names = [...pi.registered.keys()];
  expect(names.length > 40, `the real skill tree must register its shims, saw ${names.length}`).toBeTruthy();
  expect(names.includes("tdd"), "an ordinary skill shim must still register").toBeTruthy();
  expect(!pi.registered.has("setup-pstack"), "the skill shim must not claim the name the models command owns").toBeTruthy();
});
