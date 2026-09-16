import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLoopController } from "../../../extensions/loop/controller.ts";
import { listRuns } from "../../../extensions/loop/run-store.ts";

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

test("an arm whose timer cannot start leaves a readable record and no phantom loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-arm-no-heartbeat-"));
  const previous = process.env.PSTACK_RUNS_DIR;
  process.env.PSTACK_RUNS_DIR = dir;
  try {
    const tools = new Map<string, CapturedTool>();
    const pi = {
      on() {},
      registerCommand() {},
      registerTool(definition: CapturedTool) {
        tools.set(definition.name, definition);
      },
      sendUserMessage() {},
    };
    registerLoopController(pi as never);
    const run = tools.get("pstack_run");
    assert.ok(run, "pstack_run registers without the heartbeat extension");
    assert.equal(tools.has("pstack_loop"), false);
    const ctx = { ui: { setStatus() {}, notify() {} } };
    await assert.rejects(
      () =>
        run.execute(
          "t",
          { action: "arm", runId: "run-no-heartbeat", predicate: "ci green", intervalSeconds: 30 },
          undefined,
          undefined,
          ctx,
        ),
      /armProgrammaticLoop requires a registered heartbeat runtime/,
    );
    assert.deepEqual(
      listRuns().map((record) => `${record.runId} ${record.phase}`),
      ["run-no-heartbeat WAIT_FOR_EVENT_OR_HEARTBEAT"],
    );
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_RUNS_DIR");
    else process.env.PSTACK_RUNS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
