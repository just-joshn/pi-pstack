import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import "../extensions/index.ts";
import { configFile, host, readResult, sandbox } from "./host.mjs";

void test("an extension imported before the test host still uses only the sandbox", async () => {
  const h = host();
  await h.cmd("setup-pstack", "show");
  assert.equal(JSON.parse(h.notifications.at(-1)).path, configFile);
  const history = readResult(await h.call("pstack_history", {}));
  assert.equal(
    history.artifacts,
    join(sandbox, "pstack", "sessions", h.ctx.sessionManager.getSessionId()),
  );
});
