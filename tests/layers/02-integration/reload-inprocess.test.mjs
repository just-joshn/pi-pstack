import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withSession } from "../../support/session.mjs";

async function runReloadInprocessFlow(fixturePath, fixtureV1, fixtureV2, fixtureBroken) {
  await withSession(
    async (f) => {
      const loaded = f.session.resourceLoader.getExtensions();
      expect(loaded.errors.length, `Extension load errors: ${JSON.stringify(loaded.errors)}`).toBe(0);

      const commands = loaded.extensions.flatMap((e) => [...e.commands.keys()]);
      expect(commands.includes("fixture-marker"), "fixture-marker command missing").toBeTruthy();

      await f.prompt("/fixture-marker");
      expect(f.ui.notifications.some(([type, message]) => type === "info" && message === "RELOAD_MARKER_V1"), `V1 notification not found: ${JSON.stringify(f.ui.notifications)}`).toBeTruthy();

      writeFileSync(fixturePath, fixtureV2, "utf8");
      await f.reload();

      const reloadedAfterV2 = f.session.resourceLoader.getExtensions();
      expect(reloadedAfterV2.errors.length, `Extension reload V2 errors: ${JSON.stringify(reloadedAfterV2.errors)}`).toBe(0);

      await f.prompt("/fixture-marker");
      expect(f.ui.notifications.some(([type, message]) => type === "info" && message === "RELOAD_MARKER_V2"), `V2 notification not found: ${JSON.stringify(f.ui.notifications)}`).toBeTruthy();
      expect(f.handlerErrors, `Handler errors: ${JSON.stringify(f.handlerErrors)}`).toEqual([]);

      writeFileSync(fixturePath, fixtureBroken, "utf8");
      await expect(f.reload()).rejects.toSatisfy((err) => {
        expect(err.message.includes("Extension reload failed"), `Expected reload error, got: ${err.message}`).toBeTruthy();
        return true;
      });
    },
    { extensionPaths: [fixturePath] },
  );
}

test("reload picks up fixture changes and rejects syntax errors", async () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-pstack-reload-"));
  const fixturePath = join(fixtureDir, "fixture.ts");

  const fixtureV1 = `export default function(pi) {
  pi.registerCommand("fixture-marker", {
    description: "reload probe",
    handler: async (args, ctx) => {
      ctx.ui.notify("RELOAD_MARKER_V1", "info");
    },
  });
}`;

  const fixtureV2 = `export default function(pi) {
  pi.registerCommand("fixture-marker", {
    description: "reload probe",
    handler: async (args, ctx) => {
      ctx.ui.notify("RELOAD_MARKER_V2", "info");
    },
  });
}`;

  const fixtureBroken = `export default function(pi) {
  pi.registerCommand("fixture-marker", {
    description: "reload probe",
    handler: async (args, ctx) => {
      ctx.ui.notify("BROKEN
    },
  });
}`;

  writeFileSync(fixturePath, fixtureV1, "utf8");

  try {
    await runReloadInprocessFlow(fixturePath, fixtureV1, fixtureV2, fixtureBroken);
  } finally {
    try {
      const { rmSync } = await import("node:fs");
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch { void 0 }
  }
});
