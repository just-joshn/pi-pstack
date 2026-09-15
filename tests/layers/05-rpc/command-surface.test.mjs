import { test } from "node:test";
import assert from "node:assert/strict";
import { withRpc } from "../../support/rpc-client.mjs";

test("get_state succeeds without a handshake", async () => {
  await withRpc(async (rpc) => {
    const response = await rpc.request({ type: "get_state" });
    assert.equal(response.success, true, JSON.stringify(response));
    assert.equal(response.command, "get_state");
  });
});

test("commands() exposes the core commands with name and source", async () => {
  await withRpc(async (rpc) => {
    const commands = await rpc.commands();

    assert.ok(commands.length >= 55, `Expected >= 55 commands, got ${commands.length}`);
    assert.ok(
      commands.every((c) => typeof c.name === "string" && c.name.length > 0),
      "command entry with missing name",
    );
    assert.ok(
      commands.every((c) => typeof c.source === "string" && c.source.length > 0),
      "command entry with missing source",
    );

    for (const name of ["poteto-mode", "pstack", "pstack-readonly", "setup-pstack"]) {
      const entry = commands.find((c) => c.name === name);
      assert.ok(entry, `${name} missing from command surface`);
      assert.equal(entry.source, "extension", `${name} source=${entry.source}`);
    }
  });
});

test("close() resolves exit code 0", async () => {
  await withRpc(async (rpc) => {
    await rpc.request({ type: "get_state" });
    const code = await rpc.close();
    assert.equal(code, 0);
  });
});

test("next() resolves a later message and diagnostics read live traffic", async () => {
  await withRpc(async (rpc) => {
    const pending = rpc.next((msg) => msg.type === "response" && msg.command === "get_state");
    const response = await rpc.request({ type: "get_state" });
    const seen = await pending;
    assert.equal(seen.id, response.id);

    await assert.rejects(
      () => rpc.next((msg) => msg.command === "never-emitted", 300),
      (error) => {
        assert.match(error.message, /Timeout waiting for message matching predicate/);
        assert.match(error.message, /get_state/, "diagnostics must include the live message buffer");
        return true;
      },
    );
  });
});
