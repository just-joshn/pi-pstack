import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPiOnlyCommands, registerSkillCommands } from "../../../extensions/commands/skill-commands.ts";
import { registerCompanions } from "../../../extensions/companions/index.ts";

type Pi = Parameters<typeof registerCompanions>[0];

function recordingPi(): { pi: Pi; names: () => string[] } {
  let names: string[] = [];
  const fake = {
    registerCommand(name: string) {
      names = [...names, name];
    },
    registerTool() {},
  };
  return { pi: fake as unknown as Pi, names: () => names };
}

test("the modules that own commands register each name exactly once", () => {
  const { pi, names } = recordingPi();
  registerSkillCommands(pi);
  registerPiOnlyCommands(pi);
  registerCompanions(pi);

  const registered = names();
  const duplicates = registered.filter((name, index) => registered.indexOf(name) !== index);
  assert.deepEqual(duplicates, [], `duplicate command registrations: ${duplicates.join(", ")}`);
  assert.ok(registered.includes("deslop"), "companions owns the deslop command");
  assert.ok(registered.includes("babysit"), "the pi-only commands still register");
});
