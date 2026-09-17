import { expect, test } from "vitest";
import { withRpc } from "../../support/rpc-client.mjs";

test("get_state succeeds without a handshake", async () => {
  await withRpc(async (rpc) => {
    const response = await rpc.request({ type: "get_state" });
    expect(response.success, JSON.stringify(response)).toBe(true);
    expect(response.command).toBe("get_state");
  });
});

test("commands() exposes the core commands with name and source", async () => {
  await withRpc(async (rpc) => {
    const commands = await rpc.commands();

    expect(commands.length >= 55, `Expected >= 55 commands, got ${commands.length}`).toBeTruthy();
    expect(commands.every((c) => typeof c.name === "string" && c.name.length > 0), "command entry with missing name").toBeTruthy();
    expect(commands.every((c) => typeof c.source === "string" && c.source.length > 0), "command entry with missing source").toBeTruthy();

    for (const name of ["poteto-mode", "pstack", "pstack-readonly", "setup-pstack"]) {
      const entry = commands.find((c) => c.name === name);
      expect(entry, `${name} missing from command surface`).toBeTruthy();
      expect(entry.source, `${name} source=${entry.source}`).toBe("extension");
    }
  });
});

test("close() resolves exit code 0", async () => {
  await withRpc(async (rpc) => {
    await rpc.request({ type: "get_state" });
    const code = await rpc.close();
    expect(code).toBe(0);
  });
});

test("next() resolves a later message and diagnostics read live traffic", async () => {
  await withRpc(async (rpc) => {
    const pending = rpc.next((msg) => msg.type === "response" && msg.command === "get_state");
    const response = await rpc.request({ type: "get_state" });
    const seen = await pending;
    expect(seen.id).toBe(response.id);

    await expect(rpc.next((msg) => msg.command === "never-emitted", 300)).rejects.toSatisfy((error) => {
      expect(error.message).toMatch(/Timeout waiting for message matching predicate/);
      expect(error.message, "diagnostics must include the live message buffer").toMatch(/get_state/);
      return true;
    });
  });
});
