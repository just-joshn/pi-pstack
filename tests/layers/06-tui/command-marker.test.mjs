import { expect, test } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmuxAvailable, withTmux } from "../../support/tmux-driver.mjs";
import { makeTempRoot } from "../../support/temp-env.mjs";

test("command marker: key-driven command execution", { skip: !tmuxAvailable() }, async () => {
  const tmp = makeTempRoot();
  try {
    mkdirSync(join(tmp.cwd, ".pi/extensions"), { recursive: true });

    const marker = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerCommand("marker-ping", { description: "marker", handler: async (_a, ctx) => { ctx.ui.notify("TUI_MARKER_V1", "info"); } });
  pi.on("session_start", (_event, ctx) => { ctx.ui.notify(\`SESSION_START:\${_event.reason}\`, "info"); });
}`;
    writeFileSync(join(tmp.cwd, ".pi/extensions/marker.ts"), marker);

    await withTmux(
      async (fx) => {
        await fx.waitForText(tmp.cwd, 15000);
        await fx.waitForText("No models available", 15000);
        await fx.waitForText("SESSION_START:startup", 15000);

        fx.sendLiteral("/marker-ping");
        fx.send("Enter");
        const pane = await fx.waitForText("TUI_MARKER_V1", 10000);

        const startIdx = pane.indexOf("SESSION_START:startup");
        const markerIdx = pane.indexOf("TUI_MARKER_V1");
        expect(startIdx !== -1).toBeTruthy();
        expect(markerIdx !== -1).toBeTruthy();
        expect(startIdx < markerIdx).toBeTruthy();
      },
      { cwd: tmp.cwd, env: tmp.env(), argv: ["pi", "-a", "--no-session"] },
    );
  } finally {
    tmp.cleanup();
  }
});
