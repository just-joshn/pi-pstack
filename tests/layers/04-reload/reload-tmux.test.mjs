import { test } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmuxAvailable, withTmux } from "../../support/tmux-driver.mjs";
import { makeTempRoot } from "../../support/temp-env.mjs";

test("reload tmux: documented dev loop", { skip: !tmuxAvailable() }, async () => {
  const tmp = makeTempRoot();
  try {
    mkdirSync(join(tmp.cwd, ".pi/extensions"), { recursive: true });

    const fixtureV1 = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const MARK = "RELOAD_MARKER_V1";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("fixture-ping", { description: "mark", handler: async (_a, ctx) => { ctx.ui.notify(MARK, "info"); } });
}`;
    writeFileSync(join(tmp.cwd, ".pi/extensions/fixture.ts"), fixtureV1);

    await withTmux(
      async (fx) => {
        await fx.waitForText(tmp.cwd, 15000);
        await fx.waitForText("No models available", 15000);

        fx.sendLiteral("/fixture-ping");
        fx.send("Enter");
        await fx.waitForText("RELOAD_MARKER_V1", 10000);

        const fixtureV2 = fixtureV1.replace(/RELOAD_MARKER_V1/g, "RELOAD_MARKER_V2");
        writeFileSync(join(tmp.cwd, ".pi/extensions/fixture.ts"), fixtureV2);

        fx.sendLiteral("/reload");
        fx.send("Enter");
        await fx.waitForText("Reloaded", 10000);
        fx.sendLiteral("/fixture-ping");
        fx.send("Enter");
        const afterReload = await fx.waitForText("RELOAD_MARKER_V2", 10000);
        const v2Idx = afterReload.lastIndexOf("RELOAD_MARKER_V2");
        const v1Idx = afterReload.lastIndexOf("RELOAD_MARKER_V1");
        ok(v2Idx > v1Idx, "RELOAD_MARKER_V2 must be the most recent marker after reload");

        const syntaxError = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  this is a syntax error
}`;
        writeFileSync(join(tmp.cwd, ".pi/extensions/fixture.ts"), syntaxError);
        fx.sendLiteral("/reload");
        fx.send("Enter");
        const errorPane = await fx.waitForText("Failed to load extension", 10000);
        ok(errorPane.includes("[Extension issues]"), "extension issues block missing");
      },
      { cwd: tmp.cwd, env: tmp.env(), argv: ["pi", "-a", "--no-session"] },
    );
  } finally {
    tmp.cleanup();
  }
});
