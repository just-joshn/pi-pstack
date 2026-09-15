import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withSession } from "../../support/session.mjs";

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
    await withSession(
      async (f) => {
        const loaded = f.session.resourceLoader.getExtensions();
        assert.equal(loaded.errors.length, 0, `Extension load errors: ${JSON.stringify(loaded.errors)}`);

        const commands = loaded.extensions.flatMap((e) => [...e.commands.keys()]);
        assert.ok(commands.includes("fixture-marker"), "fixture-marker command missing");

        await f.prompt("/fixture-marker");
        assert.ok(
          f.ui.notifications.some(([type, message]) => type === "info" && message === "RELOAD_MARKER_V1"),
          `V1 notification not found: ${JSON.stringify(f.ui.notifications)}`,
        );

        writeFileSync(fixturePath, fixtureV2, "utf8");
        await f.reload();

        const reloadedAfterV2 = f.session.resourceLoader.getExtensions();
        assert.equal(reloadedAfterV2.errors.length, 0, `Extension reload V2 errors: ${JSON.stringify(reloadedAfterV2.errors)}`);

        await f.prompt("/fixture-marker");
        assert.ok(
          f.ui.notifications.some(([type, message]) => type === "info" && message === "RELOAD_MARKER_V2"),
          `V2 notification not found: ${JSON.stringify(f.ui.notifications)}`,
        );
        assert.deepEqual(f.handlerErrors, [], `Handler errors: ${JSON.stringify(f.handlerErrors)}`);

        writeFileSync(fixturePath, fixtureBroken, "utf8");
        await assert.rejects(
          async () => await f.reload(),
          (err) => {
            assert.ok(
              err.message.includes("Extension reload failed"),
              `Expected reload error, got: ${err.message}`,
            );
            return true;
          },
        );
      },
      { extensionPaths: [fixturePath] },
    );
  } finally {
    try {
      const { rmSync } = await import("node:fs");
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {}
  }
});
