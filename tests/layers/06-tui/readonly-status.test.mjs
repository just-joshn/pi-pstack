import { test } from "node:test";
import { ok } from "node:assert/strict";
import { resolve } from "node:path";
import { tmuxAvailable, withTmux } from "../../support/tmux-driver.mjs";
import { makeTempRoot } from "../../support/temp-env.mjs";

test("readonly status: real TUI + real extension", { skip: !tmuxAvailable() }, async () => {
  const tmp = makeTempRoot();
  try {
    const repoExt = resolve(process.cwd(), "extensions/index.ts");

    await withTmux(
      async (fx) => {
        await fx.waitForText(tmp.cwd, 15000);
        await fx.waitForText("No models available", 15000);

        fx.sendLiteral("/pstack-readonly");
        fx.send("Enter");
        await fx.waitForText("Session readonly on (command): write/edit/bash blocked.", 10000);

        const readonlyPane = await fx.waitFor(/readonly/, 10000);
        const count = (readonlyPane.match(/readonly/g) || []).length;
        ok(count >= 2);

        fx.sendLiteral("/pstack-readonly-off");
        fx.send("Enter");
        await fx.waitForText("Session readonly off.", 10000);

        fx.send("C-d");
      },
      { cwd: tmp.cwd, env: tmp.env(), argv: ["pi", "-a", "--no-session", "--no-extensions", "-e", repoExt] },
    );
  } finally {
    tmp.cleanup();
  }
});
