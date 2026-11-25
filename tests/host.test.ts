import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import "../src/index.ts";
import { configFile, host, readResult, sandbox } from "./host.ts";
import { shaped } from "./support.ts";

await describe("test host", async () => {
  await test("an extension imported before the test host still uses only the sandbox", async () => {
    const h = host();
    await h.cmd("setup-pstack", "show");
    assert.equal(h.shown().path, configFile);
    const history = shaped<{ artifacts: string }>(readResult(await h.call("pstack_history", {})));
    assert.equal(
      history.artifacts,
      join(sandbox, "pstack", "sessions", h.ctx.sessionManager.getSessionId()),
    );
  });
});
