import { expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withRpc } from "../../support/rpc-client.mjs";

const BUDGET_OPTIONS = [
  "unlimited — keep max",
  "large — xhigh reasoning",
  "medium — high reasoning",
  "small — medium reasoning",
];

function configPath(rpc) {
  return join(rpc.tmp.home, ".pi", "agent", "pstack-models.json");
}

test("setup-pstack writes the chosen budget to the HOME config", async () => {
  await withRpc(async (rpc) => {
    const promptDone = rpc.prompt("/setup-pstack");

    const select = await rpc.ui("select");
    expect(select.title).toBe("pstack budget");
    expect(select.options).toEqual(BUDGET_OPTIONS);
    rpc.respondUi(select.id, { value: "medium — high reasoning" });

    const confirm = await rpc.ui("confirm");
    expect(confirm.title).toBe("Write defaults?");
    expect(confirm.message).toMatch(/^Write role defaults \(inherit-parent \/ mapped provider ids — no bare marketing slugs\) \(budget: medium — high reasoning\) to .*pstack-models\.json\?$/);
    expect(confirm.message.includes(rpc.tmp.home), `confirm missing HOME: ${confirm.message}`).toBeTruthy();
    rpc.respondUi(confirm.id, { confirmed: true });

    const notify = await rpc.ui("notify");
    expect(notify.message).toMatch(/^Wrote .*pstack-models\.json \(edit to set real provider\/id\)\. Bare Cursor marketing slugs are mapped or refused\.$/);
    expect(notify.notifyType).toBe("info");

    const response = await promptDone;
    expect(response.success).toBe(true);

    const path = configPath(rpc);
    expect(existsSync(path), `config not written at ${path}`).toBeTruthy();
    const config = JSON.parse(readFileSync(path, "utf8"));
    expect(config.budget).toBe("medium — high reasoning");
    expect(config.version).toBe(1);
    expect(config.roles["feature, refactoring"]).toBe("inherit-parent");
  });
});

test("setup-pstack cancelled on a rejected confirm does not write", async () => {
  await withRpc(async (rpc) => {
    const promptDone = rpc.prompt("/setup-pstack");

    const select = await rpc.ui("select");
    rpc.respondUi(select.id, { value: "medium — high reasoning" });

    const confirm = await rpc.ui("confirm");
    rpc.respondUi(confirm.id, { confirmed: false });

    const notify = await rpc.ui("notify");
    expect(notify.message).toBe("setup-pstack cancelled");

    const response = await promptDone;
    expect(response.success).toBe(true);

    const path = configPath(rpc);
    expect(existsSync(path), `config written despite cancel at ${path}`).toBe(false);
  });
});

test("pstack-readonly toggles the notify and status surface", async () => {
  await withRpc(async (rpc) => {
    const on = rpc.prompt("/pstack-readonly");
    const onNotify = await rpc.ui("notify");
    expect(onNotify.message).toBe("Session readonly on (command): write/edit/bash blocked.");
    expect(onNotify.notifyType).toBe("info");
    const onStatus = await rpc.ui("setStatus");
    expect(onStatus.statusKey).toBe("pstack-ro");
    expect(onStatus.statusText).toBe("readonly");
    await on;

    const off = rpc.prompt("/pstack-readonly-off");
    const offNotify = await rpc.ui("notify");
    expect(offNotify.message).toBe("Session readonly off.");
    const offStatus = await rpc.ui("setStatus");
    expect(offStatus.statusKey).toBe("pstack-ro");
    expect(offStatus.statusText).toBe(undefined);
    await off;
  });
});
